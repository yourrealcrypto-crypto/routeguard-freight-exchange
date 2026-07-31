/**
 * Phase A3b — per-tender cross-process write lock (RG-V2-A-004).
 * Ownership, bounded waiting, stale-lock policy, fail-closed corruption.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireFileLock,
  parseLockMetadata,
  releaseFileLock,
  resolveFileLockConfig,
  type FileLockHandle,
} from "../src/v2/store/file-lock";
import { LifecyclePersistenceError } from "../src/v2/store/persistence-errors";

const FAST = resolveFileLockConfig({
  acquireTimeoutMs: 120,
  retryIntervalMs: 5,
  staleAfterMs: 1_000,
});
const NO_WAIT = resolveFileLockConfig({
  acquireTimeoutMs: 0,
  retryIntervalMs: 5,
  staleAfterMs: 1_000,
});

async function expectCode(
  fn: () => Promise<unknown>,
  code: string,
): Promise<LifecyclePersistenceError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(LifecyclePersistenceError);
    expect((err as LifecyclePersistenceError).code).toBe(code);
    return err as LifecyclePersistenceError;
  }
  throw new Error(`expected a ${code} failure`);
}

describe("v2 lifecycle file lock", () => {
  const dirs: string[] = [];

  function newDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "rg-v2-lock-"));
    dirs.push(dir);
    return dir;
  }

  function writeForeignLock(
    lockPath: string,
    opts: { ageMs: number; token?: string },
  ): string {
    const token = opts.token ?? "foreign-token-0000000000";
    writeFileSync(
      lockPath,
      JSON.stringify({
        v: 1,
        pid: 999_999,
        host: "other-host",
        token,
        tenderId: "t-lock",
        acquiredAt: new Date(Date.now() - opts.ageMs).toISOString(),
      }),
      "utf8",
    );
    return token;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("acquires exclusively and releases its own lock", async () => {
    const dir = newDir();
    const lockPath = path.join(dir, "t-lock.lock");
    const handle = await acquireFileLock(lockPath, "t-lock", FAST);
    expect(existsSync(lockPath)).toBe(true);
    const meta = parseLockMetadata(readFileSync(lockPath, "utf8"));
    expect(meta?.token).toBe(handle.token);
    expect(meta?.pid).toBe(process.pid);
    expect(meta?.tenderId).toBe("t-lock");

    expect(releaseFileLock(handle)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("a fresh lock held by another writer cannot be reclaimed", async () => {
    const dir = newDir();
    const lockPath = path.join(dir, "t-lock.lock");
    const token = writeForeignLock(lockPath, { ageMs: 0 });

    await expectCode(
      () => acquireFileLock(lockPath, "t-lock", NO_WAIT),
      "LOCK_BUSY",
    );
    // The other writer's lock is untouched.
    expect(parseLockMetadata(readFileSync(lockPath, "utf8"))?.token).toBe(token);
  });

  it("lock acquisition is bounded and times out", async () => {
    const dir = newDir();
    const lockPath = path.join(dir, "t-lock.lock");
    writeForeignLock(lockPath, { ageMs: 0 });

    const startedAt = Date.now();
    const err = await expectCode(
      () => acquireFileLock(lockPath, "t-lock", FAST),
      "LOCK_TIMEOUT",
    );
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(3_000);
    expect(err.message).toContain("t-lock");
    expect(err.message).not.toContain(dir);
  });

  it("a stale valid lock is reclaimed safely", async () => {
    const dir = newDir();
    const lockPath = path.join(dir, "t-lock.lock");
    const foreignToken = writeForeignLock(lockPath, { ageMs: 5_000 });

    const handle = await acquireFileLock(lockPath, "t-lock", FAST);
    const meta = parseLockMetadata(readFileSync(lockPath, "utf8"));
    expect(meta?.token).toBe(handle.token);
    expect(meta?.token).not.toBe(foreignToken);
    // The reclaimed copy is not left behind on the happy path.
    expect(existsSync(`${lockPath}.stale.${handle.token}`)).toBe(false);
    releaseFileLock(handle);
  });

  it("malformed lock metadata fails closed and is never deleted", async () => {
    const dir = newDir();
    const lockPath = path.join(dir, "t-lock.lock");
    writeFileSync(lockPath, '{"v":1,"pid":', "utf8"); // truncated

    await expectCode(
      () => acquireFileLock(lockPath, "t-lock", FAST),
      "LOCK_CORRUPT",
    );
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe('{"v":1,"pid":');
  });

  it("an empty lock file fails closed rather than being stolen", async () => {
    const dir = newDir();
    const lockPath = path.join(dir, "t-lock.lock");
    writeFileSync(lockPath, "", "utf8");

    await expectCode(
      () => acquireFileLock(lockPath, "t-lock", FAST),
      "LOCK_CORRUPT",
    );
    expect(existsSync(lockPath)).toBe(true);
  });

  it("a process cannot release another owner's lock", async () => {
    const dir = newDir();
    const lockPath = path.join(dir, "t-lock.lock");
    const token = writeForeignLock(lockPath, { ageMs: 0 });

    const impostor: FileLockHandle = {
      lockPath,
      tenderId: "t-lock",
      token: "not-the-owner-token-000",
      acquiredAt: new Date().toISOString(),
    };
    expect(releaseFileLock(impostor)).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    expect(parseLockMetadata(readFileSync(lockPath, "utf8"))?.token).toBe(token);
  });

  it("locks are per tender and do not block each other", async () => {
    const dir = newDir();
    const lockA = path.join(dir, "t-a.lock");
    const lockB = path.join(dir, "t-b.lock");

    const a = await acquireFileLock(lockA, "t-a", FAST);
    // A different tender acquires immediately even with a zero wait budget.
    const b = await acquireFileLock(lockB, "t-b", NO_WAIT);
    expect(a.token).not.toBe(b.token);

    releaseFileLock(a);
    releaseFileLock(b);
    expect(existsSync(lockA)).toBe(false);
    expect(existsSync(lockB)).toBe(false);
  });

  it("rejects lock metadata with a wrong version or missing fields", () => {
    expect(parseLockMetadata(JSON.stringify({ v: 2, pid: 1 }))).toBeNull();
    expect(parseLockMetadata("[]")).toBeNull();
    expect(
      parseLockMetadata(
        JSON.stringify({ v: 1, pid: 1, host: "h", token: "t", tenderId: "x" }),
      ),
    ).toBeNull();
    expect(
      parseLockMetadata(
        JSON.stringify({
          v: 1,
          pid: 1,
          host: "h",
          token: "short",
          tenderId: "x",
          acquiredAt: new Date().toISOString(),
        }),
      ),
    ).toBeNull();
  });
});
