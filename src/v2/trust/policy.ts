/**
 * Immutable external trust policy for v2 authorization.
 * Trusted values come only from application configuration / injection —
 * never from lifecycle events.
 */

import { createHash } from "node:crypto";

import { isValidHederaAccountId } from "../../domain/payment-option";

export const TRUST_POLICY_SCHEMA = "routeguard-v2-trust-1.0" as const;
export const SIGNATURE_ALGORITHM_HIERO_ECDSA =
  "ECDSA_SECP256K1_HIERO" as const;

export type TrustedRefereeEntry = {
  readonly refereeId: string;
  readonly publicKey: string;
};

/**
 * Injected trust policy. Freeze at construction; events cannot override.
 */
export type TrustPolicy = {
  readonly schemaVersion: typeof TRUST_POLICY_SCHEMA;
  /** Shipper public key (ECDSA hex) authorized for POD review actions. */
  readonly shipperPublicKey: string;
  /** Human referee registry: id → public key. */
  readonly referees: readonly TrustedRefereeEntry[];
  /** Platform access-fee treasury (x402 payTo). Not freight escrow. */
  readonly accessTreasuryAccountId: string;
  readonly signatureAlgorithm: typeof SIGNATURE_ALGORITHM_HIERO_ECDSA;
};

export type TrustPolicySnapshot = {
  readonly schemaVersion: typeof TRUST_POLICY_SCHEMA;
  readonly shipperPublicKey: string;
  readonly shipperKeyFingerprint: string;
  readonly referees: readonly TrustedRefereeEntry[];
  readonly accessTreasuryAccountId: string;
  readonly signatureAlgorithm: typeof SIGNATURE_ALGORITHM_HIERO_ECDSA;
};

/** SHA-256 fingerprint of a public key (hex), for audit metadata only. */
export function publicKeyFingerprint(publicKeyHex: string): string {
  const normalized = publicKeyHex.trim().toLowerCase();
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

const RESERVED_AUTOMATION_REFEREE_IDS = new Set([
  "ai",
  "model",
  "llm",
  "bot",
  "ai-referee",
  "model-referee",
  "llm-referee",
  "bot-referee",
  "automated-referee",
  "automation-agent",
  "routeguard-ai",
]);

function normalizedRefereeIdentity(refereeId: string): string {
  return refereeId
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-");
}

export function assertHumanRefereeIdentity(refereeId: string): void {
  const normalized = normalizedRefereeIdentity(refereeId);
  const explicitAutomationPattern =
    /^(ai|model|llm|bot|gpt|assistant)-(referee|agent|model)(?:-[0-9]+)?$/;
  if (
    RESERVED_AUTOMATION_REFEREE_IDS.has(normalized) ||
    explicitAutomationPattern.test(normalized)
  ) {
    throw new Error("AI/model/automation identities cannot be referees");
  }
}

export function createTrustPolicy(input: {
  shipperPublicKey: string;
  referees: readonly TrustedRefereeEntry[];
  accessTreasuryAccountId: string;
}): TrustPolicy {
  const shipperPublicKey = input.shipperPublicKey.trim();
  if (!shipperPublicKey || shipperPublicKey.length < 32) {
    throw new Error("shipperPublicKey is required and must be a valid key encoding");
  }
  if (!isValidHederaAccountId(input.accessTreasuryAccountId)) {
    throw new Error("accessTreasuryAccountId must be a valid Hedera account id");
  }
  if (!input.referees || input.referees.length < 1) {
    throw new Error("at least one trusted referee is required");
  }
  const seenIds = new Set<string>();
  const referees: TrustedRefereeEntry[] = input.referees.map((r) => {
    const refereeId = r.refereeId.trim();
    const publicKey = r.publicKey.trim();
    if (!refereeId || !publicKey || publicKey.length < 32) {
      throw new Error("each referee requires refereeId and publicKey");
    }
    assertHumanRefereeIdentity(refereeId);
    if (seenIds.has(refereeId)) {
      throw new Error(`duplicate refereeId: ${refereeId}`);
    }
    seenIds.add(refereeId);
    return Object.freeze({ refereeId, publicKey });
  });

  return Object.freeze({
    schemaVersion: TRUST_POLICY_SCHEMA,
    shipperPublicKey,
    referees: Object.freeze(referees),
    accessTreasuryAccountId: input.accessTreasuryAccountId.trim(),
    signatureAlgorithm: SIGNATURE_ALGORITHM_HIERO_ECDSA,
  });
}

export function snapshotTrustPolicy(policy: TrustPolicy): TrustPolicySnapshot {
  return Object.freeze({
    schemaVersion: policy.schemaVersion,
    shipperPublicKey: policy.shipperPublicKey,
    shipperKeyFingerprint: publicKeyFingerprint(policy.shipperPublicKey),
    referees: policy.referees,
    accessTreasuryAccountId: policy.accessTreasuryAccountId,
    signatureAlgorithm: policy.signatureAlgorithm,
  });
}

export function resolveTrustedReferee(
  policy: TrustPolicy,
  refereeId: string,
): TrustedRefereeEntry {
  const id = refereeId.trim();
  if (!id) {
    throw new Error("refereeId is required");
  }
  assertHumanRefereeIdentity(id);
  const found = policy.referees.find((r) => r.refereeId === id);
  if (!found) {
    throw new Error(`refereeId not in trusted registry: ${id}`);
  }
  return found;
}
