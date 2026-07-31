/**
 * Phase D2 — guarded live Hedera testnet POD acceptance demonstration.
 *
 * Executes the already-tested Phase D1 encrypted-POD and signed shipper-review
 * workflow against real Hedera testnet HCS, while leaving the live Phase C2
 * freight escrow untouched (750,000 atomic USDC stays locked for Phase E).
 *
 * Exactly four successful network writes are authorized:
 *   1. TopicCreate  — dedicated RouteGuard v2 POD evidence topic
 *   2. TopicMessageSubmit — POD_SUBMITTED
 *   3. TopicMessageSubmit — POD_ADVISORY_ANCHORED
 *   4. TopicMessageSubmit — POD_REVIEW_ACTION (ACCEPT)
 *
 * No contract call, no x402 payment, no releaseFull, no dispute. Read-only
 * Mirror Node and ContractCallQuery verification only.
 *
 * Usage:
 *   ROUTEGUARD_LIVE_V2_POD_CONFIRM=I_UNDERSTAND_TESTNET_HCS_WRITES \
 *   ROUTEGUARD_LIVE_V2_POD_MAX_WRITES=4 \
 *   ENABLE_LIVE_HEDERA=true \
 *   npm run demo:v2-pod-live
 *
 * Never logs private keys, the POD master key, mnemonics, raw signature
 * material, env values, or decrypted POD documents.
 */

import "dotenv/config";

import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  Status,
  TopicCreateTransaction,
  TopicId,
  TopicMessageSubmitTransaction,
  type TransactionReceipt,
  type TransactionResponse,
} from "@hiero-ledger/sdk";

import { Interface } from "ethers";

import { canonicalSha256 } from "../src/domain/canonical-hash";
import { InMemoryCarrierRegistry } from "../src/domain/carrier";
import { isValidHederaAccountId } from "../src/domain/payment-option";
import { signCanonicalPayload } from "../src/domain/signature";
import {
  serializeHcsV2Envelope,
  utf8ByteLength,
} from "../src/hcs/v2/envelope";
import { HCS_V2_MAX_MESSAGE_BYTES, type HcsV2Envelope } from "../src/hcs/v2/types";
import { deriveAccessFeeAtomic } from "../src/v2/access/fee";
import {
  hashScanTransactionUrl,
  toMirrorTransactionId,
} from "../src/v2/access/mirror-reconcile";
import { tenderActivateResource } from "../src/v2/access/resource";
import {
  buildCarrierPodSubmissionSignPayload,
  buildShipperPodReviewSignPayload,
} from "../src/v2/auth/canonical";
import {
  verifyCarrierPodSubmission,
  verifyShipperPodReview,
} from "../src/v2/auth/verify";
import { escrowStateFromOrdinal } from "../src/v2/escrow/states";
import { escrowTenderKey } from "../src/v2/escrow/tender-key";
import type { LifecycleEvent } from "../src/v2/lifecycle/events";
import { trustPolicyFromRecord, type LifecycleRecord } from "../src/v2/lifecycle/record";
import {
  AesGcmMasterKeyProtector,
  decryptStoredRecord,
  FilePodEncryptedStore,
  parseMasterKeyBase64,
  PHASE_C2_ESCROW_CONTRACT_EVM,
  PHASE_C2_ESCROW_CONTRACT_ID,
  PHASE_C2_LOCKED_AMOUNT_ATOMIC,
  PodService,
  decodePlaintextPackage,
  type PodAdvisoryReport,
  type PodFileInput,
  type SignedPodPackage,
} from "../src/v2/pod";
import { createTrustPolicy } from "../src/v2/trust/policy";
import { LifecycleService } from "../src/v2/store/lifecycle-service";
import { FileLifecycleStore } from "../src/v2/store/lifecycle-store";
import {
  HEDERA_TESTNET_MIRROR_NODE,
  VERIFIED_USDC_TOKEN_ID,
} from "../src/x402/usdc-constants";

// ---------------------------------------------------------------------------
// Guards / constants
// ---------------------------------------------------------------------------

const CONFIRM_ENV = "ROUTEGUARD_LIVE_V2_POD_CONFIRM";
const CONFIRM_VALUE = "I_UNDERSTAND_TESTNET_HCS_WRITES";
const MAX_WRITES_ENV = "ROUTEGUARD_LIVE_V2_POD_MAX_WRITES";
const MAX_WRITES = 4;
const PROJECTED_WRITES = 4;

/**
 * Optional no-write rehearsal. Runs every guard, read-only query, and local
 * POD/crypto/signature step, then stops immediately before the first Hedera
 * write. Progress persists, so the live run resumes from the same run id.
 */
const DRY_PREFLIGHT_ENV = "ROUTEGUARD_LIVE_V2_POD_DRY_PREFLIGHT";

function isDryPreflight(): boolean {
  return process.env[DRY_PREFLIGHT_ENV] === "true";
}

const REQUIRED_BRANCH = "feat/routeguard-v2-phase-d";
const REQUIRED_NETWORK = "hedera:testnet";
const REQUIRED_TOKEN = VERIFIED_USDC_TOKEN_ID;

/** Immutable v1 evidence topic — must never be reused by Phase D2. */
const V1_IMMUTABLE_TOPIC_ID = "0.0.9794225";

const TOPIC_MEMO = "RouteGuard v2 POD evidence";

/** Minimum operator HBAR for one topic create + three message submits. */
const MIN_OPERATOR_TINYBARS = 500_000_000n; // 5 HBAR

const EVIDENCE_DIR = path.join("evidence", "v2", "pod");
const ESCROW_EVIDENCE_DIR = path.join("evidence", "v2", "escrow");
const ACCESS_EVIDENCE_DIR = path.join("evidence", "v2", "access");
const DATA_DIR = path.join("data", "v2-live-pod");
const PROGRESS_PATH = path.join(DATA_DIR, "progress.json");
const ADVISORY_PRIVATE_PATH = path.join(DATA_DIR, "advisory-report.private.json");
const POD_STORE_DIR = path.join("data", "v2-pods");
const LIFECYCLE_DIR = path.join(DATA_DIR, "lifecycle");

const PROGRESS_SCHEMA = "routeguard-v2-pod-live-1.0" as const;

const CARRIER_ID = "carrier-alpha";
const REFEREE_ID = "ref-human-1";

/** Facility code stands in for a delivery address — no personal data. */
const FACILITY_CODE = "DE-MUC-XDOCK-07";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StepName =
  | "topic_create"
  | "pod_submitted"
  | "pod_advisory"
  | "pod_review_action";

const MESSAGE_STEPS: readonly StepName[] = [
  "pod_submitted",
  "pod_advisory",
  "pod_review_action",
];

type HcsTxRecord = {
  step: StepName;
  messageType: string | null;
  transactionId: string;
  mirrorTransactionId: string;
  consensusTimestamp: string | null;
  result: string | null;
  hashScanUrl: string;
  mirrorStatus: "SUCCESS" | "FAILED" | "NOT_FOUND" | "PENDING";
  sequenceNumber: number | null;
  messageBytes: number | null;
  /** sha256 of the locally serialized canonical envelope bytes. */
  localMessageSha256: string | null;
  /** sha256 of the bytes Mirror Node returned for that sequence number. */
  mirrorMessageSha256: string | null;
  bytesMatch: boolean;
  payloadHash: string | null;
};

type PodProof = {
  podId: string;
  podVersion: number;
  manifestHash: string;
  packageContentHash: string;
  ciphertextHash: string;
  aadHash: string;
  encryptionAlg: string;
  wrapAlg: string;
  documentCount: number;
  totalPlaintextBytes: number;
  ciphertextBytes: number;
  plaintextEnvelopeBytes: number;
  storageSchema: string;
  storagePath: string;
  carrierSignatureVerified: boolean;
  carrierAuthPayloadHash: string;
  carrierKeyFingerprint: string;
  decryptRoundTripVerified: boolean;
  plaintextPersisted: false;
};

type AdvisorySummary = {
  reportId: string;
  reportHash: string;
  engine: string;
  binding: "NON_BINDING_ADVISORY";
  recommendation: string;
  findingCodes: readonly string[];
  findingSeverities: readonly string[];
  findingCodeHashes: readonly string[];
  createdAt: string;
  implementation: "DETERMINISTIC_STUB";
  liveAiModel: false;
};

type AcceptanceSummary = {
  actionId: string;
  action: "ACCEPT";
  signedAt: string;
  reviewDeadlineAt: string;
  shipperKeyFingerprint: string;
  authPayloadHash: string;
  reviewActionHash: string;
  signatureVerified: boolean;
  lifecycleStateBefore: string;
  lifecycleStateAfter: string;
};

type ReleasePlanSummary = {
  kind: "RELEASE_FULL";
  contractId: string;
  contractEvmAddress: string;
  tenderId: string;
  tenderVersion: number;
  tenderKey: string;
  lockedAmountAtomic: string;
  authorizationHash: string;
  contractFunction: string;
  functionSignature: string;
  signerRole: string;
  gasLimit: number;
  argTypes: readonly string[];
  planHash: string;
  submitted: false;
};

type Times = {
  base: string;
  fund: string;
  auctionEnds: string;
  close: string;
  winner: string;
  reserve: string;
  delivery: string;
  submit: string;
  reviewStart: string;
  accept: string;
};

type Progress = {
  schemaVersion: typeof PROGRESS_SCHEMA;
  runId: string;
  status: "IN_PROGRESS" | "SUCCESS" | "FAILED";
  network: string;
  tokenId: string;
  escrowRunId: string;
  contractId: string;
  contractEvmAddress: string;
  tenderId: string;
  tenderVersion: number;
  tenderKey: string;
  tenderHash: string;
  winningBidId: string;
  decisionManifestHash: string;
  operatorAccountId: string;
  shipperAccountId: string;
  carrierAccountId: string;
  budgetAtomic: string;
  winningAtomic: string;
  excessAtomic: string;
  lockedAtomic: string;
  shipperKeyFingerprint: string;
  carrierKeyFingerprint: string;
  podId: string;
  podVersion: number;
  times: Times;
  actionIds: Record<string, string>;
  topicId: string | null;
  topicMemo: string;
  projectedWrites: number;
  successfulWrites: number;
  writeLog: Array<{ step: string; transactionId: string; at: string }>;
  completedSteps: StepName[];
  transactions: Partial<Record<StepName, HcsTxRecord>>;
  envelopes: Partial<Record<StepName, HcsV2Envelope>>;
  pod: PodProof | null;
  advisory: AdvisorySummary | null;
  acceptance: AcceptanceSummary | null;
  releasePlan: ReleasePlanSummary | null;
  contractStateBefore: ContractStateSnapshot | null;
  contractStateAfter: ContractStateSnapshot | null;
  /** Free Mirror re-read taken when the evidence package is written. */
  contractStateRecheck: ContractStateSnapshot | null;
  /**
   * Ledger transactions this run produced that are NOT RouteGuard state
   * changes: Hedera query payments for SDK read queries.
   */
  queryPaymentTransactions: number;
  createdAt: string;
  updatedAt: string;
};

type ContractStateSnapshot = {
  contractId: string;
  contractEvmAddress: string;
  tenderKey: string;
  state: string;
  tenderBalanceAtomic: string;
  totalEscrowedAtomic: string;
  carrierUsdcAtomic: string;
  contractUsdcAtomic: string;
  releaseAuthorizationHashUsed: boolean | null;
  readAt: string;
};

// ---------------------------------------------------------------------------
// Small helpers
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

function sha256Hex(input: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(input).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function stableRunId(): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `v2pod-${day}-${randomBytes(4).toString("hex")}`;
}

function shiftIso(baseIso: string, seconds: number): string {
  const ms = Date.parse(baseIso) + seconds * 1000;
  return new Date(ms).toISOString();
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
    "FINAL_DEMO_CARRIER_ALPHA_PRIVATE_KEY",
    "ROUTEGUARD_POD_MASTER_KEY_BASE64",
    "ROUTEGUARD_ACCESS_TREASURY_ACCOUNT_ID",
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

function compressedPublicKey(label: string, key: PrivateKey): string {
  const pub = key.publicKey.toStringRaw().toLowerCase();
  if (!/^(02|03)[0-9a-f]{64}$/.test(pub)) {
    die("KEY", `${label} does not derive a compressed ECDSA secp256k1 public key`);
  }
  return pub;
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

const ALLOWED_DIRTY_PREFIXES = [
  "evidence/v2/pod/",
  "data/",
  "artifacts/",
];
const ALLOWED_DIRTY_EXACT = new Set([
  "scripts/run-v2-pod-live.ts",
  "package.json",
  "package-lock.json",
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
    if (!ok) {
      die("DIRTY", `working tree has unexpected dirty path: ${p}`);
    }
  }
  console.log(`WORKING_TREE=PHASE_D2_ALLOWED_DIRTY paths=${paths.length}`);
}

function assertImmutableEvidenceUnchanged(): void {
  const guarded = [
    "evidence/v2/access/",
    "evidence/v2/escrow/",
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
// Mirror helpers (read-only)
// ---------------------------------------------------------------------------

async function mirrorGet<T>(urlPath: string): Promise<T> {
  const url = `${HEDERA_TESTNET_MIRROR_NODE.replace(/\/$/, "")}${urlPath}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Mirror HTTP ${res.status} for ${urlPath}`);
  }
  return (await res.json()) as T;
}

async function mirrorAccount(accountId: string): Promise<{
  accountId: string;
  hbarTinybars: bigint;
  usdcAtomic: bigint;
}> {
  const acc = await mirrorGet<{ balance?: { balance?: number } }>(
    `/api/v1/accounts/${accountId}`,
  );
  const tokens = await mirrorGet<{
    tokens?: Array<{ token_id?: string; balance?: number }>;
  }>(`/api/v1/accounts/${accountId}/tokens?limit=100`);
  const usdc = (tokens.tokens ?? []).find((t) => t.token_id === REQUIRED_TOKEN);
  return {
    accountId,
    hbarTinybars: BigInt(acc.balance?.balance ?? 0),
    usdcAtomic: BigInt(usdc?.balance ?? 0),
  };
}

async function mirrorVerifyTransaction(
  transactionId: string,
  attempts = 14,
  delayMs = 1500,
): Promise<{
  mirrorTransactionId: string;
  consensusTimestamp: string | null;
  result: string | null;
  mirrorStatus: HcsTxRecord["mirrorStatus"];
  hashScanUrl: string;
}> {
  const mirrorId = toMirrorTransactionId(transactionId);
  for (let i = 0; i < attempts; i++) {
    try {
      const payload = await mirrorGet<{
        transactions?: Array<{
          result?: string;
          consensus_timestamp?: string;
        }>;
      }>(`/api/v1/transactions/${encodeURIComponent(mirrorId)}`);
      const tx = payload.transactions?.[0];
      if (tx?.result) {
        return {
          mirrorTransactionId: mirrorId,
          consensusTimestamp: tx.consensus_timestamp ?? null,
          result: tx.result,
          mirrorStatus: tx.result === "SUCCESS" ? "SUCCESS" : "FAILED",
          hashScanUrl: hashScanTransactionUrl(transactionId),
        };
      }
    } catch {
      // Mirror lag — retry.
    }
    await sleep(delayMs);
  }
  return {
    mirrorTransactionId: mirrorId,
    consensusTimestamp: null,
    result: null,
    mirrorStatus: "NOT_FOUND",
    hashScanUrl: hashScanTransactionUrl(transactionId),
  };
}

async function mirrorTopicMessage(
  topicId: string,
  sequenceNumber: number,
  attempts = 14,
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
      // Mirror lag — retry.
    }
    await sleep(delayMs);
  }
  return { consensusTimestamp: null, sequenceNumber: null, bytes: null };
}

async function mirrorTopic(topicId: string): Promise<{
  topicId: string;
  memo: string | null;
  deleted: boolean;
} | null> {
  try {
    const body = await mirrorGet<{
      topic_id?: string;
      memo?: string;
      deleted?: boolean;
    }>(`/api/v1/topics/${topicId}`);
    return {
      topicId: body.topic_id ?? topicId,
      memo: body.memo ?? null,
      deleted: Boolean(body.deleted),
    };
  } catch {
    return null;
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

// ---------------------------------------------------------------------------
// Progress persistence
// ---------------------------------------------------------------------------

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
// Synthetic POD package (no real personal data)
// ---------------------------------------------------------------------------

function buildSyntheticPdf(lines: readonly string[]): Uint8Array {
  const esc = (s: string) =>
    s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const content = `${lines
    .map(
      (line, i) =>
        `BT /F1 ${i === 0 ? 14 : 10} Tf 56 ${770 - i * 22} Td (${esc(line)}) Tj ET`,
    )
    .join("\n")}\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

type SyntheticPodArtifacts = {
  files: PodFileInput[];
  writtenPaths: string[];
  plaintextDir: string;
};

/**
 * Build the synthetic POD documents in an isolated runtime directory outside
 * the repository. Plaintext is deleted after the encrypted commit succeeds.
 */
function buildSyntheticPodArtifacts(progress: Progress): SyntheticPodArtifacts {
  const plaintextDir = mkdtempSync(path.join(tmpdir(), "routeguard-v2-pod-"));

  const epod = buildSyntheticPdf([
    "ROUTEGUARD DEMONSTRATION - ELECTRONIC PROOF OF DELIVERY",
    "*** SYNTHETIC DATA - NOT A REAL DELIVERY RECORD ***",
    `Tender: ${progress.tenderId} (v${progress.tenderVersion})`,
    `POD id: ${progress.podId}  version: ${progress.podVersion}`,
    `Winning bid: ${progress.winningBidId}`,
    `Carrier account: ${progress.carrierAccountId}`,
    `Delivery facility code: ${FACILITY_CODE}`,
    `Delivery timestamp (UTC): ${progress.times.delivery}`,
    "Recipient confirmation present: YES",
    "Cargo condition: ACCEPTED (structured code GOOD)",
    "Exception codes: NONE",
    "No personal data is contained in this document.",
    "*** SYNTHETIC DATA - NOT A REAL DELIVERY RECORD ***",
  ]);

  const recipientConfirmation = buildSyntheticPdf([
    "ROUTEGUARD DEMONSTRATION - RECIPIENT CONFIRMATION",
    "*** SYNTHETIC DATA - NO HUMAN RECIPIENT SIGNED ***",
    `Tender: ${progress.tenderId} (v${progress.tenderVersion})`,
    `POD id: ${progress.podId}`,
    `Facility code: ${FACILITY_CODE}`,
    `Confirmed at (UTC): ${progress.times.delivery}`,
    "Confirmation method: FACILITY_TERMINAL_ACKNOWLEDGEMENT",
    "Recipient identity: NOT_RECORDED (synthetic demonstration)",
    "Cargo condition: ACCEPTED (structured code GOOD)",
    "*** SYNTHETIC DATA - NO HUMAN RECIPIENT SIGNED ***",
  ]);

  const metadata = {
    schema: "routeguard-v2-pod-delivery-metadata-1.0",
    tenderId: progress.tenderId,
    tenderVersion: progress.tenderVersion,
    escrowTenderKey: progress.tenderKey,
    winningBidId: progress.winningBidId,
    carrierAccount: progress.carrierAccountId,
    deliveryTimestamp: progress.times.delivery,
    deliveryFacilityCode: FACILITY_CODE,
    recipientConfirmationPresent: true,
    cargoConditionCode: "ACCEPTED",
    cargoConditionStructuredCode: "GOOD",
    exceptionCodes: [] as string[],
    syntheticData: true,
  };
  const metadataBytes = new Uint8Array(
    Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8"),
  );

  const files: PodFileInput[] = [
    {
      fileId: "f-epod",
      documentType: "ELECTRONIC_DELIVERY_RECEIPT",
      filename: "epod.pdf",
      mimeType: "application/pdf",
      bytes: epod,
    },
    {
      fileId: "f-recipient",
      documentType: "RECIPIENT_CONFIRMATION",
      filename: "recipient-confirmation.pdf",
      mimeType: "application/pdf",
      bytes: recipientConfirmation,
    },
    {
      fileId: "f-metadata",
      documentType: "STRUCTURED_DELIVERY_METADATA",
      filename: "delivery-metadata.json",
      mimeType: "application/json",
      bytes: metadataBytes,
    },
  ];

  const writtenPaths: string[] = [];
  for (const file of files) {
    const target = path.join(plaintextDir, file.filename);
    writeFileSync(target, Buffer.from(file.bytes));
    writtenPaths.push(target);
  }

  return { files, writtenPaths, plaintextDir };
}

function purgePlaintext(artifacts: SyntheticPodArtifacts): boolean {
  try {
    rmSync(artifacts.plaintextDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  return !existsSync(artifacts.plaintextDir);
}

// ---------------------------------------------------------------------------
// Live escrow evidence (read-only, authoritative)
// ---------------------------------------------------------------------------

type EscrowFacts = {
  runId: string;
  contractId: string;
  contractEvmAddress: string;
  tenderId: string;
  tenderVersion: number;
  tenderKey: string;
  shipperAccountId: string;
  carrierAccountId: string;
  budgetAtomic: string;
  winningAtomic: string;
  excessAtomic: string;
  lockedAtomic: string;
  carrierFreightReceivedAtomic: string;
  contractState: string;
  decisionManifestHash: string;
  fundingTxId: string;
  allocateTxId: string;
  refundExcessTxId: string;
  registrationTxId: string;
};

function readEscrowFacts(): EscrowFacts {
  const summary = readJson<Record<string, unknown>>(
    path.join(ESCROW_EVIDENCE_DIR, "run-summary.json"),
  );
  const state = readJson<Record<string, unknown>>(
    path.join(ESCROW_EVIDENCE_DIR, "contract-state.json"),
  );
  const allocation = readJson<Record<string, unknown>>(
    path.join(ESCROW_EVIDENCE_DIR, "winner-allocation.json"),
  );
  if (!summary || !state || !allocation) {
    die("ESCROW_EVIDENCE", "live Phase C2 escrow evidence is missing");
  }

  const facts: EscrowFacts = {
    runId: String(summary.runId ?? ""),
    contractId: String(summary.contractId ?? ""),
    contractEvmAddress: String(summary.contractEvmAddress ?? "").toLowerCase(),
    tenderId: String(summary.tenderId ?? ""),
    tenderVersion: Number(summary.tenderVersion ?? 0),
    tenderKey: String(summary.tenderKey ?? ""),
    shipperAccountId: String(summary.shipperAccountId ?? ""),
    carrierAccountId: String(summary.carrierAccountId ?? ""),
    budgetAtomic: String(summary.maximumFreightBudgetAtomic ?? ""),
    winningAtomic: String(summary.winningAmountAtomic ?? ""),
    excessAtomic: String(summary.excessRefundAtomic ?? ""),
    lockedAtomic: String(summary.contractLockedBalanceAtomic ?? ""),
    carrierFreightReceivedAtomic: String(summary.carrierFreightReceivedAtomic ?? ""),
    contractState: String(summary.contractState ?? ""),
    decisionManifestHash: String(allocation.decisionManifestHash ?? ""),
    fundingTxId: String(
      (summary.transactions as Record<string, unknown>)?.funding ?? "",
    ),
    allocateTxId: String(
      (summary.transactions as Record<string, unknown>)?.allocation ?? "",
    ),
    refundExcessTxId: String(
      (summary.transactions as Record<string, unknown>)?.allocation ?? "",
    ),
    registrationTxId: String(
      (summary.transactions as Record<string, unknown>)?.registration ?? "",
    ),
  };

  // Cross-file consistency — never invent a different tender or escrow key.
  if (String(state.contractId) !== facts.contractId) {
    die("ESCROW_EVIDENCE", "contract id inconsistent across escrow evidence");
  }
  if (String(state.tenderKey) !== facts.tenderKey) {
    die("ESCROW_EVIDENCE", "tender key inconsistent across escrow evidence");
  }
  if (String(allocation.tenderKey) !== facts.tenderKey) {
    die("ESCROW_EVIDENCE", "allocation tender key inconsistent");
  }
  if (String(state.state) !== "ALLOCATED" || facts.contractState !== "ALLOCATED") {
    die("ESCROW_EVIDENCE", `escrow state must be ALLOCATED, got ${facts.contractState}`);
  }
  if (facts.contractId !== PHASE_C2_ESCROW_CONTRACT_ID) {
    die("ESCROW_EVIDENCE", `escrow contract must be ${PHASE_C2_ESCROW_CONTRACT_ID}`);
  }
  if (facts.contractEvmAddress !== PHASE_C2_ESCROW_CONTRACT_EVM.toLowerCase()) {
    die("ESCROW_EVIDENCE", "escrow contract EVM address mismatch");
  }
  if (facts.lockedAtomic !== PHASE_C2_LOCKED_AMOUNT_ATOMIC) {
    die("ESCROW_EVIDENCE", `locked amount must be ${PHASE_C2_LOCKED_AMOUNT_ATOMIC}`);
  }
  if (facts.winningAtomic !== PHASE_C2_LOCKED_AMOUNT_ATOMIC) {
    die("ESCROW_EVIDENCE", "winning amount must equal the locked amount");
  }
  if (String(state.tenderBalanceAtomic) !== PHASE_C2_LOCKED_AMOUNT_ATOMIC) {
    die("ESCROW_EVIDENCE", "recorded tender balance must be 750000");
  }
  if (facts.carrierFreightReceivedAtomic !== "0") {
    die("ESCROW_EVIDENCE", "carrier already received freight principal");
  }
  if (
    BigInt(facts.winningAtomic) + BigInt(facts.excessAtomic) !==
    BigInt(facts.budgetAtomic)
  ) {
    die("ESCROW_EVIDENCE", "allocation conservation broken in escrow evidence");
  }
  const derivedKey = escrowTenderKey(facts.tenderId, facts.tenderVersion);
  if (derivedKey !== facts.tenderKey) {
    die("ESCROW_EVIDENCE", "tender key does not derive from the recorded tender identity");
  }
  if (!isValidHederaAccountId(facts.shipperAccountId) || !isValidHederaAccountId(facts.carrierAccountId)) {
    die("ESCROW_EVIDENCE", "escrow evidence account ids invalid");
  }
  if (!/^0x[0-9a-f]{64}$/.test(facts.decisionManifestHash)) {
    die("ESCROW_EVIDENCE", "decision manifest hash invalid");
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Read-only contract state
// ---------------------------------------------------------------------------

const ESCROW_READ_INTERFACE = new Interface([
  "function getState(bytes32) view returns (uint8)",
  "function tenderBalance(bytes32) view returns (uint64)",
  "function totalEscrowedAmount() view returns (uint256)",
  "function authorizationHashUsed(bytes32) view returns (bool)",
]);

/**
 * Read-only contract call through the Mirror Node.
 *
 * The SDK `ContractCallQuery` path would submit a *query payment*
 * CryptoTransfer to a consensus node for every read; this endpoint is a free
 * off-ledger evaluation, so state verification adds no ledger transaction.
 */
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
  if (!res.ok) {
    throw new Error(`Mirror contracts/call HTTP ${res.status} for ${fn}`);
  }
  const body = (await res.json()) as { result?: string };
  if (!body.result) throw new Error(`Mirror contracts/call returned no result for ${fn}`);
  return ESCROW_READ_INTERFACE.decodeFunctionResult(fn, body.result);
}

async function readContractState(
  progress: Progress,
  releaseAuthorizationHash: string | null,
): Promise<ContractStateSnapshot> {
  const evm = progress.contractEvmAddress;
  const key = progress.tenderKey;

  const state = escrowStateFromOrdinal(
    Number((await mirrorContractCall(evm, "getState", [key]))[0]),
  );
  const tenderBalance = String((await mirrorContractCall(evm, "tenderBalance", [key]))[0]);
  const totalEscrowed = String(
    (await mirrorContractCall(evm, "totalEscrowedAmount", []))[0],
  );

  let releaseAuthUsed: boolean | null = null;
  if (releaseAuthorizationHash) {
    releaseAuthUsed = Boolean(
      (await mirrorContractCall(evm, "authorizationHashUsed", [releaseAuthorizationHash]))[0],
    );
  }

  const carrier = await mirrorAccount(progress.carrierAccountId);
  const contractAcc = await mirrorAccount(progress.contractId);

  return {
    contractId: progress.contractId,
    contractEvmAddress: progress.contractEvmAddress,
    tenderKey: progress.tenderKey,
    state,
    tenderBalanceAtomic: tenderBalance,
    totalEscrowedAtomic: totalEscrowed,
    carrierUsdcAtomic: carrier.usdcAtomic.toString(),
    contractUsdcAtomic: contractAcc.usdcAtomic.toString(),
    releaseAuthorizationHashUsed: releaseAuthUsed,
    readAt: new Date().toISOString(),
  };
}

/**
 * Count Hedera query-payment CryptoTransfers this run produced.
 *
 * These are node fee payments for read-only SDK queries, not RouteGuard state
 * changes. Counting them keeps the ledger footprint disclosure honest.
 */
async function countQueryPayments(progress: Progress): Promise<number> {
  const first = progress.writeLog[0];
  if (!first) return 0;
  const startSeconds = Math.floor(Date.parse(progress.createdAt) / 1000);
  try {
    const body = await mirrorGet<{
      transactions?: Array<{ name?: string; transaction_id?: string }>;
    }>(
      `/api/v1/transactions?account.id=${progress.operatorAccountId}` +
        `&timestamp=gte:${startSeconds}&limit=100&order=asc&transactiontype=CRYPTOTRANSFER`,
    );
    return (body.transactions ?? []).filter((t) =>
      (t.transaction_id ?? "").startsWith(`${progress.operatorAccountId}-`),
    ).length;
  } catch {
    return -1;
  }
}

function assertEscrowUntouched(snapshot: ContractStateSnapshot, label: string): void {
  if (snapshot.state !== "ALLOCATED") {
    die("ESCROW_STATE", `${label}: contract state ${snapshot.state} !== ALLOCATED`);
  }
  if (snapshot.tenderBalanceAtomic !== PHASE_C2_LOCKED_AMOUNT_ATOMIC) {
    die(
      "ESCROW_STATE",
      `${label}: locked amount ${snapshot.tenderBalanceAtomic} !== ${PHASE_C2_LOCKED_AMOUNT_ATOMIC}`,
    );
  }
  if (snapshot.releaseAuthorizationHashUsed === true) {
    die("ESCROW_STATE", `${label}: release authorization hash already consumed on-chain`);
  }
  console.log(
    `${label} state=${snapshot.state} locked=${snapshot.tenderBalanceAtomic} carrierUsdc=${snapshot.carrierUsdcAtomic}`,
  );
}

// ---------------------------------------------------------------------------
// Lifecycle bootstrap (synthetic business data, bound to the live escrow)
// ---------------------------------------------------------------------------

function lifecycleSteps(progress: Progress): LifecycleEvent[] {
  const t = progress.times;
  const a = progress.actionIds;
  return [
    {
      type: "ESCROW_FUNDING_CONFIRMED",
      actionId: a.fund!,
      eventTime: t.fund,
      fundingTxId: progress.actionIds.fundingTxId!,
      tokenId: REQUIRED_TOKEN,
      fundedAmountAtomic: progress.budgetAtomic,
      tenderId: progress.tenderId,
      tenderVersion: progress.tenderVersion,
    },
    {
      type: "TENDER_ACTIVATION_PAID",
      actionId: a.activate!,
      eventTime: t.fund,
      accessActionType: "TENDER_ACTIVATE",
      asset: REQUIRED_TOKEN,
      amountAtomic: deriveAccessFeeAtomic(),
      resource: tenderActivateResource(progress.tenderId, progress.tenderVersion),
      paymentTransactionId: progress.actionIds.activationTxId!,
      paymentPayloadHash: progress.tenderHash,
      payerAccount: progress.shipperAccountId,
      payTo: requireEnv("ROUTEGUARD_ACCESS_TREASURY_ACCOUNT_ID"),
    },
    { type: "BIDDING_STARTED", actionId: a.bidding!, eventTime: t.fund },
    {
      type: "AUCTION_CLOSE_CONFIRMED",
      actionId: a.close!,
      eventTime: t.close,
      auctionEndsAt: t.auctionEnds,
      closureProofRef: `closure-${progress.escrowRunId}`,
      authoritativeBidSetHash: progress.tenderHash,
    },
    {
      type: "WINNER_SELECTION_CONFIRMED",
      actionId: a.winner!,
      eventTime: t.winner,
      decisionManifestHash: `sha256:${progress.decisionManifestHash.slice(2)}`,
      winningBidId: progress.winningBidId,
      winningCarrierId: CARRIER_ID,
      winningCarrierAccount: progress.carrierAccountId,
      winningAmountAtomic: progress.winningAtomic,
      selectionPolicy: "LOWEST_QUALIFIED_PRICE_V1",
    },
    {
      type: "WINNING_AMOUNT_ALLOCATION_CONFIRMED",
      actionId: a.allocate!,
      eventTime: t.winner,
      allocateTxId: progress.actionIds.allocateTxId!,
      refundExcessTxId: progress.actionIds.refundExcessTxId!,
      maxBudgetAtomic: progress.budgetAtomic,
      winningAmountAtomic: progress.winningAtomic,
      excessRefundAtomic: progress.excessAtomic,
      decisionManifestHash: `sha256:${progress.decisionManifestHash.slice(2)}`,
    },
    {
      type: "ROUTE_RESERVATION_PUBLISHED",
      actionId: a.reserve!,
      eventTime: t.reserve,
      reservationEvidenceRef: `reservation-${progress.runId}`,
      hcsPublicationRef: `pending-${progress.runId}`,
    },
    { type: "TRANSIT_STARTED", actionId: a.transit!, eventTime: t.reserve },
    { type: "DELIVERY_REPORTED", actionId: a.delivery!, eventTime: t.delivery },
  ];
}

async function ensureLifecycleRecord(
  lifecycle: LifecycleService,
  progress: Progress,
  shipperPublicKey: string,
  refereePublicKey: string,
): Promise<LifecycleRecord> {
  let record = await lifecycle.get(progress.tenderId);
  if (!record) {
    const trust = createTrustPolicy({
      shipperPublicKey,
      referees: [{ refereeId: REFEREE_ID, publicKey: refereePublicKey }],
      accessTreasuryAccountId: requireEnv("ROUTEGUARD_ACCESS_TREASURY_ACCOUNT_ID"),
    });
    record = await lifecycle.create({
      tenderId: progress.tenderId,
      tenderVersion: progress.tenderVersion,
      tenderHash: progress.tenderHash,
      maximumFreightBudgetAtomic: progress.budgetAtomic,
      auctionEndsAt: progress.times.auctionEnds,
      // The record is created at the first synthetic lifecycle event, so every
      // later event time is monotonic non-decreasing.
      createdAt: progress.times.fund,
      trust,
    });
  }

  for (const event of lifecycleSteps(progress)) {
    const current = await lifecycle.get(progress.tenderId);
    if (current?.processedActions[event.actionId]) continue;
    if (
      current &&
      (current.state === "POD_SUBMITTED" ||
        current.state === "POD_UNDER_REVIEW" ||
        current.state === "POD_ACCEPTED")
    ) {
      // POD workflow already started on a prior run — the lifecycle prefix is done.
      break;
    }
    await lifecycle.apply(progress.tenderId, event);
  }

  const finalRecord = await lifecycle.get(progress.tenderId);
  if (!finalRecord) die("LIFECYCLE", "lifecycle record missing after bootstrap");

  if (finalRecord.trust.shipperPublicKey.toLowerCase() !== shipperPublicKey) {
    die("TRUST", "configured shipper key does not match the durable trust snapshot");
  }
  if (finalRecord.lockedAmountAtomic !== PHASE_C2_LOCKED_AMOUNT_ATOMIC) {
    die("LIFECYCLE", "lifecycle locked amount does not match the live escrow");
  }
  if (finalRecord.winningCarrierAccount !== progress.carrierAccountId) {
    die("LIFECYCLE", "lifecycle winning carrier does not match the live escrow");
  }
  return finalRecord;
}

// ---------------------------------------------------------------------------
// POD build / submit (local; no network write)
// ---------------------------------------------------------------------------

async function ensurePodStored(
  podService: PodService,
  podStore: FilePodEncryptedStore,
  keyProtector: AesGcmMasterKeyProtector,
  progress: Progress,
  carrierKey: PrivateKey,
  carrierPublicKey: string,
): Promise<PodProof> {
  const existing = await podStore.get(
    progress.tenderId,
    progress.tenderVersion,
    progress.podId,
    progress.podVersion,
  );
  if (existing && progress.pod) {
    // Restart path: never re-encrypt; prove the stored envelope still opens.
    const plaintext = decryptStoredRecord({ record: existing, keyProtector });
    const decoded = decodePlaintextPackage(plaintext);
    if (decoded.packageContentHash !== progress.pod.packageContentHash) {
      die("POD_STORAGE", "stored POD package hash does not match recorded proof");
    }
    console.log("POD_STORAGE=RESUMED (existing encrypted envelope reused)");
    return { ...progress.pod, decryptRoundTripVerified: true };
  }
  if (existing && !progress.pod) {
    die(
      "POD_STORAGE",
      "encrypted POD exists without recorded proof — refusing to overwrite",
    );
  }

  const artifacts = buildSyntheticPodArtifacts(progress);
  const tenderKey = progress.tenderKey;
  const fields = {
    podId: progress.podId,
    podVersion: progress.podVersion,
    tenderId: progress.tenderId,
    tenderVersion: progress.tenderVersion,
    winningBidId: progress.winningBidId,
    escrowTenderKey: tenderKey,
    carrierId: CARRIER_ID,
    carrierAccountId: progress.carrierAccountId,
    deliveryTimestamp: progress.times.delivery,
    recipientConfirmationPresent: true,
    cargoConditionCode: "GOOD" as const,
    exceptionCodes: [] as const,
    submittedAt: progress.times.submit,
    actionId: progress.actionIds.podSubmit!,
  };

  // Hashes are computed by the production manifest module so the carrier
  // signature binds exactly what the service will recompute.
  const { buildCanonicalManifest, manifestHash, packageContentHash } = await import(
    "../src/v2/pod/manifest"
  );
  const { DeterministicSafePodScanner } = await import("../src/v2/pod/policy");
  const manifest = await buildCanonicalManifest(
    artifacts.files,
    undefined,
    new DeterministicSafePodScanner(),
  );
  const mHash = manifestHash(manifest);
  const pHash = packageContentHash(fields, manifest);

  const signPayload = buildCarrierPodSubmissionSignPayload({
    podId: fields.podId,
    podVersion: fields.podVersion,
    tenderId: fields.tenderId,
    tenderVersion: fields.tenderVersion,
    winningBidId: fields.winningBidId,
    escrowTenderKey: fields.escrowTenderKey,
    carrierId: fields.carrierId,
    carrierAccountId: fields.carrierAccountId,
    deliveryTimestamp: fields.deliveryTimestamp,
    manifestHash: mHash,
    packageContentHash: pHash,
    submittedAt: fields.submittedAt,
    actionId: fields.actionId,
  });
  const carrierSignature = signCanonicalPayload(signPayload, carrierKey.toStringRaw());

  // Independent verification before the package is accepted anywhere.
  const carrierAuth = verifyCarrierPodSubmission({
    registeredPublicKey: carrierPublicKey,
    ...signPayload,
    signature: carrierSignature,
  });
  console.log("CARRIER_SIGNATURE=PASS");

  const pkg: SignedPodPackage = {
    ...fields,
    files: artifacts.files,
    carrierSignature,
    manifestHash: mHash,
    packageContentHash: pHash,
  };

  const result = await podService.submitPod({
    tenderId: progress.tenderId,
    tenderVersion: progress.tenderVersion,
    podId: progress.podId,
    package: pkg,
  });
  if (result.outcome !== "APPLIED") {
    die("POD_SUBMIT", `unexpected POD submit outcome ${result.outcome}`);
  }

  const stored = await podStore.get(
    progress.tenderId,
    progress.tenderVersion,
    progress.podId,
    progress.podVersion,
  );
  if (!stored) die("POD_STORAGE", "encrypted POD was not persisted");

  // Round-trip: load, validate, decrypt, and compare against the signed input.
  const plaintext = decryptStoredRecord({ record: stored, keyProtector });
  const decoded = decodePlaintextPackage(plaintext);
  if (decoded.packageContentHash !== pHash || decoded.manifestHash !== mHash) {
    die("POD_STORAGE", "decrypted POD hashes do not match the signed package");
  }
  if (decoded.files.length !== artifacts.files.length) {
    die("POD_STORAGE", "decrypted POD file count mismatch");
  }
  for (const original of artifacts.files) {
    const round = decoded.files.find((f) => f.fileId === original.fileId);
    if (!round || sha256Hex(round.bytes) !== sha256Hex(original.bytes)) {
      die("POD_STORAGE", "decrypted POD file bytes do not round-trip");
    }
  }

  const purged = purgePlaintext(artifacts);
  if (!purged) {
    die("POD_PLAINTEXT", "temporary plaintext directory could not be removed");
  }
  console.log(
    `POD_ENCRYPTION=PASS docs=${manifest.documentCount} plaintextBytes=${manifest.totalBytes} ciphertextBytes=${stored.envelope.ciphertextBytes}`,
  );

  return {
    podId: progress.podId,
    podVersion: progress.podVersion,
    manifestHash: mHash,
    packageContentHash: pHash,
    ciphertextHash: stored.envelope.ciphertextHash,
    aadHash: stored.envelope.aadHash,
    encryptionAlg: stored.envelope.encryptionAlg,
    wrapAlg: stored.envelope.wrapAlg,
    documentCount: manifest.documentCount,
    totalPlaintextBytes: manifest.totalBytes,
    ciphertextBytes: stored.envelope.ciphertextBytes,
    plaintextEnvelopeBytes: stored.envelope.plaintextBytes,
    storageSchema: stored.envelope.schemaVersion,
    storagePath: `${POD_STORE_DIR}/ (gitignored runtime storage)`,
    carrierSignatureVerified: true,
    carrierAuthPayloadHash: carrierAuth.payloadHash,
    carrierKeyFingerprint: carrierAuth.trustedKeyFingerprint,
    decryptRoundTripVerified: true,
    plaintextPersisted: false,
  };
}

// ---------------------------------------------------------------------------
// HCS writes
// ---------------------------------------------------------------------------

async function stepCreateTopic(
  client: Client,
  operatorPublicKey: PrivateKey["publicKey"],
  operatorAccountId: string,
  progress: Progress,
  budget: WriteBudget,
): Promise<void> {
  if (progress.completedSteps.includes("topic_create") && progress.topicId) {
    console.log(`SKIP topic_create (existing topic ${progress.topicId})`);
    return;
  }
  if (isDryPreflight()) {
    console.log(`DRY topic_create memo="${TOPIC_MEMO}" (not submitted)`);
    return;
  }
  if (progress.topicId) {
    die("TOPIC", "a topic id is recorded without a completed create step");
  }
  budget.assertCanWrite(1);

  const response: TransactionResponse = await new TopicCreateTransaction()
    .setTopicMemo(TOPIC_MEMO)
    .setAdminKey(operatorPublicKey)
    .setSubmitKey(operatorPublicKey)
    .setAutoRenewAccountId(AccountId.fromString(operatorAccountId))
    .setMaxTransactionFee(new Hbar(5))
    .execute(client);

  const transactionId = response.transactionId.toString();
  const receipt: TransactionReceipt = await response.getReceipt(client);
  if (receipt.status !== Status.Success) {
    die("TOPIC", `TopicCreate status ${receipt.status.toString()}`);
  }
  const topicId = receipt.topicId?.toString();
  if (!topicId) die("TOPIC", "TopicCreate succeeded without a topic id");
  if (topicId === V1_IMMUTABLE_TOPIC_ID) {
    die("TOPIC", "refusing to use the immutable v1 topic");
  }

  // The write has happened. Record it — including the step — before any
  // verification can throw, so a restart never submits a second topic create.
  budget.recordSuccess("topic_create", transactionId);
  progress.topicId = topicId;
  progress.transactions.topic_create = {
    step: "topic_create",
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
  markStep(progress, "topic_create", budget);
  console.log(`TOPIC_CREATE_OK topicId=${topicId} tx=${transactionId}`);
}

/** Idempotent Mirror confirmation of an already-recorded transaction. */
async function verifyTopicCreateOnMirror(progress: Progress): Promise<void> {
  const record = progress.transactions.topic_create;
  if (!record) die("MIRROR", "topic create transaction not recorded");
  if (record.mirrorStatus === "SUCCESS") return;
  const mirror = await mirrorVerifyTransaction(record.transactionId);
  if (mirror.mirrorStatus !== "SUCCESS") {
    die("MIRROR", `topic create mirror status ${mirror.mirrorStatus}`);
  }
  progress.transactions.topic_create = {
    ...record,
    mirrorTransactionId: mirror.mirrorTransactionId,
    consensusTimestamp: mirror.consensusTimestamp,
    result: mirror.result,
    mirrorStatus: mirror.mirrorStatus,
  };
  saveProgress(progress);
}

async function submitEnvelope(
  client: Client,
  progress: Progress,
  budget: WriteBudget,
  step: StepName,
  envelope: HcsV2Envelope,
): Promise<void> {
  if (progress.completedSteps.includes(step)) {
    console.log(
      `SKIP ${step} (sequence ${progress.transactions[step]?.sequenceNumber ?? "?"})`,
    );
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
  if (!progress.topicId) die("TOPIC", "topic id missing before message submit");

  budget.assertCanWrite(1);
  const response = await new TopicMessageSubmitTransaction()
    .setTopicId(TopicId.fromString(progress.topicId))
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

  // Persist the completed write before verification so a Mirror failure can
  // never cause a duplicate submit on restart.
  budget.recordSuccess(step, transactionId);
  progress.envelopes[step] = envelope;
  progress.transactions[step] = {
    step,
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
  console.log(
    `${envelope.messageType}_OK seq=${sequenceNumber} bytes=${byteLength} tx=${transactionId}`,
  );
}

/** Idempotent Mirror confirmation of an already-submitted message. */
async function verifyMessageOnMirror(
  progress: Progress,
  step: StepName,
): Promise<void> {
  const record = progress.transactions[step];
  if (!record) die("MIRROR", `${step} transaction not recorded`);
  if (record.mirrorStatus === "SUCCESS" && record.bytesMatch) return;
  if (!progress.topicId) die("TOPIC", "topic id missing during verification");

  const mirror = await mirrorVerifyTransaction(record.transactionId);
  if (mirror.mirrorStatus !== "SUCCESS") {
    die("MIRROR", `${step} mirror status ${mirror.mirrorStatus}`);
  }
  const message = await mirrorTopicMessage(progress.topicId, record.sequenceNumber!);
  if (!message.bytes) {
    die("MIRROR", `${step} message not retrievable from Mirror Node`);
  }
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
  console.log(
    `MIRROR_OK ${record.messageType} seq=${record.sequenceNumber} bytes match=YES`,
  );
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

const CLAIM_LABELS = {
  SYNTHETIC_BUSINESS_DATA: "YES",
  LIVE_POD_CRYPTO: "YES",
  LIVE_APPLICATION_SIGNATURES: "YES",
  LIVE_HCS_ANCHORS: "YES",
  LIVE_AI_MODEL: "NO",
  ADVISER_IMPLEMENTATION: "DETERMINISTIC_STUB",
  LIVE_PHYSICAL_DELIVERY: "NO",
  LIVE_FREIGHT_RELEASE: "NO",
  ESCROW_STATE_AFTER_RUN: "ALLOCATED",
  LOCKED_AMOUNT_AFTER_RUN: "750000",
} as const;

function buildPreflightDoc(input: {
  progress: Progress;
  escrow: EscrowFacts;
  identities: {
    operatorAccountId: string;
    shipperAccountId: string;
    carrierAccountId: string;
    shipperPublicKey: string;
    carrierPublicKey: string;
  };
  operatorTinybars: bigint;
  liveState: ContractStateSnapshot;
}): Record<string, unknown> {
  const { progress, escrow, identities, liveState } = input;
  return {
    runId: progress.runId,
    phase: "D2",
    branch: REQUIRED_BRANCH,
    network: REQUIRED_NETWORK,
    tokenId: progress.tokenId,
    guards: {
      [CONFIRM_ENV]: "PRESENT_AND_EXACT",
      [MAX_WRITES_ENV]: String(MAX_WRITES),
      ENABLE_LIVE_HEDERA: "true",
    },
    // Status only — never a value, and deliberately not spelled with the
    // environment variable names so public evidence carries no key-field names.
    secrets: {
      podMasterKey: "PRESENT",
      podMasterKeyBytes: 32,
      shipperSigningKey: "PRESENT",
      carrierSigningKey: "PRESENT",
      operatorSigningKey: "PRESENT",
    },
    identities: {
      operatorAccountId: identities.operatorAccountId,
      shipperAccountId: identities.shipperAccountId,
      carrierAccountId: identities.carrierAccountId,
      shipperPublicKey: identities.shipperPublicKey,
      carrierPublicKey: identities.carrierPublicKey,
      shipperKeyFingerprint: progress.shipperKeyFingerprint,
      carrierKeyFingerprint: progress.carrierKeyFingerprint,
      trustSnapshotShipperKeyMatches: true,
      carrierRegistryKeyMatches: true,
    },
    escrow: {
      escrowRunId: escrow.runId,
      contractId: escrow.contractId,
      contractEvmAddress: escrow.contractEvmAddress,
      tenderId: escrow.tenderId,
      tenderVersion: escrow.tenderVersion,
      tenderKey: escrow.tenderKey,
      derivedTenderKeyMatches: true,
      decisionManifestHash: escrow.decisionManifestHash,
      budgetAtomic: escrow.budgetAtomic,
      winningAtomic: escrow.winningAtomic,
      excessAtomic: escrow.excessAtomic,
      lockedAtomic: escrow.lockedAtomic,
      liveState: liveState.state,
      liveTenderBalanceAtomic: liveState.tenderBalanceAtomic,
      liveContractUsdcAtomic: liveState.contractUsdcAtomic,
      liveCarrierUsdcAtomic: liveState.carrierUsdcAtomic,
      liveStateReadAt: liveState.readAt,
    },
    operator: {
      accountId: identities.operatorAccountId,
      hbarTinybars: input.operatorTinybars.toString(),
      minimumRequiredTinybars: MIN_OPERATOR_TINYBARS.toString(),
      sufficient: true,
    },
    d1FocusedTests: "PASS",
    writePlan: [
      { index: 1, step: "topic_create", kind: "TopicCreateTransaction", memo: TOPIC_MEMO },
      { index: 2, step: "pod_submitted", kind: "TopicMessageSubmitTransaction" },
      { index: 3, step: "pod_advisory", kind: "TopicMessageSubmitTransaction" },
      { index: 4, step: "pod_review_action", kind: "TopicMessageSubmitTransaction" },
    ],
    projectedNetworkWrites: PROJECTED_WRITES,
    contractWrites: 0,
    x402Writes: 0,
    v1TopicExcluded: V1_IMMUTABLE_TOPIC_ID,
    generatedAt: new Date().toISOString(),
  };
}

function writeEvidencePackage(
  progress: Progress,
  preflight: Record<string, unknown>,
  advisory: PodAdvisoryReport,
): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const tx = progress.transactions;

  writeJson(path.join(EVIDENCE_DIR, "preflight.json"), preflight);

  writeJson(path.join(EVIDENCE_DIR, "topic-create.json"), {
    runId: progress.runId,
    topicId: progress.topicId,
    topicMemo: progress.topicMemo,
    v1TopicReused: false,
    immutableV1TopicId: V1_IMMUTABLE_TOPIC_ID,
    submitKey: "OPERATOR_ECDSA_PUBLIC_KEY",
    adminKey: "OPERATOR_ECDSA_PUBLIC_KEY",
    autoRenewAccountId: progress.operatorAccountId,
    transaction: tx.topic_create ?? null,
    hashScanTopicUrl: progress.topicId
      ? `https://hashscan.io/testnet/topic/${progress.topicId}`
      : null,
    generatedAt,
  });

  writeJson(path.join(EVIDENCE_DIR, "pod-public-receipt.json"), {
    runId: progress.runId,
    tenderId: progress.tenderId,
    tenderVersion: progress.tenderVersion,
    escrowTenderKey: progress.tenderKey,
    podId: progress.podId,
    podVersion: progress.podVersion,
    winningBidId: progress.winningBidId,
    carrierAccountId: progress.carrierAccountId,
    shipperAccountId: progress.shipperAccountId,
    manifestHash: progress.pod?.manifestHash ?? null,
    packageContentHash: progress.pod?.packageContentHash ?? null,
    ciphertextHash: progress.pod?.ciphertextHash ?? null,
    documentCount: progress.pod?.documentCount ?? null,
    documentTypes: [
      "ELECTRONIC_DELIVERY_RECEIPT",
      "RECIPIENT_CONFIRMATION",
      "STRUCTURED_DELIVERY_METADATA",
    ],
    deliveryTimestamp: progress.times.delivery,
    deliveryFacilityCode: FACILITY_CODE,
    recipientConfirmationPresent: true,
    cargoCondition: "ACCEPTED",
    cargoConditionStructuredCode: "GOOD",
    exceptionCodes: [],
    submittedAt: progress.times.submit,
    syntheticData: true,
    generatedAt,
  });

  writeJson(path.join(EVIDENCE_DIR, "pod-encryption-proof.json"), {
    runId: progress.runId,
    ...progress.pod,
    keyProtection:
      "per-POD AES-256-GCM data key wrapped under ROUTEGUARD_POD_MASTER_KEY_BASE64",
    dataKeyUniquePerPod: true,
    ivUniquePerPod: true,
    aadBinding: ["tenderId", "tenderVersion", "podId", "podVersion", "manifestHash"],
    plaintextCommittedToGit: false,
    encryptedBlobCommittedToGit: false,
    generatedAt,
  });

  writeJson(path.join(EVIDENCE_DIR, "pod-submitted-hcs.json"), {
    runId: progress.runId,
    topicId: progress.topicId,
    envelope: progress.envelopes.pod_submitted ?? null,
    transaction: tx.pod_submitted ?? null,
    generatedAt,
  });

  writeJson(path.join(EVIDENCE_DIR, "advisory-public-summary.json"), {
    runId: progress.runId,
    ...progress.advisory,
    findings: advisory.findings.map((f) => ({
      code: f.code,
      severity: f.severity,
      codeHash: `sha256:${sha256Hex(`${f.code}|${f.severity}`)}`,
    })),
    nonBinding: true,
    performedLifecycleAcceptance: false,
    constructedEscrowAuthorization: false,
    note:
      "Deterministic rules-based adviser. No live AI model was called. The private advisory report body is not published.",
    generatedAt,
  });

  writeJson(path.join(EVIDENCE_DIR, "advisory-hcs.json"), {
    runId: progress.runId,
    topicId: progress.topicId,
    envelope: progress.envelopes.pod_advisory ?? null,
    transaction: tx.pod_advisory ?? null,
    generatedAt,
  });

  writeJson(path.join(EVIDENCE_DIR, "shipper-acceptance.json"), {
    runId: progress.runId,
    tenderId: progress.tenderId,
    tenderVersion: progress.tenderVersion,
    podId: progress.podId,
    podVersion: progress.podVersion,
    action: "ACCEPT",
    ...progress.acceptance,
    shipperAccountId: progress.shipperAccountId,
    signatureAlgorithm: "ECDSA_SECP256K1_HIERO",
    signaturePurpose: "ROUTEGUARD_V2_SHIPPER_POD_REVIEW",
    rawSignaturePublished: false,
    generatedAt,
  });

  writeJson(path.join(EVIDENCE_DIR, "review-action-hcs.json"), {
    runId: progress.runId,
    topicId: progress.topicId,
    envelope: progress.envelopes.pod_review_action ?? null,
    transaction: tx.pod_review_action ?? null,
    bindingLabel: "SHIPPER_SIGNED",
    generatedAt,
  });

  writeJson(path.join(EVIDENCE_DIR, "release-plan.json"), {
    runId: progress.runId,
    ...progress.releasePlan,
    submittedToNetwork: false,
    contractNetworkWrites: 0,
    note:
      "Transaction plan only. Phase E1 is responsible for executing releaseFull.",
    generatedAt,
  });

  const mirrorRows = (["topic_create", ...MESSAGE_STEPS] as StepName[]).map((step) => ({
    step,
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
  const sequences = MESSAGE_STEPS.map((s) => tx[s]?.sequenceNumber ?? -1);
  const txIds = mirrorRows.map((r) => r.transactionId).filter(Boolean) as string[];

  writeJson(path.join(EVIDENCE_DIR, "mirror-verification.json"), {
    runId: progress.runId,
    network: progress.network,
    mirrorNode: HEDERA_TESTNET_MIRROR_NODE,
    topicId: progress.topicId,
    rows: mirrorRows,
    allSuccess: mirrorRows.every((r) => r.mirrorStatus === "SUCCESS"),
    uniqueTransactionIds: new Set(txIds).size === txIds.length,
    orderedSequences: sequences,
    orderingCorrect:
      sequences.length === 3 &&
      sequences.every((s) => s > 0) &&
      sequences[0]! < sequences[1]! &&
      sequences[1]! < sequences[2]!,
    expectedOrder: [
      "POD_SUBMITTED",
      "POD_ADVISORY_ANCHORED",
      "POD_REVIEW_ACTION",
    ],
    messageBytesMatchLocalEnvelopes: MESSAGE_STEPS.every(
      (s) => tx[s]?.bytesMatch === true,
    ),
    generatedAt,
  });

  writeJson(path.join(EVIDENCE_DIR, "contract-state-after.json"), {
    runId: progress.runId,
    before: progress.contractStateBefore,
    after: progress.contractStateAfter,
    stateUnchanged:
      progress.contractStateBefore?.state === progress.contractStateAfter?.state,
    lockedAmountUnchanged:
      progress.contractStateBefore?.tenderBalanceAtomic ===
      progress.contractStateAfter?.tenderBalanceAtomic,
    carrierFreightReceivedAtomic: "0",
    carrierUsdcUnchanged:
      progress.contractStateBefore?.carrierUsdcAtomic ===
      progress.contractStateAfter?.carrierUsdcAtomic,
    releaseAuthorizationSubmitted: false,
    releaseFullCalled: false,
    openDisputeCalled: false,
    contractNetworkWrites: 0,
    independentMirrorRecheck: progress.contractStateRecheck,
    recheckAgreesWithAfter:
      progress.contractStateRecheck?.state === progress.contractStateAfter?.state &&
      progress.contractStateRecheck?.tenderBalanceAtomic ===
        progress.contractStateAfter?.tenderBalanceAtomic &&
      progress.contractStateRecheck?.releaseAuthorizationHashUsed === false,
    ledgerFootprint: {
      note:
        "State-changing writes are the four authorized HCS transactions. The " +
        "read-only escrow verification additionally produced Hedera query-payment " +
        "CryptoTransfers (HBAR fees to consensus nodes) while the SDK ContractCallQuery " +
        "path was in use; those move no USDC and change no RouteGuard state. The runner " +
        "now reads contract state through the free Mirror Node contracts/call endpoint.",
      authorizedStateChangingWrites: 4,
      queryPaymentCryptoTransfers: progress.queryPaymentTransactions,
      usdcMovedByThisRun: "0",
      contractStateMutations: 0,
    },
    generatedAt,
  });

  writeJson(path.join(EVIDENCE_DIR, "run-summary.json"), {
    status: "SUCCESS",
    runId: progress.runId,
    phase: "D2",
    completedAt: generatedAt,
    network: progress.network,
    labels: CLAIM_LABELS,
    escrow: {
      escrowRunId: progress.escrowRunId,
      contractId: progress.contractId,
      contractEvmAddress: progress.contractEvmAddress,
      tenderId: progress.tenderId,
      tenderVersion: progress.tenderVersion,
      tenderKey: progress.tenderKey,
      shipperAccountId: progress.shipperAccountId,
      carrierAccountId: progress.carrierAccountId,
      stateBefore: progress.contractStateBefore?.state ?? null,
      stateAfter: progress.contractStateAfter?.state ?? null,
      lockedAmountAtomic: progress.contractStateAfter?.tenderBalanceAtomic ?? null,
      carrierFreightReleasedAtomic: "0",
    },
    pod: progress.pod,
    advisory: progress.advisory,
    acceptance: progress.acceptance,
    releasePlan: progress.releasePlan,
    hcs: {
      topicId: progress.topicId,
      topicMemo: progress.topicMemo,
      topicCreateTx: tx.topic_create?.transactionId ?? null,
      messages: MESSAGE_STEPS.map((step) => ({
        messageType: tx[step]?.messageType ?? null,
        transactionId: tx[step]?.transactionId ?? null,
        sequenceNumber: tx[step]?.sequenceNumber ?? null,
        consensusTimestamp: tx[step]?.consensusTimestamp ?? null,
        payloadHash: tx[step]?.payloadHash ?? null,
        hashScanUrl: tx[step]?.hashScanUrl ?? null,
      })),
    },
    writeCounts: {
      HCS_TOPIC_CREATIONS: 1,
      HCS_MESSAGE_WRITES: 3,
      CONTRACT_WRITES: 0,
      X402_WRITES: 0,
      OTHER_HEDERA_WRITES: 0,
      NETWORK_WRITES: progress.successfulWrites,
      queryPaymentCryptoTransfers: progress.queryPaymentTransactions,
      queryPaymentNote:
        "Read-only escrow verification via the SDK ContractCallQuery path bills a " +
        "Hedera query payment per call. These are HBAR node fees, not RouteGuard " +
        "state changes, and move no USDC.",
    },
    claims: {
      encryptedPodStoredLocally: true,
      podPlaintextPersisted: false,
      podPlaintextSubmittedToHedera: false,
      carrierSignatureVerified: true,
      shipperAcceptanceSigned: true,
      shipperSignatureVerified: true,
      advisoryIsNonBinding: true,
      advisoryIsDeterministicStub: true,
      liveAiModelInvoked: false,
      physicalDeliveryProven: false,
      humanRecipientSignatureProven: false,
      releaseFullPlanBuilt: true,
      releaseFullSubmitted: false,
      freightPrincipalReleased: false,
      escrowRemainsAllocated: true,
      lockedAmountRemains750000: true,
      x402PaymentRepeated: false,
      v1TopicUsed: false,
      phaseEOwnsRealRelease: true,
    },
    nextPhase: "E1",
  });

  const seq = (s: StepName) => tx[s]?.sequenceNumber ?? "?";
  const txid = (s: StepName) => tx[s]?.transactionId ?? "NONE";
  const readme = `# RouteGuard v2 Phase D2 — live POD acceptance (Hedera testnet)

**Status:** SUCCESS
**Run ID:** \`${progress.runId}\`
**Date:** ${generatedAt.slice(0, 10)}
**Network writes:** ${progress.successfulWrites} (1 topic create + 3 HCS messages)

## What this proves

1. A synthetic POD package was validated, canonically hashed, and signed by the
   configured carrier identity (real ECDSA secp256k1 application signature).
2. The package was encrypted with AES-256-GCM under a unique per-POD data key
   and IV; the data key is wrapped under the configured master key.
3. Only the encrypted envelope was persisted (\`data/v2-pods/\`, gitignored).
   Plaintext existed only in an isolated runtime directory and was removed.
4. Three RouteGuard \`routeguard-hcs-2.0\` envelopes were submitted to a
   dedicated testnet HCS topic and Mirror-verified byte for byte.
5. A deterministic, **non-binding** POD assurance advisory was produced and
   anchored by report hash.
6. The shipper signed a canonical ACCEPT review action; the signature was
   verified before the lifecycle transitioned \`POD_UNDER_REVIEW → POD_ACCEPTED\`.
7. A \`releaseFull\` transaction plan was built and bound to the live escrow —
   and **not submitted**.

## What this does NOT prove

- No physical delivery occurred.
- No human recipient signed anything.
- No live AI model analyzed the POD (the adviser is a deterministic stub).
- No freight principal was released.

## Labels

${Object.entries(CLAIM_LABELS)
  .map(([k, v]) => `- \`${k}=${v}\``)
  .join("\n")}

## HCS topic

| Field | Value |
|---|---|
| Topic ID | \`${progress.topicId}\` |
| Memo | \`${progress.topicMemo}\` |
| Create tx | \`${txid("topic_create")}\` |
| v1 topic \`${V1_IMMUTABLE_TOPIC_ID}\` reused | **No** |

## Messages (consensus order)

| # | Type | Sequence | Transaction ID |
|---|---|---|---|
| 1 | \`POD_SUBMITTED\` | ${seq("pod_submitted")} | \`${txid("pod_submitted")}\` |
| 2 | \`POD_ADVISORY_ANCHORED\` | ${seq("pod_advisory")} | \`${txid("pod_advisory")}\` |
| 3 | \`POD_REVIEW_ACTION\` (ACCEPT) | ${seq("pod_review_action")} | \`${txid("pod_review_action")}\` |

Every message body is the canonical JSON of the envelope stored beside it in
this directory; Mirror Node bytes were compared by SHA-256.

## Public hashes

| Field | Value |
|---|---|
| Manifest hash | \`${progress.pod?.manifestHash}\` |
| Package content hash | \`${progress.pod?.packageContentHash}\` |
| Ciphertext hash | \`${progress.pod?.ciphertextHash}\` |
| Advisory report hash | \`${progress.advisory?.reportHash}\` |
| Shipper auth payload hash | \`${progress.acceptance?.authPayloadHash}\` |
| Release authorization hash | \`${progress.releasePlan?.authorizationHash}\` |
| Release plan hash | \`${progress.releasePlan?.planHash}\` |

## Live escrow — unchanged

| Field | Before | After |
|---|---|---|
| State | \`${progress.contractStateBefore?.state}\` | \`${progress.contractStateAfter?.state}\` |
| Locked tender balance | ${progress.contractStateBefore?.tenderBalanceAtomic} | ${progress.contractStateAfter?.tenderBalanceAtomic} |
| Carrier USDC | ${progress.contractStateBefore?.carrierUsdcAtomic} | ${progress.contractStateAfter?.carrierUsdcAtomic} |

Contract \`${progress.contractId}\` (\`${progress.contractEvmAddress}\`) still holds
**750,000 atomic USDC** for tender key \`${progress.tenderKey}\`. The release
authorization hash is unconsumed on-chain, re-confirmed through the free Mirror
Node \`contracts/call\` endpoint.

## Ledger footprint

| Kind | Count |
|---|---|
| Authorized state-changing writes (topic create + 3 messages) | **4** |
| Contract state mutations | 0 |
| x402 payments | 0 |
| USDC moved | 0 |
| Hedera query-payment \`CRYPTOTRANSFER\`s | ${progress.queryPaymentTransactions} |

The query payments are the HBAR node fee that the SDK \`ContractCallQuery\` read
path bills per call; they change no RouteGuard state and move no USDC. The
runner now performs escrow state verification through the free Mirror Node
\`contracts/call\` endpoint, so a repeat run adds none.

## Envelope-shape note

The anchored payloads use the **closed Phase A \`routeguard-hcs-2.0\` payload
shapes** unchanged (\`POD_SUBMITTED\`, \`POD_ADVISORY_ANCHORED\`,
\`POD_REVIEW_ACTION\`). Additional public-safe detail — manifest hash, adviser
engine id, finding codes, review-action / authorization / release-plan hashes —
is bound by the anchored hashes and recorded in this evidence directory rather
than widening an accepted on-chain schema.

## Next step

**Phase E1** — execute the real freight release and anchor \`ESCROW_RELEASED\`
plus \`TENDER_COMPLETED\`.
`;
  writeFileSync(path.join(EVIDENCE_DIR, "README.md"), readme, "utf8");
}

function assertNoPlaintextInEvidence(): void {
  // POD plaintext, embedded documents, key material, and raw signature bytes.
  const banned = [
    "%PDF-",
    '"contentBase64"',
    '"carrierSignature"',
    '"shipperSignature"',
    '"wrappedKeyB64"',
    '"ivB64"',
    '"authTagB64"',
    // Composed so this scanner's own marker never trips `npm run check:secrets`.
    ["BEGIN", "PRIVATE", "KEY"].join(" "),
    "ROUTEGUARD_POD_MASTER_KEY_BASE64=",
  ];
  // Raw Hiero ECDSA signatures are exactly 128 hex characters.
  const rawSignatureRe = /(?<![0-9a-fA-F])[0-9a-fA-F]{128}(?![0-9a-fA-F])/;
  for (const name of readdirSync(EVIDENCE_DIR)) {
    const full = path.join(EVIDENCE_DIR, name);
    const text = readFileSync(full, "utf8");
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
    if (p.startsWith("data/")) {
      die("GIT_LEAK", `runtime data path is tracked by git: ${p}`);
    }
  }
  console.log("EVIDENCE_PRIVACY=PASS");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== RouteGuard v2 Phase D2 live POD acceptance ===");
  publicReportEnv();

  // ---- Guards ----
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
  const tokenId = process.env.USDC_TOKEN_ID?.trim() || REQUIRED_TOKEN;
  if (tokenId !== REQUIRED_TOKEN) die("TOKEN", `token must be ${REQUIRED_TOKEN}`);

  assertBranch();
  assertWorkingTreeGuard();
  assertImmutableEvidenceUnchanged();

  if (PROJECTED_WRITES > MAX_WRITES) {
    die("WRITE_CAP", `projected ${PROJECTED_WRITES} exceeds ceiling ${MAX_WRITES}`);
  }
  console.log(
    `PROJECTED_WRITES topicCreate=1 messages=3 total=${PROJECTED_WRITES} cap=${MAX_WRITES}`,
  );

  // Completed-run guard. Evidence from a *different* run id is final and must
  // never be overwritten; evidence belonging to the run this process is
  // resuming is regenerated from the same durable progress.
  const existingSummary = readJson<{ status?: string; runId?: string }>(
    path.join(EVIDENCE_DIR, "run-summary.json"),
  );
  const priorProgress = readJson<Progress>(PROGRESS_PATH);
  if (
    existingSummary?.status === "SUCCESS" &&
    (!priorProgress || priorProgress.runId !== existingSummary.runId)
  ) {
    die("ALREADY_DONE", "a successful Phase D2 run already exists under evidence/v2/pod/");
  }
  if (!existsSync(ACCESS_EVIDENCE_DIR)) {
    die("ACCESS_EVIDENCE", "Phase B access evidence directory missing");
  }

  // ---- Live escrow evidence ----
  const escrow = readEscrowFacts();
  console.log(
    `ESCROW_EVIDENCE_OK contract=${escrow.contractId} tender=${escrow.tenderId} key=${escrow.tenderKey} locked=${escrow.lockedAtomic}`,
  );

  // ---- Secrets ----
  const masterKeyRaw = process.env.ROUTEGUARD_POD_MASTER_KEY_BASE64;
  let masterKey: Uint8Array;
  try {
    masterKey = parseMasterKeyBase64(masterKeyRaw);
  } catch {
    die(
      "POD_KEY",
      "ROUTEGUARD_POD_MASTER_KEY_BASE64 is missing or does not decode to exactly 32 bytes",
    );
  }
  console.log(`POD_MASTER_KEY=PRESENT bytes=${masterKey.length}`);
  if (!present("ROUTEGUARD_ACCESS_TREASURY_ACCOUNT_ID")) {
    die("ENV_MISSING", "ROUTEGUARD_ACCESS_TREASURY_ACCOUNT_ID is required");
  }

  if (!present("SHIPPER_PRIVATE_KEY")) die("ENV_MISSING", "SHIPPER_PRIVATE_KEY required");
  const carrierKeyEnv = present("FINAL_DEMO_CARRIER_ALPHA_PRIVATE_KEY")
    ? "FINAL_DEMO_CARRIER_ALPHA_PRIVATE_KEY"
    : "CARRIER_PRIVATE_KEY";
  if (!present(carrierKeyEnv)) {
    die("ENV_MISSING", "carrier signing key required");
  }
  const shipperKey = parseEcdsaKey("SHIPPER_PRIVATE_KEY", requireEnv("SHIPPER_PRIVATE_KEY"));
  const carrierKey = parseEcdsaKey(carrierKeyEnv, requireEnv(carrierKeyEnv));
  const shipperPublicKey = compressedPublicKey("shipper signing key", shipperKey);
  const carrierPublicKey = compressedPublicKey("carrier signing key", carrierKey);
  const shipperFingerprint = sha256Hex(shipperPublicKey);
  const carrierFingerprint = sha256Hex(carrierPublicKey);
  console.log(
    `SIGNING_KEYS shipper=PRESENT carrier=PRESENT shipperFingerprint=${shipperFingerprint.slice(0, 16)}… carrierFingerprint=${carrierFingerprint.slice(0, 16)}…`,
  );

  const shipperAccountId = requireEnv("SHIPPER_ACCOUNT_ID");
  const carrierAccountId = present("FINAL_DEMO_CARRIER_ALPHA_ACCOUNT_ID")
    ? requireEnv("FINAL_DEMO_CARRIER_ALPHA_ACCOUNT_ID")
    : requireEnv("CARRIER_ACCOUNT_ID");
  if (shipperAccountId !== escrow.shipperAccountId) {
    die("ACCOUNT", "configured shipper does not match the live escrow shipper");
  }
  if (carrierAccountId !== escrow.carrierAccountId) {
    die("ACCOUNT", "configured carrier does not match the live escrow winner");
  }
  const operatorAccountId = present("OPERATOR_ACCOUNT_ID")
    ? requireEnv("OPERATOR_ACCOUNT_ID")
    : shipperAccountId;
  const operatorKey = present("OPERATOR_PRIVATE_KEY")
    ? parseEcdsaKey("OPERATOR_PRIVATE_KEY", requireEnv("OPERATOR_PRIVATE_KEY"))
    : shipperKey;

  // ---- Phase D1 focused tests ----
  console.log("PREFLIGHT_D1_TESTS...");
  try {
    execFileSync(
      "npx",
      ["vitest", "run", "test/v2-pod-workflow.test.ts", "test/v2-authorization-signatures.test.ts"],
      { stdio: "inherit", shell: true },
    );
  } catch {
    die("TESTS", "Phase D1 focused tests failed");
  }
  console.log("PREFLIGHT_D1_TESTS=PASS");

  // ---- Operator balance ----
  const operatorAcc = await mirrorAccount(operatorAccountId);
  console.log(`OPERATOR account=${operatorAccountId} hbar_tinybars=${operatorAcc.hbarTinybars}`);
  if (operatorAcc.hbarTinybars < MIN_OPERATOR_TINYBARS) {
    die(
      "BALANCE",
      `operator HBAR ${operatorAcc.hbarTinybars} below ${MIN_OPERATOR_TINYBARS} tinybars required for four HCS writes`,
    );
  }

  // ---- Resume / identity ----
  mkdirSync(DATA_DIR, { recursive: true });
  let progress = readJson<Progress>(PROGRESS_PATH);
  if (progress && progress.schemaVersion !== PROGRESS_SCHEMA) {
    die("PROGRESS", "unsupported progress schema; refusing to continue");
  }
  if (progress?.status === "SUCCESS") {
    console.log(`ALREADY_SUCCESS runId=${progress.runId} — returning existing summary`);
    const advisory = readJson<PodAdvisoryReport>(ADVISORY_PRIVATE_PATH);
    if (!advisory) {
      die("ADVISORY", "completed run is missing its durable advisory report");
    }
    if (!progress.contractStateBefore) {
      die("PROGRESS", "completed run is missing its pre-run contract snapshot");
    }
    progress.contractStateRecheck = await readContractState(
      progress,
      progress.releasePlan?.authorizationHash ?? null,
    );
    assertEscrowUntouched(progress.contractStateRecheck, "CONTRACT_STATE_RECHECK");
    progress.queryPaymentTransactions = await countQueryPayments(progress);
    saveProgress(progress);
    writeEvidencePackage(
      progress,
      buildPreflightDoc({
        progress,
        escrow,
        identities: {
          operatorAccountId,
          shipperAccountId,
          carrierAccountId,
          shipperPublicKey,
          carrierPublicKey,
        },
        operatorTinybars: operatorAcc.hbarTinybars,
        liveState: progress.contractStateBefore,
      }),
      advisory,
    );
    assertNoPlaintextInEvidence();
    assertImmutableEvidenceUnchanged();
    printReturn(progress);
    return;
  }

  if (!progress || progress.status === "FAILED") {
    const runId = stableRunId();
    const base = new Date().toISOString();
    const tenderHash = canonicalSha256({
      schema: "routeguard-v2-phase-d2-tender-binding-1.0",
      tenderId: escrow.tenderId,
      tenderVersion: escrow.tenderVersion,
      tenderKey: escrow.tenderKey,
      contractId: escrow.contractId,
      contractEvmAddress: escrow.contractEvmAddress,
      escrowRunId: escrow.runId,
    });
    progress = {
      schemaVersion: PROGRESS_SCHEMA,
      runId,
      status: "IN_PROGRESS",
      network: REQUIRED_NETWORK,
      tokenId,
      escrowRunId: escrow.runId,
      contractId: escrow.contractId,
      contractEvmAddress: escrow.contractEvmAddress,
      tenderId: escrow.tenderId,
      tenderVersion: escrow.tenderVersion,
      tenderKey: escrow.tenderKey,
      tenderHash,
      winningBidId: `BID-WIN-${escrow.runId}`,
      decisionManifestHash: escrow.decisionManifestHash,
      operatorAccountId,
      shipperAccountId,
      carrierAccountId,
      budgetAtomic: escrow.budgetAtomic,
      winningAtomic: escrow.winningAtomic,
      excessAtomic: escrow.excessAtomic,
      lockedAtomic: escrow.lockedAtomic,
      shipperKeyFingerprint: shipperFingerprint,
      carrierKeyFingerprint: carrierFingerprint,
      podId: `POD-${runId}`,
      podVersion: 1,
      times: {
        base,
        fund: shiftIso(base, -28_800),
        auctionEnds: shiftIso(base, -21_600),
        close: shiftIso(base, -21_600),
        winner: shiftIso(base, -18_000),
        reserve: shiftIso(base, -14_400),
        delivery: shiftIso(base, -7_200),
        submit: base,
        reviewStart: base,
        accept: base,
      },
      actionIds: {
        fund: `act-${runId}-fund`,
        activate: `act-${runId}-activate`,
        bidding: `act-${runId}-bidding`,
        close: `act-${runId}-close`,
        winner: `act-${runId}-winner`,
        allocate: `act-${runId}-allocate`,
        reserve: `act-${runId}-reserve`,
        transit: `act-${runId}-transit`,
        delivery: `act-${runId}-delivery`,
        podSubmit: `act-${runId}-pod-submit`,
        review: `act-${runId}-review`,
        accept: `act-${runId}-accept`,
        fundingTxId: escrow.fundingTxId,
        activationTxId: escrow.registrationTxId,
        allocateTxId: escrow.allocateTxId,
        refundExcessTxId: escrow.refundExcessTxId,
      },
      topicId: null,
      topicMemo: TOPIC_MEMO,
      projectedWrites: PROJECTED_WRITES,
      successfulWrites: 0,
      writeLog: [],
      completedSteps: [],
      transactions: {},
      envelopes: {},
      pod: null,
      advisory: null,
      acceptance: null,
      releasePlan: null,
      contractStateBefore: null,
      contractStateAfter: null,
      contractStateRecheck: null,
      queryPaymentTransactions: 0,
      createdAt: base,
      updatedAt: base,
    };
    saveProgress(progress);
  } else {
    if (
      progress.shipperKeyFingerprint !== shipperFingerprint ||
      progress.carrierKeyFingerprint !== carrierFingerprint
    ) {
      die("TRUST", "configured signing identities differ from the in-progress run");
    }
    if (progress.tenderKey !== escrow.tenderKey || progress.contractId !== escrow.contractId) {
      die("ESCROW_EVIDENCE", "in-progress run is bound to a different escrow");
    }
    console.log(
      `RESUME runId=${progress.runId} completed=${progress.completedSteps.join(",") || "(none)"}`,
    );
  }
  console.log(`LIVE_RUN_ID=${progress.runId}`);
  console.log(`POD_ID=${progress.podId} v${progress.podVersion}`);

  // ---- Clients ----
  const client = Client.forTestnet();
  client.setOperator(AccountId.fromString(operatorAccountId), operatorKey);
  client.setDefaultMaxTransactionFee(new Hbar(10));

  const budget = new WriteBudget(MAX_WRITES);
  budget.successful = progress.writeLog.length;
  budget.log = [...progress.writeLog];
  console.log(`WRITE_BUDGET_RESUME successful=${budget.successful}/${MAX_WRITES}`);

  try {
    // ---- Read-only pre-run contract state ----
    const before = await readContractState(progress, null);
    assertEscrowUntouched(before, "CONTRACT_STATE_BEFORE");
    if (before.contractUsdcAtomic !== PHASE_C2_LOCKED_AMOUNT_ATOMIC) {
      die(
        "ESCROW_STATE",
        `contract USDC balance ${before.contractUsdcAtomic} !== ${PHASE_C2_LOCKED_AMOUNT_ATOMIC}`,
      );
    }
    // Keep the original pre-run snapshot on a resumed run.
    progress.contractStateBefore = progress.contractStateBefore ?? before;
    saveProgress(progress);

    // ---- Local services ----
    const keyProtector = new AesGcmMasterKeyProtector(masterKey);
    const podStore = new FilePodEncryptedStore(POD_STORE_DIR);
    const lifecycle = new LifecycleService(new FileLifecycleStore(LIFECYCLE_DIR));
    const carriers = new InMemoryCarrierRegistry([
      {
        carrierId: CARRIER_ID,
        carrierAccountId: progress.carrierAccountId,
        signingPublicKey: carrierPublicKey,
        active: true,
        allowedEquipment: ["DRY_VAN"],
        registryVersion: 1,
      },
    ]);
    const registeredCarrier = carriers.getById(CARRIER_ID);
    if (registeredCarrier?.signingPublicKey !== carrierPublicKey) {
      die("TRUST", "carrier registry key does not match the configured signing key");
    }

    const record = await ensureLifecycleRecord(
      lifecycle,
      progress,
      shipperPublicKey,
      shipperPublicKey,
    );
    console.log(`LIFECYCLE_STATE=${record.state}`);

    const podService = new PodService({
      lifecycle,
      podStore,
      keyProtector,
      carriers,
      now: () => progress!.times.submit,
      escrowContractId: progress.contractId,
      escrowContractEvm: progress.contractEvmAddress,
      requirePhaseC2LiveBindings: true,
    });

    const preflightDoc = buildPreflightDoc({
      progress,
      escrow,
      identities: {
        operatorAccountId,
        shipperAccountId,
        carrierAccountId,
        shipperPublicKey,
        carrierPublicKey,
      },
      operatorTinybars: operatorAcc.hbarTinybars,
      liveState: before,
    });
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeJson(path.join(EVIDENCE_DIR, "preflight.json"), preflightDoc);
    console.log("LIVE_PREFLIGHT=PASS");

    // ---- 1. Encrypted POD (local) ----
    const podProof = await ensurePodStored(
      podService,
      podStore,
      keyProtector,
      progress,
      carrierKey,
      carrierPublicKey,
    );
    progress.pod = podProof;
    saveProgress(progress);

    // ---- 2. Topic create (write 1) ----
    await stepCreateTopic(
      client,
      operatorKey.publicKey,
      operatorAccountId,
      progress,
      budget,
    );
    if (!isDryPreflight()) {
      await verifyTopicCreateOnMirror(progress);
      const topicInfo = await mirrorTopic(progress.topicId!);
      if (!topicInfo || topicInfo.deleted) {
        die("TOPIC", "topic not confirmed on Mirror Node");
      }
      if (topicInfo.memo !== TOPIC_MEMO) {
        die("TOPIC", "topic memo mismatch on Mirror Node");
      }
    }

    // ---- 3. POD_SUBMITTED (write 2) ----
    let podSubmittedEnvelope = progress.envelopes.pod_submitted;
    if (!podSubmittedEnvelope) {
      const { buildPodSubmittedEnvelope } = await import("../src/v2/pod/outbox");
      const current = (await lifecycle.get(progress.tenderId))!;
      podSubmittedEnvelope = buildPodSubmittedEnvelope(current, {
        sizeBytes: podProof.totalPlaintextBytes,
      });
      progress.envelopes.pod_submitted = podSubmittedEnvelope;
      saveProgress(progress);
    }
    await submitEnvelope(client, progress, budget, "pod_submitted", podSubmittedEnvelope);
    if (!isDryPreflight()) await verifyMessageOnMirror(progress, "pod_submitted");

    // ---- 4. Advisory (local) ----
    let advisory = readJson<PodAdvisoryReport>(ADVISORY_PRIVATE_PATH);
    if (!progress.advisory || !advisory) {
      const started = await podService.startReview({
        tenderId: progress.tenderId,
        tenderVersion: progress.tenderVersion,
        actionId: progress.actionIds.review!,
        eventTime: progress.times.reviewStart,
      });
      advisory = started.advisory;
      if (advisory.binding !== "NON_BINDING_ADVISORY") {
        die("ADVISORY", "adviser did not return NON_BINDING_ADVISORY");
      }
      if (started.record.state !== "POD_UNDER_REVIEW") {
        die("ADVISORY", `unexpected lifecycle state ${started.record.state}`);
      }
      writeJson(ADVISORY_PRIVATE_PATH, advisory);
      progress.advisory = {
        reportId: advisory.reportId,
        reportHash: advisory.reportHash,
        engine: advisory.engine,
        binding: advisory.binding,
        recommendation: advisory.recommendation,
        findingCodes: advisory.findings.map((f) => f.code),
        findingSeverities: advisory.findings.map((f) => f.severity),
        findingCodeHashes: advisory.findings.map(
          (f) => `sha256:${sha256Hex(`${f.code}|${f.severity}`)}`,
        ),
        createdAt: advisory.createdAt,
        implementation: "DETERMINISTIC_STUB",
        liveAiModel: false,
      };
      progress.envelopes.pod_advisory = started.outbox.find(
        (o) => o.kind === "POD_ADVISORY_ANCHORED",
      )!.envelope;
      saveProgress(progress);
    }
    console.log(
      `ADVISORY engine=${progress.advisory!.engine} binding=${progress.advisory!.binding} recommendation=${progress.advisory!.recommendation}`,
    );

    // ---- 5. POD_ADVISORY_ANCHORED (write 3) ----
    await submitEnvelope(
      client,
      progress,
      budget,
      "pod_advisory",
      progress.envelopes.pod_advisory!,
    );
    if (!isDryPreflight()) await verifyMessageOnMirror(progress, "pod_advisory");

    // ---- 6. Shipper acceptance (local) ----
    if (!progress.acceptance || !progress.releasePlan) {
      const underReview = (await lifecycle.get(progress.tenderId))!;
      if (underReview.state !== "POD_UNDER_REVIEW") {
        die("REVIEW", `expected POD_UNDER_REVIEW, got ${underReview.state}`);
      }
      const reviewDeadlineAt = underReview.reviewDeadlineAt!;
      const signPayload = buildShipperPodReviewSignPayload({
        tenderId: progress.tenderId,
        tenderVersion: progress.tenderVersion,
        podId: progress.podId,
        reviewAction: "ACCEPT",
        signedAt: progress.times.accept,
        reviewDeadlineAt,
        actionId: progress.actionIds.accept!,
      });
      const shipperSignature = signCanonicalPayload(
        signPayload,
        shipperKey.toStringRaw(),
      );
      const shipperAuth = verifyShipperPodReview({
        policy: trustPolicyFromRecord(underReview),
        tenderId: progress.tenderId,
        tenderVersion: progress.tenderVersion,
        podId: progress.podId,
        reviewAction: "ACCEPT",
        signedAt: progress.times.accept,
        reviewDeadlineAt,
        actionId: progress.actionIds.accept!,
        signature: shipperSignature,
      });
      console.log("SHIPPER_SIGNATURE=PASS");

      const reviewed = await podService.shipperReview({
        tenderId: progress.tenderId,
        tenderVersion: progress.tenderVersion,
        podId: progress.podId,
        action: "ACCEPT",
        actionId: progress.actionIds.accept!,
        signedAt: progress.times.accept,
        signature: shipperSignature,
      });
      if (reviewed.record.state !== "POD_ACCEPTED") {
        die("REVIEW", `expected POD_ACCEPTED, got ${reviewed.record.state}`);
      }
      if (!reviewed.escrowPlan) die("RELEASE_PLAN", "release plan was not built");
      const plan = reviewed.escrowPlan;
      if (plan.kind !== "RELEASE_FULL") die("RELEASE_PLAN", "unexpected plan kind");
      if (plan.contractId !== PHASE_C2_ESCROW_CONTRACT_ID) {
        die("RELEASE_PLAN", "plan is not bound to the live contract id");
      }
      if (plan.contractEvmAddress !== PHASE_C2_ESCROW_CONTRACT_EVM.toLowerCase()) {
        die("RELEASE_PLAN", "plan is not bound to the live contract EVM address");
      }
      if (plan.tenderKey !== progress.tenderKey) {
        die("RELEASE_PLAN", "plan tender key mismatch");
      }
      if (plan.lockedAmountAtomic !== PHASE_C2_LOCKED_AMOUNT_ATOMIC) {
        die("RELEASE_PLAN", "plan locked amount mismatch");
      }
      if (plan.networkWrite !== false) {
        die("RELEASE_PLAN", "plan is not marked as unsubmitted");
      }

      const reviewActionEnvelope = reviewed.outbox.find(
        (o) => o.kind === "POD_REVIEW_ACTION",
      )!.envelope;

      progress.acceptance = {
        actionId: progress.actionIds.accept!,
        action: "ACCEPT",
        signedAt: progress.times.accept,
        reviewDeadlineAt,
        shipperKeyFingerprint: shipperAuth.trustedKeyFingerprint,
        authPayloadHash: shipperAuth.payloadHash,
        reviewActionHash: canonicalSha256(reviewActionEnvelope.payload),
        signatureVerified: true,
        lifecycleStateBefore: "POD_UNDER_REVIEW",
        lifecycleStateAfter: reviewed.record.state,
      };
      progress.releasePlan = {
        kind: "RELEASE_FULL",
        contractId: plan.contractId,
        contractEvmAddress: plan.contractEvmAddress,
        tenderId: plan.tenderId,
        tenderVersion: plan.tenderVersion,
        tenderKey: plan.tenderKey,
        lockedAmountAtomic: plan.lockedAmountAtomic,
        authorizationHash: plan.authorizationHash,
        contractFunction: plan.plan.contractFunction,
        functionSignature: plan.plan.functionSignature,
        signerRole: plan.plan.signerRole,
        gasLimit: plan.plan.gasLimit,
        argTypes: plan.plan.args.map((a) => a.type),
        planHash: canonicalSha256({
          contractId: plan.contractId,
          contractEvmAddress: plan.contractEvmAddress,
          tenderKey: plan.tenderKey,
          lockedAmountAtomic: plan.lockedAmountAtomic,
          authorizationHash: plan.authorizationHash,
          functionSignature: plan.plan.functionSignature,
          args: plan.plan.args,
        }),
        submitted: false,
      };
      progress.envelopes.pod_review_action = reviewActionEnvelope;
      saveProgress(progress);
    }
    console.log(
      `POD_ACCEPTED authHash=${progress.releasePlan!.authorizationHash} planHash=${progress.releasePlan!.planHash}`,
    );

    // ---- 7. POD_REVIEW_ACTION (write 4) ----
    await submitEnvelope(
      client,
      progress,
      budget,
      "pod_review_action",
      progress.envelopes.pod_review_action!,
    );
    if (!isDryPreflight()) await verifyMessageOnMirror(progress, "pod_review_action");

    if (isDryPreflight()) {
      console.log("--- RESULT ---");
      console.log("LIVE_PREFLIGHT=PASS");
      console.log(`LIVE_RUN_ID=${progress.runId}`);
      console.log("POD_MASTER_KEY=PRESENT");
      console.log("CARRIER_SIGNATURE=PASS");
      console.log("POD_VALIDATION=PASS");
      console.log("POD_ENCRYPTION=PASS");
      console.log("POD_PLAINTEXT_PERSISTED=NO");
      console.log(`ADVISER_IMPLEMENTATION=${progress.advisory!.implementation}`);
      console.log(`ADVISER_NON_BINDING=PASS`);
      console.log("SHIPPER_SIGNATURE=PASS");
      console.log(
        `SHIPPER_ACCEPTANCE=${progress.acceptance!.lifecycleStateAfter === "POD_ACCEPTED" ? "PASS" : "FAIL"}`,
      );
      console.log("RELEASE_PLAN=PASS");
      console.log("RELEASE_PLAN_SUBMITTED=NO");
      console.log("DRY_PREFLIGHT=STOPPED_BEFORE_ANY_WRITE");
      console.log("NETWORK_WRITES=0");
      return;
    }

    // ---- 8. Post-run contract check ----
    const after = await readContractState(
      progress,
      progress.releasePlan!.authorizationHash,
    );
    assertEscrowUntouched(after, "CONTRACT_STATE_AFTER");
    if (after.releaseAuthorizationHashUsed !== false) {
      die("ESCROW_STATE", "release authorization hash unexpectedly consumed");
    }
    const baseline = progress.contractStateBefore!;
    if (after.carrierUsdcAtomic !== baseline.carrierUsdcAtomic) {
      die("ESCROW_STATE", "carrier USDC balance changed during the run");
    }
    if (after.contractUsdcAtomic !== baseline.contractUsdcAtomic) {
      die("ESCROW_STATE", "escrow contract USDC balance changed during the run");
    }
    if (after.tenderBalanceAtomic !== baseline.tenderBalanceAtomic) {
      die("ESCROW_STATE", "escrow tender balance changed during the run");
    }
    progress.contractStateAfter = after;

    // ---- 9. Ordering ----
    const sequences = MESSAGE_STEPS.map((s) => progress!.transactions[s]?.sequenceNumber ?? -1);
    if (!(sequences[0]! > 0 && sequences[0]! < sequences[1]! && sequences[1]! < sequences[2]!)) {
      die("ORDERING", `HCS sequence ordering invalid: ${sequences.join(",")}`);
    }
    const txIds = (["topic_create", ...MESSAGE_STEPS] as StepName[]).map(
      (s) => progress!.transactions[s]?.transactionId ?? "",
    );
    if (new Set(txIds).size !== txIds.length) {
      die("ORDERING", "duplicate transaction ids recorded");
    }

    if (budget.successful !== PROJECTED_WRITES) {
      die("WRITE_CAP", `expected exactly ${PROJECTED_WRITES} writes, got ${budget.successful}`);
    }

    progress.contractStateRecheck = after;
    progress.queryPaymentTransactions = await countQueryPayments(progress);
    progress.status = "SUCCESS";
    progress.successfulWrites = budget.successful;
    progress.writeLog = [...budget.log];
    saveProgress(progress);

    const advisoryReport = readJson<PodAdvisoryReport>(ADVISORY_PRIVATE_PATH)!;
    writeEvidencePackage(progress, preflightDoc, advisoryReport);
    assertNoPlaintextInEvidence();
    assertImmutableEvidenceUnchanged();
    printReturn(progress);
  } finally {
    client.close();
  }
}

function printReturn(progress: Progress): void {
  const tx = progress.transactions;
  const seq = (s: StepName) => tx[s]?.sequenceNumber ?? "NONE";
  const id = (s: StepName) => tx[s]?.transactionId ?? "NONE";
  const sequences = MESSAGE_STEPS.map((s) => tx[s]?.sequenceNumber ?? -1);
  const ordered =
    sequences[0]! > 0 && sequences[0]! < sequences[1]! && sequences[1]! < sequences[2]!;

  console.log("--- RESULT ---");
  console.log("LIVE_PREFLIGHT=PASS");
  console.log(`LIVE_RUN_ID=${progress.runId}`);
  console.log("POD_MASTER_KEY=PRESENT");
  console.log(`CARRIER_SIGNATURE=${progress.pod?.carrierSignatureVerified ? "PASS" : "FAIL"}`);
  console.log(`POD_VALIDATION=${progress.pod ? "PASS" : "FAIL"}`);
  console.log(`POD_ENCRYPTION=${progress.pod?.ciphertextHash ? "PASS" : "FAIL"}`);
  console.log("POD_PLAINTEXT_PERSISTED=NO");
  console.log(
    `POD_STORAGE_RESTART=${progress.pod?.decryptRoundTripVerified ? "PASS" : "FAIL"}`,
  );
  console.log(
    `HCS_TOPIC_CREATE=${progress.completedSteps.includes("topic_create") ? "PASS" : "FAIL"}`,
  );
  console.log(`HCS_TOPIC_ID=${progress.topicId ?? "NONE"}`);
  console.log(`HCS_TOPIC_CREATE_TX=${id("topic_create")}`);
  console.log(
    `POD_SUBMITTED_HCS=${progress.completedSteps.includes("pod_submitted") ? "PASS" : "FAIL"}`,
  );
  console.log(`POD_SUBMITTED_TX=${id("pod_submitted")}`);
  console.log(`POD_SUBMITTED_SEQUENCE=${seq("pod_submitted")}`);
  console.log(`ADVISER_IMPLEMENTATION=${progress.advisory?.implementation ?? "FAIL"}`);
  console.log(
    `ADVISER_NON_BINDING=${progress.advisory?.binding === "NON_BINDING_ADVISORY" ? "PASS" : "FAIL"}`,
  );
  console.log(
    `POD_ADVISORY_HCS=${progress.completedSteps.includes("pod_advisory") ? "PASS" : "FAIL"}`,
  );
  console.log(`POD_ADVISORY_TX=${id("pod_advisory")}`);
  console.log(`POD_ADVISORY_SEQUENCE=${seq("pod_advisory")}`);
  console.log(
    `SHIPPER_SIGNATURE=${progress.acceptance?.signatureVerified ? "PASS" : "FAIL"}`,
  );
  console.log(
    `SHIPPER_ACCEPTANCE=${progress.acceptance?.lifecycleStateAfter === "POD_ACCEPTED" ? "PASS" : "FAIL"}`,
  );
  console.log(`RELEASE_PLAN=${progress.releasePlan ? "PASS" : "FAIL"}`);
  console.log("RELEASE_PLAN_SUBMITTED=NO");
  console.log(
    `POD_REVIEW_HCS=${progress.completedSteps.includes("pod_review_action") ? "PASS" : "FAIL"}`,
  );
  console.log(`POD_REVIEW_TX=${id("pod_review_action")}`);
  console.log(`POD_REVIEW_SEQUENCE=${seq("pod_review_action")}`);
  console.log(`HCS_ORDERING=${ordered ? "PASS" : "FAIL"}`);
  console.log(`ESCROW_CONTRACT_STATE=${progress.contractStateAfter?.state ?? "OTHER"}`);
  console.log(
    `LOCKED_AMOUNT_ATOMIC=${progress.contractStateAfter?.tenderBalanceAtomic ?? "OTHER"}`,
  );
  console.log("CARRIER_FREIGHT_RELEASED_ATOMIC=0");
  console.log("HCS_TOPIC_CREATIONS=1");
  console.log(
    `HCS_MESSAGE_WRITES=${MESSAGE_STEPS.filter((s) => progress.completedSteps.includes(s)).length}`,
  );
  console.log("CONTRACT_NETWORK_WRITES=0");
  console.log("X402_NETWORK_WRITES=0");
  console.log("OTHER_HEDERA_WRITES=0");
  console.log("EVIDENCE_V2_POD=PASS");
  console.log("PRIVATE_DATA_EXPOSED=NO");
  console.log(`NETWORK_WRITES=${progress.successfulWrites}`);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message.slice(0, 300) : "unknown error";
  console.error(`FAIL [UNCAUGHT]: ${msg}`);
  process.exit(1);
});
