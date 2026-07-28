/**
 * Public HCS ROUTE_RESERVED evidence built on the shared HCS message system.
 *
 * ROUTE_RESERVED is a first-class member of the shared HcsEnvelope union. This
 * module only maps a RouteReservedRecord to the compact public payload and
 * delegates envelope construction, canonical payloadHash verification, and the
 * standard single-message byte-limit check to src/hcs/message-envelope.
 */

import { canonicalSha256 } from "../domain/canonical-hash";
import { isUtcIsoTimestamp } from "../domain/time";
import {
  assertNoProhibitedRouteReservedFields,
  createRouteReservedEnvelope,
  decodeHcsEnvelope,
  encodeHcsEnvelopeUtf8,
  envelopeHash,
  PROHIBITED_ROUTE_RESERVED_PAYLOAD_FIELDS,
} from "../hcs/message-envelope";
import {
  HCS_MAX_MESSAGE_BYTES,
  ROUTE_RESERVED_EVIDENCE_VERSION,
  type RouteReservedEnvelope,
  type RouteReservedPayload,
} from "../hcs/types";
import { ReservationError, type RouteReservedRecord } from "./types";

/** Backwards-compatible re-exports. */
export const PROHIBITED_ROUTE_RESERVED_FIELDS =
  PROHIBITED_ROUTE_RESERVED_PAYLOAD_FIELDS;
export type RouteReservedHcsPayload = RouteReservedPayload;
export type RouteReservedHcsEnvelope = RouteReservedEnvelope;

/**
 * Compact public payload. `reservationRecordHash` is the master commitment to
 * the full RouteReservedRecord (which binds tenderHash, winningBidHash,
 * decisionManifestHash, evaluatedBidSetHash and every payment field), so the
 * omitted hashes stay cryptographically committed while the envelope fits one
 * standard HCS message. tenderId/tenderVersion are carried in the shell.
 */
export function buildRouteReservedPayload(
  record: RouteReservedRecord,
  carrierId: string,
): RouteReservedPayload {
  return {
    reservationId: record.reservationId,
    winningBidId: record.winningBidId,
    carrierId,
    carrierAccount: record.carrierAccount,
    selectedOptionId: record.selectedOptionId,
    paymentAsset: record.paymentAsset,
    paymentAmountAtomic: record.paymentAmountAtomic,
    payerAccount: record.payerAccount,
    paymentTransactionId: record.transactionId,
    paymentConsensusTimestamp: record.consensusTimestamp,
    reservationRecordHash: record.reservationRecordHash,
    closeBarrierSequence: record.closeBarrierSequence,
    reservationEvidenceVersion: ROUTE_RESERVED_EVIDENCE_VERSION,
  };
}

export function createRouteReservedHcsEnvelope(input: {
  runId: string;
  tenderId: string;
  tenderVersion: number;
  tenderHash: string;
  createdAt: string;
  payload: RouteReservedPayload;
}): RouteReservedHcsEnvelope {
  return createRouteReservedEnvelope(input);
}

export function measureRouteReservedEnvelope(
  envelope: RouteReservedHcsEnvelope,
): number {
  return encodeHcsEnvelopeUtf8(envelope).byteLength;
}

export function routeReservedEnvelopeHash(
  envelope: RouteReservedHcsEnvelope,
): string {
  return envelopeHash(envelope);
}

export function decodeRouteReservedEnvelope(
  raw: unknown,
): RouteReservedHcsEnvelope {
  const decoded = decodeHcsEnvelope(raw);
  if (decoded.messageType !== "ROUTE_RESERVED") {
    throw new Error(
      `Expected ROUTE_RESERVED envelope, got ${decoded.messageType}`,
    );
  }
  return decoded;
}

/** Exposed for callers that need the payload commitment hash directly. */
export function routeReservedPayloadHash(payload: RouteReservedPayload): string {
  assertNoProhibitedRouteReservedFields(
    payload as unknown as Record<string, unknown>,
  );
  return canonicalSha256(payload);
}

/**
 * Pre-publish checks for a durable HCS publication claim. Fails closed if the
 * envelope is invalid, oversized, mis-bound to the reservation topic, or does
 * not match the durable RouteReservedRecord commitment.
 */
export function assertClaimableRouteReservedPublication(input: {
  envelope: RouteReservedHcsEnvelope;
  expectedTopicId: string;
  reservation: RouteReservedRecord;
  reservationHcsTopicId: string;
}): {
  envelopeHash: string;
  encodedByteCount: number;
} {
  const { envelope, expectedTopicId, reservation, reservationHcsTopicId } =
    input;

  if (envelope.messageType !== "ROUTE_RESERVED") {
    throw new ReservationError(
      "HCS_MESSAGE_TYPE_MISMATCH",
      `Expected ROUTE_RESERVED, got ${envelope.messageType}`,
    );
  }
  if (expectedTopicId !== reservationHcsTopicId) {
    throw new ReservationError(
      "HCS_TOPIC_MISMATCH",
      `expectedTopicId ${expectedTopicId} !== record.hcsTopicId ${reservationHcsTopicId}`,
    );
  }
  if (expectedTopicId !== reservation.hcsAuctionTopicId) {
    throw new ReservationError(
      "HCS_TOPIC_MISMATCH",
      `expectedTopicId ${expectedTopicId} !== routeReserved.hcsAuctionTopicId ${reservation.hcsAuctionTopicId}`,
    );
  }
  if (
    envelope.payload.reservationRecordHash !== reservation.reservationRecordHash
  ) {
    throw new ReservationError(
      "HCS_RESERVATION_RECORD_HASH_MISMATCH",
      "envelope reservationRecordHash does not match durable RouteReservedRecord",
    );
  }
  // Round-trip through shared decoder to re-verify payloadHash and schema.
  decodeRouteReservedEnvelope(JSON.parse(JSON.stringify(envelope)));

  const bytes = encodeHcsEnvelopeUtf8(envelope);
  if (bytes.byteLength >= HCS_MAX_MESSAGE_BYTES) {
    throw new ReservationError(
      "HCS_MESSAGE_TOO_LARGE",
      `ROUTE_RESERVED envelope is ${bytes.byteLength} bytes (limit ${HCS_MAX_MESSAGE_BYTES})`,
    );
  }

  return {
    envelopeHash: routeReservedEnvelopeHash(envelope),
    encodedByteCount: bytes.byteLength,
  };
}

/** Authoritative publication result from publisher or resolver — fail closed. */
export function assertValidHcsPublicationResult(input: {
  topicId: unknown;
  expectedTopicId: string;
  transactionId: unknown;
  sequence: unknown;
  consensusTimestamp: unknown;
  envelopeHash?: unknown;
  expectedEnvelopeHash?: string;
  /** When true, transactionId may be null (resolver FOUND without tx id). */
  allowMissingTransactionId?: boolean;
}): {
  topicId: string;
  transactionId: string | null;
  sequence: number;
  consensusTimestamp: string;
} {
  if (
    typeof input.topicId !== "string" ||
    input.topicId.length === 0 ||
    input.topicId !== input.expectedTopicId
  ) {
    throw new ReservationError(
      "HCS_TOPIC_MISMATCH",
      `Returned topicId must equal expectedTopicId ${input.expectedTopicId}`,
    );
  }

  let transactionId: string | null;
  if (
    typeof input.transactionId === "string" &&
    input.transactionId.length > 0
  ) {
    transactionId = input.transactionId;
  } else if (input.allowMissingTransactionId && input.transactionId == null) {
    transactionId = null;
  } else {
    throw new ReservationError(
      "HCS_MISSING_TRANSACTION_ID",
      "HCS publication result requires a non-empty transactionId",
    );
  }

  if (
    typeof input.sequence !== "number" ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence <= 0
  ) {
    throw new ReservationError(
      "HCS_INVALID_SEQUENCE",
      "HCS publication sequence must be a positive safe integer",
    );
  }

  if (
    typeof input.consensusTimestamp !== "string" ||
    !isUtcIsoTimestamp(input.consensusTimestamp)
  ) {
    throw new ReservationError(
      "HCS_INVALID_CONSENSUS_TIMESTAMP",
      "HCS publication consensusTimestamp must be valid UTC",
    );
  }

  if (input.expectedEnvelopeHash !== undefined) {
    if (
      typeof input.envelopeHash !== "string" ||
      input.envelopeHash !== input.expectedEnvelopeHash
    ) {
      throw new ReservationError(
        "HCS_ENVELOPE_HASH_MISMATCH",
        "Resolved envelopeHash does not match the durable publication claim",
      );
    }
  }

  return {
    topicId: input.topicId,
    transactionId,
    sequence: input.sequence,
    consensusTimestamp: input.consensusTimestamp,
  };
}
