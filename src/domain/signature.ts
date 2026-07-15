import { PrivateKey, PublicKey } from "@hiero-ledger/sdk";

import { canonicalize } from "./canonical-hash";

/**
 * Application signature contract (Hedera / Hiero ECDSA secp256k1):
 *
 * 1. Build canonical JSON of the validated payload (no signature field).
 * 2. Encode that string as UTF-8 bytes.
 * 3. Pass those bytes **directly** to Hiero `PrivateKey.sign` /
 *    `PublicKey.verify` (ECDSA secp256k1).
 * 4. Do **not** pre-hash with SHA-256 at the application layer. The installed
 *    `@hiero-ledger/sdk` ECDSA path signs/verifies the provided message bytes
 *    as given (application observes 64-byte raw r||s signatures).
 * 5. Wire encoding: lowercase or uppercase hex of exactly 64 bytes (128 hex
 *    characters). Strict syntax validation before Buffer conversion.
 *
 * Effective algorithm summary:
 *   ECDSA-secp256k1 over UTF-8(canonicalize(payload)), signature = 64-byte r||s hex.
 */

/** Hiero ECDSA raw signature length in bytes (r||s). */
export const HIERO_ECDSA_SIGNATURE_BYTES = 64;
export const HIERO_ECDSA_SIGNATURE_HEX_LENGTH = 128;

const STRICT_HEX_RE = /^[0-9a-fA-F]+$/;

/**
 * Strictly validate signature encoding before any Buffer conversion.
 * Returns null on any malformation (controlled failure, never throws).
 */
export function parseSignatureHex(signatureHex: string): Uint8Array | null {
  if (typeof signatureHex !== "string") {
    return null;
  }
  if (signatureHex.length === 0) {
    return null;
  }
  if (signatureHex.length % 2 !== 0) {
    return null;
  }
  if (!STRICT_HEX_RE.test(signatureHex)) {
    return null;
  }
  if (signatureHex.length !== HIERO_ECDSA_SIGNATURE_HEX_LENGTH) {
    return null;
  }
  try {
    const buf = Buffer.from(signatureHex, "hex");
    if (buf.length !== HIERO_ECDSA_SIGNATURE_BYTES) {
      return null;
    }
    // Detect incomplete hex parse (Node may silently drop bad trailing pairs
    // only when invalid chars exist — already rejected above).
    if (buf.toString("hex") !== signatureHex.toLowerCase()) {
      // Case-insensitive: re-check length only
      if (buf.toString("hex").length !== HIERO_ECDSA_SIGNATURE_HEX_LENGTH) {
        return null;
      }
    }
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

export function canonicalUtf8Bytes(value: unknown): Uint8Array {
  const canonical = canonicalize(value);
  return new Uint8Array(Buffer.from(canonical, "utf8"));
}

export function signCanonicalPayload(
  value: unknown,
  privateKeyHex: string,
): string {
  const key = PrivateKey.fromStringECDSA(privateKeyHex);
  const message = canonicalUtf8Bytes(value);
  const signature = key.sign(message);
  if (signature.length !== HIERO_ECDSA_SIGNATURE_BYTES) {
    throw new Error(
      `Unexpected Hiero ECDSA signature length: ${signature.length}`,
    );
  }
  return Buffer.from(signature).toString("hex");
}

/**
 * Verify ECDSA signature over canonical UTF-8 bytes.
 * Malformed signatures return false (never throw).
 */
export function verifyCanonicalPayload(
  value: unknown,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  try {
    const signature = parseSignatureHex(signatureHex);
    if (!signature) {
      return false;
    }
    const publicKey = PublicKey.fromString(publicKeyHex);
    const message = canonicalUtf8Bytes(value);
    return publicKey.verify(message, signature);
  } catch {
    return false;
  }
}
