/**
 * Durable lifecycle record shape (CAS versioned).
 */

import type { LifecycleEventType } from "./events";
import type { V2LifecycleState } from "./states";

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

  // Funding / access
  readonly fundingTxId: string | null;
  readonly fundedAmountAtomic: string | null;
  readonly activationPaymentTxId: string | null;

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
  readonly podContentHash: string | null;
  readonly reviewStartedAt: string | null;
  readonly reviewDeadlineAt: string | null;
  readonly correctionDeadlineAt: string | null;
  readonly shipperActionTaken: boolean;
  readonly advisoryReportHash: string | null;
  readonly disputeId: string | null;

  // Settlement
  readonly refereeResolution: string | null;
  readonly releaseAmountAtomic: string | null;
  readonly refundAmountAtomic: string | null;
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
};

export function createLifecycleRecord(
  input: CreateLifecycleInput,
): LifecycleRecord {
  return {
    schemaVersion: LIFECYCLE_RECORD_SCHEMA,
    tenderId: input.tenderId,
    tenderVersion: input.tenderVersion,
    tenderHash: input.tenderHash,
    maximumFreightBudgetAtomic: input.maximumFreightBudgetAtomic,
    auctionEndsAt: input.auctionEndsAt,
    state: "DRAFT",
    recordVersion: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    lastActionId: null,
    history: [],
    processedActions: {},
    fundingTxId: null,
    fundedAmountAtomic: null,
    activationPaymentTxId: null,
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
    podContentHash: null,
    reviewStartedAt: null,
    reviewDeadlineAt: null,
    correctionDeadlineAt: null,
    shipperActionTaken: false,
    advisoryReportHash: null,
    disputeId: null,
    refereeResolution: null,
    releaseAmountAtomic: null,
    refundAmountAtomic: null,
    releaseTxId: null,
    refundTxId: null,
  };
}
