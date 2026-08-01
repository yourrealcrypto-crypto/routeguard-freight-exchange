import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, fsyncSync, renameSync, writeSync, readFileSync } from "node:fs";
import path from "node:path";

import { PrivateKey } from "@hiero-ledger/sdk";

import { isValidHederaAccountId } from "../domain/payment-option";
import { escrowTenderKey } from "../v2/escrow/tender-key";
import { FINAL_DEMO_FACILITATOR_FEE_PAYER } from "../final-demo/constants";
import { parseMasterKeyBase64 } from "../v2/pod/key-protector";
import { HEDERA_TESTNET_MIRROR_NODE, USDC_SMOKE_APPROVED_FACILITATOR } from "../x402/usdc-constants";
import { MirrorReader } from "../v2/live/mirror-reader";
import {
  DEMO_CARRIER_TREASURY_ACCOUNT_ID,
  DEMO_CONTRACT_EVM_ADDRESS,
  DEMO_CONTRACT_ID,
  DEMO_HCS_TOPIC_ID,
  DEMO_OPERATOR_ACCOUNT_ID,
  DEMO_TOKEN_ID,
  IMMUTABLE_PROOF_CONTRACT_ID,
  IMMUTABLE_PROOF_TOPIC_ID,
  LIVE_PROJECTED_WRITES,
} from "./constants";
import type { OperationsDemoSessionIdentity } from "./orchestrator";

export const OPERATIONS_LIVE_REQUIRED_BRANCH = "testnet/routeguard-v2-operations-demo-session" as const;
export const OPERATIONS_LIVE_BASELINE = "b105809ec8730e39e277621726f140f0138f815e" as const;
export const OPERATIONS_LIVE_CONFIRM_ENV = "ROUTEGUARD_LIVE_V2_DEMO_SESSION_CONFIRM" as const;
export const OPERATIONS_LIVE_CONFIRM_VALUE = "I_UNDERSTAND_TESTNET_DEMO_SESSION_WRITES" as const;
export const OPERATIONS_LIVE_MAX_WRITES_ENV = "ROUTEGUARD_LIVE_V2_DEMO_SESSION_MAX_WRITES" as const;
export const OPERATIONS_LIVE_MAX_WRITES = 12 as const;
export const OPERATIONS_LIVE_DATA_DIR = path.join("data", "v2-operations-demo-session");
export const OPERATIONS_LIVE_EVIDENCE_DIR = path.join("evidence", "v2", "demo-session");
export const MIN_OPERATOR_HBAR_TINYBARS = 500_000_000n;
export const MIN_SHIPPER_USDC_ATOMIC = 25_000n;

export type LiveSessionPlan = OperationsDemoSessionIdentity & {
  readonly schemaVersion: "routeguard-operations-live-plan-1.0";
  readonly createdAt: string;
  readonly tenderVersion: 1;
  readonly tenderKey: string;
  readonly bidId: string;
  readonly carrierId: "carrier-operations-demo";
  readonly actionIds: Readonly<Record<"FUND_ESCROW" | "OPEN_TENDER" | "SUBMIT_OFFER" | "SELECT_WINNER" | "SUBMIT_POD" | "RUN_ADVISORY" | "ACCEPT_POD" | "RELEASE_FREIGHT", string>>;
  readonly idempotencyKeys: Readonly<Record<"FUND_ESCROW" | "OPEN_TENDER" | "SUBMIT_OFFER" | "SELECT_WINNER" | "SUBMIT_POD" | "RUN_ADVISORY" | "ACCEPT_POD" | "RELEASE_FREIGHT", string>>;
  readonly creationAuthorizationHash: string;
  readonly allocationAuthorizationHash: string;
  readonly bidCommitmentSalt: string;
};

export type LiveSecrets = {
  readonly operatorPrivateKey: string;
  readonly carrierPrivateKey: string;
  readonly operatorPublicKey: string;
  readonly carrierPublicKey: string;
  readonly podMasterKeyBase64: string;
  readonly facilitatorUrl: string;
};

export type LivePreflightReport = {
  readonly status: "PASS";
  readonly network: "hedera:testnet";
  readonly contractId: typeof DEMO_CONTRACT_ID;
  readonly contractEvmAddress: typeof DEMO_CONTRACT_EVM_ADDRESS;
  readonly topicId: typeof DEMO_HCS_TOPIC_ID;
  readonly tokenId: typeof DEMO_TOKEN_ID;
  readonly operatorAccountId: typeof DEMO_OPERATOR_ACCOUNT_ID;
  readonly carrierTreasuryAccountId: typeof DEMO_CARRIER_TREASURY_ACCOUNT_ID;
  readonly operatorPublicKeyStatus: "PRESENT";
  readonly carrierPublicKeyStatus: "PRESENT";
  readonly podMasterKeyStatus: "PRESENT";
  readonly operatorEvmAddress: string;
  readonly operatorHbarTinybars: string;
  readonly shipperUsdcAtomic: string;
  readonly carrierTreasuryUsdcAtomic: string;
  readonly contractUsdcAtomic: "0";
  readonly totalEscrowedAtomic: "0";
  readonly newTenderState: "UNREGISTERED";
  readonly newTenderBalanceAtomic: "0";
  readonly topicSequence: 0;
  readonly facilitatorFeePayer: string;
  readonly projectedWrites: 12;
  readonly proofTopicSequence: number;
};

function bytes32(label: string): string {
  return `0x${createHash("sha256").update(label, "utf8").digest("hex")}`;
}

function atomicJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx");
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}

function isPlan(value: unknown): value is LiveSessionPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Partial<LiveSessionPlan>;
  return plan.schemaVersion === "routeguard-operations-live-plan-1.0" &&
    typeof plan.sessionId === "string" && typeof plan.runId === "string" &&
    typeof plan.tenderId === "string" && typeof plan.podId === "string" &&
    plan.tenderVersion === 1 && plan.tenderKey === escrowTenderKey(plan.tenderId, 1) &&
    typeof plan.bidId === "string" && plan.carrierId === "carrier-operations-demo";
}

export function createOrLoadLiveSessionPlan(rootDir = OPERATIONS_LIVE_DATA_DIR): LiveSessionPlan {
  const file = path.join(rootDir, "plan.json");
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!isPlan(parsed)) throw new Error("persisted live session plan is invalid");
    return parsed;
  }
  const suffix = randomUUID();
  const actions = ["FUND_ESCROW", "OPEN_TENDER", "SUBMIT_OFFER", "SELECT_WINNER", "SUBMIT_POD", "RUN_ADVISORY", "ACCEPT_POD", "RELEASE_FREIGHT"] as const;
  const actionIds = Object.fromEntries(actions.map((action, index) => [action, `op-${index + 1}-${action.toLowerCase()}-${suffix}`])) as LiveSessionPlan["actionIds"];
  const idempotencyKeys = Object.fromEntries(actions.map((action, index) => [action, `idem-${index + 1}-${action.toLowerCase()}-${suffix}`])) as LiveSessionPlan["idempotencyKeys"];
  const tenderId = `RG-DEMO-${suffix}`;
  const plan: LiveSessionPlan = Object.freeze({
    schemaVersion: "routeguard-operations-live-plan-1.0",
    createdAt: new Date().toISOString(),
    sessionId: `demo-${suffix}`,
    runId: `run-${suffix}`,
    tenderId,
    tenderVersion: 1,
    tenderKey: escrowTenderKey(tenderId, 1),
    podId: `POD-${suffix}`,
    shipperActionId: `shipper-${suffix}`,
    bidId: `BID-${suffix}`,
    carrierId: "carrier-operations-demo",
    actionIds,
    idempotencyKeys,
    creationAuthorizationHash: bytes32(`routeguard-operations-create:${suffix}`),
    allocationAuthorizationHash: bytes32(`routeguard-operations-allocate:${suffix}`),
    bidCommitmentSalt: randomBytes(32).toString("hex"),
  });
  atomicJson(file, plan);
  return plan;
}

function requiredAlias(env: Readonly<Record<string, string | undefined>>, names: readonly string[]): string {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`${names.join(" or ")} is MISSING`);
}

export function resolveLiveSecrets(env: Readonly<Record<string, string | undefined>> = process.env): LiveSecrets {
  const operatorPrivateKey = requiredAlias(env, ["ROUTEGUARD_OPERATOR_PRIVATE_KEY", "OPERATOR_PRIVATE_KEY", "SHIPPER_PRIVATE_KEY"]);
  const carrierPrivateKey = requiredAlias(env, ["ROUTEGUARD_CARRIER_PRIVATE_KEY", "CARRIER_PRIVATE_KEY", "FINAL_DEMO_CARRIER_ALPHA_PRIVATE_KEY"]);
  const podMasterKeyBase64 = requiredAlias(env, ["ROUTEGUARD_POD_MASTER_KEY_BASE64"]);
  parseMasterKeyBase64(podMasterKeyBase64);
  const operator = PrivateKey.fromStringECDSA(operatorPrivateKey);
  const carrier = PrivateKey.fromStringECDSA(carrierPrivateKey);
  const facilitatorUrl = requiredAlias(env, ["FACILITATOR_URL"]).replace(/\/+$/, "");
  if (facilitatorUrl !== USDC_SMOKE_APPROVED_FACILITATOR) throw new Error("facilitator URL is not the approved testnet facilitator");
  return {
    operatorPrivateKey,
    carrierPrivateKey,
    operatorPublicKey: operator.publicKey.toStringRaw().toLowerCase(),
    carrierPublicKey: carrier.publicKey.toStringRaw().toLowerCase(),
    podMasterKeyBase64,
    facilitatorUrl,
  };
}

function normalizedKey(value: string | undefined): string { return (value ?? "").replace(/^0x/i, "").toLowerCase(); }
function normalizedAddress(value: string | undefined): string { return value ? (value.startsWith("0x") ? value : `0x${value}`).toLowerCase() : ""; }
function longZero(id: string): string {
  const num = BigInt(id.split(".")[2] ?? "-1");
  if (num < 0n) throw new Error("invalid Hedera id");
  return `0x${num.toString(16).padStart(40, "0")}`;
}

async function mirrorJson<T>(pathName: string, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(`${HEDERA_TESTNET_MIRROR_NODE}${pathName}`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Mirror HTTP ${response.status}`);
  return await response.json() as T;
}

export async function performLiveReadOnlyPreflight(input: {
  readonly plan: LiveSessionPlan;
  readonly secrets: LiveSecrets;
  readonly mirror?: MirrorReader;
  readonly fetchImpl?: typeof fetch;
}): Promise<LivePreflightReport> {
  if (LIVE_PROJECTED_WRITES !== OPERATIONS_LIVE_MAX_WRITES) throw new Error("live projection is not exactly twelve writes");
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const mirror = input.mirror ?? new MirrorReader({ fetchImpl });
  const [operator, carrier, token, contract, topic, proofTopic, shipperTokens, carrierTokens, contractTokens, supported] = await Promise.all([
    mirrorJson<{ account?: string; deleted?: boolean; evm_address?: string; key?: { _type?: string; key?: string }; balance?: { balance?: number } }>(`/api/v1/accounts/${DEMO_OPERATOR_ACCOUNT_ID}`, fetchImpl),
    mirrorJson<{ account?: string; deleted?: boolean; key?: { _type?: string; key?: string } }>(`/api/v1/accounts/${DEMO_CARRIER_TREASURY_ACCOUNT_ID}`, fetchImpl),
    mirrorJson<{ token_id?: string; decimals?: string | number; deleted?: boolean }>(`/api/v1/tokens/${DEMO_TOKEN_ID}`, fetchImpl),
    mirrorJson<{ contract_id?: string; evm_address?: string }>(`/api/v1/contracts/${DEMO_CONTRACT_ID}`, fetchImpl),
    mirrorJson<{ topic_id?: string; sequence_number?: number; submit_key?: { _type?: string; key?: string }; admin_key?: { _type?: string; key?: string }; auto_renew_account?: string }>(`/api/v1/topics/${DEMO_HCS_TOPIC_ID}`, fetchImpl),
    mirrorJson<{ topic_id?: string; sequence_number?: number }>(`/api/v1/topics/${IMMUTABLE_PROOF_TOPIC_ID}`, fetchImpl),
    mirrorJson<{ tokens?: Array<{ token_id?: string; balance?: number }> }>(`/api/v1/accounts/${DEMO_OPERATOR_ACCOUNT_ID}/tokens?limit=100`, fetchImpl),
    mirrorJson<{ tokens?: Array<{ token_id?: string; balance?: number }> }>(`/api/v1/accounts/${DEMO_CARRIER_TREASURY_ACCOUNT_ID}/tokens?limit=100`, fetchImpl),
    mirrorJson<{ tokens?: Array<{ token_id?: string; balance?: number }> }>(`/api/v1/accounts/${DEMO_CONTRACT_ID}/tokens?limit=100`, fetchImpl),
    fetchImpl(`${input.secrets.facilitatorUrl}/supported`, { headers: { accept: "application/json" } }),
  ]);
  if (operator.account !== DEMO_OPERATOR_ACCOUNT_ID || operator.deleted || operator.key?._type !== "ECDSA_SECP256K1" || normalizedKey(operator.key.key) !== input.secrets.operatorPublicKey) throw new Error("operator signer does not match account 0.0.9197513");
  if (carrier.account !== DEMO_CARRIER_TREASURY_ACCOUNT_ID || carrier.deleted || carrier.key?._type !== "ECDSA_SECP256K1" || normalizedKey(carrier.key.key) !== input.secrets.carrierPublicKey) throw new Error("carrier signer does not match account 0.0.9215954");
  if (token.token_id !== DEMO_TOKEN_ID || Number(token.decimals) !== 6 || token.deleted) throw new Error("testnet USDC identity failed");
  if (contract.contract_id !== DEMO_CONTRACT_ID || normalizedAddress(contract.evm_address) !== DEMO_CONTRACT_EVM_ADDRESS) throw new Error("dedicated demo contract identity failed");
  if (topic.topic_id !== DEMO_HCS_TOPIC_ID || (topic.sequence_number ?? 0) !== 0) throw new Error("dedicated demo topic is not at sequence zero");
  if (normalizedKey(topic.submit_key?.key) !== input.secrets.operatorPublicKey || normalizedKey(topic.admin_key?.key) !== input.secrets.operatorPublicKey || topic.auto_renew_account !== DEMO_OPERATOR_ACCOUNT_ID) throw new Error("dedicated demo topic authority failed");
  if (proofTopic.topic_id !== IMMUTABLE_PROOF_TOPIC_ID) throw new Error("immutable proof topic changed");
  const shipperRelation = (shipperTokens.tokens ?? []).find((entry) => entry.token_id === DEMO_TOKEN_ID);
  const carrierRelation = (carrierTokens.tokens ?? []).find((entry) => entry.token_id === DEMO_TOKEN_ID);
  const contractRelation = (contractTokens.tokens ?? []).find((entry) => entry.token_id === DEMO_TOKEN_ID);
  const shipperUsdc = BigInt(shipperRelation?.balance ?? 0);
  if (!shipperRelation || shipperUsdc < MIN_SHIPPER_USDC_ATOMIC) throw new Error("shipper USDC balance or association is insufficient");
  if (!carrierRelation) throw new Error("carrier/access treasury is not associated with USDC");
  if (!contractRelation || BigInt(contractRelation.balance ?? 0) !== 0n) throw new Error("demo contract USDC association or zero balance failed");
  const hbar = BigInt(operator.balance?.balance ?? 0);
  if (hbar < MIN_OPERATOR_HBAR_TINYBARS) throw new Error("operator HBAR balance is insufficient");
  if (!supported.ok) throw new Error(`facilitator /supported HTTP ${supported.status}`);
  const supportedBody = await supported.json() as { kinds?: Array<Record<string, unknown>> };
  const hedera = (supportedBody.kinds ?? []).find((kind) => kind.x402Version === 2 && kind.scheme === "exact" && kind.network === "hedera:testnet");
  const feePayer = (hedera?.extra as { feePayer?: string } | undefined)?.feePayer?.trim() ?? "";
  if (!hedera || !isValidHederaAccountId(feePayer) || feePayer !== FINAL_DEMO_FACILITATOR_FEE_PAYER) throw new Error("facilitator Hedera capability failed");
  const [owner, escrowToken, total, newState, newBalance, proofIdentity, demoMessageOne, proofMessageFive, proofMessageSix] = await Promise.all([
    mirror.contractCall(DEMO_CONTRACT_EVM_ADDRESS, "owner", []),
    mirror.contractCall(DEMO_CONTRACT_EVM_ADDRESS, "escrowToken", []),
    mirror.contractCall(DEMO_CONTRACT_EVM_ADDRESS, "totalEscrowedAmount", []),
    mirror.contractCall(DEMO_CONTRACT_EVM_ADDRESS, "getState", [input.plan.tenderKey]),
    mirror.contractCall(DEMO_CONTRACT_EVM_ADDRESS, "tenderBalance", [input.plan.tenderKey]),
    mirror.contractIdentity(IMMUTABLE_PROOF_CONTRACT_ID),
    mirror.topicMessage(DEMO_HCS_TOPIC_ID, 1),
    mirror.topicMessage(IMMUTABLE_PROOF_TOPIC_ID, 5),
    mirror.topicMessage(IMMUTABLE_PROOF_TOPIC_ID, 6),
  ]);
  const operatorEvmAddress = normalizedAddress(operator.evm_address);
  if (!operatorEvmAddress || String(owner[0]).toLowerCase() !== operatorEvmAddress) throw new Error("demo contract owner failed");
  if (String(escrowToken[0]).toLowerCase() !== longZero(DEMO_TOKEN_ID).toLowerCase()) throw new Error("demo contract token binding failed");
  if (String(total[0]) !== "0" || String(newState[0]) !== "0" || String(newBalance[0]) !== "0") throw new Error("demo contract is not empty for the planned tender");
  if (proofIdentity.contractId !== IMMUTABLE_PROOF_CONTRACT_ID) throw new Error("immutable proof contract changed");
  if (demoMessageOne !== null) throw new Error("dedicated demo topic is not empty");
  if (proofMessageFive === null || proofMessageSix !== null) throw new Error("immutable proof topic sequence changed");
  return {
    status: "PASS", network: "hedera:testnet", contractId: DEMO_CONTRACT_ID,
    contractEvmAddress: DEMO_CONTRACT_EVM_ADDRESS, topicId: DEMO_HCS_TOPIC_ID,
    tokenId: DEMO_TOKEN_ID, operatorAccountId: DEMO_OPERATOR_ACCOUNT_ID,
    carrierTreasuryAccountId: DEMO_CARRIER_TREASURY_ACCOUNT_ID,
    operatorPublicKeyStatus: "PRESENT", carrierPublicKeyStatus: "PRESENT", podMasterKeyStatus: "PRESENT",
    operatorEvmAddress, operatorHbarTinybars: hbar.toString(), shipperUsdcAtomic: shipperUsdc.toString(),
    carrierTreasuryUsdcAtomic: BigInt(carrierRelation.balance ?? 0).toString(), contractUsdcAtomic: "0",
    totalEscrowedAtomic: "0", newTenderState: "UNREGISTERED", newTenderBalanceAtomic: "0",
    topicSequence: 0, facilitatorFeePayer: feePayer, projectedWrites: 12,
    proofTopicSequence: 5,
  };
}
