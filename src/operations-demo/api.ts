import { mkdirSync } from "node:fs";
import path from "node:path";

import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z, ZodError } from "zod";

import { parseDemoPrivateKey } from "../v2/live/client";
import type { MirrorReader } from "../v2/live/mirror-reader";
import type { OperationsDemoConfig } from "./config";
import { LIVE_PROJECTED_WRITES } from "./constants";
import { publicDemoError } from "./errors";
import { OperationsDemoOrchestrator } from "./orchestrator";
import { DemoRateLimiter } from "./rate-limit";
import type { DemoCapabilities, DemoEvent, OperationsDemoSession } from "./types";

const CreateSchema = z.object({ mode: z.enum(["REPLAY", "SIMULATION", "LIVE"]), role: z.enum(["SHIPPER", "CARRIER"]).optional() }).strict();
const ActionSchema = z.object({
  action: z.enum(["OPEN_TENDER", "FUND_ESCROW", "SUBMIT_OFFER", "SELECT_WINNER", "SUBMIT_POD", "RUN_ADVISORY", "ACCEPT_POD", "RELEASE_FREIGHT", "REQUEST_CORRECTION", "OPEN_DISPUTE"]),
  actionId: z.string(), idempotencyKey: z.string(), payload: z.record(z.unknown()),
}).strict();

function ip(c: Context): string { return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "local"; }
function adminToken(c: Context): string | null {
  const auth = c.req.header("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : c.req.header("x-routeguard-demo-admin") ?? null;
}

export function publicSession(session: OperationsDemoSession): Record<string, unknown> {
  const { steps: _steps, events: _events, actionResults: _results, inFlightActionId: _inFlight, ...safe } = session;
  return safe;
}

export type OperationsDemoApiDeps = {
  readonly orchestrator: OperationsDemoOrchestrator;
  readonly config: OperationsDemoConfig;
  readonly mirror?: MirrorReader;
  readonly limiter?: DemoRateLimiter;
  readonly sleep?: (ms: number) => Promise<void>;
};

export function createOperationsDemoApp(deps: OperationsDemoApiDeps): Hono {
  const app = new Hono();
  const limiter = deps.limiter ?? new DemoRateLimiter();
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  const handle = (c: Context, error: unknown): Response => {
    if (error instanceof ZodError) return c.json({ error: "DEMO_ACTION_CONFLICT", message: "request body is invalid" }, 400);
    const info = publicDemoError(error);
    return c.json({ error: info.code, message: info.message }, info.status as never);
  };

  app.get("/api/operations-demo/capabilities", async (c) => {
    try {
      limiter.assert(`read:${ip(c)}`, 60, 60_000);
      const active = deps.orchestrator.store.activeLive();
      let mirrorReady = false;
      let controlledBalancesReady = false;
      let liveModeEnabled = deps.config.liveEnabled && deps.orchestrator.liveAdapterReady;
      let liveModeReason: string = deps.config.liveReason;
      if (deps.config.liveEnabled && !deps.orchestrator.liveAdapterReady) liveModeReason = "DISABLED_DEMO_INFRASTRUCTURE_PENDING";
      if (deps.config.liveEnabled && deps.mirror && deps.config.contractId && deps.config.topicId) {
        try {
          const [contract, topic, hbar, usdc] = await Promise.all([
            deps.mirror.contractIdentity(deps.config.contractId), deps.mirror.topicExists(deps.config.topicId),
            deps.mirror.hbarBalance(deps.config.operatorAccountId), deps.mirror.accountBalance(deps.config.operatorAccountId, deps.config.tokenId),
          ]);
          mirrorReady = contract.contractId === deps.config.contractId && topic;
          controlledBalancesReady = hbar >= 500_000_000n && usdc >= 22_000n;
          if (!controlledBalancesReady) { liveModeEnabled = false; liveModeReason = "DEMO_BALANCE_INSUFFICIENT"; }
          if (deps.orchestrator.store.dailySuccessfulWrites() + LIVE_PROJECTED_WRITES > deps.config.maxWritesPerDay) {
            liveModeEnabled = false; liveModeReason = "DEMO_DAILY_LIMIT_REACHED";
          }
        } catch { liveModeEnabled = false; liveModeReason = "DEMO_MIRROR_UNAVAILABLE"; }
      }
      const capabilities: DemoCapabilities = {
        replayAvailable: true, simulationAvailable: true, liveModeEnabled, liveModeReason,
        activeLiveSession: { active: Boolean(active), sessionId: active?.sessionId ?? null, expiresAt: active ? [active.idleExpiresAt, active.absoluteExpiresAt].sort()[0]! : null },
        effectiveAmountCaps: {
          tokenId: "0.0.429274", tokenDecimals: 6, maximumBudgetAtomic: "20000",
          winningAmountAtomic: "15000", excessRefundAtomic: "5000", accessFeeAtomic: "1000",
        },
        perSessionWriteLimit: deps.config.maxWritesPerSession, dailyWriteLimit: deps.config.maxWritesPerDay,
        contractConfigured: Boolean(deps.config.contractId), topicConfigured: Boolean(deps.config.topicId),
        mirrorReady, controlledBalancesReady, testnetOnly: true,
      };
      return c.json(capabilities);
    } catch (error) { return handle(c, error); }
  });

  app.get("/api/operations-demo/replay", (c) => {
    try { limiter.assert(`read:${ip(c)}`, 60, 60_000); return c.json(deps.orchestrator.replay.load()); }
    catch (error) { return handle(c, error); }
  });

  app.post("/api/operations-demo/sessions", async (c) => {
    try {
      limiter.assert(`session:${ip(c)}`, 1, 60_000);
      const body = CreateSchema.parse(await c.req.json());
      if (body.mode === "LIVE") limiter.assert("global-live-create", 10, 3_600_000);
      const session = await deps.orchestrator.createSession(body.mode, body.role ?? "SHIPPER", adminToken(c));
      return c.json(publicSession(session), 201);
    } catch (error) { return handle(c, error); }
  });

  app.get("/api/operations-demo/sessions/:sessionId", async (c) => {
    try { return c.json(publicSession(await deps.orchestrator.getSession(c.req.param("sessionId")))); }
    catch (error) { return handle(c, error); }
  });

  app.post("/api/operations-demo/sessions/:sessionId/actions", async (c) => {
    try {
      limiter.assert(`action:${ip(c)}`, 20, 60_000);
      const body = ActionSchema.parse(await c.req.json());
      return c.json(await deps.orchestrator.act(c.req.param("sessionId"), body));
    } catch (error) { return handle(c, error); }
  });

  app.get("/api/operations-demo/sessions/:sessionId/events", async (c) => {
    const sessionId = c.req.param("sessionId");
    const last = Number.parseInt(c.req.header("last-event-id") ?? c.req.query("lastEventId") ?? "0", 10) || 0;
    try { await deps.orchestrator.getSession(sessionId); }
    catch (error) { return handle(c, error); }
    return streamSSE(c, async (stream) => {
      let cursor = last;
      let heartbeatAt = Date.now();
      while (!stream.aborted) {
        const session = await deps.orchestrator.getSession(sessionId);
        const pending = session.events.filter((event: DemoEvent) => event.id > cursor);
        for (const event of pending) {
          await stream.writeSSE({ id: String(event.id), event: event.type.toLowerCase(), data: JSON.stringify(event.data) });
          cursor = event.id;
        }
        if (Date.now() - heartbeatAt >= 15_000) { await stream.writeSSE({ event: "heartbeat", data: "{}" }); heartbeatAt = Date.now(); }
        if (["COMPLETED", "EXPIRED", "ABORTED"].includes(session.workflowState)) break;
        await sleep(1_000);
      }
    });
  });

  return app;
}

export function fastHealth(config: OperationsDemoConfig, orchestrator: OperationsDemoOrchestrator): { ok: boolean; body: Record<string, unknown> } {
  try {
    orchestrator.replay.load();
    if (config.liveEnabled) {
      orchestrator.store.initialize();
      for (const dir of ["lifecycle", "tenders", "bids", "payment-claims"].map((name) => path.join(config.v2DataDir, name))) mkdirSync(dir, { recursive: true });
      mkdirSync(config.podDataDir, { recursive: true });
      if (!config.operatorPrivateKey || !config.carrierPrivateKey || !config.operatorPublicKey || !config.carrierPublicKey || !config.podMasterKeyBase64) throw new Error("live secrets incomplete");
      const operator = parseDemoPrivateKey(config.operatorPrivateKey);
      const carrier = parseDemoPrivateKey(config.carrierPrivateKey);
      if (operator.publicKey.toStringRaw() !== config.operatorPublicKey || carrier.publicKey.toStringRaw() !== config.carrierPublicKey) throw new Error("signer public identity mismatch");
      if (Buffer.from(config.podMasterKeyBase64, "base64").length !== 32) throw new Error("POD key invalid");
    }
    return { ok: true, body: { status: "ok", service: "routeguard-freight-exchange", replay: "ready", liveMode: config.liveEnabled ? "enabled" : "disabled", network: "hedera:testnet", mirrorCalls: 0 } };
  } catch { return { ok: false, body: { status: "error", service: "routeguard-freight-exchange", error: "DEMO_CONFIG_INVALID", mirrorCalls: 0 } }; }
}
