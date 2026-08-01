/**
 * AES-256-GCM POD payload encryption — pure functions, no env reads.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { PodError } from "./errors";
import { sha256Digest, sha256Hex } from "./manifest";

export const POD_CONTENT_ALG = "AES-256-GCM" as const;
export const POD_IV_BYTES = 12 as const;
export const POD_KEY_BYTES = 32 as const;
export const POD_TAG_BYTES = 16 as const;

export type PodAadBinding = {
  readonly tenderId: string;
  readonly tenderVersion: number;
  readonly podId: string;
  readonly podVersion: number;
  readonly manifestHash: string;
};

export type PodEncryptResult = {
  readonly ciphertext: Uint8Array;
  readonly iv: Uint8Array;
  readonly authTag: Uint8Array;
  readonly dataKey: Uint8Array;
  readonly ciphertextHash: string;
  readonly aadHash: string;
  readonly aadBytes: Uint8Array;
};

export function buildAadBytes(aad: PodAadBinding): Uint8Array {
  // Stable UTF-8 binding — not JSON, to keep encrypt boundary simple.
  const text = [
    "ROUTEGUARD_V2_POD_AAD_V1",
    aad.tenderId,
    String(aad.tenderVersion),
    aad.podId,
    String(aad.podVersion),
    aad.manifestHash,
  ].join("|");
  return new Uint8Array(Buffer.from(text, "utf8"));
}

export function encryptPodPayload(input: {
  readonly plaintext: Uint8Array;
  readonly aad: PodAadBinding;
  readonly dataKey?: Uint8Array;
  readonly iv?: Uint8Array;
}): PodEncryptResult {
  try {
    const dataKey = input.dataKey ?? randomBytes(POD_KEY_BYTES);
    const iv = input.iv ?? randomBytes(POD_IV_BYTES);
    if (dataKey.length !== POD_KEY_BYTES) {
      throw new PodError("POD_ENCRYPTION_FAILED", "data key length invalid");
    }
    if (iv.length !== POD_IV_BYTES) {
      throw new PodError("POD_ENCRYPTION_FAILED", "iv length invalid");
    }
    const aadBytes = buildAadBytes(input.aad);
    const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
    cipher.setAAD(Buffer.from(aadBytes));
    const enc = Buffer.concat([
      cipher.update(Buffer.from(input.plaintext)),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    const ciphertext = new Uint8Array(enc);
    return {
      ciphertext,
      iv: new Uint8Array(iv),
      authTag: new Uint8Array(authTag),
      dataKey: new Uint8Array(dataKey),
      ciphertextHash: sha256Digest(ciphertext),
      aadHash: sha256Digest(aadBytes),
      aadBytes,
    };
  } catch (err) {
    if (err instanceof PodError) throw err;
    throw new PodError("POD_ENCRYPTION_FAILED", "encryption failed");
  }
}

export function decryptPodPayload(input: {
  readonly ciphertext: Uint8Array;
  readonly iv: Uint8Array;
  readonly authTag: Uint8Array;
  readonly dataKey: Uint8Array;
  readonly aad: PodAadBinding;
}): Uint8Array {
  try {
    const aadBytes = buildAadBytes(input.aad);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(input.dataKey),
      Buffer.from(input.iv),
    );
    decipher.setAAD(Buffer.from(aadBytes));
    decipher.setAuthTag(Buffer.from(input.authTag));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(input.ciphertext)),
      decipher.final(),
    ]);
    return new Uint8Array(dec);
  } catch {
    throw new PodError("POD_DECRYPTION_FAILED", "decryption or authentication failed");
  }
}

export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function decodeBase64(value: string): Uint8Array {
  const buf = Buffer.from(value, "base64");
  if (buf.length === 0 && value.length > 0) {
    throw new PodError("POD_STORAGE_CORRUPT", "invalid base64");
  }
  return new Uint8Array(buf);
}

export function assertNotEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return true;
  return sha256Hex(a) !== sha256Hex(b);
}
