import { describe, expect, it } from "vitest";

import { createAuctionClosureProof } from "../src/auction/closure-proof";
import {
  createAuctionMachine,
  IllegalAuctionTransitionError,
  isTerminalState,
  transitionToBidding,
  transitionToClosed,
  transitionToClosedWithBooleans,
  transitionToIncompleteHcsWindow,
  transitionToNoQualifiedBid,
  transitionToOpen,
  transitionToReconciliation,
  transitionToWinnerSelected,
} from "../src/auction/state-machine";
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

function completeProof(scenario = buildFullScenario()) {
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
    reconciliationReference: "barrier",
    commitments: scenario.commitments,
    fullBids: scenario.fullBids,
    acceptanceReceipts: scenario.receipts,
    registry: scenario.registry,
    routeGuardPublicKey: scenario.routeGuardPublicKey,
    now: scenario.evaluationTimestamp,
  });
}

describe("Auction state machine", () => {
  it("follows the happy path to WINNER_SELECTED", () => {
    const proof = completeProof();
    let ctx = createAuctionMachine(AUCTION_ENDS_AT);
    ctx = transitionToOpen(ctx);
    ctx = transitionToBidding(ctx);
    ctx = transitionToReconciliation(ctx, AUCTION_ENDS_AT);
    ctx = transitionToClosed(ctx, proof);
    ctx = transitionToWinnerSelected(ctx);
    expect(ctx.state).toBe("WINNER_SELECTED");
    expect(ctx.decisionManifest?.winningBidId).toBe("bid-winner-low");
    expect(isTerminalState(ctx.state)).toBe(true);
  });

  it("rejects illegal transitions", () => {
    const ctx = createAuctionMachine(AUCTION_ENDS_AT);
    expect(() => transitionToBidding(ctx)).toThrow(
      IllegalAuctionTransitionError,
    );
  });

  it("rejects reconciliation before deadline", () => {
    let ctx = createAuctionMachine(AUCTION_ENDS_AT);
    ctx = transitionToOpen(ctx);
    ctx = transitionToBidding(ctx);
    expect(() =>
      transitionToReconciliation(ctx, "2026-08-01T09:59:59.000Z"),
    ).toThrow(/before auctionEndsAt/);
  });

  it("rejects bare boolean closure", () => {
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

  it("rejects WINNER_SELECTED without closure proof", () => {
    let ctx = createAuctionMachine(AUCTION_ENDS_AT);
    ctx = transitionToOpen(ctx);
    ctx = transitionToBidding(ctx);
    ctx = transitionToReconciliation(ctx, AUCTION_ENDS_AT);
    expect(() => transitionToWinnerSelected(ctx)).toThrow(
      IllegalAuctionTransitionError,
    );
  });

  it("transitions to NO_QUALIFIED_BID when no winner", () => {
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
    const proof = createAuctionClosureProof({
      tender,
      auctionEndsAt: tender.auctionEndsAt,
      closeBarrierSequence: 2,
      closeBarrierConsensusTimestamp: "2026-08-01T10:00:01.000Z",
      reconciledStartSequence: 1,
      reconciledEndSequence: 1,
      observedSequences: [1],
      evaluationTimestamp: EVALUATION_TIMESTAMP,
      reconciliationReference: "r",
      commitments: [commitment],
      fullBids: new Map([[signed.bid.bidId, signed]]),
      acceptanceReceipts: new Map([[signed.bid.bidId, receipt]]),
      registry: buildCarrierRegistry(),
      routeGuardPublicKey: ROUTEGUARD_PUBLIC_KEY,
      now: EVALUATION_TIMESTAMP,
    });

    let ctx = createAuctionMachine(AUCTION_ENDS_AT);
    ctx = transitionToOpen(ctx);
    ctx = transitionToBidding(ctx);
    ctx = transitionToReconciliation(ctx, AUCTION_ENDS_AT);
    ctx = transitionToClosed(ctx, proof);
    ctx = transitionToNoQualifiedBid(ctx);
    expect(ctx.state).toBe("NO_QUALIFIED_BID");
  });

  it("supports INCOMPLETE_HCS_WINDOW with incomplete proof", () => {
    const scenario = buildFullScenario();
    const seqs = sequencesFromCommitments(scenario.commitments);
    const start = Math.min(...seqs);
    const end = Math.max(...seqs);
    // Missing last sequence
    const observed = seqs.filter((s) => s !== end);

    // createAuctionClosureProof requires complete observed covering commitments
    // For incomplete terminal we still need a proof object with completeness=false.
    // Build via factory will fail if commitment seq missing — so craft incomplete
    // proof only for range completeness while still including all commitment seqs
    // but claiming a wider range with a gap outside commitments is hard.
    // Use proof with completeness false by expanding range.
    const observedFull = [...seqs];
    const proof = createAuctionClosureProof({
      tender: scenario.tender,
      auctionEndsAt: scenario.tender.auctionEndsAt,
      closeBarrierSequence: end + 1,
      closeBarrierConsensusTimestamp: "2026-08-01T10:00:01.000Z",
      reconciledStartSequence: start,
      reconciledEndSequence: end + 1, // claims extra sequence not observed
      observedSequences: observedFull,
      evaluationTimestamp: scenario.evaluationTimestamp,
      reconciliationReference: "incomplete",
      commitments: scenario.commitments,
      fullBids: scenario.fullBids,
      acceptanceReceipts: scenario.receipts,
      registry: scenario.registry,
      routeGuardPublicKey: scenario.routeGuardPublicKey,
      now: scenario.evaluationTimestamp,
    });
    expect(proof.completeness).toBe(false);

    let ctx = createAuctionMachine(AUCTION_ENDS_AT);
    ctx = transitionToOpen(ctx);
    ctx = transitionToBidding(ctx);
    ctx = transitionToReconciliation(ctx, AUCTION_ENDS_AT);
    ctx = transitionToIncompleteHcsWindow(ctx, proof);
    expect(ctx.state).toBe("INCOMPLETE_HCS_WINDOW");
    expect(isTerminalState(ctx.state)).toBe(true);
  });

  it("rejects transition out of terminal states", () => {
    const scenario = buildFullScenario();
    const seqs = sequencesFromCommitments(scenario.commitments);
    const start = Math.min(...seqs);
    const end = Math.max(...seqs);
    const proof = createAuctionClosureProof({
      tender: scenario.tender,
      auctionEndsAt: scenario.tender.auctionEndsAt,
      closeBarrierSequence: end + 1,
      closeBarrierConsensusTimestamp: "2026-08-01T10:00:01.000Z",
      reconciledStartSequence: start,
      reconciledEndSequence: end + 1,
      observedSequences: seqs,
      evaluationTimestamp: scenario.evaluationTimestamp,
      reconciliationReference: "t",
      commitments: scenario.commitments,
      fullBids: scenario.fullBids,
      acceptanceReceipts: scenario.receipts,
      registry: scenario.registry,
      routeGuardPublicKey: scenario.routeGuardPublicKey,
      now: scenario.evaluationTimestamp,
    });
    let ctx = createAuctionMachine(AUCTION_ENDS_AT);
    ctx = transitionToOpen(ctx);
    ctx = transitionToBidding(ctx);
    ctx = transitionToReconciliation(ctx, AUCTION_ENDS_AT);
    ctx = transitionToIncompleteHcsWindow(ctx, proof);
    expect(() => transitionToClosed(ctx, proof)).toThrow(
      IllegalAuctionTransitionError,
    );
  });
});
