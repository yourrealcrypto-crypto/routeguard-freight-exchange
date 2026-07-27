/**
 * Pre-submission payment-claim recovery for the live final-demo attempt
 * (final-8b73c264). Tests use temporary copies only — never mutate real
 * live evidence or perform network writes.
 */

import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadFinalDemoAttempt,
  parseFinalDemoAttempt,
  withFinalDemoAttemptUpdate,
  type FinalDemoAttemptRecord,
} from "../src/final-demo/attempt-store";
import {
  clearSafePreSubmissionPaymentClaim,
  isSafePreSubmissionPaymentClaim,
} from "../src/final-demo/payment-claim-recovery";
import { FinalDemoError } from "../src/final-demo/errors";
import { runFinalDemoOrchestration } from "../src/final-demo/orchestration";
import { createFinalDemoDryRunTransports } from "../src/final-demo/dry-transports";
import {
  CONFIRM_FINAL_DEMO_VALUE,
  FINAL_DEMO_MODE_LIVE,
} from "../src/final-demo/constants";
import { offlineUsdcReadinessPass } from "../src/final-demo/usdc-readiness";
import { envelopeHash } from "../src/hcs/message-envelope";
import { observedFromEnvelope } from "../src/final-demo/reconciliation";
import type { ObservedHcsMessage } from "../src/hcs/types";
import type { ReservationRecord } from "../src/reservation/types";
import { FileSystemReservationStore } from "../src/reservation/attempt-store";

const REPO_ROOT = path.resolve(__dirname, "..");
/** Frozen pre-submission snapshot — not the completed live evidence file. */
const PRE_SUBMISSION_ATTEMPT_FIXTURE = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "final-demo-live-attempt-pre-submission-8b73c264.json",
);
const PRE_SUBMISSION_RESERVATION_FIXTURE = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "final-demo-live-reservation-pre-submission-8b73c264.json",
);
const LIVE_ATTEMPT = path.join(
  REPO_ROOT,
  "evidence",
  "final-demo-live-attempt.json",
);
const LIVE_MATERIALS = path.join(
  REPO_ROOT,
  "evidence",
  "final-demo-live-authoritative-materials.json",
);
const LIVE_RESERVATION = path.join(
  REPO_ROOT,
  "data",
  "final-demo-live-reservations",
  "reservation-final-8b73c264.json",
);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "final-demo-pay-rec-"));
  dirs.push(dir);
  return dir;
}

function loadPreSubmissionAttemptSnapshot(): FinalDemoAttemptRecord {
  const raw = JSON.parse(readFileSync(PRE_SUBMISSION_ATTEMPT_FIXTURE, "utf8"));
  return parseFinalDemoAttempt(raw);
}

function loadPreSubmissionReservationSnapshot(): ReservationRecord {
  return JSON.parse(
    readFileSync(PRE_SUBMISSION_RESERVATION_FIXTURE, "utf8"),
  ) as ReservationRecord;
}

function emptyPreSubmissionReservation(
  overrides: Partial<ReservationRecord> = {},
): ReservationRecord {
  const base = loadPreSubmissionReservationSnapshot();
  return {
    ...base,
    state: "PAYMENT_CHALLENGE_ISSUED",
    paymentPayloadHash: null,
    clientTransaction: null,
    settleClaim: null,
    facilitatorSettle: null,
    facilitatorVerify: null,
    transactionId: null,
    mirrorConfirmation: null,
    routeReserved: null,
    ...overrides,
  };
}

describe("pre-submission payment claim recovery — pure guards", () => {
  it("exact existing pre-submission claim is safely resumable", () => {
    const attempt = loadPreSubmissionAttemptSnapshot();
    const reservation = loadPreSubmissionReservationSnapshot();

    expect(attempt.status).toBe("PAYMENT_SUBMISSION_CLAIMED");
    expect(attempt.paymentSubmissionClaim.status).toBe("CLAIMED");
    expect(attempt.paymentSubmissionClaim.transactionId).toBeNull();
    expect(attempt.topicId).toBe("0.0.9794225");
    expect(reservation.state).toBe("PAYMENT_CHALLENGE_ISSUED");
    expect(reservation.paymentPayloadHash).toBeNull();
    expect(reservation.clientTransaction).toBeNull();
    expect(reservation.settleClaim).toBeNull();
    expect(reservation.facilitatorSettle).toBeNull();
    expect(reservation.transactionId).toBeNull();

    expect(isSafePreSubmissionPaymentClaim(attempt, reservation)).toBe(true);

    const cleared = clearSafePreSubmissionPaymentClaim(attempt, reservation);
    expect(cleared.paymentSubmissionClaim.status).toBe("NONE");
    expect(cleared.paymentSubmissionClaim.transactionId).toBeNull();
    expect(cleared.paymentSubmissionClaim.claimId).toBeNull();
    expect(cleared.status).toBe("PAYMENT_READY");
    // Topic + sequences 1–4 preserved
    expect(cleared.topicId).toBe("0.0.9794225");
    expect(cleared.topicCreateTransactionId).toBe(
      "0.0.9197513@1785171882.373802899",
    );
    const confirmed = cleared.messageOutbox.filter(
      (m) => m.status === "CONFIRMED",
    );
    expect(confirmed.map((m) => m.sequence)).toEqual([1, 2, 3, 4]);
    const seq5 = cleared.messageOutbox.find(
      (m) => m.logicalLabel === "ROUTE_RESERVED",
    );
    expect(seq5?.status).toBe("PENDING");
  });

  it("claim with any transaction identity is not treated as safe pre-submission", () => {
    const attempt = withFinalDemoAttemptUpdate(
      loadPreSubmissionAttemptSnapshot(),
      {
        paymentSubmissionClaim: {
          claimedAt: "2026-07-27T17:11:58.475Z",
          claimId: "pay-claim-e7246d88-02e5-4b09-a44b-62c2385da82e",
          status: "CLAIMED",
          transactionId: "0.0.9197513@1785172400.000000001",
        },
      },
    );
    const reservation = emptyPreSubmissionReservation();
    expect(isSafePreSubmissionPaymentClaim(attempt, reservation)).toBe(false);
    expect(() =>
      clearSafePreSubmissionPaymentClaim(attempt, reservation),
    ).toThrow(FinalDemoError);
    expect(() =>
      clearSafePreSubmissionPaymentClaim(attempt, reservation),
    ).toThrow(/not a proven pre-submission/);
  });

  it("payment payload hash blocks safe pre-submission treatment", () => {
    const attempt = loadPreSubmissionAttemptSnapshot();
    const reservation = emptyPreSubmissionReservation({
      paymentPayloadHash: "sha256:" + "ab".repeat(32),
    });
    expect(isSafePreSubmissionPaymentClaim(attempt, reservation)).toBe(false);
  });

  it("settle claim or facilitator result blocks fresh payment construction", () => {
    const attempt = loadPreSubmissionAttemptSnapshot();
    const withSettle = emptyPreSubmissionReservation({
      settleClaim: {
        claimId: "settle-1",
        claimedAt: "2026-07-27T17:12:00.000Z",
        paymentPayloadHash: "sha256:" + "cd".repeat(32),
        challengeHash: "sha256:" + "ef".repeat(32),
        optionId: "USDC",
        transactionId: "0.0.9197513@1785172400.000000001",
        validStartTimestamp: "2026-07-27T17:12:00.000Z",
        transactionValidDurationSeconds: 180,
      } as unknown as ReservationRecord["settleClaim"],
    });
    expect(isSafePreSubmissionPaymentClaim(attempt, withSettle)).toBe(false);

    const withFacilitator = emptyPreSubmissionReservation({
      facilitatorSettle: {
        success: true,
        transaction: "0.0.9197513@1785172400.000000001",
        network: "hedera:testnet",
      } as unknown as ReservationRecord["facilitatorSettle"],
    });
    expect(isSafePreSubmissionPaymentClaim(attempt, withFacilitator)).toBe(
      false,
    );

    const withClientTx = emptyPreSubmissionReservation({
      clientTransaction: {
        transactionId: "0.0.9197513@1785172400.000000001",
        validStartTimestamp: "2026-07-27T17:12:00.000Z",
        transactionValidDurationSeconds: 180,
      },
    });
    expect(isSafePreSubmissionPaymentClaim(attempt, withClientTx)).toBe(false);
  });

  it("ambiguous mid-payment reservation states fail closed", () => {
    const attempt = loadPreSubmissionAttemptSnapshot();
    for (const state of [
      "PAYMENT_SUBMISSION_STARTED",
      "FACILITATOR_VERIFIED",
      "FACILITATOR_SETTLE_CLAIMED",
      "FACILITATOR_SETTLED",
      "MIRROR_CONFIRMATION_PENDING",
    ] as const) {
      const reservation = emptyPreSubmissionReservation({
        state: state as ReservationRecord["state"],
      });
      expect(isSafePreSubmissionPaymentClaim(attempt, reservation)).toBe(
        false,
      );
    }
  });

  it("sequence 5 progress blocks pre-submission clear", () => {
    const attempt = loadPreSubmissionAttemptSnapshot();
    const withSeq5 = withFinalDemoAttemptUpdate(attempt, {
      messageOutbox: attempt.messageOutbox.map((m) =>
        m.logicalLabel === "ROUTE_RESERVED"
          ? {
              ...m,
              status: "CLAIMED" as const,
              claimedAt: "2026-07-27T17:12:00.000Z",
              submitAttemptId: "submit-ROUTE_RESERVED-x",
            }
          : m,
      ),
    });
    expect(
      isSafePreSubmissionPaymentClaim(
        withSeq5,
        emptyPreSubmissionReservation(),
      ),
    ).toBe(false);
  });
});

describe("pre-submission recovery — orchestrated resume (offline, temp copy)", () => {
  const fullLiveEnv = {
    ENABLE_FINAL_DEMO_LIVE: "true",
    ENABLE_LIVE_HEDERA: "true",
    ENABLE_LIVE_USDC_PAYMENTS: "true",
    ENABLE_LIVE_HCS_WRITES: "true",
    ENABLE_LIVE_TOPIC_CREATE: "true",
    ENABLE_PHASE6B_LIVE_EXECUTE: "true",
    CONFIRM_FINAL_DEMO: CONFIRM_FINAL_DEMO_VALUE,
  };

  it("reuses topic and sequences 1–4; no second topic; settle ≤1; seq5 after settlement", async () => {
    if (
      !existsSync(PRE_SUBMISSION_ATTEMPT_FIXTURE) ||
      !existsSync(PRE_SUBMISSION_RESERVATION_FIXTURE) ||
      !existsSync(LIVE_MATERIALS)
    ) {
      return;
    }

    const dir = tempDir();
    const attemptPath = path.join(dir, "final-demo-live-attempt.json");
    const materialsPath = path.join(
      dir,
      "final-demo-live-authoritative-materials.json",
    );
    const reservationDir = path.join(dir, "live-reservations");
    mkdirSync(reservationDir, { recursive: true });
    // Temp copies of frozen pre-submission fixtures only — never mutate live evidence.
    copyFileSync(PRE_SUBMISSION_ATTEMPT_FIXTURE, attemptPath);
    copyFileSync(LIVE_MATERIALS, materialsPath);
    copyFileSync(
      PRE_SUBMISSION_RESERVATION_FIXTURE,
      path.join(reservationDir, "reservation-final-8b73c264.json"),
    );

    const liveAttempt = loadFinalDemoAttempt(attemptPath)!;
    const topicId = liveAttempt.topicId!;
    expect(topicId).toBe("0.0.9794225");
    expect(liveAttempt.status).toBe("PAYMENT_SUBMISSION_CLAIMED");

    const materials = JSON.parse(readFileSync(materialsPath, "utf8")) as {
      auctionEndsAt: string;
    };

    // Clock past auction end so live barrier wait does not wall-sleep.
    const clockMs = Date.parse(materials.auctionEndsAt) + 60_000;
    const transports = createFinalDemoDryRunTransports({ clockMs });

    // Durable sequences 1–4 as Mirror observation (exact envelopes from attempt).
    const seq1to4: ObservedHcsMessage[] = liveAttempt.messageOutbox
      .filter((m) => m.status === "CONFIRMED" && m.envelope && m.sequence)
      .map((m) => {
        const base = {
          topicId,
          sequence: m.sequence!,
          envelope: m.envelope as never,
          envelopeHash: m.envelopeHash!,
          consensusTimestamp: m.consensusTimestamp!,
        };
        return observedFromEnvelope(
          m.transactionId
            ? { ...base, transactionId: m.transactionId }
            : base,
        );
      });
    expect(seq1to4.map((m) => m.sequence)).toEqual([1, 2, 3, 4]);

    let topicCreateCalls = 0;
    transports.topicTransport.createTopic = async () => {
      topicCreateCalls += 1;
      throw new FinalDemoError(
        "Test must not create a second topic",
        "TOPIC_CREATE_BUDGET",
      );
    };
    transports.topicTransport.getCreateCount = () => topicCreateCalls;

    const hcsSubmitByLabel: Record<string, number> = {};
    let seq5Message: ObservedHcsMessage | null = null;
    let hcsSubmitCount = 0;

    transports.hcsTransport.submitMessage = async (input) => {
      hcsSubmitByLabel[input.label] = (hcsSubmitByLabel[input.label] ?? 0) + 1;
      hcsSubmitCount += 1;
      if (input.label !== "ROUTE_RESERVED") {
        throw new FinalDemoError(
          `Unexpected HCS re-submit of ${input.label}`,
          "HCS_ALREADY_CLAIMED",
        );
      }
      if (input.topicId !== topicId) {
        throw new FinalDemoError("Wrong topic on submit", "WRONG_TOPIC");
      }
      // Sequence 5 only after payment path invokes publisher (post-settlement).
      const hash = envelopeHash(input.envelope);
      const consensusTimestamp = new Date(
        transports.clock.nowMs(),
      ).toISOString().replace("Z", "123456789Z");
      const transactionId = `0.0.9197513@${Math.floor(transports.clock.nowMs() / 1000)}.500000001`;
      seq5Message = observedFromEnvelope({
        topicId,
        sequence: 5,
        envelope: input.envelope as never,
        envelopeHash: hash,
        consensusTimestamp,
        transactionId,
      });
      return {
        topicId,
        sequence: 5,
        transactionId,
        consensusTimestamp,
        envelopeHash: hash,
        receiptStatus: "SUCCESS" as const,
      };
    };
    transports.hcsTransport.getSubmitCount = () => hcsSubmitCount;

    transports.topicMirrorReader.listMessages = async () =>
      seq5Message ? [...seq1to4, seq5Message] : [...seq1to4];
    transports.topicMirrorReader.waitForEnvelopeHash = async (
      _topicId,
      hash,
    ) => {
      const msgs = seq5Message ? [...seq1to4, seq5Message] : [...seq1to4];
      const found = msgs.find((m) => m.envelopeHash === hash);
      if (!found) {
        throw new FinalDemoError(
          "Mirror missing envelope hash",
          "MIRROR_CONFIRM_FAILED",
        );
      }
      return found;
    };

    // Capture real live evidence hashes before the offline resume so we can
    // prove the test only mutates temp copies.
    const liveAttemptBefore = existsSync(LIVE_ATTEMPT)
      ? readFileSync(LIVE_ATTEMPT, "utf8")
      : null;
    const liveReservationBefore = existsSync(LIVE_RESERVATION)
      ? readFileSync(LIVE_RESERVATION, "utf8")
      : null;

    const result = await runFinalDemoOrchestration({
      mode: FINAL_DEMO_MODE_LIVE,
      env: fullLiveEnv,
      clock: transports.clock,
      workDir: dir,
      attemptPath,
      materialsPath,
      reservationStoreDir: reservationDir,
      resultJsonPath: path.join(dir, "final-demo-result.json"),
      resultMdPath: path.join(dir, "final-demo-result.md"),
      topicTransport: transports.topicTransport,
      hcsTransport: transports.hcsTransport,
      topicMirrorReader: transports.topicMirrorReader,
      paymentPayloadFactory: transports.paymentPayloadFactory,
      facilitatorTransport: transports.facilitatorTransport,
      paymentMirrorTransport: transports.paymentMirrorTransport,
      webhookTransport: transports.webhookTransport,
      webhookSigningPrivateKey: "ab".repeat(32),
      readiness: {
        secretScan: () => undefined,
        accountCheck: async () => ({ ok: true, reasons: [] }),
        usdcReadiness: async () => offlineUsdcReadinessPass(),
      },
      confirmationTimeoutMs: 2_000,
      mirrorPollIntervalMs: 10,
    });

    expect(result.topic.topicId).toBe("0.0.9794225");
    expect(topicCreateCalls).toBe(0);
    expect(result.networkWrites.topicCreates).toBe(0);
    // Sequences 1–4 must not be re-submitted
    expect(hcsSubmitByLabel["AUCTION_OPEN"] ?? 0).toBe(0);
    expect(hcsSubmitByLabel["BID_COMMITMENT_ALPHA"] ?? 0).toBe(0);
    expect(hcsSubmitByLabel["BID_COMMITMENT_BETA"] ?? 0).toBe(0);
    expect(hcsSubmitByLabel["AUCTION_CLOSE_BARRIER"] ?? 0).toBe(0);
    // Sequence 5 exactly once after settlement
    expect(hcsSubmitByLabel["ROUTE_RESERVED"] ?? 0).toBe(1);
    expect(result.settleCallCount).toBe(1);
    expect(result.networkWrites.payments).toBeLessThanOrEqual(1);
    expect(result.networkWrites.payments).toBe(1);
    expect(result.routeReserved.sequence).toBe(5);
    expect(result.winner.carrierAccount).toBe("0.0.9215954");
    expect(result.payment.receiver).toBe("0.0.9215954");
    expect(result.payment.token).toBe("0.0.429274");
    expect(result.payment.amount).toBe("10000");
    expect(result.finalState).toBe("COMPLETED");
    expect(result.materials.reservationId).toBe("reservation-final-8b73c264");

    // Transaction identity persisted on reservation (before/through settle).
    const store = new FileSystemReservationStore(reservationDir);
    const finalReservation = await store.get("reservation-final-8b73c264");
    expect(finalReservation?.clientTransaction?.transactionId).toBeTruthy();
    expect(finalReservation?.paymentPayloadHash).toMatch(/^sha256:/);
    expect(finalReservation?.settleClaim).toBeTruthy();

    // Real live files must remain byte-identical (temp-copy isolation).
    if (liveAttemptBefore !== null) {
      expect(readFileSync(LIVE_ATTEMPT, "utf8")).toBe(liveAttemptBefore);
    }
    if (liveReservationBefore !== null) {
      expect(readFileSync(LIVE_RESERVATION, "utf8")).toBe(
        liveReservationBefore,
      );
    }
  });
});
