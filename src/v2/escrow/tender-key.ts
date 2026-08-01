/**
 * Canonical freight-escrow tender key.
 *
 * The key binds the tender identity hash, the tender version, and an explicit
 * RouteGuard domain separator, so a hash produced for any other purpose can
 * never be replayed as an escrow tender key. Derivation matches
 * `RouteGuardFreightEscrowBase.computeTenderKey` byte for byte.
 */

import { AbiCoder, keccak256, toUtf8Bytes } from "ethers";

/** Domain separator string; hashed to `TENDER_KEY_DOMAIN` on-chain. */
export const ESCROW_TENDER_KEY_DOMAIN_STRING =
  "ROUTEGUARD_V2_FREIGHT_ESCROW_TENDER_KEY_V1" as const;

export const ESCROW_TENDER_KEY_DOMAIN = keccak256(
  toUtf8Bytes(ESCROW_TENDER_KEY_DOMAIN_STRING),
);

const BYTES32_RE = /^0x[0-9a-f]{64}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEDERA_ACCOUNT_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export class EscrowIdentityError extends Error {
  constructor(
    readonly code:
      | "INVALID_TENDER_ID"
      | "INVALID_TENDER_VERSION"
      | "INVALID_HASH"
      | "INVALID_ADDRESS"
      | "INVALID_ACCOUNT_ID",
    message: string,
  ) {
    super(message);
    this.name = "EscrowIdentityError";
  }
}

/** keccak256 of the UTF-8 tender id — the public tender identity hash. */
export function tenderIdHash(tenderId: string): string {
  if (
    typeof tenderId !== "string" ||
    tenderId.length === 0 ||
    tenderId.length > 128
  ) {
    throw new EscrowIdentityError(
      "INVALID_TENDER_ID",
      "tenderId must be a non-empty string of at most 128 characters",
    );
  }
  return keccak256(toUtf8Bytes(tenderId));
}

export function assertTenderVersion(tenderVersion: number): number {
  if (
    !Number.isInteger(tenderVersion) ||
    tenderVersion < 1 ||
    tenderVersion > 0xffff_ffff
  ) {
    throw new EscrowIdentityError(
      "INVALID_TENDER_VERSION",
      "tenderVersion must be a uint32 >= 1",
    );
  }
  return tenderVersion;
}

/** Canonical escrow tender key for a tender id + version. */
export function escrowTenderKey(
  tenderId: string,
  tenderVersion: number,
): string {
  return escrowTenderKeyFromHash(tenderIdHash(tenderId), tenderVersion);
}

/** Canonical escrow tender key from an already-derived identity hash. */
export function escrowTenderKeyFromHash(
  identityHash: string,
  tenderVersion: number,
): string {
  assertBytes32(identityHash, "tenderIdHash");
  const version = assertTenderVersion(tenderVersion);
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "uint32"],
      [ESCROW_TENDER_KEY_DOMAIN, identityHash, version],
    ),
  );
}

export function assertBytes32(value: string, label: string): string {
  if (typeof value !== "string" || !BYTES32_RE.test(value)) {
    throw new EscrowIdentityError(
      "INVALID_HASH",
      `${label} must be 0x-prefixed 32-byte lowercase hex`,
    );
  }
  return value;
}

/** A non-zero bytes32 authorization hash. */
export function assertAuthorizationHash(value: string, label: string): string {
  const hash = assertBytes32(value, label);
  if (hash === `0x${"0".repeat(64)}`) {
    throw new EscrowIdentityError("INVALID_HASH", `${label} must not be zero`);
  }
  return hash;
}

export function assertEvmAddress(value: string, label: string): string {
  if (typeof value !== "string" || !EVM_ADDRESS_RE.test(value)) {
    throw new EscrowIdentityError(
      "INVALID_ADDRESS",
      `${label} must be a 20-byte 0x-prefixed EVM address`,
    );
  }
  if (value.toLowerCase() === `0x${"0".repeat(40)}`) {
    throw new EscrowIdentityError(
      "INVALID_ADDRESS",
      `${label} must not be the zero address`,
    );
  }
  return value.toLowerCase();
}

/**
 * Long-zero EVM address for a Hedera account id (`0.0.N` → `0x…N`).
 *
 * Valid only for accounts without a separate ECDSA EVM alias; Phase C2
 * configuration must confirm the resolved address on Mirror Node before use.
 */
export function hederaAccountToEvmAddress(accountId: string): string {
  if (typeof accountId !== "string" || !HEDERA_ACCOUNT_RE.test(accountId)) {
    throw new EscrowIdentityError(
      "INVALID_ACCOUNT_ID",
      "accountId must be a Hedera entity id in shard.realm.num form",
    );
  }
  const num = BigInt(accountId.split(".")[2]!);
  if (num === 0n) {
    throw new EscrowIdentityError(
      "INVALID_ACCOUNT_ID",
      "account number must be greater than zero",
    );
  }
  if (num > 0xffff_ffff_ffff_ffffn) {
    throw new EscrowIdentityError(
      "INVALID_ACCOUNT_ID",
      "account number exceeds the long-zero address range",
    );
  }
  return `0x${num.toString(16).padStart(40, "0")}`;
}

/** Convert a canonical sha256 evidence hash (`sha256:<hex>`) to bytes32. */
export function sha256HashToBytes32(value: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new EscrowIdentityError(
      "INVALID_HASH",
      "value must be sha256:<64 lowercase hex>",
    );
  }
  return `0x${value.slice("sha256:".length)}`;
}
