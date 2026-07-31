/**
 * Domain-separated canonical signing payloads for v2 authorization.
 * Canonicalization uses repository canonicalize() (sorted keys).
 */

import { canonicalSha256, canonicalize } from "../../domain/canonical-hash";

export const AUTH_PROTOCOL_VERSION = "routeguard-v2-auth-1.0" as const;

export const SHIPPER_POD_REVIEW_PURPOSE =
  "ROUTEGUARD_V2_SHIPPER_POD_REVIEW" as const;

export const REFEREE_RESOLUTION_PURPOSE =
  "ROUTEGUARD_V2_REFEREE_RESOLUTION" as const;

export type ShipperReviewActionKind =
  | "ACCEPT"
  | "REQUEST_CORRECTION"
  | "REJECT_DISPUTE";

export type ShipperPodReviewSignPayload = {
  readonly protocolVersion: typeof AUTH_PROTOCOL_VERSION;
  readonly purpose: typeof SHIPPER_POD_REVIEW_PURPOSE;
  readonly tenderId: string;
  readonly tenderVersion: number;
  readonly podId: string;
  readonly reviewAction: ShipperReviewActionKind;
  readonly reasonCodes: readonly string[];
  readonly signedAt: string;
  readonly reviewDeadlineAt: string;
  readonly actionId: string;
};

export type RefereeResolutionSignPayload = {
  readonly protocolVersion: typeof AUTH_PROTOCOL_VERSION;
  readonly purpose: typeof REFEREE_RESOLUTION_PURPOSE;
  readonly tenderId: string;
  readonly tenderVersion: number;
  readonly podId: string;
  readonly disputeId: string;
  readonly resolution: "RELEASE_FULL" | "REFUND_FULL" | "PARTIAL";
  readonly releaseAmountAtomic: string;
  readonly refundAmountAtomic: string;
  readonly rationaleCode: string;
  readonly refereeId: string;
  readonly signedAt: string;
  readonly actionId: string;
};

export function buildShipperPodReviewSignPayload(input: {
  tenderId: string;
  tenderVersion: number;
  podId: string;
  reviewAction: ShipperReviewActionKind;
  reasonCodes?: readonly string[];
  signedAt: string;
  reviewDeadlineAt: string;
  actionId: string;
}): ShipperPodReviewSignPayload {
  const reasonCodes = Object.freeze(
    [...(input.reasonCodes ?? [])].map((c) => c).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return Object.freeze({
    protocolVersion: AUTH_PROTOCOL_VERSION,
    purpose: SHIPPER_POD_REVIEW_PURPOSE,
    tenderId: input.tenderId,
    tenderVersion: input.tenderVersion,
    podId: input.podId,
    reviewAction: input.reviewAction,
    reasonCodes,
    signedAt: input.signedAt,
    reviewDeadlineAt: input.reviewDeadlineAt,
    actionId: input.actionId,
  });
}

export function buildRefereeResolutionSignPayload(input: {
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
}): RefereeResolutionSignPayload {
  return Object.freeze({
    protocolVersion: AUTH_PROTOCOL_VERSION,
    purpose: REFEREE_RESOLUTION_PURPOSE,
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
}

export function canonicalSignPayloadJson(payload: unknown): string {
  return canonicalize(payload);
}

export function signPayloadHash(payload: unknown): string {
  return canonicalSha256(payload);
}
