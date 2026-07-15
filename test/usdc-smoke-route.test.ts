import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";

import { registerUsdcSmokeRoute } from "../src/x402/usdc-smoke";
import { config } from "../src/config";
import {
  VERIFIED_USDC_TOKEN_ID,
} from "../src/x402/usdc-constants";

/**
 * Route-level tests that exercise the isolated USDC smoke path.
 *
 * Default process env keeps ENABLE_USDC_SMOKE_CHALLENGE=false so the
 * registered app from src/server/app.ts returns 503. Challenge-enabled
 * 402 generation is covered by the genuine local integration run
 * (process-scoped env + live facilitator fee payer enrichment).
 */
describe("USDC smoke route (challenge disabled by default)", () => {
  it("returns 503 with LIVE_USDC_DISABLED when challenge is disabled", async () => {
    // app.ts registers against process config; default challenge flag is false.
    const app = (await import("../src/server/app")).default;
    const response = await app.request("/api/x402/usdc-smoke");

    expect(response.status).toBe(503);

    const body = await response.json();

    expect(body).toEqual({
      error: "USDC smoke challenge publication is disabled.",
      code: "LIVE_USDC_DISABLED",
      network: "hedera:testnet",
    });
  });

  it("fails closed on payment-bearing requests without constructing settlement", async () => {
    const app = (await import("../src/server/app")).default;
    const response = await app.request("/api/x402/usdc-smoke", {
      method: "GET",
      headers: {
        "PAYMENT-SIGNATURE": "dummy-not-a-real-payload",
      },
    });

    // With challenge disabled, the simple 503 handler runs (no middleware).
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.code).toBe("LIVE_USDC_DISABLED");
  });

  it("uses verified USDC token configuration in process config", () => {
    expect(config.usdcTokenId).toBe(VERIFIED_USDC_TOKEN_ID);
    expect(config.usdcDecimals).toBe(6);
    expect(config.usdcSmokeAmountDisplay).toBe("0.01");
    expect(config.usdcSmokeAmountSmallestUnits).toBe("10000");
    expect(config.usdcSmokeChallengeEnabled).toBe(false);
    expect(config.liveUsdcPaymentsEnabled).toBe(false);
  });
});

describe("USDC smoke route registration shape", () => {
  beforeAll(() => {
    // Ensure default flags: challenge disabled path is what registerUsdcSmokeRoute uses.
    expect(config.usdcSmokeChallengeEnabled).toBe(false);
  });

  it("registers a dedicated path isolated from HBAR", async () => {
    const isolated = new Hono();
    registerUsdcSmokeRoute(isolated);

    const usdc = await isolated.request("/api/x402/usdc-smoke");
    expect(usdc.status).toBe(503);

    // Unrelated path is not registered by USDC route alone.
    const missing = await isolated.request("/api/x402/hbar-smoke");
    expect(missing.status).toBe(404);
  });
});
