/**
 * Integer monetary values only — no floats in the trust-critical path.
 */

export function isSafePositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

export function isSafeNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

export function isPositiveIntegerString(value: string): boolean {
  if (!/^[1-9]\d*$/.test(value)) {
    return false;
  }
  // Bound length to avoid pathological strings; still within atomic amount domain.
  return value.length <= 78;
}
