/**
 * Phase E1 — guarded live Hedera testnet freight release and tender completion.
 *
 * Executes the releaseFull transaction plan prepared and signed for in Phase D2,
 * moving the locked 750,000 atomic HTS USDC to the winning carrier, then anchors
 * ESCROW_RELEASED and TENDER_COMPLETED to the existing Phase D2 POD topic.
 *
 * Exactly three state-changing network writes are authorized:
 *   1. ContractExecute releaseFull(bytes32,bytes32)
 *   2. TopicMessageSubmit — ESCROW_RELEASED   (expected sequence 4)
 *   3. TopicMessageSubmit — TENDER_COMPLETED  (expected sequence 5)
 *
 * All escrow state reads use the free Mirror Node `contracts/call` endpoint, so
 * verification adds no ledger transaction.
 *
 * Usage:
 *   ROUTEGUARD_LIVE_V2_RELEASE_CONFIRM=I_UNDERSTAND_TESTNET_FREIGHT_RELEASE \
 *   ROUTEGUARD_LIVE_V2_RELEASE_MAX_WRITES=3 \
 *   ENABLE_LIVE_HEDERA=true \
 *   npm run demo:v2-release-live
 *
 * Never logs private keys, master encryption keys, mnemonics, raw signature
 * material, or environment values.
 */

import "dotenv/config";

import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  AccountId,
  Client,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractId,
  Hbar,
  PrivateKey,
  Status,
  TopicId,
  TopicMessageSubmitTransaction,
} from "@hiero-ledger/sdk";
import { Interface } from "ethers";

import { canonicalSha256 } from "../src/domain/canonical-hash";
import { isValidHederaAccountId } from "../src/domain/payment-option";
import { signCanonicalPayload } from "../src/domain/signature";
import {
  buildHcsV2Envelope,
  serializeHcsV2Envelope,
  utf8ByteLength,
} from "../src/hcs/v2/envelope";
import { HCS_V2_MAX_MESSAGE_BYTES, type HcsV2Envelope } from "../src/hcs/v2/types";
import {
  hashScanTransactionUrl,
  toMirrorTransactionId,
} from "../src/v2/access/mirror-reconcile";
import {
  buildShipperPodReviewSignPayload,
  signPayloadHash,
} from "../src/v2/auth/canonical";
import { verifyShipperPodReview } from "../src/v2/auth/verify";
import { parseEscrowEvents } from "../src/v2/escrow/events";
import { escrowStateFromOrdinal } from "../src/v2/escrow/states";
import { escrowTenderKey } from "../src/v2/escrow/tender-key";
import type { LifecycleEvent } from "../src/v2/lifecycle/events";
import { eventPayloadHash } from "../src/v2/lifecycle/reducer";
import { trustPolicyFromRecord } from "../src/v2/lifecycle/record";
import {
  buildBoundReleaseFullPlan,
  shipperAcceptanceAuthorizationHash,
} from "../src/v2/pod/escrow-plans";
import { LifecycleService } from "../src/v2/store/lifecycle-service";
import { FileLifecycleStore } from "../src/v2/store/lifecycle-store";
import {
  HEDERA_TESTNET_MIRROR_NODE,
  VERIFIED_USDC_TOKEN_ID,
} from "../src/x402/usdc-constants";

// ---------------------------------------------------------------------------
// Guards / constants
// ---------------------------------------------------------------------------

const CONFIRM_ENV = "ROUTEGUARD_LIVE_V2_RELEASE_CONFIRM";
const CONFIRM_VALUE = "I_UNDERSTAND_TESTNET_FREIGHT_RELEASE";
const MAX_WRITES_ENV = "ROUTEGUARD_LIVE_V2_RELEASE_MAX_WRITES";
const MAX_WRITES = 3;
const PROJECTED_WRITES = 3;

/** No-write rehearsal: every guard and read-only check, stopping before write 1. */
const DRY_PREFLIGHT_ENV = "ROUTEGUARD_LIVE_V2_RELEASE_DRY_PREFLIGHT";

function isDryPreflight(): boolean {
  return process.env[DRY_PREFLIGHT_ENV] === "true";
}

const REQUIRED_BRANCH = "feat/routeguard-v2-phase-e";
const REQUIRED_NETWORK = "hedera:testnet";
const REQUIRED_TOKEN = VERIFIED_USDC_TOKEN_ID; // 0.0.429274

const EXPECTED_CONTRACT_ID = "0.0.9861047";
const EXPECTED_CONTRACT_EVM = "0x00000000000000000000000000000000009677b7";
const EXPECTED_TOPIC_ID = "0.0.9862010";
const EXPECTED_LOCKED_ATOMIC = "750000";
const V1_IMMUTABLE_TOPIC_ID = "0.0.9794225";

/** POD topic already carries sequences 1..3 from Phase D2. */
const EXPECTED_PRIOR_SEQUENCES = 3;
const EXPECTED_RELEASE_SEQUENCE = 4;
const EXPECTED_COMPLETION_SEQUENCE = 5;

const MIN_OPERATOR_TINYBARS = 500_000_000n; // 5 HBAR

const EVIDENCE_DIR = path.join("evidence", "v2", "release");
const POD_EVIDENCE_DIR = path.join("evidence", "v2", "pod");
const ESCROW_EVIDENCE_DIR = path.join("evidence", "v2", "escrow");
const ACCESS_EVIDENCE_DIR = path.join("evidence", "v2", "access");
const DATA_DIR = path.join("data", "v2-live-release");
const PROGRESS_PATH = path.join(DATA_DIR, "progress.json");
/** Phase D2 wrote the authoritative lifecycle record; Phase E continues it. */
const LIFECYCLE_DIR = path.join("data", "v2-live-pod", "lifecycle");

const PROGRESS_SCHEMA = "routeguard-v2-release-live-1.0" as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StepName = "release_full" | "escrow_released" | "tender_completed";

const HCS_STEPS: readonly StepName[] = ["escrow_released", "tender_completed"];

type TxRecord = {
  step: StepName;
  kind: "CONTRACT_EXECUTE" | "HCS_MESSAGE";
  messageType: string | null;
  transactionId: string;
  mirrorTransactionId: string;
  consensusTimestamp: string | null;
  result: string | null;
  hashScanUrl: string;
  mirrorStatus: "SUCCESS" | "FAILED" | "NOT_FOUND" | "PENDING";
  sequenceNumber: number | null;
  messageBytes: number | null;
  localMessageSha256: string | null;
  mirrorMessageSha256: string | null;
  bytesMatch: boolean;
  payloadHash: string | null;
};

type Balances = {
  carrierUsdcAtomic: string;
  shipperUsdcAtomic: string;
  contractUsdcAtomic: string;
  readAt: string;
};

type ContractSnapshot = {
  contractId: string;
  contractEvmAddress: string;
  tenderKey: string;
  state: string;
  tenderBalanceAtomic: string;
  totalEscrowedAtomic: string;
  releaseAuthorizationHashUsed: boolean | null;
  readAt: string;
};

type ReleaseEventProof = {
  eventName: string;
  tenderKey: string;
  winner: string;
  amountAtomic: string;
  authorizationHash: string;
  fromDispute: boolean;
  matchesPlan: boolean;
};

type Bindings = {
  accessRunId: string;
  escrowRunId: string;
  podRunId: string;
  tenderId: string;
  tenderVersion: number;
  tenderKey: string;
  contractId: string;
  contractEvmAddress: string;
  topicId: string;
  tokenId: string;
  shipperAccountId: string;
  carrierAccountId: string;
  /** Winner address the Phase C2 allocation actually bound (ECDSA alias). */
  carrierEvmAddress: string;
  winningBidId: string;
  podId: string;
  podVersion: number;
  manifestHash: string;
  packageContentHash: string;
  ciphertextHash: string;
  advisoryReportHash: string;
  acceptanceActionId: string;
  acceptanceSignedAt: string;
  acceptanceReviewDeadlineAt: string;
  acceptanceAuthPayloadHash: string;
  authorizationHash: string;
  releasePlanHash: string;
  lockedAmountAtomic: string;
  gasLimit: number;
  priorSequences: Record<string, number>;
};

type Progress = {
  schemaVersion: typeof PROGRESS_SCHEMA;
  runId: string;
  status: "IN_PROGRESS" | "SUCCESS" | "FAILED";
  network: string;
  bindings: Bindings;
  operatorAccountId: string;
  projectedWrites: number;
  successfulWrites: number;
  writeLog: Array<{ step: string; transactionId: string; at: string }>;
  completedSteps: StepName[];
  transactions: Partial<Record<StepName, TxRecord>>;
  envelopes: Partial<Record<StepName, HcsV2Envelope>>;
  balancesBefore: Balances | null;
  balancesAfter: Balances | null;
  contractBefore: ContractSnapshot | null;
  contractAfter: ContractSnapshot | null;
  releaseEvent: ReleaseEventProof | null;
  evidenceChainHash: string | null;
  completionRef: string | null;
  queryPaymentTransactions: number;
  createdAt: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(code: string, message: string): never {
  console.error(`FAIL [${code}]: ${message}`);
  process.exit(1);
}

function present(name: string): boolean {
  const v = process.env[name]?.trim();
  return Boolean(v && v.length > 0);
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) die("ENV_MISSING", `${name} is required`);
  return v;
}

function writeJson(filePath: string, data: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function readJson<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function requireJson<T>(filePath: string, label: string): T {
  const value = readJson<T>(filePath);
  if (!value) die("EVIDENCE", `${label} is missing or unreadable`);
  return value;
}

function sha256Hex(input: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(input).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function stableRunId(): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `v2rel-${day}-${randomBytes(4).toString("hex")}`;
}

function hexToBytes32(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error("expected 32-byte hex");
  return Uint8Array.from(Buffer.from(h, "hex"));
}

function publicReportEnv(): void {
  const keys = [
    CONFIRM_ENV,
    MAX_WRITES_ENV,
    "ENABLE_LIVE_HEDERA",
    "HEDERA_NETWORK",
    "USDC_TOKEN_ID",
    "OPERATOR_ACCOUNT_ID",
    "OPERATOR_PRIVATE_KEY",
    "SHIPPER_ACCOUNT_ID",
    "SHIPPER_PRIVATE_KEY",
    "FINAL_DEMO_CARRIER_ALPHA_ACCOUNT_ID",
  ];
  for (const k of keys) {
    console.log(`ENV ${k}=${present(k) ? "PRESENT" : "MISSING"}`);
  }
}

function parseEcdsaKey(label: string, raw: string): PrivateKey {
  try {
    return PrivateKey.fromStringECDSA(raw.trim());
  } catch {
    die("KEY", `${label} could not be parsed as ECDSA secp256k1 (details suppressed)`);
  }
}

// ---------------------------------------------------------------------------
// Git guards
// ---------------------------------------------------------------------------

function assertBranch(): void {
  const branch = execFileSync("git", ["branch", "--show-current"], {
    encoding: "utf8",
  }).trim();
  if (branch !== REQUIRED_BRANCH) {
    die("BRANCH", `branch must be ${REQUIRED_BRANCH}, got ${branch}`);
  }
  console.log(`BRANCH=${branch}`);
}

const ALLOWED_DIRTY_PREFIXES = ["evidence/v2/release/", "data/", "artifacts/"];
const ALLOWED_DIRTY_EXACT = new Set([
  "scripts/run-v2-release-live.ts",
  "package.json",
  "package-lock.json",
  "docs/v2-freight-escrow.md",
  "docs/v2-pod-review.md",
  "PROJECT_STATUS.md",
]);

function dirtyPaths(): string[] {
  const porcelain = execFileSync("git", ["status", "--porcelain", "-z"], {
    encoding: "utf8",
  });
  if (!porcelain) return [];
  const records = porcelain.split("\0").filter((r) => r.length > 0);
  const paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    const status = rec.slice(0, 2);
    const filePath = rec.slice(2).replace(/^\s+/, "").replace(/\\/g, "/");
    if (status.includes("R") || status.includes("C")) i += 1;
    if (filePath) paths.push(filePath);
  }
  return paths;
}

function assertWorkingTreeGuard(): void {
  const paths = dirtyPaths();
  if (paths.length === 0) {
    console.log("WORKING_TREE=CLEAN");
    return;
  }
  for (const p of paths) {
    const ok =
      ALLOWED_DIRTY_EXACT.has(p) ||
      ALLOWED_DIRTY_PREFIXES.some((prefix) => p.startsWith(prefix));
    if (!ok) die("DIRTY", `working tree has unexpected dirty path: ${p}`);
  }
  console.log(`WORKING_TREE=PHASE_E_ALLOWED_DIRTY paths=${paths.length}`);
}

function assertImmutableEvidenceUnchanged(): void {
  const guarded = [
    "evidence/v2/access/",
    "evidence/v2/escrow/",
    "evidence/v2/pod/",
    "evidence/final-demo",
  ];
  for (const p of dirtyPaths()) {
    if (guarded.some((g) => p.startsWith(g))) {
      die("IMMUTABLE_EVIDENCE", `protected evidence path modified: ${p}`);
    }
  }
  console.log("IMMUTABLE_EVIDENCE=UNCHANGED");
}

// ---------------------------------------------------------------------------
// Mirror helpers (read-only, free)
// ---------------------------------------------------------------------------

async function mirrorGet<T>(urlPath: string): Promise<T> {
  const url = `${HEDERA_TESTNET_MIRROR_NODE.replace(/\/$/, "")}${urlPath}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Mirror HTTP ${res.status} for ${urlPath}`);
  return (await res.json()) as T;
}

const ESCROW_READ_INTERFACE = new Interface([
  "function getState(bytes32) view returns (uint8)",
  "function tenderBalance(bytes32) view returns (uint64)",
  "function totalEscrowedAmount() view returns (uint256)",
  "function authorizationHashUsed(bytes32) view returns (bool)",
]);

/** Free off-ledger contract evaluation — bills no query payment. */
async function mirrorContractCall(
  contractEvmAddress: string,
  fn: string,
  args: readonly unknown[],
): Promise<readonly unknown[]> {
  const data = ESCROW_READ_INTERFACE.encodeFunctionData(fn, args as unknown[]);
  const url = `${HEDERA_TESTNET_MIRROR_NODE.replace(/\/$/, "")}/api/v1/contracts/call`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ to: contractEvmAddress, data, estimate: false }),
  });
  if (!res.ok) throw new Error(`Mirror contracts/call HTTP ${res.status} for ${fn}`);
  const body = (await res.json()) as { result?: string };
  if (!body.result) throw new Error(`Mirror contracts/call returned no result for ${fn}`);
  return ESCROW_READ_INTERFACE.decodeFunctionResult(fn, body.result);
}

async function readContractSnapshot(
  bindings: Bindings,
  authorizationHash: string | null,
): Promise<ContractSnapshot> {
  const evm = bindings.contractEvmAddress;
  const key = bindings.tenderKey;
  const state = escrowStateFromOrdinal(
    Number((await mirrorContractCall(evm, "getState", [key]))[0]),
  );
  const tenderBalance = String((await mirrorContractCall(evm, "tenderBalance", [key]))[0]);
  const totalEscrowed = String((await mirrorContractCall(evm, "totalEscrowedAmount", []))[0]);
  let used: boolean | null = null;
  if (authorizationHash) {
    used = Boolean(
      (await mirrorContractCall(evm, "authorizationHashUsed", [authorizationHash]))[0],
    );
  }
  return {
    contractId: bindings.contractId,
    contractEvmAddress: evm,
    tenderKey: key,
    state,
    tenderBalanceAtomic: tenderBalance,
    totalEscrowedAtomic: totalEscrowed,
    releaseAuthorizationHashUsed: used,
    readAt: new Date().toISOString(),
  };
}

async function accountTokenBalance(accountId: string, tokenId: string): Promise<bigint> {
  const body = await mirrorGet<{
    tokens?: Array<{ token_id?: string; balance?: number }>;
  }>(`/api/v1/accounts/${accountId}/tokens?limit=100`);
  const hit = (body.tokens ?? []).find((t) => t.token_id === tokenId);
  return BigInt(hit?.balance ?? 0);
}

async function readBalances(bindings: Bindings): Promise<Balances> {
  return {
    carrierUsdcAtomic: (
      await accountTokenBalance(bindings.carrierAccountId, bindings.tokenId)
    ).toString(),
    shipperUsdcAtomic: (
      await accountTokenBalance(bindings.shipperAccountId, bindings.tokenId)
    ).toString(),
    contractUsdcAtomic: (
      await accountTokenBalance(bindings.contractId, bindings.tokenId)
    ).toString(),
    readAt: new Date().toISOString(),
  };
}

async function accountEvmAddress(accountId: string): Promise<string | null> {
  const acc = await mirrorGet<{ evm_address?: string | null }>(
    `/api/v1/accounts/${accountId}`,
  );
  if (!acc.evm_address) return null;
  return acc.evm_address.startsWith("0x")
    ? acc.evm_address.toLowerCase()
    : `0x${acc.evm_address.toLowerCase()}`;
}

async function accountHbar(accountId: string): Promise<bigint> {
  const acc = await mirrorGet<{ balance?: { balance?: number } }>(
    `/api/v1/accounts/${accountId}`,
  );
  return BigInt(acc.balance?.balance ?? 0);
}

type MirrorTxDetail = {
  mirrorTransactionId: string;
  consensusTimestamp: string | null;
  result: string | null;
  mirrorStatus: TxRecord["mirrorStatus"];
  hashScanUrl: string;
  tokenTransfers: Array<{ account: string; amount: number; token_id: string }>;
  logs: Array<{ topics: string[]; data: string }>;
};

async function mirrorVerifyTransaction(
  transactionId: string,
  withLogs = false,
  attempts = 16,
  delayMs = 1500,
): Promise<MirrorTxDetail> {
  const mirrorId = toMirrorTransactionId(transactionId);
  for (let i = 0; i < attempts; i++) {
    try {
      const payload = await mirrorGet<{
        transactions?: Array<{
          name?: string;
          nonce?: number;
          result?: string;
          consensus_timestamp?: string;
          parent_consensus_timestamp?: string | null;
          token_transfers?: Array<{ token_id?: string; account?: string; amount?: number }>;
        }>;
      }>(`/api/v1/transactions/${encodeURIComponent(mirrorId)}`);
      const entries = (payload.transactions ?? []).filter((t) => t.result);
      // A contract call that moves HTS tokens through the precompile records the
      // transfer legs on a *child* CryptoTransfer, not on the parent
      // CONTRACTCALL — so legs are aggregated across the whole record set.
      const tx =
        entries.find((t) => !t.parent_consensus_timestamp && (t.nonce ?? 0) === 0) ??
        entries[0];
      if (tx?.result) {
        const failedChild = entries.find((t) => t.result !== "SUCCESS");
        if (tx.result === "SUCCESS" && failedChild) {
          throw new Error(`child transaction failed: ${failedChild.result}`);
        }
        const allTokenTransfers = entries.flatMap((t) => t.token_transfers ?? []);
        let logs: Array<{ topics: string[]; data: string }> = [];
        if (withLogs) {
          try {
            const cr = await mirrorGet<{
              logs?: Array<{ topics?: string[]; data?: string }>;
            }>(`/api/v1/contracts/results/${encodeURIComponent(mirrorId)}`);
            logs = (cr.logs ?? []).map((l) => ({
              topics: (l.topics ?? []).map((t) => (t.startsWith("0x") ? t : `0x${t}`)),
              data: l.data && l.data.startsWith("0x") ? l.data : `0x${l.data ?? ""}`,
            }));
          } catch {
            // contract result may lag
          }
        }
        return {
          mirrorTransactionId: mirrorId,
          consensusTimestamp: tx.consensus_timestamp ?? null,
          result: tx.result,
          mirrorStatus: tx.result === "SUCCESS" ? "SUCCESS" : "FAILED",
          hashScanUrl: hashScanTransactionUrl(transactionId),
          tokenTransfers: allTokenTransfers
            .filter((t) => t.account && t.token_id && typeof t.amount === "number")
            .map((t) => ({ account: t.account!, amount: t.amount!, token_id: t.token_id! })),
          logs,
        };
      }
    } catch {
      // retry
    }
    await sleep(delayMs);
  }
  return {
    mirrorTransactionId: mirrorId,
    consensusTimestamp: null,
    result: null,
    mirrorStatus: "NOT_FOUND",
    hashScanUrl: hashScanTransactionUrl(transactionId),
    tokenTransfers: [],
    logs: [],
  };
}

async function mirrorTopicMessage(
  topicId: string,
  sequenceNumber: number,
  attempts = 16,
  delayMs = 1500,
): Promise<{
  consensusTimestamp: string | null;
  sequenceNumber: number | null;
  bytes: Uint8Array | null;
}> {
  for (let i = 0; i < attempts; i++) {
    try {
      const body = await mirrorGet<{
        consensus_timestamp?: string;
        message?: string;
        sequence_number?: number;
        topic_id?: string;
      }>(`/api/v1/topics/${topicId}/messages/${sequenceNumber}`);
      if (body.message) {
        if (body.topic_id && body.topic_id !== topicId) {
          throw new Error("mirror returned a message for a different topic");
        }
        return {
          consensusTimestamp: body.consensus_timestamp ?? null,
          sequenceNumber: body.sequence_number ?? sequenceNumber,
          bytes: new Uint8Array(Buffer.from(body.message, "base64")),
        };
      }
    } catch {
      // retry
    }
    await sleep(delayMs);
  }
  return { consensusTimestamp: null, sequenceNumber: null, bytes: null };
}

type TopicMessageRow = {
  sequenceNumber: number;
  consensusTimestamp: string;
  messageType: string;
  tenderId: string;
  payloadHash: string;
  sha256: string;
};

async function listTopicMessages(topicId: string): Promise<TopicMessageRow[]> {
  const body = await mirrorGet<{
    messages?: Array<{
      sequence_number?: number;
      consensus_timestamp?: string;
      message?: string;
    }>;
  }>(`/api/v1/topics/${topicId}/messages?limit=50&order=asc`);
  return (body.messages ?? []).map((m) => {
    const bytes = Buffer.from(m.message ?? "", "base64");
    const parsed = JSON.parse(bytes.toString("utf8")) as HcsV2Envelope;
    return {
      sequenceNumber: m.sequence_number ?? -1,
      consensusTimestamp: m.consensus_timestamp ?? "",
      messageType: parsed.messageType,
      tenderId: parsed.tenderId,
      payloadHash: parsed.payloadHash,
      sha256: sha256Hex(bytes),
    };
  });
}

/**
 * Count Hedera query-payment CryptoTransfers made by the operator during this
 * run. This runner reads state through the free Mirror endpoint, so the
 * expected value is zero; it is measured rather than assumed.
 */
async function countQueryPayments(progress: Progress): Promise<number> {
  const startSeconds = Math.floor(Date.parse(progress.createdAt) / 1000);
  try {
    const body = await mirrorGet<{
      transactions?: Array<{
        transaction_id?: string;
        nonce?: number;
        parent_consensus_timestamp?: string | null;
      }>;
    }>(
      `/api/v1/transactions?account.id=${progress.operatorAccountId}` +
        `&timestamp=gte:${startSeconds}&limit=100&order=asc&transactiontype=CRYPTOTRANSFER`,
    );
    return (body.transactions ?? []).filter(
      (t) =>
        (t.transaction_id ?? "").startsWith(`${progress.operatorAccountId}-`) &&
        // Child CryptoTransfers are the HTS legs of releaseFull itself, not
        // separate query payments.
        !t.parent_consensus_timestamp &&
        (t.nonce ?? 0) === 0,
    ).length;
  } catch {
    return -1;
  }
}

// ---------------------------------------------------------------------------
// Write budget
// ---------------------------------------------------------------------------

class WriteBudget {
  successful = 0;
  log: Array<{ step: string; transactionId: string; at: string }> = [];

  constructor(readonly max: number) {}

  assertCanWrite(count = 1): void {
    if (this.successful + count > this.max) {
      die(
        "WRITE_CAP",
        `projected successful writes ${this.successful + count} would exceed cap ${this.max}`,
      );
    }
  }

  recordSuccess(step: string, transactionId: string): void {
    this.successful += 1;
    this.log.push({ step, transactionId, at: new Date().toISOString() });
    console.log(
      `WRITE_OK step=${step} tx=${transactionId} count=${this.successful}/${this.max}`,
    );
  }
}

function saveProgress(p: Progress): void {
  p.updatedAt = new Date().toISOString();
  writeJson(PROGRESS_PATH, p);
}

function markStep(p: Progress, step: StepName, budget: WriteBudget): void {
  if (!p.completedSteps.includes(step)) p.completedSteps.push(step);
  p.successfulWrites = budget.successful;
  p.writeLog = [...budget.log];
  saveProgress(p);
}

// ---------------------------------------------------------------------------
// Evidence-derived bindings (authoritative — never re-invented)
// ---------------------------------------------------------------------------

function readBindings(): Bindings {
  const escrow = requireJson<Record<string, any>>(
    path.join(ESCROW_EVIDENCE_DIR, "run-summary.json"),
    "Phase C2 escrow run-summary.json",
  );
  const escrowState = requireJson<Record<string, any>>(
    path.join(ESCROW_EVIDENCE_DIR, "contract-state.json"),
    "Phase C2 contract-state.json",
  );
  const pod = requireJson<Record<string, any>>(
    path.join(POD_EVIDENCE_DIR, "run-summary.json"),
    "Phase D2 POD run-summary.json",
  );
  const plan = requireJson<Record<string, any>>(
    path.join(POD_EVIDENCE_DIR, "release-plan.json"),
    "Phase D2 release-plan.json",
  );
  const acceptance = requireJson<Record<string, any>>(
    path.join(POD_EVIDENCE_DIR, "shipper-acceptance.json"),
    "Phase D2 shipper-acceptance.json",
  );
  const access = requireJson<Record<string, any>>(
    path.join(ACCESS_EVIDENCE_DIR, "run-summary.json"),
    "Phase B2b access run-summary.json",
  );
  const allocation = requireJson<Record<string, any>>(
    path.join(ESCROW_EVIDENCE_DIR, "winner-allocation.json"),
    "Phase C2 winner-allocation.json",
  );

  const priorSequences: Record<string, number> = {};
  for (const m of pod.hcs?.messages ?? []) {
    priorSequences[String(m.messageType)] = Number(m.sequenceNumber);
  }

  const bindings: Bindings = {
    accessRunId: String(access.runId ?? ""),
    escrowRunId: String(escrow.runId ?? ""),
    podRunId: String(pod.runId ?? ""),
    tenderId: String(escrow.tenderId ?? ""),
    tenderVersion: Number(escrow.tenderVersion ?? 0),
    tenderKey: String(escrow.tenderKey ?? ""),
    contractId: String(escrow.contractId ?? ""),
    contractEvmAddress: String(escrow.contractEvmAddress ?? "").toLowerCase(),
    topicId: String(pod.hcs?.topicId ?? ""),
    tokenId: String(escrow.tokenId ?? ""),
    shipperAccountId: String(escrow.shipperAccountId ?? ""),
    carrierAccountId: String(escrow.carrierAccountId ?? ""),
    carrierEvmAddress: String(allocation.winnerEvmAddress ?? "").toLowerCase(),
    winningBidId: String(pod.pod?.podId ? pod.acceptance?.actionId ?? "" : ""),
    podId: String(pod.pod?.podId ?? ""),
    podVersion: Number(pod.pod?.podVersion ?? 0),
    manifestHash: String(pod.pod?.manifestHash ?? ""),
    packageContentHash: String(pod.pod?.packageContentHash ?? ""),
    ciphertextHash: String(pod.pod?.ciphertextHash ?? ""),
    advisoryReportHash: String(pod.advisory?.reportHash ?? ""),
    acceptanceActionId: String(acceptance.actionId ?? ""),
    acceptanceSignedAt: String(acceptance.signedAt ?? ""),
    acceptanceReviewDeadlineAt: String(acceptance.reviewDeadlineAt ?? ""),
    acceptanceAuthPayloadHash: String(acceptance.authPayloadHash ?? ""),
    authorizationHash: String(plan.authorizationHash ?? ""),
    releasePlanHash: String(plan.planHash ?? ""),
    lockedAmountAtomic: String(plan.lockedAmountAtomic ?? ""),
    gasLimit: Number(plan.gasLimit ?? 0),
    priorSequences,
  };

  // ---- Hard binding checks against the live references ----
  if (bindings.contractId !== EXPECTED_CONTRACT_ID) {
    die("BINDING", `escrow contract must be ${EXPECTED_CONTRACT_ID}`);
  }
  if (bindings.contractEvmAddress !== EXPECTED_CONTRACT_EVM.toLowerCase()) {
    die("BINDING", "escrow contract EVM address mismatch");
  }
  if (bindings.topicId === V1_IMMUTABLE_TOPIC_ID) {
    die("BINDING", "refusing to use the immutable v1 topic");
  }
  if (bindings.topicId !== EXPECTED_TOPIC_ID) {
    die("BINDING", `POD topic must be ${EXPECTED_TOPIC_ID}`);
  }
  if (bindings.tokenId !== REQUIRED_TOKEN) {
    die("BINDING", `token must be ${REQUIRED_TOKEN}`);
  }
  if (String(escrow.contractState) !== "ALLOCATED" || String(escrowState.state) !== "ALLOCATED") {
    die("BINDING", "recorded escrow state is not ALLOCATED");
  }
  if (bindings.lockedAmountAtomic !== EXPECTED_LOCKED_ATOMIC) {
    die("BINDING", `locked amount must be ${EXPECTED_LOCKED_ATOMIC}`);
  }
  if (String(escrow.contractLockedBalanceAtomic) !== EXPECTED_LOCKED_ATOMIC) {
    die("BINDING", "escrow evidence locked balance mismatch");
  }
  if (String(escrow.carrierFreightReceivedAtomic) !== "0") {
    die("BINDING", "escrow evidence already records a carrier freight payment");
  }
  if (escrowTenderKey(bindings.tenderId, bindings.tenderVersion) !== bindings.tenderKey) {
    die("BINDING", "tender key does not derive from the recorded tender identity");
  }
  if (String(plan.tenderKey) !== bindings.tenderKey) {
    die("BINDING", "release plan tender key does not match the live escrow");
  }
  if (String(plan.contractId) !== bindings.contractId) {
    die("BINDING", "release plan contract id mismatch");
  }
  if (String(plan.contractEvmAddress).toLowerCase() !== bindings.contractEvmAddress) {
    die("BINDING", "release plan contract EVM mismatch");
  }
  if (plan.submitted !== false || plan.submittedToNetwork !== false) {
    die("BINDING", "release plan is already marked submitted");
  }
  if (String(plan.contractFunction) !== "releaseFull") {
    die("BINDING", "release plan is not a releaseFull plan");
  }
  if (String(plan.functionSignature) !== "releaseFull(bytes32,bytes32)") {
    die("BINDING", "release plan function signature mismatch");
  }
  if (String(acceptance.action) !== "ACCEPT" || acceptance.signatureVerified !== true) {
    die("BINDING", "Phase D2 acceptance is not a verified ACCEPT");
  }
  if (String(acceptance.lifecycleStateAfter) !== "POD_ACCEPTED") {
    die("BINDING", "Phase D2 acceptance did not reach POD_ACCEPTED");
  }
  if (String(acceptance.tenderId) !== bindings.tenderId) {
    die("BINDING", "acceptance tender mismatch");
  }
  if (String(acceptance.podId) !== bindings.podId) {
    die("BINDING", "acceptance POD id mismatch");
  }
  if (!isValidHederaAccountId(bindings.carrierAccountId)) {
    die("BINDING", "carrier account id invalid");
  }
  if (!/^0x[0-9a-f]{40}$/.test(bindings.carrierEvmAddress)) {
    die("BINDING", "carrier EVM address from the Phase C2 allocation is invalid");
  }
  if (String(allocation.winnerAccountId) !== bindings.carrierAccountId) {
    die("BINDING", "allocation winner account differs from the escrow summary");
  }
  if (String(allocation.winningAmountAtomic) !== EXPECTED_LOCKED_ATOMIC) {
    die("BINDING", "allocation winning amount mismatch");
  }
  if (!/^0x[0-9a-f]{64}$/.test(bindings.authorizationHash)) {
    die("BINDING", "release authorization hash invalid");
  }
  if (priorSequences.POD_SUBMITTED !== 1 || priorSequences.POD_ADVISORY_ANCHORED !== 2) {
    die("BINDING", "Phase D2 POD sequences 1/2 not as recorded");
  }
  if (priorSequences.POD_REVIEW_ACTION !== 3) {
    die("BINDING", "Phase D2 POD review action sequence 3 not as recorded");
  }
  return bindings;
}

// ---------------------------------------------------------------------------
// Shipper acceptance re-verification
// ---------------------------------------------------------------------------

type AcceptanceProof = {
  signPayloadHash: string;
  matchesPodEvidence: boolean;
  matchesDurableRecord: boolean;
  signatureVerified: boolean;
  eventPayloadHashReproduced: boolean;
  shipperKeyFingerprint: string;
  bindsTenderIdVersion: boolean;
  bindsPodIdVersion: boolean;
  bindsManifestAndPackageHashes: boolean;
  bindsReviewAction: boolean;
  bindsActionId: boolean;
  bindsReviewDeadline: boolean;
  authorizationHashRederived: boolean;
};

/**
 * Re-derive the exact canonical ACCEPT payload, re-sign it with the configured
 * shipper key (Hiero ECDSA is RFC6979-deterministic, so the original signature
 * bytes are reproduced), verify it against the durable trust snapshot, and
 * confirm the reproduced event hash equals the one committed in Phase D2.
 */
function reverifyShipperAcceptance(
  bindings: Bindings,
  record: Awaited<ReturnType<LifecycleService["get"]>>,
  durableAcceptAction: { eventPayloadHash: string } | null,
  shipperKey: PrivateKey,
): AcceptanceProof {
  if (!record) die("LIFECYCLE", "durable Phase D2 lifecycle record not found");

  const payload = buildShipperPodReviewSignPayload({
    tenderId: bindings.tenderId,
    tenderVersion: bindings.tenderVersion,
    podId: bindings.podId,
    reviewAction: "ACCEPT",
    signedAt: bindings.acceptanceSignedAt,
    reviewDeadlineAt: bindings.acceptanceReviewDeadlineAt,
    actionId: bindings.acceptanceActionId,
  });
  const hash = signPayloadHash(payload);
  if (hash !== bindings.acceptanceAuthPayloadHash) {
    die("ACCEPTANCE", "re-derived acceptance payload hash differs from Phase D2 evidence");
  }
  if (record.lastShipperAuthPayloadHash !== hash) {
    die("ACCEPTANCE", "durable lifecycle record disagrees with the acceptance payload hash");
  }

  const signature = signCanonicalPayload(payload, shipperKey.toStringRaw());
  let verified = false;
  try {
    const auth = verifyShipperPodReview({
      policy: trustPolicyFromRecord(record),
      tenderId: bindings.tenderId,
      tenderVersion: bindings.tenderVersion,
      podId: bindings.podId,
      reviewAction: "ACCEPT",
      signedAt: bindings.acceptanceSignedAt,
      reviewDeadlineAt: bindings.acceptanceReviewDeadlineAt,
      actionId: bindings.acceptanceActionId,
      signature,
    });
    verified = auth.payloadHash === hash;
  } catch {
    die("ACCEPTANCE", "shipper ACCEPT signature failed verification against the trust snapshot");
  }

  const reproducedEvent: LifecycleEvent = {
    type: "POD_ACCEPTED_BY_SHIPPER",
    actionId: bindings.acceptanceActionId,
    eventTime: bindings.acceptanceSignedAt,
    shipperSignature: signature,
    signedAt: bindings.acceptanceSignedAt,
    reviewDeadlineAt: bindings.acceptanceReviewDeadlineAt,
  };
  const reproducedHash = eventPayloadHash(reproducedEvent);
  const eventReproduced = durableAcceptAction?.eventPayloadHash === reproducedHash;
  if (!eventReproduced) {
    die(
      "ACCEPTANCE",
      "reproduced acceptance event hash does not match the committed Phase D2 action",
    );
  }

  // The authorization hash the contract will consume must be derivable from the
  // accepted POD identity and content hash — not supplied out of band.
  const rederived = shipperAcceptanceAuthorizationHash({
    runOrTenderId: bindings.tenderId,
    podId: bindings.podId,
    podVersion: bindings.podVersion,
    actionId: bindings.acceptanceActionId,
    contentHash: record.podContentHash ?? "",
  });
  if (rederived !== bindings.authorizationHash) {
    die("ACCEPTANCE", "release authorization hash is not derivable from the acceptance");
  }

  return {
    signPayloadHash: hash,
    matchesPodEvidence: true,
    matchesDurableRecord: true,
    signatureVerified: verified,
    eventPayloadHashReproduced: true,
    shipperKeyFingerprint: record.trust.shipperKeyFingerprint,
    bindsTenderIdVersion:
      payload.tenderId === bindings.tenderId &&
      payload.tenderVersion === bindings.tenderVersion,
    bindsPodIdVersion:
      payload.podId === bindings.podId && record.podVersion === bindings.podVersion,
    bindsManifestAndPackageHashes:
      record.podContentHash === bindings.packageContentHash &&
      record.podCiphertextHash === bindings.ciphertextHash,
    bindsReviewAction: payload.reviewAction === "ACCEPT",
    bindsActionId: payload.actionId === bindings.acceptanceActionId,
    bindsReviewDeadline: payload.reviewDeadlineAt === bindings.acceptanceReviewDeadlineAt,
    authorizationHashRederived: true,
  };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function stepReleaseFull(
  client: Client,
  progress: Progress,
  budget: WriteBudget,
): Promise<void> {
  if (progress.completedSteps.includes("release_full")) {
    console.log(
      `SKIP release_full (tx ${progress.transactions.release_full?.transactionId})`,
    );
    return;
  }
  const b = progress.bindings;
  if (isDryPreflight()) {
    console.log(
      `DRY releaseFull(${b.tenderKey}, ${b.authorizationHash}) gas=${b.gasLimit} (not submitted)`,
    );
    return;
  }
  budget.assertCanWrite(1);

  const params = new ContractFunctionParameters()
    .addBytes32(hexToBytes32(b.tenderKey))
    .addBytes32(hexToBytes32(b.authorizationHash));

  const response = await new ContractExecuteTransaction()
    .setContractId(ContractId.fromString(b.contractId))
    .setGas(b.gasLimit)
    .setFunction("releaseFull", params)
    .setMaxTransactionFee(new Hbar(20))
    .execute(client);
  const transactionId = response.transactionId.toString();
  const receipt = await response.getReceipt(client);

  // Record the attempt before any assertion can throw — releaseFull must never
  // be submitted twice, even if verification fails afterwards.
  budget.recordSuccess("release_full", transactionId);
  progress.transactions.release_full = {
    step: "release_full",
    kind: "CONTRACT_EXECUTE",
    messageType: null,
    transactionId,
    mirrorTransactionId: toMirrorTransactionId(transactionId),
    consensusTimestamp: null,
    result: null,
    hashScanUrl: hashScanTransactionUrl(transactionId),
    mirrorStatus: "PENDING",
    sequenceNumber: null,
    messageBytes: null,
    localMessageSha256: null,
    mirrorMessageSha256: null,
    bytesMatch: true,
    payloadHash: null,
  };
  markStep(progress, "release_full", budget);

  if (receipt.status !== Status.Success) {
    die("RELEASE", `releaseFull status ${receipt.status.toString()}`);
  }
  console.log(`RELEASE_FULL_OK tx=${transactionId}`);
}

async function verifyReleaseOnMirror(progress: Progress): Promise<void> {
  const record = progress.transactions.release_full;
  if (!record) die("MIRROR", "release transaction not recorded");
  const b = progress.bindings;

  const mirror = await mirrorVerifyTransaction(record.transactionId, true);
  if (mirror.mirrorStatus !== "SUCCESS") {
    die("MIRROR", `releaseFull mirror status ${mirror.mirrorStatus} result=${mirror.result}`);
  }

  // ---- Exact token movement ----
  const transfers = mirror.tokenTransfers.filter((t) => t.token_id === b.tokenId);
  const foreign = mirror.tokenTransfers.filter((t) => t.token_id !== b.tokenId);
  if (foreign.length > 0) {
    die("RELEASE", "transaction moved a token other than the escrow USDC");
  }
  const contractLeg = transfers.find((t) => t.account === b.contractId);
  const carrierLeg = transfers.find((t) => t.account === b.carrierAccountId);
  const shipperLeg = transfers.find((t) => t.account === b.shipperAccountId);
  if (!contractLeg || !carrierLeg) {
    die("RELEASE", "expected escrow→carrier USDC transfer legs are missing");
  }
  if (String(carrierLeg.amount) !== EXPECTED_LOCKED_ATOMIC) {
    die("RELEASE", `carrier leg ${carrierLeg.amount} !== ${EXPECTED_LOCKED_ATOMIC}`);
  }
  if (String(contractLeg.amount) !== `-${EXPECTED_LOCKED_ATOMIC}`) {
    die("RELEASE", `escrow leg ${contractLeg.amount} !== -${EXPECTED_LOCKED_ATOMIC}`);
  }
  if (shipperLeg) {
    die("RELEASE", "shipper unexpectedly received a token transfer during release");
  }
  if (transfers.length !== 2) {
    die("RELEASE", `expected exactly 2 USDC transfer legs, saw ${transfers.length}`);
  }

  // ---- FreightReleased event ----
  const events = parseEscrowEvents(mirror.logs);
  const released = events.find((e) => e.name === "FreightReleased");
  if (!released) die("RELEASE", "FreightReleased event not found in contract logs");
  const f = released.fields as Record<string, unknown>;
  const eventProof: ReleaseEventProof = {
    eventName: released.name,
    tenderKey: String(f.tenderKey),
    winner: String(f.winner).toLowerCase(),
    amountAtomic: String(f.amount),
    authorizationHash: String(f.authorizationHash),
    fromDispute: Boolean(f.fromDispute),
    matchesPlan: false,
  };
  if (eventProof.tenderKey !== b.tenderKey) {
    die("RELEASE", "FreightReleased tenderKey mismatch");
  }
  if (eventProof.amountAtomic !== EXPECTED_LOCKED_ATOMIC) {
    die("RELEASE", "FreightReleased amount mismatch");
  }
  if (eventProof.authorizationHash !== b.authorizationHash) {
    die("RELEASE", "FreightReleased authorization hash mismatch");
  }
  if (eventProof.fromDispute !== false) {
    die("RELEASE", "FreightReleased reports a dispute-path settlement");
  }
  if (eventProof.winner !== b.carrierEvmAddress) {
    die(
      "RELEASE",
      "FreightReleased winner is not the EVM address bound by the Phase C2 allocation",
    );
  }
  eventProof.matchesPlan = true;
  progress.releaseEvent = eventProof;

  progress.transactions.release_full = {
    ...record,
    mirrorTransactionId: mirror.mirrorTransactionId,
    consensusTimestamp: mirror.consensusTimestamp,
    result: mirror.result,
    mirrorStatus: mirror.mirrorStatus,
  };
  saveProgress(progress);
  console.log(
    `RELEASE_MIRROR_OK carrier=+${EXPECTED_LOCKED_ATOMIC} escrow=-${EXPECTED_LOCKED_ATOMIC} event=FreightReleased`,
  );
}

async function submitEnvelope(
  client: Client,
  progress: Progress,
  budget: WriteBudget,
  step: StepName,
  envelope: HcsV2Envelope,
  expectedSequence: number,
): Promise<void> {
  if (progress.completedSteps.includes(step)) {
    console.log(`SKIP ${step} (sequence ${progress.transactions[step]?.sequenceNumber})`);
    return;
  }
  const body = serializeHcsV2Envelope(envelope);
  const byteLength = utf8ByteLength(body);
  if (byteLength >= HCS_V2_MAX_MESSAGE_BYTES) {
    die("MESSAGE_SIZE", `${step} envelope is ${byteLength} bytes (limit < 1024)`);
  }
  const bytes = Buffer.from(body, "utf8");
  const localSha = sha256Hex(bytes);

  if (isDryPreflight()) {
    console.log(
      `DRY ${envelope.messageType} bytes=${byteLength} payloadHash=${envelope.payloadHash} (not submitted)`,
    );
    return;
  }
  budget.assertCanWrite(1);

  const response = await new TopicMessageSubmitTransaction()
    .setTopicId(TopicId.fromString(progress.bindings.topicId))
    .setMessage(bytes)
    .setMaxTransactionFee(new Hbar(5))
    .execute(client);
  const transactionId = response.transactionId.toString();
  const receipt = await response.getReceipt(client);
  if (receipt.status !== Status.Success) {
    die("SUBMIT", `${step} status ${receipt.status.toString()}`);
  }
  const sequenceNumber = receipt.topicSequenceNumber
    ? Number(receipt.topicSequenceNumber.toString())
    : null;
  if (!sequenceNumber) die("SUBMIT", `${step} receipt is missing a sequence number`);

  budget.recordSuccess(step, transactionId);
  progress.envelopes[step] = envelope;
  progress.transactions[step] = {
    step,
    kind: "HCS_MESSAGE",
    messageType: envelope.messageType,
    transactionId,
    mirrorTransactionId: toMirrorTransactionId(transactionId),
    consensusTimestamp: null,
    result: null,
    hashScanUrl: hashScanTransactionUrl(transactionId),
    mirrorStatus: "PENDING",
    sequenceNumber,
    messageBytes: byteLength,
    localMessageSha256: localSha,
    mirrorMessageSha256: null,
    bytesMatch: false,
    payloadHash: envelope.payloadHash,
  };
  markStep(progress, step, budget);
  if (sequenceNumber !== expectedSequence) {
    die("SEQUENCE", `${step} landed at sequence ${sequenceNumber}, expected ${expectedSequence}`);
  }
  console.log(
    `${envelope.messageType}_OK seq=${sequenceNumber} bytes=${byteLength} tx=${transactionId}`,
  );
}

async function verifyMessageOnMirror(progress: Progress, step: StepName): Promise<void> {
  const record = progress.transactions[step];
  if (!record) die("MIRROR", `${step} transaction not recorded`);
  if (record.mirrorStatus === "SUCCESS" && record.bytesMatch) return;

  const mirror = await mirrorVerifyTransaction(record.transactionId);
  if (mirror.mirrorStatus !== "SUCCESS") {
    die("MIRROR", `${step} mirror status ${mirror.mirrorStatus}`);
  }
  const message = await mirrorTopicMessage(
    progress.bindings.topicId,
    record.sequenceNumber!,
  );
  if (!message.bytes) die("MIRROR", `${step} message not retrievable from Mirror Node`);
  const mirrorSha = sha256Hex(message.bytes);
  if (mirrorSha !== record.localMessageSha256) {
    die("MIRROR", `${step} Mirror message bytes do not match the local envelope`);
  }
  if (message.sequenceNumber !== record.sequenceNumber) {
    die("MIRROR", `${step} Mirror sequence number mismatch`);
  }
  progress.transactions[step] = {
    ...record,
    mirrorTransactionId: mirror.mirrorTransactionId,
    consensusTimestamp: message.consensusTimestamp ?? mirror.consensusTimestamp,
    result: mirror.result,
    mirrorStatus: mirror.mirrorStatus,
    mirrorMessageSha256: mirrorSha,
    bytesMatch: true,
  };
  saveProgress(progress);
  console.log(`MIRROR_OK ${record.messageType} seq=${record.sequenceNumber} bytes match=YES`);
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

const CLAIM_LABELS = {
  X402_ACCESS_PAYMENTS_REAL: "YES",
  HTS_USDC_FREIGHT_ESCROW_REAL: "YES",
  MAX_SYNTHETIC_BUDGET_FUNDED: "YES",
  WINNING_AMOUNT_LOCKED_AND_EXCESS_REFUNDED: "YES",
  POD_SYNTHETIC: "YES",
  POD_ENCRYPTED_AND_SIGNED: "YES",
  POD_AND_ACCEPTANCE_ANCHORED_ON_HCS: "YES",
  SHIPPER_ACCEPTANCE_CAUSED_RELEASE: "YES",
  CARRIER_RECEIVED_750000_ATOMIC_TESTNET_USDC: "YES",
  EVIDENCE_SEQUENCE_ORDERED_ON_HEDERA: "YES",
  ADVISER_NON_BINDING: "YES",
  LIVE_AI_MODEL: "NO",
  LIVE_PHYSICAL_DELIVERY: "NO",
  REAL_COMMERCIAL_FREIGHT: "NO",
  NETWORK: "hedera:testnet",
} as const;

function writeEvidencePackage(
  progress: Progress,
  preflight: Record<string, unknown>,
  acceptance: AcceptanceProof,
  fullSequence: TopicMessageRow[],
): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const b = progress.bindings;
  const tx = progress.transactions;
  const before = progress.balancesBefore!;
  const after = progress.balancesAfter!;

  const carrierDelta = (
    BigInt(after.carrierUsdcAtomic) - BigInt(before.carrierUsdcAtomic)
  ).toString();
  const shipperDelta = (
    BigInt(after.shipperUsdcAtomic) - BigInt(before.shipperUsdcAtomic)
  ).toString();
  const contractDelta = (
    BigInt(after.contractUsdcAtomic) - BigInt(before.contractUsdcAtomic)
  ).toString();

  writeJson(path.join(EVIDENCE_DIR, "preflight.json"), preflight);

  writeJson(path.join(EVIDENCE_DIR, "release-transaction.json"), {
    runId: progress.runId,
    contractId: b.contractId,
    contractEvmAddress: b.contractEvmAddress,
    contractFunction: "releaseFull",
    functionSignature: "releaseFull(bytes32,bytes32)",
    tenderId: b.tenderId,
    tenderVersion: b.tenderVersion,
    tenderKey: b.tenderKey,
    authorizationHash: b.authorizationHash,
    releasePlanHash: b.releasePlanHash,
    podId: b.podId,
    podVersion: b.podVersion,
    tokenId: b.tokenId,
    releasedAmountAtomic: EXPECTED_LOCKED_ATOMIC,
    releasedAmountUsdc: "0.75",
    winnerAccountId: b.carrierAccountId,
    transaction: tx.release_full ?? null,
    freightReleasedEvent: progress.releaseEvent,
    duplicateReleaseImpossible: true,
    duplicateReleaseReason:
      "authorizationHashUsed(authorizationHash) is now true and RELEASED is a terminal state",
    generatedAt,
  });

  writeJson(path.join(EVIDENCE_DIR, "balance-reconciliation.json"), {
    runId: progress.runId,
    tokenId: b.tokenId,
    before,
    after,
    deltas: {
      carrierUsdcAtomic: carrierDelta,
      shipperUsdcAtomic: shipperDelta,
      escrowContractUsdcAtomic: contractDelta,
    },
    expected: {
      carrierUsdcAtomic: EXPECTED_LOCKED_ATOMIC,
      shipperUsdcAtomic: "0",
      escrowContractUsdcAtomic: `-${EXPECTED_LOCKED_ATOMIC}`,
    },
    conservationOk:
      carrierDelta === EXPECTED_LOCKED_ATOMIC &&
      contractDelta === `-${EXPECTED_LOCKED_ATOMIC}` &&
      shipperDelta === "0",
    remainingLockedBalanceAtomic: progress.contractAfter?.tenderBalanceAtomic ?? null,
    generatedAt,
  });

  writeJson(path.join(EVIDENCE_DIR, "escrow-released-hcs.json"), {
    runId: progress.runId,
    topicId: b.topicId,
    expectedSequence: EXPECTED_RELEASE_SEQUENCE,
    envelope: progress.envelopes.escrow_released ?? null,
    transaction: tx.escrow_released ?? null,
    boundContext: {
      tenderId: b.tenderId,
      tenderVersion: b.tenderVersion,
      tenderKey: b.tenderKey,
      podId: b.podId,
      podVersion: b.podVersion,
      contractId: b.contractId,
      tokenId: b.tokenId,
      authorizationHash: b.authorizationHash,
      releasePlanHash: b.releasePlanHash,
      releaseTransactionId: tx.release_full?.transactionId ?? null,
      releasedAmountAtomic: EXPECTED_LOCKED_ATOMIC,
      winnerAccountId: b.carrierAccountId,
    },
    rawSignaturesPublished: false,
    podContentsPublished: false,
    generatedAt,
  });

  writeJson(path.join(EVIDENCE_DIR, "tender-completed-hcs.json"), {
    runId: progress.runId,
    topicId: b.topicId,
    expectedSequence: EXPECTED_COMPLETION_SEQUENCE,
    envelope: progress.envelopes.tender_completed ?? null,
    transaction: tx.tender_completed ?? null,
    boundContext: {
      tenderId: b.tenderId,
      tenderVersion: b.tenderVersion,
      hcsFinalState: "PAYMENT_RELEASED",
      escrowContractFinalState: "RELEASED",
      completedFreightAmountAtomic: EXPECTED_LOCKED_ATOMIC,
      releaseTransactionId: tx.release_full?.transactionId ?? null,
      precedingEscrowReleasedSequence: tx.escrow_released?.sequenceNumber ?? null,
      evidenceChainHash: progress.evidenceChainHash,
      completionRef: progress.completionRef,
      syntheticBusinessData: true,
    },
    generatedAt,
  });

  const sequences = fullSequence.map((m) => ({
    sequenceNumber: m.sequenceNumber,
    messageType: m.messageType,
    tenderId: m.tenderId,
    consensusTimestamp: m.consensusTimestamp,
    payloadHash: m.payloadHash,
    messageSha256: m.sha256,
  }));
  const expectedOrder = [
    "POD_SUBMITTED",
    "POD_ADVISORY_ANCHORED",
    "POD_REVIEW_ACTION",
    "ESCROW_RELEASED",
    "TENDER_COMPLETED",
  ];
  writeJson(path.join(EVIDENCE_DIR, "hcs-complete-sequence.json"), {
    runId: progress.runId,
    topicId: b.topicId,
    tenderId: b.tenderId,
    messages: sequences,
    expectedOrder,
    orderingCorrect:
      sequences.length === 5 &&
      sequences.every((m, i) => m.sequenceNumber === i + 1 && m.messageType === expectedOrder[i]),
    allSameTopic: true,
    allSameTender: sequences.every((m) => m.tenderId === b.tenderId),
    phaseD2Sequences: [1, 2, 3],
    phaseE1Sequences: [EXPECTED_RELEASE_SEQUENCE, EXPECTED_COMPLETION_SEQUENCE],
    generatedAt,
  });

  writeJson(path.join(EVIDENCE_DIR, "contract-final-state.json"), {
    runId: progress.runId,
    before: progress.contractBefore,
    after: progress.contractAfter,
    finalState: progress.contractAfter?.state ?? null,
    tenderLockedBalanceAtomic: progress.contractAfter?.tenderBalanceAtomic ?? null,
    totalEscrowedAtomic: progress.contractAfter?.totalEscrowedAtomic ?? null,
    authorizationHashUsed: progress.contractAfter?.releaseAuthorizationHashUsed ?? null,
    terminalState: true,
    disputeOpened: false,
    refundIssued: false,
    partialReleaseIssued: false,
    readMethod: "Mirror Node contracts/call (free, no query payment)",
    generatedAt,
  });

  const rows = (["release_full", ...HCS_STEPS] as StepName[]).map((step) => ({
    step,
    kind: tx[step]?.kind ?? null,
    messageType: tx[step]?.messageType ?? null,
    transactionId: tx[step]?.transactionId ?? null,
    mirrorTransactionId: tx[step]?.mirrorTransactionId ?? null,
    mirrorStatus: tx[step]?.mirrorStatus ?? null,
    consensusTimestamp: tx[step]?.consensusTimestamp ?? null,
    sequenceNumber: tx[step]?.sequenceNumber ?? null,
    localMessageSha256: tx[step]?.localMessageSha256 ?? null,
    mirrorMessageSha256: tx[step]?.mirrorMessageSha256 ?? null,
    bytesMatch: tx[step]?.bytesMatch ?? null,
    hashScanUrl: tx[step]?.hashScanUrl ?? null,
  }));
  const txIds = rows.map((r) => r.transactionId).filter(Boolean) as string[];
  writeJson(path.join(EVIDENCE_DIR, "mirror-verification.json"), {
    runId: progress.runId,
    network: progress.network,
    mirrorNode: HEDERA_TESTNET_MIRROR_NODE,
    rows,
    allSuccess: rows.every((r) => r.mirrorStatus === "SUCCESS"),
    uniqueTransactionIds: new Set(txIds).size === txIds.length,
    messageBytesMatchLocalEnvelopes: HCS_STEPS.every((s) => tx[s]?.bytesMatch === true),
    tokenTransferVerified: true,
    freightReleasedEventVerified: progress.releaseEvent?.matchesPlan === true,
    contractStateVerified: progress.contractAfter?.state === "RELEASED",
    generatedAt,
  });

  writeJson(path.join(EVIDENCE_DIR, "run-summary.json"), {
    status: "SUCCESS",
    runId: progress.runId,
    phase: "E1",
    completedAt: generatedAt,
    network: progress.network,
    labels: CLAIM_LABELS,
    lineage: {
      accessRunId: b.accessRunId,
      escrowRunId: b.escrowRunId,
      podRunId: b.podRunId,
      releaseRunId: progress.runId,
      evidenceChainHash: progress.evidenceChainHash,
    },
    tender: {
      tenderId: b.tenderId,
      tenderVersion: b.tenderVersion,
      tenderKey: b.tenderKey,
      podId: b.podId,
      podVersion: b.podVersion,
      shipperAccountId: b.shipperAccountId,
      carrierAccountId: b.carrierAccountId,
      tokenId: b.tokenId,
    },
    acceptance,
    release: {
      transactionId: tx.release_full?.transactionId ?? null,
      consensusTimestamp: tx.release_full?.consensusTimestamp ?? null,
      hashScanUrl: tx.release_full?.hashScanUrl ?? null,
      authorizationHash: b.authorizationHash,
      releasePlanHash: b.releasePlanHash,
      releasedAmountAtomic: EXPECTED_LOCKED_ATOMIC,
      releasedAmountUsdc: "0.75",
      carrierBalanceDeltaAtomic: carrierDelta,
      shipperBalanceDeltaAtomic: shipperDelta,
      escrowContractBalanceDeltaAtomic: contractDelta,
      contractFinalState: progress.contractAfter?.state ?? null,
      contractLockedBalanceAtomic: progress.contractAfter?.tenderBalanceAtomic ?? null,
      authorizationHashUsed: progress.contractAfter?.releaseAuthorizationHashUsed ?? null,
    },
    hcs: {
      topicId: b.topicId,
      messages: HCS_STEPS.map((step) => ({
        messageType: tx[step]?.messageType ?? null,
        transactionId: tx[step]?.transactionId ?? null,
        sequenceNumber: tx[step]?.sequenceNumber ?? null,
        consensusTimestamp: tx[step]?.consensusTimestamp ?? null,
        payloadHash: tx[step]?.payloadHash ?? null,
        hashScanUrl: tx[step]?.hashScanUrl ?? null,
      })),
      completeSequence: sequences,
    },
    writeCounts: {
      CONTRACT_WRITES: 1,
      HCS_MESSAGE_WRITES: 2,
      X402_WRITES: 0,
      OTHER_STATE_CHANGING_WRITES: 0,
      STATE_CHANGING_NETWORK_WRITES: progress.successfulWrites,
      QUERY_PAYMENT_TRANSACTIONS: progress.queryPaymentTransactions,
      queryPaymentNote:
        "All escrow state reads use the free Mirror Node contracts/call endpoint, " +
        "so this phase bills no Hedera query payment. Counted, not assumed.",
    },
    claims: {
      x402AccessPaymentsWereRealTestnetTransactions: true,
      htsUsdcFreightEscrowWasReal: true,
      maximumSyntheticFreightBudgetFunded: true,
      winningAmountLockedAndExcessRefunded: true,
      podWasSyntheticEncryptedAndSigned: true,
      podIntegrityAndAcceptanceAnchoredOnHcs: true,
      shipperAcceptanceCausedTheRealRelease: true,
      carrierReceivedExactly750000AtomicTestnetUsdc: true,
      evidenceSequenceOrderedOnHedera: true,
      deterministicAdviserWasNonBinding: true,
      liveAiModelInvoked: false,
      physicalDeliveryProven: false,
      realWorldCommercialFreightClaimed: false,
    },
    nextPhase: "F",
  });

  const t = (s: StepName) => tx[s]?.transactionId ?? "NONE";
  const readme = `# RouteGuard v2 Phase E1 — live freight settlement (Hedera testnet)

**Status:** SUCCESS
**Run ID:** \`${progress.runId}\`
**Date:** ${generatedAt.slice(0, 10)}
**State-changing network writes:** ${progress.successfulWrites} (1 contract call + 2 HCS messages)

## What happened

The signed Phase D2 shipper acceptance was re-verified, its prepared
\`releaseFull\` plan was executed once against the live escrow, and the locked
freight principal moved to the winning carrier. The release and completion were
then anchored to the same HCS topic that already carried the POD evidence.

| Step | Value |
|---|---|
| \`releaseFull\` tx | \`${t("release_full")}\` |
| Released | **750,000 atomic USDC (0.75 USDC)** of token \`${b.tokenId}\` |
| From | escrow contract \`${b.contractId}\` |
| To | carrier \`${b.carrierAccountId}\` |
| Authorization hash | \`${b.authorizationHash}\` |
| Contract final state | \`${progress.contractAfter?.state}\` |
| Remaining locked balance | **${progress.contractAfter?.tenderBalanceAtomic}** |

## Balance reconciliation (token \`${b.tokenId}\`)

| Account | Before | After | Delta |
|---|---|---|---|
| Carrier \`${b.carrierAccountId}\` | ${before.carrierUsdcAtomic} | ${after.carrierUsdcAtomic} | **+${carrierDelta}** |
| Escrow \`${b.contractId}\` | ${before.contractUsdcAtomic} | ${after.contractUsdcAtomic} | **${contractDelta}** |
| Shipper \`${b.shipperAccountId}\` | ${before.shipperUsdcAtomic} | ${after.shipperUsdcAtomic} | ${shipperDelta} |

## Complete HCS evidence chain — topic \`${b.topicId}\`

| Seq | Message | Phase |
|---|---|---|
${fullSequence
  .map(
    (m) =>
      `| ${m.sequenceNumber} | \`${m.messageType}\` | ${m.sequenceNumber <= 3 ? "D2" : "E1"} |`,
  )
  .join("\n")}

| Message | Transaction ID |
|---|---|
| \`ESCROW_RELEASED\` | \`${t("escrow_released")}\` |
| \`TENDER_COMPLETED\` | \`${t("tender_completed")}\` |

Evidence-chain hash: \`${progress.evidenceChainHash}\`

## Truthful final claim

- The x402 access payments were **real Hedera testnet transactions**.
- The HTS USDC freight escrow was **real**.
- The maximum **synthetic** freight budget was funded (1.00 USDC).
- The winning amount was locked (0.75) and the excess refunded (0.25).
- The POD was **synthetic**, encrypted, and cryptographically signed.
- POD integrity and shipper acceptance were **anchored through HCS**.
- The shipper acceptance **caused the real escrowed freight amount to be
  released**.
- The winning carrier received **exactly 750,000 atomic testnet USDC**.
- The complete evidence sequence is **ordered on Hedera** (sequences 1–5).
- The deterministic adviser was **non-binding** and is not a live AI model.
- **No physical delivery and no real-world commercial freight is claimed.**

## Ledger footprint

| Kind | Count |
|---|---|
| Contract state-changing calls | 1 |
| HCS message submissions | 2 |
| x402 payments | 0 |
| Other state-changing writes | 0 |
| Hedera query-payment \`CRYPTOTRANSFER\`s | ${progress.queryPaymentTransactions} |

All escrow state verification used the free Mirror Node \`contracts/call\`
endpoint.

## Envelope-shape note

\`ESCROW_RELEASED\` and \`TENDER_COMPLETED\` use the **unchanged closed Phase A
\`routeguard-hcs-2.0\` payload shapes**. Additional public-safe context (tender
key, POD identity, authorization and release-plan hashes, contract id, evidence
chain) is recorded in this directory and bound into the anchored
\`completionRef\` evidence-chain hash rather than widening an accepted schema.

## Next step

**Phase F** — production website integration, Judge Mode, deployment, and the
submission package.
`;
  writeFileSync(path.join(EVIDENCE_DIR, "README.md"), readme, "utf8");
}

function assertNoPrivateDataInEvidence(): void {
  const banned = [
    "%PDF-",
    '"contentBase64"',
    '"carrierSignature"',
    '"shipperSignature"',
    '"wrappedKeyB64"',
    ["BEGIN", "PRIVATE", "KEY"].join(" "),
    "ROUTEGUARD_POD_MASTER_KEY_BASE64=",
  ];
  const rawSignatureRe = /(?<![0-9a-fA-F])[0-9a-fA-F]{128}(?![0-9a-fA-F])/;
  for (const name of readdirSync(EVIDENCE_DIR)) {
    const text = readFileSync(path.join(EVIDENCE_DIR, name), "utf8");
    for (const marker of banned) {
      if (text.includes(marker)) {
        die("EVIDENCE_LEAK", `evidence file ${name} contains "${marker}"`);
      }
    }
    if (rawSignatureRe.test(text)) {
      die("EVIDENCE_LEAK", `evidence file ${name} contains raw signature-length hex`);
    }
  }
  for (const p of dirtyPaths()) {
    if (p.startsWith("data/")) die("GIT_LEAK", `runtime data path is tracked by git: ${p}`);
  }
  console.log("EVIDENCE_PRIVACY=PASS");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== RouteGuard v2 Phase E1 live freight settlement ===");
  publicReportEnv();

  if (process.env[CONFIRM_ENV]?.trim() !== CONFIRM_VALUE) {
    die("GUARD", `${CONFIRM_ENV} must be exactly ${CONFIRM_VALUE}`);
  }
  if (process.env[MAX_WRITES_ENV]?.trim() !== String(MAX_WRITES)) {
    die("GUARD", `${MAX_WRITES_ENV} must be exactly ${MAX_WRITES}`);
  }
  if (process.env.ENABLE_LIVE_HEDERA !== "true") {
    die("GUARD", "ENABLE_LIVE_HEDERA must be true");
  }
  const network = process.env.HEDERA_NETWORK?.trim() || REQUIRED_NETWORK;
  if (network !== REQUIRED_NETWORK) {
    die("NETWORK", `network must be ${REQUIRED_NETWORK}, got ${network}`);
  }
  const tokenEnv = process.env.USDC_TOKEN_ID?.trim() || REQUIRED_TOKEN;
  if (tokenEnv !== REQUIRED_TOKEN) die("TOKEN", `token must be ${REQUIRED_TOKEN}`);

  assertBranch();
  assertWorkingTreeGuard();
  assertImmutableEvidenceUnchanged();

  if (PROJECTED_WRITES > MAX_WRITES) {
    die("WRITE_CAP", `projected ${PROJECTED_WRITES} exceeds ceiling ${MAX_WRITES}`);
  }
  console.log(
    `PROJECTED_WRITES contract=1 hcs=2 total=${PROJECTED_WRITES} cap=${MAX_WRITES}`,
  );

  const priorProgress = readJson<Progress>(PROGRESS_PATH);
  const existingSummary = readJson<{ status?: string; runId?: string }>(
    path.join(EVIDENCE_DIR, "run-summary.json"),
  );
  if (
    existingSummary?.status === "SUCCESS" &&
    (!priorProgress || priorProgress.runId !== existingSummary.runId)
  ) {
    die("ALREADY_DONE", "a successful Phase E evidence package already exists");
  }

  // ---- Bindings from immutable evidence ----
  const bindings = readBindings();
  console.log(
    `BINDINGS contract=${bindings.contractId} topic=${bindings.topicId} tender=${bindings.tenderId} pod=${bindings.podId} auth=${bindings.authorizationHash}`,
  );

  // ---- Keys / accounts ----
  if (!present("SHIPPER_PRIVATE_KEY")) die("ENV_MISSING", "SHIPPER_PRIVATE_KEY required");
  const shipperKey = parseEcdsaKey("SHIPPER_PRIVATE_KEY", requireEnv("SHIPPER_PRIVATE_KEY"));
  const operatorAccountId = present("OPERATOR_ACCOUNT_ID")
    ? requireEnv("OPERATOR_ACCOUNT_ID")
    : requireEnv("SHIPPER_ACCOUNT_ID");
  const operatorKey = present("OPERATOR_PRIVATE_KEY")
    ? parseEcdsaKey("OPERATOR_PRIVATE_KEY", requireEnv("OPERATOR_PRIVATE_KEY"))
    : shipperKey;
  if (requireEnv("SHIPPER_ACCOUNT_ID") !== bindings.shipperAccountId) {
    die("ACCOUNT", "configured shipper does not match the live escrow shipper");
  }
  const configuredCarrier = present("FINAL_DEMO_CARRIER_ALPHA_ACCOUNT_ID")
    ? requireEnv("FINAL_DEMO_CARRIER_ALPHA_ACCOUNT_ID")
    : requireEnv("CARRIER_ACCOUNT_ID");
  if (configuredCarrier !== bindings.carrierAccountId) {
    die("ACCOUNT", "configured carrier differs from the Phase C allocation winner");
  }
  console.log("SECRETS shipperKey=PRESENT operatorKey=PRESENT");

  // ---- Focused tests ----
  console.log("PREFLIGHT_FOCUSED_TESTS...");
  try {
    execFileSync(
      "npx",
      [
        "vitest",
        "run",
        "test/v2-escrow-boundary.test.ts",
        "test/v2-authorization-signatures.test.ts",
        "test/v2-pod-workflow.test.ts",
        "test/v2-referee-resolution-binding.test.ts",
      ],
      { stdio: "inherit", shell: true },
    );
  } catch {
    die("TESTS", "focused escrow / authorization / POD tests failed");
  }
  console.log("PREFLIGHT_FOCUSED_TESTS=PASS");

  // ---- Durable lifecycle + acceptance re-verification ----
  const lifecycle = new LifecycleService(new FileLifecycleStore(LIFECYCLE_DIR));
  const record = await lifecycle.get(bindings.tenderId);
  if (!record) die("LIFECYCLE", "Phase D2 durable lifecycle record not found");
  if (record.state !== "POD_ACCEPTED" && record.state !== "PAYMENT_RELEASED" &&
      record.state !== "TENDER_COMPLETED") {
    die("LIFECYCLE", `unexpected lifecycle state ${record.state}`);
  }
  const durableAccept = record.processedActions[bindings.acceptanceActionId] ?? null;
  if (!durableAccept) die("LIFECYCLE", "acceptance action not present in the durable record");
  const acceptanceProof = reverifyShipperAcceptance(
    bindings,
    record,
    durableAccept,
    shipperKey,
  );
  console.log("SHIPPER_ACCEPTANCE_REVERIFIED=PASS");

  // ---- Release plan re-verification against the production builder ----
  const rebuilt = buildBoundReleaseFullPlan({
    tenderId: bindings.tenderId,
    tenderVersion: bindings.tenderVersion,
    tenderKey: bindings.tenderKey,
    podId: bindings.podId,
    podVersion: bindings.podVersion,
    lockedAmountAtomic: bindings.lockedAmountAtomic,
    authorizationHash: bindings.authorizationHash,
    contractId: bindings.contractId,
    contractEvmAddress: bindings.contractEvmAddress,
    requirePhaseC2LiveBindings: true,
  });
  const rebuiltPlanHash = canonicalSha256({
    contractId: rebuilt.contractId,
    contractEvmAddress: rebuilt.contractEvmAddress,
    tenderKey: rebuilt.tenderKey,
    lockedAmountAtomic: rebuilt.lockedAmountAtomic,
    authorizationHash: rebuilt.authorizationHash,
    functionSignature: rebuilt.plan.functionSignature,
    args: rebuilt.plan.args,
  });
  if (rebuiltPlanHash !== bindings.releasePlanHash) {
    die("RELEASE_PLAN", "rebuilt release plan hash differs from the Phase D2 plan");
  }
  if (rebuilt.plan.gasLimit !== bindings.gasLimit) {
    die("RELEASE_PLAN", "rebuilt release plan gas limit differs");
  }
  console.log(`RELEASE_PLAN_REVERIFIED=PASS planHash=${rebuiltPlanHash}`);

  // ---- Live escrow state (free reads) ----
  // A resumed run may legitimately observe the post-release state; the
  // pre-release preconditions only apply while releaseFull is still pending.
  const releaseAlreadyExecuted = Boolean(
    priorProgress?.completedSteps.includes("release_full"),
  );
  const contractBefore = await readContractSnapshot(bindings, bindings.authorizationHash);
  if (releaseAlreadyExecuted) {
    if (contractBefore.state !== "RELEASED") {
      die("ESCROW_STATE", `resumed run expects RELEASED, saw ${contractBefore.state}`);
    }
    if (contractBefore.tenderBalanceAtomic !== "0") {
      die("ESCROW_STATE", "resumed run expects a zero locked balance");
    }
    if (contractBefore.releaseAuthorizationHashUsed !== true) {
      die("ESCROW_STATE", "resumed run expects the authorization hash to be consumed");
    }
    console.log(
      `CONTRACT_STATE_RESUMED state=${contractBefore.state} locked=${contractBefore.tenderBalanceAtomic} authUsed=true`,
    );
  } else {
    if (contractBefore.state !== "ALLOCATED") {
      die("ESCROW_STATE", `contract state ${contractBefore.state} !== ALLOCATED`);
    }
    if (contractBefore.tenderBalanceAtomic !== EXPECTED_LOCKED_ATOMIC) {
      die("ESCROW_STATE", `locked amount ${contractBefore.tenderBalanceAtomic} !== 750000`);
    }
    if (contractBefore.releaseAuthorizationHashUsed !== false) {
      die("ESCROW_STATE", "release authorization hash is already consumed on-chain");
    }
    console.log(
      `CONTRACT_STATE_BEFORE state=${contractBefore.state} locked=${contractBefore.tenderBalanceAtomic} authUsed=false`,
    );
  }

  const balancesBefore = await readBalances(bindings);
  console.log(
    `BALANCES carrier=${balancesBefore.carrierUsdcAtomic} escrow=${balancesBefore.contractUsdcAtomic} shipper=${balancesBefore.shipperUsdcAtomic}`,
  );
  if (!releaseAlreadyExecuted && balancesBefore.contractUsdcAtomic !== EXPECTED_LOCKED_ATOMIC) {
    die("BALANCE", "escrow contract USDC balance is not exactly the locked amount");
  }

  // The winner address bound at allocation must still resolve to the carrier.
  const carrierMirrorEvm = await accountEvmAddress(bindings.carrierAccountId);
  if (carrierMirrorEvm !== bindings.carrierEvmAddress) {
    die(
      "ACCOUNT",
      `carrier ${bindings.carrierAccountId} EVM address on Mirror does not match the allocation binding`,
    );
  }
  console.log(`CARRIER_EVM_BINDING=PASS ${bindings.carrierEvmAddress}`);

  const operatorTinybars = await accountHbar(operatorAccountId);
  console.log(`OPERATOR account=${operatorAccountId} hbar_tinybars=${operatorTinybars}`);
  if (operatorTinybars < MIN_OPERATOR_TINYBARS) {
    die("BALANCE", "operator HBAR insufficient for the release and two HCS writes");
  }

  // ---- Existing topic must already hold exactly the three Phase D2 messages ----
  const priorMessages = await listTopicMessages(bindings.topicId);
  if (priorMessages.length !== EXPECTED_PRIOR_SEQUENCES && priorMessages.length < 5) {
    die(
      "TOPIC",
      `topic ${bindings.topicId} holds ${priorMessages.length} messages, expected ${EXPECTED_PRIOR_SEQUENCES}`,
    );
  }
  for (const m of priorMessages.slice(0, 3)) {
    if (m.tenderId !== bindings.tenderId) {
      die("TOPIC", `topic message ${m.sequenceNumber} belongs to a different tender`);
    }
  }
  console.log(`TOPIC_PRIOR_MESSAGES=${priorMessages.length}`);

  // ---- Resume / identity ----
  mkdirSync(DATA_DIR, { recursive: true });
  let progress = priorProgress;
  if (progress && progress.schemaVersion !== PROGRESS_SCHEMA) {
    die("PROGRESS", "unsupported progress schema; refusing to continue");
  }
  if (progress?.status === "SUCCESS") {
    console.log(`ALREADY_SUCCESS runId=${progress.runId} — returning existing summary`);
    const full = await listTopicMessages(bindings.topicId);
    progress.contractAfter = await readContractSnapshot(bindings, bindings.authorizationHash);
    progress.queryPaymentTransactions = await countQueryPayments(progress);
    saveProgress(progress);
    writeEvidencePackage(
      progress,
      buildPreflightDoc(
        progress,
        acceptanceProof,
        progress.contractBefore ?? contractBefore,
        progress.balancesBefore ?? balancesBefore,
        operatorTinybars,
      ),
      acceptanceProof,
      full,
    );
    assertNoPrivateDataInEvidence();
    assertImmutableEvidenceUnchanged();
    printReturn(progress);
    return;
  }

  if (!progress || progress.status === "FAILED") {
    const now = new Date().toISOString();
    progress = {
      schemaVersion: PROGRESS_SCHEMA,
      runId: stableRunId(),
      status: "IN_PROGRESS",
      network: REQUIRED_NETWORK,
      bindings,
      operatorAccountId,
      projectedWrites: PROJECTED_WRITES,
      successfulWrites: 0,
      writeLog: [],
      completedSteps: [],
      transactions: {},
      envelopes: {},
      balancesBefore: null,
      balancesAfter: null,
      contractBefore: null,
      contractAfter: null,
      releaseEvent: null,
      evidenceChainHash: null,
      completionRef: null,
      queryPaymentTransactions: 0,
      createdAt: now,
      updatedAt: now,
    };
    saveProgress(progress);
  } else {
    if (progress.bindings.authorizationHash !== bindings.authorizationHash) {
      die("BINDING", "in-progress run is bound to a different authorization hash");
    }
    if (progress.bindings.tenderKey !== bindings.tenderKey) {
      die("BINDING", "in-progress run is bound to a different tender key");
    }
    if (progress.bindings.contractId !== bindings.contractId) {
      die("BINDING", "in-progress run is bound to a different escrow contract");
    }
    if (progress.bindings.topicId !== bindings.topicId) {
      die("BINDING", "in-progress run is bound to a different HCS topic");
    }
    // Source evidence is immutable and the identity above is asserted equal, so
    // refresh the snapshot to pick up any newly derived binding fields.
    progress.bindings = bindings;
    console.log(
      `RESUME runId=${progress.runId} completed=${progress.completedSteps.join(",") || "(none)"}`,
    );
  }
  // Never overwrite the genuine pre-release snapshot on a resumed run.
  progress.contractBefore = progress.contractBefore ?? contractBefore;
  progress.balancesBefore = progress.balancesBefore ?? balancesBefore;
  if (releaseAlreadyExecuted && !progress.balancesAfter) {
    progress.balancesAfter = balancesBefore;
  }
  saveProgress(progress);
  console.log(`LIVE_RUN_ID=${progress.runId}`);

  const preflightDoc = buildPreflightDoc(
    progress,
    acceptanceProof,
    contractBefore,
    balancesBefore,
    operatorTinybars,
  );
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeJson(path.join(EVIDENCE_DIR, "preflight.json"), preflightDoc);
  console.log("LIVE_PREFLIGHT=PASS");

  const client = Client.forTestnet();
  client.setOperator(AccountId.fromString(operatorAccountId), operatorKey);
  client.setDefaultMaxTransactionFee(new Hbar(20));

  const budget = new WriteBudget(MAX_WRITES);
  budget.successful = progress.writeLog.length;
  budget.log = [...progress.writeLog];
  console.log(`WRITE_BUDGET_RESUME successful=${budget.successful}/${MAX_WRITES}`);

  try {
    // ---- Write 1: releaseFull ----
    await stepReleaseFull(client, progress, budget);
    if (!isDryPreflight()) {
      await verifyReleaseOnMirror(progress);
      await sleep(2000);
      progress.balancesAfter = await readBalances(bindings);
      progress.contractAfter = await readContractSnapshot(
        bindings,
        bindings.authorizationHash,
      );
      saveProgress(progress);

      const carrierDelta =
        BigInt(progress.balancesAfter.carrierUsdcAtomic) -
        BigInt(progress.balancesBefore!.carrierUsdcAtomic);
      const contractDelta =
        BigInt(progress.balancesAfter.contractUsdcAtomic) -
        BigInt(progress.balancesBefore!.contractUsdcAtomic);
      const shipperDelta =
        BigInt(progress.balancesAfter.shipperUsdcAtomic) -
        BigInt(progress.balancesBefore!.shipperUsdcAtomic);
      if (carrierDelta !== BigInt(EXPECTED_LOCKED_ATOMIC)) {
        die("RELEASE", `carrier delta ${carrierDelta} !== ${EXPECTED_LOCKED_ATOMIC}`);
      }
      if (contractDelta !== -BigInt(EXPECTED_LOCKED_ATOMIC)) {
        die("RELEASE", `escrow delta ${contractDelta} !== -${EXPECTED_LOCKED_ATOMIC}`);
      }
      if (shipperDelta !== 0n) {
        die("RELEASE", `shipper delta ${shipperDelta} !== 0`);
      }
      if (progress.contractAfter.state !== "RELEASED") {
        die("RELEASE", `contract state ${progress.contractAfter.state} !== RELEASED`);
      }
      if (progress.contractAfter.tenderBalanceAtomic !== "0") {
        die("RELEASE", `tender locked balance ${progress.contractAfter.tenderBalanceAtomic} !== 0`);
      }
      if (progress.contractAfter.releaseAuthorizationHashUsed !== true) {
        die("RELEASE", "authorization hash is not marked used after release");
      }
      console.log(
        `RELEASE_VERIFIED carrier=+${carrierDelta} escrow=${contractDelta} state=${progress.contractAfter.state} locked=0 authUsed=true`,
      );

      // Durable lifecycle: POD_ACCEPTED -> PAYMENT_RELEASED
      const current = await lifecycle.get(bindings.tenderId);
      if (current?.state === "POD_ACCEPTED") {
        await lifecycle.apply(bindings.tenderId, {
          type: "ESCROW_RELEASE_CONFIRMED",
          actionId: `act-${progress.runId}-release`,
          eventTime: new Date().toISOString(),
          releaseTxId: progress.transactions.release_full!.transactionId,
          releaseAmountAtomic: EXPECTED_LOCKED_ATOMIC,
        });
      }
    }

    // ---- Write 2: ESCROW_RELEASED (sequence 4) ----
    let releasedEnvelope = progress.envelopes.escrow_released;
    if (!releasedEnvelope) {
      const releaseTxId = progress.transactions.release_full?.transactionId;
      if (!releaseTxId && !isDryPreflight()) {
        die("ESCROW_RELEASED", "release transaction id missing; refusing to anchor");
      }
      const lifecycleNow = (await lifecycle.get(bindings.tenderId))!;
      releasedEnvelope = buildHcsV2Envelope({
        messageType: "ESCROW_RELEASED",
        tenderId: bindings.tenderId,
        tenderVersion: bindings.tenderVersion,
        tenderHash: lifecycleNow.tenderHash,
        createdAt: lifecycleNow.updatedAt,
        payload: {
          // Dry mode has no release tx; the preview is validated but never
          // persisted, so a live run can never reuse a placeholder envelope.
          releaseTxId: releaseTxId ?? `${progress.operatorAccountId}@0.0`,
          amountAtomic: EXPECTED_LOCKED_ATOMIC,
          winnerAccount: bindings.carrierAccountId,
        },
      });
      if (!isDryPreflight()) {
        progress.envelopes.escrow_released = releasedEnvelope;
        saveProgress(progress);
      }
    }
    await submitEnvelope(
      client,
      progress,
      budget,
      "escrow_released",
      releasedEnvelope,
      EXPECTED_RELEASE_SEQUENCE,
    );
    if (!isDryPreflight()) await verifyMessageOnMirror(progress, "escrow_released");

    // ---- Evidence-chain hash (binds the whole lineage into the last message) ----
    if (!progress.evidenceChainHash || isDryPreflight()) {
      const chain = canonicalSha256({
        schema: "routeguard-v2-evidence-chain-1.0",
        accessRunId: bindings.accessRunId,
        escrowRunId: bindings.escrowRunId,
        podRunId: bindings.podRunId,
        releaseRunId: progress.runId,
        contractId: bindings.contractId,
        topicId: bindings.topicId,
        tenderId: bindings.tenderId,
        tenderVersion: bindings.tenderVersion,
        tenderKey: bindings.tenderKey,
        podId: bindings.podId,
        podVersion: bindings.podVersion,
        manifestHash: bindings.manifestHash,
        packageContentHash: bindings.packageContentHash,
        ciphertextHash: bindings.ciphertextHash,
        advisoryReportHash: bindings.advisoryReportHash,
        acceptanceAuthPayloadHash: bindings.acceptanceAuthPayloadHash,
        authorizationHash: bindings.authorizationHash,
        releasePlanHash: bindings.releasePlanHash,
        releaseTxId: progress.transactions.release_full?.transactionId ?? null,
        releasedAmountAtomic: EXPECTED_LOCKED_ATOMIC,
        podSequences: bindings.priorSequences,
        escrowReleasedSequence:
          progress.transactions.escrow_released?.sequenceNumber ?? EXPECTED_RELEASE_SEQUENCE,
      });
      // `completionRef` is a structured public id capped at 64 chars, so the
      // digest is carried without its `sha256:` prefix.
      if (isDryPreflight()) {
        // Preview only — a dry chain hash lacks the real release tx id.
        progress.evidenceChainHash = chain;
        progress.completionRef = chain.slice("sha256:".length);
      } else {
        progress.evidenceChainHash = chain;
        progress.completionRef = chain.slice("sha256:".length);
        saveProgress(progress);
      }
    }

    // ---- Write 3: TENDER_COMPLETED (sequence 5) ----
    let completedEnvelope = progress.envelopes.tender_completed;
    if (!completedEnvelope) {
      const current = await lifecycle.get(bindings.tenderId);
      if (!isDryPreflight() && current?.state === "PAYMENT_RELEASED") {
        await lifecycle.apply(bindings.tenderId, {
          type: "TENDER_COMPLETION_CONFIRMED",
          actionId: `act-${progress.runId}-complete`,
          eventTime: new Date().toISOString(),
        });
      }
      const lifecycleNow = (await lifecycle.get(bindings.tenderId))!;
      completedEnvelope = buildHcsV2Envelope({
        messageType: "TENDER_COMPLETED",
        tenderId: bindings.tenderId,
        tenderVersion: bindings.tenderVersion,
        tenderHash: lifecycleNow.tenderHash,
        createdAt: lifecycleNow.updatedAt,
        payload: {
          finalState: "PAYMENT_RELEASED",
          completionRef: progress.completionRef!,
        },
      });
      if (!isDryPreflight()) {
        progress.envelopes.tender_completed = completedEnvelope;
        saveProgress(progress);
      }
    }
    await submitEnvelope(
      client,
      progress,
      budget,
      "tender_completed",
      completedEnvelope,
      EXPECTED_COMPLETION_SEQUENCE,
    );
    if (!isDryPreflight()) await verifyMessageOnMirror(progress, "tender_completed");

    if (isDryPreflight()) {
      console.log("--- RESULT ---");
      console.log("LIVE_PREFLIGHT=PASS");
      console.log(`LIVE_RUN_ID=${progress.runId}`);
      console.log("SHIPPER_ACCEPTANCE_REVERIFIED=PASS");
      console.log("RELEASE_PLAN_REVERIFIED=PASS");
      console.log("DRY_PREFLIGHT=STOPPED_BEFORE_ANY_WRITE");
      console.log("STATE_CHANGING_NETWORK_WRITES=0");
      return;
    }

    // ---- Final ordering across the whole topic ----
    const fullSequence = await listTopicMessages(bindings.topicId);
    const expectedOrder = [
      "POD_SUBMITTED",
      "POD_ADVISORY_ANCHORED",
      "POD_REVIEW_ACTION",
      "ESCROW_RELEASED",
      "TENDER_COMPLETED",
    ];
    if (fullSequence.length !== 5) {
      die("ORDERING", `topic holds ${fullSequence.length} messages, expected 5`);
    }
    fullSequence.forEach((m, i) => {
      if (m.sequenceNumber !== i + 1 || m.messageType !== expectedOrder[i]) {
        die(
          "ORDERING",
          `sequence ${m.sequenceNumber} is ${m.messageType}, expected ${expectedOrder[i]} at ${i + 1}`,
        );
      }
      if (m.tenderId !== bindings.tenderId) {
        die("ORDERING", `sequence ${m.sequenceNumber} belongs to a different tender`);
      }
    });
    console.log("HCS_COMPLETE_ORDERING=PASS 1..5");

    if (budget.successful !== PROJECTED_WRITES) {
      die("WRITE_CAP", `expected exactly ${PROJECTED_WRITES} writes, got ${budget.successful}`);
    }

    progress.queryPaymentTransactions = await countQueryPayments(progress);
    progress.status = "SUCCESS";
    progress.successfulWrites = budget.successful;
    progress.writeLog = [...budget.log];
    saveProgress(progress);

    writeEvidencePackage(progress, preflightDoc, acceptanceProof, fullSequence);
    assertNoPrivateDataInEvidence();
    assertImmutableEvidenceUnchanged();
    printReturn(progress);
  } finally {
    client.close();
  }
}

function buildPreflightDoc(
  progress: Progress,
  acceptance: AcceptanceProof,
  contractBefore: ContractSnapshot,
  balancesBefore: Balances,
  operatorTinybars: bigint,
): Record<string, unknown> {
  const b = progress.bindings;
  return {
    runId: progress.runId,
    phase: "E1",
    branch: REQUIRED_BRANCH,
    network: REQUIRED_NETWORK,
    guards: {
      [CONFIRM_ENV]: "PRESENT_AND_EXACT",
      [MAX_WRITES_ENV]: String(MAX_WRITES),
      ENABLE_LIVE_HEDERA: "true",
    },
    secrets: {
      shipperSigningKey: "PRESENT",
      operatorSigningKey: "PRESENT",
    },
    bindings: b,
    acceptanceReverification: acceptance,
    releasePlanReverification: {
      rebuiltWithProductionBuilder: true,
      planHash: b.releasePlanHash,
      contractId: b.contractId,
      contractEvmAddress: b.contractEvmAddress,
      tenderKey: b.tenderKey,
      amountAtomic: b.lockedAmountAtomic,
      authorizationHash: b.authorizationHash,
      phaseC2LiveBindingsEnforced: true,
    },
    liveEscrowBefore: contractBefore,
    balancesBefore,
    operator: {
      accountId: progress.operatorAccountId,
      hbarTinybars: operatorTinybars.toString(),
      minimumRequiredTinybars: MIN_OPERATOR_TINYBARS.toString(),
      sufficient: operatorTinybars >= MIN_OPERATOR_TINYBARS,
    },
    focusedTests: "PASS",
    writePlan: [
      { index: 1, step: "release_full", kind: "ContractExecuteTransaction", fn: "releaseFull" },
      {
        index: 2,
        step: "escrow_released",
        kind: "TopicMessageSubmitTransaction",
        expectedSequence: EXPECTED_RELEASE_SEQUENCE,
      },
      {
        index: 3,
        step: "tender_completed",
        kind: "TopicMessageSubmitTransaction",
        expectedSequence: EXPECTED_COMPLETION_SEQUENCE,
      },
    ],
    projectedStateChangingWrites: PROJECTED_WRITES,
    x402Writes: 0,
    stateReadMethod: "Mirror Node contracts/call (free, no query payment)",
    generatedAt: new Date().toISOString(),
  };
}

function printReturn(progress: Progress): void {
  const tx = progress.transactions;
  const id = (s: StepName) => tx[s]?.transactionId ?? "NONE";
  const seq = (s: StepName) => tx[s]?.sequenceNumber ?? "NONE";
  const before = progress.balancesBefore;
  const after = progress.balancesAfter;
  const carrierDelta =
    before && after
      ? (BigInt(after.carrierUsdcAtomic) - BigInt(before.carrierUsdcAtomic)).toString()
      : "OTHER";

  console.log("--- RESULT ---");
  console.log("LIVE_PREFLIGHT=PASS");
  console.log(`LIVE_RUN_ID=${progress.runId}`);
  console.log("SHIPPER_ACCEPTANCE_REVERIFIED=PASS");
  console.log("RELEASE_PLAN_REVERIFIED=PASS");
  console.log(
    `RELEASE_FULL=${progress.completedSteps.includes("release_full") ? "PASS" : "FAIL"}`,
  );
  console.log(`RELEASE_TX=${id("release_full")}`);
  console.log(
    `RELEASE_MIRROR=${tx.release_full?.mirrorStatus === "SUCCESS" ? "PASS" : "FAIL"}`,
  );
  console.log(`RELEASED_AMOUNT_ATOMIC=${progress.releaseEvent?.amountAtomic ?? "OTHER"}`);
  console.log(`CARRIER_BALANCE_DELTA_ATOMIC=${carrierDelta}`);
  console.log(
    `CONTRACT_LOCKED_BALANCE_ATOMIC=${progress.contractAfter?.tenderBalanceAtomic ?? "OTHER"}`,
  );
  console.log(`CONTRACT_FINAL_STATE=${progress.contractAfter?.state ?? "OTHER"}`);
  console.log(
    `AUTHORIZATION_REPLAY_BLOCKED=${progress.contractAfter?.releaseAuthorizationHashUsed === true ? "PASS" : "FAIL"}`,
  );
  console.log(
    `ESCROW_RELEASED_HCS=${progress.completedSteps.includes("escrow_released") ? "PASS" : "FAIL"}`,
  );
  console.log(`ESCROW_RELEASED_TX=${id("escrow_released")}`);
  console.log(`ESCROW_RELEASED_SEQUENCE=${seq("escrow_released")}`);
  console.log(
    `TENDER_COMPLETED_HCS=${progress.completedSteps.includes("tender_completed") ? "PASS" : "FAIL"}`,
  );
  console.log(`TENDER_COMPLETED_TX=${id("tender_completed")}`);
  console.log(`TENDER_COMPLETED_SEQUENCE=${seq("tender_completed")}`);
  console.log("CONTRACT_WRITES=1");
  console.log(
    `HCS_MESSAGE_WRITES=${HCS_STEPS.filter((s) => progress.completedSteps.includes(s)).length}`,
  );
  console.log("X402_WRITES=0");
  console.log("OTHER_STATE_CHANGING_WRITES=0");
  console.log(`STATE_CHANGING_NETWORK_WRITES=${progress.successfulWrites}`);
  console.log(`QUERY_PAYMENT_TRANSACTIONS=${progress.queryPaymentTransactions}`);
  console.log("EVIDENCE_V2_RELEASE=PASS");
  console.log("PRIVATE_DATA_EXPOSED=NO");
  console.log(`NETWORK_WRITES=${progress.successfulWrites}`);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message.slice(0, 300) : "unknown error";
  console.error(`FAIL [UNCAUGHT]: ${msg}`);
  process.exit(1);
});
