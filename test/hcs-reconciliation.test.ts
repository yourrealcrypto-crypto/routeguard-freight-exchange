import { describe, expect, it } from "vitest";

import { ENGINE_VERSION, SELECTION_POLICY } from "../src/auction/types";
import { canonicalSha256 } from "../src/domain/canonical-hash";
import {
  createAuctionOpenEnvelope,
  createBidCommitmentEnvelope,
  createCloseBarrierEnvelope,
  envelopeHash,
} from "../src/hcs/message-envelope";
import {
  mirrorTimestampToUtcIso,
  parseSequenceNumber,
} from "../src/hcs/mirror-node-client";
import {
  computeCompleteness,
  HcsReconciliationError,
  reconcileMirrorMessages,
} from "../src/hcs/reconciliation";
import {
  CLOSE_POLICY,
  COMMITMENT_SCHEMA_VERSION,
  type ObservedHcsMessage,
} from "../src/hcs/types";

const TENDER_HASH = canonicalSha256({ tender: "recon" });
const RULES_HASH = canonicalSha256({ rules: "r" });
const BID_HASH_A = canonicalSha256({ bid: "a" });
const BID_HASH_B = canonicalSha256({ bid: "b" });
const RECEIPT_A = canonicalSha256({ r: "a" });
const RECEIPT_B = canonicalSha256({ r: "b" });

const meta = {
  runId: "run-recon-001",
  tenderId: "tender-recon",
  tenderVersion: 1,
  tenderHash: TENDER_HASH,
};

function observed(
  sequence: number,
  envelope: ObservedHcsMessage["envelope"],
  consensusTimestamp: string,
  topicId = "0.0.100",
): ObservedHcsMessage {
  return {
    topicId,
    sequence,
    consensusTimestamp,
    mirrorConsensusTimestamp: "1000.0",
    envelope,
    envelopeHash: envelopeHash(envelope),
  };
}

function buildHappyPath(orderShuffle = false): ObservedHcsMessage[] {
  const open = createAuctionOpenEnvelope({
    ...meta,
    createdAt: "2026-07-15T12:00:00.000Z",
    payload: {
      tenderId: meta.tenderId,
      tenderVersion: 1,
      tenderHash: TENDER_HASH,
      auctionEndsAt: "2026-07-15T12:01:00.000Z",
      selectionPolicy: SELECTION_POLICY,
      engineVersion: ENGINE_VERSION,
      rulesHash: RULES_HASH,
    },
  });
  const cA = createBidCommitmentEnvelope({
    ...meta,
    createdAt: "2026-07-15T12:00:10.000Z",
    payload: {
      bidId: "bid-a",
      carrierId: "carrier-alpha",
      bidHash: BID_HASH_A,
      acceptanceReceiptHash: RECEIPT_A,
      bidVersion: 1,
      commitmentSchemaVersion: COMMITMENT_SCHEMA_VERSION,
    },
  });
  const cB = createBidCommitmentEnvelope({
    ...meta,
    createdAt: "2026-07-15T12:00:20.000Z",
    payload: {
      bidId: "bid-b",
      carrierId: "carrier-beta",
      bidHash: BID_HASH_B,
      acceptanceReceiptHash: RECEIPT_B,
      bidVersion: 1,
      commitmentSchemaVersion: COMMITMENT_SCHEMA_VERSION,
    },
  });
  const obsOpen = observed(1, open, "2026-07-15T12:00:00.100Z");
  const obsA = observed(2, cA, "2026-07-15T12:00:10.100Z");
  const obsB = observed(3, cB, "2026-07-15T12:00:20.100Z");
  const barrier = createCloseBarrierEnvelope({
    ...meta,
    createdAt: "2026-07-15T12:01:05.000Z",
    payload: {
      barrierId: "barrier-1",
      tenderId: meta.tenderId,
      tenderVersion: 1,
      tenderHash: TENDER_HASH,
      auctionEndsAt: "2026-07-15T12:01:00.000Z",
      expectedCommitmentCount: 2,
      commitmentEnvelopeHashes: [obsA.envelopeHash, obsB.envelopeHash],
      closePolicy: CLOSE_POLICY,
    },
  });
  const obsBarrier = observed(4, barrier, "2026-07-15T12:01:05.100Z");
  const list = [obsOpen, obsA, obsB, obsBarrier];
  if (orderShuffle) {
    return [obsB, obsBarrier, obsOpen, obsA];
  }
  return list;
}

describe("Mirror timestamp helpers", () => {
  it("converts Mirror seconds.nanos to UTC ISO", () => {
    const iso = mirrorTimestampToUtcIso("1700000000.123456789");
    expect(iso.endsWith("Z")).toBe(true);
    expect(iso).toContain(".123456789");
  });

  it("parses sequence numbers and rejects invalid", () => {
    expect(parseSequenceNumber(1)).toBe(1);
    expect(parseSequenceNumber("12")).toBe(12);
    expect(() => parseSequenceNumber(-1)).toThrow();
    expect(() => parseSequenceNumber("x")).toThrow();
  });
});

describe("HCS reconciliation", () => {
  it("reconciles complete sequence range and is order-independent", () => {
    const a = reconcileMirrorMessages({
      topicId: "0.0.100",
      messages: buildHappyPath(false),
      expectedRunId: meta.runId,
      expectedTenderId: meta.tenderId,
      expectedTenderVersion: 1,
      expectedTenderHash: TENDER_HASH,
    });
    const b = reconcileMirrorMessages({
      topicId: "0.0.100",
      messages: buildHappyPath(true),
      expectedRunId: meta.runId,
      expectedTenderId: meta.tenderId,
      expectedTenderVersion: 1,
      expectedTenderHash: TENDER_HASH,
    });
    expect(a.completeness.complete).toBe(true);
    expect(a.completeness.observedSequences).toEqual([1, 2, 3, 4]);
    expect(a.commitmentEvidence.map((c) => c.bidId)).toEqual(["bid-a", "bid-b"]);
    expect(b.commitmentEvidence.map((c) => c.bidId)).toEqual(
      a.commitmentEvidence.map((c) => c.bidId),
    );
    expect(b.barrier.sequence).toBe(a.barrier.sequence);
  });

  it("detects missing and duplicate sequences in completeness helper", () => {
    const missing = computeCompleteness(1, 4, [1, 2, 4]);
    expect(missing.complete).toBe(false);
    expect(missing.missingSequences).toEqual([3]);

    const dup = computeCompleteness(1, 3, [1, 2, 2, 3]);
    expect(dup.complete).toBe(false);
    expect(dup.duplicateSequences).toContain(2);
  });

  it("rejects duplicate sequence", () => {
    const msgs = buildHappyPath();
    const dup = { ...msgs[1]!, sequence: 1 };
    expect(() =>
      reconcileMirrorMessages({
        topicId: "0.0.100",
        messages: [msgs[0]!, dup, msgs[2]!, msgs[3]!],
        expectedRunId: meta.runId,
        expectedTenderId: meta.tenderId,
        expectedTenderVersion: 1,
        expectedTenderHash: TENDER_HASH,
      }),
    ).toThrow(/Duplicate sequence/);
  });

  it("rejects missing sequence", () => {
    const msgs = buildHappyPath();
    // drop sequence 3, renumber barrier still at 4 → gap
    expect(() =>
      reconcileMirrorMessages({
        topicId: "0.0.100",
        messages: [msgs[0]!, msgs[1]!, msgs[3]!],
        expectedRunId: meta.runId,
        expectedTenderId: meta.tenderId,
        expectedTenderVersion: 1,
        expectedTenderHash: TENDER_HASH,
      }),
    ).toThrow(HcsReconciliationError);
  });

  it("rejects sequence zero", () => {
    const msgs = buildHappyPath();
    const zero = { ...msgs[0]!, sequence: 0 };
    expect(() =>
      reconcileMirrorMessages({
        topicId: "0.0.100",
        messages: [zero, msgs[1]!, msgs[2]!, msgs[3]!],
        expectedRunId: meta.runId,
        expectedTenderId: meta.tenderId,
        expectedTenderVersion: 1,
        expectedTenderHash: TENDER_HASH,
      }),
    ).toThrow(/zero|Sequence/i);
  });

  it("rejects wrong runId / tender / version / hash", () => {
    const msgs = buildHappyPath();
    expect(() =>
      reconcileMirrorMessages({
        topicId: "0.0.100",
        messages: msgs,
        expectedRunId: "wrong-run",
        expectedTenderId: meta.tenderId,
        expectedTenderVersion: 1,
        expectedTenderHash: TENDER_HASH,
      }),
    ).toThrow(/runId mismatch/);

    expect(() =>
      reconcileMirrorMessages({
        topicId: "0.0.100",
        messages: msgs,
        expectedRunId: meta.runId,
        expectedTenderId: "wrong-tender",
        expectedTenderVersion: 1,
        expectedTenderHash: TENDER_HASH,
      }),
    ).toThrow(/tenderId mismatch/);

    expect(() =>
      reconcileMirrorMessages({
        topicId: "0.0.100",
        messages: msgs,
        expectedRunId: meta.runId,
        expectedTenderId: meta.tenderId,
        expectedTenderVersion: 99,
        expectedTenderHash: TENDER_HASH,
      }),
    ).toThrow(/tenderVersion mismatch/);

    expect(() =>
      reconcileMirrorMessages({
        topicId: "0.0.100",
        messages: msgs,
        expectedRunId: meta.runId,
        expectedTenderId: meta.tenderId,
        expectedTenderVersion: 1,
        expectedTenderHash: canonicalSha256({ other: true }),
      }),
    ).toThrow(/tenderHash mismatch/);
  });

  it("rejects commitment after barrier", () => {
    const msgs = buildHappyPath();
    // Put a commitment at sequence 5 after barrier at 4
    const late = {
      ...msgs[1]!,
      sequence: 5,
      consensusTimestamp: "2026-07-15T12:02:00.000Z",
      envelopeHash: canonicalSha256({ late: true }),
    };
    // need unique envelope hash - rebuild commitment with different bid
    const lateEnv = createBidCommitmentEnvelope({
      ...meta,
      createdAt: "2026-07-15T12:02:00.000Z",
      payload: {
        bidId: "bid-late",
        carrierId: "carrier-gamma",
        bidHash: canonicalSha256({ late: 1 }),
        acceptanceReceiptHash: canonicalSha256({ late: 2 }),
        bidVersion: 1,
        commitmentSchemaVersion: COMMITMENT_SCHEMA_VERSION,
      },
    });
    const lateObs = observed(5, lateEnv, "2026-07-15T12:02:00.000Z");
    expect(() =>
      reconcileMirrorMessages({
        topicId: "0.0.100",
        messages: [...msgs, lateObs],
        expectedRunId: meta.runId,
        expectedTenderId: meta.tenderId,
        expectedTenderVersion: 1,
        expectedTenderHash: TENDER_HASH,
      }),
    ).toThrow(/after close barrier/);
  });

  it("rejects barrier on wrong topic", () => {
    const msgs = buildHappyPath();
    const wrongTopic = msgs.map((m) =>
      m.sequence === 4 ? { ...m, topicId: "0.0.999" } : m,
    );
    expect(() =>
      reconcileMirrorMessages({
        topicId: "0.0.100",
        messages: wrongTopic,
        expectedRunId: meta.runId,
        expectedTenderId: meta.tenderId,
        expectedTenderVersion: 1,
        expectedTenderHash: TENDER_HASH,
      }),
    ).toThrow(/topic/);
  });

  it("rejects barrier before commitments (wrong sequence order)", () => {
    const msgs = buildHappyPath();
    // Swap: barrier at 2, commitments at 3,4 — open at 1
    // Rebuild barrier that claims wrong hashes for incomplete set
    const open = msgs[0]!;
    const cA = msgs[1]!;
    const cB = msgs[2]!;
    const barrierEarly = createCloseBarrierEnvelope({
      ...meta,
      createdAt: "2026-07-15T12:00:05.000Z",
      payload: {
        barrierId: "barrier-early",
        tenderId: meta.tenderId,
        tenderVersion: 1,
        tenderHash: TENDER_HASH,
        auctionEndsAt: "2026-07-15T12:01:00.000Z",
        expectedCommitmentCount: 2,
        commitmentEnvelopeHashes: [cA.envelopeHash, cB.envelopeHash],
        closePolicy: CLOSE_POLICY,
      },
    });
    const obsBarrier = observed(2, barrierEarly, "2026-07-15T12:00:05.000Z");
    // Only open + barrier in window 1..2 — commitments after barrier rejected
    const cA3 = { ...cA, sequence: 3 };
    const cB4 = { ...cB, sequence: 4 };
    expect(() =>
      reconcileMirrorMessages({
        topicId: "0.0.100",
        messages: [open, obsBarrier, cA3, cB4],
        expectedRunId: meta.runId,
        expectedTenderId: meta.tenderId,
        expectedTenderVersion: 1,
        expectedTenderHash: TENDER_HASH,
      }),
    ).toThrow(HcsReconciliationError);
  });

  it("rejects barrier before auction deadline", () => {
    const msgs = buildHappyPath();
    const earlyBarrier = {
      ...msgs[3]!,
      consensusTimestamp: "2026-07-15T12:00:59.999Z",
    };
    expect(() =>
      reconcileMirrorMessages({
        topicId: "0.0.100",
        messages: [msgs[0]!, msgs[1]!, msgs[2]!, earlyBarrier],
        expectedRunId: meta.runId,
        expectedTenderId: meta.tenderId,
        expectedTenderVersion: 1,
        expectedTenderHash: TENDER_HASH,
      }),
    ).toThrow(/not after auctionEndsAt/);
  });

  it("rejects wrong expected commitment count", () => {
    const msgs = buildHappyPath();
    const open = msgs[0]!;
    const cA = msgs[1]!;
    const badBarrierEnv = createCloseBarrierEnvelope({
      ...meta,
      createdAt: "2026-07-15T12:01:05.000Z",
      payload: {
        barrierId: "barrier-bad-count",
        tenderId: meta.tenderId,
        tenderVersion: 1,
        tenderHash: TENDER_HASH,
        auctionEndsAt: "2026-07-15T12:01:00.000Z",
        expectedCommitmentCount: 1,
        commitmentEnvelopeHashes: [cA.envelopeHash],
        closePolicy: CLOSE_POLICY,
      },
    });
    // only one commitment before barrier
    const barrier = observed(3, badBarrierEnv, "2026-07-15T12:01:05.100Z");
    expect(() =>
      reconcileMirrorMessages({
        topicId: "0.0.100",
        messages: [open, cA, barrier],
        expectedRunId: meta.runId,
        expectedTenderId: meta.tenderId,
        expectedTenderVersion: 1,
        expectedTenderHash: TENDER_HASH,
        expectedCommitmentCount: 2,
      }),
    ).toThrow(/BID_COMMITMENT|expectedCommitmentCount/i);
  });

  it("rejects wrong commitment-envelope hash list", () => {
    const msgs = buildHappyPath();
    const badBarrierEnv = createCloseBarrierEnvelope({
      ...meta,
      createdAt: "2026-07-15T12:01:05.000Z",
      payload: {
        barrierId: "barrier-bad-hash",
        tenderId: meta.tenderId,
        tenderVersion: 1,
        tenderHash: TENDER_HASH,
        auctionEndsAt: "2026-07-15T12:01:00.000Z",
        expectedCommitmentCount: 2,
        commitmentEnvelopeHashes: [
          canonicalSha256({ wrong: 1 }),
          canonicalSha256({ wrong: 2 }),
        ],
        closePolicy: CLOSE_POLICY,
      },
    });
    const barrier = observed(4, badBarrierEnv, "2026-07-15T12:01:05.100Z");
    expect(() =>
      reconcileMirrorMessages({
        topicId: "0.0.100",
        messages: [msgs[0]!, msgs[1]!, msgs[2]!, barrier],
        expectedRunId: meta.runId,
        expectedTenderId: meta.tenderId,
        expectedTenderVersion: 1,
        expectedTenderHash: TENDER_HASH,
      }),
    ).toThrow(/commitmentEnvelopeHashes/);
  });
});
