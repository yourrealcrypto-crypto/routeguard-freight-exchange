import { isBeforeOrEqualUtc, isUtcIsoTimestamp } from "../domain/time";
import {
  isVerifiedAuctionClosureProof,
  type AuctionClosureProof,
} from "./closure-proof";
import { isRankable } from "./eligibility";
import { isSequenceRangeComplete } from "./reconciliation";
import { selectWinner } from "./ranking";
import type { AuctionState, DecisionManifest } from "./types";

export type AuctionMachineContext = {
  state: AuctionState;
  auctionEndsAt: string;
  /** Authentic verified closure proof when closed/terminal. */
  closureProof: AuctionClosureProof | null;
  decisionManifest: DecisionManifest | null;
  now: string;
};

export class IllegalAuctionTransitionError extends Error {
  constructor(
    public readonly from: AuctionState,
    public readonly to: AuctionState,
    message?: string,
  ) {
    super(
      message ?? `Illegal auction state transition: ${from} → ${to}`,
    );
    this.name = "IllegalAuctionTransitionError";
  }
}

const LEGAL: ReadonlyMap<AuctionState, readonly AuctionState[]> = new Map([
  ["DRAFT", ["OPEN"]],
  ["OPEN", ["BIDDING"]],
  ["BIDDING", ["AUCTION_RECONCILIATION_PENDING"]],
  [
    "AUCTION_RECONCILIATION_PENDING",
    ["AUCTION_CLOSED", "INCOMPLETE_HCS_WINDOW"],
  ],
  ["AUCTION_CLOSED", ["WINNER_SELECTED", "NO_QUALIFIED_BID"]],
  ["WINNER_SELECTED", []],
  ["NO_QUALIFIED_BID", []],
  ["INCOMPLETE_HCS_WINDOW", []],
]);

export function createAuctionMachine(
  auctionEndsAt: string,
): AuctionMachineContext {
  if (!isUtcIsoTimestamp(auctionEndsAt)) {
    throw new Error("auctionEndsAt must be a valid UTC ISO-8601 timestamp");
  }
  return {
    state: "DRAFT",
    auctionEndsAt,
    closureProof: null,
    decisionManifest: null,
    now: auctionEndsAt,
  };
}

function assertLegal(from: AuctionState, to: AuctionState): void {
  const allowed = LEGAL.get(from) ?? [];
  if (!allowed.includes(to)) {
    throw new IllegalAuctionTransitionError(from, to);
  }
}

function requireAuthenticProof(
  from: AuctionState,
  to: AuctionState,
  proof: unknown,
): AuctionClosureProof {
  if (!isVerifiedAuctionClosureProof(proof)) {
    throw new IllegalAuctionTransitionError(
      from,
      to,
      "Closure proof is not an authentic factory-verified proof (plain/spread/JSON objects are rejected)",
    );
  }
  return proof;
}

export function transitionToOpen(
  ctx: AuctionMachineContext,
): AuctionMachineContext {
  assertLegal(ctx.state, "OPEN");
  return { ...ctx, state: "OPEN" };
}

export function transitionToBidding(
  ctx: AuctionMachineContext,
): AuctionMachineContext {
  assertLegal(ctx.state, "BIDDING");
  return { ...ctx, state: "BIDDING" };
}

export function transitionToReconciliation(
  ctx: AuctionMachineContext,
  now: string,
): AuctionMachineContext {
  assertLegal(ctx.state, "AUCTION_RECONCILIATION_PENDING");
  if (!isUtcIsoTimestamp(now)) {
    throw new Error("now must be a valid UTC ISO-8601 timestamp");
  }
  if (!isBeforeOrEqualUtc(ctx.auctionEndsAt, now)) {
    throw new IllegalAuctionTransitionError(
      ctx.state,
      "AUCTION_RECONCILIATION_PENDING",
      "Cannot enter reconciliation before auctionEndsAt",
    );
  }
  return {
    ...ctx,
    state: "AUCTION_RECONCILIATION_PENDING",
    now,
  };
}

/**
 * AUCTION_CLOSED requires an authentic verified closure proof.
 * Completeness is recomputed from sequences; booleans alone never authorize.
 */
export function transitionToClosed(
  ctx: AuctionMachineContext,
  proofInput: unknown,
): AuctionMachineContext {
  assertLegal(ctx.state, "AUCTION_CLOSED");
  const proof = requireAuthenticProof(ctx.state, "AUCTION_CLOSED", proofInput);

  // Recompute completeness — do not trust stored boolean alone.
  const recomputedComplete = isSequenceRangeComplete(
    proof.reconciledStartSequence,
    proof.reconciledEndSequence,
    proof.observedSequences,
  );
  if (!recomputedComplete) {
    throw new IllegalAuctionTransitionError(
      ctx.state,
      "AUCTION_CLOSED",
      "Sequence range is incomplete (recomputed); cannot close",
    );
  }

  if (proof.tenderId !== proof.manifest.tenderId) {
    throw new IllegalAuctionTransitionError(
      ctx.state,
      "AUCTION_CLOSED",
      "Closure proof tenderId mismatch",
    );
  }
  if (proof.tenderVersion !== proof.manifest.tenderVersion) {
    throw new IllegalAuctionTransitionError(
      ctx.state,
      "AUCTION_CLOSED",
      "Closure proof tenderVersion mismatch",
    );
  }
  if (proof.auctionEndsAt !== ctx.auctionEndsAt) {
    throw new IllegalAuctionTransitionError(
      ctx.state,
      "AUCTION_CLOSED",
      "Closure proof auctionEndsAt mismatch",
    );
  }
  if (!isBeforeOrEqualUtc(ctx.auctionEndsAt, proof.evaluationTimestamp)) {
    throw new IllegalAuctionTransitionError(
      ctx.state,
      "AUCTION_CLOSED",
      "evaluationTimestamp before auction deadline",
    );
  }
  if (
    !isBeforeOrEqualUtc(
      ctx.auctionEndsAt,
      proof.closeBarrierConsensusTimestamp,
    )
  ) {
    throw new IllegalAuctionTransitionError(
      ctx.state,
      "AUCTION_CLOSED",
      "close barrier before auction deadline",
    );
  }

  return {
    ...ctx,
    state: "AUCTION_CLOSED",
    closureProof: proof,
    decisionManifest: proof.manifest,
    now: proof.evaluationTimestamp,
  };
}

/**
 * INCOMPLETE_HCS_WINDOW requires authentic proof whose recomputed range is incomplete.
 */
export function transitionToIncompleteHcsWindow(
  ctx: AuctionMachineContext,
  proofInput: unknown,
): AuctionMachineContext {
  assertLegal(ctx.state, "INCOMPLETE_HCS_WINDOW");
  const proof = requireAuthenticProof(
    ctx.state,
    "INCOMPLETE_HCS_WINDOW",
    proofInput,
  );

  const recomputedComplete = isSequenceRangeComplete(
    proof.reconciledStartSequence,
    proof.reconciledEndSequence,
    proof.observedSequences,
  );
  if (recomputedComplete) {
    throw new IllegalAuctionTransitionError(
      ctx.state,
      "INCOMPLETE_HCS_WINDOW",
      "Sequence range is complete; cannot mark INCOMPLETE_HCS_WINDOW",
    );
  }

  return {
    ...ctx,
    state: "INCOMPLETE_HCS_WINDOW",
    closureProof: proof,
    decisionManifest: proof.manifest,
  };
}

export function transitionToWinnerSelected(
  ctx: AuctionMachineContext,
): AuctionMachineContext {
  assertLegal(ctx.state, "WINNER_SELECTED");

  const proof = ctx.closureProof;
  if (!proof || !isVerifiedAuctionClosureProof(proof)) {
    throw new IllegalAuctionTransitionError(
      ctx.state,
      "WINNER_SELECTED",
      "Authentic verified closure proof required",
    );
  }

  // Independently re-rank from authoritative results on the proof.
  const winner = selectWinner(proof.results);
  if (!winner) {
    throw new IllegalAuctionTransitionError(
      ctx.state,
      "WINNER_SELECTED",
      "No independently ranked winner; use NO_QUALIFIED_BID",
    );
  }

  const manifest = proof.manifest;
  if (manifest.winningBidId !== winner.bidId) {
    throw new IllegalAuctionTransitionError(
      ctx.state,
      "WINNER_SELECTED",
      "manifest winningBidId does not match independent ranking",
    );
  }
  if (manifest.winningBidHash !== winner.bidHash) {
    throw new IllegalAuctionTransitionError(
      ctx.state,
      "WINNER_SELECTED",
      "manifest winningBidHash does not match independent ranking",
    );
  }

  const qualified = proof.results.filter(isRankable);
  if (qualified.length < 1) {
    throw new IllegalAuctionTransitionError(
      ctx.state,
      "WINNER_SELECTED",
      "No qualified rankable entries",
    );
  }

  const winnerEntry = manifest.commitments.find(
    (c) => c.bidId === winner.bidId && c.decision === "QUALIFIED",
  );
  if (!winnerEntry) {
    throw new IllegalAuctionTransitionError(
      ctx.state,
      "WINNER_SELECTED",
      "winningBidId is not a QUALIFIED manifest entry",
    );
  }

  return {
    ...ctx,
    state: "WINNER_SELECTED",
    decisionManifest: manifest,
  };
}

export function transitionToNoQualifiedBid(
  ctx: AuctionMachineContext,
): AuctionMachineContext {
  assertLegal(ctx.state, "NO_QUALIFIED_BID");

  const proof = ctx.closureProof;
  if (!proof || !isVerifiedAuctionClosureProof(proof)) {
    throw new IllegalAuctionTransitionError(
      ctx.state,
      "NO_QUALIFIED_BID",
      "Authentic verified closure proof required",
    );
  }

  const winner = selectWinner(proof.results);
  if (winner !== null) {
    throw new IllegalAuctionTransitionError(
      ctx.state,
      "NO_QUALIFIED_BID",
      "Independent ranking found a winner; use WINNER_SELECTED",
    );
  }

  const manifest = proof.manifest;
  if (manifest.winningBidId !== null || manifest.winningBidHash !== null) {
    throw new IllegalAuctionTransitionError(
      ctx.state,
      "NO_QUALIFIED_BID",
      "Both winner fields must be null",
    );
  }

  const qualified = proof.results.filter(isRankable);
  if (qualified.length !== 0) {
    throw new IllegalAuctionTransitionError(
      ctx.state,
      "NO_QUALIFIED_BID",
      "Qualified entries exist; use WINNER_SELECTED",
    );
  }

  return {
    ...ctx,
    state: "NO_QUALIFIED_BID",
    decisionManifest: manifest,
  };
}

/**
 * Bare boolean closure is forbidden.
 */
export function transitionToClosedWithBooleans(
  ctx: AuctionMachineContext,
  _options: {
    closeBarrierPresent: boolean;
    reconciledRangeComplete: boolean;
  },
): AuctionMachineContext {
  throw new IllegalAuctionTransitionError(
    ctx.state,
    "AUCTION_CLOSED",
    "Bare caller booleans cannot prove auction closure; provide authentic VerifiedAuctionClosureProof",
  );
}

export function isTerminalState(state: AuctionState): boolean {
  return (
    state === "WINNER_SELECTED" ||
    state === "NO_QUALIFIED_BID" ||
    state === "INCOMPLETE_HCS_WINDOW"
  );
}
