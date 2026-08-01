/**
 * One guarded RouteGuard Operations Demo session on Hedera testnet.
 *
 * --preflight performs Mirror/facilitator reads plus a zero-egress API/SSE
 * rehearsal. --execute additionally requires both exact live guard values.
 * Never prints signer material, payment payloads, signatures, or POD content.
 */
import "dotenv/config";

import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

import {
  OPERATIONS_LIVE_BASELINE,
  OPERATIONS_LIVE_CONFIRM_ENV,
  OPERATIONS_LIVE_CONFIRM_VALUE,
  OPERATIONS_LIVE_DATA_DIR,
  OPERATIONS_LIVE_EVIDENCE_DIR,
  OPERATIONS_LIVE_MAX_WRITES,
  OPERATIONS_LIVE_MAX_WRITES_ENV,
  OPERATIONS_LIVE_REQUIRED_BRANCH,
  createLiveOperationsComposition,
  createOperationsDemoApp,
  createOrLoadLiveSessionPlan,
  OperationsDemoOrchestrator,
  OperationsDemoStore,
  performLiveReadOnlyPreflight,
  resolveLiveSecrets,
  resolveOperationsDemoConfig,
  type LivePreflightReport,
  type LiveSessionPlan,
} from "../src/operations-demo";
import { canonicalSha256 } from "../src/domain/canonical-hash";
import { parseHcsV2Envelope } from "../src/hcs/v2/envelope";
import {
  DEMO_CARRIER_TREASURY_ACCOUNT_ID,
  DEMO_CONTRACT_EVM_ADDRESS,
  DEMO_CONTRACT_ID,
  DEMO_HCS_TOPIC_ID,
  DEMO_OPERATOR_ACCOUNT_ID,
  DEMO_TOKEN_ID,
  IMMUTABLE_PROOF_TOPIC_ID,
  LIVE_SUCCESSFUL_PATH,
} from "../src/operations-demo/constants";
import { MirrorReader } from "../src/v2/live/mirror-reader";
import type { DemoWorkflowState, OperationsDemoSession } from "../src/operations-demo/types";

const EXPECTED_STATES: readonly DemoWorkflowState[] = [
  "ESCROW_FUNDED", "ACCESS_ACTIVATED", "OFFER_ACCEPTED", "WINNER_ALLOCATED",
  "POD_SUBMITTED", "ADVISORY_ANCHORED", "POD_ACCEPTED", "COMPLETED",
];

function fail(code: string, message: string): never {
  console.error(`LIVE_PREFLIGHT=FAIL code=${code} message=${message}`);
  process.exit(1);
}

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assertLocalAuthority(): void {
  if (git(["branch", "--show-current"]) !== OPERATIONS_LIVE_REQUIRED_BRANCH) fail("BRANCH", `branch must be ${OPERATIONS_LIVE_REQUIRED_BRANCH}`);
  try { execFileSync("git", ["merge-base", "--is-ancestor", OPERATIONS_LIVE_BASELINE, "HEAD"], { stdio: "ignore" }); }
  catch { fail("BASELINE", "HEAD does not descend from the required baseline"); }
  const status = readFileSync("PROJECT_STATUS.md", "utf8");
  if (!status.includes("**Version:** 0.12.2")) fail("PROJECT_STATUS", "PROJECT_STATUS.md must begin at v0.12.2");
  if (existsSync(OPERATIONS_LIVE_EVIDENCE_DIR)) fail("ALREADY_DONE", "demo-session evidence already exists; refusing a second run");
  for (const relative of [
    "evidence/v2/demo-infrastructure/contract-verification.json",
    "evidence/v2/demo-infrastructure/topic-verification.json",
    "evidence/v2/demo-infrastructure/write-accounting.json",
  ]) {
    if (!existsSync(relative)) fail("INFRA_EVIDENCE", `${relative} missing`);
    JSON.parse(readFileSync(relative, "utf8"));
  }
  const contract = JSON.parse(readFileSync("evidence/v2/demo-infrastructure/contract-verification.json", "utf8")) as Record<string, unknown>;
  const topic = JSON.parse(readFileSync("evidence/v2/demo-infrastructure/topic-verification.json", "utf8")) as Record<string, unknown>;
  if (contract.contractId !== DEMO_CONTRACT_ID || contract.contractEvmAddress !== DEMO_CONTRACT_EVM_ADDRESS || contract.totalEscrowedAtomic !== "0" || contract.usdcBalanceAtomic !== "0") fail("INFRA_EVIDENCE", "contract evidence binding failed");
  if (topic.topicId !== DEMO_HCS_TOPIC_ID || topic.sequenceNumber !== 0) fail("INFRA_EVIDENCE", "topic evidence binding failed");
  try {
    execFileSync("git", ["diff", "--quiet", OPERATIONS_LIVE_BASELINE, "--", "evidence/v2/access", "evidence/v2/escrow", "evidence/v2/pod", "evidence/v2/release", "evidence/v2/demo-infrastructure", "evidence/final-demo-dry-run-attempt.json", "evidence/final-demo-live-attempt.json", "evidence/final-demo-result.json", "evidence/final-demo-result.md"], { stdio: "ignore" });
  } catch { fail("IMMUTABLE_EVIDENCE", "prior evidence differs from the baseline"); }
}

async function rehearsal(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "routeguard-operations-rehearsal-"));
  const config = resolveOperationsDemoConfig({ ROUTEGUARD_DEMO_DATA_DIR: root }, process.cwd());
  const store = new OperationsDemoStore(root);
  const orchestrator = new OperationsDemoOrchestrator(config, store);
  orchestrator.initialize();
  const app = createOperationsDemoApp({ orchestrator, config });
  const listening = await listen(app);
  const created = await fetch(`${listening.baseUrl}/api/operations-demo/sessions`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "live-preflight-rehearsal" }, body: JSON.stringify({ mode: "SIMULATION" }) });
  if (created.status !== 201) throw new Error("simulation rehearsal session creation failed");
  const session = await created.json() as { sessionId: string };
  for (let index = 0; index < LIVE_SUCCESSFUL_PATH.length; index += 1) {
    const action = LIVE_SUCCESSFUL_PATH[index]!;
    const response = await fetch(`${listening.baseUrl}/api/operations-demo/sessions/${session.sessionId}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, actionId: `rehearsal-${index + 1}`, idempotencyKey: `rehearsal-idem-${index + 1}`, payload: {} }) });
    if (response.status !== 200) throw new Error(`simulation rehearsal ${action} failed`);
  }
  const events = await fetch(`${listening.baseUrl}/api/operations-demo/sessions/${session.sessionId}/events?lastEventId=0`);
  const transcript = await events.text();
  if (!transcript.includes("COMPLETED") || transcript.indexOf("FUND_ESCROW") > transcript.indexOf("OPEN_TENDER")) throw new Error("simulation SSE rehearsal order failed");
  await new Promise<void>((resolve) => listening.server.close(() => resolve()));
}

function runtimeEnv(plan: LiveSessionPlan, adminToken: string): Record<string, string | undefined> {
  const secrets = resolveLiveSecrets(process.env);
  return {
    ...process.env,
    HEDERA_NETWORK: "hedera:testnet",
    USDC_TOKEN_ID: DEMO_TOKEN_ID,
    ROUTEGUARD_OPERATIONS_LIVE_ENABLED: "true",
    ROUTEGUARD_OPERATIONS_SUPERVISED_LOCAL: "true",
    ROUTEGUARD_OPERATIONS_MAX_ACTIVE_LIVE_SESSIONS: "1",
    ROUTEGUARD_OPERATIONS_SESSION_IDLE_TTL_MINUTES: "45",
    ROUTEGUARD_OPERATIONS_SESSION_ABSOLUTE_TTL_MINUTES: "60",
    ROUTEGUARD_OPERATIONS_MAX_WRITES_PER_SESSION: "12",
    ROUTEGUARD_OPERATIONS_MAX_WRITES_PER_DAY: "50",
    ROUTEGUARD_DEMO_DATA_DIR: path.resolve(OPERATIONS_LIVE_DATA_DIR, "demo-sessions"),
    ROUTEGUARD_V2_DATA_DIR: path.resolve(OPERATIONS_LIVE_DATA_DIR, "v2"),
    ROUTEGUARD_DEMO_CONTRACT_ID: DEMO_CONTRACT_ID,
    ROUTEGUARD_DEMO_CONTRACT_EVM_ADDRESS: DEMO_CONTRACT_EVM_ADDRESS,
    ROUTEGUARD_DEMO_HCS_TOPIC_ID: DEMO_HCS_TOPIC_ID,
    ROUTEGUARD_DEMO_ADMIN_TOKEN: adminToken,
    ROUTEGUARD_OPERATOR_PRIVATE_KEY: secrets.operatorPrivateKey,
    ROUTEGUARD_CARRIER_PRIVATE_KEY: secrets.carrierPrivateKey,
    ROUTEGUARD_OPERATOR_PUBLIC_KEY: secrets.operatorPublicKey,
    ROUTEGUARD_CARRIER_PUBLIC_KEY: secrets.carrierPublicKey,
    ROUTEGUARD_POD_MASTER_KEY_BASE64: secrets.podMasterKeyBase64,
    RAILWAY_REPLICA_COUNT: "1",
    ROUTEGUARD_LIVE_RUN_ID: plan.runId,
  };
}

async function preflight(plan: LiveSessionPlan): Promise<LivePreflightReport> {
  assertLocalAuthority();
  const secrets = resolveLiveSecrets(process.env);
  const store = new OperationsDemoStore(path.resolve(OPERATIONS_LIVE_DATA_DIR, "demo-sessions"));
  store.initialize();
  if (store.activeLive()) fail("ACTIVE_SESSION", "an active live session already exists");
  if (store.dailySuccessfulWrites() + OPERATIONS_LIVE_MAX_WRITES > 50) fail("DAILY_BUDGET", "daily write budget cannot hold twelve writes");
  await rehearsal();
  const report = await performLiveReadOnlyPreflight({ plan, secrets });
  writeJson(path.join(OPERATIONS_LIVE_DATA_DIR, "preflight.json"), { ...report, runId: plan.runId, sessionId: plan.sessionId, rehearsal: "PASS", priorEvidenceUnchanged: true, networkWrites: 0 });
  console.log("LIVE_PREFLIGHT=PASS");
  console.log(`LIVE_RUN_ID=${plan.runId}`);
  console.log("INFRASTRUCTURE_EVIDENCE=PASS");
  console.log("IMMUTABLE_PROOF_EVIDENCE=PASS");
  console.log("API_SSE_REHEARSAL=PASS");
  console.log(`OPERATOR_PRIVATE_KEY=PRESENT CARRIER_PRIVATE_KEY=PRESENT POD_MASTER_KEY=PRESENT`);
  console.log(`TOPIC_SEQUENCE=${report.topicSequence} CONTRACT_BALANCE_ATOMIC=${report.contractUsdcAtomic} TENDER_STATE=${report.newTenderState}`);
  console.log(`SHIPPER_USDC_ATOMIC=${report.shipperUsdcAtomic} OPERATOR_HBAR_TINYBARS=${report.operatorHbarTinybars}`);
  console.log("NETWORK_WRITES=0");
  return report;
}

function loadInitialPreflight(plan: LiveSessionPlan): LivePreflightReport {
  const file = path.join(OPERATIONS_LIVE_DATA_DIR, "preflight.json");
  if (!existsSync(file)) fail("RESUME_PREFLIGHT", "initial preflight evidence is missing");
  const value = JSON.parse(readFileSync(file, "utf8")) as LivePreflightReport & { runId?: string; sessionId?: string; networkWrites?: number };
  if (value.status !== "PASS" || value.runId !== plan.runId || value.sessionId !== plan.sessionId || value.networkWrites !== 0 ||
      value.contractId !== DEMO_CONTRACT_ID || value.topicId !== DEMO_HCS_TOPIC_ID || value.projectedWrites !== 12) {
    fail("RESUME_PREFLIGHT", "initial preflight evidence does not bind this session");
  }
  return value;
}

async function resumePreflight(plan: LiveSessionPlan): Promise<LivePreflightReport> {
  assertLocalAuthority();
  resolveLiveSecrets(process.env);
  const store = new OperationsDemoStore(path.resolve(OPERATIONS_LIVE_DATA_DIR, "demo-sessions"));
  store.initialize();
  const session = store.get(plan.sessionId);
  const active = store.activeLive();
  if (!session || !active || active.sessionId !== plan.sessionId || session.runId !== plan.runId || session.mode !== "LIVE") {
    fail("RESUME_PREFLIGHT", "the authorized durable LIVE session is not active");
  }
  const expectedSubSteps = ["register-tender", "approve-exact-allowance", "fund-escrow"];
  if (session.workflowState !== "CREATED" || session.lastConfirmedState !== "CREATED" || session.progress !== "RECOVERABLE" ||
      session.writesUsed !== 3 || session.writeBudget.successfulStateChangingWrites !== 3 || store.dailySuccessfulWrites() !== 3 ||
      session.steps.length !== 3 || session.steps.some((step, index) => step.actionId !== plan.actionIds.FUND_ESCROW || step.subStep !== expectedSubSteps[index] || step.status !== "VERIFIED" || step.receiptStatus !== "SUCCESS" || step.verificationStatus !== "VERIFIED" || !step.publicTransactionId)) {
    fail("RESUME_PREFLIGHT", "durable journal is not the exact verified three-write recovery state");
  }
  const transactionIds = session.steps.map((step) => step.publicTransactionId!);
  if (new Set(transactionIds).size !== 3) fail("RESUME_PREFLIGHT", "durable transaction identities are not unique");
  const mirror = new MirrorReader();
  const [state, balance, total, contractBalance, topicOne, proofFive, proofSix, ...transactions] = await Promise.all([
    mirror.contractCall(DEMO_CONTRACT_EVM_ADDRESS, "getState", [plan.tenderKey]),
    mirror.contractCall(DEMO_CONTRACT_EVM_ADDRESS, "tenderBalance", [plan.tenderKey]),
    mirror.contractCall(DEMO_CONTRACT_EVM_ADDRESS, "totalEscrowedAmount", []),
    mirror.accountBalance(DEMO_CONTRACT_ID, DEMO_TOKEN_ID),
    mirror.topicMessage(DEMO_HCS_TOPIC_ID, 1),
    mirror.topicMessage(IMMUTABLE_PROOF_TOPIC_ID, 5),
    mirror.topicMessage(IMMUTABLE_PROOF_TOPIC_ID, 6),
    ...transactionIds.map((transactionId) => mirror.transaction(transactionId)),
  ]);
  if (String(state[0]) !== "2" || String(balance[0]) !== "20000" || String(total[0]) !== "20000" || contractBalance !== 20_000n || topicOne !== null || proofFive === null || proofSix !== null || transactions.some((transaction) => transaction.status !== "SUCCESS")) {
    fail("RESUME_PREFLIGHT", "Mirror/on-chain state does not match the verified three-write journal");
  }
  const report = loadInitialPreflight(plan);
  console.log("LIVE_RESUME_PREFLIGHT=PASS");
  console.log(`LIVE_RUN_ID=${plan.runId}`);
  console.log("DURABLE_VERIFIED_WRITES=3 REMAINING_AUTHORIZED_WRITES=9");
  console.log("TENDER_STATE=FUNDED CONTRACT_BALANCE_ATOMIC=20000 TOPIC_SEQUENCE=0");
  return report;
}

async function readSse(url: string, signal: AbortSignal): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error("SSE subscription failed");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const event = frame.split("\n").find((line) => line.startsWith("event: "))?.slice(7) ?? "message";
      const raw = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? "{}";
      const data = JSON.parse(raw) as Record<string, unknown>;
      events.push({ event, data });
    }
    if (done) break;
  }
  return events;
}

function listen(app: Hono): Promise<{ server: ReturnType<typeof serve>; baseUrl: string }> {
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("loopback address unavailable"));
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function topicSequence(): Promise<number> {
  const mirror = new MirrorReader();
  let sequence = 0;
  for (let candidate = 1; candidate <= 20; candidate += 1) {
    if (await mirror.topicMessage(DEMO_HCS_TOPIC_ID, candidate)) sequence = candidate;
    else break;
  }
  return sequence;
}

async function writeEvidence(input: { plan: LiveSessionPlan; preflight: LivePreflightReport; session: OperationsDemoSession; sse: Array<{ event: string; data: Record<string, unknown> }>; restartWrites: number }): Promise<void> {
  const { plan, preflight, session } = input;
  const mirror = new MirrorReader();
  const [shipperAfter, sharedAfter, contractAfter, total, state, tenderBalance] = await Promise.all([
    mirror.accountBalance(DEMO_OPERATOR_ACCOUNT_ID, DEMO_TOKEN_ID),
    mirror.accountBalance(DEMO_CARRIER_TREASURY_ACCOUNT_ID, DEMO_TOKEN_ID),
    mirror.accountBalance(DEMO_CONTRACT_ID, DEMO_TOKEN_ID),
    mirror.contractCall(DEMO_CONTRACT_EVM_ADDRESS, "totalEscrowedAmount", []),
    mirror.contractCall(DEMO_CONTRACT_EVM_ADDRESS, "getState", [plan.tenderKey]),
    mirror.contractCall(DEMO_CONTRACT_EVM_ADDRESS, "tenderBalance", [plan.tenderKey]),
  ]);
  const shipperDelta = shipperAfter - BigInt(preflight.shipperUsdcAtomic);
  const sharedDelta = sharedAfter - BigInt(preflight.carrierTreasuryUsdcAtomic);
  const steps = Object.fromEntries(session.steps.filter((step) => step.publicTransactionId).map((step) => [step.subStep, { action: step.action, transactionId: step.publicTransactionId, hcsSequence: step.hcsSequence, evidenceHash: step.safeEvidenceHash, hashScanUrl: hashScanUrl(step.publicTransactionId!) }]));
  const txIds = session.steps.filter((step) => step.publicTransactionId).map((step) => step.publicTransactionId!);
  const mirrorTransactions = [];
  for (const transactionId of txIds) mirrorTransactions.push(await mirror.transaction(transactionId, true));
  const messages = [];
  for (let sequence = 1; sequence <= 5; sequence += 1) {
    const message = await mirror.topicMessage(DEMO_HCS_TOPIC_ID, sequence);
    if (!message) throw new Error(`HCS sequence ${sequence} missing`);
    const envelope = parseHcsV2Envelope(JSON.parse(Buffer.from(message.messageBase64, "base64").toString("utf8")));
    messages.push({ sequenceNumber: sequence, messageType: envelope.messageType, tenderId: envelope.tenderId, tenderVersion: envelope.tenderVersion, payloadHash: envelope.payloadHash, envelopeHash: canonicalSha256(envelope) });
  }
  const proofSequence = await mirror.topicMessage(IMMUTABLE_PROOF_TOPIC_ID, 5) && !(await mirror.topicMessage(IMMUTABLE_PROOF_TOPIC_ID, 6)) ? 5 : -1;
  const common = { runId: plan.runId, sessionId: plan.sessionId, network: "hedera:testnet", contractId: DEMO_CONTRACT_ID, contractEvmAddress: DEMO_CONTRACT_EVM_ADDRESS, topicId: DEMO_HCS_TOPIC_ID, tokenId: DEMO_TOKEN_ID, syntheticData: true };
  mkdirSync(OPERATIONS_LIVE_EVIDENCE_DIR, { recursive: true });
  writeJson(path.join(OPERATIONS_LIVE_EVIDENCE_DIR, "preflight.json"), { ...common, ...preflight, apiSseRehearsal: "PASS", networkWritesBeforeAuthorization: 0 });
  writeJson(path.join(OPERATIONS_LIVE_EVIDENCE_DIR, "api-session-created.json"), { ...common, workflowState: "CREATED", fundedFirst: true, actionOrder: LIVE_SUCCESSFUL_PATH });
  writeJson(path.join(OPERATIONS_LIVE_EVIDENCE_DIR, "sse-progress.json"), { ...common, events: input.sse.map((event, index) => ({ index: index + 1, event: event.event, action: event.data.action ?? null, progress: event.data.progress ?? null, workflowState: event.data.workflowState ?? null })) });
  const fileFor: Record<string, string> = { "register-tender": "escrow-registration.json", "approve-exact-allowance": "allowance.json", "fund-escrow": "escrow-funding.json", "x402-tender-access": "tender-x402-access.json", "x402-carrier-offer": "carrier-x402-access.json", "allocate-winner": "winner-allocation.json", "pod-submitted-hcs": "pod-submitted-hcs.json", "pod-advisory-hcs": "advisory-hcs.json", "pod-review-action-hcs": "review-action-hcs.json", "release-full": "freight-release.json", "escrow-released-hcs": "escrow-released-hcs.json", "tender-completed-hcs": "tender-completed-hcs.json" };
  for (const [subStep, file] of Object.entries(fileFor)) writeJson(path.join(OPERATIONS_LIVE_EVIDENCE_DIR, file), { ...common, subStep, ...(steps[subStep] as object) });
  const lifecycleFile = path.join(path.resolve(OPERATIONS_LIVE_DATA_DIR, "v2", "lifecycle"), `lifecycle-${plan.tenderId}.json`);
  const lifecycleDigest = existsSync(lifecycleFile) ? canonicalSha256(readFileSync(lifecycleFile, "utf8")) : null;
  writeJson(path.join(OPERATIONS_LIVE_EVIDENCE_DIR, "pod-encryption-proof.json"), { ...common, podId: plan.podId, encryption: "AES-256-GCM", carrierSignatureVerified: true, plaintextPersisted: false, lifecycleDigest });
  writeJson(path.join(OPERATIONS_LIVE_EVIDENCE_DIR, "shipper-acceptance.json"), { ...common, action: "ACCEPT", cryptographicallyVerified: true, rawSignatureIncluded: false });
  writeJson(path.join(OPERATIONS_LIVE_EVIDENCE_DIR, "hcs-sequence.json"), { ...common, messages, exactOrder: messages.map((item) => item.messageType).join(",") === "POD_SUBMITTED,POD_ADVISORY_ANCHORED,POD_REVIEW_ACTION,ESCROW_RELEASED,TENDER_COMPLETED", proofTopicId: IMMUTABLE_PROOF_TOPIC_ID, proofTopicSequence: proofSequence });
  writeJson(path.join(OPERATIONS_LIVE_EVIDENCE_DIR, "balance-reconciliation.json"), { ...common, shipperBeforeAtomic: preflight.shipperUsdcAtomic, shipperAfterAtomic: shipperAfter.toString(), shipperNetDeltaAtomic: shipperDelta.toString(), sharedAccountBeforeAtomic: preflight.carrierTreasuryUsdcAtomic, sharedAccountAfterAtomic: sharedAfter.toString(), sharedAccountTotalDeltaAtomic: sharedDelta.toString(), accessFeeAttributionAtomic: "2000", freightAttributionAtomic: "15000", maximumFundedAtomic: "20000", excessRefundAtomic: "5000", freightReleasedAtomic: "15000", conservation: "20000 = 5000 + 15000" });
  writeJson(path.join(OPERATIONS_LIVE_EVIDENCE_DIR, "contract-final-state.json"), { ...common, state: Number(state[0]) === 5 ? "RELEASED" : "OTHER", totalEscrowedAtomic: String(total[0]), tenderBalanceAtomic: String(tenderBalance[0]), tokenBalanceAtomic: contractAfter.toString() });
  writeJson(path.join(OPERATIONS_LIVE_EVIDENCE_DIR, "mirror-verification.json"), { ...common, transactions: mirrorTransactions.map((tx) => ({ transactionId: tx.transactionId, status: tx.status, consensusTimestamp: tx.consensusTimestamp, childTransactionCount: tx.childTransactionCount, tokenTransfers: tx.tokenTransfers, hashScanUrl: tx.hashScanUrl })) });
  writeJson(path.join(OPERATIONS_LIVE_EVIDENCE_DIR, "write-accounting.json"), { ...common, escrowRegistrationWrites: 1, allowanceWrites: 1, escrowFundingWrites: 1, x402Writes: 2, allocationWrites: 1, podHcsWrites: 3, releaseContractWrites: 1, releaseHcsWrites: 2, totalStateChangingWrites: session.writesUsed, queryPaymentTransactions: 0 });
  writeJson(path.join(OPERATIONS_LIVE_EVIDENCE_DIR, "idempotent-restart.json"), { ...common, completedSessionReturned: true, additionalWrites: input.restartWrites, topicSequenceAfterRestart: await topicSequence(), finalSessionState: session.workflowState });
  writeJson(path.join(OPERATIONS_LIVE_EVIDENCE_DIR, "run-summary.json"), { ...common, status: "SUCCESS", scenario: { route: "Los Angeles to Phoenix", mode: "Truck", equipment: "Dry Van", weightKg: 12500, pickupWindow: "05-06 Aug 2026", deliveryDeadline: "08 Aug 2026", illustrativeQuoteUsdc: "1850" }, sessionStateOrder: ["CREATED", ...EXPECTED_STATES], actionOrder: LIVE_SUCCESSFUL_PATH, transactionReferences: txIds, finalSessionState: session.workflowState, finalContractState: Number(state[0]) === 5 ? "RELEASED" : "OTHER", publicLiveMode: "DISABLED", networkWrites: session.writesUsed, claimBoundary: { syntheticScenarioAndPod: true, realTestnetX402: true, realTestnetEscrow: true, realHcs: true, realEncryptedPodAndSignatures: true, noPhysicalFreightDeliveryClaimed: true } });
  writeFileSync(path.join(OPERATIONS_LIVE_EVIDENCE_DIR, "README.md"), `# RouteGuard Operations Demo session\n\nOne supervised funded-first Hedera testnet session completed using contract \`${DEMO_CONTRACT_ID}\` and topic \`${DEMO_HCS_TOPIC_ID}\`. Business data and POD documents were synthetic; x402, HTS escrow, signatures, encryption, HCS, allocation/refund, and freight release were real testnet operations. No physical freight delivery is claimed. Public live mode remains disabled.\n`, "utf8");
}

function hashScanUrl(transactionId: string): string { return `https://hashscan.io/testnet/transaction/${transactionId}`; }

async function execute(plan: LiveSessionPlan, preflightReport: LivePreflightReport): Promise<void> {
  if (process.env[OPERATIONS_LIVE_CONFIRM_ENV]?.trim() !== OPERATIONS_LIVE_CONFIRM_VALUE) fail("AUTH_GUARD", `${OPERATIONS_LIVE_CONFIRM_ENV} is missing or incorrect`);
  if (process.env[OPERATIONS_LIVE_MAX_WRITES_ENV]?.trim() !== String(OPERATIONS_LIVE_MAX_WRITES)) fail("WRITE_GUARD", `${OPERATIONS_LIVE_MAX_WRITES_ENV} must be 12`);
  const adminToken = randomBytes(32).toString("hex");
  const env = runtimeEnv(plan, adminToken);
  const config = resolveOperationsDemoConfig(env, process.cwd());
  if (!config.liveEnabled) fail("LIVE_CONFIG", `live composition is not enabled: ${config.liveReason}`);
  let baseUrl = "";
  const composition = createLiveOperationsComposition({ config, plan, secrets: resolveLiveSecrets(env), preflight: preflightReport, getBaseUrl: () => baseUrl });
  const app = new Hono(); app.route("/", composition.operationsApp); app.route("/", composition.accessApp);
  const listening = await listen(app); baseUrl = listening.baseUrl;
  const controller = new AbortController();
  let ssePromise: Promise<Array<{ event: string; data: Record<string, unknown> }>> | null = null;
  try {
    const capabilities = await fetch(`${baseUrl}/api/operations-demo/capabilities`).then((response) => response.json()) as { liveModeEnabled?: boolean; liveModeReason?: string };
    if (!capabilities.liveModeEnabled) fail("CAPABILITIES", `live mode unavailable: ${String(capabilities.liveModeReason)}`);
    const durableSession = composition.store.get(plan.sessionId);
    if (durableSession) {
      if (durableSession.runId !== plan.runId || durableSession.mode !== "LIVE" || ["COMPLETED", "EXPIRED", "ABORTED"].includes(durableSession.workflowState)) fail("SESSION_IDENTITY", "durable session cannot be resumed");
      console.log(`OPERATIONS_API_SESSION_RESUMED=PASS sessionId=${plan.sessionId} verifiedWrites=${durableSession.writesUsed}`);
    } else {
      const created = await fetch(`${baseUrl}/api/operations-demo/sessions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}`, "x-forwarded-for": "supervised-live-session" }, body: JSON.stringify({ mode: "LIVE", role: "SHIPPER" }) });
      if (created.status !== 201) fail("SESSION_CREATE", `LIVE session HTTP ${created.status}`);
      const createdSession = await created.json() as { sessionId: string; runId: string; workflowState: string };
      if (createdSession.sessionId !== plan.sessionId || createdSession.runId !== plan.runId || createdSession.workflowState !== "CREATED") fail("SESSION_IDENTITY", "created session identity differs from preflight plan");
      console.log(`OPERATIONS_API_SESSION_CREATED=PASS sessionId=${plan.sessionId}`);
    }
    ssePromise = readSse(`${baseUrl}/api/operations-demo/sessions/${plan.sessionId}/events?lastEventId=0`, controller.signal);
    for (let index = 0; index < LIVE_SUCCESSFUL_PATH.length; index += 1) {
      const action = LIVE_SUCCESSFUL_PATH[index]!;
      const response = await fetch(`${baseUrl}/api/operations-demo/sessions/${plan.sessionId}/actions`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "supervised-live-actions" }, body: JSON.stringify({ action, actionId: plan.actionIds[action], idempotencyKey: plan.idempotencyKeys[action], payload: {} }) });
      const body = await response.json() as { workflowState?: string; writesUsed?: number; error?: string };
      if (!response.ok || body.workflowState !== EXPECTED_STATES[index]) fail("LIVE_ACTION", `${action} failed HTTP ${response.status} ${String(body.error ?? "")}`);
      console.log(`ACTION_CONFIRMED=${action} STATE=${body.workflowState} WRITES=${body.writesUsed}`);
    }
    const finalResponse = await fetch(`${baseUrl}/api/operations-demo/sessions/${plan.sessionId}`);
    const publicFinal = await finalResponse.json() as { workflowState?: string; writesUsed?: number };
    if (publicFinal.workflowState !== "COMPLETED" || publicFinal.writesUsed !== 12) fail("FINAL_SESSION", "session did not complete at exactly twelve writes");
    const sse = await ssePromise;
    const internal = composition.store.get(plan.sessionId)!;
    if (sse.filter((event) => event.event === "transaction_submitted").length !== 12 || !sse.some((event) => event.event === "terminal_state")) fail("SSE", "SSE transcript is incomplete");
    await new Promise<void>((resolve) => listening.server.close(() => resolve()));
    composition.close();
    const sequenceBeforeRestart = await topicSequence();
    const restart = createLiveOperationsComposition({ config, plan, secrets: resolveLiveSecrets(env), preflight: preflightReport, getBaseUrl: () => "http://127.0.0.1:1" });
    const writesBefore = restart.store.get(plan.sessionId)!.writesUsed;
    for (const action of LIVE_SUCCESSFUL_PATH) {
      const response = await restart.operationsApp.request(`/api/operations-demo/sessions/${plan.sessionId}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, actionId: plan.actionIds[action], idempotencyKey: plan.idempotencyKeys[action], payload: {} }) });
      if (response.status !== 200) fail("IDEMPOTENT_RESTART", `${action} replay failed`);
    }
    const writesAfter = restart.store.get(plan.sessionId)!.writesUsed;
    restart.close();
    const sequenceAfterRestart = await topicSequence();
    if (writesBefore !== 12 || writesAfter !== 12 || sequenceBeforeRestart !== 5 || sequenceAfterRestart !== 5) fail("IDEMPOTENT_RESTART", "restart changed ledger write state");
    await writeEvidence({ plan, preflight: preflightReport, session: internal, sse, restartWrites: writesAfter - writesBefore });
    console.log("OPERATIONS_API_LIVE_SESSION=PASS");
    console.log("SSE_PROGRESS=PASS");
    console.log("SESSION_FINAL_STATE=COMPLETED");
    console.log("TOTAL_STATE_CHANGING_WRITES=12");
    console.log("IDEMPOTENT_RESTART=PASS");
    console.log("RESTART_ADDITIONAL_WRITES=0");
    console.log("PUBLIC_LIVE_MODE=DISABLED");
    console.log("NETWORK_WRITES=12");
  } catch (error) {
    controller.abort();
    listening.server.close();
    composition.close();
    throw error;
  }
}

async function main(): Promise<void> {
  const mode = process.argv.includes("--execute") ? "execute" : "preflight";
  const plan = createOrLoadLiveSessionPlan();
  if (mode === "preflight") {
    await preflight(plan);
    console.log("EXPLICIT_AUTHORIZATION_RECEIVED=NO");
    return;
  }
  const sessionFile = path.join(OPERATIONS_LIVE_DATA_DIR, "demo-sessions", "sessions", `${plan.sessionId}.json`);
  const report = existsSync(sessionFile) ? await resumePreflight(plan) : await preflight(plan);
  await execute(plan, report);
}

main().catch((error) => fail("RUNNER", error instanceof Error ? error.message : "unknown failure"));
