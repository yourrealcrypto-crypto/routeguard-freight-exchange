/**
 * Mirror reconciliation for final-demo sequences 1–4 before payment.
 * Only Mirror-observed data becomes closure-proof evidence.
 */

import type { CommitmentEvidence } from "../domain/commitment-evidence";
import { reconcileMirrorMessages } from "../hcs/reconciliation";
import type {
  AuctionCloseBarrierEnvelope,
  BidCommitmentEnvelope,
  HcsEnvelope,
  ObservedHcsMessage,
} from "../hcs/types";
import {
  HISTORICAL_PHASE5_TOPIC_ID,
} from "./constants";
import { FinalDemoError } from "./errors";
import type { FinalDemoAuthoritativeMaterials } from "./materials";
import {
  assertBarrierAfterDeadline,
  assertCommitmentBeforeDeadline,
} from "./timing";

export type FinalDemoMirrorWindow = {
  topicId: string;
  runId: string;
  tenderId: string;
  tenderVersion: number;
  tenderHash: string;
  auctionEndsAt: string;
  messages: ObservedHcsMessage[];
  expectedCommitmentEnvelopeHashes: [string, string];
};

export type FinalDemoReconciliationResult = {
  topicId: string;
  reconciliationReference: string;
  evaluationTimestamp: string;
  closeBarrierConsensusTimestamp: string;
  closeBarrierSequence: 4;
  auctionEndsAt: string;
  open: ObservedHcsMessage;
  commitmentAlpha: ObservedHcsMessage;
  commitmentBeta: ObservedHcsMessage;
  barrier: ObservedHcsMessage;
  commitmentEvidence: CommitmentEvidence[];
  commitmentEnvelopeHashes: [string, string];
  barrierEnvelope: AuctionCloseBarrierEnvelope;
};

export function reconcileFinalDemoSequences1to4(
  input: FinalDemoMirrorWindow,
  materials: FinalDemoAuthoritativeMaterials,
): FinalDemoReconciliationResult {
  if (input.topicId === HISTORICAL_PHASE5_TOPIC_ID) {
    throw new FinalDemoError(
      "Historical Phase 5 topic cannot be reconciled as final-demo authority",
      "HISTORICAL_TOPIC_FORBIDDEN",
    );
  }
  if (input.topicId.startsWith("0.0.") === false) {
    throw new FinalDemoError("Invalid topic ID", "WRONG_TOPIC");
  }
  if (input.runId !== materials.runId) {
    throw new FinalDemoError("Run ID mismatch", "WRONG_RUN");
  }
  if (input.tenderId !== materials.identifiers.tenderId) {
    throw new FinalDemoError("Tender ID mismatch", "WRONG_TENDER");
  }
  if (input.tenderHash !== materials.tenderHash) {
    throw new FinalDemoError("Tender hash mismatch", "WRONG_TENDER");
  }

  // Exact type/order expectations before generic reconcile
  // Never pre-filter: validate the COMPLETE observation set.
  assertPristineTopicSequences1to4(input.messages, {
    topicId: input.topicId,
    runId: input.runId,
    tenderId: input.tenderId,
    tenderVersion: input.tenderVersion,
    tenderHash: input.tenderHash,
  });

  const bySeq = new Map(input.messages.map((m) => [m.sequence, m]));

  const open = bySeq.get(1)!;
  const cA = bySeq.get(2)!;
  const cB = bySeq.get(3)!;
  const barrier = bySeq.get(4)!;

  if (open.envelope.messageType !== "AUCTION_OPEN") {
    throw new FinalDemoError("Sequence 1 must be AUCTION_OPEN", "WRONG_MESSAGE_TYPE");
  }
  if (cA.envelope.messageType !== "BID_COMMITMENT") {
    throw new FinalDemoError("Sequence 2 must be BID_COMMITMENT", "WRONG_MESSAGE_TYPE");
  }
  if (cB.envelope.messageType !== "BID_COMMITMENT") {
    throw new FinalDemoError("Sequence 3 must be BID_COMMITMENT", "WRONG_MESSAGE_TYPE");
  }
  if (barrier.envelope.messageType !== "AUCTION_CLOSE_BARRIER") {
    throw new FinalDemoError(
      "Sequence 4 must be AUCTION_CLOSE_BARRIER",
      "WRONG_MESSAGE_TYPE",
    );
  }

  // Envelope hash binding to authoritative commitments
  if (cA.envelopeHash !== materials.commitmentEnvelopeHashes.alpha) {
    throw new FinalDemoError(
      "Commitment alpha envelope hash mismatch vs materials",
      "ENVELOPE_HASH_MISMATCH",
    );
  }
  if (cB.envelopeHash !== materials.commitmentEnvelopeHashes.beta) {
    throw new FinalDemoError(
      "Commitment beta envelope hash mismatch vs materials",
      "ENVELOPE_HASH_MISMATCH",
    );
  }
  if (open.envelopeHash !== materials.auctionOpenEnvelopeHash) {
    throw new FinalDemoError(
      "AUCTION_OPEN envelope hash mismatch vs materials",
      "ENVELOPE_HASH_MISMATCH",
    );
  }

  assertCommitmentBeforeDeadline(cA.consensusTimestamp, input.auctionEndsAt);
  assertCommitmentBeforeDeadline(cB.consensusTimestamp, input.auctionEndsAt);
  assertBarrierAfterDeadline(barrier.consensusTimestamp, input.auctionEndsAt);

  const barrierEnv = barrier.envelope as AuctionCloseBarrierEnvelope;
  const expectedHashes = [
    materials.commitmentEnvelopeHashes.alpha,
    materials.commitmentEnvelopeHashes.beta,
  ];
  if (
    barrierEnv.payload.expectedCommitmentCount !== 2 ||
    barrierEnv.payload.commitmentEnvelopeHashes.length !== 2 ||
    barrierEnv.payload.commitmentEnvelopeHashes[0] !== expectedHashes[0] ||
    barrierEnv.payload.commitmentEnvelopeHashes[1] !== expectedHashes[1] ||
    barrierEnv.payload.closePolicy !== "SAME_TOPIC_BARRIER_V1" ||
    barrierEnv.payload.tenderId !== materials.identifiers.tenderId ||
    barrierEnv.payload.tenderHash !== materials.tenderHash ||
    barrierEnv.payload.auctionEndsAt !== materials.auctionEndsAt
  ) {
    throw new FinalDemoError(
      "Close barrier payload does not bind authoritative commitments",
      "BARRIER_MISMATCH",
    );
  }

  // Use shared reconciliation for completeness/run/tender checks
  const reconciled = reconcileMirrorMessages({
    topicId: input.topicId,
    messages: [open, cA, cB, barrier],
    expectedRunId: materials.runId,
    expectedTenderId: materials.identifiers.tenderId,
    expectedTenderVersion: materials.tenderBody.version,
    expectedTenderHash: materials.tenderHash,
    expectedCommitmentCount: 2,
  });

  if (!reconciled.completeness.complete) {
    throw new FinalDemoError(
      "Mirror window incomplete after reconciliation",
      "SEQUENCE_GAP",
    );
  }

  const commitmentEvidence: CommitmentEvidence[] =
    reconciled.commitmentEvidence.map((e) => ({
      tenderId: e.tenderId,
      bidId: e.bidId,
      carrierId: e.carrierId,
      bidHash: e.bidHash,
      acceptanceReceiptHash: e.acceptanceReceiptHash,
      bidVersion: e.bidVersion,
      hcsSequence: e.hcsSequence,
      consensusTimestamp: e.consensusTimestamp,
    }));

  // Ensure evidence sequences match Mirror
  if (
    commitmentEvidence.length !== 2 ||
    commitmentEvidence[0]!.hcsSequence !== 2 ||
    commitmentEvidence[1]!.hcsSequence !== 3
  ) {
    throw new FinalDemoError(
      "Commitment evidence sequences must be 2 and 3",
      "WRONG_SEQUENCE",
    );
  }

  // Cross-check payload bid ids
  const pA = (cA.envelope as BidCommitmentEnvelope).payload;
  const pB = (cB.envelope as BidCommitmentEnvelope).payload;
  if (pA.bidId !== materials.identifiers.bidAlphaId) {
    throw new FinalDemoError("Alpha bid id mismatch on Mirror", "WRONG_BID");
  }
  if (pB.bidId !== materials.identifiers.bidBetaId) {
    throw new FinalDemoError("Beta bid id mismatch on Mirror", "WRONG_BID");
  }

  return {
    topicId: input.topicId,
    reconciliationReference: `mirror:topic:${input.topicId}:1-4`,
    evaluationTimestamp: barrier.consensusTimestamp,
    closeBarrierConsensusTimestamp: barrier.consensusTimestamp,
    closeBarrierSequence: 4,
    auctionEndsAt: input.auctionEndsAt,
    open,
    commitmentAlpha: cA,
    commitmentBeta: cB,
    barrier,
    commitmentEvidence,
    commitmentEnvelopeHashes: [
      materials.commitmentEnvelopeHashes.alpha,
      materials.commitmentEnvelopeHashes.beta,
    ],
    barrierEnvelope: barrierEnv,
  };
}

/**
 * Complete Mirror observation must be exactly sequences 1–4 before payment.
 * Never filter away unexpected messages — reject the full set.
 */
export function assertPristineTopicSequences1to4(
  messages: ObservedHcsMessage[],
  expected: {
    topicId: string;
    runId: string;
    tenderId: string;
    tenderVersion?: number;
    tenderHash?: string;
  },
): void {
  if (expected.topicId === HISTORICAL_PHASE5_TOPIC_ID) {
    throw new FinalDemoError(
      "Historical topic forbidden",
      "HISTORICAL_TOPIC_FORBIDDEN",
    );
  }
  if (messages.length !== 4) {
    throw new FinalDemoError(
      `Expected exactly 4 topic messages before payment, got ${messages.length}`,
      "UNEXPECTED_SEQUENCE",
    );
  }
  const bySeq = new Map<number, ObservedHcsMessage>();
  for (const m of messages) {
    if (m.topicId !== expected.topicId) {
      throw new FinalDemoError("Wrong topic on Mirror", "WRONG_TOPIC");
    }
    if (m.topicId === HISTORICAL_PHASE5_TOPIC_ID) {
      throw new FinalDemoError(
        "Historical topic forbidden",
        "HISTORICAL_TOPIC_FORBIDDEN",
      );
    }
    if (m.sequence < 1) {
      throw new FinalDemoError(
        `Invalid sequence ${m.sequence}`,
        "UNEXPECTED_SEQUENCE",
      );
    }
    if (m.sequence > 4) {
      throw new FinalDemoError(
        `Unexpected message sequence ${m.sequence} before payment`,
        "UNEXPECTED_SEQUENCE",
      );
    }
    if (bySeq.has(m.sequence)) {
      throw new FinalDemoError(
        `Duplicate sequence ${m.sequence}`,
        "DUPLICATE_SEQUENCE",
      );
    }
    bySeq.set(m.sequence, m);
    if (m.envelope.runId !== expected.runId) {
      throw new FinalDemoError("Wrong run on Mirror message", "WRONG_RUN");
    }
    if (m.envelope.tenderId !== expected.tenderId) {
      throw new FinalDemoError("Wrong tender on Mirror message", "WRONG_TENDER");
    }
    if (
      expected.tenderVersion !== undefined &&
      m.envelope.tenderVersion !== expected.tenderVersion
    ) {
      throw new FinalDemoError(
        "Wrong tender version on Mirror message",
        "WRONG_TENDER",
      );
    }
    if (
      expected.tenderHash !== undefined &&
      m.envelope.tenderHash !== expected.tenderHash
    ) {
      throw new FinalDemoError(
        "Wrong tender hash on Mirror message",
        "WRONG_TENDER",
      );
    }
    if (m.envelope.messageType === "ROUTE_RESERVED") {
      throw new FinalDemoError(
        "ROUTE_RESERVED before payment is forbidden",
        "UNEXPECTED_SEQUENCE",
      );
    }
  }
  for (let s = 1; s <= 4; s++) {
    if (!bySeq.has(s)) {
      throw new FinalDemoError(`Missing sequence ${s}`, "SEQUENCE_GAP");
    }
  }
  const max = Math.max(...messages.map((m) => m.sequence));
  if (max !== 4) {
    throw new FinalDemoError(
      `Highest sequence must be 4 before payment, got ${max}`,
      "TOPIC_SEQUENCE_UNEXPECTED",
    );
  }
  if (bySeq.get(1)!.envelope.messageType !== "AUCTION_OPEN") {
    throw new FinalDemoError("Sequence 1 must be AUCTION_OPEN", "WRONG_MESSAGE_TYPE");
  }
  if (bySeq.get(2)!.envelope.messageType !== "BID_COMMITMENT") {
    throw new FinalDemoError("Sequence 2 must be BID_COMMITMENT", "WRONG_MESSAGE_TYPE");
  }
  if (bySeq.get(3)!.envelope.messageType !== "BID_COMMITMENT") {
    throw new FinalDemoError("Sequence 3 must be BID_COMMITMENT", "WRONG_MESSAGE_TYPE");
  }
  if (bySeq.get(4)!.envelope.messageType !== "AUCTION_CLOSE_BARRIER") {
    throw new FinalDemoError(
      "Sequence 4 must be AUCTION_CLOSE_BARRIER",
      "WRONG_MESSAGE_TYPE",
    );
  }
}

/**
 * Pre-submit Mirror preflight: reject unexpected sequences / gaps / wrong types.
 */
export function assertMirrorReadyForSequence(
  messages: ObservedHcsMessage[],
  nextSequence: number,
  expected: {
    topicId: string;
    runId: string;
    tenderId: string;
  },
): void {
  if (expected.topicId === HISTORICAL_PHASE5_TOPIC_ID) {
    throw new FinalDemoError(
      "Historical topic forbidden",
      "HISTORICAL_TOPIC_FORBIDDEN",
    );
  }
  for (const m of messages) {
    if (m.topicId !== expected.topicId) {
      throw new FinalDemoError("Wrong topic on Mirror", "WRONG_TOPIC");
    }
    if (m.envelope.runId !== expected.runId) {
      throw new FinalDemoError("Wrong run on Mirror message", "WRONG_RUN");
    }
    if (m.envelope.tenderId !== expected.tenderId) {
      throw new FinalDemoError("Wrong tender on Mirror message", "WRONG_TENDER");
    }
  }
  const max = messages.reduce((a, m) => Math.max(a, m.sequence), 0);
  if (max !== nextSequence - 1) {
    throw new FinalDemoError(
      `Mirror max sequence ${max} does not permit next sequence ${nextSequence}`,
      "TOPIC_SEQUENCE_UNEXPECTED",
    );
  }
  for (let s = 1; s < nextSequence; s++) {
    if (!messages.some((m) => m.sequence === s)) {
      throw new FinalDemoError(`Gap at sequence ${s}`, "SEQUENCE_GAP");
    }
  }
  if (messages.some((m) => m.sequence >= nextSequence)) {
    throw new FinalDemoError(
      `Unexpected existing sequence >= ${nextSequence}`,
      "UNEXPECTED_SEQUENCE",
    );
  }
}

/** Convert UTC ISO with fractional seconds to Mirror-style seconds.nanos. */
export function utcIsoToMirrorTimestamp(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(
    iso,
  );
  if (!m) {
    // Fallback: epoch seconds only
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) {
      throw new FinalDemoError("Invalid consensus timestamp", "BAD_TIMESTAMP");
    }
    return `${Math.floor(ms / 1000)}.000000000`;
  }
  const ms = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
  const frac = (m[7] ?? "").padEnd(9, "0").slice(0, 9);
  return `${Math.floor(ms / 1000)}.${frac}`;
}

export function observedFromEnvelope(input: {
  topicId: string;
  sequence: number;
  envelope: HcsEnvelope;
  envelopeHash: string;
  consensusTimestamp: string;
  transactionId?: string;
}): ObservedHcsMessage {
  const base: ObservedHcsMessage = {
    topicId: input.topicId,
    sequence: input.sequence,
    consensusTimestamp: input.consensusTimestamp,
    mirrorConsensusTimestamp: utcIsoToMirrorTimestamp(input.consensusTimestamp),
    envelope: input.envelope,
    envelopeHash: input.envelopeHash,
  };
  if (input.transactionId !== undefined) {
    return { ...base, transactionId: input.transactionId };
  }
  return base;
}
