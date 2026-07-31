/**
 * Escrow money helpers.
 *
 * Every freight amount stays an atomic USDC integer string end to end. No
 * float, no `Number` arithmetic, and every value is bounded to the HTS `int64`
 * transfer range before it can reach a contract argument.
 */

import {
  isNonNegativeAtomicString,
  isPositiveAtomicString,
} from "../access/fee";

/** Largest amount representable by the HTS signed 64-bit transfer type. */
export const MAX_HTS_ATOMIC_AMOUNT = 9_223_372_036_854_775_807n;

export class EscrowAmountError extends Error {
  constructor(
    readonly code:
      | "NOT_ATOMIC_STRING"
      | "NOT_POSITIVE"
      | "EXCEEDS_HTS_RANGE"
      | "CONSERVATION_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "EscrowAmountError";
  }
}

/** Validate a positive atomic amount and return it as a bigint. */
export function assertPositiveEscrowAmount(
  value: string,
  label = "amount",
): bigint {
  if (typeof value !== "string" || !isPositiveAtomicString(value)) {
    throw new EscrowAmountError(
      "NOT_ATOMIC_STRING",
      `${label} must be a positive atomic integer string`,
    );
  }
  const parsed = BigInt(value);
  if (parsed > MAX_HTS_ATOMIC_AMOUNT) {
    throw new EscrowAmountError(
      "EXCEEDS_HTS_RANGE",
      `${label} exceeds the HTS int64 transfer range`,
    );
  }
  return parsed;
}

/** Validate a non-negative atomic amount and return it as a bigint. */
export function assertNonNegativeEscrowAmount(
  value: string,
  label = "amount",
): bigint {
  if (typeof value !== "string" || !isNonNegativeAtomicString(value)) {
    throw new EscrowAmountError(
      "NOT_ATOMIC_STRING",
      `${label} must be a non-negative atomic integer string`,
    );
  }
  const parsed = BigInt(value);
  if (parsed > MAX_HTS_ATOMIC_AMOUNT) {
    throw new EscrowAmountError(
      "EXCEEDS_HTS_RANGE",
      `${label} exceeds the HTS int64 transfer range`,
    );
  }
  return parsed;
}

/**
 * Allocation conservation: the winning amount plus the excess refund must equal
 * the funded amount exactly.
 */
export function assertAllocationConservation(input: {
  fundedAmountAtomic: string;
  winningAmountAtomic: string;
  excessRefundAtomic: string;
}): void {
  const funded = assertPositiveEscrowAmount(
    input.fundedAmountAtomic,
    "fundedAmountAtomic",
  );
  const winning = assertPositiveEscrowAmount(
    input.winningAmountAtomic,
    "winningAmountAtomic",
  );
  const excess = assertNonNegativeEscrowAmount(
    input.excessRefundAtomic,
    "excessRefundAtomic",
  );
  if (winning > funded) {
    throw new EscrowAmountError(
      "CONSERVATION_FAILED",
      "winningAmountAtomic must not exceed fundedAmountAtomic",
    );
  }
  if (winning + excess !== funded) {
    throw new EscrowAmountError(
      "CONSERVATION_FAILED",
      "winningAmountAtomic + excessRefundAtomic must equal fundedAmountAtomic",
    );
  }
}

/** Partial settlement conservation against the locked amount. */
export function assertPartialConservation(input: {
  lockedAmountAtomic: string;
  winnerAmountAtomic: string;
  shipperAmountAtomic: string;
}): void {
  const locked = assertPositiveEscrowAmount(
    input.lockedAmountAtomic,
    "lockedAmountAtomic",
  );
  const toWinner = assertNonNegativeEscrowAmount(
    input.winnerAmountAtomic,
    "winnerAmountAtomic",
  );
  const toShipper = assertNonNegativeEscrowAmount(
    input.shipperAmountAtomic,
    "shipperAmountAtomic",
  );
  if (toWinner === 0n && toShipper === 0n) {
    throw new EscrowAmountError(
      "NOT_POSITIVE",
      "a partial release must move a positive amount to at least one party",
    );
  }
  if (toWinner + toShipper !== locked) {
    throw new EscrowAmountError(
      "CONSERVATION_FAILED",
      "winnerAmountAtomic + shipperAmountAtomic must equal lockedAmountAtomic",
    );
  }
}

/** Derive the exact excess refund for an allocation. */
export function deriveExcessRefundAtomic(
  fundedAmountAtomic: string,
  winningAmountAtomic: string,
): string {
  const funded = assertPositiveEscrowAmount(
    fundedAmountAtomic,
    "fundedAmountAtomic",
  );
  const winning = assertPositiveEscrowAmount(
    winningAmountAtomic,
    "winningAmountAtomic",
  );
  if (winning > funded) {
    throw new EscrowAmountError(
      "CONSERVATION_FAILED",
      "winningAmountAtomic must not exceed fundedAmountAtomic",
    );
  }
  return (funded - winning).toString();
}
