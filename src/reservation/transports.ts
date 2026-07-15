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

/**
 * Read-only authoritative HCS publication resolver (Mirror-backed in production;
 * mocked in this milestone). Used when a CLAIMED publication has no recorded
 * result so the service never auto-resubmits.
 */
export type HcsPublicationResolveResult =
  | {
      readonly status: "FOUND";
      readonly topicId: string;
      readonly sequence: number;
      /** May be null when Mirror does not surface a transaction id. */
      readonly transactionId: string | null;
      readonly consensusTimestamp: string;
      readonly envelopeHash: string;
    }
  | { readonly status: "NOT_FOUND_CONCLUSIVE" }
  | { readonly status: "AMBIGUOUS" };

export interface HcsPublicationResolver {
  resolvePublication(input: {
    topicId: string;
    envelopeHash: string;
    messageType: "ROUTE_RESERVED";
    reservationId: string;
  }): Promise<HcsPublicationResolveResult>;
}
