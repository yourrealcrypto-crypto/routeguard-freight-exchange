/**
 * Canonical versioned HCS message envelopes.
 * Fail closed on malformed data, hash mismatch, size overflow, secrets.
 */

import { z } from "zod";

import {
  assertSha256Hash,
  canonicalSha256,
  canonicalize,
} from "../domain/canonical-hash";
import { isSafePositiveInteger } from "../domain/money";
import { isUtcIsoTimestamp } from "../domain/time";
import { ENGINE_VERSION, SELECTION_POLICY } from "../auction/types";
import {
  CLOSE_POLICY,
  COMMITMENT_SCHEMA_VERSION,
  HCS_MAX_MESSAGE_BYTES,
  HCS_SCHEMA_VERSION,
  type AuctionCloseBarrierEnvelope,
  type AuctionCloseBarrierPayload,
  type AuctionOpenEnvelope,
  type AuctionOpenPayload,
  type BidCommitmentEnvelope,
  type BidCommitmentPayload,
  type HcsEnvelope,
  type HcsMessageType,
} from "./types";

/** Fields that must never appear in a BID_COMMITMENT payload. */
export const PROHIBITED_COMMITMENT_PAYLOAD_FIELDS = [
  "freightPriceCents",
  "proposedPickupAt",
  "estimatedDelivery",
  "reservationPaymentOptions",
  "paymentOptions",
  "commitmentSalt",
  "salt",
  "nonce",
  "signature",
  "signedBid",
  "signedBidEnvelope",
  "bid",
  "fullBid",
  "privateKey",
] as const;

const BoundedId = z.string().min(1).max(128);
const BoundedHash = z.string().min(1).max(80);
const BoundedString = z.string().min(1).max(256);

function assertUtc(field: string, value: string, ctx: z.RefinementCtx): void {
  if (!isUtcIsoTimestamp(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${field} must be a valid UTC ISO-8601 timestamp`,
      path: field.split("."),
    });
  }
}

function assertHash(field: string, value: string, ctx: z.RefinementCtx): void {
  try {
    assertSha256Hash(value);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${field} must be sha256:<64 lowercase hex>`,
      path: field.split("."),
    });
  }
}

export const AuctionOpenPayloadSchema = z
  .object({
    tenderId: BoundedId,
    tenderVersion: z.number(),
    tenderHash: BoundedHash,
    auctionEndsAt: BoundedString,
    selectionPolicy: z.literal(SELECTION_POLICY),
    engineVersion: z.literal(ENGINE_VERSION),
    rulesHash: BoundedHash,
  })
  .superRefine((value, ctx) => {
    if (!isSafePositiveInteger(value.tenderVersion)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "tenderVersion must be a positive safe integer",
        path: ["tenderVersion"],
      });
    }
    assertUtc("auctionEndsAt", value.auctionEndsAt, ctx);
    assertHash("tenderHash", value.tenderHash, ctx);
    assertHash("rulesHash", value.rulesHash, ctx);
  });

export const BidCommitmentPayloadSchema = z
  .object({
    bidId: BoundedId,
    carrierId: BoundedId,
    bidHash: BoundedHash,
    acceptanceReceiptHash: BoundedHash,
    bidVersion: z.number(),
    commitmentSchemaVersion: z.literal(COMMITMENT_SCHEMA_VERSION),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!isSafePositiveInteger(value.bidVersion)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "bidVersion must be a positive safe integer",
        path: ["bidVersion"],
      });
    }
    assertHash("bidHash", value.bidHash, ctx);
    assertHash("acceptanceReceiptHash", value.acceptanceReceiptHash, ctx);
  });

export const AuctionCloseBarrierPayloadSchema = z
  .object({
    barrierId: BoundedId,
    tenderId: BoundedId,
    tenderVersion: z.number(),
    tenderHash: BoundedHash,
    auctionEndsAt: BoundedString,
    expectedCommitmentCount: z.number(),
    commitmentEnvelopeHashes: z.array(BoundedHash).max(32),
    closePolicy: z.literal(CLOSE_POLICY),
  })
  .superRefine((value, ctx) => {
    if (!isSafePositiveInteger(value.tenderVersion)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "tenderVersion must be a positive safe integer",
        path: ["tenderVersion"],
      });
    }
    if (!isSafePositiveInteger(value.expectedCommitmentCount)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "expectedCommitmentCount must be a positive safe integer",
        path: ["expectedCommitmentCount"],
      });
    }
    if (
      value.commitmentEnvelopeHashes.length !== value.expectedCommitmentCount
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "commitmentEnvelopeHashes length must equal expectedCommitmentCount",
        path: ["commitmentEnvelopeHashes"],
      });
    }
    assertUtc("auctionEndsAt", value.auctionEndsAt, ctx);
    assertHash("tenderHash", value.tenderHash, ctx);
    for (let i = 0; i < value.commitmentEnvelopeHashes.length; i++) {
      assertHash(
        `commitmentEnvelopeHashes.${i}`,
        value.commitmentEnvelopeHashes[i]!,
        ctx,
      );
    }
  });

const EnvelopeShellSchema = z.object({
  schemaVersion: z.string().min(1).max(64),
  messageType: z.enum([
    "AUCTION_OPEN",
    "BID_COMMITMENT",
    "AUCTION_CLOSE_BARRIER",
  ]),
  runId: BoundedId,
  tenderId: BoundedId,
  tenderVersion: z.number(),
  tenderHash: BoundedHash,
  createdAt: BoundedString,
  payloadHash: BoundedHash,
  payload: z.record(z.unknown()),
});

export class HcsEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HcsEnvelopeError";
  }
}

function assertJsonCompatible(value: unknown, path: string): void {
  if (value === null) return;
  const t = typeof value;
  if (t === "string" || t === "boolean") return;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new HcsEnvelopeError(`Non-finite number at ${path}`);
    }
    return;
  }
  if (t === "undefined" || t === "function" || t === "symbol" || t === "bigint") {
    throw new HcsEnvelopeError(`Non-JSON-compatible value at ${path}`);
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertJsonCompatible(value[i], `${path}[${i}]`);
    }
    return;
  }
  if (t === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new HcsEnvelopeError(`Non-plain object at ${path}`);
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertJsonCompatible(v, `${path}.${k}`);
    }
    return;
  }
  throw new HcsEnvelopeError(`Unsupported type at ${path}`);
}

function assertNoProhibitedCommitmentFields(
  payload: Record<string, unknown>,
): void {
  for (const field of PROHIBITED_COMMITMENT_PAYLOAD_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      throw new HcsEnvelopeError(
        `BID_COMMITMENT payload must not contain private field: ${field}`,
      );
    }
  }
}

export function computePayloadHash(payload: unknown): string {
  assertJsonCompatible(payload, "payload");
  return canonicalSha256(payload);
}

export function envelopeHash(envelope: HcsEnvelope): string {
  return canonicalSha256(envelope);
}

export function encodeHcsEnvelopeUtf8(envelope: HcsEnvelope): Uint8Array {
  // Deterministic UTF-8 of canonical JSON (sorted keys).
  const canonical = canonicalize(envelope);
  return new TextEncoder().encode(canonical);
}

export function measureHcsMessageBytes(envelope: HcsEnvelope): number {
  return encodeHcsEnvelopeUtf8(envelope).byteLength;
}

export function assertMessageSize(envelope: HcsEnvelope): void {
  const size = measureHcsMessageBytes(envelope);
  if (size > HCS_MAX_MESSAGE_BYTES) {
    throw new HcsEnvelopeError(
      `HCS message size ${size} exceeds limit ${HCS_MAX_MESSAGE_BYTES}`,
    );
  }
}

function buildEnvelopeShell(input: {
  messageType: HcsMessageType;
  runId: string;
  tenderId: string;
  tenderVersion: number;
  tenderHash: string;
  createdAt: string;
  payload: Record<string, unknown>;
}): {
  schemaVersion: typeof HCS_SCHEMA_VERSION;
  messageType: HcsMessageType;
  runId: string;
  tenderId: string;
  tenderVersion: number;
  tenderHash: string;
  createdAt: string;
  payloadHash: string;
  payload: Record<string, unknown>;
} {
  if (!isUtcIsoTimestamp(input.createdAt)) {
    throw new HcsEnvelopeError("createdAt must be a valid UTC ISO-8601 timestamp");
  }
  if (!isSafePositiveInteger(input.tenderVersion)) {
    throw new HcsEnvelopeError("tenderVersion must be a positive safe integer");
  }
  assertSha256Hash(input.tenderHash);
  assertJsonCompatible(input.payload, "payload");

  const payloadHash = computePayloadHash(input.payload);
  return {
    schemaVersion: HCS_SCHEMA_VERSION,
    messageType: input.messageType,
    runId: input.runId,
    tenderId: input.tenderId,
    tenderVersion: input.tenderVersion,
    tenderHash: input.tenderHash,
    createdAt: input.createdAt,
    payloadHash,
    payload: input.payload,
  };
}

export function createAuctionOpenEnvelope(input: {
  runId: string;
  tenderId: string;
  tenderVersion: number;
  tenderHash: string;
  createdAt: string;
  payload: AuctionOpenPayload;
}): AuctionOpenEnvelope {
  const payload = AuctionOpenPayloadSchema.parse(input.payload);
  if (payload.tenderId !== input.tenderId) {
    throw new HcsEnvelopeError("OPEN payload.tenderId mismatch");
  }
  if (payload.tenderVersion !== input.tenderVersion) {
    throw new HcsEnvelopeError("OPEN payload.tenderVersion mismatch");
  }
  if (payload.tenderHash !== input.tenderHash) {
    throw new HcsEnvelopeError("OPEN payload.tenderHash mismatch");
  }
  const shell = buildEnvelopeShell({
    messageType: "AUCTION_OPEN",
    runId: input.runId,
    tenderId: input.tenderId,
    tenderVersion: input.tenderVersion,
    tenderHash: input.tenderHash,
    createdAt: input.createdAt,
    payload: payload as unknown as Record<string, unknown>,
  });
  const envelope = shell as AuctionOpenEnvelope;
  assertMessageSize(envelope);
  return envelope;
}

export function createBidCommitmentEnvelope(input: {
  runId: string;
  tenderId: string;
  tenderVersion: number;
  tenderHash: string;
  createdAt: string;
  payload: BidCommitmentPayload;
}): BidCommitmentEnvelope {
  assertNoProhibitedCommitmentFields(
    input.payload as unknown as Record<string, unknown>,
  );
  const payload = BidCommitmentPayloadSchema.parse(input.payload);
  const shell = buildEnvelopeShell({
    messageType: "BID_COMMITMENT",
    runId: input.runId,
    tenderId: input.tenderId,
    tenderVersion: input.tenderVersion,
    tenderHash: input.tenderHash,
    createdAt: input.createdAt,
    payload: payload as unknown as Record<string, unknown>,
  });
  const envelope = shell as BidCommitmentEnvelope;
  assertMessageSize(envelope);
  return envelope;
}

export function createCloseBarrierEnvelope(input: {
  runId: string;
  tenderId: string;
  tenderVersion: number;
  tenderHash: string;
  createdAt: string;
  payload: AuctionCloseBarrierPayload;
}): AuctionCloseBarrierEnvelope {
  const payload = AuctionCloseBarrierPayloadSchema.parse(input.payload);
  if (payload.tenderId !== input.tenderId) {
    throw new HcsEnvelopeError("BARRIER payload.tenderId mismatch");
  }
  if (payload.tenderVersion !== input.tenderVersion) {
    throw new HcsEnvelopeError("BARRIER payload.tenderVersion mismatch");
  }
  if (payload.tenderHash !== input.tenderHash) {
    throw new HcsEnvelopeError("BARRIER payload.tenderHash mismatch");
  }
  const shell = buildEnvelopeShell({
    messageType: "AUCTION_CLOSE_BARRIER",
    runId: input.runId,
    tenderId: input.tenderId,
    tenderVersion: input.tenderVersion,
    tenderHash: input.tenderHash,
    createdAt: input.createdAt,
    payload: payload as unknown as Record<string, unknown>,
  });
  const envelope = shell as AuctionCloseBarrierEnvelope;
  assertMessageSize(envelope);
  return envelope;
}

/**
 * Decode and strictly validate a UTF-8 HCS message body.
 * Verifies payloadHash against the payload. Fail closed.
 */
export function decodeHcsEnvelope(raw: unknown): HcsEnvelope {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new HcsEnvelopeError("HCS message is not valid JSON");
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HcsEnvelopeError("HCS message must be a JSON object");
  }

  const shellResult = EnvelopeShellSchema.safeParse(parsed);
  if (!shellResult.success) {
    throw new HcsEnvelopeError(
      `Malformed HCS envelope: ${shellResult.error.message}`,
    );
  }
  const shell = shellResult.data;

  if (shell.schemaVersion !== HCS_SCHEMA_VERSION) {
    throw new HcsEnvelopeError(
      `Unsupported HCS schema version: ${shell.schemaVersion}`,
    );
  }
  if (!isSafePositiveInteger(shell.tenderVersion)) {
    throw new HcsEnvelopeError("tenderVersion must be a positive safe integer");
  }
  if (!isUtcIsoTimestamp(shell.createdAt)) {
    throw new HcsEnvelopeError("createdAt must be a valid UTC ISO-8601 timestamp");
  }
  try {
    assertSha256Hash(shell.tenderHash);
    assertSha256Hash(shell.payloadHash);
  } catch {
    throw new HcsEnvelopeError("envelope hashes must be sha256:<64 lowercase hex>");
  }

  assertJsonCompatible(shell.payload, "payload");
  const recomputed = computePayloadHash(shell.payload);
  if (recomputed !== shell.payloadHash) {
    throw new HcsEnvelopeError(
      "payloadHash mismatch: envelope integrity check failed",
    );
  }

  if (shell.messageType === "AUCTION_OPEN") {
    const payload = AuctionOpenPayloadSchema.parse(shell.payload);
    if (payload.tenderId !== shell.tenderId) {
      throw new HcsEnvelopeError("OPEN payload.tenderId mismatch");
    }
    if (payload.tenderVersion !== shell.tenderVersion) {
      throw new HcsEnvelopeError("OPEN payload.tenderVersion mismatch");
    }
    if (payload.tenderHash !== shell.tenderHash) {
      throw new HcsEnvelopeError("OPEN payload.tenderHash mismatch");
    }
    const envelope: AuctionOpenEnvelope = {
      schemaVersion: HCS_SCHEMA_VERSION,
      messageType: "AUCTION_OPEN",
      runId: shell.runId,
      tenderId: shell.tenderId,
      tenderVersion: shell.tenderVersion,
      tenderHash: shell.tenderHash,
      createdAt: shell.createdAt,
      payloadHash: shell.payloadHash,
      payload,
    };
    assertMessageSize(envelope);
    return envelope;
  }

  if (shell.messageType === "BID_COMMITMENT") {
    assertNoProhibitedCommitmentFields(shell.payload);
    const payload = BidCommitmentPayloadSchema.parse(shell.payload);
    const envelope: BidCommitmentEnvelope = {
      schemaVersion: HCS_SCHEMA_VERSION,
      messageType: "BID_COMMITMENT",
      runId: shell.runId,
      tenderId: shell.tenderId,
      tenderVersion: shell.tenderVersion,
      tenderHash: shell.tenderHash,
      createdAt: shell.createdAt,
      payloadHash: shell.payloadHash,
      payload,
    };
    assertMessageSize(envelope);
    return envelope;
  }

  if (shell.messageType === "AUCTION_CLOSE_BARRIER") {
    const payload = AuctionCloseBarrierPayloadSchema.parse(shell.payload);
    if (payload.tenderId !== shell.tenderId) {
      throw new HcsEnvelopeError("BARRIER payload.tenderId mismatch");
    }
    if (payload.tenderVersion !== shell.tenderVersion) {
      throw new HcsEnvelopeError("BARRIER payload.tenderVersion mismatch");
    }
    if (payload.tenderHash !== shell.tenderHash) {
      throw new HcsEnvelopeError("BARRIER payload.tenderHash mismatch");
    }
    const envelope: AuctionCloseBarrierEnvelope = {
      schemaVersion: HCS_SCHEMA_VERSION,
      messageType: "AUCTION_CLOSE_BARRIER",
      runId: shell.runId,
      tenderId: shell.tenderId,
      tenderVersion: shell.tenderVersion,
      tenderHash: shell.tenderHash,
      createdAt: shell.createdAt,
      payloadHash: shell.payloadHash,
      payload,
    };
    assertMessageSize(envelope);
    return envelope;
  }

  throw new HcsEnvelopeError(`Unsupported message type`);
}

export function decodeHcsEnvelopeFromBase64(base64: string): HcsEnvelope {
  let bytes: Uint8Array;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    throw new HcsEnvelopeError("Invalid base64 HCS message body");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return decodeHcsEnvelope(text);
}

export function serializeEnvelopeForSubmit(envelope: HcsEnvelope): Uint8Array {
  assertMessageSize(envelope);
  return encodeHcsEnvelopeUtf8(envelope);
}
