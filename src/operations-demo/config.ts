import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";

import {
  DEMO_CARRIER_TREASURY_ACCOUNT_ID,
  DEMO_OPERATOR_ACCOUNT_ID,
  DEMO_TOKEN_ID,
  IMMUTABLE_PROOF_CONTRACT_EVM,
  IMMUTABLE_PROOF_CONTRACT_ID,
  IMMUTABLE_PROOF_TOPIC_ID,
  MAX_STATE_CHANGING_WRITES_PER_DAY,
  MAX_STATE_CHANGING_WRITES_PER_SESSION,
  SESSION_ABSOLUTE_TTL_MINUTES,
  SESSION_IDLE_TTL_MINUTES,
} from "./constants";

export type OperationsDemoConfig = {
  readonly liveRequested: boolean;
  readonly liveEnabled: boolean;
  readonly liveReason: "LIVE_ENABLED" | "DEMO_LIVE_DISABLED" | "DISABLED_DEMO_INFRASTRUCTURE_PENDING" | "DEMO_CONFIG_INVALID";
  readonly adminTokenHash: Buffer | null;
  readonly maxActiveLiveSessions: 1;
  readonly idleTtlMinutes: 15;
  readonly absoluteTtlMinutes: 30;
  readonly maxWritesPerSession: 12;
  readonly maxWritesPerDay: 50;
  readonly demoDataDir: string;
  readonly v2DataDir: string;
  readonly contractId: string | null;
  readonly contractEvmAddress: string | null;
  readonly topicId: string | null;
  readonly operatorAccountId: typeof DEMO_OPERATOR_ACCOUNT_ID;
  readonly carrierTreasuryAccountId: typeof DEMO_CARRIER_TREASURY_ACCOUNT_ID;
  readonly tokenId: typeof DEMO_TOKEN_ID;
  readonly operatorPrivateKey: string | null;
  readonly carrierPrivateKey: string | null;
  readonly podMasterKeyBase64: string | null;
  readonly operatorPublicKey: string | null;
  readonly carrierPublicKey: string | null;
  readonly podDataDir: string;
  readonly railwayReplicaCount: 1;
};

function exactInt(env: Readonly<Record<string, string | undefined>>, name: string, expected: number): number {
  const value = Number.parseInt(env[name] ?? String(expected), 10);
  if (value !== expected) throw new Error(`${name} must be ${expected}`);
  return value;
}

export function hashAdminToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function adminTokenMatches(config: OperationsDemoConfig, supplied: string | null): boolean {
  if (!config.adminTokenHash || !supplied) return false;
  const candidate = hashAdminToken(supplied);
  return candidate.length === config.adminTokenHash.length && timingSafeEqual(candidate, config.adminTokenHash);
}

export function resolveOperationsDemoConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd = process.cwd(),
): OperationsDemoConfig {
  const liveRequested = env.ROUTEGUARD_OPERATIONS_LIVE_ENABLED === "true";
  exactInt(env, "ROUTEGUARD_OPERATIONS_MAX_ACTIVE_LIVE_SESSIONS", 1);
  exactInt(env, "ROUTEGUARD_OPERATIONS_SESSION_IDLE_TTL_MINUTES", SESSION_IDLE_TTL_MINUTES);
  exactInt(env, "ROUTEGUARD_OPERATIONS_SESSION_ABSOLUTE_TTL_MINUTES", SESSION_ABSOLUTE_TTL_MINUTES);
  exactInt(env, "ROUTEGUARD_OPERATIONS_MAX_WRITES_PER_SESSION", MAX_STATE_CHANGING_WRITES_PER_SESSION);
  exactInt(env, "ROUTEGUARD_OPERATIONS_MAX_WRITES_PER_DAY", MAX_STATE_CHANGING_WRITES_PER_DAY);
  exactInt(env, "RAILWAY_REPLICA_COUNT", 1);

  const demoDataDir = env.ROUTEGUARD_DEMO_DATA_DIR?.trim() || path.join(cwd, "data", "demo-sessions");
  const v2DataDir = env.ROUTEGUARD_V2_DATA_DIR?.trim() || path.join(cwd, "data", "v2");
  const contractId = env.ROUTEGUARD_DEMO_CONTRACT_ID?.trim() || null;
  const contractEvmAddress = env.ROUTEGUARD_DEMO_CONTRACT_EVM_ADDRESS?.trim() || null;
  const topicId = env.ROUTEGUARD_DEMO_HCS_TOPIC_ID?.trim() || null;
  const rawAdmin = env.ROUTEGUARD_DEMO_ADMIN_TOKEN?.trim() || null;
  const operatorPrivateKey = env.ROUTEGUARD_OPERATOR_PRIVATE_KEY?.trim() || null;
  const carrierPrivateKey = env.ROUTEGUARD_CARRIER_PRIVATE_KEY?.trim() || null;
  const podMasterKeyBase64 = env.ROUTEGUARD_POD_MASTER_KEY_BASE64?.trim() || null;
  const operatorPublicKey = env.ROUTEGUARD_OPERATOR_PUBLIC_KEY?.trim() || null;
  const carrierPublicKey = env.ROUTEGUARD_CARRIER_PUBLIC_KEY?.trim() || null;
  const podDataDir = path.join(path.dirname(v2DataDir), "v2-pods");
  const infrastructureConfigured = Boolean(contractId && contractEvmAddress && topicId);
  const persistentVolumeConfigured =
    demoDataDir.replaceAll("\\", "/").startsWith("/data/") &&
    v2DataDir.replaceAll("\\", "/").startsWith("/data/");
  const secretsConfigured = Boolean(
    rawAdmin && operatorPrivateKey && carrierPrivateKey && operatorPublicKey && carrierPublicKey && podMasterKeyBase64 &&
    Buffer.from(podMasterKeyBase64 ?? "", "base64").length === 32,
  );
  const forbiddenInfrastructure =
    contractId === IMMUTABLE_PROOF_CONTRACT_ID || contractEvmAddress?.toLowerCase() === IMMUTABLE_PROOF_CONTRACT_EVM || topicId === IMMUTABLE_PROOF_TOPIC_ID;
  let liveReason: OperationsDemoConfig["liveReason"] = "DEMO_LIVE_DISABLED";
  if (!infrastructureConfigured) liveReason = "DISABLED_DEMO_INFRASTRUCTURE_PENDING";
  else if (liveRequested && (forbiddenInfrastructure || !persistentVolumeConfigured || !secretsConfigured)) liveReason = "DEMO_CONFIG_INVALID";
  else if (liveRequested) liveReason = "LIVE_ENABLED";

  return Object.freeze({
    liveRequested,
    liveEnabled: liveReason === "LIVE_ENABLED",
    liveReason,
    adminTokenHash: rawAdmin ? hashAdminToken(rawAdmin) : null,
    maxActiveLiveSessions: 1,
    idleTtlMinutes: SESSION_IDLE_TTL_MINUTES,
    absoluteTtlMinutes: SESSION_ABSOLUTE_TTL_MINUTES,
    maxWritesPerSession: MAX_STATE_CHANGING_WRITES_PER_SESSION,
    maxWritesPerDay: MAX_STATE_CHANGING_WRITES_PER_DAY,
    demoDataDir,
    v2DataDir,
    contractId,
    contractEvmAddress,
    topicId,
    operatorAccountId: DEMO_OPERATOR_ACCOUNT_ID,
    carrierTreasuryAccountId: DEMO_CARRIER_TREASURY_ACCOUNT_ID,
    tokenId: DEMO_TOKEN_ID,
    operatorPrivateKey,
    carrierPrivateKey,
    podMasterKeyBase64,
    operatorPublicKey,
    carrierPublicKey,
    podDataDir,
    railwayReplicaCount: 1,
  });
}
