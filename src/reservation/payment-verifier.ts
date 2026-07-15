/**
 * Exact transfer verification from Mirror Node shaped confirmation data.
 * HTTP 200 alone is never accepted.
 */

import {
  HBAR_ASSET,
  USDC_TESTNET_ASSET,
} from "../domain/payment-option";
import { isUtcIsoTimestamp } from "../domain/time";
import {
  HBAR_RESERVATION_OPTION,
  ReservationError,
  USDC_RESERVATION_OPTION,
  type MirrorConfirmation,
  type ReservationOptionId,
  type SelectedPaymentOption,
} from "./types";

export type VerifiedPaymentResult = {
  readonly ok: true;
  readonly transactionId: string;
  readonly consensusTimestamp: string;
  readonly optionId: ReservationOptionId;
  readonly asset: string;
  readonly amountAtomic: string;
  readonly payerAccount: string;
  readonly payTo: string;
};

function sumTransfers(
  transfers: readonly { account: string; amount: string; tokenId?: string }[],
  account: string,
  tokenId?: string,
): bigint {
  let sum = 0n;
  for (const t of transfers) {
    if (t.account !== account) continue;
    if (tokenId !== undefined && t.tokenId !== tokenId) continue;
    if (tokenId === undefined && t.tokenId) continue;
    sum += BigInt(t.amount);
  }
  return sum;
}

function countTransfers(
  transfers: readonly { account: string; amount: string; tokenId?: string }[],
  account: string,
  tokenId?: string,
): number {
  let n = 0;
  for (const t of transfers) {
    if (t.account !== account) continue;
    if (tokenId !== undefined && t.tokenId !== tokenId) continue;
    if (tokenId === undefined && t.tokenId) continue;
    n += 1;
  }
  return n;
}

/**
 * Verify Mirror confirmation against the locked selected payment option.
 */
export function verifyMirrorPayment(
  selected: SelectedPaymentOption,
  confirmation: MirrorConfirmation,
  expectedTransactionId: string,
): VerifiedPaymentResult {
  if (confirmation.status !== "SUCCESS") {
    throw new ReservationError(
      "MIRROR_NOT_SUCCESS",
      `Mirror status is ${confirmation.status}, not SUCCESS`,
    );
  }
  if (confirmation.result && confirmation.result !== "SUCCESS") {
    throw new ReservationError(
      "MIRROR_RESULT_FAILED",
      `Mirror result ${confirmation.result}`,
    );
  }
  if (!confirmation.transactionId || !expectedTransactionId) {
    throw new ReservationError(
      "MISSING_TRANSACTION_ID",
      "Transaction ID required for payment confirmation",
    );
  }
  if (confirmation.transactionId !== expectedTransactionId) {
    throw new ReservationError(
      "TRANSACTION_ID_MISMATCH",
      "Mirror transaction ID does not match settlement transaction ID",
    );
  }
  if (
    !confirmation.consensusTimestamp ||
    !isUtcIsoTimestamp(confirmation.consensusTimestamp)
  ) {
    throw new ReservationError(
      "MISSING_CONSENSUS_TIMESTAMP",
      "Consensus timestamp required",
    );
  }

  if (selected.optionId === "HBAR") {
    return verifyHbar(selected, confirmation, expectedTransactionId);
  }
  if (selected.optionId === "USDC") {
    return verifyUsdc(selected, confirmation, expectedTransactionId);
  }
  throw new ReservationError("UNKNOWN_OPTION", "Unsupported option");
}

function verifyHbar(
  selected: SelectedPaymentOption,
  confirmation: MirrorConfirmation,
  transactionId: string,
): VerifiedPaymentResult {
  if (selected.asset !== HBAR_ASSET) {
    throw new ReservationError("ASSET_MISMATCH", "Selected asset is not HBAR");
  }
  if (selected.amountAtomic !== HBAR_RESERVATION_OPTION.amountAtomic) {
    throw new ReservationError("AMOUNT_MISMATCH", "HBAR amount not fixed demo fee");
  }

  const expected = BigInt(HBAR_RESERVATION_OPTION.amountAtomic);
  const payerDelta = sumTransfers(
    confirmation.hbarTransfers,
    selected.payerAccount,
  );
  const receiverDelta = sumTransfers(
    confirmation.hbarTransfers,
    selected.payTo,
  );

  // Payer must be exactly -amount (fees may appear as extra negative on fee payer, not shipper)
  if (payerDelta !== -expected) {
    throw new ReservationError(
      "HBAR_PAYER_AMOUNT",
      `Payer HBAR transfer ${payerDelta.toString()} !== -${expected.toString()}`,
    );
  }
  if (receiverDelta !== expected) {
    throw new ReservationError(
      "HBAR_RECEIVER_AMOUNT",
      `Receiver HBAR transfer ${receiverDelta.toString()} !== ${expected.toString()}`,
    );
  }

  // Reject duplicate primary transfer legs for payer/receiver demo amounts
  // (allow single net entry per account)
  if (countTransfers(confirmation.hbarTransfers, selected.payerAccount) > 1) {
    // Multiple entries summing correctly is ok if net matches; duplicate same-direction fail
    const amounts = confirmation.hbarTransfers
      .filter((t) => t.account === selected.payerAccount && !t.tokenId)
      .map((t) => t.amount);
    if (amounts.length > 1 && amounts.every((a) => a === `-${expected}`)) {
      throw new ReservationError(
        "DUPLICATE_TRANSFER",
        "Duplicate payer HBAR transfer of full amount",
      );
    }
  }

  // No USDC token movement required; reject unexpected full USDC transfer of demo amount
  const usdcPayer = sumTransfers(
    confirmation.tokenTransfers,
    selected.payerAccount,
    USDC_TESTNET_ASSET,
  );
  if (usdcPayer !== 0n) {
    throw new ReservationError(
      "UNEXPECTED_TOKEN_TRANSFER",
      "HBAR payment must not include USDC transfer",
    );
  }

  return {
    ok: true,
    transactionId,
    consensusTimestamp: confirmation.consensusTimestamp!,
    optionId: "HBAR",
    asset: selected.asset,
    amountAtomic: selected.amountAtomic,
    payerAccount: selected.payerAccount,
    payTo: selected.payTo,
  };
}

function verifyUsdc(
  selected: SelectedPaymentOption,
  confirmation: MirrorConfirmation,
  transactionId: string,
): VerifiedPaymentResult {
  if (selected.asset !== USDC_TESTNET_ASSET) {
    throw new ReservationError("ASSET_MISMATCH", "Selected asset is not USDC");
  }
  if (selected.amountAtomic !== USDC_RESERVATION_OPTION.amountAtomic) {
    throw new ReservationError("AMOUNT_MISMATCH", "USDC amount not fixed demo fee");
  }

  const expected = BigInt(USDC_RESERVATION_OPTION.amountAtomic);
  const tokenId = USDC_TESTNET_ASSET;

  const payerDelta = sumTransfers(
    confirmation.tokenTransfers,
    selected.payerAccount,
    tokenId,
  );
  const receiverDelta = sumTransfers(
    confirmation.tokenTransfers,
    selected.payTo,
    tokenId,
  );

  if (payerDelta !== -expected) {
    throw new ReservationError(
      "USDC_PAYER_AMOUNT",
      `Payer USDC transfer ${payerDelta.toString()} !== -${expected.toString()}`,
    );
  }
  if (receiverDelta !== expected) {
    throw new ReservationError(
      "USDC_RECEIVER_AMOUNT",
      `Receiver USDC transfer ${receiverDelta.toString()} !== ${expected.toString()}`,
    );
  }

  // Wrong token rejection: any other token transfer of non-zero amount involving parties
  for (const t of confirmation.tokenTransfers) {
    if (
      (t.account === selected.payerAccount || t.account === selected.payTo) &&
      t.tokenId &&
      t.tokenId !== tokenId &&
      t.amount !== "0"
    ) {
      throw new ReservationError(
        "WRONG_TOKEN",
        `Unexpected token ${t.tokenId}`,
      );
    }
  }

  const dupPayer = confirmation.tokenTransfers.filter(
    (t) =>
      t.account === selected.payerAccount &&
      t.tokenId === tokenId &&
      t.amount === `-${expected}`,
  );
  if (dupPayer.length > 1) {
    throw new ReservationError(
      "DUPLICATE_TRANSFER",
      "Duplicate payer USDC transfer of full amount",
    );
  }

  return {
    ok: true,
    transactionId,
    consensusTimestamp: confirmation.consensusTimestamp!,
    optionId: "USDC",
    asset: selected.asset,
    amountAtomic: selected.amountAtomic,
    payerAccount: selected.payerAccount,
    payTo: selected.payTo,
  };
}

/** HTTP 200 alone is never proof of payment. */
export function assertNotHttpOnlyProof(input: {
  httpStatus?: number;
  hasSettlementSuccess?: boolean;
  hasTransactionId?: boolean;
  mirrorSuccess?: boolean;
}): void {
  if (
    input.httpStatus === 200 &&
    !input.hasSettlementSuccess &&
    !input.hasTransactionId &&
    !input.mirrorSuccess
  ) {
    throw new ReservationError(
      "HTTP_200_INSUFFICIENT",
      "HTTP 200 alone is not sufficient proof of settlement",
    );
  }
}
