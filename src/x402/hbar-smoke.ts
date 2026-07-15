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

export const HBAR_SMOKE_PATH =
  "/api/x402/hbar-smoke" as const;

const HBAR_ASSET_ID = "0.0.0";

/**
 * 0.01 HBAR expressed in tinybars.
 *
 * This endpoint exists only to prove the x402/Hedera integration.
 * It is not the final freight-reservation settlement route.
 */
const HBAR_SMOKE_PRICE_TINYBARS = "1000000";

export function registerHbarSmokeRoute(app: Hono): void {
  if (!config.hbarSmokeChallengeEnabled) {
    app.get(HBAR_SMOKE_PATH, (context) => {
      return context.json(
        {
          error: "HBAR smoke challenge publication is disabled.",
          code: "LIVE_HBAR_DISABLED",
          network: config.network,
        },
        503,
      );
    });

    return;
  }

  if (!config.carrierAccountId) {
    throw new Error(
      "CARRIER_ACCOUNT_ID is required for the HBAR smoke route.",
    );
  }

  const facilitator = new HTTPFacilitatorClient({
    url: config.facilitatorUrl,
  });

  const x402Server = new x402ResourceServer(
    facilitator,
  ).register(
    "hedera:*",
    new ExactHederaScheme(),
  );

  const routes: RoutesConfig = {
    [`GET ${HBAR_SMOKE_PATH}`]: {
      description:
        "RouteGuard isolated HBAR x402 integration smoke test",

      accepts: {
        scheme: "exact",
        network: config.network as Network,
        payTo: config.carrierAccountId,

        price: {
          amount: HBAR_SMOKE_PRICE_TINYBARS,
          asset: HBAR_ASSET_ID,
        },

        maxTimeoutSeconds: 180,
      },
    },
  };

  app.use(HBAR_SMOKE_PATH, async (context, next) => {
    const hasPaymentPayload = Boolean(
      context.req.header("PAYMENT-SIGNATURE") ||
      context.req.header("X-PAYMENT"),
    );
    const livePaymentSubmissionEnabled =
      config.liveHederaEnabled &&
      config.liveHbarPaymentsEnabled;

    if (hasPaymentPayload && !livePaymentSubmissionEnabled) {
      return context.json(
        {
          error: "Live HBAR payment submission is disabled.",
          code: "LIVE_HBAR_DISABLED",
          network: config.network,
        },
        503,
      );
    }

    await next();
  });

  app.use(
    HBAR_SMOKE_PATH,
    paymentMiddleware(routes, x402Server),
  );

  app.get(HBAR_SMOKE_PATH, (context) => {
    return context.json({
      status: "paid",
      purpose: "x402-hbar-smoke-test",
      network: config.network,
      receiver: config.carrierAccountId,
      amountTinybars: HBAR_SMOKE_PRICE_TINYBARS,
      amountHbar: "0.01",
    });
  });
}
