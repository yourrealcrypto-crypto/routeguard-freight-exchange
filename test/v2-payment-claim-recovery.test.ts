import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type {
  PaymentClaim,
  PaymentRecoveryFaultBoundary,
  PaymentSettlementReconciler,
} from "../src/v2/access/payment-claim";
import type { SettledAccessPayment } from "../src/v2/access/x402-gate";
import { pendingBidCommitmentEnvelopes } from "../src/v2/hcs/outbox";
import {
  FilePaymentClaimStore,
  InMemoryPaymentClaimStore,
} from "../src/v2/store/payment-claim-store";
import {
  activatePath,
  bidPath,
  BID_ID,
  createHarness,
  post,
  SERVER_NOW,
  signBid,
  testBid,
  type Harness,
} from "./v2-access-route-fixtures";

function oneShotFault(boundary: PaymentRecoveryFaultBoundary) {
  let armed = true;
  return async (seen: PaymentRecoveryFaultBoundary): Promise<void> => {
    if (armed && seen === boundary) {
      armed = false;
      throw new Error(`simulated crash at ${boundary}`);
    }
  };
}

function bidRequest(actionId = "bid-recover") {
  const bid = testBid();
  return {
    actionId,
    signedAt: SERVER_NOW,
    signature: signBid({ bid, actionId }),
    bid,
  };
}

async function payActivation(h: Harness, actionId = "activate-recover") {
  const header = await h.paymentHeader(h.activationBinding());
  return post(h.app, activatePath(), { actionId }, { "X-PAYMENT": header });
}

async function openForBid(h: Harness): Promise<void> {
  const response = await payActivation(h, "activate-open");
  expect(response.status).toBe(200);
  h.facilitator.resetCounts();
}

async function payBid(h: Harness, actionId = "bid-recover") {
  const header = await h.paymentHeader(h.bidBinding());
  return post(h.app, bidPath(), bidRequest(actionId), { "X-PAYMENT": header });
}

function settlementFor(claim: PaymentClaim): SettledAccessPayment {
  return {
    transactionId: "0.0.5555@1770000000.000000001",
    payerAccount: claim.binding.payerAccount,
    payTo: claim.binding.payTo,
    asset: claim.binding.asset,
    amountAtomic: claim.binding.amountAtomic,
    resource: claim.binding.resource,
    paymentPayloadHash: claim.binding.paymentPayloadHash,
    consensusTimestamp: SERVER_NOW,
    settledAt: SERVER_NOW,
  };
}

describe("v2 durable payment claim recovery", () => {
  it("creates CLAIMED before any settlement call", async () => {
    const h = await createHarness({ paymentFault: oneShotFault("AFTER_CLAIM_CREATED") });
    expect((await payActivation(h)).status).toBe(500);
    expect(h.facilitator.settleCalls).toBe(0);
    expect((await h.paymentClaims.getByActionId("activate-recover"))?.state).toBe("CLAIMED");
  });

  it("persists settlement identity before activation resource commit", async () => {
    const h = await createHarness({ paymentFault: oneShotFault("AFTER_SETTLEMENT") });
    expect((await payActivation(h)).status).toBe(500);
    const claim = await h.paymentClaims.getByActionId("activate-recover");
    expect(claim?.state).toBe("SETTLED_PENDING_COMMIT");
    expect(claim?.settlement?.transactionId).toMatch(/^0\.0\.\d+@/);
    expect((await h.record())?.state).toBe("ESCROW_FUNDED");
  });

  it("recovers activation after settlement without a second settlement", async () => {
    const h = await createHarness({ paymentFault: oneShotFault("AFTER_SETTLEMENT") });
    await payActivation(h);
    const retry = await payActivation(h);
    expect(retry.status).toBe(200);
    expect(h.facilitator.settleCalls).toBe(1);
    expect((await h.paymentClaims.getByActionId("activate-recover"))?.state).toBe("COMMITTED");
  });

  it("recovers from the explicit pre-resource-commit fault boundary", async () => {
    const h = await createHarness({ paymentFault: oneShotFault("BEFORE_RESOURCE_COMMIT") });
    expect((await payActivation(h)).status).toBe(500);
    expect((await h.record())?.state).toBe("ESCROW_FUNDED");
    expect((await payActivation(h)).status).toBe(200);
    expect(h.facilitator.settleCalls).toBe(1);
  });

  it("recovers a bid after settlement exactly once", async () => {
    let armed = false;
    const h = await createHarness({
      paymentFault: async (boundary, claim) => {
        if (armed && boundary === "AFTER_SETTLEMENT" && claim.binding.actionType === "BID_SUBMIT") {
          armed = false;
          throw new Error("simulated bid crash");
        }
      },
    });
    await openForBid(h);
    armed = true;
    await payBid(h);
    const retry = await payBid(h);
    expect(retry.status).toBe(200);
    expect(h.facilitator.settleCalls).toBe(1);
    const record = (await h.record())!;
    expect(record.bidRegistry).toHaveLength(1);
    expect(pendingBidCommitmentEnvelopes(record)).toHaveLength(1);
  });

  it("finalizes activation after a crash following protected commit", async () => {
    const h = await createHarness({ paymentFault: oneShotFault("AFTER_RESOURCE_COMMIT") });
    await payActivation(h);
    const version = (await h.record())!.recordVersion;
    const retry = await payActivation(h);
    expect(retry.status).toBe(200);
    expect((await h.record())!.recordVersion).toBe(version);
    expect(h.facilitator.settleCalls).toBe(1);
  });

  it("finalizes bid after a crash before claim finalization without duplication", async () => {
    let armed = false;
    const h = await createHarness({
      paymentFault: async (boundary, claim) => {
        if (armed && boundary === "BEFORE_CLAIM_FINALIZATION" && claim.binding.actionType === "BID_SUBMIT") {
          armed = false;
          throw new Error("simulated bid finalization crash");
        }
      },
    });
    await openForBid(h);
    armed = true;
    await payBid(h);
    const version = (await h.record())!.recordVersion;
    await payBid(h);
    const record = (await h.record())!;
    expect(record.recordVersion).toBe(version);
    expect(record.bidRegistry).toHaveLength(1);
    expect(pendingBidCommitmentEnvelopes(record)).toHaveLength(1);
    expect(await h.bidBodies.get(record.tenderId, record.tenderVersion, BID_ID)).not.toBeNull();
  });

  it("returns committed activation without facilitator activity or lifecycle bump", async () => {
    const h = await createHarness();
    await payActivation(h);
    const version = (await h.record())!.recordVersion;
    h.facilitator.resetCounts();
    const response = await payActivation(h);
    expect(response.status).toBe(200);
    expect((await response.json()).outcome).toBe("REPLAYED");
    expect(h.facilitator.settleCalls).toBe(0);
    expect((await h.record())!.recordVersion).toBe(version);
  });

  it("returns committed bid without duplicate registry, outbox, or body", async () => {
    const h = await createHarness();
    await openForBid(h);
    await payBid(h);
    const before = await h.bidBodies.get("tender-b1", 1, BID_ID);
    h.facilitator.resetCounts();
    const response = await payBid(h);
    const record = (await h.record())!;
    expect(response.status).toBe(200);
    expect(h.facilitator.settleCalls).toBe(0);
    expect(record.bidRegistry).toHaveLength(1);
    expect(pendingBidCommitmentEnvelopes(record)).toHaveLength(1);
    expect(await h.bidBodies.get("tender-b1", 1, BID_ID)).toEqual(before);
  });

  it("uses reconciliation for an unknown settlement and never resettles", async () => {
    let reconcileCalls = 0;
    const reconciler: PaymentSettlementReconciler = {
      async reconcile() { reconcileCalls += 1; return { status: "UNKNOWN" }; },
    };
    const h = await createHarness({
      script: { settle: async () => { throw new Error("timeout after submit"); } },
      paymentReconciler: reconciler,
    });
    expect((await payActivation(h)).status).toBe(503);
    expect((await payActivation(h)).status).toBe(503);
    expect(reconcileCalls).toBe(1);
    expect(h.facilitator.settleCalls).toBe(1);
    expect((await h.record())?.state).toBe("ESCROW_FUNDED");
  });

  it("commits after reconciliation confirms the unknown settlement", async () => {
    const reconciler: PaymentSettlementReconciler = {
      async reconcile(claim) { return { status: "CONFIRMED", settlement: settlementFor(claim) }; },
    };
    const h = await createHarness({
      script: { settle: async () => { throw new Error("ambiguous transport"); } },
      paymentReconciler: reconciler,
    });
    await payActivation(h);
    expect((await payActivation(h)).status).toBe(200);
    expect(h.facilitator.settleCalls).toBe(1);
    expect((await h.record())?.state).toBe("TENDER_OPENED");
  });

  it("does not commit when reconciliation confirms failure", async () => {
    const reconciler: PaymentSettlementReconciler = {
      async reconcile() { return { status: "FAILED", failureCode: "MIRROR_NOT_FOUND" }; },
    };
    const h = await createHarness({
      script: { settle: async () => { throw new Error("ambiguous transport"); } },
      paymentReconciler: reconciler,
    });
    await payActivation(h);
    const response = await payActivation(h);
    expect(response.status).toBe(402);
    expect((await h.record())?.state).toBe("ESCROW_FUNDED");
    expect((await h.paymentClaims.getByActionId("activate-recover"))?.state).toBe("FAILED");
  });

  it("rejects conflicting reuse of an actionId", async () => {
    const h = await createHarness();
    await payActivation(h, "shared-action");
    const response = await post(
      h.app,
      bidPath(),
      bidRequest("shared-action"),
      { "X-PAYMENT": await h.paymentHeader(h.bidBinding()) },
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("ACTION_ID_CONFLICT");
  });

  it("persists a safe claim journal across file-store reconstruction", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "rg-v2-claims-"));
    try {
      const first = new FilePaymentClaimStore(dir);
      await first.acquire({
        actionType: "TENDER_ACTIVATE",
        actionId: "restart-action",
        tenderId: "tender-restart",
        tenderVersion: 1,
        bidId: null,
        payerAccount: "0.0.5555",
        payTo: "0.0.9215954",
        asset: "0.0.429274",
        amountAtomic: "1000",
        resource: "/api/v2/tenders/tender-restart/v/1/activate",
        paymentPayloadHash: "a".repeat(64),
        requestHash: "b".repeat(64),
      }, SERVER_NOW);
      await first.transition({
        actionId: "restart-action",
        from: ["CLAIMED"],
        to: "SETTLING",
        now: SERVER_NOW,
      });
      const restarted = new FilePaymentClaimStore(dir);
      expect((await restarted.getByActionId("restart-action"))?.state).toBe("SETTLING");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["another action", { actionId: "two" }],
    ["another tender", { actionId: "two", tenderId: "tender-two", resource: "/two" }],
    ["another tender version", { actionId: "two", tenderVersion: 2, resource: "/v2" }],
    ["another bid", { actionId: "two", actionType: "BID_SUBMIT", bidId: "bid-two", resource: "/bids/two" }],
  ] as const)("atomically rejects one payment payload for %s", async (_label, changed) => {
    const store = new InMemoryPaymentClaimStore();
    const binding = {
      actionType: "TENDER_ACTIVATE" as const,
      actionId: "one",
      tenderId: "tender-one",
      tenderVersion: 1,
      bidId: null,
      payerAccount: "0.0.5555",
      payTo: "0.0.9215954",
      asset: "0.0.429274",
      amountAtomic: "1000",
      resource: "/one",
      paymentPayloadHash: "c".repeat(64),
      requestHash: "d".repeat(64),
    };
    await store.acquire(binding, SERVER_NOW);
    await expect(store.acquire({ ...binding, ...changed }, SERVER_NOW))
      .rejects.toMatchObject({ code: "PAYMENT_ALREADY_USED" });
  });
});
