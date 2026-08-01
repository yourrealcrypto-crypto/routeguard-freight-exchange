/**
 * Typed lifecycle persistence errors (Phase A3b).
 *
 * Public messages never contain filesystem paths, POD content, signatures, or
 * private material. Diagnostic detail is kept on `internalDetail` for operator
 * tooling and is not interpolated into `message`.
 */

export const LIFECYCLE_PERSISTENCE_ERROR_CODES = [
  "RECORD_NOT_FOUND",
  "VERSION_CONFLICT",
  "LOCK_BUSY",
  "LOCK_TIMEOUT",
  "LOCK_CORRUPT",
  "RECORD_CORRUPT",
  "UNSUPPORTED_STORAGE_VERSION",
  "ATOMIC_WRITE_FAILED",
  "ACTION_ID_CONFLICT",
  "IMMUTABLE_FIELD_VIOLATION",
] as const;

export type LifecyclePersistenceErrorCode =
  (typeof LIFECYCLE_PERSISTENCE_ERROR_CODES)[number];

export type PersistenceErrorOptions = {
  /** Safe diagnostic context for operators. Never included in `message`. */
  readonly internalDetail?: string;
  readonly cause?: unknown;
};

export class LifecyclePersistenceError extends Error {
  readonly internalDetail: string | undefined;

  constructor(
    readonly code: LifecyclePersistenceErrorCode,
    message: string,
    options?: PersistenceErrorOptions,
  ) {
    super(message);
    this.name = "LifecyclePersistenceError";
    this.internalDetail = options?.internalDetail;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Persisted authoritative state failed full validation. Never auto-repaired. */
export class CorruptLifecycleRecordError extends LifecyclePersistenceError {
  constructor(tenderId: string, reason: string, options?: PersistenceErrorOptions) {
    super(
      "RECORD_CORRUPT",
      `Corrupt persisted lifecycle record for tender "${tenderId}": ${reason} — manual operator recovery required`,
      options,
    );
    this.name = "CorruptLifecycleRecordError";
  }
}

/** Storage schema identifier/version is not supported by this build. */
export class UnsupportedStorageVersionError extends LifecyclePersistenceError {
  constructor(tenderId: string, reason: string, options?: PersistenceErrorOptions) {
    super(
      "UNSUPPORTED_STORAGE_VERSION",
      `Unsupported lifecycle storage schema for tender "${tenderId}": ${reason}`,
      options,
    );
    this.name = "UnsupportedStorageVersionError";
  }
}

/** Another live writer holds the per-tender lock (no retry budget left). */
export class LifecycleLockBusyError extends LifecyclePersistenceError {
  constructor(tenderId: string, options?: PersistenceErrorOptions) {
    super(
      "LOCK_BUSY",
      `Lifecycle record "${tenderId}" is locked by another writer`,
      options,
    );
    this.name = "LifecycleLockBusyError";
  }
}

/** Bounded lock acquisition window elapsed while another writer held the lock. */
export class LifecycleLockTimeoutError extends LifecyclePersistenceError {
  constructor(tenderId: string, timeoutMs: number, options?: PersistenceErrorOptions) {
    super(
      "LOCK_TIMEOUT",
      `Timed out after ${timeoutMs}ms acquiring the write lock for lifecycle record "${tenderId}"`,
      options,
    );
    this.name = "LifecycleLockTimeoutError";
  }
}

/** Lock metadata is unreadable/malformed/ambiguous. Never silently deleted. */
export class LifecycleLockCorruptError extends LifecyclePersistenceError {
  constructor(tenderId: string, reason: string, options?: PersistenceErrorOptions) {
    super(
      "LOCK_CORRUPT",
      `Lock for lifecycle record "${tenderId}" is ambiguous: ${reason} — manual operator recovery required`,
      options,
    );
    this.name = "LifecycleLockCorruptError";
  }
}

/** Temp write, flush, or atomic replacement failed. Previous state preserved. */
export class LifecycleAtomicWriteError extends LifecyclePersistenceError {
  constructor(tenderId: string, reason: string, options?: PersistenceErrorOptions) {
    super(
      "ATOMIC_WRITE_FAILED",
      `Atomic persistence failed for lifecycle record "${tenderId}": ${reason} — previous authoritative state preserved`,
      options,
    );
    this.name = "LifecycleAtomicWriteError";
  }
}

/** A direct CAS proposal attempted to rewrite create-time trust/identity data. */
export class LifecycleImmutableFieldError extends LifecyclePersistenceError {
  constructor(tenderId: string, field: string) {
    super(
      "IMMUTABLE_FIELD_VIOLATION",
      `Lifecycle record "${tenderId}" cannot change immutable field "${field}"`,
      { internalDetail: `immutable field mismatch: ${field}` },
    );
    this.name = "LifecycleImmutableFieldError";
  }
}

export function isLifecyclePersistenceError(
  value: unknown,
): value is LifecyclePersistenceError {
  return value instanceof LifecyclePersistenceError;
}
