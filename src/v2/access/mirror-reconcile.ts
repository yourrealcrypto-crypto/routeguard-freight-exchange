/**
 * Read-only Mirror Node settlement reconciliation for v2 access claims.
 * Never submits transactions. Used only after a settlement attempt.
 */

import { HEDERA_TESTNET_MIRROR_NODE } from "../../x402/usdc-constants";
import { mirrorTimestampToUtcIso } from "../../hcs/mirror-node-client";
import { isValidHederaAccountId } from "../../domain/payment-option";
import type {
  PaymentClaim,
  PaymentReconciliationResult,
  PaymentSettlementReconciler,
} from "./payment-claim";
import type { SettledAccessPayment } from "./x402-gate";

export function toMirrorTransactionId(sdkId: string): string {
  if (sdkId.includes("-") && !sdkId.includes("@")) return sdkId;
  const m = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(sdkId.trim());
  if (!m) return sdkId;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function hashScanTransactionUrl(txId: string): string {
  return `https://hashscan.io/testnet/transaction/${txId}`;
}

type MirrorTx = {
  transaction_id?: string;
  result?: string;
  consensus_timestamp?: string;
  token_transfers?: Array<{
    token_id?: string;
    account?: string;
    amount?: number;
  }>;
};

export type MirrorUsdcVerification = {
  readonly status: "SUCCESS" | "FAILED" | "NOT_FOUND" | "PENDING";
  readonly transactionId: string;
  readonly mirrorTransactionId: string;
  readonly consensusTimestamp: string | null;
  readonly result: string | null;
  readonly payerTransfer: number | null;
  readonly treasuryTransfer: number | null;
  readonly tokenId: string | null;
  readonly amountAtomicMatch: boolean;
  readonly payerMatch: boolean;
  readonly treasuryMatch: boolean;
  readonly hashScanUrl: string;
};

export async function verifyUsdcAccessPaymentOnMirror(input: {
  transactionId: string;
  payerAccount: string;
  treasuryAccount: string;
  asset: string;
  amountAtomic: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<MirrorUsdcVerification> {
  const base = (input.baseUrl ?? HEDERA_TESTNET_MIRROR_NODE).replace(/\/$/, "");
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const mirrorId = toMirrorTransactionId(input.transactionId);
  const url = `${base}/api/v1/transactions/${encodeURIComponent(mirrorId)}`;
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
  });
  if (response.status === 404) {
    return {
      status: "NOT_FOUND",
      transactionId: input.transactionId,
      mirrorTransactionId: mirrorId,
      consensusTimestamp: null,
      result: null,
      payerTransfer: null,
      treasuryTransfer: null,
      tokenId: null,
      amountAtomicMatch: false,
      payerMatch: false,
      treasuryMatch: false,
      hashScanUrl: hashScanTransactionUrl(input.transactionId),
    };
  }
  if (!response.ok) {
    throw new Error(`Mirror HTTP ${response.status} for ${mirrorId}`);
  }
  const payload = (await response.json()) as { transactions?: MirrorTx[] };
  const tx = payload.transactions?.[0];
  if (!tx) {
    return {
      status: "NOT_FOUND",
      transactionId: input.transactionId,
      mirrorTransactionId: mirrorId,
      consensusTimestamp: null,
      result: null,
      payerTransfer: null,
      treasuryTransfer: null,
      tokenId: null,
      amountAtomicMatch: false,
      payerMatch: false,
      treasuryMatch: false,
      hashScanUrl: hashScanTransactionUrl(input.transactionId),
    };
  }
  const result = typeof tx.result === "string" ? tx.result : null;
  const status =
    result === "SUCCESS" ? "SUCCESS" : result ? "FAILED" : "PENDING";
  const transfers = tx.token_transfers ?? [];
  const expected = BigInt(input.amountAtomic);
  const payerLegs = transfers.filter(
    (t) => t.token_id === input.asset && t.account === input.payerAccount,
  );
  const treasuryLegs = transfers.filter(
    (t) => t.token_id === input.asset && t.account === input.treasuryAccount,
  );
  const payerTransfer =
    payerLegs.length === 1 && typeof payerLegs[0]!.amount === "number"
      ? payerLegs[0]!.amount
      : null;
  const treasuryTransfer =
    treasuryLegs.length === 1 && typeof treasuryLegs[0]!.amount === "number"
      ? treasuryLegs[0]!.amount
      : null;
  const amountAtomicMatch =
    payerTransfer === -Number(expected) &&
    treasuryTransfer === Number(expected);
  return {
    status,
    transactionId: input.transactionId,
    mirrorTransactionId: mirrorId,
    consensusTimestamp: tx.consensus_timestamp
      ? mirrorTimestampToUtcIso(tx.consensus_timestamp)
      : null,
    result,
    payerTransfer,
    treasuryTransfer,
    tokenId: input.asset,
    amountAtomicMatch,
    payerMatch:
      payerTransfer !== null &&
      isValidHederaAccountId(input.payerAccount) &&
      payerTransfer < 0,
    treasuryMatch:
      treasuryTransfer !== null &&
      isValidHederaAccountId(input.treasuryAccount) &&
      treasuryTransfer > 0,
    hashScanUrl: hashScanTransactionUrl(input.transactionId),
  };
}

/**
 * Live reconciler: if the claim already has a settlement identity, confirm it
 * on Mirror. Never invents a transaction and never resettles.
 */
export class MirrorAccessPaymentReconciler
  implements PaymentSettlementReconciler
{
  constructor(
    private readonly options: {
      baseUrl?: string;
      fetchImpl?: typeof fetch;
      maxPolls?: number;
      pollIntervalMs?: number;
    } = {},
  ) {}

  async reconcile(claim: PaymentClaim): Promise<PaymentReconciliationResult> {
    const settlement = claim.settlement;
    if (!settlement) {
      return { status: "UNKNOWN" };
    }
    const maxPolls = this.options.maxPolls ?? 20;
    const pollIntervalMs = this.options.pollIntervalMs ?? 1500;
    for (let i = 0; i < maxPolls; i++) {
      const verified = await verifyUsdcAccessPaymentOnMirror({
        transactionId: settlement.transactionId,
        payerAccount: settlement.payerAccount,
        treasuryAccount: settlement.payTo,
        asset: settlement.asset,
        amountAtomic: settlement.amountAtomic,
        ...(this.options.baseUrl !== undefined
          ? { baseUrl: this.options.baseUrl }
          : {}),
        ...(this.options.fetchImpl !== undefined
          ? { fetchImpl: this.options.fetchImpl }
          : {}),
      });
      if (
        verified.status === "SUCCESS" &&
        verified.amountAtomicMatch &&
        verified.payerMatch &&
        verified.treasuryMatch
      ) {
        const confirmed: SettledAccessPayment = {
          ...settlement,
          consensusTimestamp:
            verified.consensusTimestamp ?? settlement.consensusTimestamp,
        };
        return { status: "CONFIRMED", settlement: confirmed };
      }
      if (verified.status === "FAILED") {
        return { status: "FAILED", failureCode: "MIRROR_FAILED" };
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    return { status: "UNKNOWN" };
  }
}
