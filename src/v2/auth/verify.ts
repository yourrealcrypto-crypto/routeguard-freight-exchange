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
  buildCarrierBidSignPayload,
  buildCarrierPodSubmissionSignPayload,
  buildRefereeResolutionSignPayload,
  buildShipperPodReviewSignPayload,
  CARRIER_BID_PURPOSE,
  CARRIER_POD_SUBMISSION_PURPOSE,
  REFEREE_RESOLUTION_PURPOSE,
  SHIPPER_POD_REVIEW_PURPOSE,
  signPayloadHash,
  type CarrierBidSignPayload,
  type CarrierPodSubmissionSignPayload,
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

export type VerifiedCarrierBidAuth = {
  readonly kind: "CARRIER_BID";
  readonly purpose: typeof CARRIER_BID_PURPOSE;
  readonly actionId: string;
  readonly bidId: string;
  readonly carrierId: string;
  readonly carrierAccountId: string;
  readonly bidHash: string;
  readonly payloadHash: string;
  readonly trustedKeyFingerprint: string;
  readonly signatureAlgorithm: "ECDSA_SECP256K1_HIERO";
  readonly signPayload: CarrierBidSignPayload;
};

export type VerifiedCarrierPodAuth = {
  readonly kind: "CARRIER_POD_SUBMISSION";
  readonly purpose: typeof CARRIER_POD_SUBMISSION_PURPOSE;
  readonly actionId: string;
  readonly podId: string;
  readonly podVersion: number;
  readonly payloadHash: string;
  readonly trustedKeyFingerprint: string;
  readonly signatureAlgorithm: "ECDSA_SECP256K1_HIERO";
  readonly signPayload: CarrierPodSubmissionSignPayload;
};

export type VerifiedAuth =
  | VerifiedShipperReviewAuth
  | VerifiedRefereeResolutionAuth
  | VerifiedCarrierBidAuth
  | VerifiedCarrierPodAuth;

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

/**
 * Verify a carrier bid signature against the **registered** carrier key.
 * A public key supplied by the request is never trusted.
 */
export function verifyCarrierBid(input: {
  registeredPublicKey: string;
  tenderId: string;
  tenderVersion: number;
  bidId: string;
  carrierId: string;
  carrierAccountId: string;
  bidHash: string;
  signedAt: string;
  actionId: string;
  signature: string;
}): VerifiedCarrierBidAuth {
  if (!input.signature || typeof input.signature !== "string") {
    throw new AuthorizationError(
      "MISSING_SIGNATURE",
      "carrier bid signature required",
    );
  }
  if (!input.registeredPublicKey) {
    throw new AuthorizationError(
      "CARRIER_NOT_REGISTERED",
      "carrier has no registered signing key",
    );
  }
  const signPayload = buildCarrierBidSignPayload({
    tenderId: input.tenderId,
    tenderVersion: input.tenderVersion,
    bidId: input.bidId,
    carrierId: input.carrierId,
    carrierAccountId: input.carrierAccountId,
    bidHash: input.bidHash,
    signedAt: input.signedAt,
    actionId: input.actionId,
  });
  const ok = verifyCanonicalPayload(
    signPayload,
    input.signature,
    input.registeredPublicKey,
  );
  if (!ok) {
    throw new AuthorizationError(
      "CARRIER_SIGNATURE_INVALID",
      "carrier bid signature verification failed",
    );
  }
  return seal({
    kind: "CARRIER_BID" as const,
    purpose: CARRIER_BID_PURPOSE,
    actionId: input.actionId,
    bidId: input.bidId,
    carrierId: input.carrierId,
    carrierAccountId: input.carrierAccountId,
    bidHash: input.bidHash,
    payloadHash: signPayloadHash(signPayload),
    trustedKeyFingerprint: publicKeyFingerprint(input.registeredPublicKey),
    signatureAlgorithm: "ECDSA_SECP256K1_HIERO" as const,
    signPayload,
  });
}

/**
 * Verify a carrier POD submission signature against the registered carrier key.
 */
export function verifyCarrierPodSubmission(input: {
  registeredPublicKey: string;
  podId: string;
  podVersion: number;
  tenderId: string;
  tenderVersion: number;
  winningBidId: string;
  escrowTenderKey: string;
  carrierId: string;
  carrierAccountId: string;
  deliveryTimestamp: string;
  manifestHash: string;
  packageContentHash: string;
  submittedAt: string;
  actionId: string;
  signature: string;
}): VerifiedCarrierPodAuth {
  if (!input.signature || typeof input.signature !== "string") {
    throw new AuthorizationError(
      "MISSING_SIGNATURE",
      "carrier POD signature required",
    );
  }
  if (!input.registeredPublicKey) {
    throw new AuthorizationError(
      "CARRIER_NOT_REGISTERED",
      "carrier has no registered signing key",
    );
  }
  const signPayload = buildCarrierPodSubmissionSignPayload({
    podId: input.podId,
    podVersion: input.podVersion,
    tenderId: input.tenderId,
    tenderVersion: input.tenderVersion,
    winningBidId: input.winningBidId,
    escrowTenderKey: input.escrowTenderKey,
    carrierId: input.carrierId,
    carrierAccountId: input.carrierAccountId,
    deliveryTimestamp: input.deliveryTimestamp,
    manifestHash: input.manifestHash,
    packageContentHash: input.packageContentHash,
    submittedAt: input.submittedAt,
    actionId: input.actionId,
  });
  const ok = verifyCanonicalPayload(
    signPayload,
    input.signature,
    input.registeredPublicKey,
  );
  if (!ok) {
    throw new AuthorizationError(
      "POD_SIGNATURE_INVALID",
      "carrier POD signature verification failed",
    );
  }
  return seal({
    kind: "CARRIER_POD_SUBMISSION" as const,
    purpose: CARRIER_POD_SUBMISSION_PURPOSE,
    actionId: input.actionId,
    podId: input.podId,
    podVersion: input.podVersion,
    payloadHash: signPayloadHash(signPayload),
    trustedKeyFingerprint: publicKeyFingerprint(input.registeredPublicKey),
    signatureAlgorithm: "ECDSA_SECP256K1_HIERO" as const,
    signPayload,
  });
}

/** Test helper — sign a carrier bid payload with an ephemeral private key. */
export function signCarrierBidForTests(
  privateKeyHex: string,
  payload: CarrierBidSignPayload,
): string {
  return signCanonicalPayload(payload, privateKeyHex);
}

/** Test helper — sign a carrier POD submission payload. */
export function signCarrierPodForTests(
  privateKeyHex: string,
  payload: CarrierPodSubmissionSignPayload,
): string {
  return signCanonicalPayload(payload, privateKeyHex);
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
