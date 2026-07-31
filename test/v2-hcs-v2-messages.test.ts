import { describe, expect, it } from "vitest";

import {
  assertHcsV2EnvelopeWithinLimit,
  buildHcsV2Envelope,
  serializeHcsV2Envelope,
  utf8ByteLength,
} from "../src/hcs/v2/envelope";
import {
  HCS_V2_MAX_MESSAGE_BYTES,
  HCS_V2_MAX_ID_CHARS,
  HCS_V2_MESSAGE_TYPES,
  HCS_V2_SCHEMA_VERSION,
  type HcsV2MessageType,
  type HcsV2Payload,
} from "../src/hcs/v2/types";

const HASH =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TS = "2026-07-31T12:00:00.000Z";

function shell(messageType: HcsV2MessageType, payload: HcsV2Payload) {
  return buildHcsV2Envelope({
    messageType,
    tenderId: "tender-v2-a2",
    tenderVersion: 1,
    tenderHash: HASH,
    createdAt: TS,
    payload,
  });
}

const samples: Record<HcsV2MessageType, HcsV2Payload> = {
  TENDER_OPENED: {
    accessPaymentTxId: "0.0.1@1.1",
    maxBudgetAtomic: "1000000",
    auctionEndsAt: TS,
    selectionPolicy: "LOWEST_QUALIFIED_PRICE_V1",
  },
  BID_COMMITMENT: {
    bidId: "bid-1",
    carrierId: "carrier-a",
    bidHash: HASH,
    accessPaymentTxId: "0.0.1@1.2",
  },
  AUCTION_CLOSE_BARRIER: {
    barrierId: "bar-1",
    auctionEndsAt: TS,
    expectedCommitmentCount: 2,
    bidSetHash: HASH,
  },
  WINNER_SELECTED: {
    winningBidId: "bid-1",
    carrierId: "carrier-a",
    winningAmountAtomic: "700000",
    decisionManifestHash: HASH,
  },
  WINNER_ALLOCATED: {
    winningBidId: "bid-1",
    winnerAccount: "0.0.9215954",
    winningAmountAtomic: "700000",
    excessRefundAtomic: "300000",
    allocateTxId: "0.0.1@1.3",
    refundTxId: "0.0.1@1.4",
    decisionManifestHash: HASH,
  },
  ROUTE_RESERVED: {
    reservationId: "res-1",
    winningBidId: "bid-1",
    carrierAccount: "0.0.9215954",
    lockedAmountAtomic: "700000",
    allocateTxId: "0.0.1@1.3",
    reservationRecordHash: HASH,
  },
  POD_SUBMITTED: {
    podId: "pod-1",
    podVersion: 1,
    contentHash: HASH,
    ciphertextHash: HASH,
    sizeBytes: 4096,
  },
  POD_ADVISORY_ANCHORED: {
    podId: "pod-1",
    reportHash: HASH,
    binding: "NON_BINDING_ADVISORY",
  },
  POD_REVIEW_ACTION: {
    podId: "pod-1",
    action: "ACCEPT",
    reviewDeadlineAt: TS,
  },
  POD_DEEMED_ACCEPTED: {
    podId: "pod-1",
    reviewDeadlineAt: TS,
    tickActionId: "tick-1",
  },
  DISPUTE_OPENED: {
    disputeId: "disp-1",
    podId: "pod-1",
    reasonCode: "DAMAGED",
  },
  REFEREE_RESOLUTION: {
    disputeId: "disp-1",
    podId: "pod-1",
    resolution: "PARTIAL",
    releaseAmountAtomic: "400000",
    refundAmountAtomic: "300000",
    resolutionHash: HASH,
  },
  ESCROW_RELEASED: {
    releaseTxId: "0.0.1@2.1",
    amountAtomic: "700000",
    winnerAccount: "0.0.9215954",
  },
  ESCROW_PARTIAL: {
    releaseTxId: "0.0.1@2.1",
    refundTxId: "0.0.1@2.2",
    releaseAmountAtomic: "400000",
    refundAmountAtomic: "300000",
  },
  ESCROW_REFUNDED: {
    refundTxId: "0.0.1@2.3",
    amountAtomic: "1000000",
    shipperAccount: "0.0.9197513",
  },
  TENDER_COMPLETED: {
    finalState: "PAYMENT_RELEASED",
    completionRef: "done-1",
  },
};

describe("v2 HCS 2.0 messages", () => {
  it("uses schema routeguard-hcs-2.0", () => {
    expect(HCS_V2_SCHEMA_VERSION).toBe("routeguard-hcs-2.0");
    expect(HCS_V2_MESSAGE_TYPES).toHaveLength(16);
  });

  it("builds all message types under 1024 UTF-8 bytes", () => {
    for (const type of HCS_V2_MESSAGE_TYPES) {
      const env = shell(type, samples[type]);
      expect(env.schemaVersion).toBe(HCS_V2_SCHEMA_VERSION);
      expect(env.messageType).toBe(type);
      const serialized = serializeHcsV2Envelope(env);
      const bytes = utf8ByteLength(serialized);
      expect(bytes).toBeLessThan(HCS_V2_MAX_MESSAGE_BYTES);
      expect(() => assertHcsV2EnvelopeWithinLimit(env)).not.toThrow();
      // Canonical re-serialize is stable
      expect(serializeHcsV2Envelope(env)).toBe(serialized);
    }
  });

  it("binds payloadHash to canonical payload", () => {
    const env = shell("POD_SUBMITTED", samples.POD_SUBMITTED);
    expect(env.payloadHash.startsWith("sha256:")).toBe(true);
  });

  it("keeps realistic maximum valid UTF-8 envelopes below 1024 bytes", () => {
    const id = "x".repeat(HCS_V2_MAX_ID_CHARS);
    const maximumSamples: Record<HcsV2MessageType, HcsV2Payload> = {
      ...samples,
      TENDER_OPENED: {
        ...samples.TENDER_OPENED,
        accessPaymentTxId: id,
        maxBudgetAtomic: "9".repeat(32),
      },
      BID_COMMITMENT: {
        ...samples.BID_COMMITMENT,
        bidId: id,
        carrierId: id,
        accessPaymentTxId: id,
      },
      AUCTION_CLOSE_BARRIER: {
        ...samples.AUCTION_CLOSE_BARRIER,
        barrierId: id,
        expectedCommitmentCount: Number.MAX_SAFE_INTEGER,
      },
      WINNER_SELECTED: {
        ...samples.WINNER_SELECTED,
        winningBidId: id,
        carrierId: id,
        winningAmountAtomic: "9".repeat(32),
      },
      WINNER_ALLOCATED: {
        ...samples.WINNER_ALLOCATED,
        winningBidId: id,
        winningAmountAtomic: "9".repeat(32),
        excessRefundAtomic: "9".repeat(32),
        allocateTxId: id,
        refundTxId: id,
      },
      ROUTE_RESERVED: {
        ...samples.ROUTE_RESERVED,
        reservationId: id,
        winningBidId: id,
        lockedAmountAtomic: "9".repeat(32),
        allocateTxId: id,
      },
      POD_SUBMITTED: {
        ...samples.POD_SUBMITTED,
        podId: id,
        sizeBytes: Number.MAX_SAFE_INTEGER,
      },
      POD_ADVISORY_ANCHORED: { ...samples.POD_ADVISORY_ANCHORED, podId: id },
      POD_REVIEW_ACTION: { ...samples.POD_REVIEW_ACTION, podId: id },
      POD_DEEMED_ACCEPTED: {
        ...samples.POD_DEEMED_ACCEPTED,
        podId: id,
        tickActionId: id,
      },
      DISPUTE_OPENED: {
        ...samples.DISPUTE_OPENED,
        disputeId: id,
        podId: id,
      },
      REFEREE_RESOLUTION: {
        ...samples.REFEREE_RESOLUTION,
        disputeId: id,
        podId: id,
        releaseAmountAtomic: "9".repeat(32),
        refundAmountAtomic: "9".repeat(32),
      },
      ESCROW_RELEASED: {
        ...samples.ESCROW_RELEASED,
        releaseTxId: id,
        amountAtomic: "9".repeat(32),
      },
      ESCROW_PARTIAL: {
        ...samples.ESCROW_PARTIAL,
        releaseTxId: id,
        refundTxId: id,
        releaseAmountAtomic: "9".repeat(32),
        refundAmountAtomic: "9".repeat(32),
      },
      ESCROW_REFUNDED: {
        ...samples.ESCROW_REFUNDED,
        refundTxId: id,
        amountAtomic: "9".repeat(32),
      },
      TENDER_COMPLETED: { ...samples.TENDER_COMPLETED, completionRef: id },
    };

    for (const type of HCS_V2_MESSAGE_TYPES) {
      const env = buildHcsV2Envelope({
        messageType: type,
        tenderId: id,
        tenderVersion: Number.MAX_SAFE_INTEGER,
        tenderHash: HASH,
        createdAt: TS,
        payload: maximumSamples[type],
      });
      expect(utf8ByteLength(serializeHcsV2Envelope(env))).toBeLessThan(
        HCS_V2_MAX_MESSAGE_BYTES,
      );
    }
  });
});
