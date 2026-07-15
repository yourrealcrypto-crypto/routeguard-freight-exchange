import { describe, expect, it } from "vitest";

import { evaluateAllCommitments } from "../src/auction/eligibility";
import {
  compareRankedBids,
  rankQualifiedBids,
  selectWinner,
} from "../src/auction/ranking";
import type { EligibilityResult } from "../src/auction/types";
import {
  buildCarrierRegistry,
  buildCommitment,
  buildFullScenario,
  buildHamburgIstanbulTender,
  buildReceiptForBid,
  buildSignedBid,
  EVALUATION_TIMESTAMP,
  ROUTEGUARD_PUBLIC_KEY,
} from "./fixtures/auction-fixtures";

function qualified(
  partial: Partial<EligibilityResult> & {
    bidId: string;
    freightPriceCents: number;
    estimatedDelivery: string;
    consensusTimestamp: string;
  },
): EligibilityResult {
  const hash = partial.bidHash ?? `sha256:${"ab".repeat(32)}`;
  return {
    bidId: partial.bidId,
    carrierId: partial.carrierId ?? "carrier",
    decision: "QUALIFIED",
    reasonCodes: [],
    freightPriceCents: partial.freightPriceCents,
    estimatedDelivery: partial.estimatedDelivery,
    consensusTimestamp: partial.consensusTimestamp,
    hcsSequence: partial.hcsSequence ?? 1,
    bidHash: hash,
    timely: true,
    submittedSignedBidPresent: true,
    submittedSignedBidEnvelopeHash: `sha256:${"11".repeat(32)}`,
    submittedReceiptPresent: true,
    submittedReceiptEnvelopeHash: `sha256:${"22".repeat(32)}`,
    fullBidSchemaValid: true,
    receiptSchemaValid: true,
    fullBidPresent: true,
    validatedFullBidHash: hash,
    signedBidEnvelopeHash: `sha256:${"cd".repeat(32)}`,
    receiptPresent: true,
    validatedReceiptHash: `sha256:${"ef".repeat(32)}`,
    bidVersionMatch: true,
    signatureValid: true,
    commitment: null,
  };
}

describe("Auction ranking — LOWEST_QUALIFIED_PRICE_V1", () => {
  it("selects lowest freight price as winner", () => {
    const results = [
      qualified({
        bidId: "b-high",
        freightPriceCents: 400,
        estimatedDelivery: "2026-08-06T10:00:00.000Z",
        consensusTimestamp: "2026-08-01T09:00:00.000Z",
      }),
      qualified({
        bidId: "b-low",
        freightPriceCents: 300,
        estimatedDelivery: "2026-08-06T12:00:00.000Z",
        consensusTimestamp: "2026-08-01T09:05:00.000Z",
      }),
    ];
    expect(selectWinner(results)?.bidId).toBe("b-low");
  });

  it("tie-breaks by earliest estimatedDelivery (epoch ns)", () => {
    const results = [
      qualified({
        bidId: "b-later-del",
        freightPriceCents: 300,
        estimatedDelivery: "2026-08-07T10:00:00.000Z",
        consensusTimestamp: "2026-08-01T09:00:00.000Z",
      }),
      qualified({
        bidId: "b-earlier-del",
        freightPriceCents: 300,
        estimatedDelivery: "2026-08-06T10:00:00.000Z",
        consensusTimestamp: "2026-08-01T09:05:00.000Z",
      }),
    ];
    expect(selectWinner(results)?.bidId).toBe("b-earlier-del");
  });

  it("tie-breaks by earliest HCS consensusTimestamp (epoch ns)", () => {
    const results = [
      qualified({
        bidId: "b-later-hcs",
        freightPriceCents: 300,
        estimatedDelivery: "2026-08-06T10:00:00.000Z",
        consensusTimestamp: "2026-08-01T09:20:00.000Z",
      }),
      qualified({
        bidId: "b-earlier-hcs",
        freightPriceCents: 300,
        estimatedDelivery: "2026-08-06T10:00:00.000Z",
        consensusTimestamp: "2026-08-01T09:10:00.000Z",
      }),
    ];
    expect(selectWinner(results)?.bidId).toBe("b-earlier-hcs");
  });

  it("tie-breaks by lexicographically lowest bidId", () => {
    const results = [
      qualified({
        bidId: "bid-zz",
        freightPriceCents: 300,
        estimatedDelivery: "2026-08-06T10:00:00.000Z",
        consensusTimestamp: "2026-08-01T09:10:00.000Z",
      }),
      qualified({
        bidId: "bid-aa",
        freightPriceCents: 300,
        estimatedDelivery: "2026-08-06T10:00:00.000Z",
        consensusTimestamp: "2026-08-01T09:10:00.000Z",
      }),
    ];
    expect(selectWinner(results)?.bidId).toBe("bid-aa");
  });

  it("ranking is independent of input order (full permutation)", () => {
    const items = [
      qualified({
        bidId: "x",
        freightPriceCents: 500,
        estimatedDelivery: "2026-08-06T10:00:00.000Z",
        consensusTimestamp: "2026-08-01T09:00:00.000Z",
      }),
      qualified({
        bidId: "y",
        freightPriceCents: 400,
        estimatedDelivery: "2026-08-06T10:00:00.000Z",
        consensusTimestamp: "2026-08-01T09:00:00.000Z",
      }),
      qualified({
        bidId: "z",
        freightPriceCents: 450,
        estimatedDelivery: "2026-08-06T10:00:00.000Z",
        consensusTimestamp: "2026-08-01T09:00:00.000Z",
      }),
    ];
    const expected = ["y", "z", "x"];
    const perms = [
      [0, 1, 2],
      [2, 0, 1],
      [1, 2, 0],
      [2, 1, 0],
      [1, 0, 2],
      [0, 2, 1],
    ];
    for (const p of perms) {
      const ordered = p.map((i) => items[i]!);
      expect(rankQualifiedBids(ordered).map((r) => r.bidId)).toEqual(expected);
    }
  });

  it("full scenario winner is lowest qualified price", () => {
    const scenario = buildFullScenario();
    const results = evaluateAllCommitments(
      scenario.tender,
      [...scenario.commitments].reverse(),
      scenario.fullBids,
      scenario.receipts,
      scenario.registry,
      scenario.routeGuardPublicKey,
      scenario.evaluationTimestamp,
    );
    const winner = selectWinner(results);
    expect(winner?.bidId).toBe("bid-winner-low");
    expect(winner?.freightPriceCents).toBe(350_000);
  });

  it("compareRankedBids is a total order", () => {
    const a = {
      bidId: "a",
      carrierId: "c",
      freightPriceCents: 1,
      estimatedDelivery: "2026-08-06T10:00:00.000Z",
      consensusTimestamp: "2026-08-01T09:00:00.000Z",
      hcsSequence: 1,
      bidHash: "h",
    };
    const b = { ...a, bidId: "b" };
    expect(compareRankedBids(a, b)).toBeLessThan(0);
    expect(compareRankedBids(b, a)).toBeGreaterThan(0);
    expect(compareRankedBids(a, a)).toBe(0);
  });

  it("mixed precision consensus timestamps rank correctly", () => {
    const tender = buildHamburgIstanbulTender();
    const a = buildSignedBid({
      bidId: "mp-a",
      carrier: "alpha",
      freightPriceCents: 370_000,
      estimatedDelivery: "2026-08-06T14:00:00.000Z",
    });
    const b = buildSignedBid({
      bidId: "mp-b",
      carrier: "beta",
      freightPriceCents: 370_000,
      estimatedDelivery: "2026-08-06T14:00:00.000Z",
    });
    const ra = buildReceiptForBid(a);
    const rb = buildReceiptForBid(b);
    const results = evaluateAllCommitments(
      tender,
      [
        buildCommitment(a, ra, 1, "2026-08-01T09:10:00Z"),
        buildCommitment(b, rb, 2, "2026-08-01T09:10:00.1Z"),
      ],
      new Map([
        ["mp-a", a],
        ["mp-b", b],
      ]),
      new Map([
        ["mp-a", ra],
        ["mp-b", rb],
      ]),
      buildCarrierRegistry(),
      ROUTEGUARD_PUBLIC_KEY,
      EVALUATION_TIMESTAMP,
    );
    expect(selectWinner(results)?.bidId).toBe("mp-a");
  });
});
