/**
 * Transport interfaces for reservation payment orchestration (mockable).
 */

import type {
  FacilitatorSettleResult,
  FacilitatorVerifyResult,
  MirrorConfirmation,
  PaymentChallenge,
  SelectedPaymentOption,
  SignedWebhook,
} from "./types";
import type { HcsEnvelope } from "../hcs/types";

export interface X402ChallengeTransport {
  createChallenge(
    selected: SelectedPaymentOption,
  ): Promise<PaymentChallenge>;
}

export interface FacilitatorTransport {
  verify(input: {
    selected: SelectedPaymentOption;
    paymentPayloadHash: string;
    challengeHash: string;
  }): Promise<FacilitatorVerifyResult>;

  settle(input: {
    selected: SelectedPaymentOption;
    paymentPayloadHash: string;
    challengeHash: string;
  }): Promise<FacilitatorSettleResult>;
}

export interface MirrorConfirmationTransport {
  getTransaction(transactionId: string): Promise<MirrorConfirmation>;
}

export interface WebhookDeliveryTransport {
  deliver(
    recipient: "shipper" | "carrier",
    webhook: SignedWebhook,
  ): Promise<{ ok: boolean; error?: string }>;
}

export interface HcsPublisherTransport {
  publish(envelope: HcsEnvelope): Promise<{
    topicId: string;
    sequence: number;
    transactionId: string;
    consensusTimestamp: string;
  }>;
}
