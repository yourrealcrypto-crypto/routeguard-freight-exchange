/**
 * Convert a display-unit decimal string into HTS smallest units.
 *
 * Rules:
 * - display amount × 10^decimals must be an exact integer
 * - excess fractional precision is rejected
 * - result must be at least one smallest unit
 * - scientific notation is rejected
 */
export function displayAmountToSmallestUnits(
  displayAmount: string,
  decimals: number,
): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`Invalid token decimals: ${decimals}`);
  }

  const trimmed = displayAmount.trim();

  if (!trimmed) {
    throw new Error("Display amount must not be empty.");
  }

  if (/[eE]/.test(trimmed)) {
    throw new Error("Scientific notation is not allowed for display amounts.");
  }

  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(
      `Invalid display amount "${displayAmount}". Expected a non-negative decimal.`,
    );
  }

  const [wholePartRaw, fractionPartRaw = ""] = trimmed.split(".");
  const wholePart = wholePartRaw ?? "0";

  if (fractionPartRaw.length > decimals) {
    throw new Error(
      `Display amount "${displayAmount}" has more than ${decimals} decimal places.`,
    );
  }

  const fractionPadded = fractionPartRaw.padEnd(decimals, "0");
  const combined = `${wholePart}${fractionPadded}`.replace(/^0+(?=\d)/, "");

  if (!/^\d+$/.test(combined)) {
    throw new Error(`Failed to convert display amount "${displayAmount}".`);
  }

  // BigInt rejects leading zeros beyond "0"; normalize empty to "0"
  const normalized = combined === "" ? "0" : combined.replace(/^0+(?=\d)/, "");
  const asBigInt = BigInt(normalized);

  if (asBigInt < 1n) {
    throw new Error(
      `Display amount "${displayAmount}" converts to less than one smallest unit.`,
    );
  }

  return asBigInt.toString();
}

/**
 * Format smallest units back to a display string using fixed decimals.
 */
export function smallestUnitsToDisplayAmount(
  smallestUnits: string | number | bigint,
  decimals: number,
): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`Invalid token decimals: ${decimals}`);
  }

  const value = BigInt(smallestUnits);

  if (value < 0n) {
    throw new Error("Smallest-unit amount must not be negative.");
  }

  if (decimals === 0) {
    return value.toString();
  }

  const negative = false;
  void negative;
  const raw = value.toString().padStart(decimals + 1, "0");
  const whole = raw.slice(0, -decimals) || "0";
  const fraction = raw.slice(-decimals);
  const trimmedFraction = fraction.replace(/0+$/, "");

  return trimmedFraction.length > 0
    ? `${whole}.${trimmedFraction}`
    : whole;
}
