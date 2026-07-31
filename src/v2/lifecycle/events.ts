/**
 * Typed lifecycle events. All time, ids, and confirmations are explicit inputs.
 */

import type { AccessActionType } from "../access/fee";

export const LIFECYCLE_EVENT_TYPES = [
  "ESCROW_FUNDING_CONFIRMED",
  "TENDER_ACTIVATION_PAID",
  "BIDDING_STARTED",
  "AUCTION_CLOSE_CONFIRMED",
  "NO_QUALIFIED_BID_CONFIRMED",
  "WINNER_SELECTION_CONFIRMED",
  "WINNING_AMOUNT_ALLOCATION_CONFIRMED",
  "ROUTE_RESERVATION_PUBLISHED",
  "TRANSIT_STARTED",
  "DELIVERY_REPORTED",
  "POD_PACKAGE_SUBMITTED",
  "POD_REVIEW_STARTED",
  "POD_CORRECTION_REQUESTED",
  "POD_PACKAGE_RESUBMITTED",
  "POD_ACCEPTED_BY_SHIPPER",
  "POD_REVIEW_DEADLINE_EXPIRED",
  "POD_CORRECTION_DEADLINE_EXPIRED",
  "POD_REJECTED_TO_DISPUTE",
  "REFEREE_RESOLUTION_RECORDED",
  "ESCROW_RELEASE_CONFIRMED",
  "ESCROW_PARTIAL_RELEASE_CONFIRMED",
  "ESCROW_REFUND_CONFIRMED",
  "TENDER_COMPLETION_CONFIRMED",
  /** Non-authorizing advisory anchor — must never move settlement states. */
  "POD_ADVISORY_ANCHORED",
] as const;

export type LifecycleEventType = (typeof LIFECYCLE_EVENT_TYPES)[number];

export type LifecycleEventBase = {
  readonly type: LifecycleEventType;
  /** Unique action id for idempotency. */
  readonly actionId: string;
  /** Event time (UTC ISO) — sole clock for the transition. */
  readonly eventTime: string;
};

export type EscrowFundingConfirmed = LifecycleEventBase & {
  readonly type: "ESCROW_FUNDING_CONFIRMED";
  readonly fundingTxId: string;
  readonly tokenId: string;
  readonly fundedAmountAtomic: string;
  readonly tenderId: string;
  readonly tenderVersion: number;
};

export type TenderActivationPaid = LifecycleEventBase & {
  readonly type: "TENDER_ACTIVATION_PAID";
  readonly accessActionType: AccessActionType;
  readonly asset: string;
  readonly amountAtomic: string;
  readonly resource: string;
  readonly paymentTransactionId: string;
  readonly paymentPayloadHash: string;
  readonly payerAccount: string;
  readonly payTo: string;
};

export type BiddingStarted = LifecycleEventBase & {
  readonly type: "BIDDING_STARTED";
};

export type AuctionCloseConfirmed = LifecycleEventBase & {
  readonly type: "AUCTION_CLOSE_CONFIRMED";
  readonly auctionEndsAt: string;
  readonly closureProofRef: string;
  readonly authoritativeBidSetHash: string;
};

export type NoQualifiedBidConfirmed = LifecycleEventBase & {
  readonly type: "NO_QUALIFIED_BID_CONFIRMED";
  readonly decisionManifestHash: string;
};

export type WinnerSelectionConfirmed = LifecycleEventBase & {
  readonly type: "WINNER_SELECTION_CONFIRMED";
  readonly decisionManifestHash: string;
  readonly winningBidId: string;
  readonly winningCarrierId: string;
  readonly winningCarrierAccount: string;
  readonly winningAmountAtomic: string;
  readonly selectionPolicy: "LOWEST_QUALIFIED_PRICE_V1";
};

export type WinningAmountAllocationConfirmed = LifecycleEventBase & {
  readonly type: "WINNING_AMOUNT_ALLOCATION_CONFIRMED";
  readonly allocateTxId: string;
  readonly refundExcessTxId: string | null;
  readonly maxBudgetAtomic: string;
  readonly winningAmountAtomic: string;
  readonly excessRefundAtomic: string;
  readonly decisionManifestHash: string;
};

export type RouteReservationPublished = LifecycleEventBase & {
  readonly type: "ROUTE_RESERVATION_PUBLISHED";
  readonly reservationEvidenceRef: string;
  readonly hcsPublicationRef: string;
};

export type TransitStarted = LifecycleEventBase & {
  readonly type: "TRANSIT_STARTED";
};

export type DeliveryReported = LifecycleEventBase & {
  readonly type: "DELIVERY_REPORTED";
};

export type PodPackageSubmitted = LifecycleEventBase & {
  readonly type: "POD_PACKAGE_SUBMITTED";
  readonly podId: string;
  readonly contentHash: string;
  readonly ciphertextHash: string;
};

export type PodReviewStarted = LifecycleEventBase & {
  readonly type: "POD_REVIEW_STARTED";
};

export type PodCorrectionRequested = LifecycleEventBase & {
  readonly type: "POD_CORRECTION_REQUESTED";
  readonly reasons: readonly { code: string; message: string }[];
  readonly shipperSignature: string;
  readonly signedAt: string;
  readonly reviewDeadlineAt: string;
};

export type PodPackageResubmitted = LifecycleEventBase & {
  readonly type: "POD_PACKAGE_RESUBMITTED";
  readonly podId: string;
  readonly contentHash: string;
  readonly ciphertextHash: string;
};

export type PodAcceptedByShipper = LifecycleEventBase & {
  readonly type: "POD_ACCEPTED_BY_SHIPPER";
  readonly shipperSignature: string;
  readonly signedAt: string;
  readonly reviewDeadlineAt: string;
};

export type PodReviewDeadlineExpired = LifecycleEventBase & {
  readonly type: "POD_REVIEW_DEADLINE_EXPIRED";
  /** Timeout tick actionId must be unique per tick. */
};

export type PodCorrectionDeadlineExpired = LifecycleEventBase & {
  readonly type: "POD_CORRECTION_DEADLINE_EXPIRED";
};

export type PodRejectedToDispute = LifecycleEventBase & {
  readonly type: "POD_REJECTED_TO_DISPUTE";
  readonly reasons: readonly { code: string; message: string }[];
  readonly shipperSignature: string;
  readonly signedAt: string;
  readonly reviewDeadlineAt: string;
  readonly disputeId: string;
};

export type RefereeResolutionRecorded = LifecycleEventBase & {
  readonly type: "REFEREE_RESOLUTION_RECORDED";
  readonly disputeId: string;
  readonly podId: string;
  readonly resolution: "RELEASE_FULL" | "REFUND_FULL" | "PARTIAL";
  readonly releaseAmountAtomic: string;
  readonly refundAmountAtomic: string;
  readonly rationaleCode: string;
  readonly refereeId: string;
  /**
   * Optional event-supplied key; if present must equal trusted registry key.
   * Never used as allowlist authority.
   */
  readonly refereePublicKey?: string;
  readonly signature: string;
  readonly signedAt: string;
  readonly signerKind: "HUMAN_REFEREE";
};

export type EscrowReleaseConfirmed = LifecycleEventBase & {
  readonly type: "ESCROW_RELEASE_CONFIRMED";
  readonly releaseTxId: string;
  readonly releaseAmountAtomic: string;
};

export type EscrowPartialReleaseConfirmed = LifecycleEventBase & {
  readonly type: "ESCROW_PARTIAL_RELEASE_CONFIRMED";
  readonly releaseTxId: string;
  readonly refundTxId: string;
  readonly releaseAmountAtomic: string;
  readonly refundAmountAtomic: string;
};

export type EscrowRefundConfirmed = LifecycleEventBase & {
  readonly type: "ESCROW_REFUND_CONFIRMED";
  readonly refundTxId: string;
  readonly refundAmountAtomic: string;
};

export type TenderCompletionConfirmed = LifecycleEventBase & {
  readonly type: "TENDER_COMPLETION_CONFIRMED";
};

export type PodAdvisoryAnchored = LifecycleEventBase & {
  readonly type: "POD_ADVISORY_ANCHORED";
  readonly reportHash: string;
  readonly binding: "NON_BINDING_ADVISORY";
};

export type LifecycleEvent =
  | EscrowFundingConfirmed
  | TenderActivationPaid
  | BiddingStarted
  | AuctionCloseConfirmed
  | NoQualifiedBidConfirmed
  | WinnerSelectionConfirmed
  | WinningAmountAllocationConfirmed
  | RouteReservationPublished
  | TransitStarted
  | DeliveryReported
  | PodPackageSubmitted
  | PodReviewStarted
  | PodCorrectionRequested
  | PodPackageResubmitted
  | PodAcceptedByShipper
  | PodReviewDeadlineExpired
  | PodCorrectionDeadlineExpired
  | PodRejectedToDispute
  | RefereeResolutionRecorded
  | EscrowReleaseConfirmed
  | EscrowPartialReleaseConfirmed
  | EscrowRefundConfirmed
  | TenderCompletionConfirmed
  | PodAdvisoryAnchored;
