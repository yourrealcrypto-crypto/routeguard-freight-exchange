/**
 * Durable lifecycle record shape (CAS versioned).
 */

import {
  publicKeyFingerprint,
  snapshotTrustPolicy,
  type TrustPolicy,
  type TrustPolicySnapshot,
} from "../trust/policy";
import type { LifecycleEventType } from "./events";
import type { V2LifecycleState } from "./states";
import { PositiveAtomicSchema } from "../schemas/common";

export const LIFECYCLE_RECORD_SCHEMA = "routeguard-lifecycle-1.0" as const;

export type LifecycleTransitionRecord = {
  readonly from: V2LifecycleState;
  readonly to: V2LifecycleState;
  readonly eventType: LifecycleEventType;
  readonly actionId: string;
  readonly at: string;
  readonly reason?: string;
};

export type ProcessedActionRecord = {
  readonly actionId: string;
  readonly eventType: LifecycleEventType;
  /** Canonical hash of the event payload (excluding nothing security-critical). */
  readonly eventPayloadHash: string;
  readonly resultingState: V2LifecycleState;
  readonly recordVersionAfter: number;
  readonly at: string;
};

/**
 * Durable x402 access-payment receipt for tender activation.
 * Persisted so the paid gate can be re-validated after restart without
 * replaying the event stream.
 */
export type LifecycleAccessReceipt = {
  readonly accessActionType: "TENDER_ACTIVATE";
  readonly asset: string;
  readonly amountAtomic: string;
  readonly resource: string;
  readonly payTo: string;
  readonly payerAccount: string;
  readonly paymentTransactionId: string;
  readonly paymentPayloadHash: string;
  readonly paidAt: string;
};

/**
 * Durable index entry for one consumed x402 access settlement.
 *
 * Every paid access action appends exactly one entry. The settlement
 * transaction id is unique across the index, so a settled payment can never
 * authorize a second action (tender activation or another bid).
 */
export type LifecycleAccessPayment = {
  readonly accessActionType: "TENDER_ACTIVATE" | "BID_SUBMIT";
  readonly actionId: string;
  readonly bidId: string | null;
  readonly asset: string;
  readonly amountAtomic: string;
  readonly resource: string;
  readonly payTo: string;
  readonly payerAccount: string;
  readonly paymentTransactionId: string;
  readonly paymentPayloadHash: string;
  readonly settledAt: string;
};

/**
 * Durable public-safe record of an accepted carrier bid.
 * Carries the salted commitment only — never the freight amount, the salt, or
 * any other private bid field.
 */
export type LifecycleBidEntry = {
  readonly bidId: string;
  readonly carrierId: string;
  readonly carrierAccountId: string;
  /** Salted hash of the complete private bid (the public commitment). */
  readonly bidHash: string;
  /** Hash of the signed bid envelope (bid + carrier signature). */
  readonly signedBidEnvelopeHash: string;
  /** Canonical hash of the HCS BID_COMMITMENT payload built at acceptance. */
  readonly commitmentPayloadHash: string;
  readonly carrierKeyFingerprint: string;
  readonly bidAuthPayloadHash: string;
  readonly accessPaymentTxId: string;
  readonly actionId: string;
  readonly acceptedAt: string;
};

export type LifecycleRecord = {
  readonly schemaVersion: typeof LIFECYCLE_RECORD_SCHEMA;
  readonly tenderId: string;
  readonly tenderVersion: number;
  readonly tenderHash: string;
  readonly maximumFreightBudgetAtomic: string;
  readonly auctionEndsAt: string;
  readonly state: V2LifecycleState;
  /** Monotonic record version; starts at 1 on create. */
  readonly recordVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastActionId: string | null;
  readonly history: readonly LifecycleTransitionRecord[];
  readonly processedActions: Readonly<Record<string, ProcessedActionRecord>>;

  /** Snapshot of external trust policy at tender create (no private keys). */
  readonly trust: TrustPolicySnapshot;

  // Funding / access
  readonly fundingTxId: string | null;
  readonly fundedAmountAtomic: string | null;
  readonly activationPaymentTxId: string | null;
  /** Durable access-fee receipt recorded at TENDER_ACTIVATION_PAID. */
  readonly accessReceipt: LifecycleAccessReceipt | null;
  /** Append-only index of every consumed x402 access settlement. */
  readonly accessPayments: readonly LifecycleAccessPayment[];
  /** Append-only registry of durably accepted carrier bids (public-safe). */
  readonly bidRegistry: readonly LifecycleBidEntry[];

  // Auction
  readonly closureProofRef: string | null;
  readonly authoritativeBidSetHash: string | null;
  readonly decisionManifestHash: string | null;
  readonly winningBidId: string | null;
  readonly winningCarrierId: string | null;
  readonly winningCarrierAccount: string | null;
  readonly winningAmountAtomic: string | null;
  readonly lockedAmountAtomic: string | null;
  readonly excessRefundAtomic: string | null;
  readonly allocateTxId: string | null;
  readonly refundExcessTxId: string | null;
  readonly reservationEvidenceRef: string | null;

  // POD / review
  readonly podId: string | null;
  readonly podVersion: number | null;
  readonly podContentHash: string | null;
  readonly podCiphertextHash: string | null;
  readonly reviewStartedAt: string | null;
  readonly reviewDeadlineAt: string | null;
  readonly correctionDeadlineAt: string | null;
  readonly shipperActionTaken: boolean;
  readonly advisoryReportHash: string | null;
  readonly disputeId: string | null;
  readonly lastShipperAuthPayloadHash: string | null;
  readonly lastShipperKeyFingerprint: string | null;

  // Settlement — authorized by verified referee decision
  readonly refereeResolution: string | null;
  readonly releaseAmountAtomic: string | null;
  readonly refundAmountAtomic: string | null;
  readonly resolutionPayloadHash: string | null;
  readonly refereeId: string | null;
  readonly refereeKeyFingerprint: string | null;
  readonly releaseTxId: string | null;
  readonly refundTxId: string | null;
};

export type CreateLifecycleInput = {
  readonly tenderId: string;
  readonly tenderVersion: number;
  readonly tenderHash: string;
  readonly maximumFreightBudgetAtomic: string;
  readonly auctionEndsAt: string;
  readonly createdAt: string;
  /** External trust policy — snapshotted onto the record. */
  readonly trust: TrustPolicy;
};

export function createLifecycleRecord(
  input: CreateLifecycleInput,
): LifecycleRecord {
  const trust = snapshotTrustPolicy(input.trust);
  const maximumFreightBudgetAtomic = PositiveAtomicSchema.parse(
    input.maximumFreightBudgetAtomic,
  );
  return {
    schemaVersion: LIFECYCLE_RECORD_SCHEMA,
    tenderId: input.tenderId,
    tenderVersion: input.tenderVersion,
    tenderHash: input.tenderHash,
    maximumFreightBudgetAtomic,
    auctionEndsAt: input.auctionEndsAt,
    state: "DRAFT",
    recordVersion: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    lastActionId: null,
    history: [],
    processedActions: {},
    trust,
    fundingTxId: null,
    fundedAmountAtomic: null,
    activationPaymentTxId: null,
    accessReceipt: null,
    accessPayments: [],
    bidRegistry: [],
    closureProofRef: null,
    authoritativeBidSetHash: null,
    decisionManifestHash: null,
    winningBidId: null,
    winningCarrierId: null,
    winningCarrierAccount: null,
    winningAmountAtomic: null,
    lockedAmountAtomic: null,
    excessRefundAtomic: null,
    allocateTxId: null,
    refundExcessTxId: null,
    reservationEvidenceRef: null,
    podId: null,
    podVersion: null,
    podContentHash: null,
    podCiphertextHash: null,
    reviewStartedAt: null,
    reviewDeadlineAt: null,
    correctionDeadlineAt: null,
    shipperActionTaken: false,
    advisoryReportHash: null,
    disputeId: null,
    lastShipperAuthPayloadHash: null,
    lastShipperKeyFingerprint: null,
    refereeResolution: null,
    releaseAmountAtomic: null,
    refundAmountAtomic: null,
    resolutionPayloadHash: null,
    refereeId: null,
    refereeKeyFingerprint: null,
    releaseTxId: null,
    refundTxId: null,
  };
}

/** Rebuild TrustPolicy from durable snapshot for verification. */
export function trustPolicyFromRecord(record: LifecycleRecord): TrustPolicy {
  return Object.freeze({
    schemaVersion: record.trust.schemaVersion,
    shipperPublicKey: record.trust.shipperPublicKey,
    referees: record.trust.referees,
    accessTreasuryAccountId: record.trust.accessTreasuryAccountId,
    signatureAlgorithm: record.trust.signatureAlgorithm,
  });
}

export function fingerprintKey(publicKey: string): string {
  return publicKeyFingerprint(publicKey);
}
