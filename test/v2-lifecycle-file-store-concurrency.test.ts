/**
 * Phase A3b — file-store concurrency, durability, and adapter parity
 * (RG-V2-A-004). Two writers can never both commit from the same version, and
 * lifecycle + action-id state are always committed together.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalSha256 } from "../src/domain/canonical-hash";
import {
  LifecycleActionConflictError,
  LifecycleVersionConflictError,
} from "../src/v2/lifecycle/errors";
import type { LifecycleEvent } from "../src/v2/lifecycle/events";
import type { CreateLifecycleInput, LifecycleRecord } from "../src/v2/lifecycle/record";
import { reduceLifecycle } from "../src/v2/lifecycle/reducer";
import { LifecycleService } from "../src/v2/store/lifecycle-service";
import {
  cleanupAbandonedLifecycleTempFiles,
  FileLifecycleStore,
  InMemoryLifecycleStore,
} from "../src/v2/store/lifecycle-store";
import {
  activationEvent,
  AUCTION_ENDS,
  BUDGET,
  defaultTrustPolicy,
  HASH,
  T0,
  TREASURY,
} from "./v2-lifecycle-fixtures";

const TRUST = defaultTrustPolicy();

function createInput(tenderId: string): CreateLifecycleInput {
  return {
    tenderId,
    tenderVersion: 1,
    tenderHash: HASH,
    maximumFreightBudgetAtomic: BUDGET,
    auctionEndsAt: AUCTION_ENDS,
    createdAt: T0,
    trust: TRUST,
  };
}

function fundingEvent(tenderId: string, actionId: string): LifecycleEvent {
  return {
    type: "ESCROW_FUNDING_CONFIRMED",
    actionId,
    eventTime: T0,
    fundingTxId: `0.0.1@1.${actionId}`,
    tokenId: "0.0.429274",
    fundedAmountAtomic: BUDGET,
    tenderId,
    tenderVersion: 1,
  };
}

describe("v2 lifecycle file store concurrency and durability", () => {
  const dirs: string[] = [];

  function newDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "rg-v2-store-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exactly one of two concurrent writers commits from the same version", async () => {
    const dir = newDir();
    // Separate store instances: the in-memory mutex cannot help here, so the
    // filesystem lock and the CAS re-read are what enforce exclusion.
    const storeA = new FileLifecycleStore(dir);
    const storeB = new FileLifecycleStore(dir);
    const created = await storeA.create(createInput("t-race"));
    expect(created.recordVersion).toBe(1);

    const nextA = reduceLifecycle(created, fundingEvent("t-race", "fund-a"));
    const nextB = reduceLifecycle(created, fundingEvent("t-race", "fund-b"));

    const results = await Promise.allSettled([
      storeA.compareAndSet("t-race", 1, nextA),
      storeB.compareAndSet("t-race", 1, nextB),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      LifecycleVersionConflictError,
    );

    // No last-write-wins: exactly one transition is durable.
    const persisted = await new FileLifecycleStore(dir).get("t-race");
    expect(persisted?.recordVersion).toBe(2);
    expect(persisted?.state).toBe("ESCROW_FUNDED");
    expect(Object.keys(persisted!.processedActions)).toHaveLength(1);
    expect(persisted!.history).toHaveLength(1);

    const winner = (fulfilled[0] as PromiseFulfilledResult<LifecycleRecord>).value;
    expect(persisted!.lastActionId).toBe(winner.lastActionId);
    // The lock is released after the rename, not held afterwards.
    expect(existsSync(path.join(dir, "lifecycle-t-race.lock"))).toBe(false);
  });

  it("many concurrent writers produce exactly one commit per version", async () => {
    const dir = newDir();
    const stores = Array.from({ length: 6 }, () => new FileLifecycleStore(dir));
    const created = await stores[0]!.create(createInput("t-storm"));

    const results = await Promise.allSettled(
      stores.map((store, i) =>
        store.compareAndSet(
          "t-storm",
          1,
          reduceLifecycle(created, fundingEvent("t-storm", `fund-${i}`)),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const rejection of results.filter((r) => r.status === "rejected")) {
      expect((rejection as PromiseRejectedResult).reason).toBeInstanceOf(
        LifecycleVersionConflictError,
      );
    }
    const persisted = await new FileLifecycleStore(dir).get("t-storm");
    expect(persisted?.recordVersion).toBe(2);
    expect(persisted!.history).toHaveLength(1);
  });

  it("concurrent writes for different tenders do not block each other", async () => {
    const dir = newDir();
    const store = new FileLifecycleStore(dir, { lock: { acquireTimeoutMs: 0 } });
    await store.create(createInput("t-one"));
    await store.create(createInput("t-two"));

    // A foreign live lock on t-one must not delay t-two (no global lock).
    writeFileSync(
      path.join(dir, "lifecycle-t-one.lock"),
      JSON.stringify({
        v: 1,
        pid: 999_999,
        host: "other",
        token: "foreign-token-00000000",
        tenderId: "t-one",
        acquiredAt: new Date().toISOString(),
      }),
      "utf8",
    );

    const created = await store.get("t-two");
    const applied = await store.compareAndSet(
      "t-two",
      1,
      reduceLifecycle(created!, fundingEvent("t-two", "fund-two")),
    );
    expect(applied.recordVersion).toBe(2);

    await expect(
      store.compareAndSet(
        "t-one",
        1,
        reduceLifecycle((await store.get("t-one"))!, fundingEvent("t-one", "f1")),
      ),
    ).rejects.toMatchObject({ code: "LOCK_BUSY" });
  });

  it("temporary files are never treated as authoritative", async () => {
    const dir = newDir();
    const store = new FileLifecycleStore(dir);
    await store.create(createInput("t-temp"));
    const applied = await store.compareAndSet(
      "t-temp",
      1,
      reduceLifecycle((await store.get("t-temp"))!, fundingEvent("t-temp", "f1")),
    );
    expect(applied.recordVersion).toBe(2);

    // A stray temp file — newer on disk, and deliberately garbage.
    const stray = path.join(dir, ".lifecycle-t-temp.123.tok.abc.tmp");
    writeFileSync(stray, '{"storageSchema":"attacker"}', "utf8");

    const reloaded = await new FileLifecycleStore(dir).get("t-temp");
    expect(reloaded?.state).toBe("ESCROW_FUNDED");
    expect(reloaded?.recordVersion).toBe(2);

    // No temp file survives a normal write cycle.
    const temps = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(temps).toEqual([".lifecycle-t-temp.123.tok.abc.tmp"]);

    const recovery = cleanupAbandonedLifecycleTempFiles(dir, { minimumAgeMs: 0 });
    expect(recovery.removed).toContain(".lifecycle-t-temp.123.tok.abc.tmp");
    expect(existsSync(path.join(dir, "lifecycle-t-temp.json"))).toBe(true);
    expect((await new FileLifecycleStore(dir).get("t-temp"))?.recordVersion).toBe(2);
  });

  it("recent temp files are retained and authoritative files are never removed", async () => {
    const dir = newDir();
    const store = new FileLifecycleStore(dir);
    await store.create(createInput("t-keep"));
    const stray = path.join(dir, ".lifecycle-t-keep.9.tok.def.tmp");
    writeFileSync(stray, "partial", "utf8");

    const recovery = cleanupAbandonedLifecycleTempFiles(dir, {
      minimumAgeMs: 60_000,
    });
    expect(recovery.removed).toHaveLength(0);
    expect(recovery.retained).toContain(".lifecycle-t-keep.9.tok.def.tmp");
    expect(existsSync(path.join(dir, "lifecycle-t-keep.json"))).toBe(true);
  });

  it("a rejected CAS leaves the previous authoritative state intact", async () => {
    const dir = newDir();
    const store = new FileLifecycleStore(dir);
    const created = await store.create(createInput("t-intact"));
    const fp = path.join(dir, "lifecycle-t-intact.json");
    const before = readFileSync(fp, "utf8");

    const tampered: LifecycleRecord = {
      ...reduceLifecycle(created, fundingEvent("t-intact", "f1")),
      // Structurally impossible: funded state without a funding reference.
      fundingTxId: null,
    };
    await expect(store.compareAndSet("t-intact", 1, tampered)).rejects.toMatchObject({
      code: "RECORD_CORRUPT",
    });

    expect(readFileSync(fp, "utf8")).toBe(before);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
    expect(existsSync(path.join(dir, "lifecycle-t-intact.lock"))).toBe(false);
  });

  it("lifecycle and action-id state are committed atomically", async () => {
    const dir = newDir();
    const svc = new LifecycleService(new FileLifecycleStore(dir));
    await svc.create(createInput("t-atomic"));
    await svc.apply("t-atomic", fundingEvent("t-atomic", "fund-1"));
    const applied = await svc.apply(
      "t-atomic",
      activationEvent("t-atomic", 1, "activate-1", TREASURY),
    );
    expect(applied.record.state).toBe("TENDER_OPENED");

    const envelope = JSON.parse(
      readFileSync(path.join(dir, "lifecycle-t-atomic.json"), "utf8"),
    ) as {
      recordVersion: number;
      actions: { actionId: string; recordVersionAfter: number }[];
      record: { processedActions: Record<string, unknown>; history: unknown[] };
    };
    // One file, one rename: the transition and its action record land together.
    expect(envelope.recordVersion).toBe(3);
    expect(envelope.actions.map((a) => a.actionId).sort()).toEqual([
      "activate-1",
      "fund-1",
    ]);
    expect(Object.keys(envelope.record.processedActions)).toHaveLength(2);
    expect(envelope.record.history).toHaveLength(2);
  });

  it("replays identically after a restart and rejects conflicting reuse", async () => {
    const dir = newDir();
    const first = new LifecycleService(new FileLifecycleStore(dir));
    await first.create(createInput("t-restart"));
    await first.apply("t-restart", fundingEvent("t-restart", "fund-1"));
    const original = await first.apply(
      "t-restart",
      activationEvent("t-restart", 1, "activate-1", TREASURY),
    );

    // New process-equivalent: fresh store + service instances over the same dir.
    const restarted = new LifecycleService(new FileLifecycleStore(dir));
    const replay = await restarted.apply(
      "t-restart",
      activationEvent("t-restart", 1, "activate-1", TREASURY),
    );
    expect(replay.outcome).toBe("REPLAYED");
    expect(replay.record.recordVersion).toBe(original.record.recordVersion);
    expect(replay.record.history).toHaveLength(original.record.history.length);
    expect(canonicalSha256(replay.record)).toBe(canonicalSha256(original.record));

    const conflicting = activationEvent("t-restart", 1, "activate-1", TREASURY);
    if (conflicting.type !== "TENDER_ACTIVATION_PAID") throw new Error("bad fixture");
    await expect(
      restarted.apply("t-restart", {
        ...conflicting,
        paymentTransactionId: "0.0.1@9.9",
      }),
    ).rejects.toBeInstanceOf(LifecycleActionConflictError);

    const after = await new FileLifecycleStore(dir).get("t-restart");
    expect(after?.recordVersion).toBe(original.record.recordVersion);
  });

  it("the file store and the in-memory store produce equivalent results", async () => {
    const dir = newDir();
    const fileSvc = new LifecycleService(new FileLifecycleStore(dir));
    const memSvc = new LifecycleService(new InMemoryLifecycleStore());

    for (const svc of [fileSvc, memSvc]) {
      await svc.create(createInput("t-parity"));
      await svc.apply("t-parity", fundingEvent("t-parity", "fund-1"));
      await svc.apply(
        "t-parity",
        activationEvent("t-parity", 1, "activate-1", TREASURY),
      );
    }

    const fileRecord = await fileSvc.get("t-parity");
    const memRecord = await memSvc.get("t-parity");
    expect(canonicalSha256(fileRecord)).toBe(canonicalSha256(memRecord));

    // Identical replay, conflict, and stale-version semantics.
    for (const svc of [fileSvc, memSvc]) {
      const replayed = await svc.apply(
        "t-parity",
        activationEvent("t-parity", 1, "activate-1", TREASURY),
      );
      expect(replayed.outcome).toBe("REPLAYED");
    }

    const fileStore = new FileLifecycleStore(dir);
    const memStore = new InMemoryLifecycleStore();
    await memStore.create(createInput("t-stale"));
    await fileStore.create(createInput("t-stale"));
    for (const store of [fileStore, memStore]) {
      const current = (await store.get("t-stale"))!;
      const next = reduceLifecycle(current, fundingEvent("t-stale", "f1"));
      await store.compareAndSet("t-stale", 1, next);
      await expect(
        store.compareAndSet("t-stale", 1, next),
      ).rejects.toBeInstanceOf(LifecycleVersionConflictError);
      await expect(
        store.compareAndSet("t-missing", 1, next),
      ).rejects.toThrow();
    }
  });

  it("both adapters refuse to drop or rewrite a committed action record", async () => {
    const dir = newDir();
    const fileStore = new FileLifecycleStore(dir);
    const memStore = new InMemoryLifecycleStore();
    for (const store of [fileStore, memStore]) {
      const created = await store.create(createInput("t-actions"));
      const funded = await store.compareAndSet(
        "t-actions",
        1,
        reduceLifecycle(created, fundingEvent("t-actions", "fund-1")),
      );
      const withoutAction: LifecycleRecord = {
        ...funded,
        recordVersion: 3,
        processedActions: {},
      };
      await expect(
        store.compareAndSet("t-actions", 2, withoutAction),
      ).rejects.toBeInstanceOf(LifecycleActionConflictError);
    }
  });
});
