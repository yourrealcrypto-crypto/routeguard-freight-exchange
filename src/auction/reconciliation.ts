import type { SignedAcceptanceReceipt } from "../domain/acceptance-receipt";
import type { SignedCarrierBid } from "../domain/bid";
import {
  parseCommitmentEvidence,
  type CommitmentEvidence,
} from "../domain/commitment-evidence";
import { compareCodePointStrings } from "../domain/canonical-hash";
import type { ReconciliationErrorCode } from "./types";

export class ReconciliationError extends Error {
  constructor(
    public readonly code: ReconciliationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ReconciliationError";
  }
}

export type ValidatedReconciliationSet = {
  commitments: CommitmentEvidence[];
  fullBids: ReadonlyMap<string, SignedCarrierBid>;
  acceptanceReceipts: ReadonlyMap<string, SignedAcceptanceReceipt>;
};

/**
 * Fail closed on structural ambiguity before any eligibility evaluation.
 * Does not silently overwrite Map entries.
 */
export function validateReconciliationInputs(input: {
  commitments: unknown[];
  fullBids: Iterable<[string, SignedCarrierBid]> | ReadonlyMap<string, SignedCarrierBid>;
  acceptanceReceipts:
    | Iterable<[string, SignedAcceptanceReceipt]>
    | ReadonlyMap<string, SignedAcceptanceReceipt>;
}): ValidatedReconciliationSet {
  const parsedCommitments: CommitmentEvidence[] = [];
  const seenSequences = new Set<number>();
  const seenBidIds = new Set<string>();
  const seenCommitmentKeys = new Set<string>();

  for (const raw of input.commitments) {
    let commitment: CommitmentEvidence;
    try {
      commitment = parseCommitmentEvidence(raw);
    } catch (error: unknown) {
      throw new ReconciliationError(
        "INVALID_CLOSURE_PROOF",
        `Invalid commitment schema: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (seenSequences.has(commitment.hcsSequence)) {
      throw new ReconciliationError(
        "DUPLICATE_HCS_SEQUENCE",
        `Duplicate HCS sequence: ${commitment.hcsSequence}`,
      );
    }
    seenSequences.add(commitment.hcsSequence);

    if (seenBidIds.has(commitment.bidId)) {
      throw new ReconciliationError(
        "DUPLICATE_BID_ID",
        `Duplicate commitment bidId: ${commitment.bidId}`,
      );
    }
    seenBidIds.add(commitment.bidId);

    const identityKey = [
      commitment.tenderId,
      commitment.bidId,
      commitment.carrierId,
      commitment.bidHash,
      commitment.acceptanceReceiptHash,
      String(commitment.bidVersion),
      String(commitment.hcsSequence),
      commitment.consensusTimestamp,
    ].join("|");
    if (seenCommitmentKeys.has(identityKey)) {
      throw new ReconciliationError(
        "DUPLICATE_COMMITMENT",
        `Repeated commitment identity for bidId ${commitment.bidId}`,
      );
    }
    seenCommitmentKeys.add(identityKey);

    parsedCommitments.push(commitment);
  }

  // Sort deterministically for downstream use.
  parsedCommitments.sort((a, b) => {
    if (a.hcsSequence !== b.hcsSequence) {
      return a.hcsSequence - b.hcsSequence;
    }
    return compareCodePointStrings(a.bidId, b.bidId);
  });

  const fullBidEntries =
    input.fullBids instanceof Map
      ? [...input.fullBids.entries()]
      : [...input.fullBids];
  const fullBids = new Map<string, SignedCarrierBid>();
  const seenFullBidObjects = new WeakSet<object>();

  for (const [bidId, signed] of fullBidEntries) {
    if (fullBids.has(bidId)) {
      throw new ReconciliationError(
        "DUPLICATE_FULL_BID",
        `Duplicate full bid for bidId: ${bidId}`,
      );
    }
    if (typeof signed === "object" && signed !== null) {
      if (seenFullBidObjects.has(signed as object)) {
        throw new ReconciliationError(
          "AMBIGUOUS_BID_ASSIGNMENT",
          "One private bid object assigned to multiple map entries",
        );
      }
      seenFullBidObjects.add(signed as object);
    }
    // Enforce key consistency
    if (signed.bid.bidId !== bidId) {
      throw new ReconciliationError(
        "AMBIGUOUS_BID_ASSIGNMENT",
        `Full bid map key ${bidId} does not match bid.bidId ${signed.bid.bidId}`,
      );
    }
    fullBids.set(bidId, signed);
  }

  // One private bid must not satisfy two different commitments (same bidId is already unique;
  // also reject if the same bid content hash is reused across different commitment bidIds —
  // covered by bidId uniqueness on commitments).
  // Detect shared SignedCarrierBid reference across different bidIds (already WeakSet).

  const receiptEntries =
    input.acceptanceReceipts instanceof Map
      ? [...input.acceptanceReceipts.entries()]
      : [...input.acceptanceReceipts];
  const acceptanceReceipts = new Map<string, SignedAcceptanceReceipt>();

  for (const [bidId, receipt] of receiptEntries) {
    if (acceptanceReceipts.has(bidId)) {
      throw new ReconciliationError(
        "DUPLICATE_ACCEPTANCE_RECEIPT",
        `Duplicate acceptance receipt for bidId: ${bidId}`,
      );
    }
    if (receipt.receipt.bidId !== bidId) {
      throw new ReconciliationError(
        "AMBIGUOUS_BID_ASSIGNMENT",
        `Receipt map key ${bidId} does not match receipt.bidId ${receipt.receipt.bidId}`,
      );
    }
    acceptanceReceipts.set(bidId, receipt);
  }

  return {
    commitments: parsedCommitments,
    fullBids,
    acceptanceReceipts,
  };
}

/**
 * Sequence range completeness: every integer from start to end inclusive
 * must appear exactly once in observedSequences.
 */
export function isSequenceRangeComplete(
  start: number,
  end: number,
  observedSequences: readonly number[],
): boolean {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 1 ||
    end < start
  ) {
    return false;
  }
  const expected = end - start + 1;
  if (observedSequences.length !== expected) {
    return false;
  }
  const set = new Set(observedSequences);
  if (set.size !== expected) {
    return false;
  }
  for (let s = start; s <= end; s++) {
    if (!set.has(s)) {
      return false;
    }
  }
  return true;
}
