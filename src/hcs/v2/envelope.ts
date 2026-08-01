/**
 * HCS 2.0 envelope builders, validation, size and privacy checks.
 * Offline only — no HCS submission.
 */

import { Buffer } from "node:buffer";

import {
  assertSha256Hash,
  canonicalize,
  canonicalSha256,
} from "../../domain/canonical-hash";
import { isSafePositiveInteger } from "../../domain/money";
import { isValidHederaAccountId } from "../../domain/payment-option";
import { isUtcIsoTimestamp } from "../../domain/time";
import {
  isNonNegativeAtomicString,
  isPositiveAtomicString,
} from "../../v2/access/fee";
import { assertHcsV2PublicSafe } from "./privacy";
import {
  HCS_V2_MAX_MESSAGE_BYTES,
  HCS_V2_MAX_ID_CHARS,
  HCS_V2_DISPUTE_REASON_CODES,
  HCS_V2_MESSAGE_TYPES,
  HCS_V2_SCHEMA_VERSION,
  type HcsV2Envelope,
  type HcsV2MessageType,
  type HcsV2Payload,
} from "./types";

export type BuildHcsV2EnvelopeInput = {
  readonly messageType: HcsV2MessageType;
  readonly tenderId: string;
  readonly tenderVersion: number;
  readonly tenderHash: string;
  readonly createdAt: string;
  readonly payload: HcsV2Payload;
};

function assertHash(label: string, value: string): void {
  try {
    assertSha256Hash(value);
  } catch {
    throw new Error(`${label} must be sha256:<64 hex>`);
  }
}

function assertId(label: string, value: string): void {
  if (
    !value ||
    value.length > HCS_V2_MAX_ID_CHARS ||
    !/^[A-Za-z0-9._:@/-]+$/.test(value)
  ) {
    throw new Error(
      `${label} must be a structured public identifier <= ${HCS_V2_MAX_ID_CHARS} chars`,
    );
  }
}

const PAYLOAD_KEYS: Readonly<Record<HcsV2MessageType, readonly string[]>> = {
  TENDER_OPENED: [
    "accessPaymentTxId",
    "maxBudgetAtomic",
    "auctionEndsAt",
    "selectionPolicy",
  ],
  BID_COMMITMENT: ["bidId", "carrierId", "bidHash", "accessPaymentTxId"],
  AUCTION_CLOSE_BARRIER: [
    "barrierId",
    "auctionEndsAt",
    "expectedCommitmentCount",
    "bidSetHash",
  ],
  WINNER_SELECTED: [
    "winningBidId",
    "carrierId",
    "winningAmountAtomic",
    "decisionManifestHash",
  ],
  WINNER_ALLOCATED: [
    "winningBidId",
    "winnerAccount",
    "winningAmountAtomic",
    "excessRefundAtomic",
    "allocateTxId",
    "refundTxId",
    "decisionManifestHash",
  ],
  ROUTE_RESERVED: [
    "reservationId",
    "winningBidId",
    "carrierAccount",
    "lockedAmountAtomic",
    "allocateTxId",
    "reservationRecordHash",
  ],
  POD_SUBMITTED: [
    "podId",
    "podVersion",
    "contentHash",
    "ciphertextHash",
    "sizeBytes",
  ],
  POD_ADVISORY_ANCHORED: ["podId", "reportHash", "binding"],
  POD_REVIEW_ACTION: ["podId", "action", "reviewDeadlineAt"],
  POD_DEEMED_ACCEPTED: ["podId", "reviewDeadlineAt", "tickActionId"],
  DISPUTE_OPENED: ["disputeId", "podId", "reasonCode"],
  REFEREE_RESOLUTION: [
    "disputeId",
    "podId",
    "resolution",
    "releaseAmountAtomic",
    "refundAmountAtomic",
    "resolutionHash",
  ],
  ESCROW_RELEASED: ["releaseTxId", "amountAtomic", "winnerAccount"],
  ESCROW_PARTIAL: [
    "releaseTxId",
    "refundTxId",
    "releaseAmountAtomic",
    "refundAmountAtomic",
  ],
  ESCROW_REFUNDED: ["refundTxId", "amountAtomic", "shipperAccount"],
  TENDER_COMPLETED: ["finalState", "completionRef"],
};

function assertExactPayloadKeys(
  messageType: HcsV2MessageType,
  payload: Record<string, unknown>,
): void {
  const expected = [...PAYLOAD_KEYS[messageType]].sort();
  const actual = Object.keys(payload).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${messageType} payload contains missing or unsupported fields`);
  }
}

function validatePayload(
  messageType: HcsV2MessageType,
  payload: HcsV2Payload,
): void {
  const p = payload as Record<string, unknown>;
  assertExactPayloadKeys(messageType, p);
  switch (messageType) {
    case "TENDER_OPENED": {
      assertId("accessPaymentTxId", String(p.accessPaymentTxId));
      if (!isPositiveAtomicString(String(p.maxBudgetAtomic))) {
        throw new Error("maxBudgetAtomic invalid");
      }
      if (!isUtcIsoTimestamp(String(p.auctionEndsAt))) {
        throw new Error("auctionEndsAt invalid");
      }
      if (p.selectionPolicy !== "LOWEST_QUALIFIED_PRICE_V1") {
        throw new Error("selectionPolicy invalid");
      }
      break;
    }
    case "BID_COMMITMENT": {
      assertId("bidId", String(p.bidId));
      assertId("carrierId", String(p.carrierId));
      assertHash("bidHash", String(p.bidHash));
      assertId("accessPaymentTxId", String(p.accessPaymentTxId));
      break;
    }
    case "AUCTION_CLOSE_BARRIER": {
      assertId("barrierId", String(p.barrierId));
      if (!isUtcIsoTimestamp(String(p.auctionEndsAt))) {
        throw new Error("auctionEndsAt invalid");
      }
      if (!isSafePositiveInteger(p.expectedCommitmentCount)) {
        throw new Error("expectedCommitmentCount invalid");
      }
      assertHash("bidSetHash", String(p.bidSetHash));
      break;
    }
    case "WINNER_SELECTED": {
      assertId("winningBidId", String(p.winningBidId));
      assertId("carrierId", String(p.carrierId));
      if (!isPositiveAtomicString(String(p.winningAmountAtomic))) {
        throw new Error("winningAmountAtomic invalid");
      }
      assertHash("decisionManifestHash", String(p.decisionManifestHash));
      break;
    }
    case "WINNER_ALLOCATED": {
      assertId("winningBidId", String(p.winningBidId));
      if (!isValidHederaAccountId(String(p.winnerAccount))) {
        throw new Error("winnerAccount invalid");
      }
      if (!isPositiveAtomicString(String(p.winningAmountAtomic))) {
        throw new Error("winningAmountAtomic invalid");
      }
      if (!isNonNegativeAtomicString(String(p.excessRefundAtomic))) {
        throw new Error("excessRefundAtomic invalid");
      }
      assertId("allocateTxId", String(p.allocateTxId));
      assertHash("decisionManifestHash", String(p.decisionManifestHash));
      break;
    }
    case "ROUTE_RESERVED": {
      assertId("reservationId", String(p.reservationId));
      assertId("winningBidId", String(p.winningBidId));
      if (!isValidHederaAccountId(String(p.carrierAccount))) {
        throw new Error("carrierAccount invalid");
      }
      if (!isPositiveAtomicString(String(p.lockedAmountAtomic))) {
        throw new Error("lockedAmountAtomic invalid");
      }
      assertId("allocateTxId", String(p.allocateTxId));
      assertHash("reservationRecordHash", String(p.reservationRecordHash));
      break;
    }
    case "POD_SUBMITTED": {
      assertId("podId", String(p.podId));
      if (!isSafePositiveInteger(p.podVersion)) {
        throw new Error("podVersion invalid");
      }
      assertHash("contentHash", String(p.contentHash));
      assertHash("ciphertextHash", String(p.ciphertextHash));
      if (!isSafePositiveInteger(p.sizeBytes)) {
        throw new Error("sizeBytes invalid");
      }
      break;
    }
    case "POD_ADVISORY_ANCHORED": {
      assertId("podId", String(p.podId));
      assertHash("reportHash", String(p.reportHash));
      if (p.binding !== "NON_BINDING_ADVISORY") {
        throw new Error("binding must be NON_BINDING_ADVISORY");
      }
      break;
    }
    case "POD_REVIEW_ACTION": {
      assertId("podId", String(p.podId));
      if (
        p.action !== "ACCEPT" &&
        p.action !== "REQUEST_CORRECTION" &&
        p.action !== "REJECT_DISPUTE"
      ) {
        throw new Error("action invalid");
      }
      if (!isUtcIsoTimestamp(String(p.reviewDeadlineAt))) {
        throw new Error("reviewDeadlineAt invalid");
      }
      break;
    }
    case "POD_DEEMED_ACCEPTED": {
      assertId("podId", String(p.podId));
      if (!isUtcIsoTimestamp(String(p.reviewDeadlineAt))) {
        throw new Error("reviewDeadlineAt invalid");
      }
      assertId("tickActionId", String(p.tickActionId));
      break;
    }
    case "DISPUTE_OPENED": {
      assertId("disputeId", String(p.disputeId));
      assertId("podId", String(p.podId));
      if (
        typeof p.reasonCode !== "string" ||
        !(HCS_V2_DISPUTE_REASON_CODES as readonly string[]).includes(
          p.reasonCode,
        )
      ) {
        throw new Error("reasonCode must be a structured dispute reason code");
      }
      break;
    }
    case "REFEREE_RESOLUTION": {
      assertId("disputeId", String(p.disputeId));
      assertId("podId", String(p.podId));
      if (
        p.resolution !== "RELEASE_FULL" &&
        p.resolution !== "REFUND_FULL" &&
        p.resolution !== "PARTIAL"
      ) {
        throw new Error("resolution invalid");
      }
      if (!isNonNegativeAtomicString(String(p.releaseAmountAtomic))) {
        throw new Error("releaseAmountAtomic invalid");
      }
      if (!isNonNegativeAtomicString(String(p.refundAmountAtomic))) {
        throw new Error("refundAmountAtomic invalid");
      }
      assertHash("resolutionHash", String(p.resolutionHash));
      break;
    }
    case "ESCROW_RELEASED": {
      assertId("releaseTxId", String(p.releaseTxId));
      if (!isPositiveAtomicString(String(p.amountAtomic))) {
        throw new Error("amountAtomic invalid");
      }
      if (!isValidHederaAccountId(String(p.winnerAccount))) {
        throw new Error("winnerAccount invalid");
      }
      break;
    }
    case "ESCROW_PARTIAL": {
      assertId("releaseTxId", String(p.releaseTxId));
      assertId("refundTxId", String(p.refundTxId));
      if (!isNonNegativeAtomicString(String(p.releaseAmountAtomic))) {
        throw new Error("releaseAmountAtomic invalid");
      }
      if (!isNonNegativeAtomicString(String(p.refundAmountAtomic))) {
        throw new Error("refundAmountAtomic invalid");
      }
      break;
    }
    case "ESCROW_REFUNDED": {
      assertId("refundTxId", String(p.refundTxId));
      if (!isPositiveAtomicString(String(p.amountAtomic))) {
        throw new Error("amountAtomic invalid");
      }
      if (!isValidHederaAccountId(String(p.shipperAccount))) {
        throw new Error("shipperAccount invalid");
      }
      break;
    }
    case "TENDER_COMPLETED": {
      assertId("completionRef", String(p.completionRef));
      break;
    }
    default: {
      const _x: never = messageType;
      void _x;
      throw new Error("unknown message type");
    }
  }
}

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function serializeHcsV2Envelope(envelope: HcsV2Envelope): string {
  return canonicalize(envelope);
}

export function assertHcsV2EnvelopeWithinLimit(envelope: HcsV2Envelope): void {
  const bytes = utf8ByteLength(serializeHcsV2Envelope(envelope));
  if (bytes >= HCS_V2_MAX_MESSAGE_BYTES) {
    throw new Error(
      `HCS v2 envelope is ${bytes} bytes; must be < ${HCS_V2_MAX_MESSAGE_BYTES}`,
    );
  }
}

export function buildHcsV2Envelope(
  input: BuildHcsV2EnvelopeInput,
): HcsV2Envelope {
  if (!(HCS_V2_MESSAGE_TYPES as readonly string[]).includes(input.messageType)) {
    throw new Error(`unsupported HCS v2 messageType: ${input.messageType}`);
  }
  assertId("tenderId", input.tenderId);
  if (!isSafePositiveInteger(input.tenderVersion)) {
    throw new Error("tenderVersion must be a positive safe integer");
  }
  assertHash("tenderHash", input.tenderHash);
  if (!isUtcIsoTimestamp(input.createdAt)) {
    throw new Error("createdAt must be UTC ISO");
  }

  assertHcsV2PublicSafe(input.payload);
  validatePayload(input.messageType, input.payload);

  const payloadHash = canonicalSha256(input.payload);
  const envelope: HcsV2Envelope = {
    schemaVersion: HCS_V2_SCHEMA_VERSION,
    messageType: input.messageType,
    tenderId: input.tenderId,
    tenderVersion: input.tenderVersion,
    tenderHash: input.tenderHash,
    createdAt: input.createdAt,
    payloadHash,
    payload: input.payload,
  };

  assertHcsV2PublicSafe(envelope);
  assertHcsV2EnvelopeWithinLimit(envelope);
  return envelope;
}

export function parseHcsV2Envelope(input: unknown): HcsV2Envelope {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("envelope must be an object");
  }
  const obj = input as Record<string, unknown>;
  assertHcsV2PublicSafe(obj);
  if (obj.schemaVersion !== HCS_V2_SCHEMA_VERSION) {
    throw new Error(`schemaVersion must be ${HCS_V2_SCHEMA_VERSION}`);
  }
  if (
    typeof obj.messageType !== "string" ||
    !(HCS_V2_MESSAGE_TYPES as readonly string[]).includes(obj.messageType)
  ) {
    throw new Error("invalid messageType");
  }
  const rebuilt = buildHcsV2Envelope({
    messageType: obj.messageType as HcsV2MessageType,
    tenderId: String(obj.tenderId),
    tenderVersion: Number(obj.tenderVersion),
    tenderHash: String(obj.tenderHash),
    createdAt: String(obj.createdAt),
    payload: obj.payload as HcsV2Payload,
  });
  if (typeof obj.payloadHash === "string" && obj.payloadHash !== rebuilt.payloadHash) {
    throw new Error("payloadHash mismatch");
  }
  return rebuilt;
}
