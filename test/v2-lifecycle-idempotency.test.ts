import { describe, expect, it } from "vitest";

import { LifecycleActionConflictError } from "../src/v2/lifecycle/errors";
import { LifecycleService } from "../src/v2/store/lifecycle-service";
import { InMemoryLifecycleStore } from "../src/v2/store/lifecycle-store";
import {
  activationEvent,
  AUCTION_ENDS,
  BUDGET,
  defaultTrustPolicy,
  HASH,
  T0,
  TREASURY,
} from "./v2-lifecycle-fixtures";

describe("v2 lifecycle action idempotency", () => {
  async function fundedService() {
    const store = new InMemoryLifecycleStore();
    const svc = new LifecycleService(store);
    await svc.create({
      tenderId: "tender-idem",
      tenderVersion: 1,
      tenderHash: HASH,
      maximumFreightBudgetAtomic: BUDGET,
      auctionEndsAt: AUCTION_ENDS,
      createdAt: T0,
      trust: defaultTrustPolicy(),
    });
    await svc.apply("tender-idem", {
      type: "ESCROW_FUNDING_CONFIRMED",
      actionId: "fund-1",
      eventTime: T0,
      fundingTxId: "0.0.1@1.1",
      tokenId: "0.0.429274",
      fundedAmountAtomic: BUDGET,
      tenderId: "tender-idem",
      tenderVersion: 1,
    });
    return svc;
  }

  it("replays identical actionId without version bump or history growth", async () => {
    const svc = await fundedService();
    const event = activationEvent("tender-idem", 1, "activate-1", TREASURY);
    const first = await svc.apply("tender-idem", event);
    expect(first.outcome).toBe("APPLIED");
    expect(first.record.state).toBe("TENDER_OPENED");
    const version = first.record.recordVersion;
    const historyLen = first.record.history.length;

    const second = await svc.apply("tender-idem", event);
    expect(second.outcome).toBe("REPLAYED");
    expect(second.record.recordVersion).toBe(version);
    expect(second.record.history).toHaveLength(historyLen);
  });

  it("fails when the same actionId is reused with a different payload", async () => {
    const svc = await fundedService();
    const event = activationEvent("tender-idem", 1, "activate-2", TREASURY);
    await svc.apply("tender-idem", event);
    const conflicted = activationEvent("tender-idem", 1, "activate-2", TREASURY);
    if (conflicted.type !== "TENDER_ACTIVATION_PAID") {
      throw new Error("expected activation event");
    }
    await expect(
      svc.apply("tender-idem", {
        ...conflicted,
        paymentTransactionId: "0.0.1@9.9",
      }),
    ).rejects.toBeInstanceOf(LifecycleActionConflictError);
  });
});
