import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";

import { config } from "../config";
import {
  createOperationsDemoApp,
  fastHealth,
  OperationsDemoOrchestrator,
  OperationsDemoStore,
  resolveOperationsDemoConfig,
} from "../operations-demo";
import { MirrorReader } from "../v2/live/mirror-reader";
import { resolveV2AccessConfig } from "../v2/config";
import { createConfiguredV2AccessApp } from "../v2/http/app";
import {
  V2_BID_SUBMIT_PATH,
  V2_TENDER_ACTIVATE_PATH,
} from "../v2/http/routes";
import { registerHbarSmokeRoute } from "../x402/hbar-smoke";
import { registerUsdcSmokeRoute } from "../x402/usdc-smoke";
import { renderDevelopmentPage } from "./page";

const app = new Hono();
const operationsConfig = resolveOperationsDemoConfig(process.env);
const operationsStore = new OperationsDemoStore(operationsConfig.demoDataDir);
const operationsOrchestrator = new OperationsDemoOrchestrator(
  operationsConfig,
  operationsStore,
);
operationsOrchestrator.initialize();
const operationsApp = createOperationsDemoApp({
  orchestrator: operationsOrchestrator,
  config: operationsConfig,
  mirror: new MirrorReader(),
});

function v2AccessDisabled(context: Context): Response {
  return context.json(
    {
      error: "ACCESS_NOT_CONFIGURED",
      message: "RouteGuard v2 access routes are disabled",
    },
    503,
  );
}

app.onError((error, context) => {
  console.error(error);

  return context.json(
    {
      error: "Internal server error",
    },
    500,
  );
});

// Locked production brand assets (RouteGuard + Hedera). Read-only static files.
app.use(
  "/brand/*",
  serveStatic({
    root: "./public",
  }),
);

app.use(
  "/assets/*",
  serveStatic({ root: "./dist/web" }),
);

function operationsHealth(context: Context): Response {
  const result = fastHealth(operationsConfig, operationsOrchestrator);
  return context.json({
    ...result.body,
    livePaymentsEnabled:
      config.liveHederaEnabled &&
      (config.liveHbarPaymentsEnabled || config.liveUsdcPaymentsEnabled),
  }, result.ok ? 200 : 503);
}

app.get("/health", operationsHealth);
app.get("/api/health", (context) => {
  return context.json({
    status: "ok",
    service: "routeguard-freight-exchange",
    network: config.network,
    livePaymentsEnabled:
      config.liveHederaEnabled &&
      (config.liveHbarPaymentsEnabled || config.liveUsdcPaymentsEnabled),
  });
});

app.route("/", operationsApp);

registerHbarSmokeRoute(app);
registerUsdcSmokeRoute(app);

// RouteGuard v2 x402 access gates. Registered only when explicitly enabled and
// fully configured; a missing or malformed access treasury fails closed.
const v2Access = resolveV2AccessConfig(process.env);

if (v2Access.enabled) {
  app.route("/", createConfiguredV2AccessApp(v2Access));
} else {
  app.post(V2_TENDER_ACTIVATE_PATH, v2AccessDisabled);
  app.post(V2_BID_SUBMIT_PATH, v2AccessDisabled);
}

const webIndexPath = path.resolve("dist", "web", "index.html");
function frontend(context: Context): Response {
  if (!existsSync(webIndexPath)) return context.html(renderDevelopmentPage());
  return context.html(readFileSync(webIndexPath, "utf8"));
}

app.get("/operations-demo", (context) => context.redirect("/control", 308));
for (const route of ["/", "/proof", "/control", "/judge", "/pod-review"]) app.get(route, frontend);

// Client-side navigation fallback. API and health paths always remain JSON.
app.get("*", (context) => {
  const requestPath = context.req.path;
  if (requestPath === "/health" || requestPath.startsWith("/api/")) {
    return context.json({ error: "NOT_FOUND", message: "Route not found" }, 404);
  }
  return frontend(context);
});

export default app;
