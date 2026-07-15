/**
 * Exact transfer-shape verification from Mirror Node confirmation data.
 *
 * Payment is NEVER accepted by summing arbitrary duplicate/split legs to a net
 * amount. The payer and carrier payment legs must each be a single exact raw
 * transfer entry. HTTP 200 alone is never accepted.
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
  type MirrorTransfer,
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
  /**
   * Unrelated HBAR entries (facilitator/network/node/assessed fees) recorded
   * separately. They never affect payer/carrier payment semantics.
   */
  readonly feeTransfers: readonly MirrorTransfer[];
};

/** HBAR-native transfer entries (no tokenId). */
function hbarEntries(
  transfers: readonly MirrorTransfer[],
  account: string,
): MirrorTransfer[] {
  return transfers.filter((t) => t.account === account && !t.tokenId);
}

/** Token entries for a specific tokenId. */
function tokenEntries(
  transfers: readonly MirrorTransfer[],
  account: string,
  tokenId: string,
): MirrorTransfer[] {
  return transfers.filter(
    (t) => t.account === account && t.tokenId === tokenId,
  );
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

  if (selected.payerAccount === selected.payTo) {
    throw new ReservationError(
      "SELF_PAYMENT",
      "Payer and carrier accounts must differ",
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

  // Payer leg: exactly one raw HBAR entry, exactly -amount. No split/duplicate.
  const payerLegs = hbarEntries(confirmation.hbarTransfers, selected.payerAccount);
  if (payerLegs.length !== 1) {
    throw new ReservationError(
      "HBAR_PAYER_SHAPE",
      `Payer HBAR must be exactly one transfer entry, found ${payerLegs.length} (no split/duplicate legs)`,
    );
  }
  if (BigInt(payerLegs[0]!.amount) !== -expected) {
    throw new ReservationError(
      "HBAR_PAYER_AMOUNT",
      `Payer HBAR transfer ${payerLegs[0]!.amount} !== -${expected.toString()}`,
    );
  }

  // Receiver leg: exactly one raw HBAR entry, exactly +amount.
  const carrierLegs = hbarEntries(confirmation.hbarTransfers, selected.payTo);
  if (carrierLegs.length !== 1) {
    throw new ReservationError(
      "HBAR_RECEIVER_SHAPE",
      `Receiver HBAR must be exactly one transfer entry, found ${carrierLegs.length} (no split/duplicate legs)`,
    );
  }
  if (BigInt(carrierLegs[0]!.amount) !== expected) {
    throw new ReservationError(
      "HBAR_RECEIVER_AMOUNT",
      `Receiver HBAR transfer ${carrierLegs[0]!.amount} !== ${expected.toString()}`,
    );
  }

  // HBAR payment must not include any USDC movement for the parties.
  const partyUsdc = confirmation.tokenTransfers.filter(
    (t) =>
      (t.account === selected.payerAccount || t.account === selected.payTo) &&
      t.amount !== "0" &&
      BigInt(t.amount) !== 0n,
  );
  if (partyUsdc.length > 0) {
    throw new ReservationError(
      "UNEXPECTED_TOKEN_TRANSFER",
      "HBAR payment must not include token transfers for payer/carrier",
    );
  }

  // Unrelated HBAR entries (facilitator/network/node/assessed fees) are allowed
  // and recorded separately; they never alter payer/carrier semantics.
  const feeTransfers = confirmation.hbarTransfers.filter(
    (t) =>
      !t.tokenId &&
      t.account !== selected.payerAccount &&
      t.account !== selected.payTo,
  );

  return {
    ok: true,
    transactionId,
    consensusTimestamp: confirmation.consensusTimestamp!,
    optionId: "HBAR",
    asset: selected.asset,
    amountAtomic: selected.amountAtomic,
    payerAccount: selected.payerAccount,
    payTo: selected.payTo,
    feeTransfers,
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

  // Reject any wrong-token substitute involving the parties.
  for (const t of confirmation.tokenTransfers) {
    if (
      (t.account === selected.payerAccount || t.account === selected.payTo) &&
      t.tokenId &&
      t.tokenId !== tokenId &&
      BigInt(t.amount) !== 0n
    ) {
      throw new ReservationError(
        "WRONG_TOKEN",
        `Unexpected token ${t.tokenId} for payer/carrier`,
      );
    }
  }

  // Payer leg: exactly one selected-token entry, exactly -amount. No split.
  const payerLegs = tokenEntries(
    confirmation.tokenTransfers,
    selected.payerAccount,
    tokenId,
  );
  if (payerLegs.length !== 1) {
    throw new ReservationError(
      "USDC_PAYER_SHAPE",
      `Payer USDC must be exactly one transfer entry, found ${payerLegs.length} (no split/duplicate legs)`,
    );
  }
  if (BigInt(payerLegs[0]!.amount) !== -expected) {
    throw new ReservationError(
      "USDC_PAYER_AMOUNT",
      `Payer USDC transfer ${payerLegs[0]!.amount} !== -${expected.toString()}`,
    );
  }

  // Receiver leg: exactly one selected-token entry, exactly +amount.
  const carrierLegs = tokenEntries(
    confirmation.tokenTransfers,
    selected.payTo,
    tokenId,
  );
  if (carrierLegs.length !== 1) {
    throw new ReservationError(
      "USDC_RECEIVER_SHAPE",
      `Receiver USDC must be exactly one transfer entry, found ${carrierLegs.length} (no split/duplicate legs)`,
    );
  }
  if (BigInt(carrierLegs[0]!.amount) !== expected) {
    throw new ReservationError(
      "USDC_RECEIVER_AMOUNT",
      `Receiver USDC transfer ${carrierLegs[0]!.amount} !== ${expected.toString()}`,
    );
  }

  // No other non-zero selected-token entry (e.g. a third-party USDC leg).
  for (const t of confirmation.tokenTransfers) {
    if (t.tokenId !== tokenId) continue;
    if (t.account === selected.payerAccount || t.account === selected.payTo) {
      continue;
    }
    if (BigInt(t.amount) !== 0n) {
      throw new ReservationError(
        "USDC_THIRD_PARTY_TRANSFER",
        `Unexpected third-party USDC transfer for ${t.account}`,
      );
    }
  }

  const feeTransfers = confirmation.hbarTransfers.filter(
    (t) =>
      !t.tokenId &&
      t.account !== selected.payerAccount &&
      t.account !== selected.payTo,
  );

  return {
    ok: true,
    transactionId,
    consensusTimestamp: confirmation.consensusTimestamp!,
    optionId: "USDC",
    asset: selected.asset,
    amountAtomic: selected.amountAtomic,
    payerAccount: selected.payerAccount,
    payTo: selected.payTo,
    feeTransfers,
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
