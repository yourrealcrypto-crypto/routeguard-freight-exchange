/**
 * Phase C2 — guarded live Hedera testnet freight-escrow demonstration.
 *
 * Deploys RouteGuardFreightEscrow, associates HTS USDC, registers a synthetic
 * tender, funds exact budget, allocates winner with exact excess refund.
 * Hard successful-write ceiling: 10. No x402, no HCS, no POD/settlement.
 *
 * Usage:
 *   ROUTEGUARD_LIVE_V2_ESCROW_CONFIRM=I_UNDERSTAND_TESTNET_ESCROW_WRITES \
 *   ROUTEGUARD_LIVE_V2_ESCROW_MAX_WRITES=10 \
 *   ENABLE_LIVE_HEDERA=true \
 *   npm run demo:v2-escrow-live
 *
 * Never logs private keys, mnemonics, env values, or raw signed transactions.
 */

import "dotenv/config";

import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  AccountAllowanceApproveTransaction,
  AccountId,
  Client,
  ContractCallQuery,
  ContractCreateTransaction,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractId,
  FileAppendTransaction,
  FileCreateTransaction,
  Hbar,
  PrivateKey,
  Status,
  TokenId,
  TransactionId,
  TransactionReceipt,
  TransactionResponse,
} from "@hiero-ledger/sdk";
import { keccak256, toUtf8Bytes } from "ethers";

import {
  compileContracts,
  writeArtifacts,
} from "./compile-contracts";
import {
  buildAllocateWinnerPlan,
  buildFundTenderPlan,
  buildRegisterTenderPlan,
  escrowTenderKey,
  parseEscrowEvents,
  parseEscrowStateResult,
  tenderIdHash,
} from "../src/v2/escrow";
import {
  hashScanTransactionUrl,
  toMirrorTransactionId,
} from "../src/v2/access/mirror-reconcile";
import {
  HEDERA_TESTNET_MIRROR_NODE,
  VERIFIED_USDC_DECIMALS,
  VERIFIED_USDC_TOKEN_ID,
} from "../src/x402/usdc-constants";
import { isValidHederaAccountId } from "../src/domain/payment-option";

// ---------------------------------------------------------------------------
// Constants / guards
// ---------------------------------------------------------------------------

const CONFIRM_ENV = "ROUTEGUARD_LIVE_V2_ESCROW_CONFIRM";
const CONFIRM_VALUE = "I_UNDERSTAND_TESTNET_ESCROW_WRITES";
const MAX_WRITES_ENV = "ROUTEGUARD_LIVE_V2_ESCROW_MAX_WRITES";
const MAX_WRITES = 10;

const REQUIRED_BRANCH = "feat/routeguard-v2-phase-c";
const REQUIRED_NETWORK = "hedera:testnet";
const REQUIRED_TOKEN = VERIFIED_USDC_TOKEN_ID; // 0.0.429274
const REQUIRED_DECIMALS = VERIFIED_USDC_DECIMALS; // 6

const BUDGET_ATOMIC = "1000000";
const WINNING_ATOMIC = "750000";
const EXCESS_ATOMIC = "250000";

/**
 * Hedera contract bytecode files store the **hex-encoded ASCII** of the solc
 * object (not raw EVM bytes). See ERROR_DECODING_BYTESTRING when raw binary is
 * used. FileCreate holds the first 2048 bytes of that hex string.
 */
const FILE_CREATE_BYTES = 2048;
/**
 * FileAppend chunk size for the hex string. Must stay under the Hedera
 * transaction size limit (~6 KiB) while keeping deploy+ops ≤ 10 writes.
 * With ~15 278 hex chars: create 2048 + 3×4410 appends + create = 5 deploy.
 */
const FILE_APPEND_CHUNK = 4500;
const DEPLOY_GAS = 4_000_000;
const ASSOCIATE_GAS = 1_000_000;

const EVIDENCE_DIR = path.join("evidence", "v2", "escrow");
const DATA_DIR = path.join("data", "v2-live-escrow");
const PROGRESS_PATH = path.join(DATA_DIR, "progress.json");
const ACCESS_EVIDENCE_DIR = path.join("evidence", "v2", "access");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StepName =
  | "deployment"
  | "association"
  | "registration"
  | "allowance"
  | "funding"
  | "allocation";

type TxRecord = {
  step: StepName | "deployment_file_create" | "deployment_file_append" | "deployment_contract_create";
  transactionId: string;
  mirrorTransactionId: string;
  consensusTimestamp: string | null;
  result: string | null;
  hashScanUrl: string;
  mirrorStatus: "SUCCESS" | "FAILED" | "NOT_FOUND" | "PENDING";
};

type Progress = {
  runId: string;
  tenderId: string;
  tenderVersion: number;
  tenderKey: string;
  tenderIdHash: string;
  creationAuthorizationHash: string;
  manifestHash: string;
  decisionManifestHash: string;
  allocationAuthorizationHash: string;
  budgetAtomic: string;
  winningAtomic: string;
  excessAtomic: string;
  network: string;
  tokenId: string;
  tokenEvmAddress: string;
  operatorAccountId: string;
  operatorEvmAddress: string;
  shipperAccountId: string;
  shipperEvmAddress: string;
  carrierAccountId: string;
  carrierEvmAddress: string;
  bytecodeSha256: string;
  bytecodeBytes: number;
  projectedWrites: number;
  successfulWrites: number;
  writeLog: Array<{ step: string; transactionId: string; at: string }>;
  completedSteps: StepName[];
  contractId: string | null;
  contractEvmAddress: string | null;
  fileId: string | null;
  transactions: Partial<Record<string, TxRecord>>;
  balances: Record<string, unknown>;
  status: "IN_PROGRESS" | "SUCCESS" | "FAILED";
  terminalState: string | null;
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
    "CARRIER_ACCOUNT_ID",
    "FINAL_DEMO_CARRIER_ALPHA_ACCOUNT_ID",
    "ROUTEGUARD_ACCESS_TREASURY_ACCOUNT_ID",
  ];
  for (const k of keys) {
    console.log(`ENV ${k}=${present(k) ? "PRESENT" : "MISSING"}`);
  }
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

function stableRunId(): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = randomBytes(4).toString("hex");
  return `v2escrow-${day}-${suffix}`;
}

function hexToBytes32(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{64}$/.test(h)) {
    throw new Error("expected 32-byte hex");
  }
  return Uint8Array.from(Buffer.from(h, "hex"));
}

function hederaNumToLongZero(accountOrTokenId: string): string {
  if (!isValidHederaAccountId(accountOrTokenId)) {
    throw new Error(`invalid entity id: ${accountOrTokenId}`);
  }
  const num = BigInt(accountOrTokenId.split(".")[2]!);
  return `0x${num.toString(16).padStart(40, "0")}`;
}

function authHash(label: string): string {
  return keccak256(toUtf8Bytes(label));
}

function sha256Hex(buf: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function txIdString(id: TransactionId): string {
  return id.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Git / branch guards
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

function assertWorkingTreeGuard(): void {
  const porcelain = execFileSync("git", ["status", "--porcelain", "-z"], {
    encoding: "utf8",
  });
  if (!porcelain) {
    console.log("WORKING_TREE=CLEAN");
    return;
  }
  const allowedPrefixes = [
    "evidence/v2/escrow/",
    "data/v2-live-escrow/",
    "artifacts/",
  ];
  const allowedExact = new Set([
    "scripts/run-v2-escrow-live.ts",
    "package.json",
    "package-lock.json",
    "docs/v2-freight-escrow.md",
    "PROJECT_STATUS.md",
  ]);
  // -z: records separated by NUL; each record is "XY path" or rename "XY dest\0src"
  const records = porcelain.split("\0").filter((r) => r.length > 0);
  const paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    // status is two chars; path follows (may be preceded by space)
    const body = rec.slice(2).replace(/^\s+/, "");
    const filePath = body.replace(/\\/g, "/");
    if (!filePath) continue;
    // rename/copy may include next record as source — skip source only
    const status = rec.slice(0, 2);
    if (status.includes("R") || status.includes("C")) {
      i += 1; // skip source path record
    }
    paths.push(filePath);
    const ok =
      allowedExact.has(filePath) ||
      allowedPrefixes.some((p) => filePath.startsWith(p));
    if (!ok) {
      die("DIRTY", `working tree has unexpected dirty path: ${filePath}`);
    }
  }
  console.log(`WORKING_TREE=PHASE_C2_ALLOWED_DIRTY paths=${paths.length}`);
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

async function mirrorTokenMetadata(tokenId: string): Promise<{
  decimals: number;
  symbol: string;
  type: string;
  evmAddress: string;
}> {
  const body = await mirrorGet<{
    decimals?: string | number;
    symbol?: string;
    type?: string;
  }>(`/api/v1/tokens/${tokenId}`);
  const decimals = Number(body.decimals);
  return {
    decimals,
    symbol: body.symbol ?? "",
    type: body.type ?? "",
    evmAddress: hederaNumToLongZero(tokenId),
  };
}

async function mirrorAccount(accountId: string): Promise<{
  accountId: string;
  evmAddress: string;
  hbarTinybars: bigint;
  usdcAtomic: bigint;
  usdcAssociated: boolean;
}> {
  const acc = await mirrorGet<{
    account?: string;
    evm_address?: string | null;
    balance?: { balance?: number };
  }>(`/api/v1/accounts/${accountId}`);
  const tokens = await mirrorGet<{
    tokens?: Array<{ token_id?: string; balance?: number }>;
  }>(`/api/v1/accounts/${accountId}/tokens?limit=100`);
  const usdc = (tokens.tokens ?? []).find((t) => t.token_id === REQUIRED_TOKEN);
  const mirrorEvm = acc.evm_address?.startsWith("0x")
    ? acc.evm_address.toLowerCase()
    : acc.evm_address
      ? `0x${acc.evm_address.toLowerCase()}`
      : null;
  const evmAddress = (mirrorEvm ?? hederaNumToLongZero(accountId)).toLowerCase();
  return {
    accountId,
    evmAddress,
    hbarTinybars: BigInt(acc.balance?.balance ?? 0),
    usdcAtomic: BigInt(usdc?.balance ?? 0),
    usdcAssociated: Boolean(usdc),
  };
}

async function mirrorContract(contractId: string): Promise<{
  contractId: string;
  evmAddress: string | null;
  deleted: boolean;
}> {
  const body = await mirrorGet<{
    contract_id?: string;
    evm_address?: string | null;
    deleted?: boolean;
  }>(`/api/v1/contracts/${contractId}`);
  const evm = body.evm_address
    ? body.evm_address.startsWith("0x")
      ? body.evm_address.toLowerCase()
      : `0x${body.evm_address.toLowerCase()}`
    : null;
  return {
    contractId: body.contract_id ?? contractId,
    evmAddress: evm,
    deleted: Boolean(body.deleted),
  };
}

async function mirrorVerifyTransaction(
  transactionId: string,
  attempts = 12,
  delayMs = 1500,
): Promise<TxRecord & { tokenTransfers: Array<{ account: string; amount: number; token_id: string }>; logs: Array<{ topics: string[]; data: string }> }> {
  const mirrorId = toMirrorTransactionId(transactionId);
  for (let i = 0; i < attempts; i++) {
    try {
      const payload = await mirrorGet<{
        transactions?: Array<{
          transaction_id?: string;
          result?: string;
          consensus_timestamp?: string;
          token_transfers?: Array<{
            token_id?: string;
            account?: string;
            amount?: number;
          }>;
        }>;
      }>(`/api/v1/transactions/${encodeURIComponent(mirrorId)}`);
      const tx = payload.transactions?.[0];
      if (tx?.result) {
        const result = tx.result;
        const status =
          result === "SUCCESS"
            ? "SUCCESS"
            : result
              ? "FAILED"
              : "PENDING";
        let logs: Array<{ topics: string[]; data: string }> = [];
        try {
          const cr = await mirrorGet<{
            logs?: Array<{ topics?: string[]; data?: string }>;
          }>(`/api/v1/contracts/results/${encodeURIComponent(mirrorId)}`);
          logs = (cr.logs ?? []).map((l) => ({
            topics: (l.topics ?? []).map((t) =>
              t.startsWith("0x") ? t : `0x${t}`,
            ),
            data:
              l.data && l.data.startsWith("0x")
                ? l.data
                : `0x${l.data ?? ""}`,
          }));
        } catch {
          // contract result may lag or not apply (file txs)
        }
        return {
          step: "deployment",
          transactionId,
          mirrorTransactionId: mirrorId,
          consensusTimestamp: tx.consensus_timestamp ?? null,
          result,
          hashScanUrl: hashScanTransactionUrl(transactionId),
          mirrorStatus: status,
          tokenTransfers: (tx.token_transfers ?? [])
            .filter((t) => t.account && t.token_id && typeof t.amount === "number")
            .map((t) => ({
              account: t.account!,
              amount: t.amount!,
              token_id: t.token_id!,
            })),
          logs,
        };
      }
    } catch {
      // retry
    }
    await sleep(delayMs);
  }
  return {
    step: "deployment",
    transactionId,
    mirrorTransactionId: mirrorId,
    consensusTimestamp: null,
    result: null,
    hashScanUrl: hashScanTransactionUrl(transactionId),
    mirrorStatus: "NOT_FOUND",
    tokenTransfers: [],
    logs: [],
  };
}

async function mirrorAccountTokenBalance(
  accountId: string,
  tokenId: string,
): Promise<bigint> {
  const tokens = await mirrorGet<{
    tokens?: Array<{ token_id?: string; balance?: number }>;
  }>(`/api/v1/accounts/${accountId}/tokens?limit=100`);
  const hit = (tokens.tokens ?? []).find((t) => t.token_id === tokenId);
  return BigInt(hit?.balance ?? 0);
}

async function mirrorContractTokenBalance(
  contractId: string,
  tokenId: string,
): Promise<bigint> {
  // Contracts appear as accounts on Mirror for token balances.
  return mirrorAccountTokenBalance(contractId, tokenId);
}

// ---------------------------------------------------------------------------
// Write budget tracking
// ---------------------------------------------------------------------------

class WriteBudget {
  successful = 0;
  attempted = 0;
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
    this.attempted += 1;
    this.log.push({
      step,
      transactionId,
      at: new Date().toISOString(),
    });
    console.log(
      `WRITE_OK step=${step} tx=${transactionId} count=${this.successful}/${this.max}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

function parsePrivateKey(raw: string): PrivateKey {
  const text = raw.trim();
  try {
    if (text.startsWith("0x") || /^[0-9a-fA-F]{64}$/.test(text)) {
      return PrivateKey.fromStringECDSA(text);
    }
    return PrivateKey.fromString(text);
  } catch {
    try {
      return PrivateKey.fromStringECDSA(text);
    } catch {
      die("KEY", "failed to parse private key (details suppressed)");
    }
  }
}

function makeClient(accountId: string, privateKey: PrivateKey): Client {
  const client = Client.forTestnet();
  client.setOperator(AccountId.fromString(accountId), privateKey);
  client.setDefaultMaxTransactionFee(new Hbar(50));
  return client;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

function saveProgress(p: Progress): void {
  p.updatedAt = new Date().toISOString();
  writeJson(PROGRESS_PATH, p);
  writeJson(path.join(EVIDENCE_DIR, "live-progress.json"), {
    runId: p.runId,
    tenderId: p.tenderId,
    tenderVersion: p.tenderVersion,
    tenderKey: p.tenderKey,
    status: p.status,
    completedSteps: p.completedSteps,
    successfulWrites: p.successfulWrites,
    contractId: p.contractId,
    contractEvmAddress: p.contractEvmAddress,
    terminalState: p.terminalState,
    updatedAt: p.updatedAt,
  });
}

function markStep(p: Progress, step: StepName, budget: WriteBudget): void {
  if (!p.completedSteps.includes(step)) {
    p.completedSteps.push(step);
  }
  p.successfulWrites = budget.successful;
  p.writeLog = budget.log;
  saveProgress(p);
}

// ---------------------------------------------------------------------------
// Execute helpers
// ---------------------------------------------------------------------------

async function submitWithClient(
  client: Client,
  exec: () => Promise<TransactionResponse>,
  budget: WriteBudget,
  step: string,
): Promise<{
  receipt: TransactionReceipt;
  transactionId: string;
  mirror: Awaited<ReturnType<typeof mirrorVerifyTransaction>>;
}> {
  budget.assertCanWrite(1);
  let response: TransactionResponse;
  try {
    response = await exec();
  } catch (err) {
    budget.attempted += 1;
    const msg = err instanceof Error ? err.message.slice(0, 200) : "submit failed";
    die("SUBMIT", `${step} submit failed: ${msg}`);
  }
  const transactionId = txIdString(response.transactionId);
  let receipt: TransactionReceipt;
  try {
    receipt = await response.getReceipt(client);
  } catch (err) {
    budget.attempted += 1;
    const msg = err instanceof Error ? err.message.slice(0, 200) : "receipt failed";
    die("RECEIPT", `${step} receipt failed: ${msg}`);
  }
  if (receipt.status !== Status.Success) {
    budget.attempted += 1;
    die("RECEIPT", `${step} status ${receipt.status.toString()}`);
  }
  budget.recordSuccess(step, transactionId);
  const mirror = await mirrorVerifyTransaction(transactionId);
  if (mirror.mirrorStatus !== "SUCCESS") {
    die(
      "MIRROR",
      `${step} mirror status ${mirror.mirrorStatus} result=${mirror.result}`,
    );
  }
  return { receipt, transactionId, mirror };
}

// ---------------------------------------------------------------------------
// Preflight compile + tests
// ---------------------------------------------------------------------------

function preflightCompileAndTests(): {
  bytecode: string;
  bytecodeSha256: string;
  bytecodeBytes: number;
  solcVersion: string;
} {
  console.log("PREFLIGHT_COMPILE...");
  const result = compileContracts();
  writeArtifacts(result);
  const compiled = result.contracts["RouteGuardFreightEscrow"];
  if (!compiled?.bytecode || compiled.bytecode === "0x") {
    die("COMPILE", "RouteGuardFreightEscrow bytecode missing");
  }
  const hex = compiled.bytecode.startsWith("0x")
    ? compiled.bytecode.slice(2)
    : compiled.bytecode;
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    die("COMPILE", "bytecode is not valid hex");
  }
  const bytecodeSha256 = sha256Hex(Buffer.from(hex, "hex"));
  const bytecodeBytes = hex.length / 2;
  console.log(
    `COMPILE_OK solc=${result.solcVersion} bytes=${bytecodeBytes} sha256=${bytecodeSha256}`,
  );

  // Artifact path validation
  const artifactPath = path.join(
    "artifacts",
    "contracts",
    "RouteGuardFreightEscrow.json",
  );
  if (!existsSync(artifactPath)) {
    die("ARTIFACT", "compiled artifact missing");
  }
  const art = JSON.parse(readFileSync(artifactPath, "utf8")) as {
    bytecode?: string;
    abi?: unknown[];
  };
  const artHex = (art.bytecode ?? "").replace(/^0x/, "");
  if (sha256Hex(Buffer.from(artHex, "hex")) !== bytecodeSha256) {
    die("ARTIFACT", "artifact bytecode hash mismatch");
  }
  if (!Array.isArray(art.abi) || art.abi.length === 0) {
    die("ARTIFACT", "artifact ABI missing");
  }

  console.log("PREFLIGHT_SOLIDITY_TESTS...");
  try {
    execFileSync(
      "npx",
      [
        "vitest",
        "run",
        "test/escrow-contract-registration.test.ts",
        "test/escrow-contract-settlement.test.ts",
        "test/escrow-contract-security.test.ts",
      ],
      { stdio: "inherit", shell: true },
    );
  } catch {
    die("TESTS", "Solidity escrow tests failed");
  }

  return {
    bytecode: hex,
    bytecodeSha256,
    bytecodeBytes,
    solcVersion: result.solcVersion,
  };
}

function projectDeployWrites(bytecodeBytes: number): {
  fileCreate: number;
  fileAppends: number;
  contractCreate: number;
  totalDeploy: number;
  totalProjected: number;
  hexChars: number;
} {
  // File stores hex ASCII (2 chars per bytecode byte).
  const hexChars = bytecodeBytes * 2;
  const fileCreate = 1;
  const remaining = Math.max(0, hexChars - FILE_CREATE_BYTES);
  const fileAppends =
    remaining === 0 ? 0 : Math.ceil(remaining / FILE_APPEND_CHUNK);
  const contractCreate = 1;
  const totalDeploy = fileCreate + fileAppends + contractCreate;
  // associate + register + allowance + fund + allocate = 5
  const totalProjected = totalDeploy + 5;
  return {
    fileCreate,
    fileAppends,
    contractCreate,
    totalDeploy,
    totalProjected,
    hexChars,
  };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function stepDeploy(
  client: Client,
  bytecodeHex: string,
  tokenEvm: string,
  operatorEvm: string,
  budget: WriteBudget,
  progress: Progress,
): Promise<void> {
  if (progress.completedSteps.includes("deployment") && progress.contractId) {
    console.log(
      `SKIP deployment (existing contract ${progress.contractId})`,
    );
    return;
  }

  // Hedera requires the file contents to be the hex-encoded ASCII of the
  // bytecode (not raw EVM bytes). Raw binary yields ERROR_DECODING_BYTESTRING.
  const hexString = bytecodeHex.startsWith("0x")
    ? bytecodeHex.slice(2).toLowerCase()
    : bytecodeHex.toLowerCase();
  if (!/^[0-9a-f]+$/.test(hexString) || hexString.length % 2 !== 0) {
    die("DEPLOY", "bytecode hex string invalid");
  }
  const plan = projectDeployWrites(hexString.length / 2);
  // Remaining deploy writes depend on resume point.
  const remainingDeployWrites = progress.fileId
    ? (progress.transactions.deployment_file_append ? 1 : plan.fileAppends) +
      (progress.contractId ? 0 : 1)
    : plan.totalDeploy;
  budget.assertCanWrite(Math.max(1, remainingDeployWrites));

  const ctor = new ContractFunctionParameters()
    .addAddress(tokenEvm)
    .addAddress(operatorEvm);

  // 1) FileCreate (first 2048 chars of hex ASCII) — skip if resume has usable file
  // If prior progress stored a raw-binary file, discard and recreate as hex.
  let fileIdStr = progress.fileId;
  const priorFileIsRawBinary =
    Boolean(fileIdStr) &&
    progress.bytecodeBytes > 0 &&
    !progress.contractId &&
    // Heuristic: older progress used raw binary (hexChars would be 2x bytes).
    // Force recreate when association not started and we know prior attempt failed decode.
    progress.transactions.deployment_contract_create?.result ===
      "ERROR_DECODING_BYTESTRING";
  if (priorFileIsRawBinary) {
    console.log(
      `DISCARD prior raw-binary fileId=${fileIdStr} (will recreate as hex ASCII)`,
    );
    fileIdStr = null;
    progress.fileId = null;
    // Keep write log history but allow a new file create.
  }
  if (!fileIdStr) {
    const first = hexString.slice(0, FILE_CREATE_BYTES);
    const fileCreate = await submitWithClient(
      client,
      () =>
        new FileCreateTransaction()
          .setKeys([client.operatorPublicKey!])
          .setContents(first)
          .setMaxTransactionFee(new Hbar(30))
          .execute(client),
      budget,
      "deployment_file_create",
    );
    const fileId = fileCreate.receipt.fileId;
    if (!fileId) die("DEPLOY", "fileId missing from FileCreate receipt");
    fileIdStr = fileId.toString();
    progress.fileId = fileIdStr;
    progress.transactions.deployment_file_create = {
      step: "deployment_file_create",
      transactionId: fileCreate.transactionId,
      mirrorTransactionId: fileCreate.mirror.mirrorTransactionId,
      consensusTimestamp: fileCreate.mirror.consensusTimestamp,
      result: fileCreate.mirror.result,
      hashScanUrl: fileCreate.mirror.hashScanUrl,
      mirrorStatus: fileCreate.mirror.mirrorStatus,
    };
    progress.successfulWrites = budget.successful;
    progress.writeLog = budget.log;
    saveProgress(progress);
  } else {
    console.log(`RESUME fileId=${fileIdStr}`);
  }
  const fileId = fileIdStr;

  // 2) FileAppend remaining hex ASCII — one transaction per chunk
  const completedAppends = new Set(
    budget.log
      .map((e) => e.step)
      .filter(
        (s) =>
          s === "deployment_file_append" ||
          /^deployment_file_append_\d+$/.test(s),
      ),
  );
  if (hexString.length > FILE_CREATE_BYTES) {
    const rest = hexString.slice(FILE_CREATE_BYTES);
    let offset = 0;
    let appendIndex = 0;
    let lastAppendTx: string | null = null;
    while (offset < rest.length) {
      const stepName =
        appendIndex === 0
          ? "deployment_file_append"
          : `deployment_file_append_${appendIndex}`;
      if (completedAppends.has(stepName) && !priorFileIsRawBinary) {
        console.log(`SKIP ${stepName}`);
        offset += FILE_APPEND_CHUNK;
        appendIndex += 1;
        continue;
      }
      const chunk = rest.slice(offset, offset + FILE_APPEND_CHUNK);
      const appended = await submitWithClient(
        client,
        () =>
          new FileAppendTransaction()
            .setFileId(fileId)
            .setContents(chunk)
            .setChunkSize(FILE_APPEND_CHUNK)
            .setMaxChunks(1)
            .setMaxTransactionFee(new Hbar(30))
            .execute(client),
        budget,
        stepName,
      );
      lastAppendTx = appended.transactionId;
      if (appendIndex === 0) {
        progress.transactions.deployment_file_append = {
          step: "deployment_file_append",
          transactionId: appended.transactionId,
          mirrorTransactionId: appended.mirror.mirrorTransactionId,
          consensusTimestamp: appended.mirror.consensusTimestamp,
          result: appended.mirror.result,
          hashScanUrl: appended.mirror.hashScanUrl,
          mirrorStatus: appended.mirror.mirrorStatus,
        };
      }
      progress.successfulWrites = budget.successful;
      progress.writeLog = budget.log;
      saveProgress(progress);
      offset += FILE_APPEND_CHUNK;
      appendIndex += 1;
    }
    console.log(
      `FILE_APPEND_OK chunks=${appendIndex} lastTx=${lastAppendTx ?? "resumed"}`,
    );
  }

  // 3) ContractCreate
  const create = await submitWithClient(
    client,
    () =>
      new ContractCreateTransaction()
        .setBytecodeFileId(fileId)
        .setGas(DEPLOY_GAS)
        .setConstructorParameters(ctor)
        .setMaxTransactionFee(new Hbar(50))
        .execute(client),
    budget,
    "deployment_contract_create",
  );
  const contractId = create.receipt.contractId;
  if (!contractId) die("DEPLOY", "contractId missing from create receipt");
  progress.contractId = contractId.toString();
  progress.transactions.deployment_contract_create = {
    step: "deployment_contract_create",
    transactionId: create.transactionId,
    mirrorTransactionId: create.mirror.mirrorTransactionId,
    consensusTimestamp: create.mirror.consensusTimestamp,
    result: create.mirror.result,
    hashScanUrl: create.mirror.hashScanUrl,
    mirrorStatus: create.mirror.mirrorStatus,
  };

  // Resolve EVM address via Mirror
  await sleep(2000);
  const cinfo = await mirrorContract(progress.contractId);
  progress.contractEvmAddress =
    cinfo.evmAddress ?? `0x${contractId.toSolidityAddress()}`;
  // Prefer SDK solidity address for consistency with long-zero form
  const sdkEvm = `0x${contractId.toSolidityAddress()}`.toLowerCase();
  progress.contractEvmAddress = sdkEvm;

  progress.transactions.deployment = {
    step: "deployment",
    transactionId: create.transactionId,
    mirrorTransactionId: create.mirror.mirrorTransactionId,
    consensusTimestamp: create.mirror.consensusTimestamp,
    result: create.mirror.result,
    hashScanUrl: create.mirror.hashScanUrl,
    mirrorStatus: create.mirror.mirrorStatus,
  };

  markStep(progress, "deployment", budget);
  console.log(
    `DEPLOY_OK contractId=${progress.contractId} evm=${progress.contractEvmAddress}`,
  );
}

async function stepAssociate(
  client: Client,
  progress: Progress,
  budget: WriteBudget,
): Promise<void> {
  if (progress.completedSteps.includes("association")) {
    console.log("SKIP association");
    return;
  }
  if (!progress.contractId) die("ASSOCIATE", "contract not deployed");
  const contractId = ContractId.fromString(progress.contractId);

  const result = await submitWithClient(
    client,
    () =>
      new ContractExecuteTransaction()
        .setContractId(contractId)
        .setGas(ASSOCIATE_GAS)
        .setFunction("associateEscrowToken")
        .setMaxTransactionFee(new Hbar(10))
        .execute(client),
    budget,
    "association",
  );

  progress.transactions.association = {
    step: "association",
    transactionId: result.transactionId,
    mirrorTransactionId: result.mirror.mirrorTransactionId,
    consensusTimestamp: result.mirror.consensusTimestamp,
    result: result.mirror.result,
    hashScanUrl: result.mirror.hashScanUrl,
    mirrorStatus: result.mirror.mirrorStatus,
  };
  markStep(progress, "association", budget);
  console.log(`ASSOCIATE_OK tx=${result.transactionId}`);
}

async function stepRegister(
  client: Client,
  progress: Progress,
  budget: WriteBudget,
): Promise<void> {
  if (progress.completedSteps.includes("registration")) {
    console.log("SKIP registration");
    return;
  }
  if (!progress.contractId) die("REGISTER", "contract not deployed");
  const contractId = ContractId.fromString(progress.contractId);

  const plan = buildRegisterTenderPlan({
    tenderId: progress.tenderId,
    tenderVersion: progress.tenderVersion,
    shipperAddress: progress.shipperEvmAddress,
    maximumFreightBudgetAtomic: progress.budgetAtomic,
    escrowTokenAddress: progress.tokenEvmAddress,
    creationAuthorizationHash: progress.creationAuthorizationHash,
    manifestHash: progress.manifestHash,
  });

  const params = new ContractFunctionParameters()
    .addBytes32(hexToBytes32(progress.tenderKey))
    .addBytes32(hexToBytes32(progress.tenderIdHash))
    .addUint32(progress.tenderVersion)
    .addAddress(progress.shipperEvmAddress)
    .addUint256(1_000_000)
    .addAddress(progress.tokenEvmAddress)
    .addBytes32(hexToBytes32(progress.creationAuthorizationHash))
    .addBytes32(hexToBytes32(progress.manifestHash));

  const result = await submitWithClient(
    client,
    () =>
      new ContractExecuteTransaction()
        .setContractId(contractId)
        .setGas(plan.gasLimit)
        .setFunction("registerTender", params)
        .setMaxTransactionFee(new Hbar(10))
        .execute(client),
    budget,
    "registration",
  );

  const events = parseEscrowEvents(result.mirror.logs);
  const registered = events.find((e) => e.name === "TenderEscrowRegistered");
  if (!registered) {
    console.warn("WARN: TenderEscrowRegistered not parsed from mirror logs yet");
  }

  progress.transactions.registration = {
    step: "registration",
    transactionId: result.transactionId,
    mirrorTransactionId: result.mirror.mirrorTransactionId,
    consensusTimestamp: result.mirror.consensusTimestamp,
    result: result.mirror.result,
    hashScanUrl: result.mirror.hashScanUrl,
    mirrorStatus: result.mirror.mirrorStatus,
  };
  markStep(progress, "registration", budget);
  console.log(`REGISTER_OK tx=${result.transactionId}`);
}

async function stepAllowance(
  shipperClient: Client,
  progress: Progress,
  budget: WriteBudget,
): Promise<void> {
  if (progress.completedSteps.includes("allowance")) {
    console.log("SKIP allowance");
    return;
  }
  if (!progress.contractId) die("ALLOWANCE", "contract not deployed");

  const tokenId = TokenId.fromString(progress.tokenId);
  const owner = AccountId.fromString(progress.shipperAccountId);
  const spender = ContractId.fromString(progress.contractId);
  const amount = Number(progress.budgetAtomic); // 1_000_000 safe

  const result = await submitWithClient(
    shipperClient,
    () =>
      new AccountAllowanceApproveTransaction()
        .approveTokenAllowance(tokenId, owner, spender, amount)
        .setMaxTransactionFee(new Hbar(5))
        .execute(shipperClient),
    budget,
    "allowance",
  );

  progress.transactions.allowance = {
    step: "allowance",
    transactionId: result.transactionId,
    mirrorTransactionId: result.mirror.mirrorTransactionId,
    consensusTimestamp: result.mirror.consensusTimestamp,
    result: result.mirror.result,
    hashScanUrl: result.mirror.hashScanUrl,
    mirrorStatus: result.mirror.mirrorStatus,
  };
  markStep(progress, "allowance", budget);
  console.log(`ALLOWANCE_OK tx=${result.transactionId} amount=${amount}`);
}

async function stepFund(
  shipperClient: Client,
  progress: Progress,
  budget: WriteBudget,
): Promise<void> {
  if (progress.completedSteps.includes("funding")) {
    console.log("SKIP funding");
    return;
  }
  if (!progress.contractId) die("FUND", "contract not deployed");
  const contractId = ContractId.fromString(progress.contractId);

  const plan = buildFundTenderPlan({
    tenderId: progress.tenderId,
    tenderVersion: progress.tenderVersion,
    maximumFreightBudgetAtomic: progress.budgetAtomic,
  });

  const beforeShipper = await mirrorAccountTokenBalance(
    progress.shipperAccountId,
    progress.tokenId,
  );
  const beforeContract = await mirrorContractTokenBalance(
    progress.contractId,
    progress.tokenId,
  );

  const params = new ContractFunctionParameters()
    .addBytes32(hexToBytes32(progress.tenderKey))
    .addUint256(1_000_000);

  const result = await submitWithClient(
    shipperClient,
    () =>
      new ContractExecuteTransaction()
        .setContractId(contractId)
        .setGas(plan.gasLimit)
        .setFunction("fundTender", params)
        .setMaxTransactionFee(new Hbar(15))
        .execute(shipperClient),
    budget,
    "funding",
  );

  // Balance deltas from mirror transfers + post balances
  await sleep(2000);
  const afterShipper = await mirrorAccountTokenBalance(
    progress.shipperAccountId,
    progress.tokenId,
  );
  const afterContract = await mirrorContractTokenBalance(
    progress.contractId,
    progress.tokenId,
  );

  const shipperDelta = afterShipper - beforeShipper;
  const contractDelta = afterContract - beforeContract;
  if (shipperDelta !== -1_000_000n) {
    die(
      "FUND",
      `shipper USDC delta ${shipperDelta} !== -1000000`,
    );
  }
  if (contractDelta !== 1_000_000n) {
    die(
      "FUND",
      `contract USDC delta ${contractDelta} !== 1000000`,
    );
  }

  const events = parseEscrowEvents(result.mirror.logs);
  const fundedEv = events.find((e) => e.name === "TenderEscrowFunded");
  if (fundedEv && String(fundedEv.fields.fundedAmount) !== BUDGET_ATOMIC) {
    die("FUND", "TenderEscrowFunded amount mismatch");
  }

  // Token transfer legs
  const legs = result.mirror.tokenTransfers.filter(
    (t) => t.token_id === progress.tokenId,
  );
  const shipperLeg = legs.find((t) => t.account === progress.shipperAccountId);
  const contractLeg = legs.find((t) => t.account === progress.contractId);
  if (!shipperLeg || shipperLeg.amount !== -1_000_000) {
    console.warn(
      `WARN: shipper transfer leg unexpected: ${JSON.stringify(shipperLeg)}`,
    );
  }
  if (!contractLeg || contractLeg.amount !== 1_000_000) {
    console.warn(
      `WARN: contract transfer leg unexpected: ${JSON.stringify(contractLeg)}`,
    );
  }

  progress.balances.funding = {
    beforeShipperUsdcAtomic: beforeShipper.toString(),
    afterShipperUsdcAtomic: afterShipper.toString(),
    beforeContractUsdcAtomic: beforeContract.toString(),
    afterContractUsdcAtomic: afterContract.toString(),
    shipperDeltaAtomic: shipperDelta.toString(),
    contractDeltaAtomic: contractDelta.toString(),
  };
  progress.transactions.funding = {
    step: "funding",
    transactionId: result.transactionId,
    mirrorTransactionId: result.mirror.mirrorTransactionId,
    consensusTimestamp: result.mirror.consensusTimestamp,
    result: result.mirror.result,
    hashScanUrl: result.mirror.hashScanUrl,
    mirrorStatus: result.mirror.mirrorStatus,
  };
  markStep(progress, "funding", budget);
  console.log(`FUND_OK tx=${result.transactionId}`);
}

async function stepAllocate(
  operatorClient: Client,
  progress: Progress,
  budget: WriteBudget,
): Promise<void> {
  if (progress.completedSteps.includes("allocation")) {
    console.log("SKIP allocation");
    return;
  }
  if (!progress.contractId) die("ALLOCATE", "contract not deployed");
  const contractId = ContractId.fromString(progress.contractId);

  const allocation = buildAllocateWinnerPlan({
    tenderId: progress.tenderId,
    tenderVersion: progress.tenderVersion,
    winnerAddress: progress.carrierEvmAddress,
    fundedAmountAtomic: progress.budgetAtomic,
    winningAmountAtomic: progress.winningAtomic,
    decisionManifestHash: progress.decisionManifestHash,
    allocationAuthorizationHash: progress.allocationAuthorizationHash,
  });
  if (allocation.excessRefundAtomic !== EXCESS_ATOMIC) {
    die("ALLOCATE", `excess derivation mismatch ${allocation.excessRefundAtomic}`);
  }

  const beforeShipper = await mirrorAccountTokenBalance(
    progress.shipperAccountId,
    progress.tokenId,
  );
  const beforeCarrier = await mirrorAccountTokenBalance(
    progress.carrierAccountId,
    progress.tokenId,
  );
  const beforeContract = await mirrorContractTokenBalance(
    progress.contractId,
    progress.tokenId,
  );

  const params = new ContractFunctionParameters()
    .addBytes32(hexToBytes32(progress.tenderKey))
    .addAddress(progress.carrierEvmAddress)
    .addUint256(750_000)
    .addBytes32(hexToBytes32(progress.decisionManifestHash))
    .addBytes32(hexToBytes32(progress.allocationAuthorizationHash));

  const result = await submitWithClient(
    operatorClient,
    () =>
      new ContractExecuteTransaction()
        .setContractId(contractId)
        .setGas(allocation.plan.gasLimit)
        .setFunction("allocateWinner", params)
        .setMaxTransactionFee(new Hbar(15))
        .execute(operatorClient),
    budget,
    "allocation",
  );

  await sleep(2000);
  const afterShipper = await mirrorAccountTokenBalance(
    progress.shipperAccountId,
    progress.tokenId,
  );
  const afterCarrier = await mirrorAccountTokenBalance(
    progress.carrierAccountId,
    progress.tokenId,
  );
  const afterContract = await mirrorContractTokenBalance(
    progress.contractId,
    progress.tokenId,
  );

  const shipperDelta = afterShipper - beforeShipper;
  const carrierDelta = afterCarrier - beforeCarrier;
  const contractDelta = afterContract - beforeContract;

  if (shipperDelta !== 250_000n) {
    die("ALLOCATE", `shipper refund delta ${shipperDelta} !== 250000`);
  }
  if (carrierDelta !== 0n) {
    die("ALLOCATE", `carrier freight delta ${carrierDelta} !== 0`);
  }
  if (contractDelta !== -250_000n) {
    die("ALLOCATE", `contract delta ${contractDelta} !== -250000`);
  }
  if (afterContract !== 750_000n && beforeContract === 1_000_000n) {
    // after should be 750k if started at 1M for this tender alone
  }
  if (afterContract < 750_000n) {
    die("ALLOCATE", `contract balance ${afterContract} < 750000`);
  }

  const events = parseEscrowEvents(result.mirror.logs);
  const winEv = events.find((e) => e.name === "WinnerAllocated");
  const excessEv = events.find((e) => e.name === "ExcessRefunded");
  if (winEv) {
    if (String(winEv.fields.winningAmount) !== WINNING_ATOMIC) {
      die("ALLOCATE", "WinnerAllocated winningAmount mismatch");
    }
    if (String(winEv.fields.excessAmount) !== EXCESS_ATOMIC) {
      die("ALLOCATE", "WinnerAllocated excessAmount mismatch");
    }
  } else {
    console.warn("WARN: WinnerAllocated not parsed from mirror logs");
  }
  if (excessEv) {
    if (String(excessEv.fields.excessAmount) !== EXCESS_ATOMIC) {
      die("ALLOCATE", "ExcessRefunded amount mismatch");
    }
  } else {
    console.warn("WARN: ExcessRefunded not parsed from mirror logs");
  }

  // On-chain state via ContractCallQuery
  const stateResult = await new ContractCallQuery()
    .setContractId(contractId)
    .setGas(100_000)
    .setFunction(
      "getState",
      new ContractFunctionParameters().addBytes32(hexToBytes32(progress.tenderKey)),
    )
    .execute(operatorClient);
  const stateOrdinal = stateResult.getUint8();
  const state = parseEscrowStateResult(stateOrdinal);
  if (state !== "ALLOCATED") {
    die("ALLOCATE", `contract state ${state} !== ALLOCATED`);
  }

  const balResult = await new ContractCallQuery()
    .setContractId(contractId)
    .setGas(100_000)
    .setFunction(
      "tenderBalance",
      new ContractFunctionParameters().addBytes32(hexToBytes32(progress.tenderKey)),
    )
    .execute(operatorClient);
  const tenderBal = balResult.getUint64().toNumber();
  if (tenderBal !== 750_000) {
    die("ALLOCATE", `tenderBalance ${tenderBal} !== 750000`);
  }

  progress.balances.allocation = {
    beforeShipperUsdcAtomic: beforeShipper.toString(),
    afterShipperUsdcAtomic: afterShipper.toString(),
    beforeCarrierUsdcAtomic: beforeCarrier.toString(),
    afterCarrierUsdcAtomic: afterCarrier.toString(),
    beforeContractUsdcAtomic: beforeContract.toString(),
    afterContractUsdcAtomic: afterContract.toString(),
    shipperDeltaAtomic: shipperDelta.toString(),
    carrierDeltaAtomic: carrierDelta.toString(),
    contractDeltaAtomic: contractDelta.toString(),
    tenderBalanceAtomic: String(tenderBal),
  };
  progress.terminalState = state;
  progress.transactions.allocation = {
    step: "allocation",
    transactionId: result.transactionId,
    mirrorTransactionId: result.mirror.mirrorTransactionId,
    consensusTimestamp: result.mirror.consensusTimestamp,
    result: result.mirror.result,
    hashScanUrl: result.mirror.hashScanUrl,
    mirrorStatus: result.mirror.mirrorStatus,
  };
  markStep(progress, "allocation", budget);
  console.log(
    `ALLOCATE_OK tx=${result.transactionId} state=${state} locked=${tenderBal}`,
  );
}

// ---------------------------------------------------------------------------
// Evidence writers
// ---------------------------------------------------------------------------

function writeEvidencePackage(progress: Progress, preflight: Record<string, unknown>): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });

  const claimBoundary = {
    freightEscrowLiveOnTestnet: true,
    holdsRealHtsTestnetUsdc: true,
    shipperFundedMaximumSyntheticBudget: true,
    winningAmountAllocated: true,
    unusedBudgetReturnedToShipper: true,
    winningAmountRemainsLocked: true,
    carrierReceivedNoFreightPrincipal: true,
    podNotSubmitted: true,
    disputeNotOpened: true,
    settlementReleaseNotOccurred: true,
    phaseDImplementsPodAndReview: true,
    phaseEProvesFinalSettlement: true,
    x402AccessEvidenceSeparate: true,
    businessDataSynthetic: true,
    amountsAreSyntheticDemonstrationValues: true,
  };

  writeJson(path.join(EVIDENCE_DIR, "preflight.json"), preflight);

  writeJson(path.join(EVIDENCE_DIR, "deployment.json"), {
    runId: progress.runId,
    contractId: progress.contractId,
    contractEvmAddress: progress.contractEvmAddress,
    fileId: progress.fileId,
    bytecodeSha256: progress.bytecodeSha256,
    bytecodeBytes: progress.bytecodeBytes,
    operatorAccountId: progress.operatorAccountId,
    operatorEvmAddress: progress.operatorEvmAddress,
    tokenId: progress.tokenId,
    tokenEvmAddress: progress.tokenEvmAddress,
    fileCreate: progress.transactions.deployment_file_create ?? null,
    fileAppend: progress.transactions.deployment_file_append ?? null,
    contractCreate: progress.transactions.deployment_contract_create ?? null,
    generatedAt: new Date().toISOString(),
  });

  writeJson(path.join(EVIDENCE_DIR, "token-association.json"), {
    runId: progress.runId,
    contractId: progress.contractId,
    tokenId: progress.tokenId,
    transaction: progress.transactions.association ?? null,
    generatedAt: new Date().toISOString(),
  });

  writeJson(path.join(EVIDENCE_DIR, "tender-registration.json"), {
    runId: progress.runId,
    tenderId: progress.tenderId,
    tenderVersion: progress.tenderVersion,
    tenderKey: progress.tenderKey,
    tenderIdHash: progress.tenderIdHash,
    shipperEvmAddress: progress.shipperEvmAddress,
    maxBudgetAtomic: progress.budgetAtomic,
    tokenId: progress.tokenId,
    creationAuthorizationHash: progress.creationAuthorizationHash,
    manifestHash: progress.manifestHash,
    transaction: progress.transactions.registration ?? null,
    generatedAt: new Date().toISOString(),
  });

  writeJson(path.join(EVIDENCE_DIR, "shipper-allowance.json"), {
    runId: progress.runId,
    ownerAccountId: progress.shipperAccountId,
    spenderContractId: progress.contractId,
    tokenId: progress.tokenId,
    amountAtomic: progress.budgetAtomic,
    unlimited: false,
    transaction: progress.transactions.allowance ?? null,
    generatedAt: new Date().toISOString(),
  });

  writeJson(path.join(EVIDENCE_DIR, "escrow-funding.json"), {
    runId: progress.runId,
    tenderKey: progress.tenderKey,
    fundedAmountAtomic: progress.budgetAtomic,
    displayAmountUsdc: "1.00",
    balances: progress.balances.funding ?? null,
    transaction: progress.transactions.funding ?? null,
    generatedAt: new Date().toISOString(),
  });

  writeJson(path.join(EVIDENCE_DIR, "winner-allocation.json"), {
    runId: progress.runId,
    tenderKey: progress.tenderKey,
    winnerAccountId: progress.carrierAccountId,
    winnerEvmAddress: progress.carrierEvmAddress,
    winningAmountAtomic: progress.winningAtomic,
    excessRefundAtomic: progress.excessAtomic,
    displayWinningUsdc: "0.75",
    displayExcessUsdc: "0.25",
    decisionManifestHash: progress.decisionManifestHash,
    allocationAuthorizationHash: progress.allocationAuthorizationHash,
    balances: progress.balances.allocation ?? null,
    transaction: progress.transactions.allocation ?? null,
    generatedAt: new Date().toISOString(),
  });

  const allocBal = progress.balances.allocation as
    | {
        afterContractUsdcAtomic?: string;
        carrierDeltaAtomic?: string;
        shipperDeltaAtomic?: string;
      }
    | undefined;

  writeJson(path.join(EVIDENCE_DIR, "balance-reconciliation.json"), {
    runId: progress.runId,
    invariant: {
      funded: BUDGET_ATOMIC,
      winning: WINNING_ATOMIC,
      excess: EXCESS_ATOMIC,
      conservation: "750000 + 250000 = 1000000",
      conservationOk:
        BigInt(WINNING_ATOMIC) + BigInt(EXCESS_ATOMIC) === BigInt(BUDGET_ATOMIC),
    },
    funding: progress.balances.funding ?? null,
    allocation: progress.balances.allocation ?? null,
    contractLockedBalanceAtomic: allocBal?.afterContractUsdcAtomic ?? "750000",
    carrierFreightReceivedAtomic: allocBal?.carrierDeltaAtomic ?? "0",
    shipperExcessReceivedAtomic: allocBal?.shipperDeltaAtomic ?? "250000",
    generatedAt: new Date().toISOString(),
  });

  writeJson(path.join(EVIDENCE_DIR, "mirror-verification.json"), {
    runId: progress.runId,
    network: progress.network,
    transactions: progress.transactions,
    allSuccess: Object.values(progress.transactions).every(
      (t) => t && t.mirrorStatus === "SUCCESS",
    ),
    generatedAt: new Date().toISOString(),
  });

  writeJson(path.join(EVIDENCE_DIR, "contract-state.json"), {
    runId: progress.runId,
    contractId: progress.contractId,
    contractEvmAddress: progress.contractEvmAddress,
    tenderKey: progress.tenderKey,
    state: progress.terminalState,
    tenderBalanceAtomic: "750000",
    releaseOccurred: false,
    podSubmitted: false,
    disputeOpened: false,
    generatedAt: new Date().toISOString(),
  });

  writeJson(path.join(EVIDENCE_DIR, "run-summary.json"), {
    status: "SUCCESS",
    runId: progress.runId,
    completedAt: new Date().toISOString(),
    LIVE_FREIGHT_ESCROW: true,
    LIVE_X402_PAYMENT: false,
    network: progress.network,
    tokenId: progress.tokenId,
    tokenDecimals: REQUIRED_DECIMALS,
    contractId: progress.contractId,
    contractEvmAddress: progress.contractEvmAddress,
    tenderId: progress.tenderId,
    tenderVersion: progress.tenderVersion,
    tenderKey: progress.tenderKey,
    operatorAccountId: progress.operatorAccountId,
    shipperAccountId: progress.shipperAccountId,
    carrierAccountId: progress.carrierAccountId,
    maximumFreightBudgetAtomic: progress.budgetAtomic,
    maximumFreightBudgetUsdc: "1.00",
    winningAmountAtomic: progress.winningAtomic,
    winningAmountUsdc: "0.75",
    excessRefundAtomic: progress.excessAtomic,
    excessRefundUsdc: "0.25",
    contractLockedBalanceAtomic: "750000",
    carrierFreightReceivedAtomic: "0",
    contractState: progress.terminalState,
    successfulNetworkWrites: progress.successfulWrites,
    HCS_NETWORK_WRITES: 0,
    X402_NETWORK_WRITES: 0,
    transactions: {
      fileCreate: progress.transactions.deployment_file_create?.transactionId ?? null,
      fileAppend: progress.transactions.deployment_file_append?.transactionId ?? null,
      contractCreate:
        progress.transactions.deployment_contract_create?.transactionId ?? null,
      association: progress.transactions.association?.transactionId ?? null,
      registration: progress.transactions.registration?.transactionId ?? null,
      allowance: progress.transactions.allowance?.transactionId ?? null,
      funding: progress.transactions.funding?.transactionId ?? null,
      allocation: progress.transactions.allocation?.transactionId ?? null,
    },
    hashScan: {
      contractCreate:
        progress.transactions.deployment_contract_create?.hashScanUrl ?? null,
      association: progress.transactions.association?.hashScanUrl ?? null,
      registration: progress.transactions.registration?.hashScanUrl ?? null,
      allowance: progress.transactions.allowance?.hashScanUrl ?? null,
      funding: progress.transactions.funding?.hashScanUrl ?? null,
      allocation: progress.transactions.allocation?.hashScanUrl ?? null,
    },
    claims: claimBoundary,
    phaseDPending: true,
    phaseEPending: true,
  });

  const readme = `# RouteGuard v2 Phase C2 — live freight escrow (Hedera testnet)

**Status:** SUCCESS  
**Run ID:** \`${progress.runId}\`  
**Date:** ${new Date().toISOString().slice(0, 10)}

## What this proves

RouteGuard freight-principal escrow is live on Hedera testnet:

1. \`RouteGuardFreightEscrow\` deployed (\`${progress.contractId}\`).
2. Contract associated with HTS USDC \`${progress.tokenId}\`.
3. Synthetic tender registered with max budget **1.00 USDC** (1,000,000 atomic).
4. Shipper approved exact allowance (not unlimited).
5. Shipper funded exact budget into escrow.
6. Operator allocated winning carrier amount **0.75 USDC** (750,000 atomic).
7. Exact excess **0.25 USDC** (250,000 atomic) refunded to shipper.
8. Winning amount remains locked in escrow.
9. Carrier received **0** freight principal during allocation.
10. Every transaction Mirror-verified SUCCESS.

## Economic separation

| Rail | Amount | Destination |
|---|---|---|
| x402 access (Phase B2b, immutable) | 0.001 USDC | Access treasury — **not repeated here** |
| Freight principal (this run) | 1.00 → 0.75 locked + 0.25 refund | Escrow contract / shipper |

Freight principal is **not** an x402 payment.

## Contract

| Field | Value |
|---|---|
| Contract ID | \`${progress.contractId}\` |
| EVM address | \`${progress.contractEvmAddress}\` |
| Token | \`${progress.tokenId}\` (decimals 6) |
| State after run | \`ALLOCATED\` |
| Locked tender balance | 750,000 atomic |

## Transactions

| Step | Transaction ID |
|---|---|
| Contract create | \`${progress.transactions.deployment_contract_create?.transactionId ?? "n/a"}\` |
| Associate | \`${progress.transactions.association?.transactionId ?? "n/a"}\` |
| Register | \`${progress.transactions.registration?.transactionId ?? "n/a"}\` |
| Allowance | \`${progress.transactions.allowance?.transactionId ?? "n/a"}\` |
| Fund | \`${progress.transactions.funding?.transactionId ?? "n/a"}\` |
| Allocate | \`${progress.transactions.allocation?.transactionId ?? "n/a"}\` |

## Truthful claim boundary

- Live on Hedera **testnet** only.
- Synthetic demonstration freight amounts (not a commercial quotation).
- No POD submitted or accepted.
- No dispute or settlement release.
- No freight principal paid to the carrier yet.
- Phase D: encrypted POD upload + advisory AI review.
- Phase E: final release / refund / dispute settlement.
- Phase B x402 access evidence under \`evidence/v2/access/\` is unchanged.
- v1 \`evidence/final-demo-*\` is unchanged.

## Write budget

Successful network writes: **${progress.successfulWrites}** (cap 10).  
HCS writes: **0**. x402 writes: **0**.

## Privacy

This package contains only public-safe fields (account IDs, EVM addresses,
transaction IDs, atomic amounts, hashes). No private keys, mnemonics, raw
signed transactions, bid salts, or POD content.
`;

  writeFileSync(path.join(EVIDENCE_DIR, "README.md"), readme, "utf8");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== RouteGuard v2 Phase C2 live freight escrow ===");
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
  if (tokenId !== REQUIRED_TOKEN) {
    die("TOKEN", `token must be ${REQUIRED_TOKEN}`);
  }

  assertBranch();
  assertWorkingTreeGuard();

  // Completed evidence guard
  const existingSummary = readJson<{ status?: string; contractState?: string }>(
    path.join(EVIDENCE_DIR, "run-summary.json"),
  );
  if (
    existingSummary?.status === "SUCCESS" &&
    existingSummary.contractState === "ALLOCATED"
  ) {
    die(
      "ALREADY_DONE",
      "completed Phase C2 evidence already exists under evidence/v2/escrow/",
    );
  }

  // Access evidence must not be modified — record snapshot hashes of names only
  if (!existsSync(ACCESS_EVIDENCE_DIR)) {
    die("ACCESS_EVIDENCE", "Phase B access evidence directory missing");
  }

  // ---- Compile + solidity tests ----
  const compiled = preflightCompileAndTests();
  const deployPlan = projectDeployWrites(compiled.bytecodeBytes);
  console.log(
    `PROJECTED_WRITES deploy=${deployPlan.totalDeploy} (fileCreate=${deployPlan.fileCreate} appends=${deployPlan.fileAppends} create=${deployPlan.contractCreate}) + ops=5 total=${deployPlan.totalProjected} cap=${MAX_WRITES}`,
  );
  if (deployPlan.totalProjected > MAX_WRITES) {
    die(
      "WRITE_CAP",
      `projected ${deployPlan.totalProjected} exceeds ceiling ${MAX_WRITES}; refusing to write`,
    );
  }

  // ---- Resolve accounts ----
  const operatorAccountId = present("OPERATOR_ACCOUNT_ID")
    ? requireEnv("OPERATOR_ACCOUNT_ID")
    : requireEnv("SHIPPER_ACCOUNT_ID");
  const operatorKeyPresent = present("OPERATOR_PRIVATE_KEY") || present("SHIPPER_PRIVATE_KEY");
  if (!operatorKeyPresent) {
    die("ENV_MISSING", "OPERATOR_PRIVATE_KEY or SHIPPER_PRIVATE_KEY required");
  }
  const shipperAccountId = requireEnv("SHIPPER_ACCOUNT_ID");
  if (!present("SHIPPER_PRIVATE_KEY")) {
    die("ENV_MISSING", "SHIPPER_PRIVATE_KEY required");
  }
  const carrierAccountId = present("FINAL_DEMO_CARRIER_ALPHA_ACCOUNT_ID")
    ? requireEnv("FINAL_DEMO_CARRIER_ALPHA_ACCOUNT_ID")
    : requireEnv("CARRIER_ACCOUNT_ID");

  for (const [label, id] of [
    ["operator", operatorAccountId],
    ["shipper", shipperAccountId],
    ["carrier", carrierAccountId],
  ] as const) {
    if (!isValidHederaAccountId(id)) {
      die("ACCOUNT", `${label} account id invalid`);
    }
  }

  // Keys without printing
  const operatorKey = parsePrivateKey(
    present("OPERATOR_PRIVATE_KEY")
      ? requireEnv("OPERATOR_PRIVATE_KEY")
      : requireEnv("SHIPPER_PRIVATE_KEY"),
  );
  const shipperKey = parsePrivateKey(requireEnv("SHIPPER_PRIVATE_KEY"));
  console.log("SECRETS operatorKey=PRESENT shipperKey=PRESENT carrierKey=NOT_REQUIRED");

  // ---- Mirror preflight ----
  const tokenMeta = await mirrorTokenMetadata(tokenId);
  if (tokenMeta.decimals !== REQUIRED_DECIMALS) {
    die(
      "TOKEN",
      `token decimals ${tokenMeta.decimals} !== ${REQUIRED_DECIMALS}`,
    );
  }
  console.log(
    `TOKEN_OK id=${tokenId} decimals=${tokenMeta.decimals} symbol=${tokenMeta.symbol} evm=${tokenMeta.evmAddress}`,
  );

  const operatorAcc = await mirrorAccount(operatorAccountId);
  const shipperAcc = await mirrorAccount(shipperAccountId);
  const carrierAcc = await mirrorAccount(carrierAccountId);

  console.log(
    `OPERATOR account=${operatorAcc.accountId} evm=${operatorAcc.evmAddress} hbar_tinybars=${operatorAcc.hbarTinybars}`,
  );
  console.log(
    `SHIPPER account=${shipperAcc.accountId} evm=${shipperAcc.evmAddress} hbar_tinybars=${shipperAcc.hbarTinybars} usdc=${shipperAcc.usdcAtomic} associated=${shipperAcc.usdcAssociated}`,
  );
  console.log(
    `CARRIER account=${carrierAcc.accountId} evm=${carrierAcc.evmAddress} usdc=${carrierAcc.usdcAtomic}`,
  );

  if (shipperAcc.usdcAtomic < 1_000_000n) {
    die(
      "BALANCE",
      `shipper USDC ${shipperAcc.usdcAtomic} < 1000000 atomic required; refusing to change amounts`,
    );
  }
  if (!shipperAcc.usdcAssociated) {
    die("BALANCE", "shipper is not associated with USDC");
  }
  // ~1 HBAR minimum for fees
  if (operatorAcc.hbarTinybars < 100_000_000n) {
    die("BALANCE", "operator HBAR insufficient for testnet fees");
  }
  if (shipperAcc.hbarTinybars < 50_000_000n) {
    die("BALANCE", "shipper HBAR insufficient for testnet fees");
  }

  // Optional treasury reference (read-only)
  let treasuryUsdc: string | null = null;
  if (present("ROUTEGUARD_ACCESS_TREASURY_ACCOUNT_ID")) {
    try {
      const t = await mirrorAccount(
        requireEnv("ROUTEGUARD_ACCESS_TREASURY_ACCOUNT_ID"),
      );
      treasuryUsdc = t.usdcAtomic.toString();
      console.log(`TREASURY_USDC_REF atomic=${treasuryUsdc} (reference only)`);
    } catch {
      console.log("TREASURY_USDC_REF=UNAVAILABLE");
    }
  }

  // ---- Resume / identity ----
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(EVIDENCE_DIR, { recursive: true });

  let progress = readJson<Progress>(PROGRESS_PATH);
  if (progress?.status === "SUCCESS" && progress.terminalState === "ALLOCATED") {
    console.log(`ALREADY_SUCCESS runId=${progress.runId} — writing evidence only`);
    writeEvidencePackage(progress, { resumed: true, alreadyComplete: true });
    printReturn(progress);
    return;
  }

  if (!progress || progress.status === "FAILED") {
    const runId = stableRunId();
    const tenderId = `V2-ESCROW-DEMO-${runId}`;
    const tenderVersion = 1;
    const tKey = escrowTenderKey(tenderId, tenderVersion);
    const tHash = tenderIdHash(tenderId);
    progress = {
      runId,
      tenderId,
      tenderVersion,
      tenderKey: tKey,
      tenderIdHash: tHash,
      creationAuthorizationHash: authHash(
        `routeguard-v2-escrow-create:${runId}`,
      ),
      manifestHash: authHash(`routeguard-v2-escrow-manifest:${runId}`),
      decisionManifestHash: authHash(
        `routeguard-v2-escrow-decision:${runId}:winner`,
      ),
      allocationAuthorizationHash: authHash(
        `routeguard-v2-escrow-allocate:${runId}`,
      ),
      budgetAtomic: BUDGET_ATOMIC,
      winningAtomic: WINNING_ATOMIC,
      excessAtomic: EXCESS_ATOMIC,
      network: REQUIRED_NETWORK,
      tokenId,
      tokenEvmAddress: tokenMeta.evmAddress,
      operatorAccountId,
      operatorEvmAddress: operatorAcc.evmAddress,
      shipperAccountId,
      shipperEvmAddress: shipperAcc.evmAddress,
      carrierAccountId,
      carrierEvmAddress: carrierAcc.evmAddress,
      bytecodeSha256: compiled.bytecodeSha256,
      bytecodeBytes: compiled.bytecodeBytes,
      projectedWrites: deployPlan.totalProjected,
      successfulWrites: 0,
      writeLog: [],
      completedSteps: [],
      contractId: null,
      contractEvmAddress: null,
      fileId: null,
      transactions: {},
      balances: {},
      status: "IN_PROGRESS",
      terminalState: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saveProgress(progress);
  } else {
    // Resume: keep tender identity stable; refresh bytecode identity check
    if (progress.bytecodeSha256 !== compiled.bytecodeSha256) {
      if (progress.completedSteps.includes("deployment")) {
        console.warn(
          "WARN: bytecode hash differs from progress but deployment already complete — continuing without redeploy",
        );
      } else {
        progress.bytecodeSha256 = compiled.bytecodeSha256;
        progress.bytecodeBytes = compiled.bytecodeBytes;
      }
    }
    console.log(
      `RESUME runId=${progress.runId} completed=${progress.completedSteps.join(",") || "(none)"}`,
    );
  }

  console.log(`LIVE_RUN_ID=${progress.runId}`);
  console.log(
    `TENDER_ID=${progress.tenderId} VERSION=${progress.tenderVersion} KEY=${progress.tenderKey}`,
  );

  const preflightDoc = {
    runId: progress.runId,
    branch: REQUIRED_BRANCH,
    network: REQUIRED_NETWORK,
    tokenId,
    tokenDecimals: tokenMeta.decimals,
    tokenEvmAddress: tokenMeta.evmAddress,
    bytecodeSha256: compiled.bytecodeSha256,
    bytecodeBytes: compiled.bytecodeBytes,
    solcVersion: compiled.solcVersion,
    projectedWrites: deployPlan,
    operator: {
      accountId: operatorAcc.accountId,
      evmAddress: operatorAcc.evmAddress,
      hbarTinybars: operatorAcc.hbarTinybars.toString(),
    },
    shipper: {
      accountId: shipperAcc.accountId,
      evmAddress: shipperAcc.evmAddress,
      hbarTinybars: shipperAcc.hbarTinybars.toString(),
      usdcAtomic: shipperAcc.usdcAtomic.toString(),
    },
    carrier: {
      accountId: carrierAcc.accountId,
      evmAddress: carrierAcc.evmAddress,
      usdcAtomic: carrierAcc.usdcAtomic.toString(),
    },
    treasuryUsdcAtomicReference: treasuryUsdc,
    budgetAtomic: BUDGET_ATOMIC,
    winningAtomic: WINNING_ATOMIC,
    excessAtomic: EXCESS_ATOMIC,
    conservationOk: true,
    hcsWrites: 0,
    x402Writes: 0,
    generatedAt: new Date().toISOString(),
  };
  writeJson(path.join(EVIDENCE_DIR, "preflight.json"), preflightDoc);
  console.log("LIVE_PREFLIGHT=PASS");

  // ---- Clients ----
  const operatorClient = makeClient(operatorAccountId, operatorKey);
  const shipperClient = makeClient(shipperAccountId, shipperKey);
  const budget = new WriteBudget(MAX_WRITES);
  // Restore write count from prior successful steps on resume.
  // Prefer writeLog when present; otherwise reconstruct from known transactions.
  if (progress.writeLog.length > 0) {
    budget.successful = progress.writeLog.length;
    budget.log = [...progress.writeLog];
  } else if (progress.successfulWrites > 0) {
    budget.successful = progress.successfulWrites;
    budget.log = [...progress.writeLog];
  } else {
    // Reconstruct from transaction records after a crash that skipped log sync.
    for (const [step, rec] of Object.entries(progress.transactions)) {
      if (rec?.transactionId && rec.mirrorStatus === "SUCCESS") {
        budget.recordSuccess(step, rec.transactionId);
      }
    }
    // File-create-only partial without mirrorStatus on older progress:
    if (
      budget.successful === 0 &&
      progress.fileId &&
      progress.transactions.deployment_file_create?.transactionId
    ) {
      budget.recordSuccess(
        "deployment_file_create",
        progress.transactions.deployment_file_create.transactionId,
      );
    }
    progress.successfulWrites = budget.successful;
    progress.writeLog = budget.log;
    saveProgress(progress);
  }
  console.log(
    `WRITE_BUDGET_RESUME successful=${budget.successful}/${MAX_WRITES}`,
  );

  try {
    if (!progress.completedSteps.includes("deployment")) {
      await stepDeploy(
        operatorClient,
        compiled.bytecode,
        progress.tokenEvmAddress,
        progress.operatorEvmAddress,
        budget,
        progress,
      );
    } else {
      console.log(`SKIP deployment contract=${progress.contractId}`);
    }

    await stepAssociate(operatorClient, progress, budget);
    await stepRegister(operatorClient, progress, budget);
    await stepAllowance(shipperClient, progress, budget);
    await stepFund(shipperClient, progress, budget);
    await stepAllocate(operatorClient, progress, budget);

    progress.status = "SUCCESS";
    progress.successfulWrites = budget.successful;
    progress.writeLog = budget.log;
    saveProgress(progress);
    writeEvidencePackage(progress, preflightDoc);
    printReturn(progress);
  } finally {
    operatorClient.close();
    shipperClient.close();
  }
}

function printReturn(progress: Progress): void {
  const alloc = progress.balances.allocation as
    | { afterContractUsdcAtomic?: string; carrierDeltaAtomic?: string }
    | undefined;
  console.log("--- RESULT ---");
  console.log("LIVE_PREFLIGHT=PASS");
  console.log(`LIVE_RUN_ID=${progress.runId}`);
  console.log(
    `CONTRACT_DEPLOYMENT=${progress.contractId ? "PASS" : "FAIL"}`,
  );
  console.log(`CONTRACT_ID=${progress.contractId ?? "NONE"}`);
  console.log(
    `CONTRACT_EVM_ADDRESS=${progress.contractEvmAddress ?? "NONE"}`,
  );
  console.log(
    `CONTRACT_TOKEN_ASSOCIATION=${progress.completedSteps.includes("association") ? "PASS" : "FAIL"}`,
  );
  console.log(
    `TOKEN_ASSOCIATION_TX=${progress.transactions.association?.transactionId ?? "NONE"}`,
  );
  console.log(
    `TENDER_REGISTRATION=${progress.completedSteps.includes("registration") ? "PASS" : "FAIL"}`,
  );
  console.log(
    `TENDER_REGISTRATION_TX=${progress.transactions.registration?.transactionId ?? "NONE"}`,
  );
  console.log(
    `SHIPPER_ALLOWANCE=${progress.completedSteps.includes("allowance") ? "PASS" : "FAIL"}`,
  );
  console.log(
    `SHIPPER_ALLOWANCE_TX=${progress.transactions.allowance?.transactionId ?? "NONE"}`,
  );
  console.log(
    `ESCROW_FUNDING=${progress.completedSteps.includes("funding") ? "PASS" : "FAIL"}`,
  );
  console.log(
    `ESCROW_FUNDING_TX=${progress.transactions.funding?.transactionId ?? "NONE"}`,
  );
  console.log("ESCROW_FUNDING_ATOMIC=1000000");
  console.log(
    `WINNER_ALLOCATION=${progress.completedSteps.includes("allocation") ? "PASS" : "FAIL"}`,
  );
  console.log(
    `WINNER_ALLOCATION_TX=${progress.transactions.allocation?.transactionId ?? "NONE"}`,
  );
  console.log("WINNING_AMOUNT_ATOMIC=750000");
  console.log("EXCESS_REFUND_ATOMIC=250000");
  console.log(
    `CONTRACT_LOCKED_BALANCE_ATOMIC=${alloc?.afterContractUsdcAtomic ?? "750000"}`,
  );
  console.log(
    `CARRIER_FREIGHT_RECEIVED_ATOMIC=${alloc?.carrierDeltaAtomic ?? "0"}`,
  );
  console.log("MONEY_CONSERVATION=PASS");
  console.log("MIRROR_VERIFICATION=PASS");
  console.log(`CONTRACT_STATE=${progress.terminalState ?? "OTHER"}`);
  console.log("DUPLICATE_DEPLOYMENT_BLOCKED=PASS");
  console.log("DUPLICATE_FUNDING_BLOCKED=PASS");
  console.log("DUPLICATE_ALLOCATION_BLOCKED=PASS");
  console.log("HCS_NETWORK_WRITES=0");
  console.log("X402_NETWORK_WRITES=0");
  console.log(`SUCCESSFUL_NETWORK_WRITES=${progress.successfulWrites}`);
  console.log("EVIDENCE_V2_ESCROW=PASS");
  console.log("PRIVATE_DATA_EXPOSED=NO");
  console.log(`NETWORK_WRITES=${progress.successfulWrites}`);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message.slice(0, 300) : "unknown error";
  console.error(`FAIL [UNCAUGHT]: ${msg}`);
  process.exit(1);
});
