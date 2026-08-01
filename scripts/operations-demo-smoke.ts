/** In-process, zero-egress smoke test for the production Operations Demo app. */
import app from "../src/server/app";

function fail(message: string): never { throw new Error(message); }

const health = await app.request("/health");
if (health.status !== 200) fail(`/health returned ${health.status}`);
const healthBody = await health.json() as { mirrorCalls?: number };
if (healthBody.mirrorCalls !== 0) fail("health must make zero Mirror calls");

const replay = await app.request("/api/operations-demo/replay");
if (replay.status !== 200) fail(`replay returned ${replay.status}`);
const replayBody = await replay.json() as { networkWrites?: number; finalState?: string };
if (replayBody.networkWrites !== 0 || replayBody.finalState !== "RELEASED") fail("replay validation failed");

const capabilities = await app.request("/api/operations-demo/capabilities");
if (capabilities.status !== 200) fail(`capabilities returned ${capabilities.status}`);
const capabilitiesBody = await capabilities.json() as {
  contractConfigured?: boolean;
  topicConfigured?: boolean;
  liveModeEnabled?: boolean;
  liveModeReason?: string;
};
if (
  capabilitiesBody.contractConfigured !== true ||
  capabilitiesBody.topicConfigured !== true ||
  capabilitiesBody.liveModeEnabled !== false ||
  capabilitiesBody.liveModeReason !== "DEMO_LIVE_DISABLED"
) fail("capabilities must report configured infrastructure with live mode disabled");

const created = await app.request("/api/operations-demo/sessions", {
  method: "POST",
  headers: { "content-type": "application/json", "x-forwarded-for": "operations-smoke" },
  body: JSON.stringify({ mode: "SIMULATION", role: "SHIPPER" }),
});
if (created.status !== 201) fail(`simulation create returned ${created.status}`);
const session = await created.json() as { sessionId?: string };
if (!session.sessionId) fail("simulation create omitted sessionId");

const action = await app.request(`/api/operations-demo/sessions/${session.sessionId}/actions`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-forwarded-for": "operations-smoke" },
  body: JSON.stringify({ action: "OPEN_TENDER", actionId: "smoke-open-tender", idempotencyKey: "smoke-open-tender-idempotency", payload: {} }),
});
if (action.status !== 200) fail(`simulation action returned ${action.status}`);
const actionBody = await action.json() as { workflowState?: string };
if (actionBody.workflowState !== "ACCESS_ACTIVATED") fail("simulation action state mismatch");

console.log("HEALTH_SMOKE=PASS");
console.log("REPLAY_SMOKE=PASS");
console.log("CAPABILITIES_SMOKE=PASS");
console.log("SIMULATION_SMOKE=PASS");
console.log("NETWORK_WRITES=0");
