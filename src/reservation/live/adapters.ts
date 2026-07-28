/**
 * Production-shaped transport adapters for Phase 6B.
 * Dry-run never invokes live network write methods.
 */

import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

import { mirrorTimestampToUtcIso } from "../../hcs/mirror-node-client";
import {
  assertMessageSize,
  envelopeHash,
  serializeEnvelopeForSubmit,
} from "../../hcs/message-envelope";
import type { HcsEnvelope } from "../../hcs/types";
import { HCS_MAX_MESSAGE_BYTES } from "../../hcs/types";
import {
  DEMO_RESERVATION_FEE_NOTE,
  type FacilitatorSettleResult,
  type FacilitatorVerifyResult,
  type MirrorConfirmation,
  type MirrorTransfer,
  type PaymentChallenge,
  type SelectedPaymentOption,
  type SignedWebhook,
} from "../types";
import type {
  FacilitatorTransport,
  HcsPublicationResolveResult,
  HcsPublicationResolver,
  HcsPublisherTransport,
  MirrorConfirmationTransport,
  WebhookDeliveryTransport,
  X402ChallengeTransport,
} from "../transports";
import { expectedChallengeFields } from "../challenge";
import {
  PHASE6B_CARRIER_ACCOUNT,
  PHASE6B_FACILITATOR_FEE_PAYER,
  PHASE6B_HCS_TOPIC,
  PHASE6B_NETWORK,
  PHASE6B_PAYER_ACCOUNT,
  PHASE6B_USDC_AMOUNT_ATOMIC,
  PHASE6B_USDC_TOKEN,
} from "./constants";
import { Phase6bAttemptError } from "./attempt-store";

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

// ---------------------------------------------------------------------------
// Challenge (local, no network)
// ---------------------------------------------------------------------------

export class LocalX402ChallengeAdapter implements X402ChallengeTransport {
  async createChallenge(
    selected: SelectedPaymentOption,
  ): Promise<PaymentChallenge> {
    assertUsdcOnlySelection(selected);
    const expected = expectedChallengeFields(selected);
    return {
      x402Version: expected.x402Version,
      scheme: expected.scheme,
      network: expected.network,
      asset: expected.asset,
      amount: expected.amount,
      payTo: expected.payTo,
      resource: expected.resource,
      maxTimeoutSeconds: expected.maxTimeoutSeconds,
      description: DEMO_RESERVATION_FEE_NOTE,
    };
  }
}

export function assertUsdcOnlySelection(selected: SelectedPaymentOption): void {
  if (selected.optionId !== "USDC") {
    throw new Phase6bAttemptError(
      "Phase 6B live reservation is USDC-only — HBAR must not be selected",
      "USDC_ONLY",
    );
  }
  if (selected.asset !== PHASE6B_USDC_TOKEN) {
    throw new Phase6bAttemptError("Wrong USDC token", "WRONG_TOKEN");
  }
  if (selected.amountAtomic !== PHASE6B_USDC_AMOUNT_ATOMIC) {
    throw new Phase6bAttemptError("Wrong USDC amount", "WRONG_AMOUNT");
  }
  if (selected.payTo !== PHASE6B_CARRIER_ACCOUNT) {
    throw new Phase6bAttemptError("Wrong payment receiver", "WRONG_RECEIVER");
  }
  if (selected.payerAccount !== PHASE6B_PAYER_ACCOUNT) {
    throw new Phase6bAttemptError("Wrong payer account", "WRONG_PAYER");
  }
  if (selected.network !== PHASE6B_NETWORK) {
    throw new Phase6bAttemptError("Wrong network", "WRONG_NETWORK");
  }
}

// ---------------------------------------------------------------------------
// Facilitator (session-bound payment payload; never logs secrets)
// ---------------------------------------------------------------------------

/**
 * Holds a single signed payment session for verify/settle without persisting
 * the payload on the reservation record. Cleared after settle or on demand.
 */
export class LiveFacilitatorAdapter implements FacilitatorTransport {
  private session: {
    paymentPayload: PaymentPayload;
    requirement: PaymentRequirements;
    paymentPayloadHash: string;
    challengeHash: string;
  } | null = null;

  private readonly facilitatorUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly allowNetwork: boolean;
  verifyCallCount = 0;
  settleCallCount = 0;

  constructor(options: {
    facilitatorUrl: string;
    fetchImpl?: FetchLike;
    /** When false, verify/settle throw (dry-run). */
    allowNetwork: boolean;
  }) {
    this.facilitatorUrl = options.facilitatorUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.allowNetwork = options.allowNetwork;
  }

  /**
   * Bind the signed payload for exactly one verify+settle cycle.
   * Never logs or returns the payload.
   */
  bindPaymentSession(input: {
    paymentPayload: PaymentPayload;
    requirement: PaymentRequirements;
    paymentPayloadHash: string;
    challengeHash: string;
  }): void {
    this.session = {
      paymentPayload: input.paymentPayload,
      requirement: input.requirement,
      paymentPayloadHash: input.paymentPayloadHash,
      challengeHash: input.challengeHash,
    };
  }

  clearPaymentSession(): void {
    this.session = null;
  }

  async verify(input: {
    selected: SelectedPaymentOption;
    paymentPayloadHash: string;
    challengeHash: string;
  }): Promise<FacilitatorVerifyResult> {
    assertUsdcOnlySelection(input.selected);
    this.verifyCallCount += 1;
    if (!this.allowNetwork) {
      throw new Phase6bAttemptError(
        "Facilitator verify blocked in dry-run (no network settle path)",
        "DRY_RUN_BLOCKED",
      );
    }
    const session = this.requireSession(input);
    const { HTTPFacilitatorClient } = await import("@x402/core/server");
    const facilitator = new HTTPFacilitatorClient({
      url: this.facilitatorUrl,
    });
    try {
      const response = await facilitator.verify(
        session.paymentPayload,
        session.requirement,
      );
      return {
        isValid: response.isValid === true,
        ...(response.isValid
          ? {}
          : {
              invalidReason:
                response.invalidReason ??
                response.invalidMessage ??
                "verify_failed",
            }),
      };
    } catch (e) {
      return {
        isValid: false,
        invalidReason: e instanceof Error ? e.message : "verify_error",
      };
    }
  }

  async settle(input: {
    selected: SelectedPaymentOption;
    paymentPayloadHash: string;
    challengeHash: string;
  }): Promise<FacilitatorSettleResult> {
    assertUsdcOnlySelection(input.selected);
    this.settleCallCount += 1;
    if (!this.allowNetwork) {
      throw new Phase6bAttemptError(
        "Facilitator settle blocked in dry-run",
        "DRY_RUN_BLOCKED",
      );
    }
    const session = this.requireSession(input);
    const { HTTPFacilitatorClient } = await import("@x402/core/server");
    const facilitator = new HTTPFacilitatorClient({
      url: this.facilitatorUrl,
    });
    const response = await facilitator.settle(
      session.paymentPayload,
      session.requirement,
    );
    // Clear session after settle attempt (one-shot).
    this.clearPaymentSession();
    return {
      success: response.success === true,
      transactionId:
        typeof response.transaction === "string" && response.transaction.trim()
          ? response.transaction.trim()
          : null,
      network: PHASE6B_NETWORK,
      payerAccountId: PHASE6B_PAYER_ACCOUNT,
      ...(response.success
        ? {}
        : {
            errorReason:
              response.errorReason ??
              response.errorMessage ??
              "settle_failed",
          }),
    };
  }

  private requireSession(input: {
    paymentPayloadHash: string;
    challengeHash: string;
  }) {
    if (!this.session) {
      throw new Phase6bAttemptError(
        "No payment session bound for facilitator call",
        "NO_PAYMENT_SESSION",
      );
    }
    if (this.session.paymentPayloadHash !== input.paymentPayloadHash) {
      throw new Phase6bAttemptError(
        "Payment payload hash mismatch vs bound session",
        "PAYLOAD_HASH_MISMATCH",
      );
    }
    if (this.session.challengeHash !== input.challengeHash) {
      throw new Phase6bAttemptError(
        "Challenge hash mismatch vs bound session",
        "CHALLENGE_HASH_MISMATCH",
      );
    }
    return this.session;
  }
}

// ---------------------------------------------------------------------------
// Mirror transaction adapter
// ---------------------------------------------------------------------------

export class LiveMirrorTransactionAdapter
  implements MirrorConfirmationTransport
{
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options?: { baseUrl?: string; fetchImpl?: FetchLike }) {
    this.baseUrl = (
      options?.baseUrl ?? "https://testnet.mirrornode.hedera.com"
    ).replace(/\/$/, "");
    this.fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  }

  async getTransaction(transactionId: string): Promise<MirrorConfirmation> {
    // Mirror expects dash form: 0.0.x-sssssssss-nnnnnnnnn
    const mirrorId = toMirrorTransactionId(transactionId);
    const url = `${this.baseUrl}/api/v1/transactions/${encodeURIComponent(mirrorId)}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { accept: "application/json" },
      });
    } catch {
      throw new Phase6bAttemptError(
        "Mirror transaction fetch failed (network)",
        "MIRROR_NETWORK_ERROR",
      );
    }
    if (response.status === 404) {
      return emptyMirror(transactionId, "NOT_FOUND");
    }
    if (!response.ok) {
      throw new Phase6bAttemptError(
        `Mirror transaction HTTP ${response.status}`,
        "MIRROR_HTTP_ERROR",
      );
    }
    const payload = (await response.json()) as {
      transactions?: Array<Record<string, unknown>>;
    };
    const txs = payload.transactions ?? [];
    if (txs.length === 0) {
      return emptyMirror(transactionId, "NOT_FOUND");
    }
    const tx = txs[0]!;
    const result =
      typeof tx.result === "string" ? tx.result : null;
    const consensusRaw =
      typeof tx.consensus_timestamp === "string"
        ? tx.consensus_timestamp
        : null;
    let status: MirrorConfirmation["status"] = "PENDING";
    if (result === "SUCCESS") status = "SUCCESS";
    else if (result && result !== "SUCCESS") status = "FAILED";

    const hbarTransfers = mapHbarTransfers(tx.transfers);
    const tokenTransfers = mapTokenTransfers(tx.token_transfers);

    return {
      status,
      transactionId,
      consensusTimestamp: consensusRaw
        ? mirrorTimestampToUtcIso(consensusRaw)
        : null,
      result,
      hbarTransfers,
      tokenTransfers,
    };
  }
}

function emptyMirror(
  transactionId: string,
  status: "PENDING" | "NOT_FOUND",
): MirrorConfirmation {
  return {
    status,
    transactionId,
    consensusTimestamp: null,
    result: null,
    hbarTransfers: [],
    tokenTransfers: [],
  };
}

/** SDK form 0.0.x@s.n → Mirror form 0.0.x-s-n */
export function toMirrorTransactionId(sdkId: string): string {
  if (sdkId.includes("-") && !sdkId.includes("@")) return sdkId;
  const m = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(sdkId.trim());
  if (!m) return sdkId;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function mapHbarTransfers(raw: unknown): MirrorTransfer[] {
  if (!Array.isArray(raw)) return [];
  const out: MirrorTransfer[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const o = t as Record<string, unknown>;
    if (typeof o.account !== "string") continue;
    const amount =
      typeof o.amount === "number"
        ? String(o.amount)
        : typeof o.amount === "string"
          ? o.amount
          : null;
    if (amount === null) continue;
    out.push({ account: o.account, amount });
  }
  return out;
}

function mapTokenTransfers(raw: unknown): MirrorTransfer[] {
  if (!Array.isArray(raw)) return [];
  const out: MirrorTransfer[] = [];
  for (const group of raw) {
    if (!group || typeof group !== "object") continue;
    const g = group as Record<string, unknown>;
    const tokenId = typeof g.token_id === "string" ? g.token_id : null;
    const transfers = Array.isArray(g.transfers) ? g.transfers : [];
    for (const t of transfers) {
      if (!t || typeof t !== "object") continue;
      const o = t as Record<string, unknown>;
      if (typeof o.account !== "string") continue;
      const amount =
        typeof o.amount === "number"
          ? String(o.amount)
          : typeof o.amount === "string"
            ? o.amount
            : null;
      if (amount === null || !tokenId) continue;
      out.push({ account: o.account, amount, tokenId });
    }
  }
  // Flat form: [{token_id, account, amount}]
  if (out.length === 0) {
    for (const t of raw) {
      if (!t || typeof t !== "object") continue;
      const o = t as Record<string, unknown>;
      if (
        typeof o.token_id === "string" &&
        typeof o.account === "string" &&
        (typeof o.amount === "number" || typeof o.amount === "string")
      ) {
        out.push({
          account: o.account,
          amount: String(o.amount),
          tokenId: o.token_id,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// HCS publisher (submit only when allowNetwork)
// ---------------------------------------------------------------------------

export type HcsSdkSubmitResult = {
  transactionId: string;
  receiptStatus: string;
  envelopeHash: string;
};

/**
 * Real HCS publisher. Live path wires submitViaSdk to HcsTopicClient.submitMessage
 * + Mirror waitForEnvelopeHash. Topic creation is impossible through this adapter.
 */
export class LiveHcsPublisherAdapter implements HcsPublisherTransport {
  private readonly expectedTopicId: string;
  private readonly allowNetwork: boolean;
  /**
   * Performs TopicMessageSubmitTransaction against expectedTopicId only.
   * Must NOT create topics.
   */
  private readonly submitViaSdk:
    | ((input: {
        topicId: string;
        envelope: HcsEnvelope;
        exactBytes: Uint8Array;
      }) => Promise<{
        topicId: string;
        sequence: number;
        transactionId: string;
        consensusTimestamp: string;
      }>)
    | null;
  publishCallCount = 0;
  lastPublishedBytes: Uint8Array | null = null;

  constructor(options: {
    expectedTopicId?: string;
    allowNetwork: boolean;
    submitViaSdk?: (input: {
      topicId: string;
      envelope: HcsEnvelope;
      exactBytes: Uint8Array;
    }) => Promise<{
      topicId: string;
      sequence: number;
      transactionId: string;
      consensusTimestamp: string;
    }>;
  }) {
    this.expectedTopicId = options.expectedTopicId ?? PHASE6B_HCS_TOPIC;
    this.allowNetwork = options.allowNetwork;
    this.submitViaSdk = options.submitViaSdk ?? null;
  }

  async publish(envelope: HcsEnvelope): Promise<{
    topicId: string;
    sequence: number;
    transactionId: string;
    consensusTimestamp: string;
  }> {
    this.publishCallCount += 1;
    if (envelope.messageType !== "ROUTE_RESERVED") {
      throw new Phase6bAttemptError(
        "Publisher only accepts ROUTE_RESERVED",
        "HCS_MESSAGE_TYPE_MISMATCH",
      );
    }
    assertMessageSize(envelope);
    const exactBytes = serializeEnvelopeForSubmit(envelope);
    this.lastPublishedBytes = exactBytes;
    if (exactBytes.byteLength >= HCS_MAX_MESSAGE_BYTES) {
      throw new Phase6bAttemptError(
        `HCS envelope ${exactBytes.byteLength} exceeds ${HCS_MAX_MESSAGE_BYTES}`,
        "HCS_MESSAGE_TOO_LARGE",
      );
    }
    if (!this.allowNetwork || !this.submitViaSdk) {
      throw new Phase6bAttemptError(
        "HCS publish blocked (dry-run or SDK not wired)",
        "DRY_RUN_BLOCKED",
      );
    }
    const result = await this.submitViaSdk({
      topicId: this.expectedTopicId,
      envelope,
      exactBytes,
    });
    if (result.topicId !== this.expectedTopicId) {
      throw new Phase6bAttemptError(
        `Returned topic ${result.topicId} !== expected ${this.expectedTopicId}`,
        "HCS_TOPIC_MISMATCH",
      );
    }
    if (!result.transactionId?.trim()) {
      throw new Phase6bAttemptError(
        "HCS publish missing transactionId",
        "HCS_MISSING_TRANSACTION_ID",
      );
    }
    if (
      typeof result.sequence !== "number" ||
      !Number.isSafeInteger(result.sequence) ||
      result.sequence <= 0
    ) {
      throw new Phase6bAttemptError(
        "HCS publish missing/invalid sequence",
        "HCS_INVALID_SEQUENCE",
      );
    }
    if (!result.consensusTimestamp) {
      throw new Phase6bAttemptError(
        "HCS publish missing consensusTimestamp",
        "HCS_INVALID_CONSENSUS_TIMESTAMP",
      );
    }
    return result;
  }
}

/**
 * Factory wiring real SDK TopicMessageSubmitTransaction + Mirror for live
 * execution. Does not create topics. Call only under full Phase 6B live auth.
 */
export async function createSdkHcsSubmitViaSdk(options: {
  operatorAccountId: string;
  operatorPrivateKey: string;
  expectedTopicId?: string;
}): Promise<
  (input: {
    topicId: string;
    envelope: HcsEnvelope;
    exactBytes: Uint8Array;
  }) => Promise<{
    topicId: string;
    sequence: number;
    transactionId: string;
    consensusTimestamp: string;
  }>
> {
  const expectedTopicId = options.expectedTopicId ?? PHASE6B_HCS_TOPIC;
  const {
    AccountId,
    Client,
    Hbar,
    PrivateKey,
    Status,
    TopicId,
    TopicMessageSubmitTransaction,
  } = await import("@hiero-ledger/sdk");
  const { MirrorNodeClient } = await import("../../hcs/mirror-node-client");
  const { envelopeHash: envHash } = await import("../../hcs/message-envelope");

  let privateKey: InstanceType<typeof PrivateKey>;
  try {
    privateKey = PrivateKey.fromStringECDSA(options.operatorPrivateKey);
  } catch {
    throw new Phase6bAttemptError(
      "Failed to parse operator ECDSA key",
      "OPERATOR_KEY_INVALID",
    );
  }
  const accountId = AccountId.fromString(options.operatorAccountId);
  const client = Client.forTestnet();
  client.setOperator(accountId, privateKey);
  const mirror = new MirrorNodeClient();
  let submits = 0;

  return async ({ topicId, envelope, exactBytes }) => {
    if (topicId !== expectedTopicId) {
      throw new Phase6bAttemptError("SDK submit topic mismatch", "WRONG_TOPIC");
    }
    if (submits >= 1) {
      throw new Phase6bAttemptError(
        "HCS message submit budget exhausted (1)",
        "HCS_BUDGET_EXHAUSTED",
      );
    }
    submits += 1;
    // Use exact persisted bytes for the message body.
    const hash = envHash(envelope);
    const tx = new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(topicId))
      .setMessage(exactBytes)
      .setMaxTransactionFee(new Hbar(5));
    const response = await tx.execute(client);
    const receipt = await response.getReceipt(client);
    if (receipt.status !== Status.Success) {
      throw new Phase6bAttemptError(
        `TopicMessageSubmitTransaction failed: ${receipt.status.toString()}`,
        "HCS_SUBMIT_FAILED",
      );
    }
    const transactionId = response.transactionId.toString();
    const observed = await mirror.waitForEnvelopeHash(topicId, hash, {
      timeoutMs: 120_000,
      pollIntervalMs: 1500,
    });
    return {
      topicId,
      sequence: observed.sequence,
      transactionId,
      consensusTimestamp: observed.consensusTimestamp,
    };
  };
}

// ---------------------------------------------------------------------------
// HCS publication resolver (Mirror read-only)
// ---------------------------------------------------------------------------

export class LiveHcsPublicationResolver implements HcsPublicationResolver {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(options?: { baseUrl?: string; fetchImpl?: FetchLike }) {
    this.baseUrl = (
      options?.baseUrl ?? "https://testnet.mirrornode.hedera.com"
    ).replace(/\/$/, "");
    this.fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  }

  async resolvePublication(input: {
    topicId: string;
    envelopeHash: string;
    messageType: "ROUTE_RESERVED";
    reservationId: string;
  }): Promise<HcsPublicationResolveResult> {
    if (input.topicId !== PHASE6B_HCS_TOPIC) {
      throw new Phase6bAttemptError("Resolver topic mismatch", "WRONG_TOPIC");
    }
    const url = `${this.baseUrl}/api/v1/topics/${encodeURIComponent(input.topicId)}/messages?order=asc&limit=100`;
    const response = await this.fetchImpl(url, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return { status: "AMBIGUOUS" };
    }
    const payload = (await response.json()) as {
      messages?: Array<Record<string, unknown>>;
    };
    const matches: HcsPublicationResolveResult[] = [];
    for (const raw of payload.messages ?? []) {
      try {
        const b64 = typeof raw.message === "string" ? raw.message : null;
        if (!b64) continue;
        const { decodeHcsEnvelopeFromBase64 } = await import(
          "../../hcs/message-envelope"
        );
        const env = decodeHcsEnvelopeFromBase64(b64);
        if (env.messageType !== "ROUTE_RESERVED") continue;
        const hash = envelopeHash(env);
        if (hash !== input.envelopeHash) continue;
        const seq =
          typeof raw.sequence_number === "number"
            ? raw.sequence_number
            : Number(raw.sequence_number);
        const ts =
          typeof raw.consensus_timestamp === "string"
            ? mirrorTimestampToUtcIso(raw.consensus_timestamp)
            : null;
        if (!Number.isSafeInteger(seq) || seq <= 0 || !ts) continue;
        matches.push({
          status: "FOUND",
          topicId: input.topicId,
          sequence: seq,
          transactionId: null,
          consensusTimestamp: ts,
          envelopeHash: hash,
        });
      } catch {
        // skip undecodable
      }
    }
    if (matches.length === 0) return { status: "NOT_FOUND_CONCLUSIVE" };
    if (matches.length > 1) return { status: "AMBIGUOUS" };
    return matches[0]!;
  }
}

// ---------------------------------------------------------------------------
// Local webhook demo transport (no external HTTP)
// ---------------------------------------------------------------------------

export class LocalDemoWebhookTransport implements WebhookDeliveryTransport {
  readonly deliveries: Array<{
    recipient: "shipper" | "carrier";
    eventId: string;
    payloadHash: string;
  }> = [];

  async deliver(
    recipient: "shipper" | "carrier",
    webhook: SignedWebhook,
  ): Promise<{ ok: boolean; error?: string }> {
    this.deliveries.push({
      recipient,
      eventId: webhook.headers["X-RouteGuard-Event-Id"],
      payloadHash: webhook.payloadHash,
    });
    return { ok: true };
  }
}

export { PHASE6B_FACILITATOR_FEE_PAYER };
