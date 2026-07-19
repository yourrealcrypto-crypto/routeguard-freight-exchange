/**
 * Read-only USDC readiness for final-demo (no association, no transfer).
 */

import {
  FINAL_DEMO_PAYER_ACCOUNT,
  FINAL_DEMO_USDC_AMOUNT_ATOMIC,
  FINAL_DEMO_USDC_TOKEN,
  FINAL_DEMO_WINNER_ACCOUNT,
} from "./constants";
import { FinalDemoError } from "./errors";
import type { UsdcReadinessResult } from "./transports";

const DEFAULT_MIRROR = "https://testnet.mirrornode.hedera.com";

type MirrorAccount = {
  account?: string;
  max_automatic_token_associations?: number;
  receiver_sig_required?: boolean;
  deleted?: boolean;
  balance?: {
    tokens?: Array<{ token_id?: string; balance?: number }>;
  };
};

type MirrorAccountTokens = {
  tokens?: Array<{ token_id?: string; balance?: number }>;
};

type MirrorToken = {
  token_id?: string;
  deleted?: boolean;
  type?: string;
  pause_status?: string;
};

export type CheckUsdcReadinessOptions = {
  mirrorBaseUrl?: string;
  fetchImpl?: typeof fetch;
  tokenId?: string;
  payerAccountId?: string;
  receiverAccountId?: string;
  requiredAmountAtomic?: string;
  /** Inject result (unit tests) — skips network. */
  override?: UsdcReadinessResult;
};

async function mirrorGet<T>(
  base: string,
  apiPath: string,
  fetchImpl: typeof fetch,
): Promise<T> {
  const url = `${base.replace(/\/$/, "")}${apiPath}`;
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new FinalDemoError(
      `USDC readiness Mirror HTTP ${response.status} for ${apiPath}`,
      "USDC_READINESS_MIRROR_ERROR",
    );
  }
  return (await response.json()) as T;
}

function balanceOf(
  account: MirrorAccount,
  tokens: MirrorAccountTokens,
  tokenId: string,
): { associated: boolean; balance: bigint } {
  const fromTokens = tokens.tokens?.find((t) => t.token_id === tokenId);
  if (fromTokens) {
    return {
      associated: true,
      balance: BigInt(fromTokens.balance ?? 0),
    };
  }
  const fromBal = account.balance?.tokens?.find((t) => t.token_id === tokenId);
  if (fromBal) {
    return {
      associated: true,
      balance: BigInt(fromBal.balance ?? 0),
    };
  }
  return { associated: false, balance: 0n };
}

/**
 * Read-only USDC readiness. Never associates or transfers.
 */
export async function checkFinalDemoUsdcReadiness(
  options: CheckUsdcReadinessOptions = {},
): Promise<UsdcReadinessResult> {
  if (options.override) {
    return options.override;
  }

  const tokenId = options.tokenId ?? FINAL_DEMO_USDC_TOKEN;
  const payerAccountId = options.payerAccountId ?? FINAL_DEMO_PAYER_ACCOUNT;
  const receiverAccountId =
    options.receiverAccountId ?? FINAL_DEMO_WINNER_ACCOUNT;
  const required = BigInt(
    options.requiredAmountAtomic ?? FINAL_DEMO_USDC_AMOUNT_ATOMIC,
  );
  const base = options.mirrorBaseUrl ?? DEFAULT_MIRROR;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (tokenId !== FINAL_DEMO_USDC_TOKEN) {
    return {
      ok: false,
      tokenId,
      payerAccountId,
      receiverAccountId,
      payerAssociated: false,
      payerBalanceAtomic: "0",
      receiverUsable: false,
      reasons: [`token must be exactly ${FINAL_DEMO_USDC_TOKEN}`],
    };
  }

  const token = await mirrorGet<MirrorToken>(
    base,
    `/api/v1/tokens/${tokenId}`,
    fetchImpl,
  );
  const reasons: string[] = [];
  if (token.deleted === true) reasons.push("token is deleted");
  if (token.type && token.type !== "FUNGIBLE_COMMON") {
    reasons.push("token is not FUNGIBLE_COMMON");
  }

  const [payerAccount, receiverAccount, payerTokens, receiverTokens] =
    await Promise.all([
      mirrorGet<MirrorAccount>(base, `/api/v1/accounts/${payerAccountId}`, fetchImpl),
      mirrorGet<MirrorAccount>(
        base,
        `/api/v1/accounts/${receiverAccountId}`,
        fetchImpl,
      ),
      mirrorGet<MirrorAccountTokens>(
        base,
        `/api/v1/accounts/${payerAccountId}/tokens?token.id=${tokenId}`,
        fetchImpl,
      ),
      mirrorGet<MirrorAccountTokens>(
        base,
        `/api/v1/accounts/${receiverAccountId}/tokens?token.id=${tokenId}`,
        fetchImpl,
      ),
    ]);

  if (payerAccount.deleted) reasons.push("payer account deleted");
  if (receiverAccount.deleted) reasons.push("receiver account deleted");

  const payerTok = balanceOf(payerAccount, payerTokens, tokenId);
  const receiverTok = balanceOf(receiverAccount, receiverTokens, tokenId);
  const receiverAuto =
    receiverAccount.max_automatic_token_associations ?? 0;
  const receiverHasAuto = receiverAuto === -1 || receiverAuto > 0;
  const receiverUsable =
    receiverTok.associated ||
    (receiverHasAuto && !receiverAccount.receiver_sig_required);

  if (!payerTok.associated) {
    reasons.push("payer is not associated with USDC");
  }
  if (payerTok.balance < required) {
    reasons.push(
      `payer USDC balance ${payerTok.balance.toString()} < required ${required.toString()}`,
    );
  }
  if (!receiverUsable) {
    reasons.push(
      "receiver is not associated and has no usable automatic-association capacity",
    );
  }
  if (receiverAccount.receiver_sig_required) {
    reasons.push("receiver has receiver_sig_required=true");
  }

  return {
    ok: reasons.length === 0,
    tokenId,
    payerAccountId,
    receiverAccountId,
    payerAssociated: payerTok.associated,
    payerBalanceAtomic: payerTok.balance.toString(),
    receiverUsable,
    reasons,
  };
}

export function assertUsdcReadinessPass(result: UsdcReadinessResult): void {
  if (!result.ok) {
    throw new FinalDemoError(
      `USDC readiness failed: ${result.reasons.join("; ")}`,
      "USDC_READINESS_FAILED",
    );
  }
  if (result.tokenId !== FINAL_DEMO_USDC_TOKEN) {
    throw new FinalDemoError("Wrong USDC token", "WRONG_TOKEN");
  }
}

/** Always-pass readiness for offline dry-run / unit tests. */
export function offlineUsdcReadinessPass(): UsdcReadinessResult {
  return {
    ok: true,
    tokenId: FINAL_DEMO_USDC_TOKEN,
    payerAccountId: FINAL_DEMO_PAYER_ACCOUNT,
    receiverAccountId: FINAL_DEMO_WINNER_ACCOUNT,
    payerAssociated: true,
    payerBalanceAtomic: FINAL_DEMO_USDC_AMOUNT_ATOMIC,
    receiverUsable: true,
    reasons: [],
  };
}
