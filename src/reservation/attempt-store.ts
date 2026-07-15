/**
 * Durable reservation attempt store with optimistic concurrency (record
 * version / CAS) and cross-process write exclusion.
 *
 * Two independent guarantees:
 *   1. recordVersion + compareAndSet — a stale writer can never silently
 *      overwrite a newer record (fails closed with a typed conflict).
 *   2. Filesystem lock (exclusive `wx` create) — only one writer across
 *      processes may hold a reservation's lock; a live or ambiguous lock fails
 *      closed and is never automatically stolen.
 *
 * An in-process KeyedMutex serializes overlapping async work per reservation as
 * an optimization; the record version and filesystem lock remain authoritative.
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
  unlinkSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { KeyedMutex } from "./keyed-mutex";
import {
  assertSafeReservationId,
  assertValidPersistedReservationRecord,
  CorruptReservationRecordError,
} from "./record-schema";
import {
  ReservationError,
  ReservationVersionConflictError,
  type ReservationRecord,
  type ReservationState,
} from "./types";

export { CorruptReservationRecordError };

export interface ReservationStore {
  /**
   * Persist a brand-new record at the explicit initial version (1). Fails
   * closed if a record already exists for the id. Returns the persisted record.
   */
  create(record: ReservationRecord): Promise<ReservationRecord>;

  get(reservationId: string): Promise<ReservationRecord | null>;

  /**
   * Atomically replace the record only if its persisted version equals
   * expectedVersion, incrementing the version by exactly one. Throws
   * ReservationVersionConflictError on a stale expectedVersion. The store owns
   * the version — the caller cannot control it through nextRecord.
   */
  compareAndSet(
    reservationId: string,
    expectedVersion: number,
    nextRecord: ReservationRecord,
  ): Promise<ReservationRecord>;

  listInProgress(): Promise<ReservationRecord[]>;
}

/** In-memory-only fields never written to durable storage. */
const TRANSIENT_KEYS = new Set(["_closureProof", "_manifest"]);

const TERMINAL_STATES: readonly ReservationState[] = [
  "COMPLETED",
  "PAYMENT_REJECTED",
  "SETTLEMENT_FAILED",
  "CONFIRMATION_TIMED_OUT",
  "CONFIRMATION_FAILED",
  "EXPIRED",
  "MANUAL_REVIEW_REQUIRED",
];

export function toPersistedShape(
  record: ReservationRecord,
): Omit<ReservationRecord, "_closureProof" | "_manifest"> {
  const copy = { ...record };
  delete copy._closureProof;
  delete copy._manifest;
  return copy;
}

export function serializeReservationRecord(record: ReservationRecord): string {
  return `${JSON.stringify(toPersistedShape(record), null, 2)}\n`;
}

/** Fail closed on a missing or malformed record version. */
export function assertValidRecordVersion(
  value: unknown,
  context: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    !Number.isSafeInteger(value)
  ) {
    throw new ReservationError(
      "INVALID_RECORD_VERSION",
      `${context}: recordVersion must be a positive safe integer, got ${String(value)}`,
    );
  }
  return value;
}

/** Validate the full durable record. Fail closed on any corruption. */
function assertPersistableRecord(
  reservationId: string,
  record: ReservationRecord,
  opts?: { fromStorage?: boolean },
): void {
  assertSafeReservationId(reservationId);
  assertValidPersistedReservationRecord(record, reservationId, opts);
}

function isTerminal(state: ReservationState): boolean {
  return TERMINAL_STATES.includes(state);
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

export class InMemoryReservationStore implements ReservationStore {
  private readonly byId = new Map<string, ReservationRecord>();
  private readonly mutex = new KeyedMutex();

  async create(record: ReservationRecord): Promise<ReservationRecord> {
    return this.mutex.runExclusive(record.reservationId, async () => {
      if (this.byId.has(record.reservationId)) {
        throw new ReservationError(
          "CONFLICT",
          `Reservation ${record.reservationId} already exists`,
        );
      }
      const persisted: ReservationRecord = { ...record, recordVersion: 1 };
      assertPersistableRecord(record.reservationId, persisted);
      this.byId.set(record.reservationId, persisted);
      return this.clone(persisted);
    });
  }

  async get(reservationId: string): Promise<ReservationRecord | null> {
    const r = this.byId.get(reservationId);
    if (!r) return null;
    assertPersistableRecord(reservationId, r);
    return this.clone(r);
  }

  async compareAndSet(
    reservationId: string,
    expectedVersion: number,
    nextRecord: ReservationRecord,
  ): Promise<ReservationRecord> {
    return this.mutex.runExclusive(reservationId, async () => {
      const current = this.byId.get(reservationId);
      if (!current) {
        throw new ReservationError(
          "NOT_FOUND",
          `Reservation ${reservationId} does not exist`,
        );
      }
      const currentVersion = assertValidRecordVersion(
        current.recordVersion,
        `record ${reservationId}`,
      );
      if (currentVersion !== expectedVersion) {
        throw new ReservationVersionConflictError(
          reservationId,
          expectedVersion,
          currentVersion,
        );
      }
      // Store owns the version; the caller cannot control it.
      const persisted: ReservationRecord = {
        ...nextRecord,
        reservationId,
        recordVersion: currentVersion + 1,
      };
      assertPersistableRecord(reservationId, persisted);
      // Preserve in-memory proof handles across mutations.
      if (!persisted._closureProof && current._closureProof) {
        persisted._closureProof = current._closureProof;
      }
      if (!persisted._manifest && current._manifest) {
        persisted._manifest = current._manifest;
      }
      this.byId.set(reservationId, persisted);
      return this.clone(persisted);
    });
  }

  async listInProgress(): Promise<ReservationRecord[]> {
    const out: ReservationRecord[] = [];
    for (const r of this.byId.values()) {
      assertPersistableRecord(r.reservationId, r);
      if (!isTerminal(r.state)) {
        out.push(this.clone(r));
      }
    }
    return out;
  }

  /** Deep-clone durable data but preserve authentic proof handle identity. */
  private clone(record: ReservationRecord): ReservationRecord {
    const { _closureProof, _manifest, ...rest } = record;
    const clone = structuredClone(rest) as ReservationRecord;
    if (_closureProof) clone._closureProof = _closureProof;
    if (_manifest) clone._manifest = _manifest;
    return clone;
  }
}

// ---------------------------------------------------------------------------
// Filesystem store
// ---------------------------------------------------------------------------

type LockHandle = { path: string; token: string };

type LockMetadata = {
  v: number;
  pid: number;
  host: string;
  token: string;
  acquiredAt: string;
};

export class FileSystemReservationStore implements ReservationStore {
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly dir: string,
    /** Bounded lock acquisition attempts. Default 1 (fail closed immediately). */
    private readonly maxLockAttempts: number = 1,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  private safeId(reservationId: string): string {
    return reservationId.replace(/[^a-zA-Z0-9._-]/g, "_");
  }

  private filePath(reservationId: string): string {
    return path.join(this.dir, `${this.safeId(reservationId)}.json`);
  }

  private lockPath(reservationId: string): string {
    return path.join(this.dir, `${this.safeId(reservationId)}.lock`);
  }

  async create(record: ReservationRecord): Promise<ReservationRecord> {
    return this.mutex.runExclusive(record.reservationId, async () => {
      const lock = await this.acquireLock(record.reservationId);
      try {
        if (existsSync(this.filePath(record.reservationId))) {
          throw new ReservationError(
            "CONFLICT",
            `Reservation ${record.reservationId} already exists`,
          );
        }
        const persisted: ReservationRecord = { ...record, recordVersion: 1 };
        assertPersistableRecord(record.reservationId, persisted);
        this.writeAtomic(record.reservationId, persisted, lock.token);
        return persisted;
      } finally {
        this.releaseLock(lock);
      }
    });
  }

  async get(reservationId: string): Promise<ReservationRecord | null> {
    return this.readRecord(reservationId);
  }

  async compareAndSet(
    reservationId: string,
    expectedVersion: number,
    nextRecord: ReservationRecord,
  ): Promise<ReservationRecord> {
    return this.mutex.runExclusive(reservationId, async () => {
      const lock = await this.acquireLock(reservationId);
      try {
        // 1. read the latest persisted record
        const current = this.readRecord(reservationId);
        if (!current) {
          throw new ReservationError(
            "NOT_FOUND",
            `Reservation ${reservationId} does not exist`,
          );
        }
        // 2. compare expected version
        const currentVersion = assertValidRecordVersion(
          current.recordVersion,
          `record ${reservationId}`,
        );
        if (currentVersion !== expectedVersion) {
          throw new ReservationVersionConflictError(
            reservationId,
            expectedVersion,
            currentVersion,
          );
        }
        // 3. validate the full next record (store owns the version)
        const persisted: ReservationRecord = {
          ...nextRecord,
          reservationId,
          recordVersion: currentVersion + 1,
        };
        assertPersistableRecord(reservationId, persisted);
        // 4-6. write to unique temp file, flush, atomic rename
        this.writeAtomic(reservationId, persisted, lock.token);
        return persisted;
      } finally {
        // 7. release the lock
        this.releaseLock(lock);
      }
    });
  }

  async listInProgress(): Promise<ReservationRecord[]> {
    const files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    const out: ReservationRecord[] = [];
    const corruptions: string[] = [];
    for (const f of files) {
      const id = f.replace(/\.json$/, "");
      try {
        // safeId is lossy; re-validate using the id embedded in the record.
        const fp = path.join(this.dir, f);
        if (!existsSync(fp)) continue;
        const raw = readFileSync(fp, "utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          corruptions.push(id);
          continue;
        }
        const recId =
          parsed &&
          typeof parsed === "object" &&
          typeof (parsed as { reservationId?: unknown }).reservationId ===
            "string"
            ? (parsed as { reservationId: string }).reservationId
            : id;
        const rec = assertValidPersistedReservationRecord(parsed, recId, {
          fromStorage: true,
        });
        if (!isTerminal(rec.state)) {
          out.push(rec);
        }
      } catch (e) {
        if (
          e instanceof CorruptReservationRecordError ||
          e instanceof ReservationError
        ) {
          corruptions.push(id);
          continue;
        }
        throw e;
      }
    }
    if (corruptions.length > 0) {
      throw new CorruptReservationRecordError(
        `listInProgress found ${corruptions.length} corrupt reservation record(s)`,
        "CORRUPT_RESERVATION_RECORD",
      );
    }
    return out;
  }

  private readRecord(reservationId: string): ReservationRecord | null {
    // Resolve path only after id safety (path traversal fail-closed).
    assertSafeReservationId(reservationId);
    const fp = this.filePath(reservationId);
    if (!existsSync(fp)) return null;
    const raw = readFileSync(fp, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CorruptReservationRecordError(
        "Corrupt reservation JSON — manual review required",
        "CORRUPT_RESERVATION_RECORD",
      );
    }
    // Full schema + cross-field validation. Never exposes raw file path publicly.
    return assertValidPersistedReservationRecord(parsed, reservationId, {
      fromStorage: true,
    });
  }

  /**
   * Write to a unique temp file, flush, then atomically rename over the target.
   * A partial or interrupted write leaves the current record untouched.
   */
  private writeAtomic(
    reservationId: string,
    record: ReservationRecord,
    lockToken: string,
  ): void {
    const fp = this.filePath(reservationId);
    const tmp = path.join(
      this.dir,
      `.${this.safeId(reservationId)}.${process.pid}.${lockToken}.tmp`,
    );
    const payload = serializeReservationRecord(record);
    const fd = openSync(tmp, "w");
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
    renameSync(tmp, fp);
  }

  // -- locking -------------------------------------------------------------

  private async acquireLock(reservationId: string): Promise<LockHandle> {
    const lp = this.lockPath(reservationId);
    const token = randomUUID();
    const meta: LockMetadata = {
      v: 1,
      pid: process.pid,
      host: os.hostname(),
      token,
      acquiredAt: new Date().toISOString(),
    };

    for (let attempt = 0; attempt < Math.max(1, this.maxLockAttempts); attempt++) {
      let fd: number;
      try {
        fd = openSync(lp, "wx"); // atomic exclusive create
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") {
          // Do not steal. Inspect the existing lock and fail closed.
          this.inspectExistingLock(lp);
          if (attempt + 1 < Math.max(1, this.maxLockAttempts)) {
            await delay(5);
            continue;
          }
          throw new ReservationError(
            "LOCK_HELD",
            `Reservation ${reservationId} is locked by another writer — fail closed`,
          );
        }
        throw e;
      }
      try {
        writeSync(fd, JSON.stringify(meta), null, "utf8");
        try {
          fsyncSync(fd);
        } catch {
          // best effort
        }
      } finally {
        closeSync(fd);
      }
      return { path: lp, token };
    }
    // Unreachable: loop either returns or throws.
    throw new ReservationError(
      "LOCK_HELD",
      `Reservation ${reservationId} lock could not be acquired`,
    );
  }

  /** A partial/ambiguous existing lock fails closed for manual review. */
  private inspectExistingLock(lockPath: string): void {
    let raw: string;
    try {
      raw = readFileSync(lockPath, "utf8");
    } catch {
      throw new ReservationError(
        "LOCK_AMBIGUOUS",
        `Lock ${lockPath} exists but is unreadable — manual review required`,
      );
    }
    if (raw.trim().length === 0) {
      throw new ReservationError(
        "LOCK_AMBIGUOUS",
        `Lock ${lockPath} is empty/partial — manual review required`,
      );
    }
    let meta: unknown;
    try {
      meta = JSON.parse(raw);
    } catch {
      throw new ReservationError(
        "LOCK_AMBIGUOUS",
        `Lock ${lockPath} metadata is malformed — manual review required`,
      );
    }
    const m = meta as Partial<LockMetadata>;
    if (
      typeof m.pid !== "number" ||
      typeof m.token !== "string" ||
      m.token.length === 0 ||
      typeof m.acquiredAt !== "string" ||
      m.acquiredAt.length === 0
    ) {
      throw new ReservationError(
        "LOCK_AMBIGUOUS",
        `Lock ${lockPath} metadata is incomplete — manual review required`,
      );
    }
    // Valid, live lock held by another writer. Never steal it here.
  }

  private releaseLock(lock: LockHandle): void {
    try {
      const raw = readFileSync(lock.path, "utf8");
      const meta = JSON.parse(raw) as Partial<LockMetadata>;
      // Only remove our own lock; never remove another process's active lock.
      if (meta.token !== lock.token) {
        return;
      }
      unlinkSync(lock.path);
    } catch {
      // Lock already gone or unreadable — nothing safe to remove.
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Startup recovery: ambiguous in-progress settlement → MANUAL_REVIEW_REQUIRED
 * unless caller supplies resolved authoritative Mirror status. Never infers
 * failure from timeout and never re-settles.
 */
export function recoverInProgressState(
  record: ReservationRecord,
  resolution?: {
    mirror?: MirrorLike;
    /** Authoritatively resolved transaction id (from facilitator/ledger). */
    transactionId?: string;
  },
): ReservationRecord {
  const state = record.state;

  if (state === "FACILITATOR_SETTLE_CLAIMED") {
    // Settle may or may not have executed. Never auto-settle again.
    if (resolution?.transactionId) {
      // A transaction id was resolved authoritatively → continue confirmation.
      // Establish durable deadline + poll shell so the record stays schema-valid
      // for resumePaymentConfirmation (never re-settles).
      const now = new Date().toISOString();
      const deadline =
        record.confirmationDeadline ??
        new Date(Date.now() + 30_000).toISOString();
      return {
        ...record,
        transactionId: resolution.transactionId,
        state: "MIRROR_CONFIRMATION_PENDING",
        confirmationDeadline: deadline,
        mirrorPoll: record.mirrorPoll ?? {
          transactionId: resolution.transactionId,
          confirmationStartedAt: now,
          confirmationDeadline: deadline,
          pollAttemptCount: 0,
          lastPollAt: null,
          lastMirrorStatus: null,
          lastMirrorErrorCode: null,
          lastMirrorError: null,
          consensusTimestamp: null,
          verifiedTransfer: null,
        },
        updatedAt: now,
      };
    }
    return {
      ...record,
      state: "MANUAL_REVIEW_REQUIRED",
      failureCode: "AMBIGUOUS_SETTLE_CLAIM",
      failureReason:
        "Restart after settle claim before transaction id persisted — manual review required (do not auto-settle)",
      updatedAt: new Date().toISOString(),
    };
  }

  if (state === "FACILITATOR_SETTLED" || state === "MIRROR_CONFIRMATION_PENDING") {
    if (!record.transactionId) {
      return {
        ...record,
        state: "MANUAL_REVIEW_REQUIRED",
        failureCode: "AMBIGUOUS_SETTLEMENT",
        failureReason:
          "In-progress settlement without conclusive transaction ID — manual review required",
        updatedAt: new Date().toISOString(),
      };
    }
    // Authoritative transaction ID present: leave state for resumePaymentConfirmation
    // (bounded Mirror polling). Never re-settle. Optional resolution.mirror still
    // allows FAILED to go terminal without polling.
    if (resolution?.mirror) {
      if (resolution.mirror.status === "SUCCESS") {
        return record; // caller continues confirmation via resumePaymentConfirmation
      }
      if (resolution.mirror.status === "FAILED") {
        return {
          ...record,
          state: "CONFIRMATION_FAILED",
          failureCode: "MIRROR_FAILED",
          failureReason: "Mirror confirmed failure on recovery",
          updatedAt: new Date().toISOString(),
        };
      }
      // PENDING / NOT_FOUND — keep confirmable state for bounded resume.
      return record;
    }
    // Restart with tx id: stay confirmable; resumePaymentConfirmation polls.
    return record;
  }

  if (state === "PAYMENT_SUBMISSION_STARTED") {
    return {
      ...record,
      state: "MANUAL_REVIEW_REQUIRED",
      failureCode: "AMBIGUOUS_SUBMISSION",
      failureReason:
        "Restart during payment submission — manual review required (do not auto-retry)",
      updatedAt: new Date().toISOString(),
    };
  }

  if (state === "FACILITATOR_VERIFIED") {
    return {
      ...record,
      state: "MANUAL_REVIEW_REQUIRED",
      failureCode: "AMBIGUOUS_VERIFIED",
      failureReason:
        "Restart after verify before settle — manual review required (settle at most once)",
      updatedAt: new Date().toISOString(),
    };
  }

  return record;
}

type MirrorLike = { status: string };

export function assertNotReplaceSubmittedPayment(
  existing: ReservationRecord,
  incoming: Partial<ReservationRecord>,
): void {
  if (
    existing.transactionId &&
    incoming.transactionId &&
    incoming.transactionId !== existing.transactionId
  ) {
    throw new ReservationError(
      "CONFLICT",
      "Cannot replace an existing settlement transaction ID",
    );
  }
  if (
    existing.selected &&
    incoming.selected &&
    existing.selected.optionId !== incoming.selected.optionId &&
    (existing.state === "PAYMENT_SUBMISSION_STARTED" ||
      existing.paymentPayloadHash)
  ) {
    throw new ReservationError(
      "SELECTION_LOCKED",
      "Cannot change selected option after payment submission",
    );
  }
  void TRANSIENT_KEYS;
}
