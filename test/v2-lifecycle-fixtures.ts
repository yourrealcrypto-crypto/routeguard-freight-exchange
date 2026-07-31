/**
 * Shared fixtures for v2 lifecycle Phase A2 tests.
 */

import { deriveAccessFeeAtomic } from "../src/v2/access/fee";
import type { LifecycleEvent } from "../src/v2/lifecycle/events";
import { createLifecycleRecord } from "../src/v2/lifecycle/record";
import { reduceLifecycle } from "../src/v2/lifecycle/reducer";
import type { LifecycleRecord } from "../src/v2/lifecycle/record";

export const HASH =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const HASH_B =
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const SIG = "ab".repeat(64);
export const T0 = "2026-07-31T12:00:00.000Z";
export const AUCTION_ENDS = "2026-08-01T12:00:00.000Z";
export const BUDGET = "1000000"; // 1 USDC atomic? 1e6 = 1 USDC
export const WIN_AMOUNT = "700000";
export const EXCESS = "300000";
export const REFEREE_KEY = "02" + "cd".repeat(32);

export function baseRecord(overrides: Partial<LifecycleRecord> = {}): LifecycleRecord {
  return {
    ...createLifecycleRecord({
      tenderId: "tender-v2-a2",
      tenderVersion: 1,
      tenderHash: HASH,
      maximumFreightBudgetAtomic: BUDGET,
      auctionEndsAt: AUCTION_ENDS,
      createdAt: T0,
    }),
    ...overrides,
  };
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
    resource: `/api/v2/tenders/${rec.tenderId}/activate`,
    paymentTransactionId: "0.0.1@1.2",
    paymentPayloadHash: HASH,
    payerAccount: "0.0.9197513",
    payTo: "0.0.9197513",
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

export function activationEvent(
  tenderId: string,
  actionId = "act-activate",
): LifecycleEvent {
  return {
    type: "TENDER_ACTIVATION_PAID",
    actionId,
    eventTime: T0,
    accessActionType: "TENDER_ACTIVATE",
    asset: "0.0.429274",
    amountAtomic: deriveAccessFeeAtomic(),
    resource: `/api/v2/tenders/${tenderId}/activate`,
    paymentTransactionId: "0.0.1@1.2",
    paymentPayloadHash: HASH,
    payerAccount: "0.0.9197513",
    payTo: "0.0.9197513",
  };
}
