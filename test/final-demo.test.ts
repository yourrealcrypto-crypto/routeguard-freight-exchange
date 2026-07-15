/**
 * Phase 6B.2 final-demo offline tests — no live network writes.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertSafeToStartFinalDemoLive,
  claimMessageOutbox,
  claimTopicCreate,
  confirmMessageOutbox,
  createFinalDemoAttempt,
  emptyMessageOutbox,
  finalizeTopicCreate,
  markTopicCreateAmbiguous,
  parseFinalDemoAttempt,
  persistFinalDemoAttempt,
  withFinalDemoAttemptUpdate,
} from "../src/final-demo/attempt-store";
import {
  CONFIRM_FINAL_DEMO_VALUE,
  FINAL_DEMO_MODE_LIVE,
  FINAL_DEMO_PAYER_ACCOUNT,
  FINAL_DEMO_USDC_AMOUNT_ATOMIC,
  FINAL_DEMO_USDC_TOKEN,
  FINAL_DEMO_WINNER_ACCOUNT,
  HISTORICAL_PHASE5_TOPIC_ID,
  HISTORICAL_TOPIC_DISCLOSURE,
} from "../src/final-demo/constants";
import { runFinalDemoDryRun } from "../src/final-demo/dry-run";
import { FinalDemoError } from "../src/final-demo/errors";
import {
  assertFinalDemoLiveAuthorized,
  isFinalDemoDryRun,
} from "../src/final-demo/guards";
import {
  assertPaymentPayloadNotPersisted,
  assertFinalDemoLiveReady,
  rejectDirectSettlement,
  rejectHistoricalTopic,
  runFinalDemoLiveExecution,
} from "../src/final-demo/live-execution";
import {
  cloneMaterials,
  generateFinalDemoAuthoritativeMaterials,
  loadFinalDemoAuthoritativeMaterials,
  parseFinalDemoAuthoritativeMaterials,
} from "../src/final-demo/materials";
import { MockFinalDemoNetwork } from "../src/final-demo/mock-network";
import {
  doubleReconstructFinalDemoProof,
  reconstructFinalDemoProof,
} from "../src/final-demo/proof";
import {
  assertMirrorReadyForSequence,
  observedFromEnvelope,
  reconcileFinalDemoSequences1to4,
} from "../src/final-demo/reconciliation";
import {
  assertNoPrivateKeyFields,
  runSecretScan,
} from "../src/final-demo/secret-scan";
import { loadFinalAuctionTemplate } from "../src/final-demo/template";
import {
  assertBarrierAfterAuctionEnd,
  assertBarrierAfterDeadline,
  assertCommitmentBeforeDeadline,
  assertCommitmentTimeRemaining,
} from "../src/final-demo/timing";
import { createCloseBarrierEnvelope, envelopeHash } from "../src/hcs/message-envelope";
import { CLOSE_POLICY } from "../src/hcs/types";
import { bidHash } from "../src/domain/bid";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "final-demo-"));
  dirs.push(dir);
  return dir;
}

describe("Final demo — privacy", () => {
  it("public materials contain no private-key fields", () => {
    const dir = tempDir();
    const materialsPath = path.join(dir, "materials.json");
    const materials = generateFinalDemoAuthoritativeMaterials({
      materialsPath,
      persist: true,
      auctionWindowSeconds: 90,
      runBaseTime: "2026-08-01T12:00:00.000Z",
    });
    expect(() =>
      assertNoPrivateKeyFields(materials, "materials"),
    ).not.toThrow();
    const disk = JSON.parse(readFileSync(materialsPath, "utf8"));
    expect(() => assertNoPrivateKeyFields(disk, "disk")).not.toThrow();
    const text = JSON.stringify(disk);
    expect(text).not.toMatch(/privateKey/i);
    expect(text).not.toMatch(/PrivateKey/);
    expect(text).not.toMatch(/secretKey/i);
  });

  it("private keys never reach persisted objects after generation", () => {
    const dir = tempDir();
    const materials = generateFinalDemoAuthoritativeMaterials({
      materialsPath: path.join(dir, "m.json"),
      persist: true,
      runBaseTime: "2026-08-01T12:00:00.000Z",
    });
    // Only public keys present
    expect(materials.routeGuardPublicKey).toMatch(/^[0-9a-f]{66}$/);
    for (const c of materials.carriers) {
      expect(c.signingPublicKey).toMatch(/^[0-9a-f]{66}$/);
      expect(c).not.toHaveProperty("signingPrivateKeyHex");
    }
  });

  it("secret scanner catches injected private-key fields", () => {
    const dir = tempDir();
    const bad = path.join(dir, "evil.json");
    writeFileSync(
      bad,
      JSON.stringify({
        routeGuardPrivateKeyHex: "aa".repeat(32),
        note: "injected",
      }),
    );
    const result = runSecretScan({
      rootDir: dir,
      includeRoots: ["."],
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.path.includes("evil.json"))).toBe(
      true,
    );
  });

  it("hashes are not falsely classified as keys", () => {
    const dir = tempDir();
    const good = path.join(dir, "hashes.json");
    writeFileSync(
      good,
      JSON.stringify({
        tenderHash: "sha256:" + "ab".repeat(32),
        evaluatedBidSetHash: "sha256:" + "cd".repeat(32),
        publicNote: "ok",
      }),
    );
    const result = runSecretScan({
      rootDir: dir,
      includeRoots: ["."],
    });
    expect(result.ok).toBe(true);
  });
});

describe("Final demo — material generation", () => {
  it("synthetic package is complete and signatures verify", () => {
    const dir = tempDir();
    const materials = generateFinalDemoAuthoritativeMaterials({
      materialsPath: path.join(dir, "m.json"),
      persist: true,
      runBaseTime: "2026-08-01T12:00:00.000Z",
    });
    expect(materials.signedBids).toHaveLength(2);
    expect(materials.signedReceipts).toHaveLength(2);
    expect(materials.identifiers.tenderId).toMatch(/^tender-final-/);
    expect(materials.identifiers.bidAlphaId).toMatch(/^bid-alpha-final-/);
    expect(materials.identifiers.bidBetaId).toMatch(/^bid-beta-final-/);
    expect(materials.identifiers.reservationId).toMatch(
      /^reservation-final-/,
    );
    // Reload verifies signatures
    const reloaded = loadFinalDemoAuthoritativeMaterials(
      path.join(dir, "m.json"),
    );
    expect(reloaded.tenderHash).toBe(materials.tenderHash);
    expect(bidHash(reloaded.signedBids[0]!.bid)).toBe(
      materials.bidHashes.alpha,
    );
  });

  it("mutation of bid/salt/nonce/signature fails verification", () => {
    const dir = tempDir();
    const materials = generateFinalDemoAuthoritativeMaterials({
      materialsPath: path.join(dir, "m.json"),
      persist: true,
      runBaseTime: "2026-08-01T12:00:00.000Z",
    });
    const mutated = cloneMaterials(materials);
    mutated.signedBids[0] = {
      ...mutated.signedBids[0]!,
      bid: {
        ...mutated.signedBids[0]!.bid,
        commitmentSalt: "ff".repeat(32),
      },
    };
    expect(() => parseFinalDemoAuthoritativeMaterials(mutated)).toThrow(
      FinalDemoError,
    );

    const mutSig = cloneMaterials(materials);
    mutSig.signedBids[0] = {
      ...mutSig.signedBids[0]!,
      signature: "aa".repeat(64),
    };
    expect(() => parseFinalDemoAuthoritativeMaterials(mutSig)).toThrow(
      FinalDemoError,
    );
  });

  it("does not reuse historical tender/bid ids", () => {
    const dir = tempDir();
    const materials = generateFinalDemoAuthoritativeMaterials({
      materialsPath: path.join(dir, "m.json"),
      persist: true,
      runBaseTime: "2026-08-01T12:00:00.000Z",
    });
    const ids = JSON.stringify(materials.identifiers);
    expect(ids).not.toContain("tender-ham-ist-hcs-c8b3e38a");
    expect(ids).not.toContain("bid-a-b3e38a");
    expect(ids).not.toContain("bid-b-b3e38a");
  });
});

describe("Final demo — fresh topic", () => {
  it("exactly one topic-create claim; ambiguous does not retry", () => {
    let attempt = createFinalDemoAttempt({
      mode: FINAL_DEMO_MODE_LIVE,
      attemptId: "final-demo-test-1",
      shortAttemptId: "deadbeef",
      attemptPath: path.join(tempDir(), "a.json"),
    });
    attempt = claimTopicCreate(attempt, "claim-1");
    expect(attempt.topicCreateClaim.status).toBe("CLAIMED");
    expect(() => claimTopicCreate(attempt, "claim-2")).toThrow(/already claimed/i);

    const amb = markTopicCreateAmbiguous(attempt, "timeout");
    expect(amb.status).toBe("TOPIC_CREATE_AMBIGUOUS");
    expect(() => assertSafeToStartFinalDemoLive(amb)).toThrow(
      /ambiguous/i,
    );
  });

  it("no historical topic accepted", () => {
    expect(() => rejectHistoricalTopic(HISTORICAL_PHASE5_TOPIC_ID)).toThrow(
      FinalDemoError,
    );
    let attempt = createFinalDemoAttempt({
      mode: FINAL_DEMO_MODE_LIVE,
      attemptId: "x",
      shortAttemptId: "aabbccdd",
      attemptPath: path.join(tempDir(), "a.json"),
    });
    attempt = claimTopicCreate(attempt, "c");
    expect(() =>
      finalizeTopicCreate(attempt, {
        topicId: HISTORICAL_PHASE5_TOPIC_ID,
        topicCreateTransactionId: "tx",
        topicMemo: "bad",
        createdAt: new Date().toISOString(),
      }),
    ).toThrow(/Historical/i);
  });

  it("template has no hard-coded topic id", () => {
    const t = loadFinalAuctionTemplate();
    expect(t.dataClassification).toBe("PUBLIC_SYNTHETIC_DEMO");
    expect(JSON.stringify(t)).not.toContain('"0.0.9587459"');
  });
});

describe("Final demo — HCS ordering outbox", () => {
  it("only preceding confirmed message permits next claim", () => {
    let attempt = createFinalDemoAttempt({
      mode: FINAL_DEMO_MODE_LIVE,
      attemptId: "x",
      shortAttemptId: "11223344",
      attemptPath: path.join(tempDir(), "a.json"),
    });
    attempt = claimTopicCreate(attempt, "c");
    attempt = finalizeTopicCreate(attempt, {
      topicId: "0.0.9700001",
      topicCreateTransactionId: "tx-create",
      topicMemo: "routeguard-final:11223344",
      createdAt: new Date().toISOString(),
    });

    // Cannot claim seq2 before seq1
    expect(() =>
      claimMessageOutbox(attempt, "BID_COMMITMENT_ALPHA", {
        expectedTopic: "0.0.9700001",
        envelope: { mock: true },
        envelopeHash: "sha256:" + "11".repeat(32),
        encodedByteCount: 100,
        submitAttemptId: "s2",
      }),
    ).toThrow(/preceding/i);

    attempt = claimMessageOutbox(attempt, "AUCTION_OPEN", {
      expectedTopic: "0.0.9700001",
      envelope: { mock: true },
      envelopeHash: "sha256:" + "11".repeat(32),
      encodedByteCount: 100,
      submitAttemptId: "s1",
    });
    attempt = confirmMessageOutbox(attempt, "AUCTION_OPEN", {
      topicId: "0.0.9700001",
      sequence: 1,
      transactionId: "tx1",
      consensusTimestamp: "2026-08-01T12:00:01.000000000Z",
      envelopeHash: "sha256:" + "11".repeat(32),
    });

    // wrong sequence on confirm
    attempt = claimMessageOutbox(attempt, "BID_COMMITMENT_ALPHA", {
      expectedTopic: "0.0.9700001",
      envelope: { mock: true },
      envelopeHash: "sha256:" + "22".repeat(32),
      encodedByteCount: 100,
      submitAttemptId: "s2",
    });
    expect(() =>
      confirmMessageOutbox(attempt, "BID_COMMITMENT_ALPHA", {
        topicId: "0.0.9700001",
        sequence: 3,
        transactionId: "tx2",
        consensusTimestamp: "2026-08-01T12:00:02.000000000Z",
        envelopeHash: "sha256:" + "22".repeat(32),
      }),
    ).toThrow(/sequence/i);
  });

  it("ambiguous message does not auto-resubmit (claim blocks re-claim)", () => {
    let attempt = createFinalDemoAttempt({
      mode: FINAL_DEMO_MODE_LIVE,
      attemptId: "x",
      shortAttemptId: "99887766",
      attemptPath: path.join(tempDir(), "a.json"),
    });
    attempt = claimTopicCreate(attempt, "c");
    attempt = finalizeTopicCreate(attempt, {
      topicId: "0.0.9700002",
      topicCreateTransactionId: "tx",
      topicMemo: "m",
      createdAt: new Date().toISOString(),
    });
    attempt = claimMessageOutbox(attempt, "AUCTION_OPEN", {
      expectedTopic: "0.0.9700002",
      envelope: {},
      envelopeHash: "sha256:" + "aa".repeat(32),
      encodedByteCount: 10,
      submitAttemptId: "s",
    });
    expect(() =>
      claimMessageOutbox(attempt, "AUCTION_OPEN", {
        expectedTopic: "0.0.9700002",
        envelope: {},
        envelopeHash: "sha256:" + "aa".repeat(32),
        encodedByteCount: 10,
        submitAttemptId: "s2",
      }),
    ).toThrow(/already/i);
  });

  it("empty outbox has sequences 1–5", () => {
    const box = emptyMessageOutbox();
    expect(box.map((m) => m.expectedSequence)).toEqual([1, 2, 3, 4, 5]);
    expect(box.map((m) => m.logicalLabel)).toEqual([
      "AUCTION_OPEN",
      "BID_COMMITMENT_ALPHA",
      "BID_COMMITMENT_BETA",
      "AUCTION_CLOSE_BARRIER",
      "ROUTE_RESERVED",
    ]);
  });
});

describe("Final demo — auction timing", () => {
  it("commitments before deadline; late rejected; barrier rules", () => {
    const ends = "2026-08-01T12:01:30.000Z";
    const earlyMs = Date.parse("2026-08-01T12:00:30.000Z");
    expect(() =>
      assertCommitmentTimeRemaining(ends, earlyMs, 10_000),
    ).not.toThrow();
    const lateMs = Date.parse("2026-08-01T12:01:25.000Z");
    expect(() =>
      assertCommitmentTimeRemaining(ends, lateMs, 10_000),
    ).toThrow(/Insufficient time/i);

    expect(() =>
      assertCommitmentBeforeDeadline("2026-08-01T12:01:00.000Z", ends),
    ).not.toThrow();
    expect(() =>
      assertCommitmentBeforeDeadline("2026-08-01T12:02:00.000Z", ends),
    ).toThrow(/after auctionEndsAt/i);

    expect(() =>
      assertBarrierAfterAuctionEnd(ends, Date.parse("2026-08-01T12:01:00.000Z")),
    ).toThrow(/before auctionEndsAt/i);
    expect(() =>
      assertBarrierAfterAuctionEnd(ends, Date.parse("2026-08-01T12:01:31.000Z")),
    ).not.toThrow();

    expect(() =>
      assertBarrierAfterDeadline("2026-08-01T12:01:31.000Z", ends),
    ).not.toThrow();
    expect(() =>
      assertBarrierAfterDeadline("2026-08-01T12:01:00.000Z", ends),
    ).toThrow(/before auctionEndsAt/i);
  });
});

describe("Final demo — reconciliation and proof", () => {
  it("Mirror evidence is authoritative; double reconstruction matches", async () => {
    const dir = tempDir();
    const materials = generateFinalDemoAuthoritativeMaterials({
      materialsPath: path.join(dir, "m.json"),
      persist: true,
      runBaseTime: "2026-08-01T12:00:00.000Z",
      auctionWindowSeconds: 90,
    });
    const network = new MockFinalDemoNetwork({
      clockMs: Date.parse(materials.runBaseTime) + 1000,
    });
    const topic = await network.createTopic(
      `routeguard-final:${materials.shortAttemptId}`,
    );

    await network.submitMessage({
      topicId: topic.topicId,
      envelope: materials.auctionOpenEnvelope,
    });
    await network.submitMessage({
      topicId: topic.topicId,
      envelope: materials.commitmentPayloads.alpha,
    });
    await network.submitMessage({
      topicId: topic.topicId,
      envelope: materials.commitmentPayloads.beta,
    });
    network.setClock(Date.parse(materials.auctionEndsAt) + 5001);
    const barrier = createCloseBarrierEnvelope({
      runId: materials.runId,
      tenderId: materials.identifiers.tenderId,
      tenderVersion: materials.tenderBody.version,
      tenderHash: materials.tenderHash,
      createdAt: network.nowIso(),
      payload: {
        barrierId: materials.identifiers.barrierId,
        tenderId: materials.identifiers.tenderId,
        tenderVersion: materials.tenderBody.version,
        tenderHash: materials.tenderHash,
        auctionEndsAt: materials.auctionEndsAt,
        expectedCommitmentCount: 2,
        commitmentEnvelopeHashes: [
          materials.commitmentEnvelopeHashes.alpha,
          materials.commitmentEnvelopeHashes.beta,
        ],
        closePolicy: CLOSE_POLICY,
      },
    });
    await network.submitMessage({
      topicId: topic.topicId,
      envelope: barrier,
    });

    const msgs = network.listMessages(topic.topicId);
    const recon = reconcileFinalDemoSequences1to4(
      {
        topicId: topic.topicId,
        runId: materials.runId,
        tenderId: materials.identifiers.tenderId,
        tenderVersion: materials.tenderBody.version,
        tenderHash: materials.tenderHash,
        auctionEndsAt: materials.auctionEndsAt,
        messages: msgs,
        expectedCommitmentEnvelopeHashes: [
          materials.commitmentEnvelopeHashes.alpha,
          materials.commitmentEnvelopeHashes.beta,
        ],
      },
      materials,
    );
    expect(recon.reconciliationReference).toBe(
      `mirror:topic:${topic.topicId}:1-4`,
    );

    const { finalHashes, first } = doubleReconstructFinalDemoProof({
      materialsA: materials,
      materialsB: cloneMaterials(materials),
      reconciliation: recon,
    });
    expect(first.winningCarrierAccount).toBe(FINAL_DEMO_WINNER_ACCOUNT);
    expect(first.winningCarrierId).toBe("carrier-alpha");
    expect(finalHashes.evaluatedBidSetHash).toMatch(/^sha256:/);
    expect(finalHashes.decisionManifestHash).toMatch(/^sha256:/);

    // Mutated Mirror message fails
    const mutated = [...msgs];
    mutated[1] = {
      ...mutated[1]!,
      envelopeHash: "sha256:" + "ee".repeat(32),
    };
    expect(() =>
      reconcileFinalDemoSequences1to4(
        {
          topicId: topic.topicId,
          runId: materials.runId,
          tenderId: materials.identifiers.tenderId,
          tenderVersion: materials.tenderBody.version,
          tenderHash: materials.tenderHash,
          auctionEndsAt: materials.auctionEndsAt,
          messages: mutated,
          expectedCommitmentEnvelopeHashes: [
            materials.commitmentEnvelopeHashes.alpha,
            materials.commitmentEnvelopeHashes.beta,
          ],
        },
        materials,
      ),
    ).toThrow();

    // Wrong run fails
    expect(() =>
      reconcileFinalDemoSequences1to4(
        {
          topicId: topic.topicId,
          runId: "wrong-run",
          tenderId: materials.identifiers.tenderId,
          tenderVersion: materials.tenderBody.version,
          tenderHash: materials.tenderHash,
          auctionEndsAt: materials.auctionEndsAt,
          messages: msgs,
          expectedCommitmentEnvelopeHashes: [
            materials.commitmentEnvelopeHashes.alpha,
            materials.commitmentEnvelopeHashes.beta,
          ],
        },
        materials,
      ),
    ).toThrow(/Run ID/i);

    // Historical topic fails
    expect(() =>
      reconcileFinalDemoSequences1to4(
        {
          topicId: HISTORICAL_PHASE5_TOPIC_ID,
          runId: materials.runId,
          tenderId: materials.identifiers.tenderId,
          tenderVersion: materials.tenderBody.version,
          tenderHash: materials.tenderHash,
          auctionEndsAt: materials.auctionEndsAt,
          messages: msgs.map((m) => ({
            ...m,
            topicId: HISTORICAL_PHASE5_TOPIC_ID,
          })),
          expectedCommitmentEnvelopeHashes: [
            materials.commitmentEnvelopeHashes.alpha,
            materials.commitmentEnvelopeHashes.beta,
          ],
        },
        materials,
      ),
    ).toThrow(/Historical/i);

    // Public-ID match with altered material fails
    const altered = cloneMaterials(materials);
    altered.signedBids[0] = {
      ...altered.signedBids[0]!,
      bid: {
        ...altered.signedBids[0]!.bid,
        freightPriceCents: 999999,
      },
      // keep old signature → parse fails
    };
    expect(() =>
      reconstructFinalDemoProof({ materials: altered, reconciliation: recon }),
    ).toThrow();
  });

  it("mirror ready rejects gaps and unexpected sequences", () => {
    const open = observedFromEnvelope({
      topicId: "0.0.9700099",
      sequence: 1,
      envelope: {
        schemaVersion: "routeguard-hcs-1.0",
        messageType: "AUCTION_OPEN",
        runId: "r1",
        tenderId: "t1",
        tenderVersion: 1,
        tenderHash: "sha256:" + "11".repeat(32),
        createdAt: "2026-08-01T12:00:00.000Z",
        payloadHash: "sha256:" + "22".repeat(32),
        payload: {
          tenderId: "t1",
          tenderVersion: 1,
          tenderHash: "sha256:" + "11".repeat(32),
          auctionEndsAt: "2026-08-01T12:01:30.000Z",
          selectionPolicy: "LOWEST_QUALIFIED_PRICE_V1",
          engineVersion: "routeguard-auction-1.0",
          rulesHash: "sha256:" + "33".repeat(32),
        },
      },
      envelopeHash: "sha256:" + "44".repeat(32),
      consensusTimestamp: "2026-08-01T12:00:01.000000000Z",
    });
    expect(() =>
      assertMirrorReadyForSequence([open], 2, {
        topicId: "0.0.9700099",
        runId: "r1",
        tenderId: "t1",
      }),
    ).not.toThrow();
    expect(() =>
      assertMirrorReadyForSequence([open], 3, {
        topicId: "0.0.9700099",
        runId: "r1",
        tenderId: "t1",
      }),
    ).toThrow(/does not permit/i);
  });
});

describe("Final demo — payment and live guards", () => {
  it("USDC only; exact payer/receiver/token/amount; no direct settle", () => {
    expect(FINAL_DEMO_PAYER_ACCOUNT).toBe("0.0.9197513");
    expect(FINAL_DEMO_WINNER_ACCOUNT).toBe("0.0.9215954");
    expect(FINAL_DEMO_USDC_TOKEN).toBe("0.0.429274");
    expect(FINAL_DEMO_USDC_AMOUNT_ATOMIC).toBe("10000");
    expect(() => rejectDirectSettlement()).toThrow(/ReservationService/i);
  });

  it("confirmation phrase alone is never sufficient", () => {
    expect(() =>
      assertFinalDemoLiveAuthorized({
        confirmFinalDemo: CONFIRM_FINAL_DEMO_VALUE,
      }),
    ).toThrow();
    expect(
      isFinalDemoDryRun({
        CONFIRM_FINAL_DEMO: CONFIRM_FINAL_DEMO_VALUE,
      }),
    ).toBe(true);
  });

  it("all live flags required", () => {
    expect(() =>
      assertFinalDemoLiveAuthorized({
        enableFinalDemoLive: "true",
        enableLiveHedera: "true",
        enableLiveUsdcPayments: "true",
        enableLiveHcsWrites: "true",
        enableLiveTopicCreate: "true",
        enablePhase6bLiveExecute: "true",
        confirmFinalDemo: CONFIRM_FINAL_DEMO_VALUE,
      }),
    ).not.toThrow();
  });

  it("live execution blocked without audit; payment payload not persisted", async () => {
    await expect(
      runFinalDemoLiveExecution({
        skipEnvLiveGuard: true,
        skipSecretScan: true,
        attemptPath: path.join(tempDir(), "live-attempt.json"),
      }),
    ).rejects.toMatchObject({ code: "LIVE_PATH_REQUIRES_AUDIT" });

    expect(() =>
      assertPaymentPayloadNotPersisted({
        ok: true,
        paymentPayload: { x: 1 },
      }),
    ).toThrow(/must not be persisted/i);
  });

  it("mock payment allows only one submission", async () => {
    const net = new MockFinalDemoNetwork();
    await net.mockPaymentSettle();
    await expect(net.mockPaymentSettle()).rejects.toThrow(/second settle/i);
  });
});

describe("Final demo — recovery and evidence", () => {
  it("side-effect-started live attempt blocks second start", () => {
    const dir = tempDir();
    const p = path.join(dir, "live.json");
    let attempt = createFinalDemoAttempt({
      mode: FINAL_DEMO_MODE_LIVE,
      attemptId: "a",
      shortAttemptId: "abcd1234",
      attemptPath: p,
    });
    attempt = claimTopicCreate(attempt, "c");
    persistFinalDemoAttempt(attempt, p);
    const loaded = parseFinalDemoAttempt(
      JSON.parse(readFileSync(p, "utf8")),
    );
    expect(() => assertSafeToStartFinalDemoLive(loaded)).toThrow(
      /Topic create already/i,
    );
  });

  it("dry-run produces full evidence without secrets or historical authority", async () => {
    const dir = tempDir();
    const result = await runFinalDemoDryRun({
      workDir: dir,
      skipSecretScan: true,
      runBaseTime: "2026-08-01T12:00:00.000Z",
      auctionWindowSeconds: 90,
    });
    expect(result.mode).toBe("OFFLINE_DRY_RUN");
    expect(result.finalState).toBe("COMPLETED");
    expect(result.networkWrites.realNetwork).toBe(false);
    expect(result.sequences).toHaveLength(5);
    expect(result.sequences.map((s) => s.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(result.topic.topicId).not.toBe(HISTORICAL_PHASE5_TOPIC_ID);
    expect(result.winner.carrierAccount).toBe(FINAL_DEMO_WINNER_ACCOUNT);
    expect(result.payment.selectedOptionId).toBe("USDC");
    expect(result.payment.payer).toBe(FINAL_DEMO_PAYER_ACCOUNT);
    expect(result.payment.receiver).toBe(FINAL_DEMO_WINNER_ACCOUNT);
    expect(result.payment.token).toBe(FINAL_DEMO_USDC_TOKEN);
    expect(result.payment.amount).toBe(FINAL_DEMO_USDC_AMOUNT_ATOMIC);
    expect(result.routeReserved.sequence).toBe(5);
    expect(result.dryRunEnvelopeByteCount).toBeLessThanOrEqual(1024);
    expect(result.conservativeEnvelopeByteCount).toBeLessThanOrEqual(1024);
    expect(result.historicalTopicDisclosure).toBe(HISTORICAL_TOPIC_DISCLOSURE);
    expect(result.reconciliationReference).toContain(result.topic.topicId);
    expect(result.reconciliationReference).not.toContain(
      HISTORICAL_PHASE5_TOPIC_ID,
    );

    const json = JSON.parse(
      readFileSync(path.join(dir, "final-demo-dry-run.json"), "utf8"),
    );
    expect(() => assertNoPrivateKeyFields(json, "dry-run")).not.toThrow();
    expect(JSON.stringify(json)).not.toMatch(/privateKey/i);

    // Dry-run file names distinct from live
    expect(result.evidencePaths.attempt).toContain("dry-run");
    expect(result.attempt.mode).toBe("OFFLINE_DRY_RUN");
  });

  it("dry-run and live attempt kinds cannot be confused", () => {
    const dry = createFinalDemoAttempt({
      mode: "OFFLINE_DRY_RUN",
      attemptId: "d",
      shortAttemptId: "dddddddd",
      attemptPath: path.join(tempDir(), "dry.json"),
    });
    expect(() => assertSafeToStartFinalDemoLive(dry)).toThrow(
      /non-LIVE/i,
    );
  });
});

describe("Final demo — mock topic create budget", () => {
  it("refuses second topic create", async () => {
    const net = new MockFinalDemoNetwork();
    await net.createTopic("a");
    await expect(net.createTopic("b")).rejects.toThrow(/second topic/i);
  });
});
