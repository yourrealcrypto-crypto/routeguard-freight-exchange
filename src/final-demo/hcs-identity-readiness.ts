/**
 * Read-only HCS identity and HBAR-funding preflight for the final demo.
 * This module never signs, creates a topic, or submits a message.
 */

import {
  FINAL_DEMO_CARRIER_BETA_ACCOUNT,
  FINAL_DEMO_PAYER_ACCOUNT,
  FINAL_DEMO_WINNER_ACCOUNT,
} from "./constants";
import type { AccountCheckResult } from "./transports";
import type { FinalDemoHcsSubmitter } from "./hcs-submit-authority";

const DEFAULT_MIRROR = "https://testnet.mirrornode.hedera.com";

/** Conservative read-only readiness floor: one HBAR per submitting identity. */
export const FINAL_DEMO_MIN_HCS_BALANCE_TINYBARS = 100_000_000n;

export type FinalDemoHcsIdentity = {
  readonly role: FinalDemoHcsSubmitter;
  readonly accountId: string;
  readonly publicKeyHex: string;
};

type MirrorAccount = {
  account?: string;
  deleted?: boolean;
  key?: { _type?: string; key?: string };
  balance?: { balance?: number | string };
};

export type FinalDemoHcsIdentityReadinessResult = AccountCheckResult & {
  readonly minimumBalanceTinybars: string;
  readonly checkedAccounts: readonly string[];
};

export type CheckFinalDemoHcsIdentityReadinessOptions = {
  readonly identities: readonly FinalDemoHcsIdentity[];
  readonly mirrorBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly minimumBalanceTinybars?: bigint;
};

function normalizePublicKey(value: string): string {
  return value.trim().replace(/^0x/i, "").toLowerCase();
}

function parseTinybars(value: number | string | undefined): bigint | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return BigInt(value);
  }
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) {
    return BigInt(value);
  }
  return null;
}

function expectedAccountForRole(role: FinalDemoHcsSubmitter): string {
  if (role === "ROUTEGUARD_OPERATOR") return FINAL_DEMO_PAYER_ACCOUNT;
  if (role === "CARRIER_ALPHA") return FINAL_DEMO_WINNER_ACCOUNT;
  return FINAL_DEMO_CARRIER_BETA_ACCOUNT;
}

async function fetchMirrorAccount(
  baseUrl: string,
  accountId: string,
  fetchImpl: typeof fetch,
): Promise<MirrorAccount> {
  const response = await fetchImpl(
    `${baseUrl.replace(/\/$/, "")}/api/v1/accounts/${encodeURIComponent(accountId)}`,
    { headers: { accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error(`Mirror HTTP ${response.status} for account ${accountId}`);
  }
  return (await response.json()) as MirrorAccount;
}

/**
 * Verify the exact three role/account/key bindings, independent identities and
 * sufficient HBAR before topic creation can be attempted.
 */
export async function checkFinalDemoHcsIdentityReadiness(
  options: CheckFinalDemoHcsIdentityReadinessOptions,
): Promise<FinalDemoHcsIdentityReadinessResult> {
  const minimum =
    options.minimumBalanceTinybars ?? FINAL_DEMO_MIN_HCS_BALANCE_TINYBARS;
  const reasons: string[] = [];
  const byRole = new Map(options.identities.map((identity) => [identity.role, identity]));

  if (options.identities.length !== 3 || byRole.size !== 3) {
    reasons.push("exactly one operator, carrier-alpha and carrier-beta identity is required");
  }

  const roles: FinalDemoHcsSubmitter[] = [
    "ROUTEGUARD_OPERATOR",
    "CARRIER_ALPHA",
    "CARRIER_BETA",
  ];
  for (const role of roles) {
    const identity = byRole.get(role);
    if (!identity) {
      reasons.push(`missing ${role} identity`);
      continue;
    }
    const expectedAccount = expectedAccountForRole(role);
    if (identity.accountId !== expectedAccount) {
      reasons.push(`${role} account must be exactly ${expectedAccount}`);
    }
    if (!/^[0-9a-fA-F]{66}$/.test(identity.publicKeyHex)) {
      reasons.push(`${role} public key must be compressed ECDSA secp256k1 hex`);
    }
  }

  const accountIds = options.identities.map((identity) => identity.accountId);
  if (new Set(accountIds).size !== accountIds.length) {
    reasons.push("operator and carrier account identities must be distinct");
  }
  const publicKeys = options.identities.map((identity) =>
    normalizePublicKey(identity.publicKeyHex),
  );
  if (new Set(publicKeys).size !== publicKeys.length) {
    reasons.push("operator and carrier public-key identities must be distinct");
  }

  if (reasons.length > 0) {
    return {
      ok: false,
      reasons,
      minimumBalanceTinybars: minimum.toString(),
      checkedAccounts: accountIds,
    };
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const mirrorBaseUrl = options.mirrorBaseUrl ?? DEFAULT_MIRROR;
  const accounts = await Promise.all(
    options.identities.map(async (identity) => ({
      identity,
      account: await fetchMirrorAccount(
        mirrorBaseUrl,
        identity.accountId,
        fetchImpl,
      ),
    })),
  );

  for (const { identity, account } of accounts) {
    if (account.account !== identity.accountId) {
      reasons.push(`${identity.role} Mirror account binding mismatch`);
    }
    if (account.deleted === true) {
      reasons.push(`${identity.role} account is deleted`);
    }
    const mirrorKey = account.key?.key;
    if (
      account.key?._type !== "ECDSA_SECP256K1" ||
      typeof mirrorKey !== "string" ||
      normalizePublicKey(mirrorKey) !== normalizePublicKey(identity.publicKeyHex)
    ) {
      reasons.push(`${identity.role} account/public-key binding mismatch`);
    }
    const balance = parseTinybars(account.balance?.balance);
    if (balance == null) {
      reasons.push(`${identity.role} HBAR balance is missing or invalid`);
    } else if (balance < minimum) {
      reasons.push(
        `${identity.role} HBAR balance ${balance.toString()} is below required ${minimum.toString()} tinybars`,
      );
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    minimumBalanceTinybars: minimum.toString(),
    checkedAccounts: accountIds,
  };
}
