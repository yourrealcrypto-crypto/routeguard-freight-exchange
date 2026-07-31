/**
 * RouteGuard v2 x402 access-fee economics (product price, not network fee).
 *
 * Tender activation and durable bid submission each require an exact HTS USDC
 * access payment. Atomic units are always derived from the display amount and
 * verified token decimals — never hard-coded without derivation, never via
 * floating-point arithmetic.
 */

import { displayAmountToSmallestUnits } from "../../x402/usdc-amount";
import {
  VERIFIED_USDC_DECIMALS,
  VERIFIED_USDC_TOKEN_ID,
} from "../../x402/usdc-constants";

/** Product display amount for each protected access action. */
export const ACCESS_FEE_DISPLAY_AMOUNT = "0.001" as const;

/** Verified Hedera testnet USDC token (Circle-issued HTS). */
export const ACCESS_FEE_TOKEN_ID = VERIFIED_USDC_TOKEN_ID;

/** Verified token decimals (Mirror Node + Circle metadata). */
export const ACCESS_FEE_DECIMALS = VERIFIED_USDC_DECIMALS;

/**
 * Configuration key for the access-fee payTo treasury account.
 * Phase A1 does not require a concrete value to be present at runtime.
 */
export const ACCESS_TREASURY_ENV_KEY =
  "ROUTEGUARD_ACCESS_TREASURY_ACCOUNT_ID" as const;

export const ACCESS_ACTION_TYPES = [
  "TENDER_ACTIVATE",
  "BID_SUBMIT",
] as const;

export type AccessActionType = (typeof ACCESS_ACTION_TYPES)[number];

/**
 * At six USDC decimals, one USD cent equals 10_000 atomic units
 * (1 cent = 0.01 USD = 10_000 / 10^6 USDC).
 */
export const USDC_ATOMIC_PER_CENT = 10_000n;

/**
 * Derive the access-fee amount in atomic USDC from the product display amount
 * and verified decimals. Uses integer/string conversion only.
 */
export function deriveAccessFeeAtomic(): string {
  return displayAmountToSmallestUnits(
    ACCESS_FEE_DISPLAY_AMOUNT,
    ACCESS_FEE_DECIMALS,
  );
}

/**
 * Derived access-fee atomic amount. Validated to equal "1000" at module load.
 * Not a free-standing hard-coded constant: value comes from
 * {@link deriveAccessFeeAtomic}.
 */
export const ACCESS_FEE_AMOUNT_ATOMIC: string = (() => {
  const derived = deriveAccessFeeAtomic();
  if (derived !== "1000") {
    throw new Error(
      `Access fee derivation invariant failed: expected "1000", got "${derived}" ` +
        `(display=${ACCESS_FEE_DISPLAY_AMOUNT}, decimals=${ACCESS_FEE_DECIMALS})`,
    );
  }
  return derived;
})();

/** True when value is an AccessActionType. */
export function isAccessActionType(value: string): value is AccessActionType {
  return (ACCESS_ACTION_TYPES as readonly string[]).includes(value);
}

/**
 * Non-negative integer string in atomic USDC units (allows "0").
 * Rejects leading zeros (except "0"), signs, exponents, and floats.
 */
export function isNonNegativeAtomicString(value: string): boolean {
  if (typeof value !== "string") {
    return false;
  }
  if (value.length === 0 || value.length > 78) {
    return false;
  }
  return /^(0|[1-9]\d*)$/.test(value);
}

/**
 * Positive integer string in atomic USDC units (rejects "0").
 */
export function isPositiveAtomicString(value: string): boolean {
  if (typeof value !== "string") {
    return false;
  }
  if (value.length === 0 || value.length > 78) {
    return false;
  }
  return /^[1-9]\d*$/.test(value);
}

/**
 * Convert an integer USD-cent amount to USDC atomic units at 6 decimals.
 * 1 cent → "10000". Uses BigInt only (no Number money math on the amount).
 */
export function centsToUsdcAtomic(cents: number | string): string {
  let centsBig: bigint;
  if (typeof cents === "number") {
    if (!Number.isInteger(cents) || !Number.isSafeInteger(cents)) {
      throw new Error("cents must be a safe integer");
    }
    if (cents < 0) {
      throw new Error("cents must not be negative");
    }
    centsBig = BigInt(cents);
  } else if (typeof cents === "string") {
    if (!/^(0|[1-9]\d*)$/.test(cents)) {
      throw new Error(`Invalid cents string: ${cents}`);
    }
    centsBig = BigInt(cents);
  } else {
    throw new Error("cents must be a number or integer string");
  }

  return (centsBig * USDC_ATOMIC_PER_CENT).toString();
}

/**
 * Assert amountAtomic equals the derived product access fee.
 */
export function assertAccessFeeAmountAtomic(amountAtomic: string): void {
  const expected = deriveAccessFeeAtomic();
  if (amountAtomic !== expected) {
    throw new Error(
      `Access fee amountAtomic must be "${expected}", got "${amountAtomic}"`,
    );
  }
}

/**
 * Assert asset is the verified USDC token id.
 */
export function assertAccessFeeAsset(asset: string): void {
  if (asset !== ACCESS_FEE_TOKEN_ID) {
    throw new Error(
      `Access fee asset must be "${ACCESS_FEE_TOKEN_ID}", got "${asset}"`,
    );
  }
}
