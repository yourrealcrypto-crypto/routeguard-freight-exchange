/**
 * POD package encode/decode for encrypted storage plaintext.
 */

import { canonicalize } from "../../domain/canonical-hash";
import { PodError } from "./errors";
import type { PodFileInput, PodPackageFields } from "./types";

export type PodPlaintextPackage = {
  readonly fields: PodPackageFields;
  readonly files: readonly {
    readonly fileId: string;
    readonly documentType: string;
    readonly filename: string;
    readonly mimeType: string;
    readonly contentBase64: string;
  }[];
  readonly carrierSignature: string;
  readonly manifestHash: string;
  readonly packageContentHash: string;
};

export function encodePlaintextPackage(input: {
  fields: PodPackageFields;
  files: readonly PodFileInput[];
  carrierSignature: string;
  manifestHash: string;
  packageContentHash: string;
}): Uint8Array {
  // Pick only structured fields — callers may pass a SignedPodPackage that also
  // carries `files` / `carrierSignature` / hash fields.
  const f = input.fields;
  const fieldsOnly: PodPackageFields = {
    podId: f.podId,
    podVersion: f.podVersion,
    tenderId: f.tenderId,
    tenderVersion: f.tenderVersion,
    winningBidId: f.winningBidId,
    escrowTenderKey: f.escrowTenderKey,
    carrierId: f.carrierId,
    carrierAccountId: f.carrierAccountId,
    deliveryTimestamp: f.deliveryTimestamp,
    recipientConfirmationPresent: f.recipientConfirmationPresent,
    cargoConditionCode: f.cargoConditionCode,
    exceptionCodes: [...f.exceptionCodes],
    submittedAt: f.submittedAt,
    actionId: f.actionId,
  };
  const body: PodPlaintextPackage = {
    fields: fieldsOnly,
    files: input.files.map((file) => ({
      fileId: file.fileId,
      documentType: file.documentType,
      filename: file.filename,
      mimeType: file.mimeType,
      contentBase64: Buffer.from(file.bytes).toString("base64"),
    })),
    carrierSignature: input.carrierSignature,
    manifestHash: input.manifestHash,
    packageContentHash: input.packageContentHash,
  };
  // Deterministic JSON for stable ciphertext across equivalent packages.
  return new Uint8Array(Buffer.from(canonicalize(body), "utf8"));
}

export function decodePlaintextPackage(bytes: Uint8Array): {
  fields: PodPackageFields;
  files: PodFileInput[];
  carrierSignature: string;
  manifestHash: string;
  packageContentHash: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new PodError("POD_DECRYPTION_FAILED", "plaintext package JSON invalid");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new PodError("POD_DECRYPTION_FAILED", "plaintext package shape invalid");
  }
  const p = parsed as PodPlaintextPackage;
  if (!p.fields || !Array.isArray(p.files)) {
    throw new PodError("POD_DECRYPTION_FAILED", "plaintext package incomplete");
  }
  const files: PodFileInput[] = p.files.map((f) => ({
    fileId: f.fileId,
    documentType: f.documentType as PodFileInput["documentType"],
    filename: f.filename,
    mimeType: f.mimeType,
    bytes: new Uint8Array(Buffer.from(f.contentBase64, "base64")),
  }));
  return {
    fields: p.fields,
    files,
    carrierSignature: p.carrierSignature,
    manifestHash: p.manifestHash,
    packageContentHash: p.packageContentHash,
  };
}
