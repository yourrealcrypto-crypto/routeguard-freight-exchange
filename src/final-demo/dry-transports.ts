/**
 * Offline dry-run transports for final-demo shared orchestration.
 * Zero real network writes. Exercises ReservationService settlement.
 */

import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

import { canonicalSha256 } from "../domain/canonical-hash";
import {
  envelopeHash,
  serializeEnvelopeForSubmit,
} from "../hcs/message-envelope";
import type { HcsEnvelope, ObservedHcsMessage } from "../hcs/types";
import type { MirrorConfirmation } from "../reservation/types";
import { LocalDemoWebhookTransport } from "../reservation/live/adapters";
import {
  FINAL_DEMO_NETWORK,
  FINAL_DEMO_PAYER_ACCOUNT,
  FINAL_DEMO_USDC_AMOUNT_ATOMIC,
  FINAL_DEMO_USDC_TOKEN,
  FINAL_DEMO_WINNER_ACCOUNT,
} from "./constants";
import { FinalDemoError } from "./errors";
import { MockFinalDemoNetwork } from "./mock-network";
import type {
  FinalDemoClock,
  FinalDemoHcsTransport,
  FinalDemoTopicMirrorReader,
  FinalDemoTopicTransport,
  PaymentPayloadFactory,
  SessionFacilitatorTransport,
} from "./transports";
import type { MirrorConfirmationTransport } from "../reservation/transports";
import type { WebhookDeliveryTransport } from "../reservation/transports";

export type DryRunTransportBundle = {
  network: MockFinalDemoNetwork;
  clock: FinalDemoClock;
  topicTransport: FinalDemoTopicTransport;
  hcsTransport: FinalDemoHcsTransport;
  topicMirrorReader: FinalDemoTopicMirrorReader;
  paymentPayloadFactory: PaymentPayloadFactory;
  facilitatorTransport: SessionFacilitatorTransport;
  paymentMirrorTransport: MirrorConfirmationTransport;
  webhookTransport: WebhookDeliveryTransport;
};

/**
 * Build injectable dry-run dependencies around MockFinalDemoNetwork.
 */
export function createFinalDemoDryRunTransports(options?: {
  clockMs?: number;
}): DryRunTransportBundle {
  const network = new MockFinalDemoNetwork({
    clockMs: options?.clockMs ?? Date.now(),
  });

  const clock: FinalDemoClock = {
    nowMs: () => network.getClockMs(),
    nowIso: () => network.nowIso(),
    sleep: async (ms) => {
      network.advanceMs(ms);
    },
    advanceMs: (ms) => network.advanceMs(ms),
    setClockMs: (ms) => network.setClock(ms),
  };

  const topicTransport: FinalDemoTopicTransport = {
    createTopic: async (memo) => {
      const r = await network.createTopic(memo);
      return {
        topicId: r.topicId,
        transactionId: r.transactionId,
        topicMemo: r.topicMemo,
        createdAt: r.createdAt,
        receiptStatus: r.receiptStatus,
      };
    },
    getCreateCount: () => network.createCount,
  };

  const hcsTransport: FinalDemoHcsTransport = {
    submitMessage: async (input) => {
      const r = await network.submitMessage({
        topicId: input.topicId,
        envelope: input.envelope,
        label: input.label,
      });
      // Ensure exact bytes were measured by caller
      const recomputed = serializeEnvelopeForSubmit(input.envelope);
      if (recomputed.byteLength !== input.exactBytes.byteLength) {
        throw new FinalDemoError(
          "exactBytes length mismatch vs envelope",
          "ENVELOPE_BYTES_MISMATCH",
        );
      }
      if (envelopeHash(input.envelope) !== r.envelopeHash) {
        throw new FinalDemoError(
          "envelope hash mismatch",
          "ENVELOPE_HASH_MISMATCH",
        );
      }
      return r;
    },
    getSubmitCount: () => network.submitCount,
  };

  const topicMirrorReader: FinalDemoTopicMirrorReader = {
    listMessages: async (topicId) => network.listMessages(topicId),
    waitForEnvelopeHash: async (topicId, hash) => {
      const msgs = network.listMessages(topicId);
      const found = msgs.find((m) => m.envelopeHash === hash);
      if (!found) {
        throw new FinalDemoError(
          "Mock Mirror missing envelope hash",
          "MIRROR_CONFIRM_FAILED",
        );
      }
      return found;
    },
  };

  const facilitator = createDryRunFacilitator(network);
  const paymentMirror = createDryRunPaymentMirror(network, facilitator);
  const paymentPayloadFactory = createDryRunPaymentPayloadFactory();
  const webhookTransport = new LocalDemoWebhookTransport();

  return {
    network,
    clock,
    topicTransport,
    hcsTransport,
    topicMirrorReader,
    paymentPayloadFactory,
    facilitatorTransport: facilitator,
    paymentMirrorTransport: paymentMirror,
    webhookTransport,
  };
}

function createDryRunPaymentPayloadFactory(): PaymentPayloadFactory {
  return async (input) => {
    if (input.selected.optionId !== "USDC") {
      throw new FinalDemoError("Dry-run USDC only", "USDC_ONLY");
    }
    if (input.selected.asset !== FINAL_DEMO_USDC_TOKEN) {
      throw new FinalDemoError("Wrong token", "WRONG_TOKEN");
    }
    if (input.selected.amountAtomic !== FINAL_DEMO_USDC_AMOUNT_ATOMIC) {
      throw new FinalDemoError("Wrong amount", "WRONG_AMOUNT");
    }
    if (input.selected.payerAccount !== FINAL_DEMO_PAYER_ACCOUNT) {
      throw new FinalDemoError("Wrong payer", "WRONG_PAYER");
    }
    if (input.selected.payTo !== FINAL_DEMO_WINNER_ACCOUNT) {
      throw new FinalDemoError("Wrong receiver", "WRONG_RECEIVER");
    }

    const paymentPayload = {
      x402Version: 2,
      scheme: "exact",
      network: FINAL_DEMO_NETWORK,
      payload: {
        dryRun: true,
        note: "in-memory-synthetic-never-persisted",
        asset: input.selected.asset,
        amount: input.selected.amountAtomic,
        payTo: input.selected.payTo,
      },
    } as unknown as PaymentPayload;

    const requirement = {
      scheme: "exact",
      network: FINAL_DEMO_NETWORK,
      maxAmountRequired: input.selected.amountAtomic,
      resource: input.challenge.resource,
      description: input.challenge.description,
      mimeType: "application/json",
      payTo: input.selected.payTo,
      maxTimeoutSeconds: input.challenge.maxTimeoutSeconds,
      asset: input.selected.asset,
      extra: { dryRun: true },
    } as unknown as PaymentRequirements;

    const paymentPayloadHash = canonicalSha256(paymentPayload);
    return { paymentPayload, requirement, paymentPayloadHash };
  };
}

function createDryRunFacilitator(
  network: MockFinalDemoNetwork,
): SessionFacilitatorTransport {
  let session: {
    paymentPayload: PaymentPayload;
    requirement: PaymentRequirements;
    paymentPayloadHash: string;
    challengeHash: string;
  } | null = null;

  const fac: SessionFacilitatorTransport = {
    verifyCallCount: 0,
    settleCallCount: 0,
    bindPaymentSession(input) {
      session = { ...input };
    },
    clearPaymentSession() {
      session = null;
    },
    async verify(input) {
      fac.verifyCallCount = (fac.verifyCallCount ?? 0) + 1;
      if (!session) {
        return { isValid: false, invalidReason: "no_session" };
      }
      if (session.paymentPayloadHash !== input.paymentPayloadHash) {
        return { isValid: false, invalidReason: "payload_hash_mismatch" };
      }
      if (session.challengeHash !== input.challengeHash) {
        return { isValid: false, invalidReason: "challenge_hash_mismatch" };
      }
      // Synthetic in-memory payload is accepted once
      void session.paymentPayload;
      return { isValid: true };
    },
    async settle(input) {
      fac.settleCallCount = (fac.settleCallCount ?? 0) + 1;
      if ((fac.settleCallCount ?? 0) > 1) {
        throw new FinalDemoError(
          "Dry-run facilitator refuses second settle",
          "PAYMENT_ALREADY_SUBMITTED",
        );
      }
      if (!session) {
        return {
          success: false,
          transactionId: null,
          network: FINAL_DEMO_NETWORK,
          payerAccountId: FINAL_DEMO_PAYER_ACCOUNT,
          errorReason: "no_session",
        };
      }
      if (session.paymentPayloadHash !== input.paymentPayloadHash) {
        return {
          success: false,
          transactionId: null,
          network: FINAL_DEMO_NETWORK,
          payerAccountId: FINAL_DEMO_PAYER_ACCOUNT,
          errorReason: "payload_hash_mismatch",
        };
      }
      network.advanceMs(200);
      const transactionId = `0.0.9197513@${Math.floor(network.getClockMs() / 1000)}.555000000`;
      // stash for mirror
      (fac as { _lastTxId?: string })._lastTxId = transactionId;
      (fac as { _lastConsensus?: string })._lastConsensus =
        network.consensusTimestamp();
      return {
        success: true,
        transactionId,
        network: FINAL_DEMO_NETWORK,
        payerAccountId: FINAL_DEMO_PAYER_ACCOUNT,
      };
    },
  };
  return fac;
}

function createDryRunPaymentMirror(
  network: MockFinalDemoNetwork,
  facilitator: SessionFacilitatorTransport,
): MirrorConfirmationTransport {
  return {
    async getTransaction(transactionId: string): Promise<MirrorConfirmation> {
      const lastTx = (facilitator as { _lastTxId?: string })._lastTxId;
      const consensus =
        (facilitator as { _lastConsensus?: string })._lastConsensus ??
        network.consensusTimestamp();
      if (lastTx && transactionId !== lastTx) {
        return {
          status: "NOT_FOUND",
          transactionId,
          consensusTimestamp: null,
          result: null,
          hbarTransfers: [],
          tokenTransfers: [],
        };
      }
      // Exact USDC transfer legs
      return {
        status: "SUCCESS",
        transactionId,
        consensusTimestamp: consensus,
        result: "SUCCESS",
        hbarTransfers: [],
        tokenTransfers: [
          {
            account: FINAL_DEMO_PAYER_ACCOUNT,
            tokenId: FINAL_DEMO_USDC_TOKEN,
            amount: `-${FINAL_DEMO_USDC_AMOUNT_ATOMIC}`,
          },
          {
            account: FINAL_DEMO_WINNER_ACCOUNT,
            tokenId: FINAL_DEMO_USDC_TOKEN,
            amount: FINAL_DEMO_USDC_AMOUNT_ATOMIC,
          },
        ],
      };
    },
  };
}

/** Type-only re-export helpers for tests. */
export type { ObservedHcsMessage, HcsEnvelope };
