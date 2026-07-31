/**
 * Phase B1 — POST /api/v2/tenders/:tenderId/v/:tenderVersion/bids/:bidId
 * Durable, x402-gated carrier bid submission. No network write, no HCS submit.
 */

import { PrivateKey } from "@hiero-ledger/sdk";
import { describe, expect, it } from "vitest";

import { bidSubmitResource } from "../src/v2/access/resource";
import { buildBidCommitmentEnvelope } from "../src/v2/hcs/outbox";
import { v2BidHash } from "../src/v2/schemas/bid";
import {
  activatePath,
  bidPath,
  BID_ID,
  CARRIER_ID,
  createHarness,
  FREIGHT_AMOUNT,
  PAYER_ACCOUNT,
  post,
  SALT,
  SERVER_NOW,
  signBid,
  TENDER_ID,
  TENDER_VERSION,
  testBid,
  testCarrierRecord,
  type Harness,
} from "./v2-access-route-fixtures";
import { BUDGET, TREASURY } from "./v2-lifecycle-fixtures";

/** Activate the tender so it accepts bids. */
async function openTender(h: Harness): Promise<void> {
  const header = await h.paymentHeader(h.activationBinding());
  const response = await post(
    h.app,
    activatePath(),
    { actionId: "act-open" },
    { "X-PAYMENT": header },
  );
  expect(response.status).toBe(200);
}

async function openedHarness(
  options?: Parameters<typeof createHarness>[0],
): Promise<Harness> {
  const h = await createHarness(options);
  await openTender(h);
  // Counters below assert facilitator activity for the *bid* request only.
  h.facilitator.resetCounts();
  return h;
}

function bidRequest(
  actionId: string,
  overrides: Partial<ReturnType<typeof testBid>> = {},
) {
  const bid = testBid(overrides);
  return {
    actionId,
    signedAt: SERVER_NOW,
    signature: signBid({ bid, actionId }),
    bid,
  };
}

describe("v2 durable bid submission x402 route", () => {
  it("returns 402 bound to tenderId, tenderVersion and bidId", async () => {
    const h = await openedHarness();
    const response = await post(h.app, bidPath(), bidRequest("bid-act-1"));

    expect(response.status).toBe(402);
    const body = (await response.json()) as {
      error: string;
      accepts: { amount: string; asset: string; payTo: string }[];
      resource: { url: string };
      accessFee: { purpose: string };
    };
    expect(body.error).toBe("PAYMENT_REQUIRED");
    expect(body.accessFee.purpose).toBe("BID_SUBMISSION_ACCESS");
    expect(body.accepts[0]!.amount).toBe("1000");
    expect(body.accepts[0]!.asset).toBe("0.0.429274");
    expect(body.accepts[0]!.payTo).toBe(TREASURY);
    expect(body.resource.url).toBe(
      bidSubmitResource(TENDER_ID, TENDER_VERSION, BID_ID),
    );
    expect(h.facilitator.settleCalls).toBe(0);
  });

  it("charges nothing for a malformed bid", async () => {
    const h = await openedHarness();
    const response = await post(h.app, bidPath(), {
      actionId: "bid-act-1",
      signedAt: SERVER_NOW,
      signature: "aa".repeat(64),
      bid: { bidId: BID_ID, nope: true },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("BID_INVALID");
    expect(h.facilitator.verifyCalls).toBe(0);
    expect(h.facilitator.settleCalls).toBe(0);
  });

  it("charges nothing when the body bidId does not match the path", async () => {
    const h = await openedHarness();
    const response = await post(
      h.app,
      bidPath("bid-other"),
      bidRequest("bid-act-1"),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("BID_INVALID");
    expect(h.facilitator.settleCalls).toBe(0);
  });

  it("charges nothing for an ineligible bid", async () => {
    const wrongEquipment = await openedHarness();
    const equipmentResponse = await post(
      wrongEquipment.app,
      bidPath(),
      bidRequest("bid-act-1", { equipment: "reefer-13.6m" }),
    );
    expect(equipmentResponse.status).toBe(422);
    expect((await equipmentResponse.json()).error).toBe("BID_INELIGIBLE");
    expect(wrongEquipment.facilitator.settleCalls).toBe(0);

    const unregistered = await openedHarness({
      carriers: [testCarrierRecord({ active: false })],
    });
    const inactiveResponse = await post(
      unregistered.app,
      bidPath(),
      bidRequest("bid-act-2"),
    );
    expect(inactiveResponse.status).toBe(422);
    expect((await inactiveResponse.json()).error).toBe("BID_INELIGIBLE");

    const noCapacity = await openedHarness();
    const capacityResponse = await post(
      noCapacity.app,
      bidPath(),
      bidRequest("bid-act-3", { capacityConfirmed: false }),
    );
    expect(capacityResponse.status).toBe(422);
    expect((await capacityResponse.json()).error).toBe("BID_INELIGIBLE");
  });

  it("charges nothing for a late bid", async () => {
    const h = await openedHarness();
    h.setNow("2026-08-02T00:00:00.000Z"); // after auctionEndsAt
    const response = await post(h.app, bidPath(), bidRequest("bid-act-1"));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("AUCTION_CLOSED");
    expect(h.facilitator.settleCalls).toBe(0);
  });

  it("charges nothing for a bid above the maximum freight budget", async () => {
    const h = await openedHarness();
    const response = await post(
      h.app,
      bidPath(),
      bidRequest("bid-act-1", { freightAmountAtomic: "1000001" }),
    );
    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe("BID_INELIGIBLE");
    expect(h.facilitator.settleCalls).toBe(0);
  });

  it("charges nothing for an invalid carrier signature", async () => {
    const h = await openedHarness();
    const other = PrivateKey.generateECDSA();
    const bid = testBid();
    const response = await post(h.app, bidPath(), {
      actionId: "bid-act-1",
      signedAt: SERVER_NOW,
      signature: signBid({ bid, actionId: "bid-act-1", privateKey: other }),
      bid,
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("BID_INVALID");
    expect(h.facilitator.settleCalls).toBe(0);
  });

  it("paid bid returns 200, stores the bid durably and produces a commitment", async () => {
    const h = await openedHarness();
    const header = await h.paymentHeader(h.bidBinding());
    const response = await post(
      h.app,
      bidPath(),
      bidRequest("bid-act-1"),
      { "X-PAYMENT": header },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      outcome: string;
      accepted: boolean;
      bidId: string;
      tender: { state: string };
      commitment: { bidHash: string; commitmentPayloadHash: string };
      accessPayment: { transactionId: string; amountAtomic: string };
    };
    expect(body.outcome).toBe("ACCEPTED");
    expect(body.accepted).toBe(true);
    expect(body.bidId).toBe(BID_ID);
    expect(body.tender.state).toBe("BIDDING");
    expect(body.commitment.bidHash).toBe(v2BidHash(testBid()));
    expect(body.commitment.commitmentPayloadHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(body.accessPayment.amountAtomic).toBe("1000");

    // Durable bid body (private) and durable public registry entry.
    const stored = await h.bidBodies.get(TENDER_ID, TENDER_VERSION, BID_ID);
    expect(stored?.signed.bid.freightAmountAtomic).toBe(FREIGHT_AMOUNT);

    const record = (await h.record())!;
    expect(record.bidRegistry).toHaveLength(1);
    expect(record.bidRegistry[0]).toMatchObject({
      bidId: BID_ID,
      carrierId: CARRIER_ID,
      actionId: "bid-act-1",
    });
    expect(record.accessPayments).toHaveLength(2); // activation + bid
    expect(record.accessPayments[1]).toMatchObject({
      accessActionType: "BID_SUBMIT",
      bidId: BID_ID,
      payTo: TREASURY,
      payerAccount: PAYER_ACCOUNT,
      amountAtomic: "1000",
    });
  });

  it("never exposes the private bid body, salt, or freight amount", async () => {
    const h = await openedHarness();
    const header = await h.paymentHeader(h.bidBinding());
    const response = await post(
      h.app,
      bidPath(),
      bidRequest("bid-act-1"),
      { "X-PAYMENT": header },
    );
    const text = await response.text();

    expect(text).not.toContain(SALT);
    expect(text).not.toContain("commitmentSalt");
    expect(text).not.toContain(FREIGHT_AMOUNT);
    expect(text).not.toContain("nonce");

    // Durable public state is equally free of private bid material.
    const serialized = JSON.stringify((await h.record())!);
    expect(serialized).not.toContain(SALT);
    expect(serialized).not.toContain("commitmentSalt");
    expect(serialized).not.toContain(FREIGHT_AMOUNT);
  });

  it("first paid bid opens BIDDING and later bids stay in BIDDING", async () => {
    const h = await openedHarness();
    expect((await h.record())!.state).toBe("TENDER_OPENED");

    const firstHeader = await h.paymentHeader(h.bidBinding());
    await post(h.app, bidPath(), bidRequest("bid-act-1"), {
      "X-PAYMENT": firstHeader,
    });
    const afterFirst = (await h.record())!;
    expect(afterFirst.state).toBe("BIDDING");
    const historyAfterFirst = afterFirst.history.length;

    const secondBid = testBid({ bidId: "bid-alpha-2" });
    const secondHeader = await h.paymentHeader(h.bidBinding("bid-alpha-2"));
    const second = await post(
      h.app,
      bidPath("bid-alpha-2"),
      {
        actionId: "bid-act-2",
        signedAt: SERVER_NOW,
        signature: signBid({ bid: secondBid, actionId: "bid-act-2" }),
        bid: secondBid,
      },
      { "X-PAYMENT": secondHeader },
    );
    expect(second.status).toBe(200);

    const afterSecond = (await h.record())!;
    expect(afterSecond.state).toBe("BIDDING");
    expect(afterSecond.bidRegistry).toHaveLength(2);
    expect(afterSecond.history).toHaveLength(historyAfterFirst + 1);
    const transitions = afterSecond.history.filter(
      (entry) => entry.from === "TENDER_OPENED" && entry.to === "BIDDING",
    );
    expect(transitions).toHaveLength(1);
  });

  it("rejects a payment issued for another bid id", async () => {
    const h = await openedHarness();
    const otherBidHeader = await h.paymentHeader(h.bidBinding("bid-alpha-9"));
    const response = await post(
      h.app,
      bidPath(),
      bidRequest("bid-act-1"),
      { "X-PAYMENT": otherBidHeader },
    );
    expect(response.status).toBe(402);
    expect((await response.json()).error).toBe("PAYMENT_RESOURCE_MISMATCH");
    expect((await h.record())!.bidRegistry).toHaveLength(0);
  });

  it("a tender activation payment cannot authorize a bid submission", async () => {
    const h = await openedHarness();
    const activationHeader = await h.paymentHeader(h.activationBinding());
    const response = await post(
      h.app,
      bidPath(),
      bidRequest("bid-act-1"),
      { "X-PAYMENT": activationHeader },
    );
    expect(response.status).toBe(402);
    expect((await response.json()).error).toBe("PAYMENT_RESOURCE_MISMATCH");
    expect((await h.record())!.bidRegistry).toHaveLength(0);
  });

  it("builds a valid unsubmitted BID_COMMITMENT envelope carrying no private data", async () => {
    const h = await openedHarness();
    const header = await h.paymentHeader(h.bidBinding());
    await post(h.app, bidPath(), bidRequest("bid-act-1"), {
      "X-PAYMENT": header,
    });

    const record = (await h.record())!;
    const envelope = buildBidCommitmentEnvelope(record, record.bidRegistry[0]!);
    expect(envelope.messageType).toBe("BID_COMMITMENT");
    expect(envelope.payload).toMatchObject({
      bidId: BID_ID,
      carrierId: CARRIER_ID,
      bidHash: v2BidHash(testBid()),
    });
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain(SALT);
    expect(serialized).not.toContain(FREIGHT_AMOUNT);
    expect(serialized).not.toContain(BUDGET);
  });
});
