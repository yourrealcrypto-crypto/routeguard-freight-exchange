/**
 * Phase A3b — atomic-write failure handling (RG-V2-A-004).
 * A failed temp write or a failed replacement must preserve the previous
 * authoritative record, clean up only the owned temp file, and release the lock.
 */

import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  failTempCreate: false,
  failReplace: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    openSync: (file: string, flags: string, mode?: number) => {
      if (control.failTempCreate && String(file).endsWith(".tmp")) {
        throw Object.assign(new Error("simulated temp create failure"), {
          code: "EACCES",
        });
      }
      return actual.openSync(file, flags as never, mode as never);
    },
    renameSync: (from: string, to: string) => {
      if (control.failReplace && String(to).endsWith(".json")) {
        throw Object.assign(new Error("simulated replacement failure"), {
          code: "EPERM",
        });
      }
      return actual.renameSync(from, to);
    },
  };
});

const {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} = await import("node:fs");

const { reduceLifecycle } = await import("../src/v2/lifecycle/reducer");
const { FileLifecycleStore } = await import("../src/v2/store/lifecycle-store");
const { AUCTION_ENDS, BUDGET, defaultTrustPolicy, HASH, T0 } = await import(
  "./v2-lifecycle-fixtures"
);

describe("v2 lifecycle atomic write failure handling", () => {
  const dirs: string[] = [];

  function newDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "rg-v2-atomic-"));
    dirs.push(dir);
    return dir;
  }

  async function seed(dir: string) {
    const store = new FileLifecycleStore(dir);
    const created = await store.create({
      tenderId: "t-atomic",
      tenderVersion: 1,
      tenderHash: HASH,
      maximumFreightBudgetAtomic: BUDGET,
      auctionEndsAt: AUCTION_ENDS,
      createdAt: T0,
      trust: defaultTrustPolicy(),
    });
    const next = reduceLifecycle(created, {
      type: "ESCROW_FUNDING_CONFIRMED",
      actionId: "fund-1",
      eventTime: T0,
      fundingTxId: "0.0.1@1.1",
      tokenId: "0.0.429274",
      fundedAmountAtomic: BUDGET,
      tenderId: "t-atomic",
      tenderVersion: 1,
    });
    return { store, created, next };
  }

  afterEach(() => {
    control.failTempCreate = false;
    control.failReplace = false;
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a failed temp write preserves the previous authoritative record", async () => {
    const dir = newDir();
    const { store, next } = await seed(dir);
    const fp = path.join(dir, "lifecycle-t-atomic.json");
    const before = readFileSync(fp, "utf8");

    control.failTempCreate = true;
    await expect(store.compareAndSet("t-atomic", 1, next)).rejects.toMatchObject({
      code: "ATOMIC_WRITE_FAILED",
    });
    control.failTempCreate = false;

    expect(readFileSync(fp, "utf8")).toBe(before);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
    expect(existsSync(path.join(dir, "lifecycle-t-atomic.lock"))).toBe(false);
    expect((await store.get("t-atomic"))?.recordVersion).toBe(1);
  });

  it("a failed replacement preserves the previous authoritative record", async () => {
    const dir = newDir();
    const { store, next } = await seed(dir);
    const fp = path.join(dir, "lifecycle-t-atomic.json");
    const before = readFileSync(fp, "utf8");

    control.failReplace = true;
    await expect(store.compareAndSet("t-atomic", 1, next)).rejects.toMatchObject({
      code: "ATOMIC_WRITE_FAILED",
    });
    control.failReplace = false;

    expect(readFileSync(fp, "utf8")).toBe(before);
    // Only the temp file owned by the failed operation is cleaned up.
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
    expect(existsSync(path.join(dir, "lifecycle-t-atomic.lock"))).toBe(false);
    expect((await store.get("t-atomic"))?.state).toBe("DRAFT");
  });

  it("recovers normally once the fault clears", async () => {
    const dir = newDir();
    const { store, next } = await seed(dir);

    control.failReplace = true;
    await expect(store.compareAndSet("t-atomic", 1, next)).rejects.toMatchObject({
      code: "ATOMIC_WRITE_FAILED",
    });
    control.failReplace = false;

    const applied = await store.compareAndSet("t-atomic", 1, next);
    expect(applied.recordVersion).toBe(2);
    expect(applied.state).toBe("ESCROW_FUNDED");
    expect((await new FileLifecycleStore(dir).get("t-atomic"))?.recordVersion).toBe(2);
  });
});
