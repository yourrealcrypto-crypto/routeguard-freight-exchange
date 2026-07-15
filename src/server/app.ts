import { Hono } from "hono";

import { config } from "../config";
import { registerHbarSmokeRoute } from "../x402/hbar-smoke";
import { registerUsdcSmokeRoute } from "../x402/usdc-smoke";
import { renderDevelopmentPage } from "./page";

const app = new Hono();

app.onError((error, context) => {
  console.error(error);

  return context.json(
    {
      error: "Internal server error",
    },
    500,
  );
});

app.get("/", (context) => {
  return context.html(renderDevelopmentPage());
});

app.get("/api/health", (context) => {
  return context.json({
    status: "ok",
    service: "routeguard-freight-exchange",
    network: config.network,

    livePaymentsEnabled:
      config.liveHederaEnabled &&
      (
        config.liveHbarPaymentsEnabled ||
        config.liveUsdcPaymentsEnabled
      ),
  });
});

registerHbarSmokeRoute(app);
registerUsdcSmokeRoute(app);

export default app;
