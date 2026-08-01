/**
 * Phase B1 — access-gate configuration, route registration, and the boundary
 * between the RouteGuard access fee and freight money.
 */

import { describe, expect, it } from "vitest";

import { deriveAccessFeeAtomic } from "../src/v2/access/fee";
import {
  resolveV2AccessConfig,
  V2AccessConfigError,
  V2_ACCESS_ROUTES_ENV_KEY,
} from "../src/v2/config";
import { createV2AccessApp } from "../src/v2/http/routes";
import { VERIFIED_USDC_TOKEN_ID } from "../src/x402/usdc-constants";
import {
  activatePath,
  createHarness,
  post,
  TENDER_ID,
} from "./v2-access-route-fixtures";
import { BUDGET, TREASURY } from "./v2-lifecycle-fixtures";

describe("v2 access-gate configuration", () => {
  it("requires a treasury when the routes are enabled", () => {
    expect(() =>
      resolveV2AccessConfig({ [V2_ACCESS_ROUTES_ENV_KEY]: "true" }),
    ).toThrowError(V2AccessConfigError);

    try {
      resolveV2AccessConfig({ [V2_ACCESS_ROUTES_ENV_KEY]: "true" });
    } catch (error) {
      expect((error as V2AccessConfigError).code).toBe("TREASURY_MISSING");
    }
  });

  it("fails closed on a malformed treasury", () => {
    for (const treasury of ["not-an-account", "0.0", "0.0.-1", " ", "0x1234"]) {
      expect(() =>
        resolveV2AccessConfig({
          [V2_ACCESS_ROUTES_ENV_KEY]: "true",
          ROUTEGUARD_ACCESS_TREASURY_ACCOUNT_ID: treasury,
        }),
      ).toThrowError(V2AccessConfigError);
    }
  });

  it("fails closed on a non-verified access token", () => {
    expect(() =>
      resolveV2AccessConfig({
        [V2_ACCESS_ROUTES_ENV_KEY]: "true",
        ROUTEGUARD_ACCESS_TREASURY_ACCOUNT_ID: TREASURY,
        USDC_TOKEN_ID: "0.0.999999",
      }),
    ).toThrowError(V2AccessConfigError);
  });

  it("resolves the exact product access price", () => {
    const config = resolveV2AccessConfig({
      [V2_ACCESS_ROUTES_ENV_KEY]: "true",
      ROUTEGUARD_ACCESS_TREASURY_ACCOUNT_ID: TREASURY,
    });
    expect(config.enabled).toBe(true);
    expect(config.scheme).toBe("exact");
    expect(config.network).toBe("hedera:testnet");
    expect(config.asset).toBe(VERIFIED_USDC_TOKEN_ID);
    expect(config.asset).toBe("0.0.429274");
    expect(config.amountAtomic).toBe("1000");
    expect(config.amountAtomic).toBe(deriveAccessFeeAtomic());
    expect(config.accessTreasuryAccountId).toBe(TREASURY);
  });

  it("stays disabled without the feature flag and never invents a treasury", () => {
    const config = resolveV2AccessConfig({});
    expect(config.enabled).toBe(false);
    expect(config.accessTreasuryAccountId).toBe("");
  });

  it("route registration fails closed on an unusable treasury", async () => {
    const h = await createHarness();
    expect(() =>
      createV2AccessApp({
        ...h.deps,
        config: { ...h.config, accessTreasuryAccountId: "nonsense" },
      }),
    ).toThrowError(V2AccessConfigError);
  });

  it("refuses to charge when the server treasury disagrees with the tender", async () => {
    const h = await createHarness();
    const app = createV2AccessApp({
      ...h.deps,
      config: { ...h.config, accessTreasuryAccountId: "0.0.4242" },
    });
    const response = await post(app, activatePath(), { actionId: "act-1" });
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("ACCESS_NOT_CONFIGURED");
    expect(h.facilitator.verifyCalls).toBe(0);
    expect(h.facilitator.settleCalls).toBe(0);
  });

  it("keeps the access fee separate from freight money", async () => {
    const h = await createHarness();
    const header = await h.paymentHeader(h.activationBinding());
    await post(
      h.app,
      activatePath(),
      { actionId: "act-1" },
      { "X-PAYMENT": header },
    );

    const record = (await h.record())!;
    // Access fee is 1000 atomic to the treasury; the freight budget is
    // untouched and never routed through the access gate.
    expect(record.accessPayments[0]!.amountAtomic).toBe("1000");
    expect(record.accessPayments[0]!.payTo).toBe(TREASURY);
    expect(record.maximumFreightBudgetAtomic).toBe(BUDGET);
    expect(record.fundedAmountAtomic).toBe(BUDGET);
    expect(record.lockedAmountAtomic).toBeNull();
    expect(record.releaseTxId).toBeNull();
    expect(record.accessPayments[0]!.payTo).not.toBe(
      record.winningCarrierAccount,
    );
  });

  it("does not expose internal detail in error responses", async () => {
    const h = await createHarness();
    const response = await post(h.app, activatePath("unknown-tender"), {
      actionId: "act-1",
    });
    const text = await response.text();
    expect(response.status).toBe(404);
    expect(text).not.toMatch(/[A-Za-z]:\\|\/home\/|node_modules/);
    expect(text).not.toContain("at Object");
    expect(text).not.toContain("stack");
  });

  it("performs no network egress during a complete paid flow", async () => {
    const originalFetch = globalThis.fetch;
    const attempts: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      attempts.push(String(input));
      throw new Error("network access is forbidden in Phase B1");
    }) as typeof globalThis.fetch;

    try {
      const h = await createHarness();
      const activationHeader = await h.paymentHeader(h.activationBinding());
      const activation = await post(
        h.app,
        activatePath(),
        { actionId: "act-1" },
        { "X-PAYMENT": activationHeader },
      );
      expect(activation.status).toBe(200);

      const bidModule = await import("./v2-access-route-fixtures");
      const bid = bidModule.testBid();
      const bidHeader = await h.paymentHeader(h.bidBinding());
      const bidResponse = await post(
        h.app,
        `/api/v2/tenders/${TENDER_ID}/v/1/bids/${bid.bidId}`,
        {
          actionId: "bid-1",
          signedAt: bidModule.SERVER_NOW,
          signature: bidModule.signBid({ bid, actionId: "bid-1" }),
          bid,
        },
        { "X-PAYMENT": bidHeader },
      );
      expect(bidResponse.status).toBe(200);

      // Facilitator, Mirror Node, and HCS are all reached over HTTP in
      // production; none of them was contacted here.
      expect(attempts).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("the disabled server app returns 503 for both v2 access routes", async () => {
    const app = (await import("../src/server/app")).default;
    const activate = await app.request(activatePath(TENDER_ID), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actionId: "act-1" }),
    });
    expect(activate.status).toBe(503);
    expect((await activate.json()).error).toBe("ACCESS_NOT_CONFIGURED");

    const bid = await app.request(
      `/api/v2/tenders/${TENDER_ID}/v/1/bids/bid-1`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId: "act-1" }),
      },
    );
    expect(bid.status).toBe(503);
  });
});
