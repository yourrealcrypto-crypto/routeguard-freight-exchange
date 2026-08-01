/**
 * Canonical POD manifest and package content hashing.
 * Order is always sorted by fileId — never filesystem or multipart order.
 */

import { createHash } from "node:crypto";

import { canonicalSha256 } from "../../domain/canonical-hash";
import { PodError } from "./errors";
import {
  assertMimeAllowed,
  assertSafeFilename,
  DEFAULT_POD_FILE_POLICY,
  type PodContentScanner,
  type PodFilePolicy,
} from "./policy";
import type {
  PodCanonicalManifest,
  PodFileInput,
  PodManifestEntry,
  PodPackageFields,
} from "./types";
import { POD_CARGO_CONDITION_CODES, POD_DOCUMENT_TYPES, POD_EXCEPTION_CODES } from "./types";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Digest(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`;
}

function storageNameFor(file: PodFileInput): string {
  const safe = assertSafeFilename(file.filename);
  return `${file.fileId}__${safe}`;
}

export async function buildCanonicalManifest(
  files: readonly PodFileInput[],
  policy: PodFilePolicy = DEFAULT_POD_FILE_POLICY,
  scanner?: PodContentScanner,
): Promise<PodCanonicalManifest> {
  if (!Array.isArray(files) || files.length === 0) {
    throw new PodError("POD_INVALID", "POD package requires at least one file");
  }
  if (files.length > policy.maxFiles) {
    throw new PodError("POD_TOO_LARGE", "file count exceeds policy limit");
  }

  const seenIds = new Set<string>();
  let totalBytes = 0;
  const built: PodManifestEntry[] = [];

  for (const file of files) {
    if (!file.fileId || !/^[A-Za-z0-9._-]{1,64}$/.test(file.fileId)) {
      throw new PodError("POD_INVALID", "fileId invalid");
    }
    if (seenIds.has(file.fileId)) {
      throw new PodError("POD_INVALID", "duplicate fileId");
    }
    seenIds.add(file.fileId);

    if (
      !(POD_DOCUMENT_TYPES as readonly string[]).includes(file.documentType)
    ) {
      throw new PodError("POD_INVALID", "documentType not permitted");
    }
    assertMimeAllowed(file.mimeType, policy);
    assertSafeFilename(file.filename);

    if (!(file.bytes instanceof Uint8Array)) {
      throw new PodError("POD_INVALID", "file bytes required");
    }
    if (file.bytes.length === 0) {
      throw new PodError("POD_INVALID", "empty file rejected");
    }
    if (file.bytes.length > policy.maxFileBytes) {
      throw new PodError("POD_TOO_LARGE", "per-file size limit exceeded");
    }
    totalBytes += file.bytes.length;
    if (totalBytes > policy.maxPackageBytes) {
      throw new PodError("POD_TOO_LARGE", "total package size limit exceeded");
    }

    if (scanner) {
      const scan = await scanner.scan({
        fileId: file.fileId,
        mimeType: file.mimeType,
        bytes: file.bytes,
      });
      if (!scan.ok) {
        throw new PodError("POD_SCAN_REJECTED", "content scan rejected file");
      }
    }

    built.push({
      fileId: file.fileId,
      documentType: file.documentType,
      storageName: storageNameFor(file),
      mimeType: file.mimeType,
      byteLength: file.bytes.length,
      plaintextSha256: sha256Digest(file.bytes),
    });
  }

  built.sort((a, b) =>
    a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0,
  );

  return Object.freeze({
    entries: Object.freeze(built),
    documentCount: built.length,
    totalBytes,
  });
}

export function manifestHash(manifest: PodCanonicalManifest): string {
  return canonicalSha256({
    documentCount: manifest.documentCount,
    totalBytes: manifest.totalBytes,
    entries: manifest.entries.map((e) => ({
      fileId: e.fileId,
      documentType: e.documentType,
      storageName: e.storageName,
      mimeType: e.mimeType,
      byteLength: e.byteLength,
      plaintextSha256: e.plaintextSha256,
    })),
  });
}

/**
 * Package content hash: sorted fileId → plaintext digest map + field snapshot.
 * Independent of upload/multipart order.
 */
export function packageContentHash(
  fields: PodPackageFields,
  manifest: PodCanonicalManifest,
): string {
  return canonicalSha256({
    podId: fields.podId,
    podVersion: fields.podVersion,
    tenderId: fields.tenderId,
    tenderVersion: fields.tenderVersion,
    winningBidId: fields.winningBidId,
    escrowTenderKey: fields.escrowTenderKey,
    carrierId: fields.carrierId,
    carrierAccountId: fields.carrierAccountId,
    deliveryTimestamp: fields.deliveryTimestamp,
    recipientConfirmationPresent: fields.recipientConfirmationPresent,
    cargoConditionCode: fields.cargoConditionCode,
    exceptionCodes: [...fields.exceptionCodes].sort(),
    submittedAt: fields.submittedAt,
    actionId: fields.actionId,
    manifestHash: manifestHash(manifest),
    files: manifest.entries.map((e) => ({
      fileId: e.fileId,
      plaintextSha256: e.plaintextSha256,
      byteLength: e.byteLength,
    })),
  });
}

export function assertPackageFields(fields: PodPackageFields): void {
  const idRe = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$/;
  for (const [label, value] of [
    ["podId", fields.podId],
    ["tenderId", fields.tenderId],
    ["winningBidId", fields.winningBidId],
    ["carrierId", fields.carrierId],
    ["carrierAccountId", fields.carrierAccountId],
    ["actionId", fields.actionId],
  ] as const) {
    if (typeof value !== "string" || !idRe.test(value)) {
      throw new PodError("POD_INVALID", `${label} invalid`);
    }
  }
  if (
    !Number.isInteger(fields.podVersion) ||
    fields.podVersion < 1 ||
    fields.podVersion > 0xffff
  ) {
    throw new PodError("POD_INVALID", "podVersion invalid");
  }
  if (
    !Number.isInteger(fields.tenderVersion) ||
    fields.tenderVersion < 1
  ) {
    throw new PodError("POD_INVALID", "tenderVersion invalid");
  }
  if (
    typeof fields.escrowTenderKey !== "string" ||
    !/^0x[0-9a-f]{64}$/.test(fields.escrowTenderKey)
  ) {
    throw new PodError("POD_INVALID", "escrowTenderKey must be bytes32 hex");
  }
  if (
    !(POD_CARGO_CONDITION_CODES as readonly string[]).includes(
      fields.cargoConditionCode,
    )
  ) {
    throw new PodError("POD_INVALID", "cargoConditionCode invalid");
  }
  for (const code of fields.exceptionCodes) {
    if (!(POD_EXCEPTION_CODES as readonly string[]).includes(code)) {
      throw new PodError("POD_INVALID", "exception code invalid");
    }
  }
}
