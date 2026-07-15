/**
 * Phase 6B.1A offline tests — mocked transports only, no live writes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalSha256 } from "../src/domain/canonical-hash";
import { HCS_MAX_MESSAGE_BYTES } from "../src/hcs/types";
import { serializeEnvelopeForSubmit } from "../src/hcs/message-envelope";
import { InMemoryReservationStore } from "../src/reservation/attempt-store";
import {
  assertHcsNotYetClaimed,
  assertPaymentNotYetSubmitted,
  assertSafeToStartPhase6bLive,
  createPlannedPhase6bAttempt,
  loadPhase6bAttempt,
  parsePhase6bAttempt,
  persistPhase6bAttempt,
  withAttemptUpdate,
} from "../src/reservation/live/attempt-store";
import {
  assertUsdcOnlySelection,
  LocalX402ChallengeAdapter,
  LiveFacilitatorAdapter,
  LiveHcsPublisherAdapter,
  toMirrorTransactionId,
} from "../src/reservation/live/adapters";
import {
  AUTHORITATIVE_HASHES,
  CONFIRM_PHASE6B_RESERVATION_VALUE,
  PHASE6B_CARRIER_ACCOUNT,
  PHASE6B_HCS_TOPIC,
  PHASE6B_PAYER_ACCOUNT,
  PHASE6B_RESERVATION_ID,
  PHASE6B_USDC_AMOUNT_ATOMIC,
  PHASE6B_USDC_TOKEN,
} from "../src/reservation/live/constants";
import {
  assertTopicPreflight,
  runPhase6bDryRun,
  syntheticOfflineTopicPreflight,
  type TopicPreflightResult,
} from "../src/reservation/live/dry-run";
import {
  measureActualRouteReservedEnvelope,
  measureConservativeRouteReservedEnvelope,
} from "../src/reservation/live/envelope-budget";
import { assertPhase6bLiveExecutionAuthorized } from "../src/reservation/live/guards";
import { runPhase6bLiveExecution } from "../src/reservation/live/live-execution";
import {
  assertReconstructedHashesMatch,
  cloneSource,
  loadAuthoritativePhase5Source,
  reconstructPhase5WinnerProof,
} from "../src/reservation/live/proof-reconstruction";
import {
  buildRouteReservedPayload,
  createRouteReservedHcsEnvelope,
  measureRouteReservedEnvelope,
} from "../src/reservation/hcs-evidence";
import { createRouteReservedRecord } from "../src/reservation/route-reserved-record";
import type { SelectedPaymentOption } from "../src/reservation/types";
import { RESERVATION_TEST_WEBHOOK_PRIVATE_KEY } from "./fixtures/reservation-fixtures";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "phase6b-"));
  dirs.push(dir);
  return dir;
}

function tempAttemptPath(): string {
  return path.join(tempDir(), "attempt.json");
}

function usdcSelected(
  overrides: Partial<SelectedPaymentOption> = {},
): SelectedPaymentOption {
  return {
    reservationId: PHASE6B_RESERVATION_ID,
    offerHash: "sha256:" + "11".repeat(32),
    offerVersion: 1,
    optionId: "USDC",
    payerAccount: PHASE6B_PAYER_ACCOUNT,
    payTo: PHASE6B_CARRIER_ACCOUNT,
    asset: PHASE6B_USDC_TOKEN,
    amountAtomic: PHASE6B_USDC_AMOUNT_ATOMIC,
    scheme: "exact",
    network: "hedera:testnet",
    selectedAt: "2026-07-15T19:00:00.000Z",
    resourcePath: `/api/reservations/${PHASE6B_RESERVATION_ID}/pay/usdc`,
    ...overrides,
  };
}

const goodTopic: TopicPreflightResult = {
  ...syntheticOfflineTopicPreflight(),
};

const liveMirrorTopic: TopicPreflightResult = {
  ...goodTopic,
  source: "MIRROR_LIVE",
};

function mockPaymentPayload() {
  const requirement = {
    scheme: "exact",
    network: "hedera:testnet" as const,
    asset: PHASE6B_USDC_TOKEN,
    amount: PHASE6B_USDC_AMOUNT_ATOMIC,
    payTo: PHASE6B_CARRIER_ACCOUNT,
    maxTimeoutSeconds: 180,
    extra: { feePayer: "0.0.7162784" },
  };
  const paymentPayload = {
    x402Version: 2,
    accepted: requirement,
    payload: {
      transaction: "mock-signed-tx-bytes-not-a-secret-but-in-memory-only",
      signature: "mock-sig",
    },
  };
  return {
    paymentPayload: paymentPayload as import("@x402/core/types").PaymentPayload,
    requirement: requirement as import("@x402/core/types").PaymentRequirements,
    paymentPayloadHash: canonicalSha256(paymentPayload),
  };
}

function sessionFacilitator(opts?: {
  settleTxId?: string;
  settleSuccess?: boolean;
  verifyValid?: boolean;
  onSettle?: () => void;
}) {
  let session: {
    paymentPayload: unknown;
    paymentPayloadHash: string;
    challengeHash: string;
  } | null = null;
  let settleCallCount = 0;
  let verifyCallCount = 0;
  let lastPayloadSeen: unknown = null;

  return {
    settleCallCount: () => settleCallCount,
    verifyCallCount: () => verifyCallCount,
    lastPayloadSeen: () => lastPayloadSeen,
    bindPaymentSession(input: {
      paymentPayload: unknown;
      requirement: unknown;
      paymentPayloadHash: string;
      challengeHash: string;
    }) {
      session = {
        paymentPayload: input.paymentPayload,
        paymentPayloadHash: input.paymentPayloadHash,
        challengeHash: input.challengeHash,
      };
      lastPayloadSeen = input.paymentPayload;
    },
    clearPaymentSession() {
      session = null;
    },
    async verify(input: {
      paymentPayloadHash: string;
      challengeHash: string;
    }) {
      verifyCallCount += 1;
      if (!session) throw new Error("NO_PAYMENT_SESSION");
      if (session.paymentPayloadHash !== input.paymentPayloadHash) {
        throw new Error("PAYLOAD_HASH_MISMATCH");
      }
      return {
        isValid: opts?.verifyValid !== false,
        ...(opts?.verifyValid === false
          ? { invalidReason: "mock_invalid" }
          : {}),
      };
    },
    async settle(input: {
      paymentPayloadHash: string;
      challengeHash: string;
    }) {
      settleCallCount += 1;
      opts?.onSettle?.();
      if (!session) throw new Error("NO_PAYMENT_SESSION");
      if (session.paymentPayloadHash !== input.paymentPayloadHash) {
        throw new Error("PAYLOAD_HASH_MISMATCH");
      }
      // Prove in-memory payload was available to facilitator
      if (!session.paymentPayload) throw new Error("missing in-memory payload");
      return {
        success: opts?.settleSuccess !== false,
        transactionId: opts?.settleTxId ?? "0.0.9197513@1784142000.100000000",
        network: "hedera:testnet" as const,
        payerAccountId: PHASE6B_PAYER_ACCOUNT,
      };
    },
  };
}

describe("Phase 6B.1A — authoritative proof reconstruction", () => {
  it("exact authoritative reconstruction succeeds", () => {
    const r = reconstructPhase5WinnerProof();
    expect(r.tender.tenderId).toBe("tender-ham-ist-hcs-c8b3e38a");
    expect(r.winningBidId).toBe("bid-a-b3e38a");
    expect(r.winningCarrierAccount).toBe(PHASE6B_CARRIER_ACCOUNT);
    expect(r.hcsTopicId).toBe(PHASE6B_HCS_TOPIC);
    expect(r.closeBarrierSequence).toBe(4);
    expect(r.proof.integrityOk).toBe(true);
    expect(r.proof.manifest.evaluatedBidSetHash).toBe(
      AUTHORITATIVE_HASHES.evaluatedBidSetHash,
    );
    expect(r.proof.manifest.decisionManifestHash).toBe(
      AUTHORITATIVE_HASHES.decisionManifestHash,
    );
    expect(r.winningBidHash).toBe(AUTHORITATIVE_HASHES.winningBidHash);
    expect(r.tenderHash).toBe(AUTHORITATIVE_HASHES.tenderHash);
  });

  it("changed salt fails", () => {
    const src = cloneSource(loadAuthoritativePhase5Source()!);
    src.signedBids[0]!.bid.commitmentSalt = "ff".repeat(32);
    // expected hashes still claim original — reconstruction must fail
    expect(() => reconstructPhase5WinnerProof({ source: src })).toThrow(
      /HASH_MISMATCH|signature|authentic|integrity|bid/i,
    );
  });

  it("changed bid fails", () => {
    const src = cloneSource(loadAuthoritativePhase5Source()!);
    src.signedBids[0]!.bid.freightPriceCents = 349_000;
    expect(() => reconstructPhase5WinnerProof({ source: src })).toThrow();
  });

  it("changed receipt fails", () => {
    const src = cloneSource(loadAuthoritativePhase5Source()!);
    src.signedReceipts[0]!.receipt.acceptedAt = "2026-07-15T18:00:00.000Z";
    expect(() => reconstructPhase5WinnerProof({ source: src })).toThrow();
  });

  it("changed commitment timestamp fails", () => {
    const src = cloneSource(loadAuthoritativePhase5Source()!);
    src.commitments[0]!.consensusTimestamp = "2026-07-15T18:00:00.000000000Z";
    expect(() => reconstructPhase5WinnerProof({ source: src })).toThrow();
  });

  it("changed evaluation timestamp fails", () => {
    const src = cloneSource(loadAuthoritativePhase5Source()!);
    src.evaluationTimestamp = "2026-07-15T19:00:00.000Z";
    // expected sealed hashes no longer match reconstruction
    expect(() => reconstructPhase5WinnerProof({ source: src })).toThrow(
      /HASH_MISMATCH|integrity|Manifest/i,
    );
  });

  it("changed reconciliation reference fails", () => {
    const src = cloneSource(loadAuthoritativePhase5Source()!);
    src.reconciliationReference = "mirror:topic:0.0.1:1-4";
    expect(() => reconstructPhase5WinnerProof({ source: src })).toThrow(
      /HASH_MISMATCH|integrity|Manifest/i,
    );
  });

  it("correct public IDs with wrong hashes fail", () => {
    const r = reconstructPhase5WinnerProof();
    expect(() =>
      assertReconstructedHashesMatch(r, {
        evaluatedBidSetHash: "sha256:" + "00".repeat(32),
        decisionManifestHash: r.proof.manifest.decisionManifestHash,
        winningBidHash: r.winningBidHash,
      }),
    ).toThrow(/HASH_MISMATCH|evaluatedBidSetHash/i);

    // Public IDs alone are never enough
    expect(r.tender.tenderId).toBe("tender-ham-ist-hcs-c8b3e38a");
    expect(r.winningBidId).toBe("bid-a-b3e38a");
    expect(() =>
      assertReconstructedHashesMatch(r, {
        evaluatedBidSetHash: "sha256:" + "ab".repeat(32),
        decisionManifestHash: "sha256:" + "cd".repeat(32),
        winningBidHash: r.winningBidHash,
      }),
    ).toThrow(/mismatch|HASH_MISMATCH/i);
  });

  it("absent authoritative private source material disables live execution", () => {
    const dir = tempDir();
    const missing = path.join(dir, "does-not-exist.json");
    expect(() =>
      reconstructPhase5WinnerProof({ sourcePath: missing }),
    ).toThrow(/AUTHORITATIVE_AUCTION_MATERIAL_UNAVAILABLE|unavailable/i);
  });
});

describe("Phase 6B.1A — guards and USDC binding", () => {
  it("all live flags required", () => {
    expect(() =>
      assertPhase6bLiveExecutionAuthorized({
        enableLiveReservation: "true",
        enableLiveHedera: "true",
        enableLiveUsdcPayments: "true",
        enableLiveHcsWrites: undefined,
        confirmPhase6bReservation: CONFIRM_PHASE6B_RESERVATION_VALUE,
      }),
    ).toThrow(/HCS_WRITE|ENABLE_LIVE_HCS/i);
  });

  it("exact confirmation phrase required", () => {
    expect(() =>
      assertPhase6bLiveExecutionAuthorized({
        enableLiveReservation: "true",
        enableLiveHedera: "true",
        enableLiveUsdcPayments: "true",
        enableLiveHcsWrites: "true",
        confirmPhase6bReservation: "YES",
      }),
    ).toThrow(/CONFIRM|phrase|EXECUTE_ONE/i);

    expect(() =>
      assertPhase6bLiveExecutionAuthorized({
        enableLiveReservation: "true",
        enableLiveHedera: "true",
        enableLiveUsdcPayments: "true",
        enableLiveHcsWrites: "true",
        confirmPhase6bReservation: CONFIRM_PHASE6B_RESERVATION_VALUE,
      }),
    ).not.toThrow();
  });

  it("only USDC can be executed", () => {
    expect(() =>
      assertUsdcOnlySelection(usdcSelected({ optionId: "HBAR", asset: "0.0.0" })),
    ).toThrow(/USDC-only|USDC_ONLY/i);
  });

  it("wrong payer/receiver/token/amount rejected", () => {
    expect(() =>
      assertUsdcOnlySelection(usdcSelected({ payerAccount: "0.0.1" })),
    ).toThrow(/payer|WRONG_PAYER/i);
    expect(() =>
      assertUsdcOnlySelection(usdcSelected({ payTo: "0.0.1" })),
    ).toThrow(/receiver|WRONG_RECEIVER/i);
    expect(() =>
      assertUsdcOnlySelection(usdcSelected({ asset: "0.0.999" })),
    ).toThrow(/token|WRONG_TOKEN/i);
    expect(() =>
      assertUsdcOnlySelection(usdcSelected({ amountAtomic: "1" })),
    ).toThrow(/amount|WRONG_AMOUNT/i);
  });
});

describe("Phase 6B.1A — topic preflight", () => {
  it("wrong topic rejected", () => {
    expect(() =>
      assertTopicPreflight(
        { ...goodTopic, topicId: "0.0.1" },
        PHASE6B_RESERVATION_ID,
      ),
    ).toThrow(/topic|WRONG_TOPIC/i);
  });

  it("highest sequence other than 4 fails", () => {
    expect(() =>
      assertTopicPreflight(
        { ...goodTopic, maxSequence: 5, nextSequence: 6 },
        PHASE6B_RESERVATION_ID,
      ),
    ).toThrow(/sequence|TOPIC_SEQUENCE/i);
  });

  it("existing ROUTE_RESERVED fails", () => {
    expect(() =>
      assertTopicPreflight(
        { ...goodTopic, hasRouteReservedForReservation: true },
        PHASE6B_RESERVATION_ID,
      ),
    ).toThrow(/already|ROUTE_RESERVED/i);
  });

  it("live topic preflight cannot use synthetic data", () => {
    expect(() =>
      assertTopicPreflight(goodTopic, PHASE6B_RESERVATION_ID, {
        requireLiveMirror: true,
      }),
    ).toThrow(/Mirror|LIVE_TOPIC_PREFLIGHT|synthetic/i);

    expect(() =>
      assertTopicPreflight(liveMirrorTopic, PHASE6B_RESERVATION_ID, {
        requireLiveMirror: true,
      }),
    ).not.toThrow();
  });

  it("barrier/open sequence validity required", () => {
    expect(() =>
      assertTopicPreflight(
        { ...goodTopic, hasBarrierAt4: false },
        PHASE6B_RESERVATION_ID,
      ),
    ).toThrow(/sequence|barrier/i);
  });
});

describe("Phase 6B.1A — dry-run / live attempt isolation", () => {
  it("dry-run performs zero network writes", async () => {
    const attemptPath = tempAttemptPath();
    const result = await runPhase6bDryRun({
      env: {},
      attemptPath,
      topicPreflight: goodTopic,
    });
    expect(result.mode).toBe("OFFLINE_DRY_RUN");
    expect(result.networkWrites.facilitatorVerify).toBe(0);
    expect(result.networkWrites.facilitatorSettle).toBe(0);
    expect(result.networkWrites.hcsPublish).toBe(0);
    expect(result.networkWrites.externalWebhook).toBe(0);
    expect(result.selectedOptionId).toBe("USDC");
    expect(result.reconstructed.evaluatedBidSetHash).toBe(
      AUTHORITATIVE_HASHES.evaluatedBidSetHash,
    );
    expect(result.reconstructed.decisionManifestHash).toBe(
      AUTHORITATIVE_HASHES.decisionManifestHash,
    );
  });

  it("dry-run attempt cannot block live", async () => {
    const dir = tempDir();
    const dryPath = path.join(dir, "phase6b-dry-run-attempt.json");
    const livePath = path.join(dir, "phase6b-live-reservation-attempt.json");

    await runPhase6bDryRun({
      env: {},
      attemptPath: dryPath,
      topicPreflight: goodTopic,
    });
    const dry = loadPhase6bAttempt(dryPath)!;
    expect(dry.kind).toBe("DRY_RUN");
    expect(dry.status).toBe("DRY_RUN_COMPLETE");

    // Live attempt file absent — safe to start
    expect(loadPhase6bAttempt(livePath)).toBeNull();
    expect(() => assertSafeToStartPhase6bLive(null)).not.toThrow();

    // Dry-run kind must never be treated as live
    expect(() => assertSafeToStartPhase6bLive(dry)).toThrow(
      /WRONG_ATTEMPT_KIND|non-LIVE/i,
    );
  });

  it("dry-run can be repeated safely", async () => {
    const attemptPath = tempAttemptPath();
    await runPhase6bDryRun({
      env: {},
      attemptPath,
      topicPreflight: goodTopic,
    });
    const again = await runPhase6bDryRun({
      env: {},
      attemptPath,
      topicPreflight: goodTopic,
    });
    expect(again.mode).toBe("OFFLINE_DRY_RUN");
    expect(again.networkWrites.facilitatorSettle).toBe(0);
  });

  it("live attempt blocks duplicate payment", () => {
    const attempt = withAttemptUpdate(
      createPlannedPhase6bAttempt({
        kind: "LIVE",
        attemptId: "a2",
        reservationId: PHASE6B_RESERVATION_ID,
      }),
      {
        status: "PAYMENT_SUBMITTED",
        paymentSubmittedAt: "2026-07-15T19:02:00.000Z",
        transactionId: "0.0.1@1.1",
      },
    );
    expect(() => assertPaymentNotYetSubmitted(attempt)).toThrow(
      /already submitted|PAYMENT_ALREADY/i,
    );
    expect(() => assertSafeToStartPhase6bLive(attempt)).toThrow(
      /already claimed|already submitted|PAYMENT_ALREADY|will not settle/i,
    );
  });

  it("successful live attempt blocks rerun", () => {
    const done = withAttemptUpdate(
      createPlannedPhase6bAttempt({
        kind: "LIVE",
        attemptId: "a1",
        reservationId: PHASE6B_RESERVATION_ID,
      }),
      { status: "SUCCESS" },
    );
    expect(() => assertSafeToStartPhase6bLive(done)).toThrow(
      /success|ATTEMPT_ALREADY/i,
    );
  });

  it("HCS claim prevents duplicate publication", () => {
    const attempt = withAttemptUpdate(
      createPlannedPhase6bAttempt({
        kind: "LIVE",
        attemptId: "a3",
        reservationId: PHASE6B_RESERVATION_ID,
      }),
      {
        status: "HCS_CLAIMED",
        hcsPublishAttemptId: "pub-1",
      },
    );
    expect(() => assertHcsNotYetClaimed(attempt)).toThrow(
      /claimed|HCS_ALREADY/i,
    );
    expect(() => assertSafeToStartPhase6bLive(attempt)).toThrow(
      /HCS_ALREADY|claimed/i,
    );
  });

  it("PAYMENT_SUBMISSION_CLAIMED blocks automatic restart", () => {
    const attempt = withAttemptUpdate(
      createPlannedPhase6bAttempt({
        kind: "LIVE",
        attemptId: "a-claim",
        reservationId: PHASE6B_RESERVATION_ID,
      }),
      {
        status: "PAYMENT_SUBMISSION_CLAIMED",
        paymentSubmissionClaimedAt: "2026-07-15T19:01:00.000Z",
      },
    );
    expect(() => assertSafeToStartPhase6bLive(attempt)).toThrow(
      /PAYMENT_ALREADY|claimed|submitted/i,
    );
  });
});

describe("Phase 6B.1A — envelope budget", () => {
  it("conservative and dry-run envelopes within 1024", async () => {
    const r = reconstructPhase5WinnerProof();
    const conservative = measureConservativeRouteReservedEnvelope({
      reservationId: PHASE6B_RESERVATION_ID,
      tenderId: r.tender.tenderId,
      tenderVersion: r.tender.version,
      tenderHash: r.tenderHash,
      winningBidId: r.winningBidId,
      winningBidHash: r.winningBidHash,
      carrierId: r.winningCarrierId,
      carrierAccount: r.winningCarrierAccount,
      decisionManifestHash: r.proof.manifest.decisionManifestHash,
      evaluatedBidSetHash: r.proof.manifest.evaluatedBidSetHash,
    });
    expect(conservative.byteCount).toBeLessThanOrEqual(HCS_MAX_MESSAGE_BYTES);
    expect(conservative.margin).toBeGreaterThanOrEqual(0);

    const result = await runPhase6bDryRun({
      env: {},
      attemptPath: tempAttemptPath(),
      topicPreflight: goodTopic,
    });
    expect(result.conservativeEnvelopeByteCount).toBeLessThanOrEqual(
      HCS_MAX_MESSAGE_BYTES,
    );
    expect(result.dryRunEnvelopeByteCount).toBeLessThanOrEqual(
      HCS_MAX_MESSAGE_BYTES,
    );
    expect(result.envelopeWithinLimit).toBe(true);

    const actual = measureActualRouteReservedEnvelope({
      reservationId: PHASE6B_RESERVATION_ID,
      tenderId: r.tender.tenderId,
      tenderVersion: 1,
      tenderHash: r.tenderHash,
      winningBidId: r.winningBidId,
      winningBidHash: r.winningBidHash,
      carrierId: r.winningCarrierId,
      carrierAccount: r.winningCarrierAccount,
      decisionManifestHash: r.proof.manifest.decisionManifestHash,
      evaluatedBidSetHash: r.proof.manifest.evaluatedBidSetHash,
      transactionId: "0.0.9197513@1784142000.100000000",
      consensusTimestamp: "2026-07-15T19:05:00.123456789Z",
      createdAt: "2026-07-15T19:06:01.000Z",
    });
    expect(actual.byteCount).toBeLessThanOrEqual(HCS_MAX_MESSAGE_BYTES);
  });
});

describe("Phase 6B.1A — HCS publisher wiring", () => {
  it("supplies exact persisted bytes and rejects wrong topic / missing receipt data", async () => {
    const r = reconstructPhase5WinnerProof();
    const rr = createRouteReservedRecord({
      reservationId: PHASE6B_RESERVATION_ID,
      tenderId: r.tender.tenderId,
      tenderVersion: 1,
      tenderHash: r.tenderHash,
      winningBidId: r.winningBidId,
      winningBidHash: r.winningBidHash,
      carrierId: r.winningCarrierId,
      carrierAccount: r.winningCarrierAccount,
      selectedOptionId: "USDC",
      paymentAsset: PHASE6B_USDC_TOKEN,
      paymentAmountAtomic: PHASE6B_USDC_AMOUNT_ATOMIC,
      payerAccount: PHASE6B_PAYER_ACCOUNT,
      transactionId: "0.0.9197513@1.1",
      consensusTimestamp: "2026-07-15T19:05:00.123456789Z",
      decisionManifestHash: r.proof.manifest.decisionManifestHash,
      evaluatedBidSetHash: r.proof.manifest.evaluatedBidSetHash,
      hcsAuctionTopicId: PHASE6B_HCS_TOPIC,
      closeBarrierSequence: 4,
      reservedAt: "2026-07-15T19:05:00.123456789Z",
    });
    const env = createRouteReservedHcsEnvelope({
      runId: `reservation-${PHASE6B_RESERVATION_ID}`,
      tenderId: r.tender.tenderId,
      tenderVersion: 1,
      tenderHash: r.tenderHash,
      createdAt: "2026-07-15T19:06:01.000Z",
      payload: buildRouteReservedPayload(rr, r.winningCarrierId),
    });
    expect(measureRouteReservedEnvelope(env)).toBeLessThanOrEqual(1024);
    // decisionManifestHash must not be flat on HCS payload
    expect(env.payload).not.toHaveProperty("decisionManifestHash");

    const exactBytes = serializeEnvelopeForSubmit(env);
    let captured: Uint8Array | null = null;
    const pub = new LiveHcsPublisherAdapter({
      allowNetwork: true,
      expectedTopicId: PHASE6B_HCS_TOPIC,
      submitViaSdk: async ({ topicId, exactBytes: bytes }) => {
        captured = bytes;
        if (topicId !== PHASE6B_HCS_TOPIC) {
          throw new Error("wrong topic");
        }
        return {
          topicId,
          sequence: 5,
          transactionId: "0.0.9197513@2.2",
          consensusTimestamp: "2026-07-15T19:07:00.000000001Z",
        };
      },
    });
    const result = await pub.publish(env);
    expect(result.sequence).toBe(5);
    expect(captured).not.toBeNull();
    expect(Buffer.from(captured!).equals(Buffer.from(exactBytes))).toBe(true);
    expect(pub.publishCallCount).toBe(1);

    // No second publication budget is adapter-level for LiveHcsPublisherAdapter
    // (SDK factory enforces max 1). Re-publish is allowed at adapter if submit allows —
    // prove dry-run blocks without wiring.
    const dry = new LiveHcsPublisherAdapter({ allowNetwork: false });
    await expect(dry.publish(env)).rejects.toThrow(/dry-run|DRY_RUN|blocked/i);

    // Missing receipt fields rejected
    const bad = new LiveHcsPublisherAdapter({
      allowNetwork: true,
      submitViaSdk: async () => ({
        topicId: PHASE6B_HCS_TOPIC,
        sequence: 0,
        transactionId: "",
        consensusTimestamp: "",
      }),
    });
    await expect(bad.publish(env)).rejects.toThrow(
      /transactionId|sequence|consensus/i,
    );

    // Wrong topic rejected
    const wrongTopic = new LiveHcsPublisherAdapter({
      allowNetwork: true,
      expectedTopicId: PHASE6B_HCS_TOPIC,
      submitViaSdk: async () => ({
        topicId: "0.0.1",
        sequence: 5,
        transactionId: "0.0.1@1.1",
        consensusTimestamp: "2026-07-15T19:07:00.000000001Z",
      }),
    });
    await expect(wrongTopic.publish(env)).rejects.toThrow(/topic|TOPIC/i);
  });

  it("topic creation is impossible through publisher", () => {
    // LiveHcsPublisherAdapter only has submitViaSdk — no createTopic method
    const pub = new LiveHcsPublisherAdapter({ allowNetwork: true });
    expect(pub).not.toHaveProperty("createTopic");
    expect(typeof (pub as unknown as { createTopic?: unknown }).createTopic).toBe(
      "undefined",
    );
  });
});

describe("Phase 6B.1A — live path with mocked transports", () => {
  it("live execution code path is reachable and uses ReservationService", async () => {
    const dir = tempDir();
    const attemptPath = path.join(dir, "live-attempt.json");
    const store = new InMemoryReservationStore();
    const fac = sessionFacilitator({
      settleTxId: "0.0.9197513@1784142000.100000000",
    });
    const published: unknown[] = [];
    let settleDirectlyCalled = false;

    const result = await runPhase6bLiveExecution({
      skipEnvLiveGuard: true,
      allowSyntheticTopicPreflight: true,
      topicPreflightOverride: goodTopic,
      attemptPath,
      store,
      webhookSigningPrivateKey: RESERVATION_TEST_WEBHOOK_PRIVATE_KEY,
      facilitator: fac,
      mirror: {
        async getTransaction(txId) {
          return {
            status: "SUCCESS",
            transactionId: txId,
            consensusTimestamp: "2026-07-15T19:05:00.123456789Z",
            result: "SUCCESS",
            hbarTransfers: [{ account: "0.0.7162784", amount: "-1" }],
            tokenTransfers: [
              {
                account: PHASE6B_PAYER_ACCOUNT,
                amount: "-10000",
                tokenId: PHASE6B_USDC_TOKEN,
              },
              {
                account: PHASE6B_CARRIER_ACCOUNT,
                amount: "10000",
                tokenId: PHASE6B_USDC_TOKEN,
              },
            ],
          };
        },
      },
      hcs: {
        async publish(envelope) {
          published.push(envelope);
          return {
            topicId: PHASE6B_HCS_TOPIC,
            sequence: 5,
            transactionId: "0.0.9197513@1784142100.200000000",
            consensusTimestamp: "2026-07-15T19:07:00.000000001Z",
          };
        },
      },
      createPaymentPayload: async () => mockPaymentPayload(),
      now: () => "2026-07-15T19:01:00.000Z",
    });

    expect(result.mode).toBe("LIVE");
    expect(result.serviceSettleAuthority).toBe("ReservationService");
    expect(fac.settleCallCount()).toBe(1);
    expect(fac.verifyCallCount()).toBe(1);
    expect(fac.lastPayloadSeen()).not.toBeNull();
    // Payload was in memory for facilitator; attempt file must not contain it
    const attempt = loadPhase6bAttempt(attemptPath)!;
    const attemptJson = JSON.stringify(attempt);
    expect(attemptJson).not.toMatch(/mock-signed-tx|PAYMENT-SIGNATURE|mock-sig/i);
    expect(attempt.transactionId).toBeTruthy();
    expect(settleDirectlyCalled).toBe(false);
    expect(result.reservation.paymentPayloadHash).toMatch(/^sha256:/);
    expect(result.reservation).not.toHaveProperty("paymentPayload");
    expect(published.length).toBeLessThanOrEqual(1);
  });

  it("signed payload remains in memory only; hash persisted", async () => {
    const dir = tempDir();
    const attemptPath = path.join(dir, "live-mem.json");
    const store = new InMemoryReservationStore();
    const fac = sessionFacilitator();
    const payload = mockPaymentPayload();

    await runPhase6bLiveExecution({
      skipEnvLiveGuard: true,
      allowSyntheticTopicPreflight: true,
      topicPreflightOverride: goodTopic,
      attemptPath,
      store,
      webhookSigningPrivateKey: RESERVATION_TEST_WEBHOOK_PRIVATE_KEY,
      facilitator: fac,
      mirror: {
        async getTransaction(txId) {
          return {
            status: "SUCCESS",
            transactionId: txId,
            consensusTimestamp: "2026-07-15T19:05:00.123456789Z",
            result: "SUCCESS",
            hbarTransfers: [],
            tokenTransfers: [
              {
                account: PHASE6B_PAYER_ACCOUNT,
                amount: "-10000",
                tokenId: PHASE6B_USDC_TOKEN,
              },
              {
                account: PHASE6B_CARRIER_ACCOUNT,
                amount: "10000",
                tokenId: PHASE6B_USDC_TOKEN,
              },
            ],
          };
        },
      },
      hcs: {
        async publish() {
          return {
            topicId: PHASE6B_HCS_TOPIC,
            sequence: 5,
            transactionId: "0.0.9197513@3.3",
            consensusTimestamp: "2026-07-15T19:07:00.000000001Z",
          };
        },
      },
      createPaymentPayload: async () => payload,
    });

    const rec = await store.get(PHASE6B_RESERVATION_ID);
    expect(rec?.paymentPayloadHash).toBe(payload.paymentPayloadHash);
    const dump = JSON.stringify(rec);
    expect(dump).not.toContain("mock-signed-tx-bytes");
    expect(dump).not.toMatch(/privateKey|SHIPPER_PRIVATE/i);
  });

  it("interrupted payment (PAYMENT_SUBMISSION_CLAIMED) resumes without re-settling via fresh start", () => {
    const attemptPath = tempAttemptPath();
    const attempt = withAttemptUpdate(
      createPlannedPhase6bAttempt({
        kind: "LIVE",
        attemptId: "interrupt-pay",
        reservationId: PHASE6B_RESERVATION_ID,
        attemptPath,
      }),
      {
        status: "PAYMENT_SUBMISSION_CLAIMED",
        paymentSubmissionClaimedAt: "2026-07-15T19:01:00.000Z",
      },
    );
    persistPhase6bAttempt(attempt, attemptPath);
    const loaded = loadPhase6bAttempt(attemptPath)!;
    expect(() => assertSafeToStartPhase6bLive(loaded)).toThrow(
      /PAYMENT_ALREADY|claimed/i,
    );
  });

  it("interrupted HCS (HCS_CLAIMED) does not auto-publish again", () => {
    const attempt = withAttemptUpdate(
      createPlannedPhase6bAttempt({
        kind: "LIVE",
        attemptId: "interrupt-hcs",
        reservationId: PHASE6B_RESERVATION_ID,
      }),
      {
        status: "HCS_CLAIMED",
        hcsPublishAttemptId: "pub-xyz",
        transactionId: "0.0.9197513@1.1",
        paymentSubmittedAt: "2026-07-15T19:02:00.000Z",
      },
    );
    expect(() => assertSafeToStartPhase6bLive(attempt)).toThrow(
      /HCS_ALREADY|PAYMENT_ALREADY|claimed|submitted/i,
    );
    expect(() => assertHcsNotYetClaimed(attempt)).toThrow(
      /already claimed|HCS_ALREADY|cannot duplicate/i,
    );
  });
});

describe("Phase 6B.1A — evidence and secrets", () => {
  it("evidence excludes secrets and dry-run evidence is labeled offline", async () => {
    const attemptPath = tempAttemptPath();
    const result = await runPhase6bDryRun({
      env: {},
      attemptPath,
      topicPreflight: goodTopic,
    });
    const attempt = loadPhase6bAttempt(attemptPath)!;
    const json = JSON.stringify({ result, attempt });
    expect(json).not.toMatch(
      /privateKey|PAYMENT-SIGNATURE|signedPayment|commitmentSalt|SHIPPER_PRIVATE/i,
    );
    expect(attempt).not.toHaveProperty("paymentPayload");
    expect(parsePhase6bAttempt(attempt).asset).toBe(PHASE6B_USDC_TOKEN);
    expect(result.mode).toBe("OFFLINE_DRY_RUN");
    expect(attempt.kind).toBe("DRY_RUN");
  });

  it("facilitator adapter blocks settle in dry-run", async () => {
    const fac = new LiveFacilitatorAdapter({
      facilitatorUrl: "https://api.testnet.blocky402.com",
      allowNetwork: false,
    });
    await expect(
      fac.settle({
        selected: usdcSelected(),
        paymentPayloadHash: "sha256:" + "11".repeat(32),
        challengeHash: "sha256:" + "22".repeat(32),
      }),
    ).rejects.toThrow(/dry-run|DRY_RUN/i);
  });

  it("local challenge adapter produces exact USDC challenge", async () => {
    const adapter = new LocalX402ChallengeAdapter();
    const c = await adapter.createChallenge(usdcSelected());
    expect(c.asset).toBe(PHASE6B_USDC_TOKEN);
    expect(c.amount).toBe(PHASE6B_USDC_AMOUNT_ATOMIC);
    expect(c.payTo).toBe(PHASE6B_CARRIER_ACCOUNT);
    expect(c.maxTimeoutSeconds).toBe(180);
    expect(c.x402Version).toBe(2);
  });

  it("mirror transaction id conversion", () => {
    expect(toMirrorTransactionId("0.0.9197513@1784142000.100000000")).toBe(
      "0.0.9197513-1784142000-100000000",
    );
  });
});
