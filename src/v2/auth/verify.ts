/**
 * Cryptographic verification for shipper review and referee resolutions.
 * Produces sealed authorization objects that cannot be forged by plain objects.
 */

import {
  signCanonicalPayload,
  verifyCanonicalPayload,
} from "../../domain/signature";
import {
  publicKeyFingerprint,
  resolveTrustedReferee,
  type TrustPolicy,
} from "../trust/policy";
import {
  buildRefereeResolutionSignPayload,
  buildShipperPodReviewSignPayload,
  REFEREE_RESOLUTION_PURPOSE,
  SHIPPER_POD_REVIEW_PURPOSE,
  signPayloadHash,
  type RefereeResolutionSignPayload,
  type ShipperPodReviewSignPayload,
  type ShipperReviewActionKind,
} from "./canonical";

const sealedAuth = new WeakSet<object>();

export type VerifiedShipperReviewAuth = {
  readonly kind: "SHIPPER_POD_REVIEW";
  readonly purpose: typeof SHIPPER_POD_REVIEW_PURPOSE;
  readonly actionId: string;
  readonly reviewAction: ShipperReviewActionKind;
  readonly payloadHash: string;
  readonly trustedKeyFingerprint: string;
  readonly signatureAlgorithm: "ECDSA_SECP256K1_HIERO";
  readonly signPayload: ShipperPodReviewSignPayload;
};

export type VerifiedRefereeResolutionAuth = {
  readonly kind: "REFEREE_RESOLUTION";
  readonly purpose: typeof REFEREE_RESOLUTION_PURPOSE;
  readonly actionId: string;
  readonly refereeId: string;
  readonly payloadHash: string;
  readonly trustedKeyFingerprint: string;
  readonly signatureAlgorithm: "ECDSA_SECP256K1_HIERO";
  readonly signPayload: RefereeResolutionSignPayload;
  readonly resolution: "RELEASE_FULL" | "REFUND_FULL" | "PARTIAL";
  readonly releaseAmountAtomic: string;
  readonly refundAmountAtomic: string;
  readonly disputeId: string;
  readonly podId: string;
};

export type VerifiedAuth =
  | VerifiedShipperReviewAuth
  | VerifiedRefereeResolutionAuth;

export function isSealedVerifiedAuth(value: unknown): value is VerifiedAuth {
  return typeof value === "object" && value !== null && sealedAuth.has(value);
}

function seal<T extends object>(value: T): T {
  sealedAuth.add(value);
  return Object.freeze(value);
}

export class AuthorizationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export function verifyShipperPodReview(input: {
  policy: TrustPolicy;
  tenderId: string;
  tenderVersion: number;
  podId: string;
  reviewAction: ShipperReviewActionKind;
  reasonCodes?: readonly string[];
  signedAt: string;
  reviewDeadlineAt: string;
  actionId: string;
  signature: string;
}): VerifiedShipperReviewAuth {
  if (!input.signature || typeof input.signature !== "string") {
    throw new AuthorizationError("MISSING_SIGNATURE", "shipper signature required");
  }
  const signPayload = buildShipperPodReviewSignPayload({
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
  const ok = verifyCanonicalPayload(
    signPayload,
    input.signature,
    input.policy.shipperPublicKey,
  );
  if (!ok) {
    throw new AuthorizationError(
      "SHIPPER_SIGNATURE_INVALID",
      "shipper signature verification failed",
    );
  }
  return seal({
    kind: "SHIPPER_POD_REVIEW" as const,
    purpose: SHIPPER_POD_REVIEW_PURPOSE,
    actionId: input.actionId,
    reviewAction: input.reviewAction,
    payloadHash: signPayloadHash(signPayload),
    trustedKeyFingerprint: publicKeyFingerprint(input.policy.shipperPublicKey),
    signatureAlgorithm: "ECDSA_SECP256K1_HIERO" as const,
    signPayload,
  });
}

export function verifyRefereeResolution(input: {
  policy: TrustPolicy;
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
  signature: string;
  /** If supplied, must exactly match the trusted key for refereeId. */
  eventPublicKey?: string;
}): VerifiedRefereeResolutionAuth {
  if (/^(ai|model|gpt|llm|assistant|bot)/i.test(input.refereeId) || input.refereeId === "AI") {
    throw new AuthorizationError(
      "AI_REFEREE",
      "AI/model identities cannot be referees",
    );
  }
  let trusted;
  try {
    trusted = resolveTrustedReferee(input.policy, input.refereeId);
  } catch (err: unknown) {
    throw new AuthorizationError(
      "REFEREE_NOT_TRUSTED",
      err instanceof Error ? err.message : "referee not trusted",
    );
  }
  if (
    input.eventPublicKey !== undefined &&
    input.eventPublicKey.trim() !== trusted.publicKey
  ) {
    throw new AuthorizationError(
      "REFEREE_KEY_MISMATCH",
      "event public key does not match trusted registry key",
    );
  }
  if (!input.signature || typeof input.signature !== "string") {
    throw new AuthorizationError(
      "MISSING_SIGNATURE",
      "referee signature required",
    );
  }
  const signPayload = buildRefereeResolutionSignPayload({
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
  const ok = verifyCanonicalPayload(
    signPayload,
    input.signature,
    trusted.publicKey,
  );
  if (!ok) {
    throw new AuthorizationError(
      "REFEREE_SIGNATURE_INVALID",
      "referee signature verification failed",
    );
  }
  return seal({
    kind: "REFEREE_RESOLUTION" as const,
    purpose: REFEREE_RESOLUTION_PURPOSE,
    actionId: input.actionId,
    refereeId: input.refereeId,
    payloadHash: signPayloadHash(signPayload),
    trustedKeyFingerprint: publicKeyFingerprint(trusted.publicKey),
    signatureAlgorithm: "ECDSA_SECP256K1_HIERO" as const,
    signPayload,
    resolution: input.resolution,
    releaseAmountAtomic: input.releaseAmountAtomic,
    refundAmountAtomic: input.refundAmountAtomic,
    disputeId: input.disputeId,
    podId: input.podId,
  });
}

/** Test helper — sign shipper payload with ephemeral private key. */
export function signShipperPodReviewForTests(
  privateKeyHex: string,
  payload: ShipperPodReviewSignPayload,
): string {
  return signCanonicalPayload(payload, privateKeyHex);
}

/** Test helper — sign referee payload with ephemeral private key. */
export function signRefereeResolutionForTests(
  privateKeyHex: string,
  payload: RefereeResolutionSignPayload,
): string {
  return signCanonicalPayload(payload, privateKeyHex);
}
