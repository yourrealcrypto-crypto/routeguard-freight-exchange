/**
 * Guarded one-time Hedera testnet infrastructure deployment for the RouteGuard
 * Operations Demo. The only state-changing operations reachable from this
 * runner are one file create, three file appends, one contract create, one HTS
 * association, and one HCS topic create.
 */

import "dotenv/config";

import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  AccountId,
  Client,
  ContractCreateTransaction,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractId,
  FileAppendTransaction,
  FileCreateTransaction,
  Hbar,
  PrivateKey,
  Status,
  TopicCreateTransaction,
  Transaction,
  TransactionId,
  type TransactionReceipt,
} from "@hiero-ledger/sdk";
import { Interface } from "ethers";

import { compileContracts } from "./compile-contracts";
import {
  DEMO_OPERATOR_ACCOUNT_ID,
  IMMUTABLE_PROOF_CONTRACT_EVM,
  IMMUTABLE_PROOF_CONTRACT_ID,
  IMMUTABLE_PROOF_TOPIC_ID,
} from "../src/operations-demo/constants";
import { ROUTEGUARD_FREIGHT_ESCROW_ABI } from "../src/v2/escrow/abi";
import { hashScanTransactionUrl, toMirrorTransactionId } from "../src/v2/access/mirror-reconcile";
import {
  HEDERA_TESTNET_MIRROR_NODE,
  VERIFIED_USDC_DECIMALS,
  VERIFIED_USDC_TOKEN_ID,
} from "../src/x402/usdc-constants";

export const DEMO_INFRA_CONFIRM_ENV = "ROUTEGUARD_LIVE_V2_DEMO_INFRA_CONFIRM";
export const DEMO_INFRA_CONFIRM_VALUE = "I_UNDERSTAND_TESTNET_DEMO_INFRA_WRITES";
export const DEMO_INFRA_MAX_WRITES_ENV = "ROUTEGUARD_LIVE_V2_DEMO_INFRA_MAX_WRITES";
export const DEMO_INFRA_MAX_WRITES = 7;
export const DEMO_INFRA_REQUIRED_BRANCH = "feat/routeguard-v2-operations-demo-infra";
export const DEMO_INFRA_BASELINE = "388907131ccb34bb85396265d5de9750f45033e1";
export const ACCEPTED_BYTECODE_SHA256 = "584bf3710a13fb798f73734a2afea5213afda437d672ee91078a72315c30abe5";
export const ACCEPTED_SOLC_VERSION = "0.8.28+commit.7893614a.Emscripten.clang";
export const FILE_CREATE_CHARS = 2_048;
export const FILE_APPEND_CHARS = 4_500;
export const REQUIRED_FILE_APPENDS = 3;

const REQUIRED_NETWORK = "hedera:testnet";
const CONTRACT_MEMO = "RouteGuard Operations Demo Escrow";
const TOPIC_MEMO = "RouteGuard operations demo";
const DEPLOY_GAS = 4_000_000;
const ASSOCIATION_GAS = 1_000_000;
const MIN_OPERATOR_HBAR_TINYBARS = 100_000_000n;
const EVIDENCE_DIR = path.join("evidence", "v2", "demo-infrastructure");
const DATA_DIR = path.join("data", "v2-live-demo-infrastructure");
const PROGRESS_PATH = path.join(DATA_DIR, "progress.json");
const ARTIFACT_PATH = path.join("artifacts", "contracts", "RouteGuardFreightEscrow.json");

const TX_STEPS = [
  "bytecode_file_create",
  "bytecode_file_append_1",
  "bytecode_file_append_2",
  "bytecode_file_append_3",
  "contract_create",
  "contract_association",
  "topic_create",
] as const;
type TxStep = (typeof TX_STEPS)[number];

type MirrorTx = {
  transactionId: string;
  mirrorTransactionId: string;
  result: string | null;
  consensusTimestamp: string | null;
  entityId: string | null;
  childTransactionCount: number;
  logs: Array<{ topics: string[]; data: string }>;
  hashScanUrl: string;
  mirrorStatus: "SUCCESS" | "FAILED" | "NOT_FOUND";
};

type TxRecord = MirrorTx & {
  step: TxStep;
  receiptStatus: "PENDING" | "SUCCESS";
};

type ProofSnapshot = {
  contractId: string;
  contractEvmAddress: string;
  contractBytecodeSha256: string;
  contractTotalEscrowedAtomic: string;
  topicId: string;
  topicSequenceNumber: number;
};

type Progress = {
  schemaVersion: 1;
  runId: string;
  status: "IN_PROGRESS" | "SUCCESS";
  network: typeof REQUIRED_NETWORK;
  tokenId: typeof VERIFIED_USDC_TOKEN_ID;
  tokenEvmAddress: string;
  operatorAccountId: string;
  operatorEvmAddress: string;
  operatorPublicKey: string;
  bytecodeSha256: string;
  bytecodeBytes: number;
  bytecodeHexChars: number;
  solcVersion: string;
  projectedWrites: 7;
  fileId: string | null;
  contractId: string | null;
  contractEvmAddress: string | null;
  topicId: string | null;
  transactions: Partial<Record<TxStep, TxRecord>>;
  proofBefore: ProofSnapshot;
  createdAt: string;
  updatedAt: string;
};

type CompiledEscrow = {
  bytecodeHex: string;
  bytecodeSha256: string;
  bytecodeBytes: number;
  solcVersion: string;
};

type MirrorAccount = {
  account?: string;
  deleted?: boolean;
  evm_address?: string | null;
  key?: { _type?: string; key?: string };
  balance?: { balance?: number | string };
};

const escrowInterface = new Interface([
  ...ROUTEGUARD_FREIGHT_ESCROW_ABI,
  "event EscrowTokenAssociated(address indexed token, int64 responseCode)",
]);

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function sha256(value: string | Buffer | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeHex(value: string): string {
  return value.trim().replace(/^0x/i, "").toLowerCase();
}

function longZero(entityId: string): string {
  const parts = entityId.split(".");
  if (parts.length !== 3 || parts[0] !== "0" || parts[1] !== "0" || !/^\d+$/.test(parts[2]!)) {
    fail("ENTITY_ID", "expected a 0.0.x Hedera entity id");
  }
  return `0x${BigInt(parts[2]!).toString(16).padStart(40, "0")}`;
}

function present(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function secretStatus(): void {
  for (const name of [
    DEMO_INFRA_CONFIRM_ENV,
    DEMO_INFRA_MAX_WRITES_ENV,
    "HEDERA_NETWORK",
    "USDC_TOKEN_ID",
    "OPERATOR_ACCOUNT_ID",
    "SHIPPER_ACCOUNT_ID",
    "ROUTEGUARD_OPERATOR_PRIVATE_KEY",
    "OPERATOR_PRIVATE_KEY",
    "SHIPPER_PRIVATE_KEY",
  ]) {
    console.log(`ENV ${name}=${present(name) ? "PRESENT" : "MISSING"}`);
  }
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    fail("PROGRESS", `invalid JSON at ${filePath.replaceAll("\\", "/")}`);
  }
}

function saveProgress(progress: Progress): void {
  progress.updatedAt = new Date().toISOString();
  writeJson(PROGRESS_PATH, progress);
  writeJson(path.join(EVIDENCE_DIR, "live-progress.json"), {
    runId: progress.runId,
    status: progress.status,
    successfulWrites: successfulWriteCount(progress),
    fileId: progress.fileId,
    contractId: progress.contractId,
    contractEvmAddress: progress.contractEvmAddress,
    topicId: progress.topicId,
    transactions: progress.transactions,
    updatedAt: progress.updatedAt,
  });
}

function run(command: string, args: string[], label: string): void {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false });
  if (result.status !== 0) fail(label, `${command} exited with status ${String(result.status)}`);
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function assertGitGate(): void {
  const branch = git(["branch", "--show-current"]);
  if (branch !== DEMO_INFRA_REQUIRED_BRANCH) fail("BRANCH", `must be ${DEMO_INFRA_REQUIRED_BRANCH}`);
  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", DEMO_INFRA_BASELINE, "HEAD"]);
  if (ancestry.status !== 0) fail("BASELINE", `HEAD must descend from ${DEMO_INFRA_BASELINE}`);

  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }).replace(/\r?\n$/, "");
  if (dirty) {
    const allowedExact = new Set([
      "package.json",
      "package-lock.json",
      "PROJECT_STATUS.md",
      ".env.example",
      "docs/operations-demo-backend.md",
      "scripts/run-v2-demo-infrastructure-live.ts",
      "test/demo-infrastructure-runner.test.ts",
      "src/operations-demo/constants.ts",
      "src/operations-demo/config.ts",
    ]);
    const allowedPrefixes = ["evidence/v2/demo-infrastructure/", "data/v2-live-demo-infrastructure/"];
    for (const line of dirty.split(/\r?\n/)) {
      const filePath = line.slice(3).replaceAll("\\", "/").replace(/^"|"$/g, "");
      if (!allowedExact.has(filePath) && !allowedPrefixes.some((prefix) => filePath.startsWith(prefix))) {
        fail("DIRTY", `unexpected dirty path ${filePath}`);
      }
    }
  }

  for (const immutablePath of [
    "contracts",
    "evidence/v2/access",
    "evidence/v2/escrow",
    "evidence/v2/pod",
    "evidence/v2/release",
    "evidence/final-demo-dry-run.json",
    "evidence/final-demo-dry-run.md",
    "evidence/final-demo-dry-run-report.html",
    "evidence/final-demo-dry-run-attempt.json",
    "evidence/final-demo-dry-run-authoritative-materials.json",
    "evidence/final-demo-result.json",
    "evidence/final-demo-result.md",
    "evidence/final-demo-report.html",
    "evidence/final-demo-live-attempt.json",
    "evidence/final-demo-live-authoritative-materials.json",
    "evidence/final-demo-live-reservation-record.json",
  ]) {
    const result = spawnSync("git", ["diff", "--quiet", DEMO_INFRA_BASELINE, "--", immutablePath]);
    if (result.status !== 0) fail("IMMUTABLE", `${immutablePath} differs from baseline`);
  }
}

function requireGuards(): void {
  if (process.env[DEMO_INFRA_CONFIRM_ENV]?.trim() !== DEMO_INFRA_CONFIRM_VALUE) {
    fail("CONFIRM", `${DEMO_INFRA_CONFIRM_ENV} is missing or incorrect`);
  }
  if (process.env[DEMO_INFRA_MAX_WRITES_ENV]?.trim() !== String(DEMO_INFRA_MAX_WRITES)) {
    fail("WRITE_CAP", `${DEMO_INFRA_MAX_WRITES_ENV} must be exactly 7`);
  }
  if ((process.env.HEDERA_NETWORK?.trim() || REQUIRED_NETWORK) !== REQUIRED_NETWORK) {
    fail("NETWORK", `network must be ${REQUIRED_NETWORK}`);
  }
  if ((process.env.USDC_TOKEN_ID?.trim() || VERIFIED_USDC_TOKEN_ID) !== VERIFIED_USDC_TOKEN_ID) {
    fail("TOKEN", `token must be ${VERIFIED_USDC_TOKEN_ID}`);
  }
  if (process.env.ROUTEGUARD_OPERATIONS_LIVE_ENABLED?.trim() === "true") {
    fail("LIVE_MODE", "ROUTEGUARD_OPERATIONS_LIVE_ENABLED must remain false");
  }
}

export function projectDemoInfrastructureWrites(bytecodeBytes: number): {
  fileCreateWrites: number;
  fileAppendWrites: number;
  contractCreateWrites: number;
  contractAssociationWrites: number;
  topicCreateWrites: number;
  totalStateChangingWrites: number;
  bytecodeHexChars: number;
} {
  if (!Number.isSafeInteger(bytecodeBytes) || bytecodeBytes <= 0) fail("BYTECODE", "bytecode size invalid");
  const bytecodeHexChars = bytecodeBytes * 2;
  const fileAppendWrites = Math.ceil(Math.max(0, bytecodeHexChars - FILE_CREATE_CHARS) / FILE_APPEND_CHARS);
  return {
    fileCreateWrites: 1,
    fileAppendWrites,
    contractCreateWrites: 1,
    contractAssociationWrites: 1,
    topicCreateWrites: 1,
    totalStateChangingWrites: 4 + fileAppendWrites,
    bytecodeHexChars,
  };
}

function compileAndVerify(): CompiledEscrow {
  const result = compileContracts();
  if (result.solcVersion !== ACCEPTED_SOLC_VERSION) fail("SOLC", "compiler version differs from accepted Phase C artifact");
  const compiled = result.contracts.RouteGuardFreightEscrow;
  if (!compiled?.bytecode) fail("BYTECODE", "compiled production escrow bytecode missing");
  const bytecodeHex = normalizeHex(compiled.bytecode);
  if (!/^[0-9a-f]+$/.test(bytecodeHex) || bytecodeHex.length % 2 !== 0) fail("BYTECODE", "compiled bytecode is not valid hex");
  const bytecodeSha256 = sha256(Buffer.from(bytecodeHex, "hex"));
  if (bytecodeSha256 !== ACCEPTED_BYTECODE_SHA256) fail("BYTECODE", "compiled hash differs from accepted Phase C artifact");

  const artifact = readJson<{ bytecode?: string; solcVersion?: string }>(ARTIFACT_PATH);
  if (!artifact?.bytecode || artifact.solcVersion !== ACCEPTED_SOLC_VERSION) fail("ARTIFACT", "accepted production artifact is missing or has the wrong compiler");
  if (sha256(Buffer.from(normalizeHex(artifact.bytecode), "hex")) !== bytecodeSha256) fail("ARTIFACT", "accepted artifact bytecode differs from current compilation");
  const phaseC = readJson<{ bytecodeSha256?: string; bytecodeBytes?: number }>(path.join("evidence", "v2", "escrow", "deployment.json"));
  if (phaseC?.bytecodeSha256 !== bytecodeSha256 || phaseC.bytecodeBytes !== bytecodeHex.length / 2) {
    fail("PHASE_C", "compiled bytecode identity differs from immutable Phase C evidence");
  }
  return { bytecodeHex, bytecodeSha256, bytecodeBytes: bytecodeHex.length / 2, solcVersion: result.solcVersion };
}

function runOfflinePreflight(): CompiledEscrow {
  const vitest = path.resolve("node_modules", "vitest", "vitest.mjs");
  run(process.execPath, [vitest, "run", "test/operations-demo-core.test.ts", "test/demo-infrastructure-runner.test.ts"], "FOCUSED_TESTS");
  const compiled = compileAndVerify();
  run(process.execPath, [vitest, "run", "test/escrow-contract-registration.test.ts", "test/escrow-contract-settlement.test.ts", "test/escrow-contract-security.test.ts"], "SOLIDITY_TESTS");
  const plan = projectDemoInfrastructureWrites(compiled.bytecodeBytes);
  if (plan.fileAppendWrites !== REQUIRED_FILE_APPENDS || plan.totalStateChangingWrites !== DEMO_INFRA_MAX_WRITES) {
    fail("WRITE_PROJECTION", `requires ${plan.fileAppendWrites} file appends and ${plan.totalStateChangingWrites} total writes`);
  }
  return compiled;
}

async function mirrorGet<T>(urlPath: string): Promise<T> {
  const response = await fetch(`${HEDERA_TESTNET_MIRROR_NODE}${urlPath}`, { headers: { accept: "application/json" } });
  if (!response.ok) fail("MIRROR", `HTTP ${response.status} for ${urlPath}`);
  return (await response.json()) as T;
}

async function mirrorTransaction(transactionId: string, attempts = 20): Promise<MirrorTx> {
  const mirrorTransactionId = toMirrorTransactionId(transactionId);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(`${HEDERA_TESTNET_MIRROR_NODE}/api/v1/transactions/${encodeURIComponent(mirrorTransactionId)}`, { headers: { accept: "application/json" } });
    if (response.ok) {
      const body = (await response.json()) as { transactions?: Array<{ result?: string; consensus_timestamp?: string; entity_id?: string; nonce?: number; parent_consensus_timestamp?: string | null }> };
      const entries = body.transactions ?? [];
      const parent = entries.find((entry) => !entry.parent_consensus_timestamp && (entry.nonce ?? 0) === 0) ?? entries[0];
      if (parent?.result) {
        let logs: Array<{ topics: string[]; data: string }> = [];
        try {
          const result = await mirrorGet<{ logs?: Array<{ topics?: string[]; data?: string }> }>(`/api/v1/contracts/results/${encodeURIComponent(mirrorTransactionId)}`);
          logs = (result.logs ?? []).map((log) => ({ topics: log.topics ?? [], data: log.data ?? "" }));
        } catch {
          // File and topic transactions do not have contract results.
        }
        return {
          transactionId,
          mirrorTransactionId,
          result: parent.result,
          consensusTimestamp: parent.consensus_timestamp ?? null,
          entityId: parent.entity_id ?? null,
          childTransactionCount: entries.filter((entry) => Boolean(entry.parent_consensus_timestamp) || (entry.nonce ?? 0) > 0).length,
          logs,
          hashScanUrl: hashScanTransactionUrl(transactionId),
          mirrorStatus: entries.every((entry) => entry.result === "SUCCESS") ? "SUCCESS" : "FAILED",
        };
      }
    } else if (response.status !== 404) {
      fail("MIRROR", `transaction lookup HTTP ${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  return { transactionId, mirrorTransactionId, result: null, consensusTimestamp: null, entityId: null, childTransactionCount: 0, logs: [], hashScanUrl: hashScanTransactionUrl(transactionId), mirrorStatus: "NOT_FOUND" };
}

async function mirrorContractCall(contractEvmAddress: string, fn: string, args: readonly unknown[]): Promise<readonly unknown[]> {
  const data = escrowInterface.encodeFunctionData(fn, args as unknown[]);
  const response = await fetch(`${HEDERA_TESTNET_MIRROR_NODE}/api/v1/contracts/call`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ to: contractEvmAddress, data, estimate: false }),
  });
  if (!response.ok) fail("MIRROR_CALL", `${fn} returned HTTP ${response.status}`);
  const body = (await response.json()) as { result?: string };
  if (!body.result) fail("MIRROR_CALL", `${fn} returned no result`);
  return escrowInterface.decodeFunctionResult(fn, body.result);
}

function contractBytecode(body: { bytecode?: string; runtime_bytecode?: string }): string {
  const value = body.runtime_bytecode || body.bytecode;
  if (!value) fail("CONTRACT_BYTECODE", "Mirror contract response has no runtime bytecode");
  return normalizeHex(value);
}

async function proofSnapshot(): Promise<ProofSnapshot> {
  const [contract, topic, total] = await Promise.all([
    mirrorGet<{ contract_id?: string; evm_address?: string; bytecode?: string; runtime_bytecode?: string }>(`/api/v1/contracts/${IMMUTABLE_PROOF_CONTRACT_ID}`),
    mirrorGet<{ topic_id?: string; sequence_number?: number }>(`/api/v1/topics/${IMMUTABLE_PROOF_TOPIC_ID}`),
    mirrorContractCall(IMMUTABLE_PROOF_CONTRACT_EVM, "totalEscrowedAmount", []),
  ]);
  return {
    contractId: contract.contract_id ?? IMMUTABLE_PROOF_CONTRACT_ID,
    contractEvmAddress: (contract.evm_address?.startsWith("0x") ? contract.evm_address : `0x${contract.evm_address ?? ""}`).toLowerCase(),
    contractBytecodeSha256: sha256(Buffer.from(contractBytecode(contract), "hex")),
    contractTotalEscrowedAtomic: String(total[0]),
    topicId: topic.topic_id ?? IMMUTABLE_PROOF_TOPIC_ID,
    topicSequenceNumber: Number(topic.sequence_number),
  };
}

function parsePrivateKey(raw: string): PrivateKey {
  try {
    return PrivateKey.fromStringECDSA(raw.trim());
  } catch {
    try {
      return PrivateKey.fromString(raw.trim());
    } catch {
      fail("OPERATOR_KEY", "configured operator private key could not be parsed");
    }
  }
}

async function networkPreflight(compiled: CompiledEscrow): Promise<{
  operatorAccountId: string;
  operatorEvmAddress: string;
  operatorKey: PrivateKey;
  operatorPublicKey: string;
  tokenEvmAddress: string;
  operatorHbarTinybars: string;
  proofBefore: ProofSnapshot;
}> {
  const operatorAccountId = process.env.OPERATOR_ACCOUNT_ID?.trim() || process.env.SHIPPER_ACCOUNT_ID?.trim();
  if (!operatorAccountId) fail("OPERATOR_ACCOUNT", "operator account configuration is missing");
  if (operatorAccountId !== DEMO_OPERATOR_ACCOUNT_ID) fail("OPERATOR_ACCOUNT", `configured owner must be ${DEMO_OPERATOR_ACCOUNT_ID}`);
  const rawKey = process.env.ROUTEGUARD_OPERATOR_PRIVATE_KEY?.trim() || process.env.OPERATOR_PRIVATE_KEY?.trim() || process.env.SHIPPER_PRIVATE_KEY?.trim();
  if (!rawKey) fail("OPERATOR_KEY", "operator private key is missing");
  const operatorKey = parsePrivateKey(rawKey);
  const operatorPublicKey = operatorKey.publicKey.toStringRaw().toLowerCase();

  const [account, token, proofBefore] = await Promise.all([
    mirrorGet<MirrorAccount>(`/api/v1/accounts/${operatorAccountId}`),
    mirrorGet<{ token_id?: string; decimals?: string | number; deleted?: boolean }>(`/api/v1/tokens/${VERIFIED_USDC_TOKEN_ID}`),
    proofSnapshot(),
  ]);
  if (account.account !== operatorAccountId || account.deleted === true) fail("OPERATOR_ACCOUNT", "Mirror operator identity is invalid");
  if (account.key?._type !== "ECDSA_SECP256K1" || normalizeHex(account.key.key ?? "") !== operatorPublicKey) {
    fail("OPERATOR_KEY", "operator key does not match the configured account");
  }
  const hbar = BigInt(account.balance?.balance ?? 0);
  if (hbar < MIN_OPERATOR_HBAR_TINYBARS) fail("OPERATOR_BALANCE", "operator HBAR balance is insufficient");
  if (token.token_id !== VERIFIED_USDC_TOKEN_ID || Number(token.decimals) !== VERIFIED_USDC_DECIMALS || token.deleted === true) {
    fail("TOKEN", "Mirror token identity or decimals are invalid");
  }
  if (proofBefore.contractId !== IMMUTABLE_PROOF_CONTRACT_ID || proofBefore.contractEvmAddress !== IMMUTABLE_PROOF_CONTRACT_EVM || proofBefore.topicId !== IMMUTABLE_PROOF_TOPIC_ID) {
    fail("IMMUTABLE_PROOF", "completed proof infrastructure identity mismatch");
  }
  const plan = projectDemoInfrastructureWrites(compiled.bytecodeBytes);
  if (plan.fileAppendWrites !== 3 || plan.totalStateChangingWrites !== 7) fail("WRITE_PROJECTION", "exact seven-write plan is not available");
  return {
    operatorAccountId,
    operatorEvmAddress: (account.evm_address ? (account.evm_address.startsWith("0x") ? account.evm_address : `0x${account.evm_address}`) : longZero(operatorAccountId)).toLowerCase(),
    operatorKey,
    operatorPublicKey,
    tokenEvmAddress: longZero(VERIFIED_USDC_TOKEN_ID),
    operatorHbarTinybars: hbar.toString(),
    proofBefore,
  };
}

function successfulWriteCount(progress: Progress): number {
  return TX_STEPS.filter((step) => progress.transactions[step]?.receiptStatus === "SUCCESS").length;
}

async function reconcileRecorded(progress: Progress, step: TxStep): Promise<TxRecord | null> {
  const existing = progress.transactions[step];
  if (!existing) return null;
  if (existing.mirrorStatus === "SUCCESS") return existing;
  const mirror = await mirrorTransaction(existing.transactionId);
  if (mirror.mirrorStatus === "SUCCESS") {
    const record: TxRecord = { ...mirror, step, receiptStatus: "SUCCESS" };
    progress.transactions[step] = record;
    saveProgress(progress);
    return record;
  }
  fail("AMBIGUOUS_TRANSACTION", `${step} has persisted transaction ${existing.transactionId} but Mirror status is ${mirror.mirrorStatus}`);
}

function receiptEntityId(step: TxStep, receipt: TransactionReceipt): string | null {
  if (step === "bytecode_file_create") return receipt.fileId?.toString() ?? null;
  if (step === "contract_create") return receipt.contractId?.toString() ?? null;
  if (step === "topic_create") return receipt.topicId?.toString() ?? null;
  return null;
}

async function submit(
  progress: Progress,
  client: Client,
  operatorKey: PrivateKey,
  step: TxStep,
  build: (transactionId: TransactionId) => Transaction,
): Promise<TxRecord> {
  const reconciled = await reconcileRecorded(progress, step);
  if (reconciled) return reconciled;
  if (successfulWriteCount(progress) >= DEMO_INFRA_MAX_WRITES) fail("WRITE_CAP", "successful write ceiling exhausted");

  const transactionId = TransactionId.generate(AccountId.fromString(progress.operatorAccountId));
  const txId = transactionId.toString();
  progress.transactions[step] = {
    step,
    transactionId: txId,
    mirrorTransactionId: toMirrorTransactionId(txId),
    result: null,
    consensusTimestamp: null,
    entityId: null,
    childTransactionCount: 0,
    logs: [],
    hashScanUrl: hashScanTransactionUrl(txId),
    mirrorStatus: "NOT_FOUND",
    receiptStatus: "PENDING",
  };
  saveProgress(progress);

  let receipt: TransactionReceipt;
  try {
    const transaction = build(transactionId).freezeWith(client);
    const signed = await transaction.sign(operatorKey);
    const response = await signed.execute(client);
    receipt = await response.getReceipt(client);
  } catch {
    fail("SUBMISSION", `${step} failed or is ambiguous; transaction id retained for Mirror reconciliation`);
  }
  if (receipt.status !== Status.Success) fail("RECEIPT", `${step} receipt was not SUCCESS`);
  const pending = progress.transactions[step]!;
  progress.transactions[step] = { ...pending, receiptStatus: "SUCCESS", result: "SUCCESS", entityId: receiptEntityId(step, receipt) };
  saveProgress(progress);

  const mirror = await mirrorTransaction(txId);
  if (mirror.mirrorStatus !== "SUCCESS") fail("MIRROR", `${step} receipt succeeded but Mirror verification is ${mirror.mirrorStatus}`);
  const complete: TxRecord = { ...mirror, step, receiptStatus: "SUCCESS", entityId: mirror.entityId ?? receiptEntityId(step, receipt) };
  progress.transactions[step] = complete;
  saveProgress(progress);
  console.log(`WRITE_OK step=${step} count=${successfulWriteCount(progress)}/7 tx=${txId}`);
  return complete;
}

async function executeWrites(progress: Progress, compiled: CompiledEscrow, client: Client, operatorKey: PrivateKey): Promise<void> {
  const asciiHex = compiled.bytecodeHex;
  const chunks = [
    asciiHex.slice(0, FILE_CREATE_CHARS),
    ...Array.from({ length: 3 }, (_, index) => asciiHex.slice(FILE_CREATE_CHARS + index * FILE_APPEND_CHARS, FILE_CREATE_CHARS + (index + 1) * FILE_APPEND_CHARS)),
  ];
  if (chunks.length !== 4 || chunks.some((chunk) => chunk.length === 0) || chunks.join("") !== asciiHex) fail("CHUNKING", "bytecode does not map to one create plus three appends");

  const fileCreate = await submit(progress, client, operatorKey, "bytecode_file_create", (transactionId) =>
    new FileCreateTransaction()
      .setTransactionId(transactionId)
      .setKeys([operatorKey.publicKey])
      .setContents(chunks[0]!)
      .setFileMemo("RouteGuard Operations Demo escrow bytecode")
      .setMaxTransactionFee(new Hbar(30)),
  );
  progress.fileId = progress.fileId ?? fileCreate.entityId;
  if (!progress.fileId) fail("FILE_CREATE", "successful file create has no file id");
  saveProgress(progress);

  for (let index = 1; index <= 3; index += 1) {
    const step = `bytecode_file_append_${index}` as TxStep;
    await submit(progress, client, operatorKey, step, (transactionId) =>
      new FileAppendTransaction()
        .setTransactionId(transactionId)
        .setFileId(progress.fileId!)
        .setContents(chunks[index]!)
        .setChunkSize(FILE_APPEND_CHARS)
        .setMaxChunks(1)
        .setMaxTransactionFee(new Hbar(30)),
    );
  }

  const constructor = new ContractFunctionParameters().addAddress(progress.tokenEvmAddress).addAddress(progress.operatorEvmAddress);
  const contractCreate = await submit(progress, client, operatorKey, "contract_create", (transactionId) =>
    new ContractCreateTransaction()
      .setTransactionId(transactionId)
      .setBytecodeFileId(progress.fileId!)
      .setGas(DEPLOY_GAS)
      .setConstructorParameters(constructor)
      .setContractMemo(CONTRACT_MEMO)
      .setMaxTransactionFee(new Hbar(50)),
  );
  progress.contractId = progress.contractId ?? contractCreate.entityId;
  if (!progress.contractId) fail("CONTRACT_CREATE", "successful contract create has no contract id");
  if (progress.contractId === IMMUTABLE_PROOF_CONTRACT_ID) fail("CONTRACT_CREATE", "new contract equals immutable proof contract");
  progress.contractEvmAddress = longZero(progress.contractId).toLowerCase();
  if (progress.contractEvmAddress === IMMUTABLE_PROOF_CONTRACT_EVM) fail("CONTRACT_CREATE", "new EVM address equals immutable proof contract");
  saveProgress(progress);

  await submit(progress, client, operatorKey, "contract_association", (transactionId) =>
    new ContractExecuteTransaction()
      .setTransactionId(transactionId)
      .setContractId(ContractId.fromString(progress.contractId!))
      .setGas(ASSOCIATION_GAS)
      .setFunction("associateEscrowToken")
      .setMaxTransactionFee(new Hbar(10)),
  );

  const topicCreate = await submit(progress, client, operatorKey, "topic_create", (transactionId) =>
    new TopicCreateTransaction()
      .setTransactionId(transactionId)
      .setTopicMemo(TOPIC_MEMO)
      .setAdminKey(operatorKey.publicKey)
      .setSubmitKey(operatorKey.publicKey)
      .setAutoRenewAccountId(AccountId.fromString(progress.operatorAccountId))
      .setMaxTransactionFee(new Hbar(5)),
  );
  progress.topicId = progress.topicId ?? topicCreate.entityId;
  if (!progress.topicId) fail("TOPIC_CREATE", "successful topic create has no topic id");
  if (progress.topicId === IMMUTABLE_PROOF_TOPIC_ID) fail("TOPIC_CREATE", "new topic equals immutable proof topic");
  saveProgress(progress);
}

async function verifyAndWriteEvidence(progress: Progress, compiled: CompiledEscrow, operatorHbarBefore: string): Promise<void> {
  if (!progress.fileId || !progress.contractId || !progress.contractEvmAddress || !progress.topicId) fail("VERIFY", "infrastructure identities incomplete");
  for (const step of TX_STEPS) {
    const record = await reconcileRecorded(progress, step);
    if (!record || record.mirrorStatus !== "SUCCESS") fail("VERIFY", `${step} is not Mirror SUCCESS`);
  }
  if (successfulWriteCount(progress) !== 7) fail("WRITE_ACCOUNTING", "successful write count is not exactly seven");

  const [contract, proofContract, tokenRelationships, topic, topicMessages, proofAfter] = await Promise.all([
    mirrorGet<{ contract_id?: string; evm_address?: string; bytecode?: string; runtime_bytecode?: string; memo?: string; expiration_timestamp?: string; auto_renew_account?: string; auto_renew_period?: number }>(`/api/v1/contracts/${progress.contractId}`),
    mirrorGet<{ bytecode?: string; runtime_bytecode?: string }>(`/api/v1/contracts/${IMMUTABLE_PROOF_CONTRACT_ID}`),
    mirrorGet<{ tokens?: Array<{ token_id?: string; balance?: number; automatic_association?: boolean }> }>(`/api/v1/accounts/${progress.contractId}/tokens?limit=100`),
    mirrorGet<{ topic_id?: string; memo?: string; sequence_number?: number; submit_key?: { _type?: string; key?: string } | null; admin_key?: { _type?: string; key?: string } | null; auto_renew_account?: string | null; auto_renew_period?: number | null }>(`/api/v1/topics/${progress.topicId}`),
    mirrorGet<{ messages?: unknown[] }>(`/api/v1/topics/${progress.topicId}/messages?limit=1`),
    proofSnapshot(),
  ]);

  const fileSteps: TxStep[] = ["bytecode_file_create", "bytecode_file_append_1", "bytecode_file_append_2", "bytecode_file_append_3", "contract_create"];
  const fileConsensus = fileSteps.map((step) => progress.transactions[step]?.consensusTimestamp ?? fail("FILE_VERIFY", `${step} consensus timestamp is missing`));
  for (let index = 1; index < fileConsensus.length; index += 1) {
    if (Number(fileConsensus[index]) <= Number(fileConsensus[index - 1])) fail("FILE_VERIFY", "file writes and contract create are not in consensus order");
  }
  const newRuntime = contractBytecode(contract);
  const proofRuntime = contractBytecode(proofContract);
  if (newRuntime !== proofRuntime) fail("RUNTIME_BYTECODE", "new contract runtime differs from completed proof contract");
  const mirrorEvm = (contract.evm_address?.startsWith("0x") ? contract.evm_address : `0x${contract.evm_address ?? ""}`).toLowerCase();
  if (contract.contract_id !== progress.contractId || mirrorEvm !== progress.contractEvmAddress) fail("CONTRACT_VERIFY", "Mirror contract identity mismatch");

  const tenderKeys = [
    `0x${sha256("ROUTEGUARD_DEMO_INFRA_UNUSED_TENDER_1")}`,
    `0x${sha256("ROUTEGUARD_DEMO_INFRA_UNUSED_TENDER_2")}`,
  ];
  const [owner, token, total, stateOne, stateTwo, balanceOne, balanceTwo] = await Promise.all([
    mirrorContractCall(progress.contractEvmAddress, "owner", []),
    mirrorContractCall(progress.contractEvmAddress, "escrowToken", []),
    mirrorContractCall(progress.contractEvmAddress, "totalEscrowedAmount", []),
    mirrorContractCall(progress.contractEvmAddress, "getState", [tenderKeys[0]]),
    mirrorContractCall(progress.contractEvmAddress, "getState", [tenderKeys[1]]),
    mirrorContractCall(progress.contractEvmAddress, "tenderBalance", [tenderKeys[0]]),
    mirrorContractCall(progress.contractEvmAddress, "tenderBalance", [tenderKeys[1]]),
  ]);
  const relation = (tokenRelationships.tokens ?? []).find((entry) => entry.token_id === VERIFIED_USDC_TOKEN_ID);
  if (String(owner[0]).toLowerCase() !== progress.operatorEvmAddress || String(token[0]).toLowerCase() !== progress.tokenEvmAddress) fail("CONTRACT_VERIFY", "owner or token binding mismatch");
  if (String(total[0]) !== "0" || String(stateOne[0]) !== "0" || String(stateTwo[0]) !== "0" || String(balanceOne[0]) !== "0" || String(balanceTwo[0]) !== "0") fail("CONTRACT_VERIFY", "new escrow is not empty and unregistered");
  if (!relation || Number(relation.balance ?? 0) !== 0) fail("ASSOCIATION_VERIFY", "USDC association is missing or balance is nonzero");

  const association = progress.transactions.contract_association!;
  let associationResponseCode: string | null = null;
  for (const log of association.logs) {
    try {
      const parsed = escrowInterface.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name === "EscrowTokenAssociated") associationResponseCode = String(parsed.args.responseCode);
    } catch {
      // Ignore unrelated logs.
    }
  }
  if (associationResponseCode !== "22" && associationResponseCode !== "194") fail("ASSOCIATION_VERIFY", "association response code is not SUCCESS or already-associated");

  const normalizedPublicKey = normalizeHex(progress.operatorPublicKey);
  const topicMessageCount = (topicMessages.messages ?? []).length;
  const topicSequenceNumber = typeof topic.sequence_number === "number" ? topic.sequence_number : topicMessageCount === 0 ? 0 : -1;
  if (topic.topic_id !== progress.topicId || topic.memo !== TOPIC_MEMO || topicSequenceNumber !== 0 || topicMessageCount !== 0) fail("TOPIC_VERIFY", "topic identity, memo, or empty sequence invariant failed");
  if (topic.submit_key?._type !== "ECDSA_SECP256K1" || normalizeHex(topic.submit_key.key ?? "") !== normalizedPublicKey) fail("TOPIC_VERIFY", "submit key is not bound to the operator");
  if (topic.admin_key?._type !== "ECDSA_SECP256K1" || normalizeHex(topic.admin_key.key ?? "") !== normalizedPublicKey) fail("TOPIC_VERIFY", "admin key is not bound to the accepted operator convention");
  if (topic.auto_renew_account !== progress.operatorAccountId) fail("TOPIC_VERIFY", "auto-renew account is not the operator");
  if (JSON.stringify(proofAfter) !== JSON.stringify(progress.proofBefore)) fail("IMMUTABLE_PROOF", "completed proof contract or topic changed during the run");

  const txs = Object.fromEntries(TX_STEPS.map((step) => [step, progress.transactions[step]]));
  const common = { runId: progress.runId, network: progress.network, tokenId: progress.tokenId };
  writeJson(path.join(EVIDENCE_DIR, "preflight.json"), {
    ...common,
    branch: DEMO_INFRA_REQUIRED_BRANCH,
    baseline: DEMO_INFRA_BASELINE,
    bytecodeSha256: progress.bytecodeSha256,
    bytecodeBytes: progress.bytecodeBytes,
    bytecodeHexChars: progress.bytecodeHexChars,
    solcVersion: progress.solcVersion,
    sourceUnchangedFromBaseline: true,
    operatorAccountId: progress.operatorAccountId,
    operatorEvmAddress: progress.operatorEvmAddress,
    operatorHbarTinybarsBefore: operatorHbarBefore,
    tokenDecimals: VERIFIED_USDC_DECIMALS,
    projectedWrites: 7,
    fileCreateWrites: 1,
    fileAppendWrites: 3,
    contractCreateWrites: 1,
    contractAssociationWrites: 1,
    topicCreateWrites: 1,
    queryPaymentTransactions: 0,
  });
  writeJson(path.join(EVIDENCE_DIR, "bytecode-file-create.json"), { ...common, fileId: progress.fileId, byteCount: FILE_CREATE_CHARS, transaction: txs.bytecode_file_create });
  writeJson(path.join(EVIDENCE_DIR, "bytecode-file-appends.json"), { ...common, fileId: progress.fileId, appendCount: 3, transactions: [txs.bytecode_file_append_1, txs.bytecode_file_append_2, txs.bytecode_file_append_3], finalFileLength: compiled.bytecodeHex.length, finalFileSha256: sha256(compiled.bytecodeHex), intendedFileSha256: sha256(compiled.bytecodeHex), matchesIntendedBytecode: true, consensusOrderVerified: true, verificationMethod: "accepted local bytecode chunks plus four Mirror SUCCESS file transactions plus matching deployed runtime bytecode; free Mirror REST exposes no file-content endpoint" });
  writeJson(path.join(EVIDENCE_DIR, "contract-create.json"), { ...common, contractId: progress.contractId, contractEvmAddress: progress.contractEvmAddress, memo: CONTRACT_MEMO, constructorArguments: { escrowToken: progress.tokenEvmAddress, owner: progress.operatorEvmAddress }, bytecodeSha256: progress.bytecodeSha256, runtimeBytecodeSha256: sha256(Buffer.from(newRuntime, "hex")), runtimeMatchesCompletedProof: true, expirationTimestamp: contract.expiration_timestamp ?? null, autoRenewAccount: contract.auto_renew_account ?? null, autoRenewPeriod: contract.auto_renew_period ?? null, transaction: txs.contract_create });
  writeJson(path.join(EVIDENCE_DIR, "contract-association.json"), { ...common, contractId: progress.contractId, associated: true, responseCode: associationResponseCode, tokenBalanceAtomic: String(relation.balance ?? 0), transaction: txs.contract_association });
  writeJson(path.join(EVIDENCE_DIR, "topic-create.json"), { ...common, topicId: progress.topicId, memo: TOPIC_MEMO, submitKeyType: topic.submit_key?._type ?? null, submitKeyBoundToOperator: true, adminKeyPresent: Boolean(topic.admin_key), adminKeyBoundToOperator: true, autoRenewAccount: topic.auto_renew_account ?? null, autoRenewPeriod: topic.auto_renew_period ?? null, sequenceNumber: 0, transaction: txs.topic_create });
  writeJson(path.join(EVIDENCE_DIR, "contract-verification.json"), { ...common, contractId: progress.contractId, contractEvmAddress: progress.contractEvmAddress, exists: true, runtimeMatchesCompletedProof: true, owner: String(owner[0]), escrowToken: String(token[0]), totalEscrowedAtomic: "0", usdcBalanceAtomic: "0", usdcAssociated: true, unusedTenderKeys: tenderKeys.map((tenderKey) => ({ tenderKey, state: "UNREGISTERED", balanceAtomic: "0" })), noTenderFunded: true, noCarrierAllocated: true, noFreightReleaseOccurred: true });
  writeJson(path.join(EVIDENCE_DIR, "topic-verification.json"), { ...common, topicId: progress.topicId, exists: true, memo: TOPIC_MEMO, sequenceNumber: 0, messageCount: 0, submitAuthority: progress.operatorAccountId, separateFromImmutableProofTopic: true });
  writeJson(path.join(EVIDENCE_DIR, "mirror-verification.json"), { ...common, allSevenTransactionsMirrorSuccess: true, transactions: txs, proofBefore: progress.proofBefore, proofAfter });
  writeJson(path.join(EVIDENCE_DIR, "write-accounting.json"), { ...common, fileCreateWrites: 1, fileAppendWrites: 3, contractCreateWrites: 1, contractAssociationWrites: 1, hcsTopicCreateWrites: 1, x402Writes: 0, hcsMessageWrites: 0, demoSessionWrites: 0, queryPaymentTransactions: 0, totalStateChangingWrites: 7, childTransactionCount: TX_STEPS.reduce((sum, step) => sum + (progress.transactions[step]?.childTransactionCount ?? 0), 0), childTransactionsCountedAsApplicationWrites: false });
  writeJson(path.join(EVIDENCE_DIR, "run-summary.json"), {
    ...common,
    status: "SUCCESS",
    fileId: progress.fileId,
    contractId: progress.contractId,
    contractEvmAddress: progress.contractEvmAddress,
    topicId: progress.topicId,
    bytecodeSha256: progress.bytecodeSha256,
    associationTransactionId: progress.transactions.contract_association!.transactionId,
    topicCreateTransactionId: progress.transactions.topic_create!.transactionId,
    totalStateChangingWrites: 7,
    queryPaymentTransactions: 0,
    contractTotalEscrowedAtomic: "0",
    contractUsdcBalanceAtomic: "0",
    unusedTenderState: "UNREGISTERED",
    topicSequenceNumber: 0,
    topicMessageCount: 0,
    immutableProofContractUnchanged: true,
    immutableProofTopicUnchanged: true,
    liveModeDefault: "DISABLED",
    liveInfrastructureStatus: "READY_DISABLED_BY_DEFAULT",
    nextStep: "One supervised 12-write Operations Demo session at 20000 / 15000 / 5000 atomic economics, followed by frontend integration.",
  });
  writeFileSync(path.join(EVIDENCE_DIR, "README.md"), `# RouteGuard Operations Demo infrastructure\n\nRun \`${progress.runId}\` deployed dedicated reusable Operations Demo infrastructure on Hedera testnet with exactly seven application state-changing writes.\n\n- Escrow: \`${progress.contractId}\` / \`${progress.contractEvmAddress}\`\n- HCS topic: \`${progress.topicId}\`\n- HTS USDC: \`${VERIFIED_USDC_TOKEN_ID}\`\n- Bytecode SHA-256: \`${progress.bytecodeSha256}\` (identical production bytecode to completed Phase C)\n- Contract funds: zero; no tender registered or funded\n- Topic messages: zero; sequence number zero\n- Completed proof contract \`${IMMUTABLE_PROOF_CONTRACT_ID}\` and topic \`${IMMUTABLE_PROOF_TOPIC_ID}\` remain separate and unchanged\n- Public live mode remains disabled\n- One supervised 12-write interactive session remains pending\n\nThis evidence contains public identifiers and verification facts only. It contains no private keys, mnemonics, raw signed transactions, environment contents, or admin token.\n`, "utf8");
}

function completedSummary(): { status?: string; runId?: string; contractId?: string; contractEvmAddress?: string; topicId?: string } | null {
  return readJson(path.join(EVIDENCE_DIR, "run-summary.json"));
}

function printCore(progress: Progress): void {
  console.log(`LIVE_PREFLIGHT=PASS`);
  console.log(`LIVE_RUN_ID=${progress.runId}`);
  console.log(`BYTECODE_IDENTITY=PASS`);
  console.log(`BYTECODE_FILE_CREATE=PASS`);
  console.log(`BYTECODE_FILE_ID=${progress.fileId ?? "NONE"}`);
  console.log(`BYTECODE_FILE_CREATE_TX=${progress.transactions.bytecode_file_create?.transactionId ?? "NONE"}`);
  console.log(`BYTECODE_FILE_APPEND_COUNT=3`);
  console.log(`BYTECODE_FILE_APPEND_TXS=${[1, 2, 3].map((index) => progress.transactions[`bytecode_file_append_${index}` as TxStep]?.transactionId).join(",")}`);
  console.log(`CONTRACT_CREATE=PASS`);
  console.log(`DEMO_CONTRACT_ID=${progress.contractId ?? "NONE"}`);
  console.log(`DEMO_CONTRACT_EVM_ADDRESS=${progress.contractEvmAddress ?? "NONE"}`);
  console.log(`DEMO_CONTRACT_CREATE_TX=${progress.transactions.contract_create?.transactionId ?? "NONE"}`);
  console.log(`DEMO_CONTRACT_OWNER=${progress.operatorAccountId}`);
  console.log(`DEMO_CONTRACT_TOKEN=${progress.tokenId}`);
  console.log(`DEMO_CONTRACT_ASSOCIATION=PASS`);
  console.log(`DEMO_CONTRACT_ASSOCIATION_TX=${progress.transactions.contract_association?.transactionId ?? "NONE"}`);
  console.log(`HCS_TOPIC_CREATE=PASS`);
  console.log(`DEMO_HCS_TOPIC_ID=${progress.topicId ?? "NONE"}`);
  console.log(`DEMO_HCS_TOPIC_CREATE_TX=${progress.transactions.topic_create?.transactionId ?? "NONE"}`);
  console.log(`TOTAL_STATE_CHANGING_WRITES=${successfulWriteCount(progress)}`);
  console.log(`NETWORK_WRITES=${successfulWriteCount(progress)}`);
}

export async function main(): Promise<void> {
  const preflightOnly = process.argv.includes("--preflight-only");
  secretStatus();
  assertGitGate();
  requireGuards();
  const existingSummary = completedSummary();
  if (existingSummary?.status === "SUCCESS") {
    const progress = readJson<Progress>(PROGRESS_PATH);
    if (!progress || progress.status !== "SUCCESS") fail("COMPLETED_EVIDENCE", "successful evidence exists without matching completed progress");
    printCore(progress);
    return;
  }

  const compiled = runOfflinePreflight();
  const network = await networkPreflight(compiled);
  const preflightDocument = {
    runId: readJson<Progress>(PROGRESS_PATH)?.runId ?? null,
    branch: DEMO_INFRA_REQUIRED_BRANCH,
    baseline: DEMO_INFRA_BASELINE,
    network: REQUIRED_NETWORK,
    tokenId: VERIFIED_USDC_TOKEN_ID,
    tokenDecimals: VERIFIED_USDC_DECIMALS,
    bytecodeSha256: compiled.bytecodeSha256,
    bytecodeBytes: compiled.bytecodeBytes,
    bytecodeHexChars: compiled.bytecodeHex.length,
    solcVersion: compiled.solcVersion,
    operatorAccountId: network.operatorAccountId,
    operatorEvmAddress: network.operatorEvmAddress,
    operatorHbarTinybarsBefore: network.operatorHbarTinybars,
    fileCreateWrites: 1,
    fileAppendWrites: 3,
    contractCreateWrites: 1,
    contractAssociationWrites: 1,
    topicCreateWrites: 1,
    totalStateChangingWrites: 7,
    queryPaymentTransactions: 0,
    sourceUnchangedFromBaseline: true,
    proofBefore: network.proofBefore,
  };
  writeJson(path.join(EVIDENCE_DIR, "preflight.json"), preflightDocument);
  if (preflightOnly) {
    console.log("LIVE_PREFLIGHT=PASS");
    console.log("BYTECODE_IDENTITY=PASS");
    console.log("BYTECODE_FILE_APPEND_COUNT=3");
    console.log("TOTAL_STATE_CHANGING_WRITES=0");
    console.log("NETWORK_WRITES=0");
    console.log("PREFLIGHT_ONLY=YES");
    return;
  }

  let progress = readJson<Progress>(PROGRESS_PATH);
  if (!progress) {
    const now = new Date().toISOString();
    progress = {
      schemaVersion: 1,
      runId: `v2demo-infra-${now.slice(0, 10).replaceAll("-", "")}-${randomBytes(4).toString("hex")}`,
      status: "IN_PROGRESS",
      network: REQUIRED_NETWORK,
      tokenId: VERIFIED_USDC_TOKEN_ID,
      tokenEvmAddress: network.tokenEvmAddress,
      operatorAccountId: network.operatorAccountId,
      operatorEvmAddress: network.operatorEvmAddress,
      operatorPublicKey: network.operatorPublicKey,
      bytecodeSha256: compiled.bytecodeSha256,
      bytecodeBytes: compiled.bytecodeBytes,
      bytecodeHexChars: compiled.bytecodeHex.length,
      solcVersion: compiled.solcVersion,
      projectedWrites: 7,
      fileId: null,
      contractId: null,
      contractEvmAddress: null,
      topicId: null,
      transactions: {},
      proofBefore: network.proofBefore,
      createdAt: now,
      updatedAt: now,
    };
    saveProgress(progress);
  } else {
    if (progress.bytecodeSha256 !== compiled.bytecodeSha256 || progress.operatorAccountId !== network.operatorAccountId || progress.tokenId !== VERIFIED_USDC_TOKEN_ID || JSON.stringify(progress.proofBefore) !== JSON.stringify(network.proofBefore)) {
      fail("RESUME", "persisted run identity does not match the current preflight");
    }
  }

  const client = Client.forTestnet().setOperator(AccountId.fromString(network.operatorAccountId), network.operatorKey).setDefaultMaxTransactionFee(new Hbar(50));
  try {
    await executeWrites(progress, compiled, client, network.operatorKey);
    await verifyAndWriteEvidence(progress, compiled, network.operatorHbarTinybars);
    progress.status = "SUCCESS";
    saveProgress(progress);
    printCore(progress);
  } finally {
    client.close();
  }
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]).endsWith(path.join("scripts", "run-v2-demo-infrastructure-live.ts"));
if (invokedDirectly) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "UNKNOWN: runner failed";
    console.error(`LIVE_PREFLIGHT=FAIL`);
    console.error(`DEMO_INFRASTRUCTURE_FAILED=${message.slice(0, 300)}`);
    process.exitCode = 1;
  });
}
