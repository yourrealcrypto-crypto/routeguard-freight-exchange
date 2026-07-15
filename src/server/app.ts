import { Hono } from "hono";
import { config } from "../config";
import { renderDevelopmentPage } from "./page";

const app = new Hono();

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
      (config.liveHbarPaymentsEnabled ||
        config.liveUsdcPaymentsEnabled),
  });
});

export default app;