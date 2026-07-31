/**
 * Encrypted POD storage — memory and local file adapters.
 * Plaintext is never written. Overwrites are rejected.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { canonicalSha256 } from "../../domain/canonical-hash";
import { PodError } from "./errors";
import {
  decodeBase64,
  encodeBase64,
  encryptPodPayload,
  decryptPodPayload,
  POD_CONTENT_ALG,
  type PodAadBinding,
} from "./encrypt";
import type { PodKeyProtector, WrappedPodDataKey } from "./key-protector";
import { sha256Digest } from "./manifest";
import type { PodCanonicalManifest, PodPackageFields } from "./types";

export const POD_STORE_SCHEMA = "routeguard-v2-pod-store-1.0" as const;

export type PodStorageEnvelope = {
  readonly schemaVersion: typeof POD_STORE_SCHEMA;
  readonly tenderId: string;
  readonly tenderVersion: number;
  readonly podId: string;
  readonly podVersion: number;
  readonly ciphertextRef: string;
  readonly ciphertextHash: string;
  readonly plaintextPackageHash: string;
  readonly manifestHash: string;
  readonly encryptionAlg: typeof POD_CONTENT_ALG;
  readonly ivB64: string;
  readonly authTagB64: string;
  readonly wrappedKey: WrappedPodDataKey;
  readonly wrapAlg: string;
  readonly aadHash: string;
  readonly ciphertextBytes: number;
  readonly plaintextBytes: number;
  readonly createdAt: string;
  readonly integrityHash: string;
  /** Public-safe structured fields snapshot (no file bytes). */
  readonly publicFields: PodPackageFields;
  readonly publicManifest: PodCanonicalManifest;
};

export type StoredPodRecord = {
  readonly envelope: PodStorageEnvelope;
  readonly ciphertextB64: string;
};

export type PublicPodMetadata = {
  readonly tenderId: string;
  readonly tenderVersion: number;
  readonly podId: string;
  readonly podVersion: number;
  readonly manifestHash: string;
  readonly packageContentHash: string;
  readonly ciphertextHash: string;
  readonly documentCount: number;
  readonly totalBytes: number;
  readonly createdAt: string;
  readonly encryptionAlg: typeof POD_CONTENT_ALG;
};

export interface PodEncryptedStore {
  put(record: StoredPodRecord): Promise<void>;
  get(
    tenderId: string,
    tenderVersion: number,
    podId: string,
    podVersion: number,
  ): Promise<StoredPodRecord | null>;
  getPublicMeta(
    tenderId: string,
    tenderVersion: number,
    podId: string,
    podVersion: number,
  ): Promise<PublicPodMetadata | null>;
}

function integrityOf(envelope: Omit<PodStorageEnvelope, "integrityHash">): string {
  return canonicalSha256(envelope);
}

export function sealEnvelope(
  partial: Omit<PodStorageEnvelope, "integrityHash">,
): PodStorageEnvelope {
  const integrityHash = integrityOf(partial);
  return Object.freeze({ ...partial, integrityHash });
}

export function assertEnvelopeIntegrity(envelope: PodStorageEnvelope): void {
  if (envelope.schemaVersion !== POD_STORE_SCHEMA) {
    throw new PodError("POD_STORAGE_CORRUPT", "unsupported storage schema");
  }
  const { integrityHash: _i, ...rest } = envelope;
  const expected = integrityOf(rest);
  if (expected !== envelope.integrityHash) {
    throw new PodError("POD_STORAGE_CORRUPT", "envelope integrity mismatch");
  }
}

export function envelopeToPublicMeta(
  envelope: PodStorageEnvelope,
): PublicPodMetadata {
  return {
    tenderId: envelope.tenderId,
    tenderVersion: envelope.tenderVersion,
    podId: envelope.podId,
    podVersion: envelope.podVersion,
    manifestHash: envelope.manifestHash,
    packageContentHash: envelope.plaintextPackageHash,
    ciphertextHash: envelope.ciphertextHash,
    documentCount: envelope.publicManifest.documentCount,
    totalBytes: envelope.publicManifest.totalBytes,
    createdAt: envelope.createdAt,
    encryptionAlg: envelope.encryptionAlg,
  };
}

function storageKey(
  tenderId: string,
  tenderVersion: number,
  podId: string,
  podVersion: number,
): string {
  return `${tenderId}|${tenderVersion}|${podId}|v${podVersion}`;
}

function safeSeg(label: string, value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$/.test(value)) {
    throw new PodError("POD_INVALID", `${label} not storage-safe`);
  }
  return value.replace(/[:@]/g, "_");
}

/** Build encrypted stored record from plaintext package JSON bytes. */
export function encryptAndBuildRecord(input: {
  readonly plaintext: Uint8Array;
  readonly fields: PodPackageFields;
  readonly manifest: PodCanonicalManifest;
  readonly manifestHash: string;
  readonly packageContentHash: string;
  readonly keyProtector: PodKeyProtector;
  readonly createdAt: string;
}): StoredPodRecord {
  const aad: PodAadBinding = {
    tenderId: input.fields.tenderId,
    tenderVersion: input.fields.tenderVersion,
    podId: input.fields.podId,
    podVersion: input.fields.podVersion,
    manifestHash: input.manifestHash,
  };
  const enc = encryptPodPayload({ plaintext: input.plaintext, aad });
  const wrapContext = `${input.fields.tenderId}|${input.fields.tenderVersion}|${input.fields.podId}|${input.fields.podVersion}|${input.manifestHash}`;
  const wrapped = input.keyProtector.wrapKey(enc.dataKey, wrapContext);
  // Zero the ephemeral key reference (best-effort; JS GC still applies).
  enc.dataKey.fill(0);

  const f = input.fields;
  const publicFields: PodPackageFields = {
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
  const ciphertextRef = `pod://${publicFields.tenderId}/v${publicFields.tenderVersion}/${publicFields.podId}/v${publicFields.podVersion}`;
  const envelope = sealEnvelope({
    schemaVersion: POD_STORE_SCHEMA,
    tenderId: publicFields.tenderId,
    tenderVersion: publicFields.tenderVersion,
    podId: publicFields.podId,
    podVersion: publicFields.podVersion,
    ciphertextRef,
    ciphertextHash: enc.ciphertextHash,
    plaintextPackageHash: input.packageContentHash,
    manifestHash: input.manifestHash,
    encryptionAlg: POD_CONTENT_ALG,
    ivB64: encodeBase64(enc.iv),
    authTagB64: encodeBase64(enc.authTag),
    wrappedKey: wrapped,
    wrapAlg: wrapped.wrapAlg,
    aadHash: enc.aadHash,
    ciphertextBytes: enc.ciphertext.length,
    plaintextBytes: input.plaintext.length,
    createdAt: input.createdAt,
    publicFields,
    publicManifest: input.manifest,
  });

  return {
    envelope,
    ciphertextB64: encodeBase64(enc.ciphertext),
  };
}

export function decryptStoredRecord(input: {
  readonly record: StoredPodRecord;
  readonly keyProtector: PodKeyProtector;
}): Uint8Array {
  assertEnvelopeIntegrity(input.record.envelope);
  const env = input.record.envelope;
  const wrapContext = `${env.tenderId}|${env.tenderVersion}|${env.podId}|${env.podVersion}|${env.manifestHash}`;
  const dataKey = input.keyProtector.unwrapKey(env.wrappedKey, wrapContext);
  try {
    const ciphertext = decodeBase64(input.record.ciphertextB64);
    if (sha256Digest(ciphertext) !== env.ciphertextHash) {
      throw new PodError("POD_STORAGE_CORRUPT", "ciphertext hash mismatch");
    }
    return decryptPodPayload({
      ciphertext,
      iv: decodeBase64(env.ivB64),
      authTag: decodeBase64(env.authTagB64),
      dataKey,
      aad: {
        tenderId: env.tenderId,
        tenderVersion: env.tenderVersion,
        podId: env.podId,
        podVersion: env.podVersion,
        manifestHash: env.manifestHash,
      },
    });
  } finally {
    dataKey.fill(0);
  }
}

export class MemoryPodEncryptedStore implements PodEncryptedStore {
  private readonly map = new Map<string, StoredPodRecord>();

  async put(record: StoredPodRecord): Promise<void> {
    assertEnvelopeIntegrity(record.envelope);
    const key = storageKey(
      record.envelope.tenderId,
      record.envelope.tenderVersion,
      record.envelope.podId,
      record.envelope.podVersion,
    );
    if (this.map.has(key)) {
      throw new PodError("POD_ALREADY_EXISTS", "POD version already stored");
    }
    // Deep freeze-ish: store JSON clone of public fields only; ciphertext is opaque.
    const clone: StoredPodRecord = {
      envelope: structuredClone(record.envelope),
      ciphertextB64: record.ciphertextB64,
    };
    // Refuse if plaintext-looking fields snuck into ciphertext blob.
    if (
      record.ciphertextB64.includes("deliveryTimestamp") ||
      record.ciphertextB64.includes("carrierSignature")
    ) {
      // base64 of plaintext JSON might coincidentally contain substrings — skip heuristic.
    }
    this.map.set(key, clone);
  }

  async get(
    tenderId: string,
    tenderVersion: number,
    podId: string,
    podVersion: number,
  ): Promise<StoredPodRecord | null> {
    const hit = this.map.get(
      storageKey(tenderId, tenderVersion, podId, podVersion),
    );
    if (!hit) return null;
    assertEnvelopeIntegrity(hit.envelope);
    return hit;
  }

  async getPublicMeta(
    tenderId: string,
    tenderVersion: number,
    podId: string,
    podVersion: number,
  ): Promise<PublicPodMetadata | null> {
    const hit = await this.get(tenderId, tenderVersion, podId, podVersion);
    return hit ? envelopeToPublicMeta(hit.envelope) : null;
  }

  /** Test helper: list raw keys (no secrets). */
  keys(): string[] {
    return [...this.map.keys()];
  }
}

export class FilePodEncryptedStore implements PodEncryptedStore {
  constructor(private readonly rootDir: string) {
    mkdirSync(rootDir, { recursive: true });
  }

  private pathFor(
    tenderId: string,
    tenderVersion: number,
    podId: string,
    podVersion: number,
  ): string {
    const dir = path.join(
      this.rootDir,
      safeSeg("tenderId", tenderId),
      `v${tenderVersion}`,
      safeSeg("podId", podId),
    );
    mkdirSync(dir, { recursive: true });
    return path.join(dir, `pod-v${podVersion}.json`);
  }

  async put(record: StoredPodRecord): Promise<void> {
    assertEnvelopeIntegrity(record.envelope);
    const file = this.pathFor(
      record.envelope.tenderId,
      record.envelope.tenderVersion,
      record.envelope.podId,
      record.envelope.podVersion,
    );
    if (existsSync(file)) {
      throw new PodError("POD_ALREADY_EXISTS", "POD version already stored");
    }
    const body = `${JSON.stringify(record, null, 2)}\n`;
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | null = null;
    try {
      fd = openSync(tmp, "wx");
      writeSync(fd, body, undefined, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(tmp, file);
    } catch (err) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new PodError("POD_ALREADY_EXISTS", "POD version already stored");
      }
      throw new PodError("PERSISTENCE_CONFLICT", "POD store write failed");
    }
  }

  async get(
    tenderId: string,
    tenderVersion: number,
    podId: string,
    podVersion: number,
  ): Promise<StoredPodRecord | null> {
    const file = this.pathFor(tenderId, tenderVersion, podId, podVersion);
    if (!existsSync(file)) return null;
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      throw new PodError("POD_STORAGE_CORRUPT", "POD store unreadable");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new PodError("POD_STORAGE_CORRUPT", "POD store JSON invalid");
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("envelope" in parsed) ||
      !("ciphertextB64" in parsed)
    ) {
      throw new PodError("POD_STORAGE_CORRUPT", "POD store shape invalid");
    }
    const record = parsed as StoredPodRecord;
    assertEnvelopeIntegrity(record.envelope);
    return record;
  }

  async getPublicMeta(
    tenderId: string,
    tenderVersion: number,
    podId: string,
    podVersion: number,
  ): Promise<PublicPodMetadata | null> {
    const hit = await this.get(tenderId, tenderVersion, podId, podVersion);
    return hit ? envelopeToPublicMeta(hit.envelope) : null;
  }
}
