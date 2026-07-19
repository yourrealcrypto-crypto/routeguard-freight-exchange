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
  "FACILITATOR_SETTLE_CLAIMED",
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

/** Fixed x402 challenge timeout for demo reservation fees. */
export const CHALLENGE_MAX_TIMEOUT_SECONDS = 180 as const;
/** Fixed x402 protocol version. */
export const CHALLENGE_X402_VERSION = 2 as const;

/**
 * Durable sanitized payment challenge. Persisted exactly once per selection.
 * Hash covers every field except challengeHash itself. Never contains payment
 * signatures, signed transaction bytes, payment payloads, private keys, or
 * secret headers.
 */
export type PaymentChallengeRecord = {
  readonly x402Version: typeof CHALLENGE_X402_VERSION;
  readonly scheme: typeof RESERVATION_SCHEME;
  readonly network: typeof RESERVATION_NETWORK;
  readonly asset: string;
  readonly amount: string;
  readonly payTo: string;
  readonly resource: string;
  readonly maxTimeoutSeconds: typeof CHALLENGE_MAX_TIMEOUT_SECONDS;
  readonly description: string;
  readonly challengeHash: string;
  readonly issuedAt: string;
};

/**
 * Durable Mirror confirmation poll state for restart-safe bounded polling.
 * Never contains payment signatures, signed payloads, private keys, or secrets.
 */
export type MirrorPollRecord = {
  readonly transactionId: string;
  readonly confirmationStartedAt: string;
  readonly confirmationDeadline: string;
  readonly pollAttemptCount: number;
  readonly lastPollAt: string | null;
  readonly lastMirrorStatus:
    | "SUCCESS"
    | "FAILED"
    | "PENDING"
    | "NOT_FOUND"
    | "TRANSPORT_ERROR"
    | null;
  readonly lastMirrorErrorCode: string | null;
  readonly lastMirrorError: string | null;
  readonly consensusTimestamp: string | null;
  /** Sanitized verified transfer facts after SUCCESS — no secret material. */
  readonly verifiedTransfer: {
    readonly optionId: ReservationOptionId;
    readonly asset: string;
    readonly amountAtomic: string;
    readonly payerAccount: string;
    readonly payTo: string;
  } | null;
};

/**
 * Immutable semantic webhook event. Created exactly once per (reservation,
 * recipient) before first delivery. Retries reuse it verbatim — eventId,
 * payload, emittedAt, payloadHash, signature, signed timestamp never change.
 */
export type WebhookEvent = {
  readonly eventId: string;
  readonly recipient: "shipper" | "carrier";
  readonly eventType: typeof ROUTE_RESERVED_EVENT_TYPE;
  readonly payload: WebhookEventPayload;
  readonly payloadHash: string;
  readonly emittedAt: string;
  readonly signatureVersion: typeof WEBHOOK_SIGNATURE_VERSION;
  readonly signature: string;
  /** Signed header timestamp value bound into the signature. */
  readonly signedTimestamp: string;
};

/**
 * Operational delivery metadata for one webhook event. Mutates across retries
 * without touching the immutable semantic event above.
 */
export type WebhookDeliveryRecord = {
  readonly eventId: string;
  readonly recipient: "shipper" | "carrier";
  readonly payloadHash: string;
  readonly delivered: boolean;
  readonly deliveryAttemptNumber: number;
  readonly attemptedAt: string | null;
  readonly lastResponseCode: number | null;
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

/**
 * Durable HCS ROUTE_RESERVED publication outbox claim. Persisted with CAS
 * BEFORE the external HCS publish call so a lost response cannot cause a
 * second automatic submit. Never contains private bid data, payment
 * signatures, private keys, signed payment payloads, salts, or nonces.
 */
export type HcsPublicationClaimStatus =
  | "CLAIMED"
  | "RESOLVING"
  | "PUBLISHED"
  | "MANUAL_REVIEW_REQUIRED"
  | "FAILED_CONCLUSIVE";

export type HcsPublicationClaim = {
  readonly publishAttemptId: string;
  readonly reservationId: string;
  /** Bound to the reservation record's existing auction topic — not a hard-coded constant. */
  readonly expectedTopicId: string;
  readonly messageType: "ROUTE_RESERVED";
  /** Complete canonical public ROUTE_RESERVED envelope. */
  readonly envelope: Readonly<Record<string, unknown>>;
  readonly envelopeHash: string;
  readonly encodedByteCount: number;
  readonly claimedAt: string;
  readonly status: HcsPublicationClaimStatus;
  readonly transactionId: string | null;
  readonly sequence: number | null;
  readonly consensusTimestamp: string | null;
  readonly failureCode: string | null;
  readonly failureReason: string | null;
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

/**
 * Durable settle claim persisted with CAS AFTER FACILITATOR_VERIFIED and BEFORE
 * the external facilitator settle call. Only the caller that persists this claim
 * may invoke settle, and settle is invoked at most once. Never contains payment
 * signatures, signed payloads, keys, or secret headers — only public binding
 * facts plus a locally generated settleAttemptId used as durable evidence.
 */
export type SettleClaim = {
  readonly settleAttemptId: string;
  readonly reservationId: string;
  readonly attemptNumber: number;
  readonly selectedOptionId: ReservationOptionId;
  readonly asset: string;
  readonly amountAtomic: string;
  readonly payerAccount: string;
  readonly payTo: string;
  readonly network: typeof RESERVATION_NETWORK;
  readonly challengeHash: string;
  readonly paymentPayloadHash: string;
  /**
   * v1.5 §22.4/§23.1 — the EXACT client-frozen Hedera transaction ID and
   * validity window decoded from the signed payment transaction, persisted
   * BEFORE the external facilitator settle call. Mandatory; never invented.
   */
  readonly transactionId: string;
  readonly validStartTimestamp: string;
  readonly transactionValidDurationSeconds: number;
  readonly claimedAt: string;
  /** recordVersion at which this claim was durably persisted. */
  readonly recordVersion: number;
};

/**
 * v1.5 §22.4 — client-frozen transaction identity persisted on the record at
 * PAYMENT_SUBMISSION_STARTED (before any facilitator transmission). Decoded
 * from the signed transaction; never invented.
 */
export type ClientTransactionBinding = {
  readonly transactionId: string;
  readonly validStartTimestamp: string;
  readonly transactionValidDurationSeconds: number;
};

export type ReservationRecord = {
  /**
   * Monotonic optimistic-concurrency version. Initial persisted value is 1 and
   * every successful mutation increments it by exactly one. Store-managed; never
   * accepted from public API input.
   */
  recordVersion: number;
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
  /**
   * Canonical creation idempotency fingerprint. Computed internally over
   * trust-critical create fields; never accepted from public API input.
   */
  creationFingerprint: string;
  /** Sanitized proof metadata only — not the WeakSet identity. */
  proofTenderId: string;
  proofManifestHash: string;
  offer: ReservationOffer;
  selected: SelectedPaymentOption | null;
  attemptNumber: number;
  /**
   * Durable complete sanitized challenge (issued once). challengeHash on this
   * record is the authority; paymentChallengeHash mirrors it for legacy bind.
   */
  paymentChallenge: PaymentChallengeRecord | null;
  paymentChallengeHash: string | null;
  paymentPayloadHash: string | null;
  /**
   * v1.5 §22.4 — exact client-frozen transaction identity, durable from
   * PAYMENT_SUBMISSION_STARTED onward (before verify/settle transmission).
   */
  clientTransaction: ClientTransactionBinding | null;
  facilitatorVerify: FacilitatorVerifyResult | null;
  /** Durable settle-once authority persisted before the external settle call. */
  settleClaim: SettleClaim | null;
  facilitatorSettle: FacilitatorSettleResult | null;
  transactionId: string | null;
  mirrorConfirmation: MirrorConfirmation | null;
  /** Durable Mirror poll audit / recovery state. */
  mirrorPoll: MirrorPollRecord | null;
  confirmationDeadline: string | null;
  routeReserved: RouteReservedRecord | null;
  /** Immutable semantic webhook events (created once, before first delivery). */
  webhookEvents: WebhookEvent[];
  webhooks: WebhookDeliveryRecord[];
  /**
   * Durable HCS publication claim / outbox. Persisted before external publish;
   * holds CLAIMED→PUBLISHED or resolution outcomes without reversing ROUTE_RESERVED.
   */
  hcsPublicationClaim: HcsPublicationClaim | null;
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

/**
 * Typed optimistic-concurrency conflict. Thrown by the store when a
 * compareAndSet expected version no longer matches the persisted record — i.e.
 * a newer record would otherwise be silently overwritten. Callers must never
 * treat this as success.
 */
export class ReservationVersionConflictError extends ReservationError {
  constructor(
    public readonly reservationId: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(
      "VERSION_CONFLICT",
      `Reservation ${reservationId} version conflict: expected ${expectedVersion}, found ${actualVersion}`,
    );
    this.name = "ReservationVersionConflictError";
  }
}
