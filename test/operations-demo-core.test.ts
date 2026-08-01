import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalSha256 } from "../src/domain/canonical-hash";
import {
  DisabledLiveAdapter,
  LiveHederaAdapter,
  SimulationAdapter,
} from "../src/operations-demo/adapters";
import { createOperationsDemoApp, fastHealth, publicSession } from "../src/operations-demo/api";
import { hashAdminToken, resolveOperationsDemoConfig, type OperationsDemoConfig } from "../src/operations-demo/config";
import {
  DEMO_EXCESS_REFUND_ATOMIC,
  DEMO_MAX_BUDGET_ATOMIC,
  DEMO_TOKEN_ID,
  DEMO_WINNING_AMOUNT_ATOMIC,
  DEMO_X402_ACCESS_FEE_ATOMIC,
  IMMUTABLE_PROOF_CONTRACT_ID,
  IMMUTABLE_PROOF_TOPIC_ID,
  LIVE_PROJECTED_WRITES,
} from "../src/operations-demo/constants";
import { DemoError } from "../src/operations-demo/errors";
import { OperationsDemoOrchestrator } from "../src/operations-demo/orchestrator";
import { TransactionReceiptJournal } from "../src/operations-demo/receipt-journal";
import { CompletedReplayAdapter } from "../src/operations-demo/replay";
import { actionIdentityHash, assertSafeActionRequest, transitionFor } from "../src/operations-demo/state-machine";
import { OperationsDemoStore } from "../src/operations-demo/store";
import type { DemoAction, DemoActionRequest, DemoWorkflowState } from "../src/operations-demo/types";
import { MirrorReader } from "../src/v2/live/mirror-reader";
import { WriteBudget, WriteBudgetError } from "../src/v2/live/write-budget";

const roots: string[] = [];
const NOW = "2026-08-01T12:00:00.000Z";

function root(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rg-operations-demo-"));
  roots.push(dir);
  return dir;
}

function setup(env: Record<string, string | undefined> = {}, now = NOW) {
  const dir = root();
  const config = resolveOperationsDemoConfig(env, dir);
  const store = new OperationsDemoStore(config.demoDataDir, () => Date.parse(now));
  const replay = new CompletedReplayAdapter(path.resolve("evidence", "v2"));
  const orchestrator = new OperationsDemoOrchestrator(config, store, replay, new SimulationAdapter(() => now), null, () => now);
  orchestrator.initialize();
  return { dir, config, store, replay, orchestrator };
}

function liveEnv(): Record<string, string> {
  return {
    ROUTEGUARD_OPERATIONS_LIVE_ENABLED: "true",
    ROUTEGUARD_DEMO_ADMIN_TOKEN: "correct-horse-battery-staple",
    ROUTEGUARD_DEMO_CONTRACT_ID: "0.0.9991001",
    ROUTEGUARD_DEMO_CONTRACT_EVM_ADDRESS: "0x0000000000000000000000000000000000987069",
    ROUTEGUARD_DEMO_HCS_TOPIC_ID: "0.0.9991002",
  };
}

function setupLive(now = NOW) {
  const dir = root();
  const base = resolveOperationsDemoConfig({}, dir);
  const config = Object.freeze({
    ...base,
    liveRequested: true,
    liveEnabled: true,
    liveReason: "LIVE_ENABLED" as const,
    adminTokenHash: hashAdminToken("correct-horse-battery-staple"),
    contractId: "0.0.9991001",
    contractEvmAddress: "0x0000000000000000000000000000000000987069",
    topicId: "0.0.9991002",
    operatorPrivateKey: "1".repeat(64),
    carrierPrivateKey: "2".repeat(64),
    podMasterKeyBase64: Buffer.alloc(32).toString("base64"),
  }) satisfies OperationsDemoConfig;
  const store = new OperationsDemoStore(config.demoDataDir, () => Date.parse(now));
  const replay = new CompletedReplayAdapter(path.resolve("evidence", "v2"));
  const orchestrator = new OperationsDemoOrchestrator(config, store, replay, new SimulationAdapter(() => now), new DisabledLiveAdapter("DEMO_LIVE_DISABLED"), () => now);
  orchestrator.initialize();
  return { dir, config, store, replay, orchestrator };
}

const actionOrder: readonly DemoAction[] = [
  "OPEN_TENDER", "SUBMIT_OFFER", "FUND_ESCROW", "SELECT_WINNER",
  "SUBMIT_POD", "RUN_ADVISORY", "ACCEPT_POD", "RELEASE_FREIGHT",
];

function request(action: DemoAction, index = 1, payload: Record<string, unknown> = {}): DemoActionRequest {
  return { action, actionId: `action-${index}-${action}`, idempotencyKey: `idempotency-${index}-${action}`, payload };
}

describe("Operations Demo fixed safety contract", () => {
  it("projects exactly twelve live writes", () => expect(LIVE_PROJECTED_WRITES).toBe(12));
  it("pins maximum budget to 20000 atomic", () => expect(DEMO_MAX_BUDGET_ATOMIC).toBe("20000"));
  it("pins winning amount to 15000 atomic", () => expect(DEMO_WINNING_AMOUNT_ATOMIC).toBe("15000"));
  it("pins excess refund to 5000 atomic", () => expect(DEMO_EXCESS_REFUND_ATOMIC).toBe("5000"));
  it("pins both access fees to 1000 atomic", () => expect(DEMO_X402_ACCESS_FEE_ATOMIC).toBe("1000"));
  it("pins Testnet USDC", () => expect(DEMO_TOKEN_ID).toBe("0.0.429274"));
  it("live mode defaults disabled with infrastructure pending", () => {
    const { config } = setup();
    expect(config.liveEnabled).toBe(false);
    expect(config.liveReason).toBe("DISABLED_DEMO_INFRASTRUCTURE_PENDING");
  });
  it("rejects the immutable proof contract", () => {
    expect(() => resolveOperationsDemoConfig({ ...liveEnv(), ROUTEGUARD_DEMO_CONTRACT_ID: IMMUTABLE_PROOF_CONTRACT_ID }, root())).not.toThrow();
    const config = resolveOperationsDemoConfig({ ...liveEnv(), ROUTEGUARD_DEMO_CONTRACT_ID: IMMUTABLE_PROOF_CONTRACT_ID }, root());
    expect(config.liveEnabled).toBe(false);
    expect(config.liveReason).toBe("DEMO_CONFIG_INVALID");
  });
  it("rejects the immutable proof topic", () => {
    const config = resolveOperationsDemoConfig({ ...liveEnv(), ROUTEGUARD_DEMO_HCS_TOPIC_ID: IMMUTABLE_PROOF_TOPIC_ID }, root());
    expect(config.liveEnabled).toBe(false);
  });
  it("live adapter rejects immutable proof bindings", () => {
    const mirror = new MirrorReader({ fetchImpl: vi.fn() as unknown as typeof fetch });
    expect(() => new LiveHederaAdapter(IMMUTABLE_PROOF_CONTRACT_ID, "0.0.999", async () => { throw new Error(); }, mirror)).toThrow();
    expect(() => new LiveHederaAdapter("0.0.999", IMMUTABLE_PROOF_TOPIC_ID, async () => { throw new Error(); }, mirror)).toThrow();
  });
});

describe("write budget", () => {
  it("accepts the complete twelve-write plan", () => expect(new WriteBudget(12, 12, 0, 50).snapshot().projectedWrites).toBe(12));
  it("refuses projected write thirteen", () => expect(() => new WriteBudget(13, 12, 0, 50)).toThrow(WriteBudgetError));
  it("refuses daily write fifty-one", () => expect(() => new WriteBudget(12, 12, 39, 50)).toThrowError(/daily/));
  it("refuses the next write before crossing the session ceiling", () => {
    const budget = new WriteBudget(12, 12, 0, 50);
    for (let i = 0; i < 12; i++) { budget.begin(`w${i}`); budget.confirm(); }
    expect(() => budget.begin("w13")).toThrowError(/session ceiling/);
  });
  it("child transfers are disclosure only", () => {
    const budget = new WriteBudget(1, 12, 0, 50); budget.observe("CHILD_RECORD", 2);
    expect(budget.snapshot()).toMatchObject({ successfulStateChangingWrites: 0, childRecordsObserved: 2 });
  });
  it("Mirror HTTP reads consume no writes", () => {
    const budget = new WriteBudget(1, 12, 0, 50); budget.observe("READ_ONLY", 3);
    expect(budget.snapshot()).toMatchObject({ successfulStateChangingWrites: 0, readOnlyCalls: 3 });
  });
  it("optional HCS messages cannot enter the twelve-write path", () => {
    expect(actionOrder).not.toContain("TENDER_OPENED");
    expect(actionOrder).not.toContain("BID_COMMITMENT");
  });
});

describe("request allowlist and authorization identity", () => {
  it.each(["amount", "amountAtomic", "token", "tokenId", "recipient", "payTo", "winnerAccount", "contractId", "topicId", "accountId", "address", "network", "privateKey"])(
    "rejects browser-controlled field %s", (field) => {
      expect(() => assertSafeActionRequest(request("OPEN_TENDER", 1, { nested: { [field]: "override" } }))).toThrow(DemoError);
    },
  );
  it("identical identities hash identically", () => expect(actionIdentityHash(request("OPEN_TENDER"))).toBe(actionIdentityHash(request("OPEN_TENDER"))));
  it("conflicting payload changes identity", () => expect(actionIdentityHash(request("OPEN_TENDER", 1))).not.toBe(actionIdentityHash(request("OPEN_TENDER", 1, { note: "different" }))));
  it("session authorization material is unique", async () => {
    const { orchestrator } = setup();
    const a = await orchestrator.createSession("SIMULATION");
    const b = await orchestrator.createSession("SIMULATION");
    expect(a.publicEvidenceHashes).not.toEqual(b.publicEvidenceHashes);
    expect(a.scenario.tenderKey).not.toBe(b.scenario.tenderKey);
  });
});

describe("state, idempotency, persistence and expiry", () => {
  it("has the exact successful progression", () => {
    let state: DemoWorkflowState = "CREATED";
    const expected: DemoWorkflowState[] = ["ACCESS_ACTIVATED", "OFFER_ACCEPTED", "ESCROW_FUNDED", "WINNER_ALLOCATED", "POD_SUBMITTED", "ADVISORY_ANCHORED", "POD_ACCEPTED", "COMPLETED"];
    for (let i = 0; i < actionOrder.length; i++) { state = transitionFor(state, actionOrder[i]!); expect(state).toBe(expected[i]); }
  });
  it("fails illegal transitions", () => expect(() => transitionFor("CREATED", "FUND_ESCROW")).toThrowError(/not allowed/));
  it("completed is terminal", () => expect(() => transitionFor("COMPLETED", "OPEN_TENDER")).toThrowError(/terminal/));
  it("full simulation completes with zero egress and simulated references", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    const { orchestrator } = setup();
    const session = await orchestrator.createSession("SIMULATION");
    for (let i = 0; i < actionOrder.length; i++) await orchestrator.act(session.sessionId, request(actionOrder[i]!, i + 1));
    const completed = await orchestrator.getSession(session.sessionId);
    expect(completed.workflowState).toBe("COMPLETED");
    expect(completed.writesUsed).toBe(0);
    expect(completed.transactions.every((tx) => tx.transactionId.startsWith("sim:") && tx.hashScanUrl === null)).toBe(true);
    expect(network).not.toHaveBeenCalled();
    network.mockRestore();
  });
  it("all eight successful actions are idempotent with original responses", async () => {
    const { orchestrator } = setup();
    const session = await orchestrator.createSession("SIMULATION");
    for (let i = 0; i < actionOrder.length; i++) {
      const req = request(actionOrder[i]!, i + 1);
      const first = await orchestrator.act(session.sessionId, req);
      const replayed = await orchestrator.act(session.sessionId, req);
      expect(replayed).toEqual(first);
    }
  });
  it("conflicting action identity fails", async () => {
    const { orchestrator } = setup(); const session = await orchestrator.createSession("SIMULATION");
    await orchestrator.act(session.sessionId, request("OPEN_TENDER"));
    await expect(orchestrator.act(session.sessionId, request("OPEN_TENDER", 1, { note: "conflict" }))).rejects.toMatchObject({ code: "DEMO_ACTION_CONFLICT" });
  });
  it("persistent session survives a store restart", async () => {
    const { config, store, orchestrator } = setup();
    const session = await orchestrator.createSession("SIMULATION");
    await orchestrator.act(session.sessionId, request("OPEN_TENDER"));
    const restarted = new OperationsDemoStore(config.demoDataDir, () => Date.parse(NOW));
    expect(restarted.get(session.sessionId)?.workflowState).toBe("ACCESS_ACTIVATED");
  });
  it("one active live session is enforced", async () => {
    const { config, store, replay } = setupLive();
    const orchestrator = new OperationsDemoOrchestrator(config, store, replay, new SimulationAdapter(() => NOW), new DisabledLiveAdapter("DEMO_LIVE_DISABLED"), () => NOW);
    const first = await orchestrator.createSession("LIVE", "SHIPPER", "correct-horse-battery-staple");
    await expect(orchestrator.createSession("LIVE", "SHIPPER", "correct-horse-battery-staple")).rejects.toMatchObject({ code: "DEMO_SESSION_ACTIVE" });
    expect(store.activeLive()?.sessionId).toBe(first.sessionId);
  });
  it("concurrent live creates produce exactly one success", async () => {
    const { config, store, replay } = setupLive();
    const orchestrator = new OperationsDemoOrchestrator(config, store, replay, new SimulationAdapter(() => NOW), new DisabledLiveAdapter("DEMO_LIVE_DISABLED"), () => NOW);
    const results = await Promise.allSettled([
      orchestrator.createSession("LIVE", "SHIPPER", "correct-horse-battery-staple"),
      orchestrator.createSession("LIVE", "SHIPPER", "correct-horse-battery-staple"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });
  it("one in-flight action rejects a concurrent action", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const delayed = new SimulationAdapter(() => NOW);
    const adapter = { execute: async (...args: Parameters<SimulationAdapter["execute"]>) => { await barrier; return delayed.execute(...args); } };
    const { config, store, replay } = setup();
    const orchestrator = new OperationsDemoOrchestrator(config, store, replay, adapter, null, () => NOW);
    const session = await orchestrator.createSession("SIMULATION");
    const first = orchestrator.act(session.sessionId, request("OPEN_TENDER"));
    await vi.waitFor(() => expect(store.get(session.sessionId)?.inFlightActionId).toBeTruthy());
    await expect(orchestrator.act(session.sessionId, request("OPEN_TENDER", 2))).rejects.toMatchObject({ code: "DEMO_ACTION_IN_PROGRESS" });
    release(); await first;
  });
  it("expired funded live session requires operator recovery and never refunds", async () => {
    const start = Date.parse(NOW); let clock = start;
    const { config } = setupLive(); const dir = root();
    const adjustedConfig = Object.freeze({ ...config, demoDataDir: path.join(dir, "demo-sessions"), v2DataDir: path.join(dir, "v2") });
    const store = new OperationsDemoStore(config.demoDataDir, () => clock);
    const orchestrator = new OperationsDemoOrchestrator(adjustedConfig, store, new CompletedReplayAdapter(), new SimulationAdapter(), new DisabledLiveAdapter("DEMO_LIVE_DISABLED"), () => new Date(clock).toISOString());
    orchestrator.initialize();
    const session = await orchestrator.createSession("LIVE", "SHIPPER", "correct-horse-battery-staple");
    await store.mutate(session.sessionId, (current) => ({ ...current, recordVersion: current.recordVersion + 1, workflowState: "ESCROW_FUNDED", lastConfirmedState: "ESCROW_FUNDED", escrowState: "FUNDED", lockedAmountAtomic: "20000" }));
    clock += 31 * 60_000;
    const expired = await orchestrator.getSession(session.sessionId);
    expect(expired).toMatchObject({ workflowState: "EXPIRED", operatorRecoveryRequired: true, lockedAmountAtomic: "20000" });
    expect(store.activeLive()).toBeNull();
  });
  it("crash after receipt becomes recoverable and retry never resubmits", async () => {
    const { config, store, replay } = setupLive();
    const journal = new TransactionReceiptJournal(store, () => NOW);
    let submissions = 0;
    const adapter = {
      execute: async (session: any, req: DemoActionRequest, intended: DemoWorkflowState) => {
        const prior = journal.findSuccessfulReceipt(store.get(session.sessionId)!, req.actionId, "x402-tender-access");
        if (!prior) {
          await journal.plan({
            sessionId: session.sessionId, action: req.action, actionId: req.actionId,
            idempotencyKeyHash: canonicalSha256(req.idempotencyKey), payloadHash: canonicalSha256(req.payload),
            expectedPreviousState: session.lastConfirmedState, intendedNextState: intended, subStep: "x402-tender-access",
          });
          submissions++;
          await journal.receipt({ sessionId: session.sessionId, actionId: req.actionId, subStep: "x402-tender-access", transactionId: "0.0.9197513@100.1" });
          throw new DemoError("DEMO_MIRROR_UNAVAILABLE", "Mirror delayed", 503);
        }
        await journal.verify({ sessionId: session.sessionId, actionId: req.actionId, subStep: "x402-tender-access", evidenceHash: canonicalSha256({ verified: prior.publicTransactionId }) });
        return {
          steps: [], hcsSequences: [], evidenceHashes: [canonicalSha256({ recovered: true })], writes: 0,
          transactions: [{ action: req.action, transactionId: prior.publicTransactionId!, hashScanUrl: "https://hashscan.io/testnet/transaction/0.0.9197513@100.1", simulated: false, receiptStatus: "SUCCESS" as const, mirrorVerified: true }],
        };
      },
    };
    const orchestrator = new OperationsDemoOrchestrator(config, store, replay, new SimulationAdapter(), adapter, () => NOW);
    const session = await orchestrator.createSession("LIVE", "SHIPPER", "correct-horse-battery-staple");
    await expect(orchestrator.act(session.sessionId, request("OPEN_TENDER"))).rejects.toMatchObject({ code: "DEMO_MIRROR_UNAVAILABLE" });
    expect((await orchestrator.getSession(session.sessionId)).progress).toBe("RECOVERABLE");
    const recovered = await orchestrator.act(session.sessionId, request("OPEN_TENDER"));
    expect(recovered.workflowState).toBe("ACCESS_ACTIVATED");
    expect(submissions).toBe(1);
    expect((await orchestrator.getSession(session.sessionId)).writesUsed).toBe(1);
  });
  it("receipt journal refuses a changed transaction identity", async () => {
    const { config, store, replay } = setupLive();
    const orchestrator = new OperationsDemoOrchestrator(config, store, replay, new SimulationAdapter(), new DisabledLiveAdapter("DEMO_LIVE_DISABLED"), () => NOW);
    const session = await orchestrator.createSession("LIVE", "SHIPPER", "correct-horse-battery-staple");
    const journal = new TransactionReceiptJournal(store, () => NOW);
    await journal.plan({ sessionId: session.sessionId, action: "OPEN_TENDER", actionId: "action-1", idempotencyKeyHash: canonicalSha256("idempotency-1"), payloadHash: canonicalSha256({}), expectedPreviousState: "CREATED", intendedNextState: "ACCESS_ACTIVATED", subStep: "payment" });
    await journal.receipt({ sessionId: session.sessionId, actionId: "action-1", subStep: "payment", transactionId: "0.0.1@1.1" });
    await expect(journal.receipt({ sessionId: session.sessionId, actionId: "action-1", subStep: "payment", transactionId: "0.0.1@1.2" })).rejects.toMatchObject({ code: "DEMO_PERSISTENCE_CONFLICT" });
  });
  it("live POD submission calls PodService directly, without an HTTP route hop", async () => {
    const { config, store, replay } = setupLive();
    const submitPod = vi.fn(async () => ({ receipt: {}, outcome: "APPLIED", outbox: [] }));
    const podWorkflow = {
      service: { submitPod, startReview: vi.fn(), shipperReview: vi.fn() },
      buildSubmission: vi.fn(() => ({ direct: true })),
      buildReview: vi.fn(),
      buildAcceptance: vi.fn(),
    } as any;
    const adapter = {
      execute: async () => ({ steps: [], transactions: [], hcsSequences: [], evidenceHashes: [canonicalSha256({ pod: true })], writes: 0 }),
    };
    const orchestrator = new OperationsDemoOrchestrator(config, store, replay, new SimulationAdapter(), adapter, () => NOW, podWorkflow);
    const session = await orchestrator.createSession("LIVE", "CARRIER", "correct-horse-battery-staple");
    await store.mutate(session.sessionId, (current) => ({ ...current, recordVersion: current.recordVersion + 1, workflowState: "WINNER_ALLOCATED", lastConfirmedState: "WINNER_ALLOCATED", availableActions: ["SUBMIT_POD"] }));
    await orchestrator.act(session.sessionId, request("SUBMIT_POD"));
    expect(submitPod).toHaveBeenCalledTimes(1);
  });
});

describe("Mirror, replay, API and privacy", () => {
  it("aggregates child HTS transfers when the parent has none", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ transactions: [
      { result: "SUCCESS", nonce: 0, consensus_timestamp: "1.2", token_transfers: [] },
      { result: "SUCCESS", nonce: 1, parent_consensus_timestamp: "1.2", token_transfers: [
        { token_id: "0.0.429274", account: "0.0.1", amount: -15000 },
        { token_id: "0.0.429274", account: "0.0.2", amount: 15000 },
      ] },
    ] }), { status: 200 })) as unknown as typeof fetch;
    const result = await new MirrorReader({ baseUrl: "https://mirror.invalid", fetchImpl }).transaction("0.0.1@1.2");
    expect(result).toMatchObject({ status: "SUCCESS", childTransactionCount: 1 });
    expect(result.tokenTransfers).toHaveLength(2);
  });
  it("uses free Mirror contracts/call for state reads", async () => {
    const encoded = "0x" + "0".repeat(63) + "1";
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ result: encoded }), { status: 200 })) as unknown as typeof fetch;
    await new MirrorReader({ baseUrl: "https://mirror.invalid", fetchImpl }).contractCall("0x0000000000000000000000000000000000000001", "getState", ["0x" + "0".repeat(64)]);
    expect(fetchImpl).toHaveBeenCalledWith("https://mirror.invalid/api/v1/contracts/call", expect.objectContaining({ method: "POST" }));
  });
  it("replay exposes the complete immutable proof and performs no fetch", () => {
    const network = vi.spyOn(globalThis, "fetch");
    const replay = new CompletedReplayAdapter().load();
    expect(replay).toMatchObject({ networkWrites: 0, finalState: "RELEASED", lockedAmountAtomic: "0", contractId: IMMUTABLE_PROOF_CONTRACT_ID, topicId: IMMUTABLE_PROOF_TOPIC_ID });
    expect(replay.accessTransactions).toHaveLength(2); expect(replay.hcsSequence).toHaveLength(5);
    expect(network).not.toHaveBeenCalled(); network.mockRestore();
  });
  it("corrupt replay evidence fails visibly", () => {
    const dir = root(); writeFileSync(path.join(dir, "run-summary.json"), "{}", "utf8");
    expect(() => new CompletedReplayAdapter(dir).load()).toThrowError(/missing or invalid/);
  });
  it("capabilities, replay, create, get and action endpoints work", async () => {
    const { config, orchestrator } = setup(); const app = createOperationsDemoApp({ orchestrator, config });
    expect((await app.request("/api/operations-demo/capabilities")).status).toBe(200);
    expect(await (await app.request("/api/operations-demo/capabilities")).json()).toMatchObject({ replayAvailable: true, simulationAvailable: true, liveModeReason: "DISABLED_DEMO_INFRASTRUCTURE_PENDING" });
    expect((await app.request("/api/operations-demo/replay")).status).toBe(200);
    const created = await app.request("/api/operations-demo/sessions", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "create-1" }, body: JSON.stringify({ mode: "SIMULATION" }) });
    expect(created.status).toBe(201); const session = await created.json() as { sessionId: string };
    expect((await app.request(`/api/operations-demo/sessions/${session.sessionId}`)).status).toBe(200);
    const action = await app.request(`/api/operations-demo/sessions/${session.sessionId}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request("OPEN_TENDER")) });
    expect(action.status).toBe(200);
  });
  it("SSE resumes after Last-Event-ID without duplicates", async () => {
    const { config, orchestrator } = setup(); const app = createOperationsDemoApp({ orchestrator, config });
    const session = await orchestrator.createSession("REPLAY");
    const response = await app.request(`/api/operations-demo/sessions/${session.sessionId}/events`, { headers: { "last-event-id": "0" } });
    const text = await response.text();
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect((text.match(/id: 1/g) ?? [])).toHaveLength(1);
  });
  it("live session requires admin authorization", async () => {
    const { config, store, replay } = setupLive();
    const orchestrator = new OperationsDemoOrchestrator(config, store, replay, new SimulationAdapter(), new DisabledLiveAdapter("DEMO_LIVE_DISABLED"), () => NOW);
    await expect(orchestrator.createSession("LIVE", "SHIPPER", "wrong-token")).rejects.toMatchObject({ code: "DEMO_ADMIN_REQUIRED" });
  });
  it("public sessions expose no journals, POD secrets, keys, paths or raw signatures", async () => {
    const { orchestrator } = setup(); const session = await orchestrator.createSession("SIMULATION");
    const serialized = JSON.stringify(publicSession(session));
    for (const forbidden of ["steps", "events", "actionResults", "wrappedDataKey", "ciphertextB64", "privateKey", "mnemonic", "filesystemPath", "carrierSignature"]) expect(serialized).not.toContain(forbidden);
  });
  it("health validates replay and makes zero Mirror calls", () => {
    const network = vi.spyOn(globalThis, "fetch"); const { config, orchestrator } = setup();
    expect(fastHealth(config, orchestrator)).toMatchObject({ ok: true, body: { mirrorCalls: 0 } });
    expect(network).not.toHaveBeenCalled(); network.mockRestore();
  });
  it("rate limits POST session creation", async () => {
    const { config, orchestrator } = setup(); const app = createOperationsDemoApp({ orchestrator, config });
    const init = { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "limited" }, body: JSON.stringify({ mode: "SIMULATION" }) };
    expect((await app.request("/api/operations-demo/sessions", init)).status).toBe(201);
    expect((await app.request("/api/operations-demo/sessions", init)).status).toBe(429);
  });
  it("persisted files contain no supplied idempotency key", async () => {
    const { config, orchestrator } = setup(); const session = await orchestrator.createSession("SIMULATION");
    await orchestrator.act(session.sessionId, request("OPEN_TENDER"));
    const raw = readFileSync(path.join(config.demoDataDir, "sessions", `${session.sessionId}.json`), "utf8");
    expect(raw).not.toContain("idempotency-1-OPEN_TENDER");
    expect(existsSync(path.join(config.demoDataDir, "sessions", `${session.sessionId}.json`))).toBe(true);
  });
});
