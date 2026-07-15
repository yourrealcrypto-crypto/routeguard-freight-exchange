/**
 * Auction window enforcement for final-demo commitments and close barrier.
 */

import { FinalDemoError } from "./errors";

export function assertCommitmentTimeRemaining(
  auctionEndsAt: string,
  nowMs: number = Date.now(),
  safetyMarginMs: number = 10_000,
): void {
  const ends = Date.parse(auctionEndsAt);
  if (Number.isNaN(ends)) {
    throw new FinalDemoError("Invalid auctionEndsAt", "BAD_TIMESTAMP");
  }
  if (nowMs + safetyMarginMs >= ends) {
    throw new FinalDemoError(
      "Insufficient time remaining before auctionEndsAt for commitment submit",
      "AUCTION_WINDOW_EXPIRED",
    );
  }
}

export function assertBarrierAfterAuctionEnd(
  auctionEndsAt: string,
  nowMs: number = Date.now(),
): void {
  const ends = Date.parse(auctionEndsAt);
  if (Number.isNaN(ends)) {
    throw new FinalDemoError("Invalid auctionEndsAt", "BAD_TIMESTAMP");
  }
  if (nowMs < ends) {
    throw new FinalDemoError(
      "Close barrier must not be submitted before auctionEndsAt",
      "BARRIER_BEFORE_DEADLINE",
    );
  }
}

export function assertCommitmentBeforeDeadline(
  consensusTimestamp: string,
  auctionEndsAt: string,
): void {
  // Nanosecond-capable lexicographic compare for UTC ISO strings works when
  // both use the same format; prefer Date.parse with ms precision.
  const c = Date.parse(consensusTimestamp);
  const e = Date.parse(auctionEndsAt);
  if (Number.isNaN(c) || Number.isNaN(e)) {
    throw new FinalDemoError("Invalid timestamp for deadline check", "BAD_TIMESTAMP");
  }
  // Equality at deadline is timely (handled in domain); here reject clear late.
  if (c > e) {
    throw new FinalDemoError(
      "Commitment consensus after auctionEndsAt",
      "LATE_COMMITMENT",
    );
  }
}

export function assertBarrierAfterDeadline(
  barrierConsensusTimestamp: string,
  auctionEndsAt: string,
): void {
  const b = Date.parse(barrierConsensusTimestamp);
  const e = Date.parse(auctionEndsAt);
  if (Number.isNaN(b) || Number.isNaN(e)) {
    throw new FinalDemoError("Invalid timestamp for barrier check", "BAD_TIMESTAMP");
  }
  if (b < e) {
    throw new FinalDemoError(
      "Barrier consensus before auctionEndsAt",
      "BARRIER_BEFORE_DEADLINE",
    );
  }
}

export function msUntil(
  targetIso: string,
  nowMs: number = Date.now(),
): number {
  const t = Date.parse(targetIso);
  if (Number.isNaN(t)) {
    throw new FinalDemoError("Invalid target timestamp", "BAD_TIMESTAMP");
  }
  return t - nowMs;
}
