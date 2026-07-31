/**
 * Shared fixtures for v2 lifecycle tests (ephemeral keys at runtime).
 */

import { PrivateKey } from "@hiero-ledger/sdk";

import { tenderActivateResource } from "../src/v2/access/resource";
import {
  buildRefereeResolutionSignPayload,
  buildShipperPodReviewSignPayload,
  type ShipperReviewActionKind,
} from "../src/v2/auth/canonical";
import {
  signRefereeResolutionForTests,
  signShipperPodReviewForTests,
  verifyRefereeResolution,
  verifyShipperPodReview,
  type VerifiedAuth,
} from "../src/v2/auth/verify";
import { deriveAccessFeeAtomic } from "../src/v2/access/fee";
import type { LifecycleEvent } from "../src/v2/lifecycle/events";
import { createLifecycleRecord } from "../src/v2/lifecycle/record";
import { reduceLifecycle } from "../src/v2/lifecycle/reducer";
import type { LifecycleRecord } from "../src/v2/lifecycle/record";
import { createTrustPolicy, type TrustPolicy } from "../src/v2/trust/policy";

export const HASH =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const HASH_B =
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const T0 = "2026-07-31T12:00:00.000Z";
export const AUCTION_ENDS = "2026-08-01T12:00:00.000Z";
export const BUDGET = "1000000";
export const WIN_AMOUNT = "700000";
export const EXCESS = "300000";
export const TREASURY = "0.0.9197513";

/** Ephemeral keys generated once per test process — never committed. */
export const SHIPPER_PRIVATE = PrivateKey.generateECDSA();
export const SHIPPER_PUBLIC = SHIPPER_PRIVATE.publicKey.toStringRaw();
export const REFEREE_PRIVATE = PrivateKey.generateECDSA();
export const REFEREE_PUBLIC = REFEREE_PRIVATE.publicKey.toStringRaw();
export const REFEREE_ID = "ref-human-1";

export function defaultTrustPolicy(
  overrides?: Partial<{
    shipperPublicKey: string;
    referees: { refereeId: string; publicKey: string }[];
    accessTreasuryAccountId: string;
  }>,
): TrustPolicy {
  return createTrustPolicy({
    shipperPublicKey: overrides?.shipperPublicKey ?? SHIPPER_PUBLIC,
    referees: overrides?.referees ?? [
      { refereeId: REFEREE_ID, publicKey: REFEREE_PUBLIC },
    ],
    accessTreasuryAccountId: overrides?.accessTreasuryAccountId ?? TREASURY,
  });
}

export function baseRecord(
  overrides: Partial<LifecycleRecord> = {},
  trust: TrustPolicy = defaultTrustPolicy(),
): LifecycleRecord {
  return {
    ...createLifecycleRecord({
      tenderId: "tender-v2-a2",
      tenderVersion: 1,
      tenderHash: HASH,
      maximumFreightBudgetAtomic: BUDGET,
      auctionEndsAt: AUCTION_ENDS,
      createdAt: T0,
      trust,
    }),
    ...overrides,
  };
}

export function signShipperAction(input: {
  tenderId: string;
  tenderVersion: number;
  podId: string;
  reviewAction: ShipperReviewActionKind;
  reasonCodes?: string[];
  signedAt: string;
  reviewDeadlineAt: string;
  actionId: string;
  privateKey?: PrivateKey;
}): string {
  const payload = buildShipperPodReviewSignPayload({
    tenderId: input.tenderId,
    tenderVersion: input.tenderVersion,
    podId: input.podId,
    reviewAction: input.reviewAction,
    ...(input.reasonCodes !== undefined
      ? { reasonCodes: input.reasonCodes }
      : {}),
    signedAt: input.signedAt,
    reviewDeadlineAt: input.reviewDeadlineAt,
    actionId: input.actionId,
  });
  const key = (input.privateKey ?? SHIPPER_PRIVATE).toStringRaw();
  return signShipperPodReviewForTests(key, payload);
}

export function signRefereeAction(input: {
  tenderId: string;
  tenderVersion: number;
  podId: string;
  disputeId: string;
  resolution: "RELEASE_FULL" | "REFUND_FULL" | "PARTIAL";
  releaseAmountAtomic: string;
  refundAmountAtomic: string;
  rationaleCode: string;
  refereeId: string;
  signedAt: string;
  actionId: string;
  privateKey?: PrivateKey;
}): string {
  const payload = buildRefereeResolutionSignPayload({
    tenderId: input.tenderId,
    tenderVersion: input.tenderVersion,
    podId: input.podId,
    disputeId: input.disputeId,
    resolution: input.resolution,
    releaseAmountAtomic: input.releaseAmountAtomic,
    refundAmountAtomic: input.refundAmountAtomic,
    rationaleCode: input.rationaleCode,
    refereeId: input.refereeId,
    signedAt: input.signedAt,
    actionId: input.actionId,
  });
  const key = (input.privateKey ?? REFEREE_PRIVATE).toStringRaw();
  return signRefereeResolutionForTests(key, payload);
}

export function shipperAuth(
  record: LifecycleRecord,
  input: {
    reviewAction: ShipperReviewActionKind;
    actionId: string;
    signedAt: string;
    reviewDeadlineAt: string;
    reasonCodes?: string[];
    signature: string;
  },
): VerifiedAuth {
  return verifyShipperPodReview({
    policy: defaultTrustPolicy({
      shipperPublicKey: record.trust.shipperPublicKey,
      referees: [...record.trust.referees],
      accessTreasuryAccountId: record.trust.accessTreasuryAccountId,
    }),
    tenderId: record.tenderId,
    tenderVersion: record.tenderVersion,
    podId: record.podId!,
    reviewAction: input.reviewAction,
    ...(input.reasonCodes !== undefined
      ? { reasonCodes: input.reasonCodes }
      : {}),
    signedAt: input.signedAt,
    reviewDeadlineAt: input.reviewDeadlineAt,
    actionId: input.actionId,
    signature: input.signature,
  });
}

export function refereeAuth(
  record: LifecycleRecord,
  input: {
    actionId: string;
    disputeId: string;
    podId: string;
    resolution: "RELEASE_FULL" | "REFUND_FULL" | "PARTIAL";
    releaseAmountAtomic: string;
    refundAmountAtomic: string;
    rationaleCode: string;
    refereeId: string;
    signedAt: string;
    signature: string;
    eventPublicKey?: string;
  },
): VerifiedAuth {
  return verifyRefereeResolution({
    policy: defaultTrustPolicy({
      shipperPublicKey: record.trust.shipperPublicKey,
      referees: [...record.trust.referees],
      accessTreasuryAccountId: record.trust.accessTreasuryAccountId,
    }),
    tenderId: record.tenderId,
    tenderVersion: record.tenderVersion,
    podId: input.podId,
    disputeId: input.disputeId,
    resolution: input.resolution,
    releaseAmountAtomic: input.releaseAmountAtomic,
    refundAmountAtomic: input.refundAmountAtomic,
    rationaleCode: input.rationaleCode,
    refereeId: input.refereeId,
    signedAt: input.signedAt,
    actionId: input.actionId,
    signature: input.signature,
    ...(input.eventPublicKey !== undefined
      ? { eventPublicKey: input.eventPublicKey }
      : {}),
  });
}

export function fund(rec: LifecycleRecord, t = T0): LifecycleRecord {
  return reduceLifecycle(rec, {
    type: "ESCROW_FUNDING_CONFIRMED",
    actionId: "act-fund",
    eventTime: t,
    fundingTxId: "0.0.1@1.1",
    tokenId: "0.0.429274",
    fundedAmountAtomic: BUDGET,
    tenderId: rec.tenderId,
    tenderVersion: rec.tenderVersion,
  });
}

export function activate(rec: LifecycleRecord, t = T0): LifecycleRecord {
  return reduceLifecycle(rec, {
    type: "TENDER_ACTIVATION_PAID",
    actionId: "act-activate",
    eventTime: t,
    accessActionType: "TENDER_ACTIVATE",
    asset: "0.0.429274",
    amountAtomic: deriveAccessFeeAtomic(),
    resource: tenderActivateResource(rec.tenderId, rec.tenderVersion),
    paymentTransactionId: "0.0.1@1.2",
    paymentPayloadHash: HASH,
    payerAccount: "0.0.9197513",
    payTo: rec.trust.accessTreasuryAccountId,
  });
}

export function toBidding(rec: LifecycleRecord, t = T0): LifecycleRecord {
  return reduceLifecycle(rec, {
    type: "BIDDING_STARTED",
    actionId: "act-bid-open",
    eventTime: t,
  });
}

export function closeAuction(rec: LifecycleRecord, t = AUCTION_ENDS): LifecycleRecord {
  return reduceLifecycle(rec, {
    type: "AUCTION_CLOSE_CONFIRMED",
    actionId: "act-close",
    eventTime: t,
    auctionEndsAt: AUCTION_ENDS,
    closureProofRef: "proof-ref-1",
    authoritativeBidSetHash: HASH,
  });
}

export function selectWinner(rec: LifecycleRecord, t = AUCTION_ENDS): LifecycleRecord {
  return reduceLifecycle(rec, {
    type: "WINNER_SELECTION_CONFIRMED",
    actionId: "act-winner",
    eventTime: t,
    decisionManifestHash: HASH,
    winningBidId: "bid-1",
    winningCarrierId: "carrier-alpha",
    winningCarrierAccount: "0.0.9215954",
    winningAmountAtomic: WIN_AMOUNT,
    selectionPolicy: "LOWEST_QUALIFIED_PRICE_V1",
  });
}

export function allocate(rec: LifecycleRecord, t = AUCTION_ENDS): LifecycleRecord {
  return reduceLifecycle(rec, {
    type: "WINNING_AMOUNT_ALLOCATION_CONFIRMED",
    actionId: "act-alloc",
    eventTime: t,
    allocateTxId: "0.0.1@1.3",
    refundExcessTxId: "0.0.1@1.4",
    maxBudgetAtomic: BUDGET,
    winningAmountAtomic: WIN_AMOUNT,
    excessRefundAtomic: EXCESS,
    decisionManifestHash: HASH,
  });
}

export function reserve(rec: LifecycleRecord, t = AUCTION_ENDS): LifecycleRecord {
  return reduceLifecycle(rec, {
    type: "ROUTE_RESERVATION_PUBLISHED",
    actionId: "act-reserve",
    eventTime: t,
    reservationEvidenceRef: "res-ev-1",
    hcsPublicationRef: "hcs-seq-5",
  });
}

export function happyToPodSubmitted(t = AUCTION_ENDS): LifecycleRecord {
  let r = baseRecord();
  r = fund(r, T0);
  r = activate(r, T0);
  r = toBidding(r, T0);
  r = closeAuction(r, t);
  r = selectWinner(r, t);
  r = allocate(r, t);
  r = reserve(r, t);
  r = reduceLifecycle(r, {
    type: "TRANSIT_STARTED",
    actionId: "act-transit",
    eventTime: t,
  });
  r = reduceLifecycle(r, {
    type: "DELIVERY_REPORTED",
    actionId: "act-deliver",
    eventTime: t,
  });
  r = reduceLifecycle(r, {
    type: "POD_PACKAGE_SUBMITTED",
    actionId: "act-pod",
    eventTime: t,
    podId: "pod-1",
    contentHash: HASH,
    ciphertextHash: HASH_B,
  });
  return r;
}

export function happyToUnderReview(
  reviewStart = "2026-08-02T12:00:00.000Z",
): LifecycleRecord {
  let r = happyToPodSubmitted(AUCTION_ENDS);
  r = reduceLifecycle(r, {
    type: "POD_REVIEW_STARTED",
    actionId: "act-review",
    eventTime: reviewStart,
  });
  return r;
}

export function acceptPod(rec: LifecycleRecord, at: string): LifecycleRecord {
  const actionId = "act-accept";
  const signedAt = at;
  const sig = signShipperAction({
    tenderId: rec.tenderId,
    tenderVersion: rec.tenderVersion,
    podId: rec.podId!,
    reviewAction: "ACCEPT",
    signedAt,
    reviewDeadlineAt: rec.reviewDeadlineAt!,
    actionId,
  });
  const auth = shipperAuth(rec, {
    reviewAction: "ACCEPT",
    actionId,
    signedAt,
    reviewDeadlineAt: rec.reviewDeadlineAt!,
    signature: sig,
  });
  return reduceLifecycle(
    rec,
    {
      type: "POD_ACCEPTED_BY_SHIPPER",
      actionId,
      eventTime: at,
      shipperSignature: sig,
      signedAt,
      reviewDeadlineAt: rec.reviewDeadlineAt!,
    },
    { verifiedAuth: auth },
  );
}

/** POD_UNDER_REVIEW → POD_DISPUTED with a real shipper signature. */
export function rejectToDispute(
  rec: LifecycleRecord,
  disputeId = "disp-1",
  actionId = "act-reject",
): LifecycleRecord {
  const deadline = rec.reviewDeadlineAt!;
  const signature = signShipperAction({
    tenderId: rec.tenderId,
    tenderVersion: rec.tenderVersion,
    podId: rec.podId!,
    reviewAction: "REJECT_DISPUTE",
    reasonCodes: ["DAMAGED"],
    signedAt: deadline,
    reviewDeadlineAt: deadline,
    actionId,
  });
  const auth = shipperAuth(rec, {
    reviewAction: "REJECT_DISPUTE",
    actionId,
    signedAt: deadline,
    reviewDeadlineAt: deadline,
    reasonCodes: ["DAMAGED"],
    signature,
  });
  return reduceLifecycle(
    rec,
    {
      type: "POD_REJECTED_TO_DISPUTE",
      actionId,
      eventTime: deadline,
      reasons: [{ code: "DAMAGED", message: "broken" }],
      shipperSignature: signature,
      signedAt: deadline,
      reviewDeadlineAt: deadline,
      disputeId,
    },
    { verifiedAuth: auth },
  );
}

/** POD_DISPUTED → REFEREE_DECISION with a real referee signature. */
export function recordRefereeDecision(
  rec: LifecycleRecord,
  input: {
    resolution: "RELEASE_FULL" | "REFUND_FULL" | "PARTIAL";
    releaseAmountAtomic: string;
    refundAmountAtomic: string;
    disputeId?: string;
    actionId?: string;
  },
): LifecycleRecord {
  const actionId = input.actionId ?? "act-referee";
  const disputeId = input.disputeId ?? rec.disputeId ?? "disp-1";
  const signedAt = rec.updatedAt;
  const common = {
    tenderId: rec.tenderId,
    tenderVersion: rec.tenderVersion,
    podId: rec.podId!,
    disputeId,
    resolution: input.resolution,
    releaseAmountAtomic: input.releaseAmountAtomic,
    refundAmountAtomic: input.refundAmountAtomic,
    rationaleCode: "REVIEWED",
    refereeId: REFEREE_ID,
    signedAt,
    actionId,
  };
  const signature = signRefereeAction(common);
  const auth = refereeAuth(rec, { ...common, signature });
  return reduceLifecycle(
    rec,
    {
      type: "REFEREE_RESOLUTION_RECORDED",
      actionId,
      eventTime: signedAt,
      disputeId,
      podId: rec.podId!,
      resolution: input.resolution,
      releaseAmountAtomic: input.releaseAmountAtomic,
      refundAmountAtomic: input.refundAmountAtomic,
      rationaleCode: "REVIEWED",
      refereeId: REFEREE_ID,
      signature,
      signedAt,
      signerKind: "HUMAN_REFEREE",
    },
    { verifiedAuth: auth },
  );
}

export function activationEvent(
  tenderId: string,
  tenderVersion = 1,
  actionId = "act-activate",
  payTo = TREASURY,
): LifecycleEvent {
  return {
    type: "TENDER_ACTIVATION_PAID",
    actionId,
    eventTime: T0,
    accessActionType: "TENDER_ACTIVATE",
    asset: "0.0.429274",
    amountAtomic: deriveAccessFeeAtomic(),
    resource: tenderActivateResource(tenderId, tenderVersion),
    paymentTransactionId: "0.0.1@1.2",
    paymentPayloadHash: HASH,
    payerAccount: "0.0.9197513",
    payTo,
  };
}
