/**
 * CAS lifecycle persistence — in-memory and filesystem adapters.
 * Compare-and-set by recordVersion; action-id idempotency at service layer.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import {
  LifecycleNotFoundError,
  LifecycleVersionConflictError,
} from "../lifecycle/errors";
import {
  createLifecycleRecord,
  type CreateLifecycleInput,
  type LifecycleRecord,
} from "../lifecycle/record";

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

function assertSafeTenderId(tenderId: string): void {
  if (!tenderId || tenderId.length > 128 || /[\\/]/.test(tenderId)) {
    throw new Error(`Invalid tenderId: ${tenderId}`);
  }
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

/** In-memory CAS store for tests and offline engines. */
export class InMemoryLifecycleStore implements LifecycleStore {
  private readonly records = new Map<string, LifecycleRecord>();

  async create(input: CreateLifecycleInput): Promise<LifecycleRecord> {
    assertSafeTenderId(input.tenderId);
    if (this.records.has(input.tenderId)) {
      throw new Error(`Lifecycle already exists: ${input.tenderId}`);
    }
    const record = createLifecycleRecord(input);
    this.records.set(input.tenderId, record);
    return record;
  }

  async get(tenderId: string): Promise<LifecycleRecord | null> {
    return this.records.get(tenderId) ?? null;
  }

  async compareAndSet(
    tenderId: string,
    expectedVersion: number,
    nextRecord: LifecycleRecord,
  ): Promise<LifecycleRecord> {
    const current = this.records.get(tenderId);
    if (!current) {
      throw new LifecycleNotFoundError(tenderId);
    }
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
    const persisted: LifecycleRecord = {
      ...nextRecord,
      recordVersion: expectedVersion + 1,
    };
    // Caller reducer already incremented version — prefer caller's next if
    // it matches expected+1; otherwise force store-owned increment.
    if (nextRecord.recordVersion === expectedVersion + 1) {
      this.records.set(tenderId, nextRecord);
      return nextRecord;
    }
    this.records.set(tenderId, persisted);
    return persisted;
  }
}

/**
 * Filesystem CAS store — one JSON file per tender under baseDir.
 * Atomic write via temp file + rename. No database.
 */
export class FileLifecycleStore implements LifecycleStore {
  constructor(private readonly baseDir: string) {
    mkdirSync(this.baseDir, { recursive: true });
  }

  private filePath(tenderId: string): string {
    assertSafeTenderId(tenderId);
    return path.join(this.baseDir, `lifecycle-${tenderId}.json`);
  }

  async create(input: CreateLifecycleInput): Promise<LifecycleRecord> {
    const fp = this.filePath(input.tenderId);
    if (existsSync(fp)) {
      throw new Error(`Lifecycle already exists: ${input.tenderId}`);
    }
    const record = createLifecycleRecord(input);
    this.writeAtomic(fp, record);
    return record;
  }

  async get(tenderId: string): Promise<LifecycleRecord | null> {
    const fp = this.filePath(tenderId);
    if (!existsSync(fp)) {
      return null;
    }
    const raw = readFileSync(fp, "utf8");
    return JSON.parse(raw) as LifecycleRecord;
  }

  async compareAndSet(
    tenderId: string,
    expectedVersion: number,
    nextRecord: LifecycleRecord,
  ): Promise<LifecycleRecord> {
    const current = await this.get(tenderId);
    if (!current) {
      throw new LifecycleNotFoundError(tenderId);
    }
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
    const toWrite =
      nextRecord.recordVersion === expectedVersion + 1
        ? nextRecord
        : { ...nextRecord, recordVersion: expectedVersion + 1 };
    this.writeAtomic(this.filePath(tenderId), toWrite);
    return toWrite;
  }

  private writeAtomic(filePath: string, data: LifecycleRecord): void {
    const dir = path.dirname(filePath);
    mkdirSync(dir, { recursive: true });
    const payload = `${JSON.stringify(data, null, 2)}\n`;
    const tmp = path.join(
      dir,
      `.${path.basename(filePath)}.${process.pid}.tmp`,
    );
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, payload, undefined, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, filePath);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }
}
