/**
 * Payer-side x402 payment-payload generation for Phase 6B.
 *
 * Creates and signs a PaymentPayload in process memory only.
 * Does NOT settle — facilitator verify/settle remains ReservationService authority.
 * Never logs the signed payload, PAYMENT-SIGNATURE, or private keys.
 */

import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

import { canonicalSha256 } from "../../domain/canonical-hash";
import { validStartIsoFromTransactionId } from "../client-transaction";
import {
  PHASE6B_CARRIER_ACCOUNT,
  PHASE6B_FACILITATOR_FEE_PAYER,
  PHASE6B_NETWORK,
  PHASE6B_PAYER_ACCOUNT,
  PHASE6B_USDC_AMOUNT_ATOMIC,
  PHASE6B_USDC_TOKEN,
} from "./constants";
import { Phase6bAttemptError } from "./attempt-store";
import type { PayerPaymentPayloadFactory } from "./live-execution";

const EXPECTED_PAYER_PUBKEY =
  "02c07aaa7bc004c9c44186395f496639cf46741b6bc8092c024156e5ac68d5fde5";

/**
 * Build a real payer-side factory using installed @x402 packages.
 * Reads private key only when invoked (never at import time).
 */
export function createLivePayerPaymentPayloadFactory(options: {
  env?: NodeJS.ProcessEnv;
  /** Override fee payer (default: known Blocky402 testnet fee payer). */
  feePayer?: string;
}): PayerPaymentPayloadFactory {
  return async (input) => {
    const env = options.env ?? process.env;
    const accountId = env.SHIPPER_ACCOUNT_ID?.trim();
    const privateKeyText = env.SHIPPER_PRIVATE_KEY?.trim();
    if (!accountId || !privateKeyText) {
      throw new Phase6bAttemptError(
        "SHIPPER_ACCOUNT_ID and SHIPPER_PRIVATE_KEY required to create payment payload",
        "PAYER_CREDENTIALS_REQUIRED",
      );
    }
    if (accountId !== PHASE6B_PAYER_ACCOUNT) {
      throw new Phase6bAttemptError(
        "Payer account must be 0.0.9197513",
        "WRONG_PAYER",
      );
    }
    if (input.selected.payerAccount !== PHASE6B_PAYER_ACCOUNT) {
      throw new Phase6bAttemptError("Selected payer mismatch", "WRONG_PAYER");
    }
    if (input.selected.payTo !== PHASE6B_CARRIER_ACCOUNT) {
      throw new Phase6bAttemptError(
        "Selected receiver mismatch",
        "WRONG_RECEIVER",
      );
    }
    if (input.selected.asset !== PHASE6B_USDC_TOKEN) {
      throw new Phase6bAttemptError("Selected asset must be USDC", "WRONG_TOKEN");
    }
    if (input.selected.amountAtomic !== PHASE6B_USDC_AMOUNT_ATOMIC) {
      throw new Phase6bAttemptError(
        "Selected amount must be 10000",
        "WRONG_AMOUNT",
      );
    }

    const feePayer =
      options.feePayer?.trim() ||
      env.USDC_EXPECTED_FEE_PAYER?.trim() ||
      PHASE6B_FACILITATOR_FEE_PAYER;

    const [coreClientModule, hederaModule, hederaExactModule] =
      await Promise.all([
        import("@x402/core/client"),
        import("@x402/hedera"),
        import("@x402/hedera/exact/client"),
      ]);

    let shipperPrivateKey: ReturnType<
      typeof hederaModule.PrivateKey.fromStringECDSA
    >;
    try {
      shipperPrivateKey =
        hederaModule.PrivateKey.fromStringECDSA(privateKeyText);
    } catch {
      throw new Phase6bAttemptError(
        "Invalid SHIPPER_PRIVATE_KEY",
        "OPERATOR_KEY_INVALID",
      );
    }

    const derivedHex = shipperPrivateKey.publicKey
      .toStringRaw()
      .toLowerCase();
    if (derivedHex !== EXPECTED_PAYER_PUBKEY) {
      throw new Phase6bAttemptError(
        "Derived public key does not match approved payer key",
        "PAYER_KEY_MISMATCH",
      );
    }

    const signer = hederaModule.createClientHederaSigner(
      accountId,
      shipperPrivateKey,
      { network: PHASE6B_NETWORK },
    );

    const requirement: PaymentRequirements = {
      scheme: "exact",
      network: PHASE6B_NETWORK,
      asset: PHASE6B_USDC_TOKEN,
      amount: PHASE6B_USDC_AMOUNT_ATOMIC,
      payTo: PHASE6B_CARRIER_ACCOUNT,
      maxTimeoutSeconds: input.challenge.maxTimeoutSeconds,
      extra: { feePayer },
    };

    const client = new coreClientModule.x402Client(
      (x402Version, requirements) => {
        if (x402Version !== 2) {
          throw new Phase6bAttemptError(
            "Unexpected x402Version during payment creation",
            "X402_VERSION_MISMATCH",
          );
        }
        if (requirements.length !== 1) {
          throw new Phase6bAttemptError(
            "Expected exactly one payment requirement",
            "REQUIREMENT_COUNT",
          );
        }
        const r = requirements[0]!;
        if (r.network !== PHASE6B_NETWORK || r.scheme !== "exact") {
          throw new Phase6bAttemptError(
            "Requirement network/scheme mismatch",
            "REQUIREMENT_MISMATCH",
          );
        }
        if (r.asset !== PHASE6B_USDC_TOKEN) {
          throw new Phase6bAttemptError(
            "Requirement asset mismatch",
            "WRONG_TOKEN",
          );
        }
        if (r.amount !== PHASE6B_USDC_AMOUNT_ATOMIC) {
          throw new Phase6bAttemptError(
            "Requirement amount mismatch",
            "WRONG_AMOUNT",
          );
        }
        if (r.payTo !== PHASE6B_CARRIER_ACCOUNT) {
          throw new Phase6bAttemptError(
            "Requirement payTo mismatch",
            "WRONG_RECEIVER",
          );
        }
        return r;
      },
    ).register(
      PHASE6B_NETWORK,
      new hederaExactModule.ExactHederaScheme(signer),
    );

    // createPaymentPayload keeps the signed payload in memory for the caller.
    const paymentPayload: PaymentPayload = await client.createPaymentPayload({
      x402Version: 2,
      error: "Payment required for RouteGuard reservation",
      resource: {
        url: input.challenge.resource,
        description: input.challenge.description,
        mimeType: "application/json",
      },
      accepts: [requirement],
    });

    // v1.5 §22.4 — decode the EXACT client-frozen transaction identity from the
    // signed transaction bytes (offline; nothing invented). Cross-checked
    // between the official @x402/hedera inspector and the Hiero SDK decode.
    const txBase64 =
      (paymentPayload as { payload?: { transaction?: string } })?.payload
        ?.transaction ??
      (paymentPayload as { transaction?: string })?.transaction;
    if (typeof txBase64 !== "string" || txBase64.length === 0) {
      throw new Phase6bAttemptError(
        "Signed payment payload lacks a decodable transaction",
        "CLIENT_TX_UNDECODABLE",
      );
    }
    const inspected = hederaModule.inspectHederaTransaction(txBase64);
    const sdkModule = await import("@hiero-ledger/sdk");
    const decoded = sdkModule.Transaction.fromBytes(
      Buffer.from(txBase64, "base64"),
    );
    const decodedTxId = decoded.transactionId?.toString()?.trim();
    if (!decodedTxId || !/^\d+\.\d+\.\d+@\d+\.\d+$/.test(decodedTxId)) {
      throw new Phase6bAttemptError(
        "Signed transaction has no client-frozen transaction ID",
        "CLIENT_TX_ID_MISSING",
      );
    }
    if (
      typeof inspected.transactionId === "string" &&
      inspected.transactionId.trim() &&
      inspected.transactionId.trim() !== decodedTxId
    ) {
      throw new Phase6bAttemptError(
        "Inspector and SDK disagree on the frozen transaction ID",
        "CLIENT_TX_ID_MISMATCH",
      );
    }
    const durationSeconds = decoded.transactionValidDuration;
    if (
      !Number.isInteger(durationSeconds) ||
      durationSeconds < 1 ||
      durationSeconds > 180
    ) {
      throw new Phase6bAttemptError(
        "Signed transaction valid duration outside Hedera bounds",
        "CLIENT_TX_DURATION_INVALID",
      );
    }
    const clientTransaction = {
      transactionId: decodedTxId,
      validStartTimestamp: validStartIsoFromTransactionId(decodedTxId),
      transactionValidDurationSeconds: durationSeconds,
    };

    const paymentPayloadHash = canonicalSha256(paymentPayload);
    return { paymentPayload, requirement, paymentPayloadHash, clientTransaction };
  };
}
