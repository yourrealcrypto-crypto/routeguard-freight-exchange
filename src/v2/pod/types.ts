/**
 * POD package types — synthetic demo data only; no real personal data required.
 */

export const POD_DOCUMENT_TYPES = [
  "ELECTRONIC_DELIVERY_RECEIPT",
  "ECMR_EPOD",
  "RECIPIENT_CONFIRMATION",
  "DELIVERY_IMAGE",
  "CARGO_CONDITION_EVIDENCE",
  "EXCEPTION_DOCUMENT",
  "STRUCTURED_DELIVERY_METADATA",
] as const;

export type PodDocumentType = (typeof POD_DOCUMENT_TYPES)[number];

export const POD_CARGO_CONDITION_CODES = [
  "GOOD",
  "DAMAGED",
  "PARTIAL",
  "SEAL_BROKEN",
  "OTHER",
] as const;

export type PodCargoConditionCode = (typeof POD_CARGO_CONDITION_CODES)[number];

export const POD_EXCEPTION_CODES = [
  "NONE",
  "DAMAGED",
  "SHORTAGE",
  "LATE",
  "SEAL_MISMATCH",
  "OTHER_STRUCTURED",
] as const;

export type PodExceptionCode = (typeof POD_EXCEPTION_CODES)[number];

/** One file as submitted by the carrier (in-memory / request body). */
export type PodFileInput = {
  readonly fileId: string;
  readonly documentType: PodDocumentType;
  readonly filename: string;
  readonly mimeType: string;
  /** Raw file bytes (never logged). */
  readonly bytes: Uint8Array;
};

/** Canonical manifest entry — ordered deterministically by fileId. */
export type PodManifestEntry = {
  readonly fileId: string;
  readonly documentType: PodDocumentType;
  readonly storageName: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly plaintextSha256: string;
};

export type PodCanonicalManifest = {
  readonly entries: readonly PodManifestEntry[];
  readonly documentCount: number;
  readonly totalBytes: number;
};

/** Structured POD package fields bound by the carrier signature. */
export type PodPackageFields = {
  readonly podId: string;
  readonly podVersion: number;
  readonly tenderId: string;
  readonly tenderVersion: number;
  readonly winningBidId: string;
  readonly escrowTenderKey: string;
  readonly carrierId: string;
  readonly carrierAccountId: string;
  readonly deliveryTimestamp: string;
  readonly recipientConfirmationPresent: boolean;
  readonly cargoConditionCode: PodCargoConditionCode;
  readonly exceptionCodes: readonly PodExceptionCode[];
  readonly submittedAt: string;
  readonly actionId: string;
};

export type SignedPodPackage = PodPackageFields & {
  readonly files: readonly PodFileInput[];
  readonly carrierSignature: string;
  /** Optional pre-computed hashes for verification after signing. */
  readonly manifestHash?: string;
  readonly packageContentHash?: string;
};

export type PublicPodReceipt = {
  readonly podId: string;
  readonly podVersion: number;
  readonly tenderId: string;
  readonly tenderVersion: number;
  readonly state: string;
  readonly manifestHash: string;
  readonly packageContentHash: string;
  readonly ciphertextHash: string;
  readonly submittedAt: string;
  readonly reviewEligible: boolean;
};

export type PodAdvisoryRecommendation =
  | "ACCEPT"
  | "REQUEST_CORRECTION"
  | "MANUAL_REVIEW";

export type PodAdvisoryFinding = {
  readonly code: string;
  readonly severity: "INFO" | "WARN" | "FAIL";
  readonly message: string;
  readonly evidenceRef?: string;
};

export type PodAdvisoryReport = {
  readonly reportId: string;
  readonly podId: string;
  readonly podVersion: number;
  readonly tenderId: string;
  readonly engine: string;
  readonly binding: "NON_BINDING_ADVISORY";
  readonly recommendation: PodAdvisoryRecommendation;
  readonly findings: readonly PodAdvisoryFinding[];
  readonly reportHash: string;
  readonly createdAt: string;
};
