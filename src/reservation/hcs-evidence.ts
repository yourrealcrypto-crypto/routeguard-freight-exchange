/**
 * Public HCS ROUTE_RESERVED evidence — hashes and public identifiers only.
 */

import { z } from "zod";

import {
  assertSha256Hash,
  canonicalize,
  canonicalSha256,
} from "../domain/canonical-hash";
import { isSafePositiveInteger } from "../domain/money";
import { isValidHederaAccountId } from "../domain/payment-option";
import { isUtcIsoTimestamp } from "../domain/time";
import { HcsEnvelopeError } from "../hcs/message-envelope";
import { HCS_MAX_MESSAGE_BYTES, HCS_SCHEMA_VERSION } from "../hcs/types";
import {
  RESERVATION_EVIDENCE_VERSION,
  RESERVATION_NETWORK,
  ReservationError,
  type ReservationOptionId,
  type RouteReservedRecord,
} from "./types";

export const PROHIBITED_ROUTE_RESERVED_FIELDS = [
  "freightPriceCents",
  "commitmentSalt",
  "salt",
  "nonce",
  "signature",
  "signedBid",
  "privateKey",
  "paymentPayload",
  "signedPaymentPayload",
  "fullBid",
] as const;

export type RouteReservedHcsPayload = {
  reservationId: string;
  tenderId: string;
  tenderVersion: number;
  winningBidId: string;
  winningBidHash: string;
  carrierId: string;
  carrierAccount: string;
  selectedOptionId: ReservationOptionId;
  paymentNetwork: typeof RESERVATION_NETWORK;
  paymentAsset: string;
  paymentAmountAtomic: string;
  payerAccount: string;
  paymentTransactionId: string;
  paymentConsensusTimestamp: string;
  reservationRecordHash: string;
  decisionManifestHash: string;
  closeBarrierSequence: number;
  reservationEvidenceVersion: typeof RESERVATION_EVIDENCE_VERSION;
};

const RouteReservedPayloadSchema = z
  .object({
    reservationId: z.string().min(1).max(128),
    tenderId: z.string().min(1).max(128),
    tenderVersion: z.number(),
    winningBidId: z.string().min(1).max(128),
    winningBidHash: z.string().min(1).max(80),
    carrierId: z.string().min(1).max(128),
    carrierAccount: z.string().min(1).max(64),
    selectedOptionId: z.enum(["USDC", "HBAR"]),
    paymentNetwork: z.literal(RESERVATION_NETWORK),
    paymentAsset: z.string().min(1).max(64),
    paymentAmountAtomic: z.string().min(1).max(32),
    payerAccount: z.string().min(1).max(64),
    paymentTransactionId: z.string().min(1).max(128),
    paymentConsensusTimestamp: z.string().min(1).max(64),
    reservationRecordHash: z.string().min(1).max(80),
    decisionManifestHash: z.string().min(1).max(80),
    closeBarrierSequence: z.number(),
    reservationEvidenceVersion: z.literal(RESERVATION_EVIDENCE_VERSION),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!isSafePositiveInteger(value.tenderVersion)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "tenderVersion must be positive safe integer",
        path: ["tenderVersion"],
      });
    }
    if (!isSafePositiveInteger(value.closeBarrierSequence)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "closeBarrierSequence must be positive safe integer",
        path: ["closeBarrierSequence"],
      });
    }
    for (const [field, hash] of [
      ["winningBidHash", value.winningBidHash],
      ["reservationRecordHash", value.reservationRecordHash],
      ["decisionManifestHash", value.decisionManifestHash],
    ] as const) {
      try {
        assertSha256Hash(hash);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} must be sha256 hash`,
          path: [field],
        });
      }
    }
    if (!isValidHederaAccountId(value.carrierAccount)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "carrierAccount invalid",
        path: ["carrierAccount"],
      });
    }
    if (!isValidHederaAccountId(value.payerAccount)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "payerAccount invalid",
        path: ["payerAccount"],
      });
    }
    if (!isUtcIsoTimestamp(value.paymentConsensusTimestamp)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "paymentConsensusTimestamp must be UTC",
        path: ["paymentConsensusTimestamp"],
      });
    }
  });

export type RouteReservedHcsEnvelope = {
  schemaVersion: typeof HCS_SCHEMA_VERSION;
  messageType: "ROUTE_RESERVED";
  runId: string;
  tenderId: string;
  tenderVersion: number;
  tenderHash: string;
  createdAt: string;
  payloadHash: string;
  payload: RouteReservedHcsPayload;
};

export function buildRouteReservedPayload(
  record: RouteReservedRecord,
  carrierId: string,
): RouteReservedHcsPayload {
  return {
    reservationId: record.reservationId,
    tenderId: record.tenderId,
    tenderVersion: record.tenderVersion,
    winningBidId: record.winningBidId,
    winningBidHash: record.winningBidHash,
    carrierId,
    carrierAccount: record.carrierAccount,
    selectedOptionId: record.selectedOptionId,
    paymentNetwork: RESERVATION_NETWORK,
    paymentAsset: record.paymentAsset,
    paymentAmountAtomic: record.paymentAmountAtomic,
    payerAccount: record.payerAccount,
    paymentTransactionId: record.transactionId,
    paymentConsensusTimestamp: record.consensusTimestamp,
    reservationRecordHash: record.reservationRecordHash,
    decisionManifestHash: record.decisionManifestHash,
    closeBarrierSequence: record.closeBarrierSequence,
    reservationEvidenceVersion: RESERVATION_EVIDENCE_VERSION,
  };
}

function assertNoPrivateFields(payload: object): void {
  for (const field of PROHIBITED_ROUTE_RESERVED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      throw new ReservationError(
        "PRIVATE_FIELD",
        `ROUTE_RESERVED payload must not contain ${field}`,
      );
    }
  }
}

export function createRouteReservedHcsEnvelope(input: {
  runId: string;
  tenderId: string;
  tenderVersion: number;
  tenderHash: string;
  createdAt: string;
  payload: RouteReservedHcsPayload;
}): RouteReservedHcsEnvelope {
  assertNoPrivateFields(input.payload as object);

  const payload = RouteReservedPayloadSchema.parse(input.payload);
  if (payload.tenderId !== input.tenderId) {
    throw new ReservationError("TENDER_MISMATCH", "payload tenderId mismatch");
  }
  if (payload.tenderVersion !== input.tenderVersion) {
    throw new ReservationError(
      "TENDER_MISMATCH",
      "payload tenderVersion mismatch",
    );
  }
  if (!isUtcIsoTimestamp(input.createdAt)) {
    throw new ReservationError("INVALID_TIMESTAMP", "createdAt must be UTC");
  }
  assertSha256Hash(input.tenderHash);

  const payloadHash = canonicalSha256(payload);
  const envelope: RouteReservedHcsEnvelope = {
    schemaVersion: HCS_SCHEMA_VERSION,
    messageType: "ROUTE_RESERVED",
    runId: input.runId,
    tenderId: input.tenderId,
    tenderVersion: input.tenderVersion,
    tenderHash: input.tenderHash,
    createdAt: input.createdAt,
    payloadHash,
    payload,
  };

  // ROUTE_RESERVED carries multiple sha256 digests; allow up to 2× base HCS
  // limit for this evidence type (mocked publisher in Phase 6A; live publish
  // may use chunking in a later milestone if needed).
  const maxBytes = HCS_MAX_MESSAGE_BYTES * 2;
  const size = measureRouteReservedEnvelope(envelope);
  if (size > maxBytes) {
    throw new HcsEnvelopeError(
      `ROUTE_RESERVED message size ${size} exceeds ${maxBytes}`,
    );
  }

  return Object.freeze(envelope) as RouteReservedHcsEnvelope;
}

export function measureRouteReservedEnvelope(
  envelope: RouteReservedHcsEnvelope,
): number {
  return new TextEncoder().encode(canonicalize(envelope)).byteLength;
}

export function routeReservedEnvelopeHash(
  envelope: RouteReservedHcsEnvelope,
): string {
  return canonicalSha256(envelope);
}

export function decodeRouteReservedEnvelope(
  raw: unknown,
): RouteReservedHcsEnvelope {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new HcsEnvelopeError("Invalid ROUTE_RESERVED JSON");
    }
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new HcsEnvelopeError("Invalid ROUTE_RESERVED envelope");
  }
  const o = parsed as Record<string, unknown>;
  if (o.schemaVersion !== HCS_SCHEMA_VERSION) {
    throw new HcsEnvelopeError(
      `Unsupported schema: ${String(o.schemaVersion)}`,
    );
  }
  if (o.messageType !== "ROUTE_RESERVED") {
    throw new HcsEnvelopeError(
      `Expected ROUTE_RESERVED, got ${String(o.messageType)}`,
    );
  }
  if (o.payload && typeof o.payload === "object") {
    assertNoPrivateFields(o.payload as object);
  }
  const payload = RouteReservedPayloadSchema.parse(o.payload);
  const payloadHash = canonicalSha256(payload);
  if (payloadHash !== o.payloadHash) {
    throw new HcsEnvelopeError("payloadHash mismatch");
  }
  return {
    schemaVersion: HCS_SCHEMA_VERSION,
    messageType: "ROUTE_RESERVED",
    runId: String(o.runId),
    tenderId: String(o.tenderId),
    tenderVersion: Number(o.tenderVersion),
    tenderHash: String(o.tenderHash),
    createdAt: String(o.createdAt),
    payloadHash,
    payload,
  };
}
