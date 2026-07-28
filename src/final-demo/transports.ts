/**
 * Transport interfaces for final-demo shared orchestration.
 * Dry-run and live differ only by injected implementations.
 */

import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

import type { HcsEnvelope, ObservedHcsMessage } from "../hcs/types";
import type {
  FacilitatorTransport,
  MirrorConfirmationTransport,
  WebhookDeliveryTransport,
} from "../reservation/transports";
import type { FinalDemoMessageLabel } from "./constants";
import type { FinalDemoHcsSubmitter } from "./hcs-submit-authority";

export type FinalDemoClock = {
  nowMs: () => number;
  nowIso: () => string;
  /** Wall-clock or fake sleep until duration elapses. */
  sleep: (ms: number) => Promise<void>;
  /** Optional: dry-run / tests may advance fake clock. */
  advanceMs?: (ms: number) => void;
  setClockMs?: (ms: number) => void;
};

export type TopicCreateResult = {
  topicId: string;
  transactionId: string;
  topicMemo: string;
  createdAt: string;
  receiptStatus: string;
};

export type FinalDemoTopicTransport = {
  createTopic: (memo: string) => Promise<TopicCreateResult>;
  /** Cumulative create invocations in this process (budget probe). */
  getCreateCount: () => number;
};

export type HcsSubmitResult = {
  topicId: string;
  sequence: number;
  transactionId: string;
  consensusTimestamp: string;
  envelopeHash: string;
  receiptStatus: string;
};

export type FinalDemoHcsTransport = {
  submitMessage: (input: {
    topicId: string;
    envelope: HcsEnvelope;
    label: FinalDemoMessageLabel;
    submitter: FinalDemoHcsSubmitter;
    exactBytes: Uint8Array;
  }) => Promise<HcsSubmitResult>;
  getSubmitCount: () => number;
};

export type FinalDemoTopicMirrorReader = {
  /** Read all messages currently visible on the topic (ascending sequence). */
  listMessages: (topicId: string) => Promise<ObservedHcsMessage[]>;
  /**
   * Wait until Mirror shows the exact envelope hash (optional; live uses this).
   * Dry-run may resolve immediately from listMessages.
   */
  waitForEnvelopeHash?: (
    topicId: string,
    envelopeHash: string,
    options?: { timeoutMs?: number; pollIntervalMs?: number },
  ) => Promise<ObservedHcsMessage>;
};

export type SessionFacilitatorTransport = FacilitatorTransport & {
  bindPaymentSession: (input: {
    paymentPayload: PaymentPayload;
    requirement: PaymentRequirements;
    paymentPayloadHash: string;
    challengeHash: string;
    /** Client-frozen transaction ID for exact settle-response binding. */
    clientTransactionId?: string;
  }) => void;
  clearPaymentSession: () => void;
  /** Test/ops counters when available. */
  verifyCallCount?: number;
  settleCallCount?: number;
};

export type PaymentPayloadFactory = (input: {
  selected: {
    optionId: "USDC";
    scheme: string;
    network: string;
    asset: string;
    amountAtomic: string;
    payTo: string;
    payerAccount: string;
    reservationId?: string;
    offerHash?: string;
    offerVersion?: number;
    selectedAt?: string;
    resourcePath?: string;
  };
  challenge: {
    x402Version: number;
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    resource: string;
    maxTimeoutSeconds: number;
    description: string;
  };
}) => Promise<{
  paymentPayload: PaymentPayload;
  requirement: PaymentRequirements;
  paymentPayloadHash: string;
  /**
   * v1.5 §22.4 — exact transaction identity decoded from the signed payment
   * transaction (never invented). Persisted before any facilitator call.
   */
  clientTransaction: {
    transactionId: string;
    validStartTimestamp: string;
    transactionValidDurationSeconds: number;
  };
}>;

export type UsdcReadinessResult = {
  ok: boolean;
  tokenId: string;
  payerAccountId: string;
  receiverAccountId: string;
  payerAssociated: boolean;
  payerBalanceAtomic: string;
  receiverUsable: boolean;
  reasons: string[];
};

export type AccountCheckResult = {
  ok: boolean;
  reasons: string[];
};

export type FinalDemoReadinessChecks = {
  secretScan: () => void;
  /** F-002 — facilitator capability preflight, before any irreversible write. */
  facilitatorPreflight?: () => Promise<void>;
  accountCheck?: () => Promise<AccountCheckResult>;
  usdcReadiness?: () => Promise<UsdcReadinessResult>;
};

export type { MirrorConfirmationTransport, WebhookDeliveryTransport };
