/**
 * POD data-key protection boundary.
 * Outer composition supplies the 32-byte master key; pure functions never read env.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { PodError } from "./errors";
import { encodeBase64, decodeBase64, POD_IV_BYTES, POD_KEY_BYTES } from "./encrypt";

export const POD_WRAP_ALG = "AES-256-GCM-WRAP-V1" as const;

export type WrappedPodDataKey = {
  readonly wrapAlg: typeof POD_WRAP_ALG;
  readonly wrappedKeyB64: string;
  readonly wrapIvB64: string;
  readonly wrapTagB64: string;
};

export interface PodKeyProtector {
  wrapKey(dataKey: Uint8Array, context: string): WrappedPodDataKey;
  unwrapKey(wrapped: WrappedPodDataKey, context: string): Uint8Array;
}

/**
 * AES-256-GCM wrap of the per-POD data key under an application master key.
 * Context (tender/pod/version) is AAD so a wrapped key cannot be transplanted.
 */
export class AesGcmMasterKeyProtector implements PodKeyProtector {
  constructor(private readonly masterKey: Uint8Array) {
    if (masterKey.length !== POD_KEY_BYTES) {
      throw new PodError(
        "POD_KEY_CONFIG",
        "master key must be exactly 32 bytes",
      );
    }
  }

  wrapKey(dataKey: Uint8Array, context: string): WrappedPodDataKey {
    if (dataKey.length !== POD_KEY_BYTES) {
      throw new PodError("POD_ENCRYPTION_FAILED", "data key length invalid");
    }
    const iv = randomBytes(POD_IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.masterKey, iv);
    cipher.setAAD(Buffer.from(`POD_KEY_WRAP|${context}`, "utf8"));
    const enc = Buffer.concat([cipher.update(Buffer.from(dataKey)), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      wrapAlg: POD_WRAP_ALG,
      wrappedKeyB64: encodeBase64(enc),
      wrapIvB64: encodeBase64(iv),
      wrapTagB64: encodeBase64(tag),
    };
  }

  unwrapKey(wrapped: WrappedPodDataKey, context: string): Uint8Array {
    if (wrapped.wrapAlg !== POD_WRAP_ALG) {
      throw new PodError("POD_DECRYPTION_FAILED", "unsupported wrap algorithm");
    }
    try {
      const iv = decodeBase64(wrapped.wrapIvB64);
      const tag = decodeBase64(wrapped.wrapTagB64);
      const ciphertext = decodeBase64(wrapped.wrappedKeyB64);
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.masterKey,
        Buffer.from(iv),
      );
      decipher.setAAD(Buffer.from(`POD_KEY_WRAP|${context}`, "utf8"));
      decipher.setAuthTag(Buffer.from(tag));
      const key = Buffer.concat([
        decipher.update(Buffer.from(ciphertext)),
        decipher.final(),
      ]);
      if (key.length !== POD_KEY_BYTES) {
        throw new PodError("POD_DECRYPTION_FAILED", "unwrapped key length invalid");
      }
      return new Uint8Array(key);
    } catch (err) {
      if (err instanceof PodError) throw err;
      throw new PodError("POD_DECRYPTION_FAILED", "key unwrap failed");
    }
  }
}

/** Validate and decode ROUTEGUARD_POD_MASTER_KEY_BASE64 at the outer boundary. */
export function parseMasterKeyBase64(value: string | undefined | null): Uint8Array {
  if (!value || !value.trim()) {
    throw new PodError("POD_KEY_CONFIG", "POD master key missing");
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(value.trim(), "base64");
  } catch {
    throw new PodError("POD_KEY_CONFIG", "POD master key is not valid base64");
  }
  if (buf.length !== POD_KEY_BYTES) {
    throw new PodError(
      "POD_KEY_CONFIG",
      "POD master key must decode to exactly 32 bytes",
    );
  }
  return new Uint8Array(buf);
}

export function masterKeyStatus(
  value: string | undefined | null,
): "PRESENT" | "MISSING" {
  try {
    parseMasterKeyBase64(value);
    return "PRESENT";
  } catch {
    return "MISSING";
  }
}
