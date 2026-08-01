/**
 * Phase B1 — idempotency and payment-replay protection across both access
 * gates. A settled payment authorizes exactly one action, and an identical
 * retry never settles twice or duplicates durable state.
 */

import { describe, expect, it } from "vitest";

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

async function activate(h: Harness, actionId = "act-open"): Promise<Response> {
  const header = await h.paymentHeader(h.activationBinding());
  return post(h.app, activatePath(), { actionId }, { "X-PAYMENT": header });
}

function bidRequest(actionId: string, bidId = BID_ID) {
  const bid = testBid({ bidId });
  return {
    actionId,
    signedAt: SERVER_NOW,
    signature: signBid({ bid, actionId }),
    bid,
  };
}

describe("v2 access-gate idempotency and replay protection", () => {
  it("an identical paid activation retry is idempotent", async () => {
    const h = await createHarness();
    const first = await activate(h, "act-1");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      tender: { recordVersion: number };
      accessPayment: { transactionId: string };
    };
    const settleCallsAfterFirst = h.facilitator.settleCalls;

    const retry = await activate(h, "act-1");
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as {
      outcome: string;
      tender: { state: string; recordVersion: number };
      accessPayment: { transactionId: string };
    };

    expect(retryBody.outcome).toBe("REPLAYED");
    expect(retryBody.tender.state).toBe("TENDER_OPENED");
    // No second settlement, no second transition, no version bump.
    expect(h.facilitator.settleCalls).toBe(settleCallsAfterFirst);
    expect(retryBody.tender.recordVersion).toBe(firstBody.tender.recordVersion);
    expect(retryBody.accessPayment.transactionId).toBe(
      firstBody.accessPayment.transactionId,
    );

    const record = (await h.record())!;
    expect(record.accessPayments).toHaveLength(1);
    expect(
      record.history.filter((h2) => h2.eventType === "TENDER_ACTIVATION_PAID"),
    ).toHaveLength(1);
  });

  it("reusing an activation actionId for a different action fails closed", async () => {
    const h = await createHarness();
    await activate(h, "act-1");

    const response = await post(
      h.app,
      bidPath(),
      bidRequest("act-1"),
      {},
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("ACTION_ID_CONFLICT");
  });

  it("a duplicate paid bid retry does not duplicate the bid or the history", async () => {
    const h = await createHarness();
    await activate(h, "act-open");

    const header = await h.paymentHeader(h.bidBinding());
    const first = await post(h.app, bidPath(), bidRequest("bid-1"), {
      "X-PAYMENT": header,
    });
    expect(first.status).toBe(200);
    const settleCalls = h.facilitator.settleCalls;
    const afterFirst = (await h.record())!;

    const retry = await post(h.app, bidPath(), bidRequest("bid-1"), {
      "X-PAYMENT": header,
    });
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as {
      outcome: string;
      bidId: string;
      tender: { recordVersion: number };
    };
    expect(retryBody.outcome).toBe("REPLAYED");
    expect(retryBody.bidId).toBe(BID_ID);
    expect(h.facilitator.settleCalls).toBe(settleCalls);

    const afterRetry = (await h.record())!;
    expect(afterRetry.recordVersion).toBe(afterFirst.recordVersion);
    expect(afterRetry.bidRegistry).toHaveLength(1);
    expect(afterRetry.accessPayments).toHaveLength(2);
    expect(afterRetry.history).toHaveLength(afterFirst.history.length);
  });

  it("the same actionId with a changed bid payload fails closed", async () => {
    const h = await createHarness();
    await activate(h, "act-open");

    const header = await h.paymentHeader(h.bidBinding());
    await post(h.app, bidPath(), bidRequest("bid-1"), { "X-PAYMENT": header });

    // Same actionId, different bid id → conflicting action reuse.
    const otherHeader = await h.paymentHeader(h.bidBinding("bid-alpha-2"));
    const conflict = await post(
      h.app,
      bidPath("bid-alpha-2"),
      bidRequest("bid-1", "bid-alpha-2"),
      { "X-PAYMENT": otherHeader },
    );
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toBe("ACTION_ID_CONFLICT");
    expect((await h.record())!.bidRegistry).toHaveLength(1);
  });

  it("one settlement transaction cannot pay for two bids", async () => {
    // Pin the facilitator to a single transaction id for every settlement.
    const h = await createHarness({
      script: {
        settle: () => ({
          success: true,
          transaction: "0.0.7162784@1785173999.000000009",
          network: "hedera:testnet",
          payer: "0.0.7162784",
        }),
      },
    });
    await activate(h, "act-open");

    const firstHeader = await h.paymentHeader(h.bidBinding());
    const first = await post(h.app, bidPath(), bidRequest("bid-1"), {
      "X-PAYMENT": firstHeader,
    });
    // The activation already consumed that pinned transaction.
    expect(first.status).toBe(409);
    expect((await first.json()).error).toBe("PAYMENT_REPLAY");
    expect((await h.record())!.bidRegistry).toHaveLength(0);
  });

  it("a bid payment cannot authorize a second bid", async () => {
    let pinned: string | null = null;
    const h = await createHarness({
      script: {
        settle: (_payload, _requirements, sequence) => {
          // Activation gets a unique id; every later settlement repeats one id.
          const transaction =
            sequence === 1
              ? "0.0.7162784@1785173991.000000001"
              : (pinned ??= "0.0.7162784@1785173992.000000002");
          return {
            success: true,
            transaction,
            network: "hedera:testnet",
            payer: "0.0.7162784",
          };
        },
      },
    });
    await activate(h, "act-open");

    const firstHeader = await h.paymentHeader(h.bidBinding());
    const first = await post(h.app, bidPath(), bidRequest("bid-1"), {
      "X-PAYMENT": firstHeader,
    });
    expect(first.status).toBe(200);

    const secondBid = testBid({ bidId: "bid-alpha-2" });
    const secondHeader = await h.paymentHeader(h.bidBinding("bid-alpha-2"));
    const second = await post(
      h.app,
      bidPath("bid-alpha-2"),
      {
        actionId: "bid-2",
        signedAt: SERVER_NOW,
        signature: signBid({ bid: secondBid, actionId: "bid-2" }),
        bid: secondBid,
      },
      { "X-PAYMENT": secondHeader },
    );
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe("PAYMENT_REPLAY");

    const record = (await h.record())!;
    expect(record.bidRegistry).toHaveLength(1);
    expect(record.accessPayments).toHaveLength(2);
  });

  it("re-submitting an already accepted bid under a new actionId fails closed", async () => {
    const h = await createHarness();
    await activate(h, "act-open");

    const header = await h.paymentHeader(h.bidBinding());
    await post(h.app, bidPath(), bidRequest("bid-1"), { "X-PAYMENT": header });

    const settleCalls = h.facilitator.settleCalls;
    const second = await post(h.app, bidPath(), bidRequest("bid-2"), {
      "X-PAYMENT": await h.paymentHeader(h.bidBinding()),
    });
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe("PERSISTENCE_CONFLICT");
    // Rejected before any further settlement.
    expect(h.facilitator.settleCalls).toBe(settleCalls);
    expect((await h.record())!.bidRegistry).toHaveLength(1);
  });

  it("an unpaid retry after payment returns the original resource", async () => {
    const h = await createHarness();
    await activate(h, "act-1");

    // No payment header at all: the committed action still replays.
    const retry = await post(h.app, activatePath(), { actionId: "act-1" });
    expect(retry.status).toBe(200);
    const body = (await retry.json()) as { outcome: string };
    expect(body.outcome).toBe("REPLAYED");
    expect(h.facilitator.settleCalls).toBe(1);
  });
});
