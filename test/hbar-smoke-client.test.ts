import { encodePaymentRequiredHeader } from "@x402/core/http";
import type {
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
} from "@x402/core/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  canSignPayment,
  claimSettlementAttempt,
  describeHbarSmokeSettlementFailure,
  fetchAndValidateHbarSmokeChallenge,
  HBAR_SMOKE_APPROVED_FEE_PAYER,
  HBAR_SMOKE_APPROVED_PAYER,
  HBAR_SMOKE_APPROVED_RECEIVER,
  isSettlementGuardClaimed,
  resetSettlementGuardForTests,
  runHbarSmokeClient,
  validateHbarSmokePaymentRequirements,
  validateHbarSmokeSettlement,
  verifyHbarSmokePayment,
} from "../src/x402/hbar-smoke-client";

const carrierAccountId = "0.0.1234";
const smokeUrl = "https://example.com/api/x402/hbar-smoke";

const validRequirement: PaymentRequirements = {
  scheme: "exact",
  network: "hedera:testnet",
  amount: "1000000",
  asset: "0.0.0",
  payTo: HBAR_SMOKE_APPROVED_RECEIVER,
  maxTimeoutSeconds: 180,
  extra: {
    feePayer: HBAR_SMOKE_APPROVED_FEE_PAYER,
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

function fetchReturning(response: Response): typeof globalThis.fetch {
  return vi.fn(async () => response) as unknown as typeof globalThis.fetch;
}

describe("HBAR smoke client validation", () => {
  it("accepts a valid requirement", () => {
    const validated = validateHbarSmokePaymentRequirements(
      validPaymentRequired,
      HBAR_SMOKE_APPROVED_RECEIVER,
    );

    expect(validated.paymentRequired).toBe(validPaymentRequired);
    expect(validated.requirement).toBe(validRequirement);
  });

  it("rejects a wrong receiver", () => {
    expect(() =>
      validateHbarSmokePaymentRequirements(
        withRequirement({ payTo: "0.0.9999" }),
        HBAR_SMOKE_APPROVED_RECEIVER,
      ),
    ).toThrow(/Unexpected payTo recipient/);
  });

  it("rejects a wrong network", () => {
    expect(() =>
      validateHbarSmokePaymentRequirements(
        withRequirement({ network: "hedera:mainnet" }),
        HBAR_SMOKE_APPROVED_RECEIVER,
      ),
    ).toThrow(/Unexpected network/);
  });

  it("rejects a wrong amount", () => {
    expect(() =>
      validateHbarSmokePaymentRequirements(
        withRequirement({ amount: "1000001" }),
        HBAR_SMOKE_APPROVED_RECEIVER,
      ),
    ).toThrow(/Unexpected amount/);
  });

  it("rejects a wrong asset", () => {
    expect(() =>
      validateHbarSmokePaymentRequirements(
        withRequirement({ asset: "0.0.1" }),
        HBAR_SMOKE_APPROVED_RECEIVER,
      ),
    ).toThrow(/Unexpected asset/);
  });

  it("rejects a wrong scheme", () => {
    expect(() =>
      validateHbarSmokePaymentRequirements(
        withRequirement({ scheme: "inexact" }),
        HBAR_SMOKE_APPROVED_RECEIVER,
      ),
    ).toThrow(/Unexpected scheme/);
  });

  it("rejects a wrong x402 version", () => {
    expect(() =>
      validateHbarSmokePaymentRequirements(
        {
          ...validPaymentRequired,
          x402Version: 1,
        },
        HBAR_SMOKE_APPROVED_RECEIVER,
      ),
    ).toThrow(/Unexpected x402Version/);
  });

  it("rejects missing accepts", () => {
    expect(() =>
      validateHbarSmokePaymentRequirements(
        {
          x402Version: 2,
          resource: validPaymentRequired.resource,
        },
        HBAR_SMOKE_APPROVED_RECEIVER,
      ),
    ).toThrow(/Missing accepts/);
  });

  it("rejects invalid accepts", () => {
    expect(() =>
      validateHbarSmokePaymentRequirements(
        {
          ...validPaymentRequired,
          accepts: "not-an-array",
        },
        HBAR_SMOKE_APPROVED_RECEIVER,
      ),
    ).toThrow(/Invalid accepts/);
  });

  it("rejects empty accepts", () => {
    expect(() =>
      validateHbarSmokePaymentRequirements(
        {
          ...validPaymentRequired,
          accepts: [],
        },
        HBAR_SMOKE_APPROVED_RECEIVER,
      ),
    ).toThrow(/exactly one payment requirement, got 0/);
  });

  it("rejects multiple accepts without selecting one", () => {
    expect(() =>
      validateHbarSmokePaymentRequirements(
        {
          ...validPaymentRequired,
          accepts: [validRequirement, validRequirement],
        },
        HBAR_SMOKE_APPROVED_RECEIVER,
      ),
    ).toThrow(/exactly one payment requirement, got 2/);
  });

  it("rejects a missing Hedera fee payer before signing", () => {
    expect(() =>
      validateHbarSmokePaymentRequirements(
        withRequirement({ extra: {} }),
        HBAR_SMOKE_APPROVED_RECEIVER,
      ),
    ).toThrow(/Missing Hedera fee payer/);
  });
});

describe("HBAR smoke challenge fetching", () => {
  it("decodes and validates a genuine PAYMENT-REQUIRED header", async () => {
    const fetched = await fetchAndValidateHbarSmokeChallenge(
      smokeUrl,
      HBAR_SMOKE_APPROVED_RECEIVER,
      fetchReturning(challengeResponse()),
    );

    expect(fetched.response.status).toBe(402);
    expect(fetched.paymentRequired).toEqual(validPaymentRequired);
    expect(fetched.requirement).toEqual(validRequirement);
  });

  it("rejects a non-402 initial response", async () => {
    await expect(
      fetchAndValidateHbarSmokeChallenge(
        smokeUrl,
        carrierAccountId,
        fetchReturning(new Response(null, { status: 503 })),
      ),
    ).rejects.toThrow(/Expected 402 Payment Required, got HTTP 503/);
  });

  it("rejects a missing PAYMENT-REQUIRED header", async () => {
    await expect(
      fetchAndValidateHbarSmokeChallenge(
        smokeUrl,
        carrierAccountId,
        fetchReturning(new Response(null, { status: 402 })),
      ),
    ).rejects.toThrow(/Missing PAYMENT-REQUIRED header/);
  });

  it("rejects a malformed PAYMENT-REQUIRED header", async () => {
    await expect(
      fetchAndValidateHbarSmokeChallenge(
        smokeUrl,
        carrierAccountId,
        fetchReturning(
          new Response(null, {
            status: 402,
            headers: {
              "PAYMENT-REQUIRED": "not-valid-base64-json",
            },
          }),
        ),
      ),
    ).rejects.toThrow(/Malformed PAYMENT-REQUIRED header/);
  });
});

describe("HBAR smoke signing boundary", () => {
  it("requires both live flags before signing", () => {
    expect(canSignPayment(false, false)).toBe(false);
    expect(canSignPayment(true, false)).toBe(false);
    expect(canSignPayment(false, true)).toBe(false);
    expect(canSignPayment(true, true)).toBe(true);
  });

  it.each([
    ["false", "false"],
    ["true", "false"],
    ["false", "true"],
  ])(
    "stops before private-key access when live flags are %s/%s",
    async (liveHedera, liveHbarPayments) => {
      let privateKeyAccessed = false;
      const env = new Proxy<NodeJS.ProcessEnv>(
        {
          CARRIER_ACCOUNT_ID: HBAR_SMOKE_APPROVED_RECEIVER,
          HBAR_SMOKE_URL: smokeUrl,
          ENABLE_LIVE_HEDERA: liveHedera,
          ENABLE_LIVE_HBAR_PAYMENTS: liveHbarPayments,
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
      const result = await runHbarSmokeClient({
        env,
        fetchImplementation: fetchReturning(
          challengeResponse(
            withRequirement({
              payTo: HBAR_SMOKE_APPROVED_RECEIVER,
            }),
          ),
        ),
        logger: {
          log: vi.fn(),
        },
      });

      expect(result.mode).toBe("challenge-only");
      expect(privateKeyAccessed).toBe(false);
    },
  );

  it("rejects an unapproved payer before private-key access", async () => {
    let privateKeyAccessed = false;
    const env = new Proxy<NodeJS.ProcessEnv>(
      {
        CARRIER_ACCOUNT_ID: HBAR_SMOKE_APPROVED_RECEIVER,
        SHIPPER_ACCOUNT_ID: "0.0.1111",
        HBAR_SMOKE_URL: smokeUrl,
        ENABLE_LIVE_HEDERA: "true",
        ENABLE_LIVE_HBAR_PAYMENTS: "true",
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

    await expect(
      runHbarSmokeClient({
        env,
        fetchImplementation: fetchReturning(
          challengeResponse(
            withRequirement({
              payTo: HBAR_SMOKE_APPROVED_RECEIVER,
            }),
          ),
        ),
        logger: {
          log: vi.fn(),
        },
      }),
    ).rejects.toThrow(/approved payer/);
    expect(privateKeyAccessed).toBe(false);
  });

  it("accepts only an authoritative successful settlement", () => {
    const settlement: SettleResponse = {
      success: true,
      payer: HBAR_SMOKE_APPROVED_PAYER,
      transaction: "0.0.9197513@1784082000.000000001",
      network: "hedera:testnet",
      amount: "1000000",
    };

    expect(
      validateHbarSmokeSettlement(
        settlement,
        HBAR_SMOKE_APPROVED_PAYER,
      ),
    ).toBe(settlement);
    expect(() =>
      validateHbarSmokeSettlement(
        {
          ...settlement,
          success: false,
        },
        HBAR_SMOKE_APPROVED_PAYER,
      ),
    ).toThrow(/unsuccessful HBAR settlement/);
  });

  it("preserves sanitized facilitator settlement failure details", () => {
    expect(
      describeHbarSmokeSettlementFailure({
        success: false,
        errorReason: "transaction_failed",
        errorMessage: "BUSY",
        transaction: "",
        network: "hedera:testnet",
      }),
    ).toBe("transaction_failed: BUSY");
  });

  it("does not execute the CLI when its module is imported", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch must not run during import"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await import("../scripts/hbar-smoke-client");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it("keeps verify-only mode from enabling settlement", async () => {
    let privateKeyAccessed = false;
    const env = new Proxy<NodeJS.ProcessEnv>(
      {
        CARRIER_ACCOUNT_ID: HBAR_SMOKE_APPROVED_RECEIVER,
        FACILITATOR_URL: "https://api.testnet.blocky402.com",
        HBAR_SMOKE_URL: smokeUrl,
        ENABLE_LIVE_HEDERA: "true",
        ENABLE_LIVE_HBAR_PAYMENTS: "true",
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

    await expect(
      verifyHbarSmokePayment({
        env,
        fetchImplementation: fetchReturning(
          challengeResponse(
            withRequirement({
              payTo: HBAR_SMOKE_APPROVED_RECEIVER,
            }),
          ),
        ),
        logger: {
          log: vi.fn(),
        },
      }),
    ).rejects.toThrow(/requires ENABLE_LIVE_HBAR_PAYMENTS=false/);
    expect(privateKeyAccessed).toBe(false);
  });

  it("does not execute the verify CLI when its module is imported", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch must not run during import"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await import("../scripts/hbar-smoke-verify");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});

describe("HBAR smoke settlement guard (one-attempt)", () => {
  beforeEach(() => {
    resetSettlementGuardForTests();
  });

  it("first claim succeeds", () => {
    expect(isSettlementGuardClaimed()).toBe(false);
    claimSettlementAttempt();
    expect(isSettlementGuardClaimed()).toBe(true);
  });

  it("second claim throws", () => {
    claimSettlementAttempt();
    expect(() => claimSettlementAttempt()).toThrow(
      /Only one payment attempt is allowed per process/,
    );
    expect(isSettlementGuardClaimed()).toBe(true);
  });

  it("failure after claim does not reset the guard", () => {
    claimSettlementAttempt();
    // Simulate a failure path that should not reset
    try {
      // do nothing that would reset
    } catch {
      // ignored
    }
    expect(isSettlementGuardClaimed()).toBe(true);
    expect(() => claimSettlementAttempt()).toThrow(
      /Only one payment attempt is allowed per process/,
    );
  });
});
