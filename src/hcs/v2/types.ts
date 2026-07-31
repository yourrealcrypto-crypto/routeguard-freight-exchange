/**
 * RouteGuard HCS 2.0 public-safe evidence message types.
 * Schema: routeguard-hcs-2.0 — no network submission in Phase A2.
 */

export const HCS_V2_SCHEMA_VERSION = "routeguard-hcs-2.0" as const;
export const HCS_V2_MAX_MESSAGE_BYTES = 1024 as const;

export const HCS_V2_MESSAGE_TYPES = [
  "TENDER_OPENED",
  "BID_COMMITMENT",
  "AUCTION_CLOSE_BARRIER",
  "WINNER_SELECTED",
  "WINNER_ALLOCATED",
  "ROUTE_RESERVED",
  "POD_SUBMITTED",
  "POD_ADVISORY_ANCHORED",
  "POD_REVIEW_ACTION",
  "POD_DEEMED_ACCEPTED",
  "DISPUTE_OPENED",
  "REFEREE_RESOLUTION",
  "ESCROW_RELEASED",
  "ESCROW_PARTIAL",
  "ESCROW_REFUNDED",
  "TENDER_COMPLETED",
] as const;

export type HcsV2MessageType = (typeof HCS_V2_MESSAGE_TYPES)[number];

export type HcsV2EnvelopeBase = {
  readonly schemaVersion: typeof HCS_V2_SCHEMA_VERSION;
  readonly messageType: HcsV2MessageType;
  readonly tenderId: string;
  readonly tenderVersion: number;
  readonly tenderHash: string;
  readonly createdAt: string;
  readonly payloadHash: string;
};

export type TenderOpenedPayload = {
  readonly accessPaymentTxId: string;
  readonly maxBudgetAtomic: string;
  readonly auctionEndsAt: string;
  readonly selectionPolicy: "LOWEST_QUALIFIED_PRICE_V1";
};

export type BidCommitmentPayloadV2 = {
  readonly bidId: string;
  readonly carrierId: string;
  readonly bidHash: string;
  readonly accessPaymentTxId: string;
};

export type AuctionCloseBarrierPayloadV2 = {
  readonly barrierId: string;
  readonly auctionEndsAt: string;
  readonly expectedCommitmentCount: number;
  readonly bidSetHash: string;
};

export type WinnerSelectedPayload = {
  readonly winningBidId: string;
  readonly carrierId: string;
  readonly winningAmountAtomic: string;
  readonly decisionManifestHash: string;
};

export type WinnerAllocatedPayload = {
  readonly winningBidId: string;
  readonly winnerAccount: string;
  readonly winningAmountAtomic: string;
  readonly excessRefundAtomic: string;
  readonly allocateTxId: string;
  readonly refundTxId: string | null;
  readonly decisionManifestHash: string;
};

export type RouteReservedPayloadV2 = {
  readonly reservationId: string;
  readonly winningBidId: string;
  readonly carrierAccount: string;
  readonly lockedAmountAtomic: string;
  readonly allocateTxId: string;
  readonly reservationRecordHash: string;
};

export type PodSubmittedPayload = {
  readonly podId: string;
  readonly contentHash: string;
  readonly ciphertextHash: string;
  readonly sizeBytes: number;
};

export type PodAdvisoryAnchoredPayload = {
  readonly podId: string;
  readonly reportHash: string;
  readonly binding: "NON_BINDING_ADVISORY";
};

export type PodReviewActionPayload = {
  readonly podId: string;
  readonly action: "ACCEPT" | "REQUEST_CORRECTION" | "REJECT_DISPUTE";
  readonly reviewDeadlineAt: string;
};

export type PodDeemedAcceptedPayload = {
  readonly podId: string;
  readonly reviewDeadlineAt: string;
  readonly tickActionId: string;
};

export type DisputeOpenedPayload = {
  readonly disputeId: string;
  readonly podId: string;
  readonly reasonCode: string;
};

export type RefereeResolutionPayload = {
  readonly disputeId: string;
  readonly podId: string;
  readonly resolution: "RELEASE_FULL" | "REFUND_FULL" | "PARTIAL";
  readonly releaseAmountAtomic: string;
  readonly refundAmountAtomic: string;
  readonly resolutionHash: string;
};

export type EscrowReleasedPayload = {
  readonly releaseTxId: string;
  readonly amountAtomic: string;
  readonly winnerAccount: string;
};

export type EscrowPartialPayload = {
  readonly releaseTxId: string;
  readonly refundTxId: string;
  readonly releaseAmountAtomic: string;
  readonly refundAmountAtomic: string;
};

export type EscrowRefundedPayload = {
  readonly refundTxId: string;
  readonly amountAtomic: string;
  readonly shipperAccount: string;
};

export type TenderCompletedPayload = {
  readonly finalState:
    | "PAYMENT_RELEASED"
    | "PARTIAL_RELEASE"
    | "REFUNDED"
    | "TENDER_COMPLETED";
  readonly completionRef: string;
};

export type HcsV2Payload =
  | TenderOpenedPayload
  | BidCommitmentPayloadV2
  | AuctionCloseBarrierPayloadV2
  | WinnerSelectedPayload
  | WinnerAllocatedPayload
  | RouteReservedPayloadV2
  | PodSubmittedPayload
  | PodAdvisoryAnchoredPayload
  | PodReviewActionPayload
  | PodDeemedAcceptedPayload
  | DisputeOpenedPayload
  | RefereeResolutionPayload
  | EscrowReleasedPayload
  | EscrowPartialPayload
  | EscrowRefundedPayload
  | TenderCompletedPayload;

export type HcsV2Envelope = HcsV2EnvelopeBase & {
  readonly payload: HcsV2Payload;
};
