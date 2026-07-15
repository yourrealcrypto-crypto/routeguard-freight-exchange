/**
 * RouteGuard Phase 6A — durable dual-asset winner reservation types.
 * Demo reservation fees are separate from freight price.
 */

import type { VerifiedAuctionClosureProof } from "../auction/closure-proof";
import type { DecisionManifest } from "../auction/types";

export const RESERVATION_SCHEMA_VERSION = "routeguard-reservation-1.0" as const;
export const RESERVATION_OFFER_VERSION = 1 as const;
/** Short version tag to keep HCS ROUTE_RESERVED payloads under size limits. */
export const RESERVATION_EVIDENCE_VERSION = "rg-res-ev-1" as const;
export const WEBHOOK_SIGNATURE_VERSION = "routeguard-webhook-sig-1.0" as const;
export const ROUTE_RESERVED_EVENT_TYPE = "ROUTE_RESERVED" as const;

export const RESERVATION_NETWORK = "hedera:testnet" as const;
export const RESERVATION_SCHEME = "exact" as const;

/** Demo reservation fee — NOT the freight invoice amount. */
export const DEMO_RESERVATION_FEE_NOTE =
  "Demo reservation fee only — not payment of the freight price." as const;

export const USDC_RESERVATION_OPTION = {
  optionId: "USDC" as const,
  scheme: RESERVATION_SCHEME,
  network: RESERVATION_NETWORK,
  asset: "0.0.429274" as const,
  amountAtomic: "10000" as const,
  displayAmount: "0.01" as const,
  currencyLabel: "USDC" as const,
};

export const HBAR_RESERVATION_OPTION = {
  optionId: "HBAR" as const,
  scheme: RESERVATION_SCHEME,
  network: RESERVATION_NETWORK,
  asset: "0.0.0" as const,
  amountAtomic: "1000000" as const,
  displayAmount: "0.01" as const,
  currencyLabel: "HBAR" as const,
};

export type ReservationOptionId = "USDC" | "HBAR";

export const RESERVATION_STATES = [
  "OFFER_CREATED",
  "OPTION_SELECTED",
  "PAYMENT_CHALLENGE_ISSUED",
  "PAYMENT_SUBMISSION_STARTED",
  "FACILITATOR_VERIFIED",
  "FACILITATOR_SETTLED",
  "MIRROR_CONFIRMATION_PENDING",
  "PAYMENT_CONFIRMED",
  "ROUTE_RESERVED",
  "WEBHOOKS_DISPATCHED",
  "HCS_EVIDENCE_RECORDED",
  "COMPLETED",
  "PAYMENT_REJECTED",
  "SETTLEMENT_FAILED",
  "CONFIRMATION_TIMED_OUT",
  "CONFIRMATION_FAILED",
  "WEBHOOK_DELIVERY_FAILED",
  "HCS_EVIDENCE_FAILED",
  "EXPIRED",
  "MANUAL_REVIEW_REQUIRED",
] as const;

export type ReservationState = (typeof RESERVATION_STATES)[number];

export const TERMINAL_PAYMENT_FAILURE_STATES: ReadonlySet<ReservationState> =
  new Set([
    "PAYMENT_REJECTED",
    "SETTLEMENT_FAILED",
    "CONFIRMATION_TIMED_OUT",
    "CONFIRMATION_FAILED",
    "EXPIRED",
    "MANUAL_REVIEW_REQUIRED",
  ]);

/** States at or after ROUTE_RESERVED — reservation must not reverse. */
export const POST_RESERVATION_STATES: ReadonlySet<ReservationState> = new Set([
  "ROUTE_RESERVED",
  "WEBHOOKS_DISPATCHED",
  "HCS_EVIDENCE_RECORDED",
  "COMPLETED",
  "WEBHOOK_DELIVERY_FAILED",
  "HCS_EVIDENCE_FAILED",
]);

export type OfferOption = {
  readonly optionId: ReservationOptionId;
  readonly scheme: typeof RESERVATION_SCHEME;
  readonly network: typeof RESERVATION_NETWORK;
  readonly asset: string;
  readonly amountAtomic: string;
  readonly displayAmount: string;
  readonly currencyLabel: string;
};

export type ReservationOffer = {
  readonly reservationId: string;
  readonly offerVersion: number;
  readonly tenderId: string;
  readonly winningBidId: string;
  readonly payTo: string;
  readonly expiresAt: string;
  readonly feeLabel: typeof DEMO_RESERVATION_FEE_NOTE;
  readonly options: readonly OfferOption[];
  readonly offerHash: string;
};

export type SelectedPaymentOption = {
  readonly reservationId: string;
  readonly offerHash: string;
  readonly offerVersion: number;
  readonly optionId: ReservationOptionId;
  readonly payerAccount: string;
  readonly payTo: string;
  readonly asset: string;
  readonly amountAtomic: string;
  readonly scheme: typeof RESERVATION_SCHEME;
  readonly network: typeof RESERVATION_NETWORK;
  readonly selectedAt: string;
  readonly resourcePath: string;
};

export type CreateReservationInput = {
  reservationId: string;
  tenderId: string;
  tenderVersion: number;
  tenderHash: string;
  winningBidId: string;
  winningBidHash: string;
  winningCarrierId: string;
  winningCarrierAccount: string;
  decisionManifestHash: string;
  evaluatedBidSetHash: string;
  hcsTopicId: string;
  closeBarrierSequence: number;
  closeBarrierConsensusTimestamp: string;
  /** Must be runtime-authentic factory proof. */
  closureProof: VerifiedAuctionClosureProof;
  reservationOfferVersion: number;
  createdAt: string;
  expiresAt: string;
  /** Shipper payer account for later selection (optional until select). */
  defaultPayerAccount?: string;
};

export type StateTransitionRecord = {
  readonly from: ReservationState;
  readonly to: ReservationState;
  readonly at: string;
  readonly reason?: string;
};

export type FacilitatorVerifyResult = {
  readonly isValid: boolean;
  readonly invalidReason?: string;
};

export type FacilitatorSettleResult = {
  readonly success: boolean;
  readonly transactionId: string | null;
  readonly network: string;
  readonly payerAccountId: string;
  readonly errorReason?: string;
};

export type MirrorTransfer = {
  readonly account: string;
  readonly amount: string;
  readonly tokenId?: string;
};

export type MirrorConfirmation = {
  readonly status: "SUCCESS" | "FAILED" | "PENDING" | "NOT_FOUND";
  readonly transactionId: string;
  readonly consensusTimestamp: string | null;
  readonly result: string | null;
  readonly hbarTransfers: readonly MirrorTransfer[];
  readonly tokenTransfers: readonly MirrorTransfer[];
};

export type PaymentChallenge = {
  readonly x402Version: number;
  readonly scheme: typeof RESERVATION_SCHEME;
  readonly network: typeof RESERVATION_NETWORK;
  readonly asset: string;
  readonly amount: string;
  readonly payTo: string;
  readonly resource: string;
  readonly maxTimeoutSeconds: number;
  readonly description: string;
};

export type WebhookDeliveryRecord = {
  readonly eventId: string;
  readonly recipient: "shipper" | "carrier";
  readonly payloadHash: string;
  readonly delivered: boolean;
  readonly attempts: number;
  readonly lastAttemptAt: string | null;
  readonly lastError: string | null;
};

export type HcsEvidenceRecord = {
  readonly messageType: "ROUTE_RESERVED";
  readonly envelopeHash: string;
  readonly topicId: string | null;
  readonly sequence: number | null;
  readonly transactionId: string | null;
  readonly consensusTimestamp: string | null;
  readonly published: boolean;
  readonly lastError: string | null;
};

export type RouteReservedRecord = {
  readonly schemaVersion: typeof RESERVATION_SCHEMA_VERSION;
  readonly reservationId: string;
  readonly tenderId: string;
  readonly tenderVersion: number;
  readonly tenderHash: string;
  readonly winningBidId: string;
  readonly winningBidHash: string;
  readonly carrierId: string;
  readonly carrierAccount: string;
  readonly selectedOptionId: ReservationOptionId;
  readonly paymentNetwork: typeof RESERVATION_NETWORK;
  readonly paymentAsset: string;
  readonly paymentAmountAtomic: string;
  readonly payerAccount: string;
  readonly transactionId: string;
  readonly consensusTimestamp: string;
  readonly decisionManifestHash: string;
  readonly evaluatedBidSetHash: string;
  readonly hcsAuctionTopicId: string;
  readonly closeBarrierSequence: number;
  readonly reservedAt: string;
  readonly reservationRecordHash: string;
};

export type ReservationRecord = {
  reservationId: string;
  state: ReservationState;
  tenderId: string;
  tenderVersion: number;
  tenderHash: string;
  winningBidId: string;
  winningBidHash: string;
  winningCarrierId: string;
  winningCarrierAccount: string;
  decisionManifestHash: string;
  evaluatedBidSetHash: string;
  hcsTopicId: string;
  closeBarrierSequence: number;
  closeBarrierConsensusTimestamp: string;
  /** Sanitized proof metadata only — not the WeakSet identity. */
  proofTenderId: string;
  proofManifestHash: string;
  offer: ReservationOffer;
  selected: SelectedPaymentOption | null;
  attemptNumber: number;
  paymentChallengeHash: string | null;
  paymentPayloadHash: string | null;
  facilitatorVerify: FacilitatorVerifyResult | null;
  facilitatorSettle: FacilitatorSettleResult | null;
  transactionId: string | null;
  mirrorConfirmation: MirrorConfirmation | null;
  confirmationDeadline: string | null;
  routeReserved: RouteReservedRecord | null;
  webhooks: WebhookDeliveryRecord[];
  hcsEvidence: HcsEvidenceRecord | null;
  history: StateTransitionRecord[];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  failureCode: string | null;
  failureReason: string | null;
  /** In-memory only authentic proof handle for service; never persisted. */
  _closureProof?: VerifiedAuctionClosureProof;
  _manifest?: DecisionManifest;
};

export type WebhookEventPayload = {
  readonly eventId: string;
  readonly eventType: typeof ROUTE_RESERVED_EVENT_TYPE;
  readonly reservationId: string;
  readonly tenderId: string;
  readonly winningBidId: string;
  readonly carrierAccount: string;
  readonly selectedOptionId: ReservationOptionId;
  readonly paymentAsset: string;
  readonly paymentAmountAtomic: string;
  readonly transactionId: string;
  readonly consensusTimestamp: string;
  readonly reservationRecordHash: string;
  readonly emittedAt: string;
};

export type SignedWebhook = {
  readonly payload: WebhookEventPayload;
  readonly headers: {
    readonly "X-RouteGuard-Event-Id": string;
    readonly "X-RouteGuard-Timestamp": string;
    readonly "X-RouteGuard-Signature": string;
    readonly "X-RouteGuard-Signature-Version": string;
  };
  readonly payloadHash: string;
};

export class ReservationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ReservationError";
  }
}
