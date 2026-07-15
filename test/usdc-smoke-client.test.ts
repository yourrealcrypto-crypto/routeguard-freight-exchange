import { encodePaymentRequiredHeader } from "@x402/core/http";
import type {
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
} from "@x402/core/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  displayAmountToSmallestUnits,
  smallestUnitsToDisplayAmount,
} from "../src/x402/usdc-amount";
import {
  USDC_SMOKE_APPROVED_RECEIVER,
  USDC_SMOKE_KNOWN_FEE_PAYER,
  USDC_SMOKE_MAX_TIMEOUT_SECONDS,
  VERIFIED_USDC_DECIMALS,
  VERIFIED_USDC_TOKEN_ID,
} from "../src/x402/usdc-constants";
import {
  canSignUsdcPayment,
  claimUsdcSettlementAttempt,
  describeUsdcSmokeSettlementFailure,
  fetchAndValidateUsdcSmokeChallenge,
  isUsdcSettlementGuardClaimed,
  resetUsdcSettlementGuardForTests,
  resolveUsdcSmokeExpectedAmounts,
  runUsdcSmokeClient,
  validateUsdcSmokePaymentRequirements,
  validateUsdcSmokeSettlement,
} from "../src/x402/usdc-smoke-client";

const smokeUrl = "https://example.com/api/x402/usdc-smoke";
const expectedAmount = displayAmountToSmallestUnits(
  "0.01",
  VERIFIED_USDC_DECIMALS,
);

const validRequirement: PaymentRequirements = {
  scheme: "exact",
  network: "hedera:testnet",
  amount: expectedAmount,
  asset: VERIFIED_USDC_TOKEN_ID,
  payTo: USDC_SMOKE_APPROVED_RECEIVER,
  maxTimeoutSeconds: USDC_SMOKE_MAX_TIMEOUT_SECONDS,
  extra: {
    feePayer: USDC_SMOKE_KNOWN_FEE_PAYER,
  },
};

const validPaymentRequired: PaymentRequired = {
  x402Version: 2,
  resource: {
    url: smokeUrl,
  },
  accepts: [validRequirement],
};

function withRequirement(
  overrides: Partial<PaymentRequirements>,
): PaymentRequired {
  return {
    ...validPaymentRequired,
    accepts: [
      {
        ...validRequirement,
        ...overrides,
      },
    ],
  };
}

function challengeResponse(
  paymentRequired: PaymentRequired = validPaymentRequired,
): Response {
  return new Response(null, {
    status: 402,
    headers: {
      "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired),
    },
  });
}

function facilitatorSupportedResponse(
  feePayer: string = USDC_SMOKE_KNOWN_FEE_PAYER,
): Response {
  return new Response(
    JSON.stringify({
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: "hedera:testnet",
          extra: { feePayer },
        },
      ],
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

function fetchForChallengeAndFacilitator(
  challenge: Response = challengeResponse(),
  feePayer: string = USDC_SMOKE_KNOWN_FEE_PAYER,
): typeof globalThis.fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    if (url.includes("/supported")) {
      return facilitatorSupportedResponse(feePayer);
    }

    return challenge;
  }) as unknown as typeof globalThis.fetch;
}

describe("USDC amount conversion", () => {
  it("converts 0.01 display USDC to exact smallest units with 6 decimals", () => {
    expect(displayAmountToSmallestUnits("0.01", 6)).toBe("10000");
    expect(resolveUsdcSmokeExpectedAmounts({}).smallestUnits).toBe("10000");
  });

  it("rejects excess decimal precision", () => {
    expect(() => displayAmountToSmallestUnits("0.0100001", 6)).toThrow(
      /more than 6 decimal places/,
    );
  });

  it("rejects values below one smallest unit", () => {
    expect(() => displayAmountToSmallestUnits("0", 6)).toThrow(
      /less than one smallest unit/,
    );
    expect(() => displayAmountToSmallestUnits("0.000000", 6)).toThrow(
      /less than one smallest unit/,
    );
  });

  it("formats smallest units back to display", () => {
    expect(smallestUnitsToDisplayAmount("10000", 6)).toBe("0.01");
    expect(smallestUnitsToDisplayAmount(1n, 6)).toBe("0.000001");
  });
});

describe("USDC smoke client validation", () => {
  it("accepts a valid USDC requirement", () => {
    const validated = validateUsdcSmokePaymentRequirements(
      validPaymentRequired,
      USDC_SMOKE_APPROVED_RECEIVER,
      VERIFIED_USDC_TOKEN_ID,
      expectedAmount,
      USDC_SMOKE_KNOWN_FEE_PAYER,
    );

    expect(validated.paymentRequired).toBe(validPaymentRequired);
    expect(validated.requirement).toBe(validRequirement);
  });

  it("rejects a wrong token ID", () => {
    expect(() =>
      validateUsdcSmokePaymentRequirements(
        withRequirement({ asset: "0.0.1" }),
        USDC_SMOKE_APPROVED_RECEIVER,
        VERIFIED_USDC_TOKEN_ID,
        expectedAmount,
        USDC_SMOKE_KNOWN_FEE_PAYER,
      ),
    ).toThrow(/Unexpected asset/);
  });

  it("rejects a wrong amount", () => {
    expect(() =>
      validateUsdcSmokePaymentRequirements(
        withRequirement({ amount: "10001" }),
        USDC_SMOKE_APPROVED_RECEIVER,
        VERIFIED_USDC_TOKEN_ID,
        expectedAmount,
        USDC_SMOKE_KNOWN_FEE_PAYER,
      ),
    ).toThrow(/Unexpected amount/);
  });

  it("rejects a wrong recipient", () => {
    expect(() =>
      validateUsdcSmokePaymentRequirements(
        withRequirement({ payTo: "0.0.9999" }),
        USDC_SMOKE_APPROVED_RECEIVER,
        VERIFIED_USDC_TOKEN_ID,
        expectedAmount,
        USDC_SMOKE_KNOWN_FEE_PAYER,
      ),
    ).toThrow(/Unexpected payTo recipient/);
  });

  it("rejects a wrong network", () => {
    expect(() =>
      validateUsdcSmokePaymentRequirements(
        withRequirement({ network: "hedera:mainnet" }),
        USDC_SMOKE_APPROVED_RECEIVER,
        VERIFIED_USDC_TOKEN_ID,
        expectedAmount,
        USDC_SMOKE_KNOWN_FEE_PAYER,
      ),
    ).toThrow(/Unexpected network/);
  });

  it("rejects a wrong scheme", () => {
    expect(() =>
      validateUsdcSmokePaymentRequirements(
        withRequirement({ scheme: "inexact" }),
        USDC_SMOKE_APPROVED_RECEIVER,
        VERIFIED_USDC_TOKEN_ID,
        expectedAmount,
        USDC_SMOKE_KNOWN_FEE_PAYER,
      ),
    ).toThrow(/Unexpected scheme/);
  });

  it("rejects a wrong x402 version", () => {
    expect(() =>
      validateUsdcSmokePaymentRequirements(
        {
          ...validPaymentRequired,
          x402Version: 1,
        },
        USDC_SMOKE_APPROVED_RECEIVER,
        VERIFIED_USDC_TOKEN_ID,
        expectedAmount,
        USDC_SMOKE_KNOWN_FEE_PAYER,
      ),
    ).toThrow(/Unexpected x402Version/);
  });

  it("rejects missing fee payer", () => {
    expect(() =>
      validateUsdcSmokePaymentRequirements(
        withRequirement({ extra: {} }),
        USDC_SMOKE_APPROVED_RECEIVER,
        VERIFIED_USDC_TOKEN_ID,
        expectedAmount,
        USDC_SMOKE_KNOWN_FEE_PAYER,
      ),
    ).toThrow(/Missing Hedera fee payer/);
  });

  it("rejects a wrong fee payer", () => {
    expect(() =>
      validateUsdcSmokePaymentRequirements(
        withRequirement({ extra: { feePayer: "0.0.1" } }),
        USDC_SMOKE_APPROVED_RECEIVER,
        VERIFIED_USDC_TOKEN_ID,
        expectedAmount,
        USDC_SMOKE_KNOWN_FEE_PAYER,
      ),
    ).toThrow(/Unexpected feePayer/);
  });

  it("rejects missing accepts", () => {
    expect(() =>
      validateUsdcSmokePaymentRequirements(
        {
          x402Version: 2,
          resource: validPaymentRequired.resource,
        },
        USDC_SMOKE_APPROVED_RECEIVER,
        VERIFIED_USDC_TOKEN_ID,
        expectedAmount,
        USDC_SMOKE_KNOWN_FEE_PAYER,
      ),
    ).toThrow(/Missing accepts/);
  });

  it("rejects empty accepts", () => {
    expect(() =>
      validateUsdcSmokePaymentRequirements(
        {
          ...validPaymentRequired,
          accepts: [],
        },
        USDC_SMOKE_APPROVED_RECEIVER,
        VERIFIED_USDC_TOKEN_ID,
        expectedAmount,
        USDC_SMOKE_KNOWN_FEE_PAYER,
      ),
    ).toThrow(/exactly one payment requirement, got 0/);
  });

  it("rejects multiple accepts", () => {
    expect(() =>
      validateUsdcSmokePaymentRequirements(
        {
          ...validPaymentRequired,
          accepts: [validRequirement, validRequirement],
        },
        USDC_SMOKE_APPROVED_RECEIVER,
        VERIFIED_USDC_TOKEN_ID,
        expectedAmount,
        USDC_SMOKE_KNOWN_FEE_PAYER,
      ),
    ).toThrow(/exactly one payment requirement, got 2/);
  });

  it("rejects invalid accepts type", () => {
    expect(() =>
      validateUsdcSmokePaymentRequirements(
        {
          ...validPaymentRequired,
          accepts: "not-an-array",
        },
        USDC_SMOKE_APPROVED_RECEIVER,
        VERIFIED_USDC_TOKEN_ID,
        expectedAmount,
        USDC_SMOKE_KNOWN_FEE_PAYER,
      ),
    ).toThrow(/Invalid accepts/);
  });
});

describe("USDC smoke challenge fetching", () => {
  it("decodes and validates a genuine PAYMENT-REQUIRED header", async () => {
    const fetched = await fetchAndValidateUsdcSmokeChallenge(
      smokeUrl,
      USDC_SMOKE_APPROVED_RECEIVER,
      VERIFIED_USDC_TOKEN_ID,
      expectedAmount,
      USDC_SMOKE_KNOWN_FEE_PAYER,
      vi.fn(async () => challengeResponse()) as unknown as typeof fetch,
    );

    expect(fetched.response.status).toBe(402);
    expect(fetched.paymentRequired).toEqual(validPaymentRequired);
    expect(fetched.requirement).toEqual(validRequirement);
  });

  it("rejects a non-402 initial response", async () => {
    await expect(
      fetchAndValidateUsdcSmokeChallenge(
        smokeUrl,
        USDC_SMOKE_APPROVED_RECEIVER,
        VERIFIED_USDC_TOKEN_ID,
        expectedAmount,
        USDC_SMOKE_KNOWN_FEE_PAYER,
        vi.fn(async () => new Response(null, { status: 503 })) as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/Expected 402 Payment Required, got HTTP 503/);
  });

  it("rejects a missing PAYMENT-REQUIRED header", async () => {
    await expect(
      fetchAndValidateUsdcSmokeChallenge(
        smokeUrl,
        USDC_SMOKE_APPROVED_RECEIVER,
        VERIFIED_USDC_TOKEN_ID,
        expectedAmount,
        USDC_SMOKE_KNOWN_FEE_PAYER,
        vi.fn(async () => new Response(null, { status: 402 })) as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/Missing PAYMENT-REQUIRED header/);
  });

  it("rejects a malformed PAYMENT-REQUIRED header", async () => {
    await expect(
      fetchAndValidateUsdcSmokeChallenge(
        smokeUrl,
        USDC_SMOKE_APPROVED_RECEIVER,
        VERIFIED_USDC_TOKEN_ID,
        expectedAmount,
        USDC_SMOKE_KNOWN_FEE_PAYER,
        vi.fn(
          async () =>
            new Response(null, {
              status: 402,
              headers: {
                "PAYMENT-REQUIRED": "not-valid-base64-json",
              },
            }),
        ) as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/Malformed PAYMENT-REQUIRED header/);
  });
});

describe("USDC smoke signing boundary", () => {
  it("live guard requires both live flags", () => {
    expect(canSignUsdcPayment(false, false)).toBe(false);
    expect(canSignUsdcPayment(true, false)).toBe(false);
    expect(canSignUsdcPayment(false, true)).toBe(false);
    expect(canSignUsdcPayment(true, true)).toBe(true);
  });

  it.each([
    ["false", "false"],
    ["true", "false"],
    ["false", "true"],
  ])(
    "challenge-only mode does not access private-key material when flags are %s/%s",
    async (liveHedera, liveUsdcPayments) => {
      let privateKeyAccessed = false;
      const env = new Proxy<NodeJS.ProcessEnv>(
        {
          CARRIER_ACCOUNT_ID: USDC_SMOKE_APPROVED_RECEIVER,
          FACILITATOR_URL: "https://api.testnet.blocky402.com",
          USDC_SMOKE_URL: smokeUrl,
          ENABLE_LIVE_HEDERA: liveHedera,
          ENABLE_LIVE_USDC_PAYMENTS: liveUsdcPayments,
        },
        {
          get(target, property, receiver) {
            if (property === "SHIPPER_PRIVATE_KEY") {
              privateKeyAccessed = true;
              throw new Error("private key must not be read");
            }

            return Reflect.get(target, property, receiver);
          },
        },
      );

      const result = await runUsdcSmokeClient({
        env,
        fetchImplementation: fetchForChallengeAndFacilitator(),
        logger: { log: vi.fn() },
        expectedFeePayer: USDC_SMOKE_KNOWN_FEE_PAYER,
      });

      expect(result.mode).toBe("challenge-only");
      expect(privateKeyAccessed).toBe(false);
    },
  );

  it("accepts only an authoritative successful settlement", () => {
    const settlement: SettleResponse = {
      success: true,
      payer: "0.0.9197513",
      transaction: "0.0.7162784@1784123744.752811412",
      network: "hedera:testnet",
      amount: expectedAmount,
    };

    expect(
      validateUsdcSmokeSettlement(
        settlement,
        "0.0.9197513",
        expectedAmount,
      ),
    ).toBe(settlement);
    expect(() =>
      validateUsdcSmokeSettlement(
        { ...settlement, success: false },
        "0.0.9197513",
        expectedAmount,
      ),
    ).toThrow(/unsuccessful USDC settlement/);
  });

  it("preserves sanitized facilitator settlement failure details", () => {
    expect(
      describeUsdcSmokeSettlementFailure({
        success: false,
        errorReason: "transaction_failed",
        errorMessage: "TOKEN_NOT_ASSOCIATED_TO_ACCOUNT",
        transaction: "",
        network: "hedera:testnet",
      }),
    ).toBe("transaction_failed: TOKEN_NOT_ASSOCIATED_TO_ACCOUNT");
  });

  it("does not execute the CLI when its module is imported", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch must not run during import"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await import("../scripts/usdc-smoke-client");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});

describe("USDC smoke settlement guard (one-attempt)", () => {
  beforeEach(() => {
    resetUsdcSettlementGuardForTests();
  });

  it("first settlement-attempt claim succeeds", () => {
    expect(isUsdcSettlementGuardClaimed()).toBe(false);
    claimUsdcSettlementAttempt();
    expect(isUsdcSettlementGuardClaimed()).toBe(true);
  });

  it("second claim fails", () => {
    claimUsdcSettlementAttempt();
    expect(() => claimUsdcSettlementAttempt()).toThrow(
      /Only one payment attempt is allowed per process/,
    );
    expect(isUsdcSettlementGuardClaimed()).toBe(true);
  });
});
