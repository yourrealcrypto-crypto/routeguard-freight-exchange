import { describe, expect, it } from "vitest";

import {
  centsToUsdcAtomic,
  deriveAccessFeeAtomic,
  isNonNegativeAtomicString,
  isPositiveAtomicString,
  USDC_ATOMIC_PER_CENT,
} from "../src/v2/access/fee";
import { displayAmountToSmallestUnits } from "../src/x402/usdc-amount";

describe("v2 money model", () => {
  it('converts 1 cent exactly to "10000" atomic units', () => {
    expect(USDC_ATOMIC_PER_CENT).toBe(10_000n);
    expect(centsToUsdcAtomic(1)).toBe("10000");
    expect(centsToUsdcAtomic("1")).toBe("10000");
  });

  it("converts multi-cent budgets with BigInt only", () => {
    expect(centsToUsdcAtomic(400_000)).toBe("4000000000");
    expect(centsToUsdcAtomic(0)).toBe("0");
  });

  it('derives access and smoke display amounts without floats', () => {
    expect(deriveAccessFeeAtomic()).toBe("1000");
    expect(displayAmountToSmallestUnits("0.001", 6)).toBe("1000");
    expect(displayAmountToSmallestUnits("0.01", 6)).toBe("10000");
  });

  it("rejects floats, exponents, negatives, and malformed atomic strings", () => {
    expect(isNonNegativeAtomicString("0")).toBe(true);
    expect(isNonNegativeAtomicString("1000")).toBe(true);
    expect(isNonNegativeAtomicString("01")).toBe(false);
    expect(isNonNegativeAtomicString("-1")).toBe(false);
    expect(isNonNegativeAtomicString("1.5")).toBe(false);
    expect(isNonNegativeAtomicString("1e3")).toBe(false);
    expect(isNonNegativeAtomicString("")).toBe(false);
    expect(isNonNegativeAtomicString("abc")).toBe(false);

    expect(isPositiveAtomicString("0")).toBe(false);
    expect(isPositiveAtomicString("1")).toBe(true);

    expect(() => centsToUsdcAtomic(-1)).toThrow(/negative/);
    expect(() => centsToUsdcAtomic(1.5)).toThrow(/safe integer/);
    expect(() => centsToUsdcAtomic("1e3")).toThrow(/Invalid cents/);
    expect(() => centsToUsdcAtomic("01")).toThrow(/Invalid cents/);
    expect(() => displayAmountToSmallestUnits("1e-3", 6)).toThrow(
      /Scientific notation/,
    );
    expect(() => displayAmountToSmallestUnits("-0.001", 6)).toThrow();
  });
});
