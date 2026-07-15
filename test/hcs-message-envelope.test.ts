import { describe, expect, it } from "vitest";

import { canonicalSha256 } from "../src/domain/canonical-hash";
import {
  assertMessageSize,
  computePayloadHash,
  createAuctionOpenEnvelope,
  createBidCommitmentEnvelope,
  createCloseBarrierEnvelope,
  decodeHcsEnvelope,
  decodeHcsEnvelopeFromBase64,
  encodeHcsEnvelopeUtf8,
  envelopeHash,
  HcsEnvelopeError,
  measureHcsMessageBytes,
  PROHIBITED_COMMITMENT_PAYLOAD_FIELDS,
} from "../src/hcs/message-envelope";
import {
  CLOSE_POLICY,
  COMMITMENT_SCHEMA_VERSION,
  HCS_MAX_MESSAGE_BYTES,
  HCS_SCHEMA_VERSION,
} from "../src/hcs/types";
import { ENGINE_VERSION, SELECTION_POLICY } from "../src/auction/types";

const TENDER_HASH = canonicalSha256({ tender: "ham-ist-demo" });
const RULES_HASH = canonicalSha256({ rules: "v1" });
const BID_HASH = canonicalSha256({ bid: "a" });
const RECEIPT_HASH = canonicalSha256({ receipt: "a" });

const baseMeta = {
  runId: "run-test-001",
  tenderId: "tender-ham-ist-hcs-001",
  tenderVersion: 1,
  tenderHash: TENDER_HASH,
  createdAt: "2026-07-15T12:00:00.000Z",
};

describe("HCS message envelope", () => {
  it("canonicalizes payloadHash and verifies on decode", () => {
    const payload = {
      tenderId: baseMeta.tenderId,
      tenderVersion: 1,
      tenderHash: TENDER_HASH,
      auctionEndsAt: "2026-07-15T12:01:30.000Z",
      selectionPolicy: SELECTION_POLICY,
      engineVersion: ENGINE_VERSION,
      rulesHash: RULES_HASH,
    };
    const env = createAuctionOpenEnvelope({ ...baseMeta, payload });
    expect(env.schemaVersion).toBe(HCS_SCHEMA_VERSION);
    expect(env.payloadHash).toBe(computePayloadHash(payload));
    expect(env.payloadHash).toBe(canonicalSha256(payload));

    const decoded = decodeHcsEnvelope(JSON.parse(JSON.stringify(env)));
    expect(decoded.messageType).toBe("AUCTION_OPEN");
    expect(envelopeHash(decoded)).toBe(envelopeHash(env));
  });

  it("rejects malformed envelopes", () => {
    expect(() => decodeHcsEnvelope("not-json")).toThrow(HcsEnvelopeError);
    expect(() => decodeHcsEnvelope([])).toThrow(HcsEnvelopeError);
    expect(() => decodeHcsEnvelope(null)).toThrow(HcsEnvelopeError);
  });

  it("rejects unsupported schema version", () => {
    const env = createAuctionOpenEnvelope({
      ...baseMeta,
      payload: {
        tenderId: baseMeta.tenderId,
        tenderVersion: 1,
        tenderHash: TENDER_HASH,
        auctionEndsAt: "2026-07-15T12:01:30.000Z",
        selectionPolicy: SELECTION_POLICY,
        engineVersion: ENGINE_VERSION,
        rulesHash: RULES_HASH,
      },
    });
    const bad = { ...env, schemaVersion: "routeguard-hcs-0.9" };
    // Fix payloadHash so we fail on version not hash
    expect(() => decodeHcsEnvelope(bad)).toThrow(/Unsupported HCS schema version/);
  });

  it("rejects payloadHash mismatch", () => {
    const env = createAuctionOpenEnvelope({
      ...baseMeta,
      payload: {
        tenderId: baseMeta.tenderId,
        tenderVersion: 1,
        tenderHash: TENDER_HASH,
        auctionEndsAt: "2026-07-15T12:01:30.000Z",
        selectionPolicy: SELECTION_POLICY,
        engineVersion: ENGINE_VERSION,
        rulesHash: RULES_HASH,
      },
    });
    const bad = {
      ...env,
      payloadHash: canonicalSha256({ tampered: true }),
    };
    expect(() => decodeHcsEnvelope(bad)).toThrow(/payloadHash mismatch/);
  });

  it("rejects message size over HCS limit", () => {
    const hugeId = "x".repeat(900);
    expect(() =>
      createBidCommitmentEnvelope({
        ...baseMeta,
        payload: {
          bidId: hugeId,
          carrierId: hugeId,
          bidHash: BID_HASH,
          acceptanceReceiptHash: RECEIPT_HASH,
          bidVersion: 1,
          commitmentSchemaVersion: COMMITMENT_SCHEMA_VERSION,
        },
      }),
    ).toThrow(/exceeds limit|String must contain at most|too_big|max/i);
  });

  it("assertMessageSize rejects oversized envelopes", () => {
    const env = createBidCommitmentEnvelope({
      ...baseMeta,
      payload: {
        bidId: "bid-a",
        carrierId: "carrier-alpha",
        bidHash: BID_HASH,
        acceptanceReceiptHash: RECEIPT_HASH,
        bidVersion: 1,
        commitmentSchemaVersion: COMMITMENT_SCHEMA_VERSION,
      },
    });
    expect(measureHcsMessageBytes(env)).toBeLessThanOrEqual(HCS_MAX_MESSAGE_BYTES);
    assertMessageSize(env);
  });

  it("prohibits private fields from commitment payload", () => {
    for (const field of [
      "freightPriceCents",
      "commitmentSalt",
      "nonce",
      "signature",
      "salt",
    ] as const) {
      expect(PROHIBITED_COMMITMENT_PAYLOAD_FIELDS).toContain(field);
      const payload = {
        bidId: "bid-a",
        carrierId: "carrier-alpha",
        bidHash: BID_HASH,
        acceptanceReceiptHash: RECEIPT_HASH,
        bidVersion: 1,
        commitmentSchemaVersion: COMMITMENT_SCHEMA_VERSION,
        [field]: field === "freightPriceCents" ? 100 : "secret",
      };
      expect(() =>
        createBidCommitmentEnvelope({
          ...baseMeta,
          payload: payload as never,
        }),
      ).toThrow(/must not contain private field/);
    }
  });

  it("rejects prohibited fields on decode", () => {
    const good = createBidCommitmentEnvelope({
      ...baseMeta,
      payload: {
        bidId: "bid-a",
        carrierId: "carrier-alpha",
        bidHash: BID_HASH,
        acceptanceReceiptHash: RECEIPT_HASH,
        bidVersion: 1,
        commitmentSchemaVersion: COMMITMENT_SCHEMA_VERSION,
      },
    });
    const smuggled = {
      ...good,
      payload: { ...good.payload, freightPriceCents: 350000 },
    };
    smuggled.payloadHash = computePayloadHash(smuggled.payload);
    expect(() => decodeHcsEnvelope(smuggled)).toThrow(/private field/);
  });

  it("creates and decodes close barrier", () => {
    const h1 = canonicalSha256({ c: 1 });
    const h2 = canonicalSha256({ c: 2 });
    const env = createCloseBarrierEnvelope({
      ...baseMeta,
      payload: {
        barrierId: "barrier-1",
        tenderId: baseMeta.tenderId,
        tenderVersion: 1,
        tenderHash: TENDER_HASH,
        auctionEndsAt: "2026-07-15T12:01:30.000Z",
        expectedCommitmentCount: 2,
        commitmentEnvelopeHashes: [h1, h2],
        closePolicy: CLOSE_POLICY,
      },
    });
    expect(env.messageType).toBe("AUCTION_CLOSE_BARRIER");
    const bytes = encodeHcsEnvelopeUtf8(env);
    const b64 = Buffer.from(bytes).toString("base64");
    const decoded = decodeHcsEnvelopeFromBase64(b64);
    expect(decoded.messageType).toBe("AUCTION_CLOSE_BARRIER");
  });

  it("rejects invalid createdAt timestamps", () => {
    expect(() =>
      createAuctionOpenEnvelope({
        ...baseMeta,
        createdAt: "2026-07-15T12:00:00+00:00",
        payload: {
          tenderId: baseMeta.tenderId,
          tenderVersion: 1,
          tenderHash: TENDER_HASH,
          auctionEndsAt: "2026-07-15T12:01:30.000Z",
          selectionPolicy: SELECTION_POLICY,
          engineVersion: ENGINE_VERSION,
          rulesHash: RULES_HASH,
        },
      }),
    ).toThrow(/UTC/);
  });
});
