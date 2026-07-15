import type { Hono } from "hono";

import {
  HTTPFacilitatorClient,
  x402ResourceServer,
} from "@x402/core/server";

import type { RoutesConfig } from "@x402/core/server";
import type { Network } from "@x402/core/types";

import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { paymentMiddleware } from "@x402/hono";

import { config } from "../config";
import { USDC_SMOKE_MAX_TIMEOUT_SECONDS } from "./usdc-constants";

export const USDC_SMOKE_PATH =
  "/api/x402/usdc-smoke" as const;

/**
 * Isolated HTS USDC x402 smoke route.
 *
 * Challenge publication is controlled by ENABLE_USDC_SMOKE_CHALLENGE.
 * Live settlement additionally requires ENABLE_LIVE_HEDERA and
 * ENABLE_LIVE_USDC_PAYMENTS. Payment-bearing requests fail closed when
 * either live flag is false and never construct a signer.
 */
export function registerUsdcSmokeRoute(app: Hono): void {
  if (!config.usdcSmokeChallengeEnabled) {
    app.get(USDC_SMOKE_PATH, (context) => {
      return context.json(
        {
          error: "USDC smoke challenge publication is disabled.",
          code: "LIVE_USDC_DISABLED",
          network: config.network,
        },
        503,
      );
    });

    return;
  }

  if (!config.carrierAccountId) {
    throw new Error(
      "CARRIER_ACCOUNT_ID is required for the USDC smoke route.",
    );
  }

  const facilitator = new HTTPFacilitatorClient({
    url: config.facilitatorUrl,
  });

  // feePayer is injected dynamically from Blocky402 /supported via
  // ExactHederaScheme.enhancePaymentRequirements — not hardcoded here.
  const x402Server = new x402ResourceServer(
    facilitator,
  ).register(
    "hedera:*",
    new ExactHederaScheme(),
  );

  const routes: RoutesConfig = {
    [`GET ${USDC_SMOKE_PATH}`]: {
      description:
        "RouteGuard isolated HTS USDC x402 integration smoke test",

      accepts: {
        scheme: "exact",
        network: config.network as Network,
        payTo: config.carrierAccountId,

        price: {
          amount: config.usdcSmokeAmountSmallestUnits,
          asset: config.usdcTokenId,
        },

        maxTimeoutSeconds: USDC_SMOKE_MAX_TIMEOUT_SECONDS,
      },
    },
  };

  app.use(USDC_SMOKE_PATH, async (context, next) => {
    const hasPaymentPayload = Boolean(
      context.req.header("PAYMENT-SIGNATURE") ||
      context.req.header("X-PAYMENT"),
    );
    const livePaymentSubmissionEnabled =
      config.liveHederaEnabled &&
      config.liveUsdcPaymentsEnabled;

    if (hasPaymentPayload && !livePaymentSubmissionEnabled) {
      return context.json(
        {
          error: "Live USDC payment submission is disabled.",
          code: "LIVE_USDC_DISABLED",
          network: config.network,
        },
        503,
      );
    }

    await next();
  });

  app.use(
    USDC_SMOKE_PATH,
    paymentMiddleware(routes, x402Server),
  );

  app.get(USDC_SMOKE_PATH, (context) => {
    return context.json({
      status: "paid",
      purpose: "x402-usdc-smoke-test",
      network: config.network,
      receiver: config.carrierAccountId,
      asset: config.usdcTokenId,
      amountSmallestUnits: config.usdcSmokeAmountSmallestUnits,
      amountDisplay: config.usdcSmokeAmountDisplay,
      decimals: config.usdcDecimals,
    });
  });
}
