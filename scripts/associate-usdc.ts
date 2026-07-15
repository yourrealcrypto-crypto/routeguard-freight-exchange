/**
 * One-shot Hedera Testnet USDC token association for the approved payer.
 *
 * - Network: hedera:testnet only
 * - Account: 0.0.9197513
 * - Token: 0.0.429274 (USDC)
 * - At most one TokenAssociateTransaction per process
 * - No USDC transfer, no x402 payment
 *
 * Importing this module is side-effect free; main() runs only under direct execution.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  Status,
  TokenAssociateTransaction,
  TokenId,
} from "@hiero-ledger/sdk";

import {
  HEDERA_TESTNET_MIRROR_NODE,
  USDC_SMOKE_APPROVED_PAYER,
  VERIFIED_USDC_DECIMALS,
  VERIFIED_USDC_NAME,
  VERIFIED_USDC_SYMBOL,
  VERIFIED_USDC_TOKEN_ID,
  VERIFIED_USDC_TYPE,
} from "../src/x402/usdc-constants";

const APPROVED_PAYER = USDC_SMOKE_APPROVED_PAYER;
const APPROVED_TOKEN = VERIFIED_USDC_TOKEN_ID;
const APPROVED_PAYER_PUBKEY =
  "02c07aaa7bc004c9c44186395f496639cf46741b6bc8092c024156e5ac68d5fde5";
const MIRROR = HEDERA_TESTNET_MIRROR_NODE;
const MAX_TX_FEE_HBAR = 2;

// Process-level one-association guard
let associationAttemptClaimed = false;

function claimAssociationAttempt(): void {
  if (associationAttemptClaimed) {
    throw new Error(
      "Association guard already claimed. Only one association attempt is allowed per process.",
    );
  }
  associationAttemptClaimed = true;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function mirrorGet<T>(apiPath: string): Promise<T> {
  const url = `${MIRROR}${apiPath}`;
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Mirror Node ${apiPath} returned HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

type MirrorToken = {
  token_id?: string;
  symbol?: string;
  name?: string;
  decimals?: string | number;
  type?: string;
  pause_status?: string;
  deleted?: boolean;
};

type MirrorAccountTokens = {
  tokens?: Array<{ token_id?: string; balance?: number }>;
};

type MirrorTransaction = {
  transactions?: Array<{
    transaction_id?: string;
    result?: string;
    name?: string;
    valid_start_timestamp?: string;
    transaction_hash?: string;
  }>;
};

function isPayerAssociated(
  tokens: MirrorAccountTokens,
  tokenId: string,
): boolean {
  return Boolean(tokens.tokens?.some((t) => t.token_id === tokenId));
}

function payerTokenBalance(
  tokens: MirrorAccountTokens,
  tokenId: string,
): bigint {
  const entry = tokens.tokens?.find((t) => t.token_id === tokenId);
  return BigInt(entry?.balance ?? 0);
}

/**
 * Convert SDK transaction ID string form to Mirror Node / HashScan forms.
 * SDK often yields: 0.0.9197513@seconds.nanos
 * Mirror path uses: 0.0.9197513-seconds-nanos
 */
function toMirrorTransactionId(sdkTransactionId: string): string {
  // e.g. 0.0.9197513@1784123744.752811412 → 0.0.9197513-1784123744-752811412
  const match = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(sdkTransactionId.trim());
  if (!match) {
    // Already dash form or unexpected — pass through
    return sdkTransactionId.replace("@", "-").replace(/\.(?=\d+$)/, "-");
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function hashScanLink(sdkTransactionId: string): string {
  // HashScan accepts the @ form in the URL path
  return `https://hashscan.io/testnet/transaction/${sdkTransactionId}`;
}

async function waitForMirrorTransaction(
  sdkTransactionId: string,
  attempts = 12,
  delayMs = 1500,
): Promise<MirrorTransaction["transactions"] extends (infer U)[] | undefined ? U : never> {
  const mirrorId = toMirrorTransactionId(sdkTransactionId);

  for (let i = 0; i < attempts; i++) {
    try {
      const payload = await mirrorGet<MirrorTransaction>(
        `/api/v1/transactions/${encodeURIComponent(mirrorId)}`,
      );
      const tx = payload.transactions?.[0];
      if (tx && tx.result) {
        return tx as never;
      }
    } catch {
      // Mirror lag is common immediately after consensus
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(
    `Mirror Node did not confirm transaction ${mirrorId} within timeout.`,
  );
}

async function confirmAssociationOnMirror(
  accountId: string,
  tokenId: string,
  attempts = 10,
  delayMs = 1000,
): Promise<{ associated: boolean; balance: bigint }> {
  for (let i = 0; i < attempts; i++) {
    const tokens = await mirrorGet<MirrorAccountTokens>(
      `/api/v1/accounts/${accountId}/tokens?token.id=${tokenId}`,
    );
    if (isPayerAssociated(tokens, tokenId)) {
      return {
        associated: true,
        balance: payerTokenBalance(tokens, tokenId),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return { associated: false, balance: 0n };
}

export async function main(): Promise<void> {
  await import("dotenv/config");

  const network = process.env.HEDERA_NETWORK?.trim() || "hedera:testnet";
  if (network !== "hedera:testnet") {
    throw new Error(
      `Unsupported network "${network}". Association is testnet-only.`,
    );
  }

  const shipperAccountIdText = requireEnv("SHIPPER_ACCOUNT_ID");
  const shipperPrivateKeyText = requireEnv("SHIPPER_PRIVATE_KEY");

  if (shipperAccountIdText !== APPROVED_PAYER) {
    throw new Error(
      `SHIPPER_ACCOUNT_ID must be the approved payer ${APPROVED_PAYER}.`,
    );
  }

  console.log("RouteGuard USDC token association");
  console.log("");
  console.log(`  network     : hedera:testnet`);
  console.log(`  account     : ${APPROVED_PAYER}`);
  console.log(`  token       : ${APPROVED_TOKEN}`);
  console.log(`  symbol      : ${VERIFIED_USDC_SYMBOL}`);
  console.log("");

  // --- Pre-flight: token metadata ---
  const token = await mirrorGet<MirrorToken>(
    `/api/v1/tokens/${APPROVED_TOKEN}`,
  );

  if (!isRecord(token as unknown as Record<string, unknown>)) {
    throw new Error("Invalid token metadata from Mirror Node.");
  }

  const decimals = Number(token.decimals);
  const activeUsdc =
    token.deleted === false &&
    token.symbol === VERIFIED_USDC_SYMBOL &&
    token.name === VERIFIED_USDC_NAME &&
    token.type === VERIFIED_USDC_TYPE &&
    decimals === VERIFIED_USDC_DECIMALS &&
    (token.pause_status === "NOT_APPLICABLE" ||
      token.pause_status === "UNPAUSED");

  console.log("Pre-association Mirror Node checks");
  console.log(`  token_id    : ${token.token_id ?? APPROVED_TOKEN}`);
  console.log(`  symbol      : ${token.symbol ?? "(missing)"}`);
  console.log(`  name        : ${token.name ?? "(missing)"}`);
  console.log(`  decimals    : ${token.decimals ?? "(missing)"}`);
  console.log(`  type        : ${token.type ?? "(missing)"}`);
  console.log(`  deleted     : ${String(token.deleted)}`);
  console.log(`  pause       : ${token.pause_status ?? "(missing)"}`);
  console.log(`  active USDC : ${activeUsdc ? "yes" : "no"}`);

  if (!activeUsdc) {
    throw new Error(
      "Token 0.0.429274 failed active USDC validation on Mirror Node.",
    );
  }

  // --- Pre-flight: association status ---
  const preTokens = await mirrorGet<MirrorAccountTokens>(
    `/api/v1/accounts/${APPROVED_PAYER}/tokens?token.id=${APPROVED_TOKEN}`,
  );
  const alreadyAssociated = isPayerAssociated(preTokens, APPROVED_TOKEN);
  const preBalance = payerTokenBalance(preTokens, APPROVED_TOKEN);

  console.log(`  payer assoc : ${alreadyAssociated}`);
  console.log(`  payer bal   : ${preBalance.toString()} smallest units`);
  console.log("");

  if (alreadyAssociated) {
    console.log("ALREADY_ASSOCIATED");
    console.log("No transaction submitted.");
    return;
  }

  console.log("PRE_ASSOCIATION_STATUS: not associated");

  // --- ECDSA key parse + exact public key match (before any signing) ---
  let privateKey: PrivateKey;
  try {
    privateKey = PrivateKey.fromStringECDSA(shipperPrivateKeyText);
  } catch {
    throw new Error("Invalid SHIPPER_PRIVATE_KEY (ECDSA parse failed).");
  }

  const derivedHex = privateKey.publicKey.toStringRaw().toLowerCase();
  if (derivedHex !== APPROVED_PAYER_PUBKEY) {
    throw new Error(
      "Derived public key does not match the approved ECDSA payer key.",
    );
  }
  console.log("PUBLIC_KEY_MATCH: PASS");
  console.log(`  key type    : ECDSA_SECP256K1 (fromStringECDSA)`);
  console.log("");

  const accountId = AccountId.fromString(APPROVED_PAYER);
  const tokenId = TokenId.fromString(APPROVED_TOKEN);

  const client = Client.forTestnet();
  client.setOperator(accountId, privateKey);

  try {
    // Claim one-attempt guard immediately before construction/submit
    claimAssociationAttempt();

    const transaction = await new TokenAssociateTransaction()
      .setAccountId(accountId)
      .setTokenIds([tokenId])
      .setMaxTransactionFee(new Hbar(MAX_TX_FEE_HBAR))
      .freezeWith(client);

    const signed = await transaction.sign(privateKey);

    console.log("Submitting TokenAssociateTransaction (single attempt)...");
    const response = await signed.execute(client);
    const receipt = await response.getReceipt(client);
    const transactionId = response.transactionId.toString();

    if (receipt.status !== Status.Success) {
      throw new Error(
        `Association receipt status was ${receipt.status.toString()}, expected SUCCESS.`,
      );
    }

    console.log("");
    console.log("Receipt");
    console.log(`  status      : SUCCESS`);
    console.log(`  tx id       : ${transactionId}`);
    console.log(`  hashscan    : ${hashScanLink(transactionId)}`);
    console.log("");

    // --- Mirror confirmation of the transaction ---
    const mirrorTx = await waitForMirrorTransaction(transactionId);
    console.log("Mirror Node transaction");
    console.log(`  transaction_id : ${mirrorTx.transaction_id ?? toMirrorTransactionId(transactionId)}`);
    console.log(`  result         : ${mirrorTx.result ?? "(missing)"}`);
    console.log(`  name           : ${mirrorTx.name ?? "(missing)"}`);

    if (mirrorTx.result !== "SUCCESS") {
      throw new Error(
        `Mirror Node result was ${mirrorTx.result}, expected SUCCESS.`,
      );
    }

    // --- Mirror confirmation of association ---
    const post = await confirmAssociationOnMirror(
      APPROVED_PAYER,
      APPROVED_TOKEN,
    );

    console.log("");
    console.log("Post-association status");
    console.log(`  payer associated : ${post.associated}`);
    console.log(
      `  payer USDC bal   : ${post.balance.toString()} smallest units`,
    );

    if (!post.associated) {
      throw new Error(
        "Transaction SUCCESS but Mirror Node does not yet show token association.",
      );
    }

    console.log("");
    console.log("USDC_ASSOCIATION_PASSED");
    console.log(`HASHSCAN: ${hashScanLink(transactionId)}`);
  } finally {
    client.close();
  }
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
      `USDC_ASSOCIATION_FAILED: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  });
}
