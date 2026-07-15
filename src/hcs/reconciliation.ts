/**
 * Mirror Node HCS window reconciliation → Phase 4 CommitmentEvidence.
 */

import {
  parseCommitmentEvidence,
  type CommitmentEvidence,
} from "../domain/commitment-evidence";
import { isAfterUtc, isBeforeOrEqualUtc, isBeforeUtc } from "../domain/time";
import { isSequenceRangeComplete } from "../auction/reconciliation";
import type {
  AuctionCloseBarrierEnvelope,
  AuctionOpenEnvelope,
  BidCommitmentEnvelope,
  CompletenessResult,
  MirrorReconciliationResult,
  ObservedHcsMessage,
} from "./types";

export class HcsReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HcsReconciliationError";
  }
}

export function computeCompleteness(
  start: number,
  end: number,
  sequences: readonly number[],
): CompletenessResult {
  const observedSequences = [...sequences].sort((a, b) => a - b);
  const set = new Set(observedSequences);
  const missingSequences: number[] = [];
  const duplicateSequences: number[] = [];
  const counts = new Map<number, number>();
  for (const s of observedSequences) {
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  for (const [s, c] of counts) {
    if (c > 1) duplicateSequences.push(s);
  }
  if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start) {
    for (let s = start; s <= end; s++) {
      if (!set.has(s)) missingSequences.push(s);
    }
  }
  const complete =
    isSequenceRangeComplete(start, end, observedSequences) &&
    duplicateSequences.length === 0;
  return {
    complete,
    startSequence: start,
    endSequence: end,
    observedSequences,
    missingSequences,
    duplicateSequences,
  };
}

/**
 * Reconcile raw observed messages for a dedicated single-run topic.
 * Input order does not affect the result (sorted by sequence).
 */
export function reconcileMirrorMessages(input: {
  topicId: string;
  messages: ObservedHcsMessage[];
  expectedRunId: string;
  expectedTenderId: string;
  expectedTenderVersion: number;
  expectedTenderHash: string;
  expectedCommitmentCount?: number;
}): MirrorReconciliationResult {
  const expectedCommitmentCount = input.expectedCommitmentCount ?? 2;

  if (input.messages.length === 0) {
    throw new HcsReconciliationError("No HCS messages to reconcile");
  }

  // Fail on duplicate sequences or duplicate envelope hashes.
  const bySequence = new Map<number, ObservedHcsMessage>();
  const envelopeHashes = new Set<string>();

  for (const msg of input.messages) {
    if (msg.topicId !== input.topicId) {
      throw new HcsReconciliationError(
        `Message sequence ${msg.sequence} is on topic ${msg.topicId}, expected ${input.topicId}`,
      );
    }
    if (msg.sequence < 1) {
      throw new HcsReconciliationError(
        `Sequence zero/negative rejected: ${msg.sequence}`,
      );
    }
    if (bySequence.has(msg.sequence)) {
      throw new HcsReconciliationError(
        `Duplicate sequence ${msg.sequence}`,
      );
    }
    if (envelopeHashes.has(msg.envelopeHash)) {
      throw new HcsReconciliationError(
        `Duplicate envelope hash ${msg.envelopeHash}`,
      );
    }
    bySequence.set(msg.sequence, msg);
    envelopeHashes.add(msg.envelopeHash);
  }

  const ordered = [...bySequence.values()].sort(
    (a, b) => a.sequence - b.sequence,
  );

  // Monotonic consensus timestamps.
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const cur = ordered[i]!;
    if (!isBeforeOrEqualUtc(prev.consensusTimestamp, cur.consensusTimestamp)) {
      // Strict: later sequence must not have earlier consensus time.
      if (isBeforeUtc(cur.consensusTimestamp, prev.consensusTimestamp)) {
        throw new HcsReconciliationError(
          `Non-monotonic consensus timestamps at sequences ${prev.sequence} → ${cur.sequence}`,
        );
      }
    }
  }

  // Identity binding on every message.
  for (const msg of ordered) {
    const e = msg.envelope;
    if (e.runId !== input.expectedRunId) {
      throw new HcsReconciliationError(
        `runId mismatch at sequence ${msg.sequence}: ${e.runId}`,
      );
    }
    if (e.tenderId !== input.expectedTenderId) {
      throw new HcsReconciliationError(
        `tenderId mismatch at sequence ${msg.sequence}`,
      );
    }
    if (e.tenderVersion !== input.expectedTenderVersion) {
      throw new HcsReconciliationError(
        `tenderVersion mismatch at sequence ${msg.sequence}`,
      );
    }
    if (e.tenderHash !== input.expectedTenderHash) {
      throw new HcsReconciliationError(
        `tenderHash mismatch at sequence ${msg.sequence}`,
      );
    }
  }

  const barriers = ordered.filter(
    (m) => m.envelope.messageType === "AUCTION_CLOSE_BARRIER",
  );
  if (barriers.length !== 1) {
    throw new HcsReconciliationError(
      `Expected exactly one AUCTION_CLOSE_BARRIER, found ${barriers.length}`,
    );
  }
  const barrier = barriers[0]!;
  const barrierEnvelope = barrier.envelope as AuctionCloseBarrierEnvelope;

  const opens = ordered.filter(
    (m) => m.envelope.messageType === "AUCTION_OPEN",
  );
  if (opens.length !== 1) {
    throw new HcsReconciliationError(
      `Expected exactly one AUCTION_OPEN, found ${opens.length}`,
    );
  }
  const open = opens[0]!;
  const openEnvelope = open.envelope as AuctionOpenEnvelope;

  // Window: sequences 1 through barrier inclusive.
  if (ordered[0]!.sequence !== 1) {
    throw new HcsReconciliationError(
      `First observed sequence must be 1, got ${ordered[0]!.sequence}`,
    );
  }

  const windowMessages = ordered.filter((m) => m.sequence <= barrier.sequence);
  const sequences = windowMessages.map((m) => m.sequence);
  const completeness = computeCompleteness(1, barrier.sequence, sequences);
  if (!completeness.complete) {
    throw new HcsReconciliationError(
      `Incomplete sequence range 1..${barrier.sequence}: missing=[${completeness.missingSequences.join(",")}] duplicates=[${completeness.duplicateSequences.join(",")}]`,
    );
  }

  // Reject messages after barrier from commitment set; for dedicated topic
  // we require no post-barrier messages in the observed set for this run.
  const postBarrier = ordered.filter((m) => m.sequence > barrier.sequence);
  if (postBarrier.length > 0) {
    throw new HcsReconciliationError(
      `Unexpected messages after close barrier (sequences ${postBarrier.map((m) => m.sequence).join(",")})`,
    );
  }

  const commitmentMsgs = windowMessages.filter(
    (m) => m.envelope.messageType === "BID_COMMITMENT",
  );
  if (commitmentMsgs.length !== expectedCommitmentCount) {
    throw new HcsReconciliationError(
      `Expected ${expectedCommitmentCount} BID_COMMITMENT messages before barrier, found ${commitmentMsgs.length}`,
    );
  }

  // Commitments must precede barrier sequence (already filtered) and open.
  for (const c of commitmentMsgs) {
    if (c.sequence <= open.sequence) {
      throw new HcsReconciliationError(
        `Commitment sequence ${c.sequence} must be after OPEN sequence ${open.sequence}`,
      );
    }
    if (c.sequence >= barrier.sequence) {
      throw new HcsReconciliationError(
        `Commitment sequence ${c.sequence} must be before barrier sequence ${barrier.sequence}`,
      );
    }
  }

  if (open.sequence >= barrier.sequence) {
    throw new HcsReconciliationError("OPEN must precede barrier");
  }

  // Barrier before commitments rejected (covered by sequence order + count).
  const lastCommitmentSeq = Math.max(...commitmentMsgs.map((c) => c.sequence));
  if (barrier.sequence <= lastCommitmentSeq) {
    throw new HcsReconciliationError(
      "Barrier sequence must be after all commitments",
    );
  }

  const auctionEndsAt = openEnvelope.payload.auctionEndsAt;
  if (barrierEnvelope.payload.auctionEndsAt !== auctionEndsAt) {
    throw new HcsReconciliationError(
      "Barrier auctionEndsAt does not match OPEN auctionEndsAt",
    );
  }

  // Barrier consensus timestamp must be after auctionEndsAt (strict after).
  if (!isAfterUtc(barrier.consensusTimestamp, auctionEndsAt)) {
    // equality is also invalid — barrier must be after deadline
    if (isBeforeOrEqualUtc(barrier.consensusTimestamp, auctionEndsAt)) {
      throw new HcsReconciliationError(
        `Barrier consensus timestamp ${barrier.consensusTimestamp} is not after auctionEndsAt ${auctionEndsAt}`,
      );
    }
  }

  if (
    barrierEnvelope.payload.expectedCommitmentCount !== expectedCommitmentCount
  ) {
    throw new HcsReconciliationError(
      `Barrier expectedCommitmentCount ${barrierEnvelope.payload.expectedCommitmentCount} !== ${expectedCommitmentCount}`,
    );
  }

  // commitmentEnvelopeHashes in expected submission order (sequence order).
  const commitmentEnvelopeHashes = commitmentMsgs
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map((m) => m.envelopeHash);

  const barrierHashes = barrierEnvelope.payload.commitmentEnvelopeHashes;
  if (barrierHashes.length !== commitmentEnvelopeHashes.length) {
    throw new HcsReconciliationError(
      "Barrier commitmentEnvelopeHashes length mismatch",
    );
  }
  for (let i = 0; i < barrierHashes.length; i++) {
    if (barrierHashes[i] !== commitmentEnvelopeHashes[i]) {
      throw new HcsReconciliationError(
        `Barrier commitmentEnvelopeHashes[${i}] mismatch: barrier has ${barrierHashes[i]}, observed ${commitmentEnvelopeHashes[i]}`,
      );
    }
  }

  if (barrierEnvelope.payload.tenderId !== input.expectedTenderId) {
    throw new HcsReconciliationError("Barrier tenderId mismatch");
  }
  if (barrierEnvelope.payload.tenderVersion !== input.expectedTenderVersion) {
    throw new HcsReconciliationError("Barrier tenderVersion mismatch");
  }
  if (barrierEnvelope.payload.tenderHash !== input.expectedTenderHash) {
    throw new HcsReconciliationError("Barrier tenderHash mismatch");
  }

  const commitmentEvidence: CommitmentEvidence[] = commitmentMsgs
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map((m) => {
      const p = (m.envelope as BidCommitmentEnvelope).payload;
      return parseCommitmentEvidence({
        tenderId: m.envelope.tenderId,
        bidId: p.bidId,
        carrierId: p.carrierId,
        bidHash: p.bidHash,
        acceptanceReceiptHash: p.acceptanceReceiptHash,
        bidVersion: p.bidVersion,
        hcsSequence: m.sequence,
        consensusTimestamp: m.consensusTimestamp,
      });
    });

  return {
    runId: input.expectedRunId,
    tenderId: input.expectedTenderId,
    tenderVersion: input.expectedTenderVersion,
    tenderHash: input.expectedTenderHash,
    topicId: input.topicId,
    open,
    commitments: commitmentMsgs
      .slice()
      .sort((a, b) => a.sequence - b.sequence),
    barrier,
    completeness,
    commitmentEvidence,
    commitmentEnvelopeHashes,
    auctionEndsAt,
    evaluationTimestamp: barrier.consensusTimestamp,
  };
}
