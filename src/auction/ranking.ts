import { compareCodePointStrings } from "../domain/canonical-hash";
import { parseUtcTimestamp } from "../domain/time";
import { isRankable } from "./eligibility";
import type { EligibilityResult } from "./types";

export type RankedBid = {
  bidId: string;
  carrierId: string;
  freightPriceCents: number;
  estimatedDelivery: string;
  consensusTimestamp: string;
  hcsSequence: number;
  bidHash: string;
};

/**
 * LOWEST_QUALIFIED_PRICE_V1
 *
 * 1. lowest freightPriceCents
 * 2. earliest estimatedDelivery (epoch nanoseconds)
 * 3. earliest commitment consensusTimestamp (epoch nanoseconds)
 * 4. lexicographically lowest bidId (explicit code-point < / >)
 */
export function compareRankedBids(a: RankedBid, b: RankedBid): number {
  if (a.freightPriceCents !== b.freightPriceCents) {
    return a.freightPriceCents - b.freightPriceCents;
  }

  const delA = parseUtcTimestamp(a.estimatedDelivery).epochNanoseconds;
  const delB = parseUtcTimestamp(b.estimatedDelivery).epochNanoseconds;
  if (delA < delB) return -1;
  if (delA > delB) return 1;

  const consA = parseUtcTimestamp(a.consensusTimestamp).epochNanoseconds;
  const consB = parseUtcTimestamp(b.consensusTimestamp).epochNanoseconds;
  if (consA < consB) return -1;
  if (consA > consB) return 1;

  return compareCodePointStrings(a.bidId, b.bidId);
}

export function rankQualifiedBids(
  results: readonly EligibilityResult[],
): RankedBid[] {
  const qualified: RankedBid[] = [];

  for (const result of results) {
    if (!isRankable(result)) {
      continue;
    }
    if (
      result.freightPriceCents === null ||
      result.estimatedDelivery === null ||
      result.bidHash === null
    ) {
      continue;
    }
    qualified.push({
      bidId: result.bidId,
      carrierId: result.carrierId,
      freightPriceCents: result.freightPriceCents,
      estimatedDelivery: result.estimatedDelivery,
      consensusTimestamp: result.consensusTimestamp,
      hcsSequence: result.hcsSequence,
      bidHash: result.bidHash,
    });
  }

  qualified.sort(compareRankedBids);
  return qualified;
}

export function selectWinner(
  results: readonly EligibilityResult[],
): RankedBid | null {
  const ranked = rankQualifiedBids(results);
  return ranked[0] ?? null;
}
