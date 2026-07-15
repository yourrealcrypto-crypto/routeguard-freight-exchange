/**
 * Hedera Testnet USDC readiness preflight.
 *
 * Read-only Mirror Node queries only. Does not associate tokens or transfer.
 * Exit code 0 when a real 0.01 USDC smoke payment is currently possible;
 * non-zero when prerequisites are missing (not treated as an implementation failure).
 *
 * Importing this module is side-effect free: main() runs only under direct execution
 * (npm run check:usdc / tsx scripts/check-usdc-readiness.ts).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_USDC_SMOKE_AMOUNT_DISPLAY,
  HEDERA_TESTNET_MIRROR_NODE,
  USDC_SMOKE_APPROVED_PAYER,
  USDC_SMOKE_APPROVED_RECEIVER,
  VERIFIED_USDC_DECIMALS,
  VERIFIED_USDC_NAME,
  VERIFIED_USDC_SYMBOL,
  VERIFIED_USDC_TOKEN_ID,
  VERIFIED_USDC_TREASURY,
  VERIFIED_USDC_TYPE,
} from "../src/x402/usdc-constants";
import {
  displayAmountToSmallestUnits,
  smallestUnitsToDisplayAmount,
} from "../src/x402/usdc-amount";

const MIRROR = HEDERA_TESTNET_MIRROR_NODE;
const TOKEN_ID =
  process.env.USDC_TOKEN_ID?.trim() || VERIFIED_USDC_TOKEN_ID;
const PAYER =
  process.env.SHIPPER_ACCOUNT_ID?.trim() || USDC_SMOKE_APPROVED_PAYER;
const RECEIVER =
  process.env.CARRIER_ACCOUNT_ID?.trim() || USDC_SMOKE_APPROVED_RECEIVER;
const DISPLAY_AMOUNT =
  process.env.USDC_SMOKE_AMOUNT_DISPLAY?.trim() ||
  DEFAULT_USDC_SMOKE_AMOUNT_DISPLAY;

type MirrorToken = {
  token_id?: string;
  symbol?: string;
  name?: string;
  decimals?: string | number;
  treasury_account_id?: string;
  type?: string;
  pause_status?: string;
  deleted?: boolean;
  total_supply?: string;
  max_supply?: string;
  supply_type?: string;
};

type MirrorAccount = {
  account?: string;
  max_automatic_token_associations?: number;
  receiver_sig_required?: boolean;
  deleted?: boolean;
  balance?: {
    balance?: number;
    tokens?: Array<{ token_id?: string; balance?: number }>;
  };
};

type MirrorAccountTokens = {
  tokens?: Array<{
    token_id?: string;
    balance?: number;
    automatic_association?: boolean;
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function mirrorGet<T>(path: string): Promise<T> {
  const url = `${MIRROR}${path}`;
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Mirror Node ${path} returned HTTP ${response.status}`);
  }

  return (await response.json()) as T;
}

function findTokenBalance(
  account: MirrorAccount,
  accountTokens: MirrorAccountTokens,
  tokenId: string,
): { associated: boolean; balanceSmallest: bigint } {
  const fromTokensEndpoint = accountTokens.tokens?.find(
    (t) => t.token_id === tokenId,
  );

  if (fromTokensEndpoint) {
    return {
      associated: true,
      balanceSmallest: BigInt(fromTokensEndpoint.balance ?? 0),
    };
  }

  const fromBalance = account.balance?.tokens?.find(
    (t) => t.token_id === tokenId,
  );

  if (fromBalance) {
    return {
      associated: true,
      balanceSmallest: BigInt(fromBalance.balance ?? 0),
    };
  }

  return { associated: false, balanceSmallest: 0n };
}

export async function main(): Promise<void> {
  const requiredSmallest = displayAmountToSmallestUnits(
    DISPLAY_AMOUNT,
    VERIFIED_USDC_DECIMALS,
  );
  const requiredSmallestBig = BigInt(requiredSmallest);

  console.log("RouteGuard Freight Exchange USDC readiness check");
  console.log("");
  console.log(`  network             : hedera:testnet`);
  console.log(`  mirror              : ${MIRROR}`);
  console.log(`  token ID            : ${TOKEN_ID}`);
  console.log(`  proposed display    : ${DISPLAY_AMOUNT} USDC`);
  console.log(`  required smallest   : ${requiredSmallest}`);
  console.log(`  payer (shipper)     : ${PAYER}`);
  console.log(`  receiver (carrier)  : ${RECEIVER}`);
  console.log("");

  const token = await mirrorGet<MirrorToken>(`/api/v1/tokens/${TOKEN_ID}`);

  if (!isRecord(token as unknown as Record<string, unknown>)) {
    throw new Error("Invalid token metadata response.");
  }

  const decimals = Number(token.decimals);
  const activeFungible =
    token.deleted === false &&
    token.type === VERIFIED_USDC_TYPE &&
    (token.pause_status === "NOT_APPLICABLE" ||
      token.pause_status === "UNPAUSED") &&
    Number.isInteger(decimals) &&
    decimals >= 0;

  console.log("Token metadata (Mirror Node)");
  console.log(`  token_id            : ${token.token_id ?? TOKEN_ID}`);
  console.log(`  symbol              : ${token.symbol ?? "(missing)"}`);
  console.log(`  name                : ${token.name ?? "(missing)"}`);
  console.log(`  decimals            : ${token.decimals ?? "(missing)"}`);
  console.log(
    `  treasury            : ${token.treasury_account_id ?? "(missing)"}`,
  );
  console.log(`  type                : ${token.type ?? "(missing)"}`);
  console.log(
    `  pause_status        : ${token.pause_status ?? "(missing)"}`,
  );
  console.log(`  deleted             : ${String(token.deleted)}`);
  console.log(
    `  total_supply        : ${token.total_supply ?? "(missing)"}`,
  );
  console.log(
    `  supply_type         : ${token.supply_type ?? "(missing)"}`,
  );
  console.log(
    `  active fungible HTS : ${activeFungible ? "yes" : "no"}`,
  );
  console.log("");

  if (TOKEN_ID === VERIFIED_USDC_TOKEN_ID) {
    const mismatches: string[] = [];
    if (token.symbol !== VERIFIED_USDC_SYMBOL) {
      mismatches.push(`symbol (got ${token.symbol})`);
    }
    if (token.name !== VERIFIED_USDC_NAME) {
      mismatches.push(`name (got ${token.name})`);
    }
    if (decimals !== VERIFIED_USDC_DECIMALS) {
      mismatches.push(`decimals (got ${token.decimals})`);
    }
    if (token.treasury_account_id !== VERIFIED_USDC_TREASURY) {
      mismatches.push(`treasury (got ${token.treasury_account_id})`);
    }
    if (mismatches.length > 0) {
      console.log(
        `WARNING: Mirror metadata diverges from verified constants: ${mismatches.join(", ")}`,
      );
      console.log("");
    }
  }

  if (!activeFungible) {
    console.error("USDC_READINESS_FAILED: token is not an active fungible HTS token.");
    process.exitCode = 1;
    return;
  }

  if (decimals !== VERIFIED_USDC_DECIMALS) {
    console.error(
      `USDC_READINESS_FAILED: token decimals ${decimals} do not match verified ${VERIFIED_USDC_DECIMALS}.`,
    );
    process.exitCode = 1;
    return;
  }

  const [payerAccount, receiverAccount, payerTokens, receiverTokens] =
    await Promise.all([
      mirrorGet<MirrorAccount>(`/api/v1/accounts/${PAYER}`),
      mirrorGet<MirrorAccount>(`/api/v1/accounts/${RECEIVER}`),
      mirrorGet<MirrorAccountTokens>(
        `/api/v1/accounts/${PAYER}/tokens?token.id=${TOKEN_ID}`,
      ),
      mirrorGet<MirrorAccountTokens>(
        `/api/v1/accounts/${RECEIVER}/tokens?token.id=${TOKEN_ID}`,
      ),
    ]);

  const payerToken = findTokenBalance(payerAccount, payerTokens, TOKEN_ID);
  const receiverToken = findTokenBalance(
    receiverAccount,
    receiverTokens,
    TOKEN_ID,
  );

  const payerAutoSlots = payerAccount.max_automatic_token_associations ?? 0;
  const receiverAutoSlots =
    receiverAccount.max_automatic_token_associations ?? 0;

  // Hedera: -1 means unlimited automatic associations.
  const payerHasAutoCapacity = payerAutoSlots === -1 || payerAutoSlots > 0;
  const receiverHasAutoCapacity =
    receiverAutoSlots === -1 || receiverAutoSlots > 0;

  const payerBalanceDisplay = smallestUnitsToDisplayAmount(
    payerToken.balanceSmallest,
    decimals,
  );
  const receiverBalanceDisplay = smallestUnitsToDisplayAmount(
    receiverToken.balanceSmallest,
    decimals,
  );

  const sufficientBalance =
    payerToken.balanceSmallest >= requiredSmallestBig;

  // Receiver can accept via explicit association OR automatic association capacity.
  const receiverCanAccept =
    receiverToken.associated || receiverHasAutoCapacity;

  // Payer must hold the token (requires association) with sufficient balance.
  const payerCanSend = payerToken.associated && sufficientBalance;

  const receiverSigRequired = Boolean(receiverAccount.receiver_sig_required);
  const payerSigRequired = Boolean(payerAccount.receiver_sig_required);

  console.log("Payer (shipper)");
  console.log(`  account             : ${payerAccount.account ?? PAYER}`);
  console.log(`  deleted             : ${String(payerAccount.deleted)}`);
  console.log(`  associated          : ${payerToken.associated}`);
  console.log(
    `  token balance       : ${payerToken.balanceSmallest.toString()} smallest (${payerBalanceDisplay} USDC)`,
  );
  console.log(
    `  max auto associations: ${payerAutoSlots} (${payerHasAutoCapacity ? "available" : "none"})`,
  );
  console.log(
    `  receiver_sig_required: ${payerSigRequired}`,
  );
  console.log(
    `  enough for smoke    : ${sufficientBalance}`,
  );
  console.log("");

  console.log("Receiver (carrier)");
  console.log(
    `  account             : ${receiverAccount.account ?? RECEIVER}`,
  );
  console.log(`  deleted             : ${String(receiverAccount.deleted)}`);
  console.log(`  associated          : ${receiverToken.associated}`);
  console.log(
    `  token balance       : ${receiverToken.balanceSmallest.toString()} smallest (${receiverBalanceDisplay} USDC)`,
  );
  console.log(
    `  max auto associations: ${receiverAutoSlots} (${receiverHasAutoCapacity ? "available" : "none"})`,
  );
  console.log(
    `  receiver_sig_required: ${receiverSigRequired}`,
  );
  console.log(
    `  can accept transfer : ${receiverCanAccept}`,
  );
  console.log("");

  if (receiverSigRequired) {
    console.log(
      "NOTE: receiver_sig_required=true may block unsolicited token transfers",
    );
    console.log("      depending on transfer construction.");
    console.log("");
  }

  const missing: string[] = [];

  if (payerAccount.deleted) {
    missing.push("payer account is deleted");
  }
  if (receiverAccount.deleted) {
    missing.push("receiver account is deleted");
  }
  if (!payerToken.associated) {
    missing.push(
      "payer is not associated with USDC (do not auto-associate here; associate out-of-band or via faucet receive)",
    );
  }
  if (!sufficientBalance) {
    missing.push(
      `payer USDC balance ${payerBalanceDisplay} is below required ${DISPLAY_AMOUNT} (obtain Testnet USDC from Circle faucet; not an implementation failure)`,
    );
  }
  if (!receiverCanAccept) {
    missing.push(
      "receiver is not associated with USDC and has no automatic token association capacity",
    );
  }
  if (receiverSigRequired) {
    missing.push(
      "receiver has receiver_sig_required=true which may block the token transfer",
    );
  }
  if (!payerCanSend) {
    // already covered by association/balance; keep aggregate signal
  }

  const settlementPossible =
    activeFungible &&
    payerCanSend &&
    receiverCanAccept &&
    !receiverSigRequired &&
    !payerAccount.deleted &&
    !receiverAccount.deleted;

  console.log("Settlement readiness");
  console.log(
    `  real USDC settlement currently possible: ${settlementPossible ? "YES" : "NO"}`,
  );

  if (missing.length > 0) {
    console.log("  missing prerequisites:");
    for (const item of missing) {
      console.log(`    - ${item}`);
    }
    console.log("");
    console.log("USDC_READINESS_NOT_READY");
    console.log(
      "Lack of testnet USDC balance/association is an account-funding prerequisite, not an implementation failure.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("");
  console.log("USDC_READINESS_PASSED");
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) {
    return false;
  }

  const modulePath = path.resolve(fileURLToPath(import.meta.url));
  const entryPath = path.resolve(process.argv[1]);

  return process.platform === "win32"
    ? modulePath.toLowerCase() === entryPath.toLowerCase()
    : modulePath === entryPath;
}

if (isDirectExecution()) {
  void main().catch((error: unknown) => {
    console.error(
      `USDC_READINESS_FAILED: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  });
}
