/**
 * RouteGuard HCS auction evidence types (Phase 5).
 * Public-only identifiers, hashes, and policy references — never private bids.
 */

import type { CommitmentEvidence } from "../domain/commitment-evidence";

export const HCS_SCHEMA_VERSION = "routeguard-hcs-1.0" as const;
export const COMMITMENT_SCHEMA_VERSION = "routeguard-bid-commitment-1.0" as const;
export const CLOSE_POLICY = "SAME_TOPIC_BARRIER_V1" as const;

/** Hedera HCS message body hard limit (bytes). */
export const HCS_MAX_MESSAGE_BYTES = 1024 as const;

export const HCS_MESSAGE_TYPES = [
  "AUCTION_OPEN",
  "BID_COMMITMENT",
  "AUCTION_CLOSE_BARRIER",
  "ROUTE_RESERVED",
] as const;

export type HcsMessageType = (typeof HCS_MESSAGE_TYPES)[number];

/** Public reservation-evidence schema version tag (kept short for byte budget). */
export const ROUTE_RESERVED_EVIDENCE_VERSION = "rg-res-ev-1" as const;
/** Reservation payment network literal. */
export const RESERVATION_PAYMENT_NETWORK = "hedera:testnet" as const;

export type AuctionOpenPayload = {
  tenderId: string;
  tenderVersion: number;
  tenderHash: string;
  auctionEndsAt: string;
  selectionPolicy: "LOWEST_QUALIFIED_PRICE_V1";
  engineVersion: "routeguard-auction-1.0";
  rulesHash: string;
};

export type BidCommitmentPayload = {
  bidId: string;
  carrierId: string;
  bidHash: string;
  acceptanceReceiptHash: string;
  bidVersion: number;
  commitmentSchemaVersion: typeof COMMITMENT_SCHEMA_VERSION;
};

export type AuctionCloseBarrierPayload = {
  barrierId: string;
  tenderId: string;
  tenderVersion: number;
  tenderHash: string;
  auctionEndsAt: string;
  expectedCommitmentCount: number;
  commitmentEnvelopeHashes: string[];
  closePolicy: typeof CLOSE_POLICY;
};

/**
 * Public ROUTE_RESERVED evidence payload. Compact public-only fields that fit a
 * single standard HCS message. `reservationRecordHash` is the master commitment
 * to the full RouteReservedRecord (which binds tenderHash, winningBidHash,
 * decisionManifestHash, evaluatedBidSetHash and every payment field), so the
 * dropped hashes remain cryptographically committed. tenderId/tenderVersion are
 * carried in the envelope shell. Never carries private bid/price/salt/signature
 * data.
 */
export type RouteReservedPayload = {
  reservationId: string;
  winningBidId: string;
  carrierId: string;
  carrierAccount: string;
  selectedOptionId: "USDC" | "HBAR";
  paymentAsset: string;
  paymentAmountAtomic: string;
  payerAccount: string;
  paymentTransactionId: string;
  paymentConsensusTimestamp: string;
  reservationRecordHash: string;
  closeBarrierSequence: number;
  reservationEvidenceVersion: typeof ROUTE_RESERVED_EVIDENCE_VERSION;
};

export type HcsPayload =
  | AuctionOpenPayload
  | BidCommitmentPayload
  | AuctionCloseBarrierPayload
  | RouteReservedPayload;

export type HcsEnvelopeBase = {
  schemaVersion: typeof HCS_SCHEMA_VERSION;
  messageType: HcsMessageType;
  runId: string;
  tenderId: string;
  tenderVersion: number;
  tenderHash: string;
  createdAt: string;
  payloadHash: string;
};

export type AuctionOpenEnvelope = HcsEnvelopeBase & {
  messageType: "AUCTION_OPEN";
  payload: AuctionOpenPayload;
};

export type BidCommitmentEnvelope = HcsEnvelopeBase & {
  messageType: "BID_COMMITMENT";
  payload: BidCommitmentPayload;
};

export type AuctionCloseBarrierEnvelope = HcsEnvelopeBase & {
  messageType: "AUCTION_CLOSE_BARRIER";
  payload: AuctionCloseBarrierPayload;
};

export type RouteReservedEnvelope = HcsEnvelopeBase & {
  messageType: "ROUTE_RESERVED";
  payload: RouteReservedPayload;
};

export type HcsEnvelope =
  | AuctionOpenEnvelope
  | BidCommitmentEnvelope
  | AuctionCloseBarrierEnvelope
  | RouteReservedEnvelope;

/** Mirror-authoritative observation of one HCS message. */
export type ObservedHcsMessage = {
  topicId: string;
  sequence: number;
  /** UTC ISO-8601 with nanosecond fraction (converted from Mirror). */
  consensusTimestamp: string;
  /** Raw Mirror consensus_timestamp (seconds.nanos). */
  mirrorConsensusTimestamp: string;
  envelope: HcsEnvelope;
  /** canonicalSha256 of the decoded envelope. */
  envelopeHash: string;
  transactionId?: string;
};

export type CompletenessResult = {
  complete: boolean;
  startSequence: number;
  endSequence: number;
  observedSequences: number[];
  missingSequences: number[];
  duplicateSequences: number[];
};

export type MirrorReconciliationResult = {
  runId: string;
  tenderId: string;
  tenderVersion: number;
  tenderHash: string;
  topicId: string;
  open: ObservedHcsMessage;
  commitments: ObservedHcsMessage[];
  barrier: ObservedHcsMessage;
  completeness: CompletenessResult;
  commitmentEvidence: CommitmentEvidence[];
  commitmentEnvelopeHashes: string[];
  auctionEndsAt: string;
  evaluationTimestamp: string;
};

export const ATTEMPT_STATUSES = [
  "PLANNED",
  "TOPIC_CREATED",
  "OPEN_SUBMITTED",
  "COMMITMENT_A_SUBMITTED",
  "COMMITMENT_B_SUBMITTED",
  "BARRIER_SUBMITTED",
  "MIRROR_RECONCILED",
  "AUCTION_EVALUATED",
  "SUCCESS",
  "FAILED",
] as const;

export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export type MessageAttemptRecord = {
  messageType: HcsMessageType;
  label: string;
  transactionId: string | null;
  sequence: number | null;
  consensusTimestamp: string | null;
  envelopeHash: string | null;
  submittedAt: string | null;
};

export type HcsAttemptRecord = {
  runId: string;
  status: AttemptStatus;
  network: "hedera:testnet";
  plannedTenderId: string;
  plannedTenderHash: string;
  plannedAuctionEndsAt: string | null;
  approvedWriteBudget: {
    topicCreates: 1;
    messageSubmits: 4;
  };
  topicId: string | null;
  topicCreateTransactionId: string | null;
  topicMemo: string | null;
  messages: {
    open: MessageAttemptRecord | null;
    commitmentA: MessageAttemptRecord | null;
    commitmentB: MessageAttemptRecord | null;
    barrier: MessageAttemptRecord | null;
  };
  finalResult: string | null;
  error: string | null;
  updatedAt: string;
  createdAt: string;
};

export const HCS_DEMO_OPERATOR_ACCOUNT = "0.0.9197513" as const;
export const HCS_DEMO_OPERATOR_PUBLIC_KEY =
  "02c07aaa7bc004c9c44186395f496639cf46741b6bc8092c024156e5ac68d5fde5" as const;
export const HCS_DEMO_CARRIER_PAYMENT_ACCOUNT = "0.0.9215954" as const;

export const CONFIRM_HCS_DEMO_WRITE_VALUE = "ONE_TOPIC_FOUR_MESSAGES" as const;

export const HEDERA_TESTNET_MIRROR_NODE =
  "https://testnet.mirrornode.hedera.com" as const;
