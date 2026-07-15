/**
 * Signed ROUTE_RESERVED webhooks — application-layer ECDSA.
 * Signature input is explicitly defined and canonical.
 */

import { canonicalSha256 } from "../domain/canonical-hash";
import {
  signCanonicalPayload,
  verifyCanonicalPayload,
} from "../domain/signature";
import { isUtcIsoTimestamp } from "../domain/time";
import {
  ROUTE_RESERVED_EVENT_TYPE,
  ReservationError,
  WEBHOOK_SIGNATURE_VERSION,
  type RouteReservedRecord,
  type SignedWebhook,
  type WebhookEventPayload,
} from "./types";

/**
 * Canonical signature payload for webhooks.
 * Headers alone are not signed; signed body is:
 * {
 *   eventId, timestamp (header value), signatureVersion, payload
 * }
 */
export type WebhookSignatureInput = {
  readonly eventId: string;
  readonly timestamp: string;
  readonly signatureVersion: typeof WEBHOOK_SIGNATURE_VERSION;
  readonly payload: WebhookEventPayload;
};

export function buildWebhookSignatureInput(
  eventId: string,
  timestamp: string,
  payload: WebhookEventPayload,
): WebhookSignatureInput {
  return {
    eventId,
    timestamp,
    signatureVersion: WEBHOOK_SIGNATURE_VERSION,
    payload,
  };
}

export function createRouteReservedWebhookPayload(input: {
  eventId: string;
  reservation: {
    reservationId: string;
    tenderId: string;
    winningBidId: string;
  };
  carrierAccount: string;
  selectedOptionId: RouteReservedRecord["selectedOptionId"];
  paymentAsset: string;
  paymentAmountAtomic: string;
  transactionId: string;
  consensusTimestamp: string;
  reservationRecordHash: string;
  emittedAt: string;
}): WebhookEventPayload {
  if (!isUtcIsoTimestamp(input.emittedAt)) {
    throw new ReservationError("INVALID_TIMESTAMP", "emittedAt must be UTC");
  }
  return Object.freeze({
    eventId: input.eventId,
    eventType: ROUTE_RESERVED_EVENT_TYPE,
    reservationId: input.reservation.reservationId,
    tenderId: input.reservation.tenderId,
    winningBidId: input.reservation.winningBidId,
    carrierAccount: input.carrierAccount,
    selectedOptionId: input.selectedOptionId,
    paymentAsset: input.paymentAsset,
    paymentAmountAtomic: input.paymentAmountAtomic,
    transactionId: input.transactionId,
    consensusTimestamp: input.consensusTimestamp,
    reservationRecordHash: input.reservationRecordHash,
    emittedAt: input.emittedAt,
  });
}

export function signWebhook(
  payload: WebhookEventPayload,
  privateKeyHex: string,
  timestamp: string = payload.emittedAt,
): SignedWebhook {
  if (!isUtcIsoTimestamp(timestamp)) {
    throw new ReservationError("INVALID_TIMESTAMP", "timestamp must be UTC");
  }
  const sigInput = buildWebhookSignatureInput(
    payload.eventId,
    timestamp,
    payload,
  );
  const signature = signCanonicalPayload(sigInput, privateKeyHex);
  const payloadHash = canonicalSha256(payload);

  return {
    payload,
    payloadHash,
    headers: {
      "X-RouteGuard-Event-Id": payload.eventId,
      "X-RouteGuard-Timestamp": timestamp,
      "X-RouteGuard-Signature": signature,
      "X-RouteGuard-Signature-Version": WEBHOOK_SIGNATURE_VERSION,
    },
  };
}

export function verifyWebhook(
  webhook: SignedWebhook,
  publicKeyHex: string,
): boolean {
  const { headers, payload } = webhook;
  if (headers["X-RouteGuard-Event-Id"] !== payload.eventId) {
    return false;
  }
  if (headers["X-RouteGuard-Signature-Version"] !== WEBHOOK_SIGNATURE_VERSION) {
    return false;
  }
  if (canonicalSha256(payload) !== webhook.payloadHash) {
    return false;
  }
  const sigInput = buildWebhookSignatureInput(
    headers["X-RouteGuard-Event-Id"],
    headers["X-RouteGuard-Timestamp"],
    payload,
  );
  return verifyCanonicalPayload(
    sigInput,
    headers["X-RouteGuard-Signature"],
    publicKeyHex,
  );
}

/** Stable event IDs for retries — same semantic event. */
export function reservationWebhookEventId(
  reservationId: string,
  recipient: "shipper" | "carrier",
): string {
  return `evt-route-reserved-${reservationId}-${recipient}`;
}
