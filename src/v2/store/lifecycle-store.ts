/**
 * CAS lifecycle persistence — in-memory and filesystem adapters.
 *
 * Two independent guarantees on the filesystem adapter:
 *   1. recordVersion compare-and-set — a stale writer can never overwrite a
 *      newer record (fails closed with a typed VERSION_CONFLICT).
 *   2. a per-tender filesystem lock (exclusive `wx` create) — the complete
 *      read → validate → compare → write → verify sequence runs while the lock
 *      is held, so two Node processes cannot both commit from the same version.
 *
 * Everything read back from disk is fully validated (see persisted-record.ts);
 * corrupt authoritative state fails closed and is never repaired or deleted.
 * Lifecycle semantics (expected version, action-id replay/conflict, tender
 * binding, version increment) are identical in both adapters.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { KeyedMutex } from "../../reservation/keyed-mutex";
import {
  LifecycleActionConflictError,
  LifecycleNotFoundError,
  LifecycleVersionConflictError,
} from "../lifecycle/errors";
import {
  createLifecycleRecord,
  type CreateLifecycleInput,
  type LifecycleRecord,
} from "../lifecycle/record";
import {
  acquireFileLock,
  releaseFileLock,
  resolveFileLockConfig,
  type FileLockConfig,
  type FileLockHandle,
} from "./file-lock";
import {
  LifecycleAtomicWriteError,
  LifecyclePersistenceError,
} from "./persistence-errors";
import {
  assertSafeTenderId,
  assertValidLifecycleRecord,
  buildPersistedLifecycleEnvelope,
  parsePersistedLifecycleEnvelope,
  serializePersistedLifecycleEnvelope,
} from "./persisted-record";

export interface LifecycleStore {
  create(input: CreateLifecycleInput): Promise<LifecycleRecord>;
  get(tenderId: string): Promise<LifecycleRecord | null>;
  /**
   * Replace only when persisted version equals expectedVersion.
   * Store sets next version to expectedVersion + 1.
   */
  compareAndSet(
    tenderId: string,
    expectedVersion: number,
    nextRecord: LifecycleRecord,
  ): Promise<LifecycleRecord>;
}

function assertRecordVersion(value: unknown, ctx: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    !Number.isSafeInteger(value)
  ) {
    throw new Error(`${ctx}: invalid recordVersion`);
  }
  return value;
}

/**
 * Shared CAS pre-conditions. Enforced identically by both adapters so file and
 * memory stores can never disagree on lifecycle semantics.
 *
 * The processed-action index lives inside the record, so a committed transition
 * and its action record are always written together; this check additionally
 * refuses to drop or rewrite an already-committed action.
 */
function assertCasPreconditions(
  tenderId: string,
  current: LifecycleRecord,
  expectedVersion: number,
  nextRecord: LifecycleRecord,
): void {
  assertRecordVersion(current.recordVersion, "stored");
  if (current.recordVersion !== expectedVersion) {
    throw new LifecycleVersionConflictError(
      tenderId,
      expectedVersion,
      current.recordVersion,
    );
  }
  if (nextRecord.tenderId !== tenderId) {
    throw new Error("tenderId mismatch on CAS write");
  }
  if (nextRecord.tenderVersion !== current.tenderVersion) {
    throw new Error("tenderVersion mismatch on CAS write");
  }
  for (const [actionId, committed] of Object.entries(current.processedActions)) {
    const next = nextRecord.processedActions[actionId];
    if (!next) {
      throw new LifecycleActionConflictError(
        actionId,
        `actionId "${actionId}" is already committed and cannot be dropped`,
      );
    }
    if (
      next.eventPayloadHash !== committed.eventPayloadHash ||
      next.recordVersionAfter !== committed.recordVersionAfter ||
      next.resultingState !== committed.resultingState
    ) {
      throw new LifecycleActionConflictError(actionId);
    }
  }
}

function withStoreVersion(
  nextRecord: LifecycleRecord,
  expectedVersion: number,
): LifecycleRecord {
  return nextRecord.recordVersion === expectedVersion + 1
    ? nextRecord
    : { ...nextRecord, recordVersion: expectedVersion + 1 };
}

/** In-memory CAS store for tests and offline engines. */
export class InMemoryLifecycleStore implements LifecycleStore {
  private readonly records = new Map<string, LifecycleRecord>();
  private readonly mutex = new KeyedMutex();

  async create(input: CreateLifecycleInput): Promise<LifecycleRecord> {
    assertSafeTenderId(input.tenderId);
    return this.mutex.runExclusive(input.tenderId, async () => {
      if (this.records.has(input.tenderId)) {
        throw new Error(`Lifecycle already exists: ${input.tenderId}`);
      }
      const record = createLifecycleRecord(input);
      assertValidLifecycleRecord(record, input.tenderId);
      this.records.set(input.tenderId, record);
      return record;
    });
  }

  async get(tenderId: string): Promise<LifecycleRecord | null> {
    const record = this.records.get(tenderId);
    if (!record) return null;
    return assertValidLifecycleRecord(record, tenderId);
  }

  async compareAndSet(
    tenderId: string,
    expectedVersion: number,
    nextRecord: LifecycleRecord,
  ): Promise<LifecycleRecord> {
    assertSafeTenderId(tenderId);
    return this.mutex.runExclusive(tenderId, async () => {
      const current = this.records.get(tenderId);
      if (!current) {
        throw new LifecycleNotFoundError(tenderId);
      }
      assertCasPreconditions(tenderId, current, expectedVersion, nextRecord);
      const persisted = withStoreVersion(nextRecord, expectedVersion);
      assertValidLifecycleRecord(persisted, tenderId);
      this.records.set(tenderId, persisted);
      return persisted;
    });
  }
}

// ---------------------------------------------------------------------------
// Filesystem store
// ---------------------------------------------------------------------------

const TEMP_PREFIX = ".lifecycle-";
const TEMP_SUFFIX = ".tmp";

export type FileLifecycleStoreOptions = {
  readonly lock?: Partial<FileLockConfig>;
};

/**
 * Filesystem CAS store — one authoritative JSON envelope per tender.
 * Writes are serialized per tender by a lock file and land through a unique
 * temp file + atomic rename. `.tmp` files are never authoritative.
 */
export class FileLifecycleStore implements LifecycleStore {
  private readonly mutex = new KeyedMutex();
  private readonly lockConfig: FileLockConfig;

  constructor(
    private readonly baseDir: string,
    options?: FileLifecycleStoreOptions,
  ) {
    this.lockConfig = resolveFileLockConfig(options?.lock);
    mkdirSync(this.baseDir, { recursive: true });
  }

  private filePath(tenderId: string): string {
    return path.join(this.baseDir, `lifecycle-${assertSafeTenderId(tenderId)}.json`);
  }

  private lockPath(tenderId: string): string {
    return path.join(this.baseDir, `lifecycle-${assertSafeTenderId(tenderId)}.lock`);
  }

  async create(input: CreateLifecycleInput): Promise<LifecycleRecord> {
    const tenderId = assertSafeTenderId(input.tenderId);
    return this.mutex.runExclusive(tenderId, async () => {
      const lock = await acquireFileLock(
        this.lockPath(tenderId),
        tenderId,
        this.lockConfig,
      );
      try {
        if (existsSync(this.filePath(tenderId))) {
          throw new Error(`Lifecycle already exists: ${tenderId}`);
        }
        const record = createLifecycleRecord(input);
        assertValidLifecycleRecord(record, tenderId);
        this.writeAtomic(tenderId, record, lock);
        return record;
      } finally {
        releaseFileLock(lock);
      }
    });
  }

  async get(tenderId: string): Promise<LifecycleRecord | null> {
    return this.readRecord(tenderId);
  }

  async compareAndSet(
    tenderId: string,
    expectedVersion: number,
    nextRecord: LifecycleRecord,
  ): Promise<LifecycleRecord> {
    const safeId = assertSafeTenderId(tenderId);
    return this.mutex.runExclusive(safeId, async () => {
      // 1. acquire the per-tender cross-process lock
      const lock = await acquireFileLock(
        this.lockPath(safeId),
        safeId,
        this.lockConfig,
      );
      try {
        // 2-3. read and fully validate the current authoritative envelope
        const current = this.readRecord(safeId);
        if (!current) {
          throw new LifecycleNotFoundError(safeId);
        }
        // 4-6. compare expected version, action-id state, and tender binding
        assertCasPreconditions(safeId, current, expectedVersion, nextRecord);
        const persisted = withStoreVersion(nextRecord, expectedVersion);
        assertValidLifecycleRecord(persisted, safeId);
        // 7-11. temp write → flush → atomic replace → read-back verification
        this.writeAtomic(safeId, persisted, lock);
        return persisted;
      } finally {
        // 12. release the lock (always after the rename)
        releaseFileLock(lock);
      }
    });
  }

  /** Read the authoritative file only. `.tmp` files are never consulted. */
  private readRecord(tenderId: string): LifecycleRecord | null {
    const safeId = assertSafeTenderId(tenderId);
    const fp = this.filePath(safeId);
    let bytes: Buffer;
    try {
      bytes = readFileSync(fp);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
    return parsePersistedLifecycleEnvelope(bytes, safeId).record;
  }

  /**
   * Write to a uniquely named temp file in the same directory, flush it, then
   * atomically replace the authoritative file and verify the result reloads.
   * A failure at any point preserves the previous authoritative record.
   */
  private writeAtomic(
    tenderId: string,
    record: LifecycleRecord,
    lock: FileLockHandle,
  ): void {
    const fp = this.filePath(tenderId);
    const envelope = buildPersistedLifecycleEnvelope(record);
    const payload = serializePersistedLifecycleEnvelope(envelope);
    const tmp = path.join(
      this.baseDir,
      `${TEMP_PREFIX}${tenderId}.${process.pid}.${lock.token}.${randomUUID()}${TEMP_SUFFIX}`,
    );

    try {
      // Exclusive create: never overwrite another writer's temp file.
      const fd = openSync(tmp, "wx");
      try {
        writeSync(fd, payload, null, "utf8");
        try {
          fsyncSync(fd);
        } catch {
          // fsync unsupported on some platforms/filesystems — best effort.
        }
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      this.removeOwnedTemp(tmp);
      throw new LifecycleAtomicWriteError(tenderId, "temporary write failed", {
        cause: err,
      });
    }

    try {
      // Atomic within the directory; replaces the target on POSIX and Windows.
      renameSync(tmp, fp);
    } catch (err) {
      this.removeOwnedTemp(tmp);
      throw new LifecycleAtomicWriteError(
        tenderId,
        "atomic replacement failed",
        { cause: err },
      );
    }

    this.fsyncDirBestEffort();

    // Verify the authoritative file reloads and revalidates.
    try {
      const verified = parsePersistedLifecycleEnvelope(readFileSync(fp), tenderId);
      if (verified.record.recordVersion !== record.recordVersion) {
        throw new Error("verified record version mismatch");
      }
    } catch (err) {
      if (err instanceof LifecyclePersistenceError) {
        throw err;
      }
      throw new LifecycleAtomicWriteError(
        tenderId,
        "written record failed read-back verification",
        { cause: err },
      );
    }
  }

  private removeOwnedTemp(tmp: string): void {
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing owned to clean up.
    }
  }

  private fsyncDirBestEffort(): void {
    // Directory fsync is unsupported on Windows; treat as best effort.
    let fd: number | undefined;
    try {
      fd = openSync(this.baseDir, "r");
      fsyncSync(fd);
    } catch {
      // ignore
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------

export type TempFileRecoveryResult = {
  /** Abandoned temp files that were removed. */
  readonly removed: readonly string[];
  /** Temp files left in place (too recent to be considered abandoned). */
  readonly retained: readonly string[];
};

/**
 * Deterministic crash-recovery helper.
 *
 * Removes only files matching this store's temp-file naming convention and only
 * when they are older than `minimumAgeMs`. Authoritative `.json` records and
 * lock files are never touched, and a temp file is never promoted to
 * authoritative state — the authoritative path stays the sole source of truth.
 */
export function cleanupAbandonedLifecycleTempFiles(
  baseDir: string,
  options?: { minimumAgeMs?: number },
): TempFileRecoveryResult {
  const minimumAgeMs = options?.minimumAgeMs ?? 60_000;
  if (!existsSync(baseDir)) {
    return { removed: [], retained: [] };
  }
  const removed: string[] = [];
  const retained: string[] = [];
  for (const name of readdirSync(baseDir)) {
    if (!name.startsWith(TEMP_PREFIX) || !name.endsWith(TEMP_SUFFIX)) {
      continue;
    }
    const full = path.join(baseDir, name);
    let ageMs: number;
    try {
      ageMs = Date.now() - statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (ageMs < minimumAgeMs) {
      retained.push(name);
      continue;
    }
    try {
      unlinkSync(full);
      removed.push(name);
    } catch {
      retained.push(name);
    }
  }
  return { removed, retained };
}
