import { describe, expect, it } from "vitest";

import {
  ACCESS_ACTION_TYPES,
  ACCESS_FEE_AMOUNT_ATOMIC,
  ACCESS_FEE_DECIMALS,
  ACCESS_FEE_DISPLAY_AMOUNT,
  ACCESS_FEE_TOKEN_ID,
  ACCESS_TREASURY_ENV_KEY,
  assertAccessFeeAmountAtomic,
  assertAccessFeeAsset,
  deriveAccessFeeAtomic,
  isAccessActionType,
} from "../src/v2/access/fee";
import { displayAmountToSmallestUnits } from "../src/x402/usdc-amount";

describe("v2 access fee", () => {
  it('derives "0.001" with 6 decimals to exactly "1000"', () => {
    const derived = displayAmountToSmallestUnits("0.001", 6);
    expect(derived).toBe("1000");
    expect(deriveAccessFeeAtomic()).toBe("1000");
    expect(ACCESS_FEE_AMOUNT_ATOMIC).toBe("1000");
    expect(ACCESS_FEE_AMOUNT_ATOMIC).toBe(deriveAccessFeeAtomic());
  });

  it('derives "0.01" with 6 decimals to exactly "10000"', () => {
    expect(displayAmountToSmallestUnits("0.01", 6)).toBe("10000");
  });

  it("exposes product constants without treating network fee as app price", () => {
    expect(ACCESS_FEE_DISPLAY_AMOUNT).toBe("0.001");
    expect(ACCESS_FEE_TOKEN_ID).toBe("0.0.429274");
    expect(ACCESS_FEE_DECIMALS).toBe(6);
    expect(ACCESS_TREASURY_ENV_KEY).toBe(
      "ROUTEGUARD_ACCESS_TREASURY_ACCOUNT_ID",
    );
  });

  it("defines TENDER_ACTIVATE and BID_SUBMIT action types", () => {
    expect(ACCESS_ACTION_TYPES).toEqual(["TENDER_ACTIVATE", "BID_SUBMIT"]);
    expect(isAccessActionType("TENDER_ACTIVATE")).toBe(true);
    expect(isAccessActionType("BID_SUBMIT")).toBe(true);
    expect(isAccessActionType("RELEASE_FUNDS")).toBe(false);
  });

  it("assertAccessFeeAmountAtomic accepts only the derived fee", () => {
    expect(() => assertAccessFeeAmountAtomic("1000")).not.toThrow();
    expect(() => assertAccessFeeAmountAtomic("10000")).toThrow(
      /amountAtomic must be/,
    );
  });

  it("assertAccessFeeAsset accepts only verified USDC token", () => {
    expect(() => assertAccessFeeAsset("0.0.429274")).not.toThrow();
    expect(() => assertAccessFeeAsset("0.0.0")).toThrow(/asset must be/);
  });

  it("rejects scientific notation and excess precision for display amounts", () => {
    expect(() => displayAmountToSmallestUnits("1e-3", 6)).toThrow(
      /Scientific notation/,
    );
    expect(() => displayAmountToSmallestUnits("0.0010001", 6)).toThrow(
      /more than 6 decimal/,
    );
  });
});
