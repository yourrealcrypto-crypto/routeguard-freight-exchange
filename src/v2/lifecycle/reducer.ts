/**
 * Pure deterministic lifecycle reducer.
 * No Date.now, random, filesystem, network, or env reads.
 * Cryptographic verification is performed outside and supplied as sealed auth.
 */

import { canonicalSha256 } from "../../domain/canonical-hash";
import {
  isBeforeOrEqualUtc,
  isUtcIsoTimestamp,
} from "../../domain/time";
import {
  ACCESS_FEE_TOKEN_ID,
  deriveAccessFeeAtomic,
  isNonNegativeAtomicString,
  isPositiveAtomicString,
} from "../access/fee";
import { tenderActivateResource } from "../access/resource";
import {
  isSealedVerifiedAuth,
  type VerifiedAuth,
  type VerifiedRefereeResolutionAuth,
  type VerifiedShipperReviewAuth,
} from "../auth/verify";
import {
  computeCorrectionDeadline,
  computePostResubmitReviewDeadline,
  computeReviewDeadline,
} from "./deadlines";
import {
  IllegalLifecycleTransitionError,
  LifecycleGuardError,
} from "./errors";
import type { LifecycleEvent } from "./events";
import type {
  LifecycleRecord,
  LifecycleTransitionRecord,
} from "./record";
import type { V2LifecycleState } from "./states";

/**
 * Explicit reduce context. Trust identities are snapshotted on the record;
 * sealed verifiedAuth is produced only by the verification module.
 */
export type LifecycleReduceContext = {
  readonly verifiedAuth?: VerifiedAuth;
};

const LEGAL: ReadonlyMap<V2LifecycleState, readonly V2LifecycleState[]> =
  new Map([
    ["DRAFT", ["ESCROW_FUNDED"]],
    ["ESCROW_FUNDED", ["TENDER_OPENED"]],
    ["TENDER_OPENED", ["BIDDING"]],
    ["BIDDING", ["AUCTION_CLOSED"]],
    ["AUCTION_CLOSED", ["WINNER_SELECTED", "NO_QUALIFIED_BID"]],
    ["NO_QUALIFIED_BID", ["REFUNDED"]],
    ["WINNER_SELECTED", ["WINNING_AMOUNT_LOCKED"]],
    ["WINNING_AMOUNT_LOCKED", ["ROUTE_RESERVED"]],
    ["ROUTE_RESERVED", ["IN_TRANSIT"]],
    ["IN_TRANSIT", ["DELIVERY_REPORTED"]],
    ["DELIVERY_REPORTED", ["POD_SUBMITTED"]],
    ["POD_SUBMITTED", ["POD_UNDER_REVIEW"]],
    [
      "POD_UNDER_REVIEW",
      [
        "POD_CORRECTION_REQUESTED",
        "POD_ACCEPTED",
        "POD_DEEMED_ACCEPTED",
        "POD_DISPUTED",
      ],
    ],
    ["POD_CORRECTION_REQUESTED", ["POD_RESUBMITTED", "POD_DISPUTED"]],
    ["POD_RESUBMITTED", ["POD_UNDER_REVIEW"]],
    ["POD_ACCEPTED", ["PAYMENT_RELEASED"]],
    ["POD_DEEMED_ACCEPTED", ["PAYMENT_RELEASED"]],
    ["POD_DISPUTED", ["REFEREE_DECISION"]],
    [
      "REFEREE_DECISION",
      ["PAYMENT_RELEASED", "PARTIAL_RELEASE", "REFUNDED"],
    ],
    ["PAYMENT_RELEASED", ["TENDER_COMPLETED"]],
    ["PARTIAL_RELEASE", ["TENDER_COMPLETED"]],
    ["REFUNDED", ["TENDER_COMPLETED"]],
    ["TENDER_COMPLETED", []],
  ]);

export function assertLegalTransition(
  from: V2LifecycleState,
  to: V2LifecycleState,
): void {
  if (from === to) {
    return;
  }
  const allowed = LEGAL.get(from) ?? [];
  if (!allowed.includes(to)) {
    throw new IllegalLifecycleTransitionError(from, to);
  }
}

export function isLegalTransition(
  from: V2LifecycleState,
  to: V2LifecycleState,
): boolean {
  if (from === to) return true;
  return (LEGAL.get(from) ?? []).includes(to);
}

export function legalSuccessors(
  from: V2LifecycleState,
): readonly V2LifecycleState[] {
  return LEGAL.get(from) ?? [];
}

export function eventPayloadHash(event: LifecycleEvent): string {
  return canonicalSha256(event);
}

function requireUtc(label: string, value: string): void {
  if (!isUtcIsoTimestamp(value)) {
    throw new LifecycleGuardError(
      "INVALID_TIMESTAMP",
      `${label} must be a valid UTC ISO-8601 timestamp`,
    );
  }
}

function requirePositiveAtomic(label: string, value: string): void {
  if (!isPositiveAtomicString(value)) {
    throw new LifecycleGuardError(
      "INVALID_AMOUNT",
      `${label} must be a positive atomic integer string`,
    );
  }
}

function requireNonNegAtomic(label: string, value: string): void {
  if (!isNonNegativeAtomicString(value)) {
    throw new LifecycleGuardError(
      "INVALID_AMOUNT",
      `${label} must be a non-negative atomic integer string`,
    );
  }
}

function appendHistory(
  record: LifecycleRecord,
  from: V2LifecycleState,
  to: V2LifecycleState,
  event: LifecycleEvent,
  reason?: string,
): LifecycleTransitionRecord[] {
  const entry: LifecycleTransitionRecord = {
    from,
    to,
    eventType: event.type,
    actionId: event.actionId,
    at: event.eventTime,
    ...(reason ? { reason } : {}),
  };
  return [...record.history, entry];
}

function withTransition(
  record: LifecycleRecord,
  to: V2LifecycleState,
  event: LifecycleEvent,
  patch: Partial<LifecycleRecord>,
  reason?: string,
): LifecycleRecord {
  assertLegalTransition(record.state, to);
  requireUtc("eventTime", event.eventTime);
  if (!event.actionId || event.actionId.length > 128) {
    throw new LifecycleGuardError("INVALID_ACTION_ID", "actionId is required");
  }

  const nextVersion = record.recordVersion + 1;
  const history = appendHistory(record, record.state, to, event, reason);
  const processed = {
    ...record.processedActions,
    [event.actionId]: {
      actionId: event.actionId,
      eventType: event.type,
      eventPayloadHash: eventPayloadHash(event),
      resultingState: to,
      recordVersionAfter: nextVersion,
      at: event.eventTime,
    },
  };

  return {
    ...record,
    ...patch,
    state: to,
    recordVersion: nextVersion,
    updatedAt: event.eventTime,
    lastActionId: event.actionId,
    history,
    processedActions: processed,
  };
}

function requireSealedShipperAuth(
  context: LifecycleReduceContext | undefined,
  event: LifecycleEvent,
  action: "ACCEPT" | "REQUEST_CORRECTION" | "REJECT_DISPUTE",
): VerifiedShipperReviewAuth {
  const auth = context?.verifiedAuth;
  if (!auth || !isSealedVerifiedAuth(auth) || auth.kind !== "SHIPPER_POD_REVIEW") {
    throw new LifecycleGuardError(
      "SHIPPER_AUTH_REQUIRED",
      "sealed shipper authorization is required",
    );
  }
  if (auth.actionId !== event.actionId) {
    throw new LifecycleGuardError(
      "AUTH_ACTION_MISMATCH",
      "verified auth actionId does not match event",
    );
  }
  if (auth.reviewAction !== action) {
    throw new LifecycleGuardError(
      "AUTH_ACTION_MISMATCH",
      "verified auth review action does not match event",
    );
  }
  return auth;
}

function requireSealedRefereeAuth(
  context: LifecycleReduceContext | undefined,
  event: LifecycleEvent,
): VerifiedRefereeResolutionAuth {
  const auth = context?.verifiedAuth;
  if (!auth || !isSealedVerifiedAuth(auth) || auth.kind !== "REFEREE_RESOLUTION") {
    throw new LifecycleGuardError(
      "REFEREE_AUTH_REQUIRED",
      "sealed referee authorization is required",
    );
  }
  if (auth.actionId !== event.actionId) {
    throw new LifecycleGuardError(
      "AUTH_ACTION_MISMATCH",
      "verified auth actionId does not match event",
    );
  }
  return auth;
}

/**
 * Apply one lifecycle event. Pure: returns a new record.
 * Does not implement CAS / store persistence.
 * Signed transitions require sealed verifiedAuth from the verification service.
 */
export function reduceLifecycle(
  record: LifecycleRecord,
  event: LifecycleEvent,
  context: LifecycleReduceContext = {},
): LifecycleRecord {
  requireUtc("eventTime", event.eventTime);

  // Advisory anchor never authorizes state change (except storing hash).
  if (event.type === "POD_ADVISORY_ANCHORED") {
    if (event.binding !== "NON_BINDING_ADVISORY") {
      throw new LifecycleGuardError(
        "ADVISORY_BINDING",
        "advisory must be NON_BINDING_ADVISORY",
      );
    }
    // Store hash without state transition / version bump for settlement —
    // still records action for idempotency with a same-state "transition".
    if (record.state === "TENDER_COMPLETED") {
      throw new LifecycleGuardError(
        "TERMINAL",
        "cannot anchor advisory on completed tender",
      );
    }
    const nextVersion = record.recordVersion + 1;
    return {
      ...record,
      advisoryReportHash: event.reportHash,
      recordVersion: nextVersion,
      updatedAt: event.eventTime,
      lastActionId: event.actionId,
      processedActions: {
        ...record.processedActions,
        [event.actionId]: {
          actionId: event.actionId,
          eventType: event.type,
          eventPayloadHash: eventPayloadHash(event),
          resultingState: record.state,
          recordVersionAfter: nextVersion,
          at: event.eventTime,
        },
      },
      history: [
        ...record.history,
        {
          from: record.state,
          to: record.state,
          eventType: event.type,
          actionId: event.actionId,
          at: event.eventTime,
          reason: "NON_BINDING_ADVISORY_HASH_ONLY",
        },
      ],
    };
  }

  switch (event.type) {
    case "ESCROW_FUNDING_CONFIRMED": {
      if (record.state !== "DRAFT") {
        throw new IllegalLifecycleTransitionError(
          record.state,
          "ESCROW_FUNDED",
        );
      }
      if (event.tenderId !== record.tenderId) {
        throw new LifecycleGuardError("TENDER_MISMATCH", "tenderId mismatch");
      }
      if (event.tenderVersion !== record.tenderVersion) {
        throw new LifecycleGuardError(
          "TENDER_VERSION_MISMATCH",
          "tenderVersion mismatch",
        );
      }
      if (event.tokenId !== ACCESS_FEE_TOKEN_ID) {
        throw new LifecycleGuardError(
          "TOKEN_MISMATCH",
          `token must be ${ACCESS_FEE_TOKEN_ID}`,
        );
      }
      if (!event.fundingTxId) {
        throw new LifecycleGuardError(
          "MISSING_FUNDING_REF",
          "fundingTxId required",
        );
      }
      requirePositiveAtomic("fundedAmountAtomic", event.fundedAmountAtomic);
      if (
        BigInt(event.fundedAmountAtomic) <
        BigInt(record.maximumFreightBudgetAtomic)
      ) {
        throw new LifecycleGuardError(
          "INSUFFICIENT_FUNDING",
          "funded amount must be >= maximumFreightBudgetAtomic",
        );
      }
      return withTransition(record, "ESCROW_FUNDED", event, {
        fundingTxId: event.fundingTxId,
        fundedAmountAtomic: event.fundedAmountAtomic,
      });
    }

    case "TENDER_ACTIVATION_PAID": {
      if (record.state !== "ESCROW_FUNDED") {
        throw new IllegalLifecycleTransitionError(
          record.state,
          "TENDER_OPENED",
        );
      }
      if (event.accessActionType !== "TENDER_ACTIVATE") {
        throw new LifecycleGuardError(
          "ACCESS_ACTION",
          "accessActionType must be TENDER_ACTIVATE",
        );
      }
      if (event.asset !== ACCESS_FEE_TOKEN_ID) {
        throw new LifecycleGuardError(
          "ACCESS_ASSET",
          `asset must be ${ACCESS_FEE_TOKEN_ID}`,
        );
      }
      const expectedFee = deriveAccessFeeAtomic();
      if (event.amountAtomic !== expectedFee) {
        throw new LifecycleGuardError(
          "ACCESS_AMOUNT",
          `amountAtomic must be ${expectedFee}`,
        );
      }
      const expectedResource = tenderActivateResource(
        record.tenderId,
        record.tenderVersion,
      );
      if (event.resource !== expectedResource) {
        throw new LifecycleGuardError(
          "ACCESS_RESOURCE",
          `resource must bind tenderId+version: expected ${expectedResource}`,
        );
      }
      if (event.payTo !== record.trust.accessTreasuryAccountId) {
        throw new LifecycleGuardError(
          "ACCESS_TREASURY",
          "payTo must equal configured access treasury account",
        );
      }
      if (!event.paymentTransactionId || !event.paymentPayloadHash) {
        throw new LifecycleGuardError(
          "ACCESS_PAYMENT",
          "payment transaction and payload hash required",
        );
      }
      return withTransition(record, "TENDER_OPENED", event, {
        activationPaymentTxId: event.paymentTransactionId,
      });
    }

    case "BIDDING_STARTED": {
      if (record.state !== "TENDER_OPENED") {
        throw new IllegalLifecycleTransitionError(record.state, "BIDDING");
      }
      return withTransition(record, "BIDDING", event, {});
    }

    case "AUCTION_CLOSE_CONFIRMED": {
      if (record.state !== "BIDDING") {
        throw new IllegalLifecycleTransitionError(
          record.state,
          "AUCTION_CLOSED",
        );
      }
      requireUtc("auctionEndsAt", event.auctionEndsAt);
      if (event.auctionEndsAt !== record.auctionEndsAt) {
        throw new LifecycleGuardError(
          "AUCTION_ENDS_MISMATCH",
          "auctionEndsAt must match tender",
        );
      }
      if (!isBeforeOrEqualUtc(record.auctionEndsAt, event.eventTime)) {
        throw new LifecycleGuardError(
          "AUCTION_NOT_ENDED",
          "eventTime must be at or after auctionEndsAt",
        );
      }
      if (!event.closureProofRef || !event.authoritativeBidSetHash) {
        throw new LifecycleGuardError(
          "CLOSURE_PROOF",
          "closureProofRef and authoritativeBidSetHash required",
        );
      }
      return withTransition(record, "AUCTION_CLOSED", event, {
        closureProofRef: event.closureProofRef,
        authoritativeBidSetHash: event.authoritativeBidSetHash,
      });
    }

    case "NO_QUALIFIED_BID_CONFIRMED": {
      if (record.state !== "AUCTION_CLOSED") {
        throw new IllegalLifecycleTransitionError(
          record.state,
          "NO_QUALIFIED_BID",
        );
      }
      if (!event.decisionManifestHash) {
        throw new LifecycleGuardError(
          "MANIFEST",
          "decisionManifestHash required",
        );
      }
      return withTransition(record, "NO_QUALIFIED_BID", event, {
        decisionManifestHash: event.decisionManifestHash,
        winningBidId: null,
        winningAmountAtomic: null,
      });
    }

    case "WINNER_SELECTION_CONFIRMED": {
      if (record.state !== "AUCTION_CLOSED") {
        throw new IllegalLifecycleTransitionError(
          record.state,
          "WINNER_SELECTED",
        );
      }
      if (
        !event.decisionManifestHash ||
        !event.winningBidId ||
        !event.winningCarrierId ||
        !event.winningCarrierAccount
      ) {
        throw new LifecycleGuardError(
          "WINNER_FIELDS",
          "winner selection fields incomplete",
        );
      }
      requirePositiveAtomic("winningAmountAtomic", event.winningAmountAtomic);
      if (event.selectionPolicy !== "LOWEST_QUALIFIED_PRICE_V1") {
        throw new LifecycleGuardError(
          "SELECTION_POLICY",
          "selectionPolicy must be LOWEST_QUALIFIED_PRICE_V1",
        );
      }
      if (
        BigInt(event.winningAmountAtomic) >
        BigInt(record.maximumFreightBudgetAtomic)
      ) {
        throw new LifecycleGuardError(
          "WIN_ABOVE_BUDGET",
          "winningAmountAtomic exceeds maximumFreightBudgetAtomic",
        );
      }
      return withTransition(record, "WINNER_SELECTED", event, {
        decisionManifestHash: event.decisionManifestHash,
        winningBidId: event.winningBidId,
        winningCarrierId: event.winningCarrierId,
        winningCarrierAccount: event.winningCarrierAccount,
        winningAmountAtomic: event.winningAmountAtomic,
      });
    }

    case "WINNING_AMOUNT_ALLOCATION_CONFIRMED": {
      if (record.state !== "WINNER_SELECTED") {
        throw new IllegalLifecycleTransitionError(
          record.state,
          "WINNING_AMOUNT_LOCKED",
        );
      }
      if (!event.allocateTxId) {
        throw new LifecycleGuardError(
          "ALLOCATE_REF",
          "allocateTxId required",
        );
      }
      requirePositiveAtomic("maxBudgetAtomic", event.maxBudgetAtomic);
      requirePositiveAtomic("winningAmountAtomic", event.winningAmountAtomic);
      requireNonNegAtomic("excessRefundAtomic", event.excessRefundAtomic);
      if (event.maxBudgetAtomic !== record.maximumFreightBudgetAtomic) {
        throw new LifecycleGuardError(
          "BUDGET_MISMATCH",
          "maxBudgetAtomic must match maximumFreightBudgetAtomic",
        );
      }
      if (
        record.winningAmountAtomic &&
        event.winningAmountAtomic !== record.winningAmountAtomic
      ) {
        throw new LifecycleGuardError(
          "WIN_AMOUNT_MISMATCH",
          "winningAmountAtomic must match selected winner",
        );
      }
      if (
        record.decisionManifestHash &&
        event.decisionManifestHash !== record.decisionManifestHash
      ) {
        throw new LifecycleGuardError(
          "MANIFEST_MISMATCH",
          "decisionManifestHash must match winner selection",
        );
      }
      const max = BigInt(event.maxBudgetAtomic);
      const win = BigInt(event.winningAmountAtomic);
      const excess = BigInt(event.excessRefundAtomic);
      if (win + excess !== max) {
        throw new LifecycleGuardError(
          "CONSERVATION",
          "winningAmountAtomic + excessRefundAtomic must equal maxBudgetAtomic",
        );
      }
      if (excess === 0n && event.refundExcessTxId !== null) {
        throw new LifecycleGuardError(
          "REFUND_TX",
          "refundExcessTxId must be null when excess is 0",
        );
      }
      if (excess > 0n && !event.refundExcessTxId) {
        throw new LifecycleGuardError(
          "REFUND_TX",
          "refundExcessTxId required when excess > 0",
        );
      }
      return withTransition(record, "WINNING_AMOUNT_LOCKED", event, {
        lockedAmountAtomic: event.winningAmountAtomic,
        excessRefundAtomic: event.excessRefundAtomic,
        allocateTxId: event.allocateTxId,
        refundExcessTxId: event.refundExcessTxId,
        decisionManifestHash: event.decisionManifestHash,
        winningAmountAtomic: event.winningAmountAtomic,
      });
    }

    case "ROUTE_RESERVATION_PUBLISHED": {
      if (record.state !== "WINNING_AMOUNT_LOCKED") {
        throw new IllegalLifecycleTransitionError(
          record.state,
          "ROUTE_RESERVED",
        );
      }
      if (!event.reservationEvidenceRef || !event.hcsPublicationRef) {
        throw new LifecycleGuardError(
          "RESERVATION_EVIDENCE",
          "reservation publication evidence required",
        );
      }
      return withTransition(record, "ROUTE_RESERVED", event, {
        reservationEvidenceRef: event.reservationEvidenceRef,
      });
    }

    case "TRANSIT_STARTED": {
      if (record.state !== "ROUTE_RESERVED") {
        throw new IllegalLifecycleTransitionError(record.state, "IN_TRANSIT");
      }
      return withTransition(record, "IN_TRANSIT", event, {});
    }

    case "DELIVERY_REPORTED": {
      if (record.state !== "IN_TRANSIT") {
        throw new IllegalLifecycleTransitionError(
          record.state,
          "DELIVERY_REPORTED",
        );
      }
      return withTransition(record, "DELIVERY_REPORTED", event, {});
    }

    case "POD_PACKAGE_SUBMITTED": {
      if (record.state !== "DELIVERY_REPORTED") {
        throw new IllegalLifecycleTransitionError(
          record.state,
          "POD_SUBMITTED",
        );
      }
      if (!event.podId || !event.contentHash || !event.ciphertextHash) {
        throw new LifecycleGuardError(
          "POD_FIELDS",
          "podId, contentHash, ciphertextHash required",
        );
      }
      return withTransition(record, "POD_SUBMITTED", event, {
        podId: event.podId,
        podContentHash: event.contentHash,
      });
    }

    case "POD_REVIEW_STARTED": {
      if (record.state === "POD_SUBMITTED") {
        const reviewDeadlineAt = computeReviewDeadline(event.eventTime);
        return withTransition(record, "POD_UNDER_REVIEW", event, {
          reviewStartedAt: event.eventTime,
          reviewDeadlineAt,
          shipperActionTaken: false,
          correctionDeadlineAt: null,
        });
      }
      if (record.state === "POD_RESUBMITTED") {
        const reviewDeadlineAt = computePostResubmitReviewDeadline(
          event.eventTime,
        );
        return withTransition(record, "POD_UNDER_REVIEW", event, {
          reviewStartedAt: event.eventTime,
          reviewDeadlineAt,
          shipperActionTaken: false,
          correctionDeadlineAt: null,
        });
      }
      throw new IllegalLifecycleTransitionError(
        record.state,
        "POD_UNDER_REVIEW",
      );
    }

    case "POD_CORRECTION_REQUESTED": {
      if (record.state !== "POD_UNDER_REVIEW") {
        throw new IllegalLifecycleTransitionError(
          record.state,
          "POD_CORRECTION_REQUESTED",
        );
      }
      if (!event.reasons || event.reasons.length < 1) {
        throw new LifecycleGuardError(
          "CORRECTION_REASONS",
          "structured correction reasons required",
        );
      }
      if (!record.reviewDeadlineAt) {
        throw new LifecycleGuardError(
          "NO_REVIEW_DEADLINE",
          "reviewDeadlineAt missing",
        );
      }
      if (event.reviewDeadlineAt !== record.reviewDeadlineAt) {
        throw new LifecycleGuardError(
          "DEADLINE_BIND",
          "reviewDeadlineAt must match bound deadline",
        );
      }
      if (!isBeforeOrEqualUtc(event.eventTime, record.reviewDeadlineAt)) {
        throw new LifecycleGuardError(
          "AFTER_REVIEW_DEADLINE",
          "correction request must be at or before review deadline",
        );
      }
      if (!record.podId) {
        throw new LifecycleGuardError("POD_REQUIRED", "podId missing on record");
      }
      const auth = requireSealedShipperAuth(
        context,
        event,
        "REQUEST_CORRECTION",
      );
      if (auth.signPayload.podId !== record.podId) {
        throw new LifecycleGuardError("POD_MISMATCH", "auth podId mismatch");
      }
      if (
        auth.signPayload.tenderId !== record.tenderId ||
        auth.signPayload.tenderVersion !== record.tenderVersion
      ) {
        throw new LifecycleGuardError("TENDER_MISMATCH", "auth tender mismatch");
      }
      return withTransition(record, "POD_CORRECTION_REQUESTED", event, {
        correctionDeadlineAt: computeCorrectionDeadline(event.eventTime),
        shipperActionTaken: true,
        lastShipperAuthPayloadHash: auth.payloadHash,
        lastShipperKeyFingerprint: auth.trustedKeyFingerprint,
      });
    }

    case "POD_PACKAGE_RESUBMITTED": {
      if (record.state !== "POD_CORRECTION_REQUESTED") {
        throw new IllegalLifecycleTransitionError(
          record.state,
          "POD_RESUBMITTED",
        );
      }
      if (!record.correctionDeadlineAt) {
        throw new LifecycleGuardError(
          "NO_CORRECTION_DEADLINE",
          "correctionDeadlineAt missing",
        );
      }
      if (!isBeforeOrEqualUtc(event.eventTime, record.correctionDeadlineAt)) {
        throw new LifecycleGuardError(
          "AFTER_CORRECTION_DEADLINE",
          "resubmission must be at or before correction deadline",
        );
      }
      if (!event.podId || !event.contentHash) {
        throw new LifecycleGuardError(
          "POD_FIELDS",
          "podId and contentHash required",
        );
      }
      return withTransition(record, "POD_RESUBMITTED", event, {
        podId: event.podId,
        podContentHash: event.contentHash,
      });
    }

    case "POD_ACCEPTED_BY_SHIPPER": {
      if (record.state !== "POD_UNDER_REVIEW") {
        throw new IllegalLifecycleTransitionError(
          record.state,
          "POD_ACCEPTED",
        );
      }
      if (!record.reviewDeadlineAt) {
        throw new LifecycleGuardError(
          "NO_REVIEW_DEADLINE",
          "reviewDeadlineAt missing",
        );
      }
      if (event.reviewDeadlineAt !== record.reviewDeadlineAt) {
        throw new LifecycleGuardError(
          "DEADLINE_BIND",
          "reviewDeadlineAt must match bound deadline",
        );
      }
      if (!isBeforeOrEqualUtc(event.eventTime, record.reviewDeadlineAt)) {
        throw new LifecycleGuardError(
          "AFTER_REVIEW_DEADLINE",
          "acceptance must be at or before review deadline",
        );
      }
      if (!record.podId) {
        throw new LifecycleGuardError("POD_REQUIRED", "podId missing on record");
      }
      const auth = requireSealedShipperAuth(context, event, "ACCEPT");
      if (auth.signPayload.podId !== record.podId) {
        throw new LifecycleGuardError("POD_MISMATCH", "auth podId mismatch");
      }
      if (
        auth.signPayload.tenderId !== record.tenderId ||
        auth.signPayload.tenderVersion !== record.tenderVersion
      ) {
        throw new LifecycleGuardError("TENDER_MISMATCH", "auth tender mismatch");
      }
      return withTransition(record, "POD_ACCEPTED", event, {
        shipperActionTaken: true,
        lastShipperAuthPayloadHash: auth.payloadHash,
        lastShipperKeyFingerprint: auth.trustedKeyFingerprint,
      });
    }

    case "POD_REVIEW_DEADLINE_EXPIRED": {
      if (record.state !== "POD_UNDER_REVIEW") {
        throw new IllegalLifecycleTransitionError(
          record.state,
          "POD_DEEMED_ACCEPTED",
        );
      }
      if (!record.reviewDeadlineAt) {
        throw new LifecycleGuardError(
          "NO_REVIEW_DEADLINE",
          "reviewDeadlineAt missing",
        );
      }
      if (!isBeforeOrEqualUtc(record.reviewDeadlineAt, event.eventTime)) {
        throw new LifecycleGuardError(
          "BEFORE_REVIEW_DEADLINE",
          "deemed acceptance requires eventTime at or after review deadline",
        );
      }
      if (record.shipperActionTaken) {
        throw new LifecycleGuardError(
          "SHIPPER_ALREADY_ACTED",
          "cannot deem accept after a prior shipper action",
        );
      }
      return withTransition(record, "POD_DEEMED_ACCEPTED", event, {});
    }

    case "POD_CORRECTION_DEADLINE_EXPIRED": {
      if (record.state !== "POD_CORRECTION_REQUESTED") {
        throw new IllegalLifecycleTransitionError(
          record.state,
          "POD_DISPUTED",
        );
      }
      if (!record.correctionDeadlineAt) {
        throw new LifecycleGuardError(
          "NO_CORRECTION_DEADLINE",
          "correctionDeadlineAt missing",
        );
      }
      if (!isBeforeOrEqualUtc(record.correctionDeadlineAt, event.eventTime)) {
        throw new LifecycleGuardError(
          "BEFORE_CORRECTION_DEADLINE",
          "correction timeout requires eventTime at or after correction deadline",
        );
      }
      return withTransition(record, "POD_DISPUTED", event, {
        disputeId: `dispute-timeout-${event.actionId}`,
      });
    }

    case "POD_REJECTED_TO_DISPUTE": {
      if (record.state !== "POD_UNDER_REVIEW") {
        throw new IllegalLifecycleTransitionError(
          record.state,
          "POD_DISPUTED",
        );
      }
      if (!event.reasons || event.reasons.length < 1) {
        throw new LifecycleGuardError(
          "REJECT_REASONS",
          "structured rejection reasons required",
        );
      }
      if (!event.disputeId) {
        throw new LifecycleGuardError(
          "REJECT_FIELDS",
          "disputeId required",
        );
      }
      if (!record.reviewDeadlineAt) {
        throw new LifecycleGuardError(
          "NO_REVIEW_DEADLINE",
          "reviewDeadlineAt missing",
        );
      }
      if (event.reviewDeadlineAt !== record.reviewDeadlineAt) {
        throw new LifecycleGuardError(
          "DEADLINE_BIND",
          "reviewDeadlineAt must match bound deadline",
        );
      }
      if (!isBeforeOrEqualUtc(event.eventTime, record.reviewDeadlineAt)) {
        throw new LifecycleGuardError(
          "AFTER_REVIEW_DEADLINE",
          "rejection must be at or before review deadline",
        );
      }
      if (!record.podId) {
        throw new LifecycleGuardError("POD_REQUIRED", "podId missing on record");
      }
      const auth = requireSealedShipperAuth(context, event, "REJECT_DISPUTE");
      if (auth.signPayload.podId !== record.podId) {
        throw new LifecycleGuardError("POD_MISMATCH", "auth podId mismatch");
      }
      if (
        auth.signPayload.tenderId !== record.tenderId ||
        auth.signPayload.tenderVersion !== record.tenderVersion
      ) {
        throw new LifecycleGuardError("TENDER_MISMATCH", "auth tender mismatch");
      }
      return withTransition(record, "POD_DISPUTED", event, {
        disputeId: event.disputeId,
        shipperActionTaken: true,
        lastShipperAuthPayloadHash: auth.payloadHash,
        lastShipperKeyFingerprint: auth.trustedKeyFingerprint,
      });
    }

    case "REFEREE_RESOLUTION_RECORDED": {
      if (record.state !== "POD_DISPUTED") {
        throw new IllegalLifecycleTransitionError(
          record.state,
          "REFEREE_DECISION",
        );
      }
      if (event.signerKind !== "HUMAN_REFEREE") {
        throw new LifecycleGuardError(
          "AI_SIGNER",
          "AI signer is not permitted",
        );
      }
      const auth = requireSealedRefereeAuth(context, event);
      if (auth.refereeId !== event.refereeId) {
        throw new LifecycleGuardError(
          "REFEREE_ID_MISMATCH",
          "verified refereeId does not match event",
        );
      }
      if (auth.disputeId !== event.disputeId || auth.podId !== event.podId) {
        throw new LifecycleGuardError(
          "AUTH_BINDING",
          "verified dispute/pod does not match event",
        );
      }
      if (
        auth.resolution !== event.resolution ||
        auth.releaseAmountAtomic !== event.releaseAmountAtomic ||
        auth.refundAmountAtomic !== event.refundAmountAtomic
      ) {
        throw new LifecycleGuardError(
          "AUTH_AMOUNT_MISMATCH",
          "verified resolution amounts do not match event",
        );
      }
      if (record.disputeId && event.disputeId !== record.disputeId) {
        throw new LifecycleGuardError(
          "DISPUTE_MISMATCH",
          "disputeId mismatch",
        );
      }
      if (record.podId && event.podId !== record.podId) {
        throw new LifecycleGuardError("POD_MISMATCH", "podId mismatch");
      }
      if (
        auth.signPayload.tenderId !== record.tenderId ||
        auth.signPayload.tenderVersion !== record.tenderVersion
      ) {
        throw new LifecycleGuardError("TENDER_MISMATCH", "auth tender mismatch");
      }
      requireNonNegAtomic("releaseAmountAtomic", event.releaseAmountAtomic);
      requireNonNegAtomic("refundAmountAtomic", event.refundAmountAtomic);
      const locked = BigInt(record.lockedAmountAtomic ?? "0");
      const rel = BigInt(event.releaseAmountAtomic);
      const ref = BigInt(event.refundAmountAtomic);
      if (rel + ref !== locked) {
        throw new LifecycleGuardError(
          "CONSERVATION",
          "release + refund must equal locked amount",
        );
      }
      if (event.resolution === "RELEASE_FULL" && ref !== 0n) {
        throw new LifecycleGuardError(
          "RESOLUTION_AMOUNTS",
          "RELEASE_FULL requires refund 0",
        );
      }
      if (event.resolution === "REFUND_FULL" && rel !== 0n) {
        throw new LifecycleGuardError(
          "RESOLUTION_AMOUNTS",
          "REFUND_FULL requires release 0",
        );
      }
      if (event.resolution === "PARTIAL" && rel === 0n && ref === 0n) {
        throw new LifecycleGuardError(
          "RESOLUTION_AMOUNTS",
          "PARTIAL requires a positive split",
        );
      }
      return withTransition(record, "REFEREE_DECISION", event, {
        refereeResolution: event.resolution,
        releaseAmountAtomic: event.releaseAmountAtomic,
        refundAmountAtomic: event.refundAmountAtomic,
        resolutionPayloadHash: auth.payloadHash,
        refereeId: auth.refereeId,
        refereeKeyFingerprint: auth.trustedKeyFingerprint,
        disputeId: event.disputeId,
      });
    }

    case "ESCROW_RELEASE_CONFIRMED": {
      const okFrom =
        record.state === "POD_ACCEPTED" ||
        record.state === "POD_DEEMED_ACCEPTED" ||
        (record.state === "REFEREE_DECISION" &&
          record.refereeResolution === "RELEASE_FULL");
      if (!okFrom) {
        throw new IllegalLifecycleTransitionError(
          record.state,
          "PAYMENT_RELEASED",
        );
      }
      if (!event.releaseTxId) {
        throw new LifecycleGuardError("RELEASE_TX", "releaseTxId required");
      }
      requirePositiveAtomic("releaseAmountAtomic", event.releaseAmountAtomic);
      const locked =
        record.lockedAmountAtomic ?? record.winningAmountAtomic;
      if (!locked) {
        throw new LifecycleGuardError(
          "LOCKED_MISSING",
          "locked amount required for release",
        );
      }
      if (event.releaseAmountAtomic !== locked) {
        throw new LifecycleGuardError(
          "RELEASE_AMOUNT",
          "releaseAmountAtomic must equal locked amount",
        );
      }
      // When releasing after referee full release, amounts must match decision.
      if (record.state === "REFEREE_DECISION") {
        if (record.refereeResolution !== "RELEASE_FULL") {
          throw new LifecycleGuardError(
            "RESOLUTION_MISMATCH",
            "full release requires RELEASE_FULL decision",
          );
        }
        if (
          record.releaseAmountAtomic !== event.releaseAmountAtomic ||
          record.refundAmountAtomic !== "0"
        ) {
          throw new LifecycleGuardError(
            "DECISION_AMOUNT_MISMATCH",
            "release must exactly match verified referee decision",
          );
        }
      }
      return withTransition(record, "PAYMENT_RELEASED", event, {
        releaseTxId: event.releaseTxId,
        releaseAmountAtomic: event.releaseAmountAtomic,
        refundAmountAtomic: "0",
      });
    }

    case "ESCROW_PARTIAL_RELEASE_CONFIRMED": {
      if (
        record.state !== "REFEREE_DECISION" ||
        record.refereeResolution !== "PARTIAL"
      ) {
        throw new IllegalLifecycleTransitionError(
          record.state,
          "PARTIAL_RELEASE",
        );
      }
      requireNonNegAtomic("releaseAmountAtomic", event.releaseAmountAtomic);
      requireNonNegAtomic("refundAmountAtomic", event.refundAmountAtomic);
      const locked = BigInt(record.lockedAmountAtomic ?? "0");
      if (
        BigInt(event.releaseAmountAtomic) + BigInt(event.refundAmountAtomic) !==
        locked
      ) {
        throw new LifecycleGuardError(
          "CONSERVATION",
          "partial release + refund must equal locked amount",
        );
      }
      if (
        event.releaseAmountAtomic !== record.releaseAmountAtomic ||
        event.refundAmountAtomic !== record.refundAmountAtomic
      ) {
        throw new LifecycleGuardError(
          "DECISION_AMOUNT_MISMATCH",
          "partial settlement must exactly match verified referee decision",
        );
      }
      if (!event.releaseTxId || !event.refundTxId) {
        throw new LifecycleGuardError(
          "PARTIAL_TX",
          "releaseTxId and refundTxId required",
        );
      }
      return withTransition(record, "PARTIAL_RELEASE", event, {
        releaseTxId: event.releaseTxId,
        refundTxId: event.refundTxId,
        releaseAmountAtomic: event.releaseAmountAtomic,
        refundAmountAtomic: event.refundAmountAtomic,
      });
    }

    case "ESCROW_REFUND_CONFIRMED": {
      const okFrom =
        record.state === "NO_QUALIFIED_BID" ||
        (record.state === "REFEREE_DECISION" &&
          record.refereeResolution === "REFUND_FULL");
      if (!okFrom) {
        throw new IllegalLifecycleTransitionError(record.state, "REFUNDED");
      }
      if (!event.refundTxId) {
        throw new LifecycleGuardError("REFUND_TX", "refundTxId required");
      }
      requirePositiveAtomic("refundAmountAtomic", event.refundAmountAtomic);
      if (record.state === "NO_QUALIFIED_BID") {
        if (event.refundAmountAtomic !== record.maximumFreightBudgetAtomic) {
          throw new LifecycleGuardError(
            "REFUND_AMOUNT",
            "full budget refund required for NO_QUALIFIED_BID",
          );
        }
      } else {
        if (record.refereeResolution !== "REFUND_FULL") {
          throw new LifecycleGuardError(
            "RESOLUTION_MISMATCH",
            "full refund requires REFUND_FULL decision",
          );
        }
        if (
          record.refundAmountAtomic !== event.refundAmountAtomic ||
          record.releaseAmountAtomic !== "0"
        ) {
          throw new LifecycleGuardError(
            "DECISION_AMOUNT_MISMATCH",
            "refund must exactly match verified referee decision",
          );
        }
        if (
          record.lockedAmountAtomic &&
          event.refundAmountAtomic !== record.lockedAmountAtomic
        ) {
          throw new LifecycleGuardError(
            "REFUND_AMOUNT",
            "refund must equal locked amount",
          );
        }
      }
      return withTransition(record, "REFUNDED", event, {
        refundTxId: event.refundTxId,
        refundAmountAtomic: event.refundAmountAtomic,
        releaseAmountAtomic: "0",
      });
    }

    case "TENDER_COMPLETION_CONFIRMED": {
      if (
        record.state !== "PAYMENT_RELEASED" &&
        record.state !== "PARTIAL_RELEASE" &&
        record.state !== "REFUNDED"
      ) {
        throw new IllegalLifecycleTransitionError(
          record.state,
          "TENDER_COMPLETED",
        );
      }
      return withTransition(record, "TENDER_COMPLETED", event, {});
    }

    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      throw new LifecycleGuardError(
        "UNKNOWN_EVENT",
        "unsupported lifecycle event",
      );
    }
  }
}

/**
 * Count of directed legal edges in the transition graph (excluding self-loops).
 */
export function countLegalTransitions(): number {
  let n = 0;
  for (const [, tos] of LEGAL) {
    n += tos.length;
  }
  return n;
}
