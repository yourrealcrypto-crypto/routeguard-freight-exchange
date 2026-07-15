import { describe, expect, it } from "vitest";

import { evaluateCommitmentEligibility } from "../src/auction/eligibility";
import { evaluateAuction } from "../src/auction/decision-manifest";
import {
  AUCTION_ENDS_AT,
  buildCarrierRegistry,
  buildCommitment,
  buildFullScenario,
  buildHamburgIstanbulTender,
  buildReceiptForBid,
  buildSignedBid,
  EVALUATION_TIMESTAMP,
  ROUTEGUARD_PUBLIC_KEY,
} from "./fixtures/auction-fixtures";
import { bidHash } from "../src/domain/bid";

describe("Auction eligibility", () => {
  it("qualifies a valid timely bid", () => {
    const tender = buildHamburgIstanbulTender();
    const signed = buildSignedBid({
      bidId: "elig-ok",
      carrier: "alpha",
      freightPriceCents: 350_000,
    });
    const receipt = buildReceiptForBid(signed);
    const result = evaluateCommitmentEligibility({
      tender,
      commitment: buildCommitment(
        signed,
        receipt,
        1,
        "2026-08-01T09:00:00.000Z",
      ),
      signedBid: signed,
      signedReceipt: receipt,
      registry: buildCarrierRegistry(),
      routeGuardPublicKey: ROUTEGUARD_PUBLIC_KEY,
      evaluationTimestamp: EVALUATION_TIMESTAMP,
    });
    expect(result.decision).toBe("QUALIFIED");
    expect(result.reasonCodes).toEqual([]);
  });

  it("rejects late commitment", () => {
    const tender = buildHamburgIstanbulTender();
    const signed = buildSignedBid({
      bidId: "elig-late",
      carrier: "alpha",
      freightPriceCents: 300_000,
    });
    const receipt = buildReceiptForBid(signed);
    const result = evaluateCommitmentEligibility({
      tender,
      commitment: buildCommitment(
        signed,
        receipt,
        1,
        "2026-08-01T10:00:00.001Z",
      ),
      signedBid: signed,
      signedReceipt: receipt,
      registry: buildCarrierRegistry(),
      routeGuardPublicKey: ROUTEGUARD_PUBLIC_KEY,
      evaluationTimestamp: EVALUATION_TIMESTAMP,
    });
    expect(result.reasonCodes).toContain("LATE_COMMITMENT");
    expect(result.decision).toBe("REJECTED");
  });

  it("treats deadline equality as timely", () => {
    const tender = buildHamburgIstanbulTender();
    const signed = buildSignedBid({
      bidId: "elig-eq",
      carrier: "alpha",
      freightPriceCents: 350_000,
    });
    const receipt = buildReceiptForBid(signed);
    const result = evaluateCommitmentEligibility({
      tender,
      commitment: buildCommitment(signed, receipt, 1, AUCTION_ENDS_AT),
      signedBid: signed,
      signedReceipt: receipt,
      registry: buildCarrierRegistry(),
      routeGuardPublicKey: ROUTEGUARD_PUBLIC_KEY,
      evaluationTimestamp: EVALUATION_TIMESTAMP,
    });
    expect(result.reasonCodes).not.toContain("LATE_COMMITMENT");
    expect(result.decision).toBe("QUALIFIED");
  });

  it("rejects missing full bid", () => {
    const tender = buildHamburgIstanbulTender();
    const signed = buildSignedBid({
      bidId: "elig-missing",
      carrier: "alpha",
      freightPriceCents: 350_000,
    });
    const receipt = buildReceiptForBid(signed);
    const result = evaluateCommitmentEligibility({
      tender,
      commitment: buildCommitment(
        signed,
        receipt,
        1,
        "2026-08-01T09:00:00.000Z",
      ),
      signedBid: undefined,
      signedReceipt: receipt,
      registry: buildCarrierRegistry(),
      routeGuardPublicKey: ROUTEGUARD_PUBLIC_KEY,
      evaluationTimestamp: EVALUATION_TIMESTAMP,
    });
    expect(result.reasonCodes).toContain("FULL_BID_MISSING");
  });

  it("rejects bid hash mismatch", () => {
    const tender = buildHamburgIstanbulTender();
    const signed = buildSignedBid({
      bidId: "elig-hash",
      carrier: "alpha",
      freightPriceCents: 350_000,
    });
    const receipt = buildReceiptForBid(signed);
    const commitment = {
      ...buildCommitment(signed, receipt, 1, "2026-08-01T09:00:00.000Z"),
      bidHash: bidHash({ ...signed.bid, freightPriceCents: 999 }),
    };
    const result = evaluateCommitmentEligibility({
      tender,
      commitment,
      signedBid: signed,
      signedReceipt: receipt,
      registry: buildCarrierRegistry(),
      routeGuardPublicKey: ROUTEGUARD_PUBLIC_KEY,
      evaluationTimestamp: EVALUATION_TIMESTAMP,
    });
    expect(result.reasonCodes).toContain("BID_HASH_MISMATCH");
  });

  it("rejects equipment, price, inactive, wrong payTo, bad signature cases", () => {
    const scenario = buildFullScenario();
    const manifest = evaluateAuction({
      tender: scenario.tender,
      commitments: scenario.commitments,
      fullBids: scenario.fullBids,
      acceptanceReceipts: scenario.receipts,
      registry: scenario.registry,
      routeGuardPublicKey: scenario.routeGuardPublicKey,
      evaluationTimestamp: scenario.evaluationTimestamp,
      barrierSequence: 100,
      reconciliationReference: "hcs-topic-1:0-31",
    });

    const byId = Object.fromEntries(
      manifest.commitments.map((c) => [c.bidId, c]),
    );

    expect(byId["bid-equip-mismatch"]?.reasonCodes).toContain(
      "EQUIPMENT_MISMATCH",
    );
    expect(byId["bid-over-max"]?.reasonCodes).toContain("PRICE_ABOVE_MAXIMUM");
    expect(byId["bid-inactive"]?.reasonCodes).toContain("CARRIER_INACTIVE");
    expect(byId["bid-wrong-payto"]?.reasonCodes).toContain(
      "PAYMENT_RECIPIENT_MISMATCH",
    );
    expect(byId["bid-bad-sig"]?.reasonCodes).toContain("INVALID_BID_SIGNATURE");
    expect(byId["bid-late-delivery"]?.reasonCodes).toContain(
      "DELIVERY_DEADLINE_MISSED",
    );
    expect(byId["bid-late-cheap"]?.reasonCodes).toContain("LATE_COMMITMENT");
    expect(byId["bid-missing-full"]?.reasonCodes).toEqual(["FULL_BID_MISSING"]);
    expect(byId["bid-winner-low"]?.decision).toBe("QUALIFIED");
  });
});
