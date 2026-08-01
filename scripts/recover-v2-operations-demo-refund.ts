/**
 * One-write recovery for the stranded supervised Operations Demo tender.
 *
 * --preflight is strictly read-only on Hedera and writes only sanitized local
 * evidence. --execute additionally requires the separate exact process guards.
 */
import "dotenv/config";

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";

import { canonicalSha256 } from "../src/domain/canonical-hash";
import { HEDERA_TESTNET_MIRROR_NODE } from "../src/x402/usdc-constants";
import {
  DEMO_CONTRACT_EVM_ADDRESS,
  DEMO_CONTRACT_ID,
  DEMO_HCS_TOPIC_ID,
  DEMO_MAX_BUDGET_ATOMIC,
  DEMO_OPERATOR_ACCOUNT_ID,
  DEMO_TOKEN_ID,
  IMMUTABLE_PROOF_TOPIC_ID,
} from "../src/operations-demo/constants";
import {
  OPERATIONS_LIVE_BASELINE,
  OPERATIONS_LIVE_DATA_DIR,
  OPERATIONS_LIVE_REQUIRED_BRANCH,
  createOrLoadLiveSessionPlan,
  resolveLiveSecrets,
  type LiveSessionPlan,
} from "../src/operations-demo/live-preflight";
import { OperationsDemoStore } from "../src/operations-demo/store";
import { escrowTenderKey, sha256HashToBytes32, tenderIdHash } from "../src/v2/escrow/tender-key";
import { buildNoQualifiedBidRefundPlan } from "../src/v2/escrow/requests";
import { createTestnetClient } from "../src/v2/live/client";
import { ContractExecutor } from "../src/v2/live/contract-executor";
import { MirrorReader } from "../src/v2/live/mirror-reader";
import { FileLifecycleStore } from "../src/v2/store/lifecycle-store";
import { FilePaymentClaimStore } from "../src/v2/store/payment-claim-store";

const RECOVERY_CONFIRM_ENV = "ROUTEGUARD_LIVE_V2_DEMO_REFUND_CONFIRM";
const RECOVERY_CONFIRM_VALUE = "I_UNDERSTAND_SINGLE_TESTNET_REFUND_WRITE";
const RECOVERY_MAX_WRITES_ENV = "ROUTEGUARD_LIVE_V2_DEMO_REFUND_MAX_WRITES";
const RECOVERY_MAX_WRITES = 1;
const RECOVERY_EVIDENCE_DIR = path.join("evidence", "v2", "demo-session-recovery");
const RECOVERY_PLAN_FILE = path.join(OPERATIONS_LIVE_DATA_DIR, "refund-recovery-plan.json");
const RECOVERY_JOURNAL_FILE = path.join(OPERATIONS_LIVE_DATA_DIR, "refund-recovery-journal.json");

type RecoveryPlan = {
  readonly schemaVersion: "routeguard-operations-refund-plan-1.0";
  readonly runId: string;
  readonly sessionId: string;
  readonly tenderId: string;
  readonly tenderVersion: 1;
  readonly tenderKey: string;
  readonly authorizationHash: string;
};

type RecoveryPreflight = {
  readonly schemaVersion: "routeguard-operations-refund-preflight-1.0";
  readonly status: "PASS";
  readonly checkedAt: string;
  readonly network: "hedera:testnet";
  readonly runId: string;
  readonly sessionId: string;
  readonly tenderId: string;
  readonly tenderVersion: 1;
  readonly tenderKey: string;
  readonly contractId: typeof DEMO_CONTRACT_ID;
  readonly contractEvmAddress: typeof DEMO_CONTRACT_EVM_ADDRESS;
  readonly tokenId: typeof DEMO_TOKEN_ID;
  readonly contractState: "FUNDED";
  readonly tenderBalanceAtomic: "20000";
  readonly totalEscrowedAtomic: "20000";
  readonly contractTokenBalanceAtomic: "20000";
  readonly refundRecipientAccountId: typeof DEMO_OPERATOR_ACCOUNT_ID;
  readonly refundRecipientEvmAddress: string;
  readonly refundAmountAtomic: "20000";
  readonly authorizationHash: string;
  readonly authorizationHashUsed: false;
  readonly registeredManifestHash: string;
  readonly localManifestHash: string;
  readonly registeredManifestPreserved: true;
  readonly carrierOfferPaymentOccurred: false;
  readonly winnerAllocationOccurred: false;
  readonly demoTopicSequence: 0;
  readonly proofTopicSequence: 5;
  readonly successfulSessionWritesBeforeRecovery: 4;
  readonly additionalApplicationWrites: 1;
  readonly projectedSuccessfulWritesAfterRecovery: 5;
  readonly networkWritesDuringPreflight: 0;
};

function fail(code: string, message: string): never {
  console.error(`RECOVERY_PREFLIGHT=FAIL code=${code} message=${message}`);
  process.exit(1);
}

function atomicJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx");
  try { writeSync(fd, `${JSON.stringify(value, null, 2)}\n`, null, "utf8"); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temp, file);
}

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function authorizationHash(plan: LiveSessionPlan): string {
  return `0x${createHash("sha256").update(`routeguard-operations-refund:${plan.runId}:${plan.tenderKey}`, "utf8").digest("hex")}`;
}

function createOrLoadRecoveryPlan(plan: LiveSessionPlan): RecoveryPlan {
  const expected: RecoveryPlan = {
    schemaVersion: "routeguard-operations-refund-plan-1.0",
    runId: plan.runId,
    sessionId: plan.sessionId,
    tenderId: plan.tenderId,
    tenderVersion: 1,
    tenderKey: escrowTenderKey(plan.tenderId, 1),
    authorizationHash: authorizationHash(plan),
  };
  if (!existsSync(RECOVERY_PLAN_FILE)) { atomicJson(RECOVERY_PLAN_FILE, expected); return expected; }
  const existing = JSON.parse(readFileSync(RECOVERY_PLAN_FILE, "utf8")) as RecoveryPlan;
  if (canonicalSha256(existing) !== canonicalSha256(expected)) fail("RECOVERY_PLAN", "persisted recovery plan differs from the stranded tender");
  return existing;
}

function assertLocalAuthority(): void {
  if (git(["branch", "--show-current"]) !== OPERATIONS_LIVE_REQUIRED_BRANCH) fail("BRANCH", `branch must be ${OPERATIONS_LIVE_REQUIRED_BRANCH}`);
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", OPERATIONS_LIVE_BASELINE, "HEAD"], { stdio: "ignore" });
  } catch { fail("BASELINE", "HEAD does not descend from the required baseline"); }
  if (existsSync(path.join("evidence", "v2", "demo-session"))) fail("SECOND_SESSION", "completed session evidence exists; recovery target is ambiguous");
}

function normalized(value: unknown): string { return String(value ?? "").toLowerCase(); }
function tuple(value: readonly unknown[]): readonly unknown[] {
  const first = value[0];
  if (!first || typeof first !== "object" || !(Symbol.iterator in first)) fail("CONTRACT_TENDER", "getTender result is invalid");
  return first as readonly unknown[];
}

async function mirrorAccount(): Promise<{ account?: string; evm_address?: string; key?: { _type?: string; key?: string } }> {
  const response = await fetch(`${HEDERA_TESTNET_MIRROR_NODE}/api/v1/accounts/${DEMO_OPERATOR_ACCOUNT_ID}`, { headers: { accept: "application/json" } });
  if (!response.ok) fail("MIRROR_ACCOUNT", `Mirror account HTTP ${response.status}`);
  return await response.json() as { account?: string; evm_address?: string; key?: { _type?: string; key?: string } };
}

async function preflight(): Promise<{ report: RecoveryPreflight; plan: RecoveryPlan }> {
  assertLocalAuthority();
  const livePlan = createOrLoadLiveSessionPlan();
  const plan = createOrLoadRecoveryPlan(livePlan);
  if (plan.tenderKey !== livePlan.tenderKey) fail("TENDER_KEY", "recovery key differs from the stable live plan");
  const secrets = resolveLiveSecrets(process.env);
  const demoStore = new OperationsDemoStore(path.resolve(OPERATIONS_LIVE_DATA_DIR, "demo-sessions"));
  demoStore.initialize();
  const session = demoStore.get(plan.sessionId);
  if (!session || session.runId !== plan.runId || session.mode !== "LIVE" || session.lastConfirmedState !== "ACCESS_ACTIVATED" || session.writesUsed !== 4) fail("SESSION", "durable session is not the exact stranded four-write session");
  const successful = session.steps.filter((step) => step.receiptStatus === "SUCCESS");
  const offerStep = session.steps.find((step) => step.action === "SUBMIT_OFFER");
  if (successful.length !== 4 || successful.some((step) => step.status !== "VERIFIED" || step.verificationStatus !== "VERIFIED") || !offerStep || offerStep.publicTransactionId !== null || offerStep.receiptStatus !== null || session.actionResults[livePlan.actionIds.SUBMIT_OFFER]) fail("SESSION_JOURNAL", "offer or write journal differs from the stranded state");

  const lifecycle = await new FileLifecycleStore(path.resolve(OPERATIONS_LIVE_DATA_DIR, "v2", "lifecycle")).get(plan.tenderId);
  if (!lifecycle || lifecycle.state !== "TENDER_OPENED" || lifecycle.bidRegistry.length !== 0 || lifecycle.winningBidId !== null || lifecycle.allocateTxId !== null || lifecycle.accessPayments.length !== 1 || lifecycle.accessPayments[0]?.accessActionType !== "TENDER_ACTIVATE") fail("LIFECYCLE", "authoritative lifecycle contains an offer or allocation");
  const offerClaim = await new FilePaymentClaimStore(path.resolve(OPERATIONS_LIVE_DATA_DIR, "v2", "payment-claims")).getByActionId(livePlan.actionIds.SUBMIT_OFFER);
  if (offerClaim !== null) fail("OFFER_PAYMENT", "carrier-offer payment claim exists");

  const tenderFile = path.resolve(OPERATIONS_LIVE_DATA_DIR, "v2", "tenders", `tender-${plan.tenderId}-v1.json`);
  const localTender = JSON.parse(readFileSync(tenderFile, "utf8")) as unknown;
  const localManifestHash = sha256HashToBytes32(canonicalSha256(localTender));
  if (lifecycle.tenderHash !== canonicalSha256(localTender)) fail("MANIFEST", "authoritative lifecycle tender hash differs from the registered local tender");

  const mirror = new MirrorReader();
  const [state, tenderBalance, total, contractTokenBalance, tenderRaw, computedKey, authUsed, topicOne, proofFive, proofSix, account] = await Promise.all([
    mirror.contractCall(DEMO_CONTRACT_EVM_ADDRESS, "getState", [plan.tenderKey]),
    mirror.contractCall(DEMO_CONTRACT_EVM_ADDRESS, "tenderBalance", [plan.tenderKey]),
    mirror.contractCall(DEMO_CONTRACT_EVM_ADDRESS, "totalEscrowedAmount", []),
    mirror.accountBalance(DEMO_CONTRACT_ID, DEMO_TOKEN_ID),
    mirror.contractCall(DEMO_CONTRACT_EVM_ADDRESS, "getTender", [plan.tenderKey]),
    mirror.contractCall(DEMO_CONTRACT_EVM_ADDRESS, "computeTenderKey", [tenderIdHash(plan.tenderId), 1]),
    mirror.contractCall(DEMO_CONTRACT_EVM_ADDRESS, "authorizationHashUsed", [plan.authorizationHash]),
    mirror.topicMessage(DEMO_HCS_TOPIC_ID, 1),
    mirror.topicMessage(IMMUTABLE_PROOF_TOPIC_ID, 5),
    mirror.topicMessage(IMMUTABLE_PROOF_TOPIC_ID, 6),
    mirrorAccount(),
  ]);
  const tender = tuple(tenderRaw);
  const shipper = normalized(tender[2]);
  const zeroAddress = "0x0000000000000000000000000000000000000000";
  if (String(state[0]) !== "2" || String(tender[0]) !== "2" || String(tender[1]) !== "1") fail("CONTRACT_STATE", "contract tender is not FUNDED version 1");
  if (String(tenderBalance[0]) !== DEMO_MAX_BUDGET_ATOMIC || String(total[0]) !== DEMO_MAX_BUDGET_ATOMIC || contractTokenBalance !== 20_000n || String(tender[4]) !== DEMO_MAX_BUDGET_ATOMIC || String(tender[5]) !== DEMO_MAX_BUDGET_ATOMIC) fail("CONTRACT_BALANCE", "contract does not hold exactly 20000 atomic USDC for the tender");
  if (normalized(computedKey[0]) !== normalized(plan.tenderKey) || normalized(tender[8]) !== normalized(tenderIdHash(plan.tenderId))) fail("TENDER_KEY", "on-chain tender identity does not match the exact stranded key");
  if (account.account !== DEMO_OPERATOR_ACCOUNT_ID || account.key?._type !== "ECDSA_SECP256K1" || normalized(account.key.key).replace(/^0x/, "") !== secrets.operatorPublicKey || normalized(account.evm_address) !== shipper) fail("REFUND_RECIPIENT", "registered shipper is not the configured original operator account");
  if (normalized(tender[3]) !== zeroAddress || String(tender[6]) !== "0" || String(tender[7]) !== "0" || normalized(tender[11]) !== `0x${"0".repeat(64)}`) fail("ALLOCATION", "on-chain tender contains winner allocation state");
  if (normalized(tender[9]) !== normalized(localManifestHash)) fail("MANIFEST", "registered tender manifest differs from the immutable local tender manifest");
  if (authUsed[0] !== false) fail("AUTHORIZATION", "recovery authorization hash is already consumed");
  if (topicOne !== null || proofFive === null || proofSix !== null) fail("TOPICS", "demo or immutable proof topic state changed");

  const report: RecoveryPreflight = {
    schemaVersion: "routeguard-operations-refund-preflight-1.0", status: "PASS", checkedAt: new Date().toISOString(), network: "hedera:testnet",
    runId: plan.runId, sessionId: plan.sessionId, tenderId: plan.tenderId, tenderVersion: 1, tenderKey: plan.tenderKey,
    contractId: DEMO_CONTRACT_ID, contractEvmAddress: DEMO_CONTRACT_EVM_ADDRESS, tokenId: DEMO_TOKEN_ID,
    contractState: "FUNDED", tenderBalanceAtomic: "20000", totalEscrowedAtomic: "20000", contractTokenBalanceAtomic: "20000",
    refundRecipientAccountId: DEMO_OPERATOR_ACCOUNT_ID, refundRecipientEvmAddress: shipper, refundAmountAtomic: "20000",
    authorizationHash: plan.authorizationHash, authorizationHashUsed: false,
    registeredManifestHash: normalized(tender[9]), localManifestHash, registeredManifestPreserved: true,
    carrierOfferPaymentOccurred: false, winnerAllocationOccurred: false, demoTopicSequence: 0, proofTopicSequence: 5,
    successfulSessionWritesBeforeRecovery: 4, additionalApplicationWrites: RECOVERY_MAX_WRITES, projectedSuccessfulWritesAfterRecovery: 5,
    networkWritesDuringPreflight: 0,
  };
  atomicJson(path.join(RECOVERY_EVIDENCE_DIR, "refund-preflight.json"), report);
  writeFileSync(path.join(RECOVERY_EVIDENCE_DIR, "README.md"), "# Operations Demo stranded-tender recovery\n\nRead-only preflight for one manual `refundNoQualifiedBid` transaction. The original registered tender manifest is preserved. No carrier-offer payment or winner allocation occurred. Execution requires a separate explicit authorization and exactly one guarded Hedera testnet write.\n", "utf8");
  console.log("RECOVERY_PREFLIGHT=PASS");
  console.log(`LIVE_RUN_ID=${plan.runId}`);
  console.log(`TENDER_KEY=${plan.tenderKey}`);
  console.log("CONTRACT_STATE=FUNDED CONTRACT_BALANCE_ATOMIC=20000");
  console.log(`REFUND_RECIPIENT_ACCOUNT=${DEMO_OPERATOR_ACCOUNT_ID} REFUND_AMOUNT_ATOMIC=20000`);
  console.log("CARRIER_OFFER_PAYMENT=ABSENT WINNER_ALLOCATION=ABSENT");
  console.log("REGISTERED_TENDER_MANIFEST=PRESERVED");
  console.log("ADDITIONAL_STATE_CHANGING_WRITES=1");
  console.log("NETWORK_WRITES=0");
  return { report, plan };
}

async function execute(report: RecoveryPreflight, plan: RecoveryPlan): Promise<void> {
  if (process.env[RECOVERY_CONFIRM_ENV]?.trim() !== RECOVERY_CONFIRM_VALUE) fail("AUTH_GUARD", `${RECOVERY_CONFIRM_ENV} is missing or incorrect`);
  if (process.env[RECOVERY_MAX_WRITES_ENV]?.trim() !== "1") fail("WRITE_GUARD", `${RECOVERY_MAX_WRITES_ENV} must be 1`);
  const secrets = resolveLiveSecrets(process.env);
  const txPlan = buildNoQualifiedBidRefundPlan({ tenderId: plan.tenderId, tenderVersion: 1, authorizationHash: plan.authorizationHash });
  if (txPlan.tenderKey !== plan.tenderKey || txPlan.operation !== "REFUND_NO_QUALIFIED_BID") fail("REFUND_PLAN", "refund transaction plan binding failed");
  let journal = existsSync(RECOVERY_JOURNAL_FILE) ? JSON.parse(readFileSync(RECOVERY_JOURNAL_FILE, "utf8")) as { transactionId?: string; tenderKey?: string; authorizationHash?: string } : { tenderKey: plan.tenderKey, authorizationHash: plan.authorizationHash };
  if (journal.tenderKey !== plan.tenderKey || journal.authorizationHash !== plan.authorizationHash) fail("RECOVERY_JOURNAL", "recovery journal binding differs");
  if (!journal.transactionId) {
    atomicJson(RECOVERY_JOURNAL_FILE, journal);
    const client = createTestnetClient({ network: "hedera:testnet", accountId: DEMO_OPERATOR_ACCOUNT_ID, privateKey: secrets.operatorPrivateKey });
    try {
      const executor = new ContractExecutor({ contractId: DEMO_CONTRACT_ID, contractEvmAddress: DEMO_CONTRACT_EVM_ADDRESS, tokenId: DEMO_TOKEN_ID });
      await executor.execute(client, txPlan, (receipt) => { journal = { ...journal, transactionId: receipt.transactionId }; atomicJson(RECOVERY_JOURNAL_FILE, journal); });
    } finally { client.close(); }
  }
  const transactionId = journal.transactionId!;
  const mirror = new MirrorReader();
  let transaction = await mirror.transaction(transactionId, true);
  for (let attempt = 0; attempt < 30 && transaction.status === "NOT_FOUND"; attempt += 1) { await new Promise((resolve) => setTimeout(resolve, 2_000)); transaction = await mirror.transaction(transactionId, true); }
  const [state, tenderBalance, total, contractBalance, authUsed] = await Promise.all([
    mirror.contractCall(DEMO_CONTRACT_EVM_ADDRESS, "getState", [plan.tenderKey]),
    mirror.contractCall(DEMO_CONTRACT_EVM_ADDRESS, "tenderBalance", [plan.tenderKey]),
    mirror.contractCall(DEMO_CONTRACT_EVM_ADDRESS, "totalEscrowedAmount", []),
    mirror.accountBalance(DEMO_CONTRACT_ID, DEMO_TOKEN_ID),
    mirror.contractCall(DEMO_CONTRACT_EVM_ADDRESS, "authorizationHashUsed", [plan.authorizationHash]),
  ]);
  const shipperDelta = transaction.tokenTransfers.filter((item) => item.tokenId === DEMO_TOKEN_ID && item.accountId === DEMO_OPERATOR_ACCOUNT_ID).reduce((sum, item) => sum + item.amount, 0);
  const contractDelta = transaction.tokenTransfers.filter((item) => item.tokenId === DEMO_TOKEN_ID && item.accountId === DEMO_CONTRACT_ID).reduce((sum, item) => sum + item.amount, 0);
  if (transaction.status !== "SUCCESS" || String(state[0]) !== "6" || String(tenderBalance[0]) !== "0" || String(total[0]) !== "0" || contractBalance !== 0n || authUsed[0] !== true || shipperDelta !== 20_000 || contractDelta !== -20_000) fail("REFUND_VERIFY", "refund transaction did not reconcile exactly");
  atomicJson(path.join(RECOVERY_EVIDENCE_DIR, "refund-result.json"), { ...report, status: "SUCCESS", transactionId, hashScanUrl: transaction.hashScanUrl, consensusTimestamp: transaction.consensusTimestamp, finalContractState: "REFUNDED", finalTenderBalanceAtomic: "0", finalContractTokenBalanceAtomic: "0", shipperRefundAtomic: "20000", additionalApplicationWrites: 1, totalSuccessfulWritesIncludingRecovery: 5 });
  console.log("REFUND_NO_QUALIFIED_BID=PASS");
  console.log(`REFUND_TRANSACTION_ID=${transactionId}`);
  console.log("REFUND_AMOUNT_ATOMIC=20000 FINAL_CONTRACT_STATE=REFUNDED");
  console.log("ADDITIONAL_STATE_CHANGING_WRITES=1");
}

const mode = process.argv.includes("--execute") ? "execute" : "preflight";
preflight().then(async ({ report, plan }) => {
  if (mode === "execute") await execute(report, plan);
  else console.log("EXPLICIT_REFUND_AUTHORIZATION_RECEIVED=NO");
}).catch((error) => fail("RUNNER", error instanceof Error ? error.message : "unknown failure"));
