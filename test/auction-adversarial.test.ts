import { describe, expect, it } from "vitest";

import {
  createAuctionClosureProof,
  isVerifiedAuctionClosureProof,
} from "../src/auction/closure-proof";
import {
  buildDecisionManifest,
  computeEvaluatedBidSetHash,
  evaluateAuction,
  reconstructExpectedManifestBody,
  verifyDecisionManifestIntegrity,
} from "../src/auction/decision-manifest";
import { evaluateAllCommitments, evaluateCommitmentEligibility } from "../src/auction/eligibility";
import { hashSubmittedEvidence } from "../src/auction/evidence-hash";
import { selectWinner } from "../src/auction/ranking";
import {
  ReconciliationError,
  validateReconciliationInputs,
} from "../src/auction/reconciliation";
import { LOWEST_QUALIFIED_PRICE_V1_RULES } from "../src/auction/rules";
import {
  createAuctionMachine,
  IllegalAuctionTransitionError,
  transitionToBidding,
  transitionToClosed,
  transitionToClosedWithBooleans,
  transitionToNoQualifiedBid,
  transitionToOpen,
  transitionToReconciliation,
  transitionToWinnerSelected,
} from "../src/auction/state-machine";
import { bidHash } from "../src/domain/bid";
import { acceptanceReceiptHash } from "../src/domain/acceptance-receipt";
import { canonicalSha256 } from "../src/domain/canonical-hash";
import type { DecisionManifest } from "../src/auction/types";
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
  sequencesFromCommitments,
} from "./fixtures/auction-fixtures";

function evaluateScenario(scenario = buildFullScenario()) {
  return evaluateAuction({
    tender: scenario.tender,
    commitments: scenario.commitments,
    fullBids: scenario.fullBids,
    acceptanceReceipts: scenario.receipts,
    registry: scenario.registry,
    routeGuardPublicKey: scenario.routeGuardPublicKey,
    evaluationTimestamp: scenario.evaluationTimestamp,
    barrierSequence: 100,
    reconciliationReference: "hcs-topic:10-31",
  });
}

describe("Adversarial — reconciliation integrity", () => {
  it("rejects duplicate HCS sequence", () => {
    const s = buildFullScenario();
    const c0 = s.commitments[0]!;
    const dup = { ...c0, bidId: "other-bid" };
    expect(() =>
      validateReconciliationInputs({
        commitments: [c0, dup],
        fullBids: s.fullBids,
        acceptanceReceipts: s.receipts,
      }),
    ).toThrow(ReconciliationError);
    try {
      validateReconciliationInputs({
        commitments: [c0, dup],
        fullBids: s.fullBids,
        acceptanceReceipts: s.receipts,
      });
    } catch (e) {
      expect((e as ReconciliationError).code).toBe("DUPLICATE_HCS_SEQUENCE");
    }
  });

  it("rejects duplicate bid ID", () => {
    const s = buildFullScenario();
    const c0 = s.commitments[0]!;
    const c1 = {
      ...s.commitments[1]!,
      bidId: c0.bidId,
      hcsSequence: 999,
    };
    expect(() =>
      validateReconciliationInputs({
        commitments: [c0, c1],
        fullBids: s.fullBids,
        acceptanceReceipts: s.receipts,
      }),
    ).toThrow(/DUPLICATE_BID_ID|Duplicate commitment bidId/);
  });

  it("rejects duplicate full bids for one bidId", () => {
    const s = buildFullScenario();
    const entries = [...s.fullBids.entries()];
    const [id, bid] = entries[0]!;
    expect(() =>
      validateReconciliationInputs({
        commitments: s.commitments,
        fullBids: [
          [id, bid],
          [id, bid],
        ],
        acceptanceReceipts: s.receipts,
      }),
    ).toThrow(/Duplicate full bid/);
  });

  it("rejects one bid object assigned to two map keys", () => {
    const s = buildFullScenario();
    const bid = s.fullBids.values().next().value!;
    expect(() =>
      validateReconciliationInputs({
        commitments: s.commitments.slice(0, 1),
        fullBids: [
          [bid.bid.bidId, bid],
          ["other-id", { ...bid, bid: { ...bid.bid, bidId: "other-id" } }],
        ],
        acceptanceReceipts: s.receipts,
      }),
    ).not.toThrow(); // different objects OK

    const shared = bid;
    expect(() =>
      validateReconciliationInputs({
        commitments: [s.commitments[0]!],
        fullBids: [
          [shared.bid.bidId, shared],
          ["ghost", shared],
        ],
        acceptanceReceipts: s.receipts,
      }),
    ).toThrow(/One private bid object assigned|map key/);
  });

  it("rejects bidVersion mismatch", () => {
    const tender = buildHamburgIstanbulTender();
    const signed = buildSignedBid({
      bidId: "ver",
      carrier: "alpha",
      freightPriceCents: 350_000,
      version: 1,
    });
    const receipt = buildReceiptForBid(signed);
    const commitment = {
      ...buildCommitment(signed, receipt, 1, "2026-08-01T09:00:00.000Z"),
      bidVersion: 2,
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
    expect(result.reasonCodes).toContain("BID_VERSION_MISMATCH");
  });
});

describe("Adversarial — eligibility isolation", () => {
  it("malformed bid does not abort other commitments", () => {
    const tender = buildHamburgIstanbulTender();
    const good = buildSignedBid({
      bidId: "good",
      carrier: "alpha",
      freightPriceCents: 350_000,
    });
    const bad = buildSignedBid({
      bidId: "bad",
      carrier: "beta",
      freightPriceCents: 360_000,
    });
    // Corrupt the bad bid content after signing (JSON-compatible schema invalid)
    const corrupted = {
      bid: { ...bad.bid, freightPriceCents: "corrupt" as unknown as number },
      signature: bad.signature,
    };
    const rg = buildCarrierRegistry();
    const rGood = buildReceiptForBid(good);
    const rBad = buildReceiptForBid(bad);

    const results = evaluateAllCommitments(
      tender,
      [
        buildCommitment(good, rGood, 1, "2026-08-01T09:00:00.000Z"),
        {
          ...buildCommitment(bad, rBad, 2, "2026-08-01T09:01:00.000Z"),
        },
      ],
      new Map([
        ["good", good],
        ["bad", corrupted as typeof bad],
      ]),
      new Map([
        ["good", rGood],
        ["bad", rBad],
      ]),
      rg,
      ROUTEGUARD_PUBLIC_KEY,
      EVALUATION_TIMESTAMP,
    );

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.bidId === "good")?.decision).toBe("QUALIFIED");
    expect(results.find((r) => r.bidId === "bad")?.reasonCodes).toContain(
      "INVALID_BID_SCHEMA",
    );
  });

  it("malformed receipt does not abort other commitments", () => {
    const tender = buildHamburgIstanbulTender();
    const a = buildSignedBid({
      bidId: "a1",
      carrier: "alpha",
      freightPriceCents: 350_000,
    });
    const b = buildSignedBid({
      bidId: "b1",
      carrier: "beta",
      freightPriceCents: 360_000,
    });
    const ra = buildReceiptForBid(a);
    const rb = buildReceiptForBid(b);
    const badReceipt = {
      receipt: { ...rb.receipt, acceptedAt: "not-a-date" },
      signature: rb.signature,
    };

    const results = evaluateAllCommitments(
      tender,
      [
        buildCommitment(a, ra, 1, "2026-08-01T09:00:00.000Z"),
        buildCommitment(b, rb, 2, "2026-08-01T09:01:00.000Z"),
      ],
      new Map([
        ["a1", a],
        ["b1", b],
      ]),
      new Map([
        ["a1", ra],
        ["b1", badReceipt as typeof rb],
      ]),
      buildCarrierRegistry(),
      ROUTEGUARD_PUBLIC_KEY,
      EVALUATION_TIMESTAMP,
    );

    expect(results.find((r) => r.bidId === "a1")?.decision).toBe("QUALIFIED");
    expect(results.find((r) => r.bidId === "b1")?.reasonCodes).toContain(
      "INVALID_ACCEPTANCE_RECEIPT",
    );
  });

  it("pickup before/after window rejected", () => {
    const tender = buildHamburgIstanbulTender();
    const early = buildSignedBid({
      bidId: "early-p",
      carrier: "alpha",
      freightPriceCents: 350_000,
      proposedPickupAt: "2026-08-03T05:00:00.000Z",
    });
    const late = buildSignedBid({
      bidId: "late-p",
      carrier: "alpha",
      freightPriceCents: 350_000,
      proposedPickupAt: "2026-08-03T19:00:00.000Z",
    });
    for (const signed of [early, late]) {
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
      expect(result.reasonCodes).toContain("PICKUP_WINDOW_INFEASIBLE");
    }
  });

  it("late commitments never enter ranking", () => {
    const s = buildFullScenario();
    const results = evaluateAllCommitments(
      s.tender,
      s.commitments,
      s.fullBids,
      s.receipts,
      s.registry,
      s.routeGuardPublicKey,
      s.evaluationTimestamp,
    );
    const late = results.find((r) => r.bidId === "bid-late-cheap");
    expect(late?.reasonCodes).toContain("LATE_COMMITMENT");
    expect(selectWinner(results)?.bidId).not.toBe("bid-late-cheap");
  });
});

describe("Adversarial — evaluatedBidSetHash sensitivity", () => {
  it("changes when commitment fields or decisions change; stable under reorder", () => {
    const s = buildFullScenario();
    const baseResults = evaluateAllCommitments(
      s.tender,
      s.commitments,
      s.fullBids,
      s.receipts,
      s.registry,
      s.routeGuardPublicKey,
      s.evaluationTimestamp,
    );
    const h1 = computeEvaluatedBidSetHash(s.tender, baseResults);
    const h2 = computeEvaluatedBidSetHash(
      s.tender,
      [...baseResults].reverse(),
    );
    expect(h1).toBe(h2);

    // Mutate a commitment bidHash field in a cloned result
    const mutated = baseResults.map((r, i) =>
      i === 0
        ? {
            ...r,
            commitment: r.commitment
              ? {
                  ...r.commitment,
                  bidHash: `sha256:${"ff".repeat(32)}`,
                }
              : null,
          }
        : r,
    );
    expect(computeEvaluatedBidSetHash(s.tender, mutated)).not.toBe(h1);

    // Decision mutation
    const decMut = baseResults.map((r, i) =>
      i === 0
        ? {
            ...r,
            decision: "REJECTED" as const,
            reasonCodes: ["PRICE_ABOVE_MAXIMUM" as const],
          }
        : r,
    );
    expect(computeEvaluatedBidSetHash(s.tender, decMut)).not.toBe(h1);

    // Full-bid presence mutation
    const presMut = baseResults.map((r, i) =>
      i === 0
        ? { ...r, fullBidPresent: !r.fullBidPresent }
        : r,
    );
    expect(computeEvaluatedBidSetHash(s.tender, presMut)).not.toBe(h1);
  });

  it("manifest hash stable under input permutation", () => {
    const s = buildFullScenario();
    const m1 = evaluateScenario(s);
    const m2 = evaluateAuction({
      tender: s.tender,
      commitments: [...s.commitments].reverse(),
      fullBids: s.fullBids,
      acceptanceReceipts: s.receipts,
      registry: s.registry,
      routeGuardPublicKey: s.routeGuardPublicKey,
      evaluationTimestamp: s.evaluationTimestamp,
      barrierSequence: 100,
      reconciliationReference: "hcs-topic:10-31",
    });
    expect(m1.decisionManifestHash).toBe(m2.decisionManifestHash);
    expect(m1.winningBidId).toBe(m2.winningBidId);
  });

  it("manifest mutation changes its hash via integrity check", () => {
    const s = buildFullScenario();
    const m = evaluateScenario(s);
    const forged = {
      ...m,
      winningBidId: "forged-winner",
      winningBidHash: `sha256:${"aa".repeat(32)}`,
    };
    const results = evaluateAllCommitments(
      s.tender,
      s.commitments,
      s.fullBids,
      s.receipts,
      s.registry,
      s.routeGuardPublicKey,
      s.evaluationTimestamp,
    );
    const check = verifyDecisionManifestIntegrity({
      manifest: forged,
      tender: s.tender,
      results,
      evaluationTimestamp: s.evaluationTimestamp,
      barrierSequence: 100,
      reconciliationReference: "hcs-topic:10-31",
    });
    expect(check.ok).toBe(false);
  });
});

describe("Adversarial — state machine closure proof", () => {
  function makeCompleteProof(scenario = buildFullScenario()) {
    const seqs = sequencesFromCommitments(scenario.commitments);
    const start = Math.min(...seqs);
    const end = Math.max(...seqs);
    // Fill complete range
    const observed: number[] = [];
    for (let i = start; i <= end; i++) observed.push(i);

    return createAuctionClosureProof({
      tender: scenario.tender,
      auctionEndsAt: scenario.tender.auctionEndsAt,
      closeBarrierSequence: end + 1,
      closeBarrierConsensusTimestamp: "2026-08-01T10:00:01.000Z",
      reconciledStartSequence: start,
      reconciledEndSequence: end,
      observedSequences: observed,
      evaluationTimestamp: scenario.evaluationTimestamp,
      reconciliationReference: "proof-ref",
      commitments: scenario.commitments,
      fullBids: scenario.fullBids,
      acceptanceReceipts: scenario.receipts,
      registry: scenario.registry,
      routeGuardPublicKey: scenario.routeGuardPublicKey,
      now: scenario.evaluationTimestamp,
    });
  }

  it("happy path WINNER_SELECTED with closure proof", () => {
    const proof = makeCompleteProof();
    let ctx = createAuctionMachine(AUCTION_ENDS_AT);
    ctx = transitionToOpen(ctx);
    ctx = transitionToBidding(ctx);
    ctx = transitionToReconciliation(ctx, AUCTION_ENDS_AT);
    ctx = transitionToClosed(ctx, proof);
    ctx = transitionToWinnerSelected(ctx);
    expect(ctx.state).toBe("WINNER_SELECTED");
    expect(ctx.decisionManifest?.winningBidId).toBe("bid-winner-low");
  });

  it("bare caller booleans cannot prove closure", () => {
    let ctx = createAuctionMachine(AUCTION_ENDS_AT);
    ctx = transitionToOpen(ctx);
    ctx = transitionToBidding(ctx);
    ctx = transitionToReconciliation(ctx, AUCTION_ENDS_AT);
    expect(() =>
      transitionToClosedWithBooleans(ctx, {
        closeBarrierPresent: true,
        reconciledRangeComplete: true,
      }),
    ).toThrow(/Bare caller booleans/);
  });

  it("forged plain manifest cannot authorize WINNER_SELECTED", () => {
    let ctx = createAuctionMachine(AUCTION_ENDS_AT);
    ctx = transitionToOpen(ctx);
    ctx = transitionToBidding(ctx);
    ctx = transitionToReconciliation(ctx, AUCTION_ENDS_AT);
    // Skip proof — attempt winner with empty context
    expect(() => transitionToWinnerSelected(ctx)).toThrow(
      IllegalAuctionTransitionError,
    );
  });

  it("NO_QUALIFIED_BID requires null winners and zero qualified", () => {
    const tender = buildHamburgIstanbulTender();
    const signed = buildSignedBid({
      bidId: "only-over",
      carrier: "alpha",
      freightPriceCents: 500_000,
    });
    const receipt = buildReceiptForBid(signed);
    const commitment = buildCommitment(
      signed,
      receipt,
      1,
      "2026-08-01T09:00:00.000Z",
    );
    const registry = buildCarrierRegistry();
    const proof = createAuctionClosureProof({
      tender,
      auctionEndsAt: tender.auctionEndsAt,
      closeBarrierSequence: 2,
      closeBarrierConsensusTimestamp: "2026-08-01T10:00:01.000Z",
      reconciledStartSequence: 1,
      reconciledEndSequence: 1,
      observedSequences: [1],
      evaluationTimestamp: EVALUATION_TIMESTAMP,
      reconciliationReference: "no-qual",
      commitments: [commitment],
      fullBids: new Map([[signed.bid.bidId, signed]]),
      acceptanceReceipts: new Map([[signed.bid.bidId, receipt]]),
      registry,
      routeGuardPublicKey: ROUTEGUARD_PUBLIC_KEY,
      now: EVALUATION_TIMESTAMP,
    });

    expect(proof.manifest.winningBidId).toBeNull();
    expect(proof.manifest.winningBidHash).toBeNull();

    let ctx = createAuctionMachine(AUCTION_ENDS_AT);
    ctx = transitionToOpen(ctx);
    ctx = transitionToBidding(ctx);
    ctx = transitionToReconciliation(ctx, AUCTION_ENDS_AT);
    ctx = transitionToClosed(ctx, proof);
    ctx = transitionToNoQualifiedBid(ctx);
    expect(ctx.state).toBe("NO_QUALIFIED_BID");
  });
});

describe("Adversarial — rules immutability", () => {
  it("rules arrays cannot be mutated", () => {
    const ranking = LOWEST_QUALIFIED_PRICE_V1_RULES.ranking as string[];
    expect(Object.isFrozen(LOWEST_QUALIFIED_PRICE_V1_RULES)).toBe(true);
    expect(Object.isFrozen(LOWEST_QUALIFIED_PRICE_V1_RULES.ranking)).toBe(
      true,
    );
    expect(() => {
      ranking.push("hack");
    }).toThrow();
  });
});

describe("Adversarial — ranking mixed precision", () => {
  it("nanosecond delivery precision affects ranking", () => {
    const tender = buildHamburgIstanbulTender();
    const a = buildSignedBid({
      bidId: "ns-a",
      carrier: "alpha",
      freightPriceCents: 300_000,
      estimatedDelivery: "2026-08-06T12:00:00.000000002Z",
    });
    const b = buildSignedBid({
      bidId: "ns-b",
      carrier: "beta",
      freightPriceCents: 300_000,
      estimatedDelivery: "2026-08-06T12:00:00.000000001Z",
    });
    const ra = buildReceiptForBid(a);
    const rb = buildReceiptForBid(b);
    const results = evaluateAllCommitments(
      tender,
      [
        buildCommitment(a, ra, 1, "2026-08-01T09:00:00.000Z"),
        buildCommitment(b, rb, 2, "2026-08-01T09:00:00.000Z"),
      ],
      new Map([
        ["ns-a", a],
        ["ns-b", b],
      ]),
      new Map([
        ["ns-a", ra],
        ["ns-b", rb],
      ]),
      buildCarrierRegistry(),
      ROUTEGUARD_PUBLIC_KEY,
      EVALUATION_TIMESTAMP,
    );
    expect(selectWinner(results)?.bidId).toBe("ns-b");
  });
});

describe("Integrity — submitted evidence binding in evaluatedBidSetHash", () => {
  it("different malformed bids with same rejection code produce different hashes", () => {
    const tender = buildHamburgIstanbulTender();
    const good = buildSignedBid({
      bidId: "bind-good",
      carrier: "alpha",
      freightPriceCents: 350_000,
    });
    // Two differently corrupted plain envelopes
    // Schema-invalid but JSON-compatible (strings, not NaN) so evidence hashes.
    const malA = {
      bid: {
        ...good.bid,
        bidId: "mal-a",
        freightPriceCents: "not-an-integer" as unknown as number,
      },
      signature: good.signature,
    };
    const malB = {
      bid: {
        ...good.bid,
        bidId: "mal-b",
        freightPriceCents: "also-not-an-integer" as unknown as number,
        nonce: "different-nonce-for-mal-b",
      },
      signature: good.signature,
    };
    // Need valid commitments for mal-a/mal-b — use fixed synthetic commitments
    // with matching bidIds (hash fields placeholder-valid sha256)
    const dummyHash = `sha256:${"ab".repeat(32)}`;
    const cA = {
      tenderId: tender.tenderId,
      bidId: "mal-a",
      carrierId: "carrier-alpha",
      bidHash: dummyHash,
      acceptanceReceiptHash: dummyHash,
      bidVersion: 1,
      hcsSequence: 1,
      consensusTimestamp: "2026-08-01T09:00:00.000Z",
    };
    const cB = { ...cA, bidId: "mal-b", hcsSequence: 2 };

    const resultsA = evaluateAllCommitments(
      tender,
      [cA],
      new Map([["mal-a", malA]]),
      new Map(),
      buildCarrierRegistry(),
      ROUTEGUARD_PUBLIC_KEY,
      EVALUATION_TIMESTAMP,
    );
    const resultsB = evaluateAllCommitments(
      tender,
      [cB],
      new Map([["mal-b", malB]]),
      new Map(),
      buildCarrierRegistry(),
      ROUTEGUARD_PUBLIC_KEY,
      EVALUATION_TIMESTAMP,
    );

    expect(resultsA[0]?.reasonCodes).toContain("INVALID_BID_SCHEMA");
    expect(resultsB[0]?.reasonCodes).toContain("INVALID_BID_SCHEMA");
    expect(resultsA[0]?.submittedSignedBidEnvelopeHash).not.toBeNull();
    expect(resultsA[0]?.submittedSignedBidEnvelopeHash).not.toBe(
      resultsB[0]?.submittedSignedBidEnvelopeHash,
    );
    expect(computeEvaluatedBidSetHash(tender, resultsA)).not.toBe(
      computeEvaluatedBidSetHash(tender, resultsB),
    );
  });

  it("different malformed receipts with same rejection code produce different hashes", () => {
    const tender = buildHamburgIstanbulTender();
    const signed = buildSignedBid({
      bidId: "rcp-mal",
      carrier: "alpha",
      freightPriceCents: 350_000,
    });
    const goodReceipt = buildReceiptForBid(signed);
    const commitment = buildCommitment(
      signed,
      goodReceipt,
      1,
      "2026-08-01T09:00:00.000Z",
    );
    const malR1 = {
      receipt: { ...goodReceipt.receipt, acceptedAt: "not-a-date", receiptId: "r-x" },
      signature: goodReceipt.signature,
    };
    const malR2 = {
      receipt: { ...goodReceipt.receipt, acceptedAt: "also-bad", receiptId: "r-y" },
      signature: goodReceipt.signature,
    };

    const r1 = evaluateAllCommitments(
      tender,
      [commitment],
      new Map([[signed.bid.bidId, signed]]),
      new Map([[signed.bid.bidId, malR1]]),
      buildCarrierRegistry(),
      ROUTEGUARD_PUBLIC_KEY,
      EVALUATION_TIMESTAMP,
    );
    const r2 = evaluateAllCommitments(
      tender,
      [commitment],
      new Map([[signed.bid.bidId, signed]]),
      new Map([[signed.bid.bidId, malR2]]),
      buildCarrierRegistry(),
      ROUTEGUARD_PUBLIC_KEY,
      EVALUATION_TIMESTAMP,
    );

    expect(r1[0]?.reasonCodes).toContain("INVALID_ACCEPTANCE_RECEIPT");
    expect(r2[0]?.reasonCodes).toContain("INVALID_ACCEPTANCE_RECEIPT");
    expect(r1[0]?.submittedReceiptEnvelopeHash).not.toBe(
      r2[0]?.submittedReceiptEnvelopeHash,
    );
    expect(computeEvaluatedBidSetHash(tender, r1)).not.toBe(
      computeEvaluatedBidSetHash(tender, r2),
    );
  });

  it("removing malformed evidence or changing a field changes the hash", () => {
    const tender = buildHamburgIstanbulTender();
    const dummyHash = `sha256:${"cd".repeat(32)}`;
    const commitment = {
      tenderId: tender.tenderId,
      bidId: "rm-mal",
      carrierId: "carrier-alpha",
      bidHash: dummyHash,
      acceptanceReceiptHash: dummyHash,
      bidVersion: 1,
      hcsSequence: 1,
      consensusTimestamp: "2026-08-01T09:00:00.000Z",
    };
    const mal = {
      bid: { junk: true, freightPriceCents: "nope" },
      signature: "aa".repeat(64),
    };
    const withMal = evaluateAllCommitments(
      tender,
      [commitment],
      new Map([["rm-mal", mal]]),
      new Map(),
      buildCarrierRegistry(),
      ROUTEGUARD_PUBLIC_KEY,
      EVALUATION_TIMESTAMP,
    );
    const without = evaluateAllCommitments(
      tender,
      [commitment],
      new Map(),
      new Map(),
      buildCarrierRegistry(),
      ROUTEGUARD_PUBLIC_KEY,
      EVALUATION_TIMESTAMP,
    );
    const mal2 = {
      bid: { junk: true, freightPriceCents: "nope", extra: 1 },
      signature: "aa".repeat(64),
    };
    const withMal2 = evaluateAllCommitments(
      tender,
      [commitment],
      new Map([["rm-mal", mal2]]),
      new Map(),
      buildCarrierRegistry(),
      ROUTEGUARD_PUBLIC_KEY,
      EVALUATION_TIMESTAMP,
    );

    const h1 = computeEvaluatedBidSetHash(tender, withMal);
    const h0 = computeEvaluatedBidSetHash(tender, without);
    const h2 = computeEvaluatedBidSetHash(tender, withMal2);
    expect(h1).not.toBe(h0);
    expect(h1).not.toBe(h2);
  });

  it("unsupported non-JSON evidence fails with typed error", () => {
    expect(() => hashSubmittedEvidence(new Date())).toThrow(ReconciliationError);
    try {
      hashSubmittedEvidence(() => 1);
    } catch (e) {
      expect(e).toBeInstanceOf(ReconciliationError);
      expect((e as ReconciliationError).code).toBe("UNSUPPORTED_EVIDENCE_TYPE");
    }
  });
});

describe("Integrity — manifest vs authoritative evaluation", () => {
  function rehashManifest(
    body: Omit<DecisionManifest, "decisionManifestHash">,
  ): DecisionManifest {
    return {
      ...body,
      decisionManifestHash: canonicalSha256(body),
    };
  }

  it("altered decision rehashed still fails verification", () => {
    const s = buildFullScenario();
    const manifest = evaluateScenario(s);
    const results = evaluateAllCommitments(
      s.tender,
      s.commitments,
      s.fullBids,
      s.receipts,
      s.registry,
      s.routeGuardPublicKey,
      s.evaluationTimestamp,
    );

    const entry = manifest.commitments.find(
      (c) => c.bidId === "bid-over-max",
    )!;
    const alteredCommitments = manifest.commitments.map((c) =>
      c.bidId === entry.bidId
        ? { ...c, decision: "QUALIFIED" as const, reasonCodes: [] }
        : c,
    );
    const { decisionManifestHash: _d, ...rest } = manifest;
    const forged = rehashManifest({
      ...rest,
      commitments: alteredCommitments,
    });

    const check = verifyDecisionManifestIntegrity({
      manifest: forged,
      tender: s.tender,
      results,
      evaluationTimestamp: s.evaluationTimestamp,
      barrierSequence: 100,
      reconciliationReference: "hcs-topic:10-31",
    });
    expect(check.ok).toBe(false);
    expect(check.errors.some((e) => /decision|authoritative|hash/i.test(e))).toBe(
      true,
    );
  });

  it("omitted entry / extra entry / reordered entry fail after rehash", () => {
    const s = buildFullScenario();
    const manifest = evaluateScenario(s);
    const results = evaluateAllCommitments(
      s.tender,
      s.commitments,
      s.fullBids,
      s.receipts,
      s.registry,
      s.routeGuardPublicKey,
      s.evaluationTimestamp,
    );
    const { decisionManifestHash: _d, ...rest } = manifest;

    const omitted = rehashManifest({
      ...rest,
      commitments: manifest.commitments.slice(1),
    });
    expect(
      verifyDecisionManifestIntegrity({
        manifest: omitted,
        tender: s.tender,
        results,
        evaluationTimestamp: s.evaluationTimestamp,
        barrierSequence: 100,
        reconciliationReference: "hcs-topic:10-31",
      }).ok,
    ).toBe(false);

    const extra = rehashManifest({
      ...rest,
      commitments: [
        ...manifest.commitments,
        {
          bidId: "ghost",
          carrierId: "x",
          hcsSequence: 9999,
          consensusTimestamp: "2026-08-01T09:00:00.000Z",
          decision: "REJECTED",
          reasonCodes: ["FULL_BID_MISSING"],
        },
      ],
    });
    expect(
      verifyDecisionManifestIntegrity({
        manifest: extra,
        tender: s.tender,
        results,
        evaluationTimestamp: s.evaluationTimestamp,
        barrierSequence: 100,
        reconciliationReference: "hcs-topic:10-31",
      }).ok,
    ).toBe(false);

    // Reverse order then rehash — fails exact order comparison vs authoritative
    const reordered = rehashManifest({
      ...rest,
      commitments: [...manifest.commitments].reverse(),
    });
    expect(
      verifyDecisionManifestIntegrity({
        manifest: reordered,
        tender: s.tender,
        results,
        evaluationTimestamp: s.evaluationTimestamp,
        barrierSequence: 100,
        reconciliationReference: "hcs-topic:10-31",
      }).ok,
    ).toBe(false);
  });

  it("forged winner fields rehashed fail; genuine passes", () => {
    const s = buildFullScenario();
    const manifest = evaluateScenario(s);
    const results = evaluateAllCommitments(
      s.tender,
      s.commitments,
      s.fullBids,
      s.receipts,
      s.registry,
      s.routeGuardPublicKey,
      s.evaluationTimestamp,
    );

    expect(
      verifyDecisionManifestIntegrity({
        manifest,
        tender: s.tender,
        results,
        evaluationTimestamp: s.evaluationTimestamp,
        barrierSequence: 100,
        reconciliationReference: "hcs-topic:10-31",
      }).ok,
    ).toBe(true);

    const { decisionManifestHash: _d, ...rest } = manifest;
    const forgedWinner = rehashManifest({
      ...rest,
      winningBidId: "bid-higher-price",
      winningBidHash: `sha256:${"ee".repeat(32)}`,
    });
    expect(
      verifyDecisionManifestIntegrity({
        manifest: forgedWinner,
        tender: s.tender,
        results,
        evaluationTimestamp: s.evaluationTimestamp,
        barrierSequence: 100,
        reconciliationReference: "hcs-topic:10-31",
      }).ok,
    ).toBe(false);

    // Expected reconstruction matches genuine
    const expected = reconstructExpectedManifestBody(
      s.tender,
      results,
      s.evaluationTimestamp,
      100,
      "hcs-topic:10-31",
    );
    expect(manifest.decisionManifestHash).toBe(canonicalSha256(expected));
  });

  it("no-winner converted to winner rehashed fails", () => {
    const tender = buildHamburgIstanbulTender();
    const signed = buildSignedBid({
      bidId: "only-bad2",
      carrier: "alpha",
      freightPriceCents: 500_000,
    });
    const receipt = buildReceiptForBid(signed);
    const commitment = buildCommitment(
      signed,
      receipt,
      1,
      "2026-08-01T09:00:00.000Z",
    );
    const results = evaluateAllCommitments(
      tender,
      [commitment],
      new Map([[signed.bid.bidId, signed]]),
      new Map([[signed.bid.bidId, receipt]]),
      buildCarrierRegistry(),
      ROUTEGUARD_PUBLIC_KEY,
      EVALUATION_TIMESTAMP,
    );
    const genuine = buildDecisionManifest({
      tender,
      commitments: [commitment],
      fullBids: new Map([[signed.bid.bidId, signed]]),
      acceptanceReceipts: new Map([[signed.bid.bidId, receipt]]),
      registry: buildCarrierRegistry(),
      routeGuardPublicKey: ROUTEGUARD_PUBLIC_KEY,
      evaluationTimestamp: EVALUATION_TIMESTAMP,
      barrierSequence: 1,
      reconciliationReference: "nw",
    });
    expect(genuine.winningBidId).toBeNull();

    const { decisionManifestHash: _d, ...rest } = genuine;
    const forged = rehashManifest({
      ...rest,
      winningBidId: signed.bid.bidId,
      winningBidHash: bidHash(signed.bid),
    });
    expect(
      verifyDecisionManifestIntegrity({
        manifest: forged,
        tender,
        results,
        evaluationTimestamp: EVALUATION_TIMESTAMP,
        barrierSequence: 1,
        reconciliationReference: "nw",
      }).ok,
    ).toBe(false);
  });
});

describe("Integrity — authentic closure proof runtime identity", () => {
  function makeCompleteProof(scenario = buildFullScenario()) {
    const seqs = sequencesFromCommitments(scenario.commitments);
    const start = Math.min(...seqs);
    const end = Math.max(...seqs);
    const observed: number[] = [];
    for (let i = start; i <= end; i++) observed.push(i);
    return createAuctionClosureProof({
      tender: scenario.tender,
      auctionEndsAt: scenario.tender.auctionEndsAt,
      closeBarrierSequence: end + 1,
      closeBarrierConsensusTimestamp: "2026-08-01T10:00:01.000Z",
      reconciledStartSequence: start,
      reconciledEndSequence: end,
      observedSequences: observed,
      evaluationTimestamp: scenario.evaluationTimestamp,
      reconciliationReference: "auth-ref",
      commitments: scenario.commitments,
      fullBids: scenario.fullBids,
      acceptanceReceipts: scenario.receipts,
      registry: scenario.registry,
      routeGuardPublicKey: scenario.routeGuardPublicKey,
      now: scenario.evaluationTimestamp,
    });
  }

  it("plain proof-shaped object is rejected", () => {
    const genuine = makeCompleteProof();
    const plain = {
      tenderId: genuine.tenderId,
      tenderVersion: genuine.tenderVersion,
      auctionEndsAt: genuine.auctionEndsAt,
      closeBarrierSequence: genuine.closeBarrierSequence,
      closeBarrierConsensusTimestamp: genuine.closeBarrierConsensusTimestamp,
      reconciledStartSequence: genuine.reconciledStartSequence,
      reconciledEndSequence: genuine.reconciledEndSequence,
      observedSequences: [...genuine.observedSequences],
      completeness: true,
      evaluationTimestamp: genuine.evaluationTimestamp,
      reconciliationReference: genuine.reconciliationReference,
      manifest: genuine.manifest,
      integrityOk: true,
      results: genuine.results,
    };
    expect(isVerifiedAuctionClosureProof(plain)).toBe(false);

    let ctx = createAuctionMachine(AUCTION_ENDS_AT);
    ctx = transitionToOpen(ctx);
    ctx = transitionToBidding(ctx);
    ctx = transitionToReconciliation(ctx, AUCTION_ENDS_AT);
    expect(() => transitionToClosed(ctx, plain)).toThrow(
      /not an authentic factory-verified proof/,
    );
  });

  it("spread copy and JSON round-trip are rejected", () => {
    const genuine = makeCompleteProof();
    const spread = { ...genuine };
    expect(isVerifiedAuctionClosureProof(spread)).toBe(false);

    const jsonCopy = JSON.parse(JSON.stringify(genuine));
    expect(isVerifiedAuctionClosureProof(jsonCopy)).toBe(false);

    let ctx = createAuctionMachine(AUCTION_ENDS_AT);
    ctx = transitionToOpen(ctx);
    ctx = transitionToBidding(ctx);
    ctx = transitionToReconciliation(ctx, AUCTION_ENDS_AT);
    expect(() => transitionToClosed(ctx, spread)).toThrow(/authentic/);
    expect(() => transitionToClosed(ctx, jsonCopy)).toThrow(/authentic/);
  });

  it("genuine factory proof authorizes closed and winner", () => {
    const proof = makeCompleteProof();
    expect(isVerifiedAuctionClosureProof(proof)).toBe(true);
    let ctx = createAuctionMachine(AUCTION_ENDS_AT);
    ctx = transitionToOpen(ctx);
    ctx = transitionToBidding(ctx);
    ctx = transitionToReconciliation(ctx, AUCTION_ENDS_AT);
    ctx = transitionToClosed(ctx, proof);
    ctx = transitionToWinnerSelected(ctx);
    expect(ctx.state).toBe("WINNER_SELECTED");
  });

  it("proof with modified tender identity is not creatable; wrong tender rejected at factory", () => {
    const s = buildFullScenario();
    const other = buildHamburgIstanbulTender({
      tenderId: "other-tender",
    });
    const seqs = sequencesFromCommitments(s.commitments);
    const start = Math.min(...seqs);
    const end = Math.max(...seqs);
    const observed: number[] = [];
    for (let i = start; i <= end; i++) observed.push(i);

    expect(() =>
      createAuctionClosureProof({
        tender: other,
        auctionEndsAt: other.auctionEndsAt,
        closeBarrierSequence: end + 1,
        closeBarrierConsensusTimestamp: "2026-08-01T10:00:01.000Z",
        reconciledStartSequence: start,
        reconciledEndSequence: end,
        observedSequences: observed,
        evaluationTimestamp: s.evaluationTimestamp,
        reconciliationReference: "wrong-tender",
        commitments: s.commitments, // still reference original tenderId
        fullBids: s.fullBids,
        acceptanceReceipts: s.receipts,
        registry: s.registry,
        routeGuardPublicKey: s.routeGuardPublicKey,
        now: s.evaluationTimestamp,
      }),
    ).toThrow();
  });

  it("frozen genuine proof cannot be mutated", () => {
    const proof = makeCompleteProof();
    expect(Object.isFrozen(proof)).toBe(true);
    expect(() => {
      (proof as { completeness: boolean }).completeness = false;
    }).toThrow();
  });
});

