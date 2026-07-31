import { describe, expect, it } from "vitest";

import {
  bidSubmitResource,
  tenderActivateResource,
} from "../src/v2/access/resource";
import { deriveAccessFeeAtomic } from "../src/v2/access/fee";
import { reduceLifecycle } from "../src/v2/lifecycle/reducer";
import { LifecycleService } from "../src/v2/store/lifecycle-service";
import { InMemoryLifecycleStore } from "../src/v2/store/lifecycle-store";
import {
  activationEvent,
  AUCTION_ENDS,
  baseRecord,
  BUDGET,
  defaultTrustPolicy,
  fund,
  HASH,
  T0,
  TREASURY,
} from "./v2-lifecycle-fixtures";

describe("v2 access policy binding", () => {
  it("builds versioned resources for tender and bid actions", () => {
    expect(tenderActivateResource("t1", 2)).toBe(
      "/api/v2/tenders/t1/v/2/activate",
    );
    expect(bidSubmitResource("t1", 2, "bid-9")).toBe(
      "/api/v2/tenders/t1/v/2/bids/bid-9",
    );
    expect(tenderActivateResource("t1", 1)).not.toBe(
      tenderActivateResource("t1", 2),
    );
  });

  it("rejects access resource without tenderVersion", () => {
    const r = fund(baseRecord());
    expect(() =>
      reduceLifecycle(r, {
        type: "TENDER_ACTIVATION_PAID",
        actionId: "a1",
        eventTime: T0,
        accessActionType: "TENDER_ACTIVATE",
        asset: "0.0.429274",
        amountAtomic: deriveAccessFeeAtomic(),
        resource: `/api/v2/tenders/${r.tenderId}/activate`,
        paymentTransactionId: "tx",
        paymentPayloadHash: HASH,
        payerAccount: "0.0.9197513",
        payTo: TREASURY,
      }),
    ).toThrow(/resource|ACCESS_RESOURCE/i);
  });

  it("rejects access receipt for another tenderVersion", () => {
    const r = fund(baseRecord());
    expect(r.tenderVersion).toBe(1);
    expect(() =>
      reduceLifecycle(r, {
        type: "TENDER_ACTIVATION_PAID",
        actionId: "a1",
        eventTime: T0,
        accessActionType: "TENDER_ACTIVATE",
        asset: "0.0.429274",
        amountAtomic: deriveAccessFeeAtomic(),
        resource: tenderActivateResource(r.tenderId, 99),
        paymentTransactionId: "tx",
        paymentPayloadHash: HASH,
        payerAccount: "0.0.9197513",
        payTo: TREASURY,
      }),
    ).toThrow(/resource|ACCESS_RESOURCE/i);
  });

  it("rejects wrong payTo; accepts configured treasury", () => {
    const r = fund(baseRecord());
    expect(() =>
      reduceLifecycle(r, {
        type: "TENDER_ACTIVATION_PAID",
        actionId: "a1",
        eventTime: T0,
        accessActionType: "TENDER_ACTIVATE",
        asset: "0.0.429274",
        amountAtomic: deriveAccessFeeAtomic(),
        resource: tenderActivateResource(r.tenderId, r.tenderVersion),
        paymentTransactionId: "tx",
        paymentPayloadHash: HASH,
        payerAccount: "0.0.9197513",
        payTo: "0.0.9215954",
      }),
    ).toThrow(/treasury|ACCESS_TREASURY/i);

    const ok = reduceLifecycle(r, {
      type: "TENDER_ACTIVATION_PAID",
      actionId: "a2",
      eventTime: T0,
      accessActionType: "TENDER_ACTIVATE",
      asset: "0.0.429274",
      amountAtomic: deriveAccessFeeAtomic(),
      resource: tenderActivateResource(r.tenderId, r.tenderVersion),
      paymentTransactionId: "tx",
      paymentPayloadHash: HASH,
      payerAccount: "0.0.9197513",
      payTo: TREASURY,
    });
    expect(ok.state).toBe("TENDER_OPENED");
  });

  it("keeps tender and bid access actions distinct", () => {
    const activate = tenderActivateResource("t1", 1);
    const bid = bidSubmitResource("t1", 1, "bid-1");
    expect(activate).not.toBe(bid);
    expect(activate).toContain("/activate");
    expect(bid).toContain("/bids/");
  });

  it("service path enforces treasury via record trust snapshot", async () => {
    const store = new InMemoryLifecycleStore();
    const svc = new LifecycleService(store);
    await svc.create({
      tenderId: "t-access",
      tenderVersion: 3,
      tenderHash: HASH,
      maximumFreightBudgetAtomic: BUDGET,
      auctionEndsAt: AUCTION_ENDS,
      createdAt: T0,
      trust: defaultTrustPolicy({ accessTreasuryAccountId: TREASURY }),
    });
    await svc.apply("t-access", {
      type: "ESCROW_FUNDING_CONFIRMED",
      actionId: "f1",
      eventTime: T0,
      fundingTxId: "tx",
      tokenId: "0.0.429274",
      fundedAmountAtomic: BUDGET,
      tenderId: "t-access",
      tenderVersion: 3,
    });
    await expect(
      svc.apply(
        "t-access",
        activationEvent("t-access", 3, "act", "0.0.1"),
      ),
    ).rejects.toThrow();
    const ok = await svc.apply(
      "t-access",
      activationEvent("t-access", 3, "act2", TREASURY),
    );
    expect(ok.record.state).toBe("TENDER_OPENED");
  });

  it("exact access fee remains 1000 atomic", () => {
    expect(deriveAccessFeeAtomic()).toBe("1000");
  });
});
