import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LifecycleVersionConflictError } from "../src/v2/lifecycle/errors";
import { reduceLifecycle } from "../src/v2/lifecycle/reducer";
import { LifecycleService } from "../src/v2/store/lifecycle-service";
import {
  FileLifecycleStore,
  InMemoryLifecycleStore,
} from "../src/v2/store/lifecycle-store";
import {
  AUCTION_ENDS,
  BUDGET,
  HASH,
  T0,
} from "./v2-lifecycle-fixtures";

describe("v2 lifecycle CAS store", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("in-memory CAS rejects stale expected versions", async () => {
    const store = new InMemoryLifecycleStore();
    const created = await store.create({
      tenderId: "t-cas",
      tenderVersion: 1,
      tenderHash: HASH,
      maximumFreightBudgetAtomic: BUDGET,
      auctionEndsAt: AUCTION_ENDS,
      createdAt: T0,
    });
    expect(created.recordVersion).toBe(1);

    const next = reduceLifecycle(created, {
      type: "ESCROW_FUNDING_CONFIRMED",
      actionId: "f1",
      eventTime: T0,
      fundingTxId: "tx",
      tokenId: "0.0.429274",
      fundedAmountAtomic: BUDGET,
      tenderId: "t-cas",
      tenderVersion: 1,
    });
    const applied = await store.compareAndSet("t-cas", 1, next);
    expect(applied.recordVersion).toBe(2);

    await expect(
      store.compareAndSet("t-cas", 1, next),
    ).rejects.toBeInstanceOf(LifecycleVersionConflictError);
  });

  it("filesystem CAS persists and reloads records", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rg-lc-"));
    dirs.push(dir);
    const store = new FileLifecycleStore(dir);
    const svc = new LifecycleService(store);
    await svc.create({
      tenderId: "t-file",
      tenderVersion: 1,
      tenderHash: HASH,
      maximumFreightBudgetAtomic: BUDGET,
      auctionEndsAt: AUCTION_ENDS,
      createdAt: T0,
    });
    await svc.apply("t-file", {
      type: "ESCROW_FUNDING_CONFIRMED",
      actionId: "f1",
      eventTime: T0,
      fundingTxId: "tx",
      tokenId: "0.0.429274",
      fundedAmountAtomic: BUDGET,
      tenderId: "t-file",
      tenderVersion: 1,
    });

    const store2 = new FileLifecycleStore(dir);
    const loaded = await store2.get("t-file");
    expect(loaded?.state).toBe("ESCROW_FUNDED");
    expect(loaded?.recordVersion).toBe(2);
  });
});
