/**
 * Per-tender cross-process write lock for the v2 lifecycle file store.
 *
 * Exclusion comes from atomic exclusive creation (`open(..., "wx")`) of a lock
 * file that sits beside the authoritative record. An in-process mutex is only an
 * optimization; this lock is what protects multiple Node processes.
 *
 * Policy:
 *   - one lock file per tender (never a global lock);
 *   - bounded retry/backoff with an explicit timeout (never an unbounded wait);
 *   - release verifies the ownership token before unlinking;
 *   - malformed lock metadata fails closed (LOCK_CORRUPT) and is never deleted;
 *   - a *valid* lock older than the stale threshold may be reclaimed through an
 *     atomic rename that confirms the lock was not replaced between inspection
 *     and reclamation.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import os from "node:os";

import {
  LifecycleLockBusyError,
  LifecycleLockCorruptError,
  LifecycleLockTimeoutError,
} from "./persistence-errors";

export const LOCK_METADATA_VERSION = 1 as const;

export type FileLockConfig = {
  /** Total bounded window for acquiring the lock. 0 → single attempt. */
  readonly acquireTimeoutMs: number;
  /** Delay between acquisition attempts. */
  readonly retryIntervalMs: number;
  /** A valid lock older than this may be reclaimed. */
  readonly staleAfterMs: number;
};

/** Explicit UTC epoch-millisecond provider used by trust-sensitive lock logic. */
export type FileLockNow = () => number;

export const DEFAULT_FILE_LOCK_CONFIG: FileLockConfig = Object.freeze({
  acquireTimeoutMs: 5_000,
  retryIntervalMs: 20,
  staleAfterMs: 60_000,
});

export function resolveFileLockConfig(
  overrides?: Partial<FileLockConfig>,
): FileLockConfig {
  const merged = { ...DEFAULT_FILE_LOCK_CONFIG, ...(overrides ?? {}) };
  if (
    !Number.isFinite(merged.acquireTimeoutMs) ||
    merged.acquireTimeoutMs < 0 ||
    merged.acquireTimeoutMs > 300_000
  ) {
    throw new Error("acquireTimeoutMs must be between 0 and 300000");
  }
  if (
    !Number.isFinite(merged.retryIntervalMs) ||
    merged.retryIntervalMs < 1 ||
    merged.retryIntervalMs > 5_000
  ) {
    throw new Error("retryIntervalMs must be between 1 and 5000");
  }
  if (
    !Number.isFinite(merged.staleAfterMs) ||
    merged.staleAfterMs < 1_000 ||
    merged.staleAfterMs > 86_400_000
  ) {
    throw new Error("staleAfterMs must be between 1000 and 86400000");
  }
  return Object.freeze(merged);
}

export type LockMetadata = {
  readonly v: typeof LOCK_METADATA_VERSION;
  readonly pid: number;
  readonly host: string;
  readonly token: string;
  readonly tenderId: string;
  readonly acquiredAt: string;
};

export type FileLockHandle = {
  readonly lockPath: string;
  readonly tenderId: string;
  readonly token: string;
  readonly acquiredAt: string;
};

function nowIso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse + validate lock metadata. Returns null when unusable (fail closed). */
export function parseLockMetadata(raw: string): LockMetadata | null {
  if (raw.trim().length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const m = parsed as Record<string, unknown>;
  if (m.v !== LOCK_METADATA_VERSION) return null;
  if (typeof m.pid !== "number" || !Number.isSafeInteger(m.pid) || m.pid < 0) {
    return null;
  }
  if (typeof m.host !== "string" || m.host.length === 0 || m.host.length > 256) {
    return null;
  }
  if (typeof m.token !== "string" || m.token.length < 8 || m.token.length > 128) {
    return null;
  }
  if (
    typeof m.tenderId !== "string" ||
    m.tenderId.length === 0 ||
    m.tenderId.length > 128
  ) {
    return null;
  }
  if (typeof m.acquiredAt !== "string") return null;
  const acquiredMs = Date.parse(m.acquiredAt);
  if (!Number.isFinite(acquiredMs)) return null;
  return {
    v: LOCK_METADATA_VERSION,
    pid: m.pid,
    host: m.host,
    token: m.token,
    tenderId: m.tenderId,
    acquiredAt: m.acquiredAt,
  };
}

function writeLockFile(lockPath: string, meta: LockMetadata): void {
  const fd = openSync(lockPath, "wx"); // atomic exclusive create
  try {
    writeSync(fd, JSON.stringify(meta), null, "utf8");
    try {
      fsyncSync(fd);
    } catch {
      // fsync unsupported on some platforms/filesystems — best effort.
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Reclaim a stale lock without a read-then-delete race.
 *
 * The contender atomically renames the lock aside to a private path; only one
 * contender can win that rename. It then re-reads the moved file and confirms
 * the ownership token is the exact one it inspected. If a different lock was
 * moved (i.e. the lock was replaced between inspection and reclamation) the
 * operation fails closed and leaves the moved file behind as evidence.
 */
function reclaimStaleLock(
  lockPath: string,
  tenderId: string,
  inspected: LockMetadata,
  reclaimToken: string,
): void {
  const asidePath = `${lockPath}.stale.${reclaimToken}`;
  try {
    renameSync(lockPath, asidePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return; // another contender already reclaimed it — retry normally
    }
    throw new LifecycleLockCorruptError(
      tenderId,
      "stale lock could not be moved aside for reclamation",
      { cause: err },
    );
  }

  let movedRaw: string;
  try {
    movedRaw = readFileSync(asidePath, "utf8");
  } catch (err) {
    throw new LifecycleLockCorruptError(
      tenderId,
      "reclaimed lock became unreadable during reclamation",
      { cause: err },
    );
  }
  const moved = parseLockMetadata(movedRaw);
  if (!moved || moved.token !== inspected.token) {
    throw new LifecycleLockCorruptError(
      tenderId,
      "lock was replaced during stale reclamation; the moved lock file is preserved for inspection",
      { internalDetail: `expected token ${inspected.token}` },
    );
  }
  try {
    unlinkSync(asidePath);
  } catch {
    // Best effort: the aside copy is no longer authoritative.
  }
}

/**
 * Acquire the per-tender write lock. Bounded: always resolves or throws a typed
 * LOCK_BUSY / LOCK_TIMEOUT / LOCK_CORRUPT error.
 */
export async function acquireFileLock(
  lockPath: string,
  tenderId: string,
  config: FileLockConfig,
  now: FileLockNow,
): Promise<FileLockHandle> {
  const token = randomUUID();
  const startedAt = now();
  const deadline = startedAt + config.acquireTimeoutMs;

  for (;;) {
    const currentTimeMs = now();
    const acquiredAt = nowIso(currentTimeMs);
    const meta: LockMetadata = {
      v: LOCK_METADATA_VERSION,
      pid: process.pid,
      host: os.hostname(),
      token,
      tenderId,
      acquiredAt,
    };
    try {
      writeLockFile(lockPath, meta);
      return { lockPath, tenderId, token, acquiredAt };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }

    // Someone holds the lock. Inspect it; never steal a live or ambiguous lock.
    let existingRaw: string;
    try {
      existingRaw = readFileSync(lockPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        continue; // released between our create and our read — retry at once
      }
      throw new LifecycleLockCorruptError(tenderId, "lock file is unreadable", {
        cause: err,
      });
    }
    const existing = parseLockMetadata(existingRaw);
    if (!existing) {
      // Malformed/partial lock: fail closed. Never deleted automatically.
      throw new LifecycleLockCorruptError(
        tenderId,
        "lock metadata is malformed or incomplete",
      );
    }

    const ageMs = currentTimeMs - Date.parse(existing.acquiredAt);
    if (ageMs >= config.staleAfterMs) {
      reclaimStaleLock(lockPath, tenderId, existing, token);
      continue; // attempt a fresh exclusive create
    }

    if (config.acquireTimeoutMs === 0) {
      throw new LifecycleLockBusyError(tenderId, {
        internalDetail: `held by pid ${existing.pid}`,
      });
    }
    if (currentTimeMs + config.retryIntervalMs > deadline) {
      throw new LifecycleLockTimeoutError(tenderId, config.acquireTimeoutMs, {
        internalDetail: `held by pid ${existing.pid}`,
      });
    }
    await delay(config.retryIntervalMs);
  }
}

/**
 * Release a lock this caller owns. Returns false when the lock is missing or
 * owned by someone else — another owner's lock is never removed.
 */
export function releaseFileLock(handle: FileLockHandle): boolean {
  let raw: string;
  try {
    raw = readFileSync(handle.lockPath, "utf8");
  } catch {
    return false; // already gone or unreadable — nothing safe to remove
  }
  const meta = parseLockMetadata(raw);
  if (!meta || meta.token !== handle.token) {
    return false;
  }
  try {
    unlinkSync(handle.lockPath);
    return true;
  } catch {
    return false;
  }
}

/** True when a lock file currently exists (diagnostics/tests only). */
export function lockFileExists(lockPath: string): boolean {
  return existsSync(lockPath);
}
