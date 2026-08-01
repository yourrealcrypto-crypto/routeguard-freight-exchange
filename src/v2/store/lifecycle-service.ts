/**
 * Lifecycle service: verification + pure reduce + CAS + action-id idempotency.
 * Trust policy is injected; events cannot supply allowlists or treasury authority.
 */

import type { CarrierRegistry } from "../../domain/carrier";
import {
  AuthorizationError,
  verifyCarrierBid,
  verifyRefereeResolution,
  verifyShipperPodReview,
  type VerifiedAuth,
} from "../auth/verify";
import {
  LifecycleActionConflictError,
  LifecycleNotFoundError,
} from "../lifecycle/errors";
import type { LifecycleEvent } from "../lifecycle/events";
import {
  eventPayloadHash,
  reduceLifecycle,
} from "../lifecycle/reducer";
import type {
  CreateLifecycleInput,
  LifecycleRecord,
} from "../lifecycle/record";
import { trustPolicyFromRecord } from "../lifecycle/record";
import type { TrustPolicy } from "../trust/policy";
import type { LifecycleStore } from "./lifecycle-store";

export type ApplyLifecycleResult = {
  readonly record: LifecycleRecord;
  readonly outcome: "APPLIED" | "REPLAYED";
};

export type LifecycleServiceOptions = {
  /**
   * Trusted carrier registry used to verify paid bid submissions.
   * Required before any BID_SUBMISSION_PAID event can be applied.
   */
  readonly carriers?: CarrierRegistry;
};

export class LifecycleService {
  private readonly carriers: CarrierRegistry | undefined;

  constructor(
    private readonly store: LifecycleStore,
    options?: LifecycleServiceOptions,
  ) {
    this.carriers = options?.carriers;
  }

  async create(input: CreateLifecycleInput): Promise<LifecycleRecord> {
    return this.store.create(input);
  }

  async get(tenderId: string): Promise<LifecycleRecord | null> {
    return this.store.get(tenderId);
  }

  /**
   * Apply an event with action-id idempotency.
   * Signed events are cryptographically verified before reduction.
   */
  async apply(
    tenderId: string,
    event: LifecycleEvent,
  ): Promise<ApplyLifecycleResult> {
    const current = await this.store.get(tenderId);
    if (!current) {
      throw new LifecycleNotFoundError(tenderId);
    }

    const prior = current.processedActions[event.actionId];
    if (prior) {
      const hash = eventPayloadHash(event);
      if (prior.eventPayloadHash !== hash) {
        throw new LifecycleActionConflictError(event.actionId);
      }
      return { record: current, outcome: "REPLAYED" };
    }

    const policy = trustPolicyFromRecord(current);
    const verifiedAuth = verifyEventIfNeeded(
      current,
      event,
      policy,
      this.carriers,
    );
    const next = reduceLifecycle(
      current,
      event,
      verifiedAuth ? { verifiedAuth } : {},
    );
    const persisted = await this.store.compareAndSet(
      tenderId,
      current.recordVersion,
      next,
    );
    return { record: persisted, outcome: "APPLIED" };
  }
}

function verifyEventIfNeeded(
  record: LifecycleRecord,
  event: LifecycleEvent,
  policy: TrustPolicy,
  carriers?: CarrierRegistry,
): VerifiedAuth | undefined {
  switch (event.type) {
    case "BID_SUBMISSION_PAID": {
      const carrier = carriers?.getById(event.carrierId);
      if (!carrier || !carrier.active) {
        throw new AuthorizationError(
          "CARRIER_NOT_TRUSTED",
          "carrier is not present in the trusted registry",
        );
      }
      if (carrier.carrierAccountId !== event.carrierAccountId) {
        throw new AuthorizationError(
          "CARRIER_ACCOUNT_MISMATCH",
          "carrier account does not match the trusted registry",
        );
      }
      return verifyCarrierBid({
        registeredPublicKey: carrier.signingPublicKey,
        tenderId: record.tenderId,
        tenderVersion: record.tenderVersion,
        bidId: event.bidId,
        carrierId: event.carrierId,
        carrierAccountId: event.carrierAccountId,
        bidHash: event.bidHash,
        signedAt: event.signedAt,
        actionId: event.actionId,
        signature: event.carrierSignature,
      });
    }
    case "POD_ACCEPTED_BY_SHIPPER": {
      if (!record.podId || !record.reviewDeadlineAt) {
        return undefined; // reducer will fail closed on missing state
      }
      return verifyShipperPodReview({
        policy,
        tenderId: record.tenderId,
        tenderVersion: record.tenderVersion,
        podId: record.podId,
        reviewAction: "ACCEPT",
        signedAt: event.signedAt,
        reviewDeadlineAt: event.reviewDeadlineAt,
        actionId: event.actionId,
        signature: event.shipperSignature,
      });
    }
    case "POD_CORRECTION_REQUESTED": {
      if (!record.podId) return undefined;
      return verifyShipperPodReview({
        policy,
        tenderId: record.tenderId,
        tenderVersion: record.tenderVersion,
        podId: record.podId,
        reviewAction: "REQUEST_CORRECTION",
        reasonCodes: event.reasons.map((r) => r.code),
        signedAt: event.signedAt,
        reviewDeadlineAt: event.reviewDeadlineAt,
        actionId: event.actionId,
        signature: event.shipperSignature,
      } as const);
    }
    case "POD_REJECTED_TO_DISPUTE": {
      if (!record.podId) return undefined;
      return verifyShipperPodReview({
        policy,
        tenderId: record.tenderId,
        tenderVersion: record.tenderVersion,
        podId: record.podId,
        reviewAction: "REJECT_DISPUTE",
        reasonCodes: event.reasons.map((r) => r.code),
        signedAt: event.signedAt,
        reviewDeadlineAt: event.reviewDeadlineAt,
        actionId: event.actionId,
        signature: event.shipperSignature,
      } as const);
    }
    case "REFEREE_RESOLUTION_RECORDED": {
      return verifyRefereeResolution({
        policy,
        tenderId: record.tenderId,
        tenderVersion: record.tenderVersion,
        podId: event.podId,
        disputeId: event.disputeId,
        resolution: event.resolution,
        releaseAmountAtomic: event.releaseAmountAtomic,
        refundAmountAtomic: event.refundAmountAtomic,
        rationaleCode: event.rationaleCode,
        refereeId: event.refereeId,
        signedAt: event.signedAt,
        actionId: event.actionId,
        signature: event.signature,
        ...(event.refereePublicKey !== undefined
          ? { eventPublicKey: event.refereePublicKey }
          : {}),
      });
    }
    default:
      return undefined;
  }
}
