/**
 * Shared final-demo orchestration engine (Phase 6B.3).
 *
 * OFFLINE_DRY_RUN and LIVE_FINAL_DEMO execute the same algorithm.
 * Mode differences are dependency injection only.
 *
 * Settlement authority is ALWAYS ReservationService.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";

import type { PaymentPayload } from "@x402/core/types";

import { createCloseBarrierEnvelope, envelopeHash } from "../hcs/message-envelope";
import { serializeEnvelopeForSubmit } from "../hcs/message-envelope";
import type { HcsEnvelope, ObservedHcsMessage } from "../hcs/types";
import { CLOSE_POLICY, HCS_MAX_MESSAGE_BYTES } from "../hcs/types";
import {
  FileSystemReservationStore,
  type ReservationStore,
} from "../reservation/attempt-store";
import {
  buildRouteReservedPayload,
  createRouteReservedHcsEnvelope,
  measureRouteReservedEnvelope,
} from "../reservation/hcs-evidence";
import { ReservationService } from "../reservation/reservation-service";
import type { ReservationRecord } from "../reservation/types";
import type { HcsPublisherTransport } from "../reservation/transports";
import { LocalX402ChallengeAdapter } from "../reservation/live/adapters";
import { assertUsdcOnlySelection as assertPhase6bUsdc } from "../reservation/live/adapters";
import { atomicWriteJson, atomicWriteText } from "./atomic-write";
import {
  claimMessageOutbox,
  claimTopicCreate,
  confirmMessageOutbox,
  createFinalDemoAttempt,
  FinalDemoAttemptStore,
  finalizeTopicCreate,
  getOutboxMessage,
  loadFinalDemoAttempt,
  markTopicCreateAmbiguous,
  withFinalDemoAttemptUpdate,
  type FinalDemoAttemptRecord,
} from "./attempt-store";
import {
  FINAL_DEMO_BARRIER_SAFETY_MARGIN_MS,
  FINAL_DEMO_COMMITMENT_SAFETY_MARGIN_MS,
  FINAL_DEMO_DRY_MATERIALS_PATH,
  FINAL_DEMO_DRY_RESERVATION_DIR,
  FINAL_DEMO_DRY_RUN_ATTEMPT_PATH,
  FINAL_DEMO_DRY_RUN_JSON_PATH,
  FINAL_DEMO_DRY_RUN_MD_PATH,
  FINAL_DEMO_LIVE_ATTEMPT_PATH,
  FINAL_DEMO_LIVE_MATERIALS_PATH,
  FINAL_DEMO_LIVE_RESERVATION_DIR,
  FINAL_DEMO_MODE_DRY,
  FINAL_DEMO_MODE_LIVE,
  FINAL_DEMO_PAYER_ACCOUNT,
  FINAL_DEMO_RESULT_JSON_PATH,
  FINAL_DEMO_RESULT_MD_PATH,
  FINAL_DEMO_USDC_AMOUNT_ATOMIC,
  FINAL_DEMO_USDC_TOKEN,
  FINAL_DEMO_WINNER_ACCOUNT,
  HISTORICAL_PHASE5_TOPIC_ID,
  HISTORICAL_TOPIC_DISCLOSURE,
  SYNTHETIC_DATA_DISCLOSURE,
  type FinalDemoMessageLabel,
} from "./constants";
import {
  buildPaymentEconomicsSummary,
  formatPaymentEconomicsLines,
} from "../domain/payment-economics";
import { STABLECOIN_NETWORK_TRANSFER_COST_USD } from "../domain/hedera-transfer-costs";
import { measureFinalDemoConservativeEnvelope } from "./envelope-budget";
import { FinalDemoError } from "./errors";
import { assertFinalDemoLiveAuthorized } from "./guards";
import {
  generateFinalDemoAuthoritativeMaterials,
  hashMaterialsPackage,
  loadFinalDemoAuthoritativeMaterials,
  type FinalDemoAuthoritativeMaterials,
} from "./materials";
import {
  assertMirrorReadyForSequence,
  assertPristineTopicSequences1to4,
  reconcileFinalDemoSequences1to4,
  type FinalDemoReconciliationResult,
} from "./reconciliation";
import { assertNoPrivateKeyFields, assertSecretScanPass } from "./secret-scan";
import {
  assertBarrierAfterAuctionEnd,
  assertCommitmentTimeRemaining,
} from "./timing";
import type {
  FinalDemoClock,
  FinalDemoHcsTransport,
  FinalDemoReadinessChecks,
  FinalDemoTopicMirrorReader,
  FinalDemoTopicTransport,
  PaymentPayloadFactory,
  SessionFacilitatorTransport,
} from "./transports";
import {
  assertUsdcReadinessPass,
  offlineUsdcReadinessPass,
} from "./usdc-readiness";
import type { MirrorConfirmationTransport } from "../reservation/transports";
import type { WebhookDeliveryTransport } from "../reservation/transports";

const DEFAULT_WEBHOOK_KEY =
  "7a8b9c0d1e2f30415263748596a7b8c9d0e1f2031425364758697a8b9c0d1e2f";

export type FinalDemoOrchestrationMode =
  | typeof FINAL_DEMO_MODE_DRY
  | typeof FINAL_DEMO_MODE_LIVE;

export type FinalDemoOrchestrationDeps = {
  mode: FinalDemoOrchestrationMode;
  env?: NodeJS.ProcessEnv;
  clock: FinalDemoClock;
  workDir?: string;
  templatePath?: string;
  attemptPath?: string;
  materialsPath?: string;
  resultJsonPath?: string;
  resultMdPath?: string;
  reservationStore?: ReservationStore;
  reservationStoreDir?: string;
  topicTransport: FinalDemoTopicTransport;
  hcsTransport: FinalDemoHcsTransport;
  topicMirrorReader: FinalDemoTopicMirrorReader;
  paymentPayloadFactory: PaymentPayloadFactory;
  facilitatorTransport: SessionFacilitatorTransport;
  paymentMirrorTransport: MirrorConfirmationTransport;
  webhookTransport: WebhookDeliveryTransport;
  webhookSigningPrivateKey?: string;
  readiness?: FinalDemoReadinessChecks;
  /** Auction window override (seconds). Default from materials/template (300). */
  auctionWindowSeconds?: number;
  runBaseTime?: string;
  confirmationTimeoutMs?: number;
  /** Dry-run/tests only: prep buffer seconds (default 120 for live realism). */
  prepBufferSeconds?: number;
  mirrorPollIntervalMs?: number;
  /** Inject settle call counter observer (tests). */
  onReservationServiceCreated?: (service: ReservationService) => void;
};

export type FinalDemoOrchestrationResult = {
  mode: FinalDemoOrchestrationMode;
  disclosure: typeof SYNTHETIC_DATA_DISCLOSURE;
  historicalTopicDisclosure: typeof HISTORICAL_TOPIC_DISCLOSURE;
  attempt: FinalDemoAttemptRecord;
  materials: {
    attemptId: string;
    shortAttemptId: string;
    tenderId: string;
    bidAlphaId: string;
    bidBetaId: string;
    reservationId: string;
    tenderHash: string;
    bidHashes: { alpha: string; beta: string };
    receiptHashes: { alpha: string; beta: string };
    commitmentEnvelopeHashes: { alpha: string; beta: string };
  };
  topic: {
    topicId: string;
    topicCreateTransactionId: string;
    topicMemo: string;
  };
  sequences: Array<{
    sequence: number;
    label: string;
    envelopeHash: string;
    transactionId: string;
    consensusTimestamp: string;
  }>;
  auctionEndsAt: string;
  barrierConsensusTimestamp: string;
  reconciliationReference: string;
  finalHashes: {
    tenderHash: string;
    winningBidHash: string;
    evaluatedBidSetHash: string;
    decisionManifestHash: string;
  };
  winner: {
    bidId: string;
    carrierId: string;
    carrierAccount: string;
  };
  payment: {
    selectedOptionId: "USDC";
    payer: string;
    receiver: string;
    token: string;
    amount: string;
    /** Carrier-received reservation amount — network cost not deducted. */
    carrierReceivedAmountAtomic: string;
    challengeStatedHederaNetworkTransferCostUsd: typeof STABLECOIN_NETWORK_TRANSFER_COST_USD;
    economics: ReturnType<typeof buildPaymentEconomicsSummary>;
    transactionId: string;
    consensusTimestamp: string;
    tokenTransfers: Array<{
      account: string;
      tokenId?: string;
      amount: string;
    }>;
  };
  reservationRecordHash: string;
  routeReserved: {
    sequence: 5;
    envelopeHash: string;
    byteCount: number;
    transactionId: string;
    consensusTimestamp: string;
  };
  conservativeEnvelopeByteCount: number;
  dryRunEnvelopeByteCount: number;
  envelopeWithinLimit: boolean;
  networkWrites: {
    topicCreates: number;
    hcsSubmits: number;
    payments: number;
    realNetwork: boolean;
  };
  evidencePaths: {
    materials: string;
    attempt: string;
    json: string;
    md: string;
  };
  finalState: "COMPLETED" | "DRY_RUN_COMPLETE";
  /** ReservationService settle call count when available. */
  settleCallCount: number | null;
  reservation: ReservationRecord | null;
  webhookEventIds: string[];
  webhookPayloadHashes: string[];
};

function resolvePaths(deps: FinalDemoOrchestrationDeps) {
  const workDir = deps.workDir ?? process.cwd();
  const useTemp = Boolean(deps.workDir);
  const isLive = deps.mode === FINAL_DEMO_MODE_LIVE;
  const materialsName = isLive
    ? "final-demo-live-authoritative-materials.json"
    : "final-demo-dry-run-authoritative-materials.json";
  const defaultMaterials = isLive
    ? FINAL_DEMO_LIVE_MATERIALS_PATH
    : FINAL_DEMO_DRY_MATERIALS_PATH;
  return {
    materials: path.resolve(
      deps.materialsPath ??
        (useTemp ? path.join(workDir, materialsName) : defaultMaterials),
    ),
    attempt: path.resolve(
      deps.attemptPath ??
        (useTemp
          ? path.join(
              workDir,
              isLive
                ? "final-demo-live-attempt.json"
                : "final-demo-dry-run-attempt.json",
            )
          : isLive
            ? FINAL_DEMO_LIVE_ATTEMPT_PATH
            : FINAL_DEMO_DRY_RUN_ATTEMPT_PATH),
    ),
    json: path.resolve(
      deps.resultJsonPath ??
        (useTemp
          ? path.join(
              workDir,
              isLive ? "final-demo-result.json" : "final-demo-dry-run.json",
            )
          : isLive
            ? FINAL_DEMO_RESULT_JSON_PATH
            : FINAL_DEMO_DRY_RUN_JSON_PATH),
    ),
    md: path.resolve(
      deps.resultMdPath ??
        (useTemp
          ? path.join(
              workDir,
              isLive ? "final-demo-result.md" : "final-demo-dry-run.md",
            )
          : isLive
            ? FINAL_DEMO_RESULT_MD_PATH
            : FINAL_DEMO_DRY_RUN_MD_PATH),
    ),
    reservationDir: path.resolve(
      deps.reservationStoreDir ??
        (useTemp
          ? path.join(
              workDir,
              isLive ? "live-reservations" : "dry-reservations",
            )
          : isLive
            ? FINAL_DEMO_LIVE_RESERVATION_DIR
            : FINAL_DEMO_DRY_RESERVATION_DIR),
    ),
  };
}

/** CAS-backed attempt persistence (store owns recordVersion). */
async function persistAttempt(
  store: FinalDemoAttemptStore,
  attempt: FinalDemoAttemptRecord,
): Promise<FinalDemoAttemptRecord> {
  const existing = await store.get();
  if (!existing) {
    return store.create(attempt);
  }
  return store.compareAndSet(existing.recordVersion, attempt);
}

function labelForSequence(seq: number): FinalDemoMessageLabel {
  switch (seq) {
    case 1:
      return "AUCTION_OPEN";
    case 2:
      return "BID_COMMITMENT_ALPHA";
    case 3:
      return "BID_COMMITMENT_BETA";
    case 4:
      return "AUCTION_CLOSE_BARRIER";
    case 5:
      return "ROUTE_RESERVED";
    default:
      throw new FinalDemoError(`Invalid sequence ${seq}`, "WRONG_SEQUENCE");
  }
}

/**
 * Shared orchestration entry. Both dry-run and live call this function.
 */
export async function runFinalDemoOrchestration(
  deps: FinalDemoOrchestrationDeps,
): Promise<FinalDemoOrchestrationResult> {
  const env = deps.env ?? process.env;
  const isLive = deps.mode === FINAL_DEMO_MODE_LIVE;
  const paths = resolvePaths(deps);
  const clock = deps.clock;
  const attemptStore = new FinalDemoAttemptStore(paths.attempt);

  // ---- 1–3. Guards / readiness (before any side effect) ----
  // Live mode always requires env guards (no skip). Dry-run does not.
  if (isLive) {
    assertFinalDemoLiveAuthorized({
      enableFinalDemoLive: env.ENABLE_FINAL_DEMO_LIVE,
      enableLiveHedera: env.ENABLE_LIVE_HEDERA,
      enableLiveUsdcPayments: env.ENABLE_LIVE_USDC_PAYMENTS,
      enableLiveHcsWrites: env.ENABLE_LIVE_HCS_WRITES,
      enableLiveTopicCreate: env.ENABLE_LIVE_TOPIC_CREATE,
      enablePhase6bLiveExecute: env.ENABLE_PHASE6B_LIVE_EXECUTE,
      confirmFinalDemo: env.CONFIRM_FINAL_DEMO,
    });
  }

  const readiness = deps.readiness ?? {
    secretScan: () => assertSecretScanPass({ rootDir: process.cwd() }),
    usdcReadiness: async () =>
      isLive
        ? (await import("./usdc-readiness")).checkFinalDemoUsdcReadiness()
        : offlineUsdcReadinessPass(),
  };
  readiness.secretScan();

  if (readiness.accountCheck) {
    const ac = await readiness.accountCheck();
    if (!ac.ok) {
      throw new FinalDemoError(
        `Account check failed: ${ac.reasons.join("; ")}`,
        "ACCOUNT_CHECK_FAILED",
      );
    }
  }
  if (readiness.usdcReadiness) {
    const ur = await readiness.usdcReadiness();
    assertUsdcReadinessPass(ur);
  }

  // ---- 4–5. Materials + durable attempt ----
  let existing = await attemptStore.get();
  if (existing) {
    if (existing.mode !== deps.mode) {
      throw new FinalDemoError(
        "Attempt mode mismatch for orchestration path",
        "WRONG_ATTEMPT_KIND",
      );
    }
    // Offline dry-run may be re-run (overwrites artifacts). Live success is final.
    if (existing.status === "DRY_RUN_COMPLETE" && !isLive) {
      // Remove durable attempt so create() can start a new dry-run identity.
      try {
        const { unlinkSync, existsSync } = await import("node:fs");
        if (existsSync(paths.attempt)) unlinkSync(paths.attempt);
      } catch {
        // best effort
      }
      existing = null;
    } else if (existing.status === "COMPLETED") {
      throw new FinalDemoError(
        "Prior successful final-demo attempt exists",
        "ATTEMPT_ALREADY_SUCCESS",
      );
    } else if (
      existing.status === "AMBIGUOUS" ||
      existing.status === "TOPIC_CREATE_AMBIGUOUS" ||
      existing.topicCreateClaim.status === "AMBIGUOUS"
    ) {
      throw new FinalDemoError(
        "Prior ambiguous final-demo attempt — manual resolution required",
        "ATTEMPT_AMBIGUOUS",
      );
    } else if (existing.status === "FAILED" && isLive) {
      throw new FinalDemoError(
        "Prior failed final-demo attempt — manual review",
        "ATTEMPT_FAILED_BLOCKS_RERUN",
      );
    } else if (existing.status === "FAILED" && !isLive) {
      try {
        const { unlinkSync, existsSync } = await import("node:fs");
        if (existsSync(paths.attempt)) unlinkSync(paths.attempt);
      } catch {
        // best effort
      }
      existing = null;
    }
  }

  let materials: FinalDemoAuthoritativeMaterials;
  let attempt: FinalDemoAttemptRecord;

  if (
    existing &&
    existing.topicCreateClaim.status === "CLAIMED" &&
    !existing.topicId
  ) {
    throw new FinalDemoError(
      "Topic create claimed without result — manual resolution required (no second create)",
      "TOPIC_CREATE_AMBIGUOUS",
    );
  }

  if (existing && existing.attemptId && existing.runBaseTime) {
    // Resume or continue: reload materials (never create a new auction window).
    materials = loadFinalDemoAuthoritativeMaterials(paths.materials);
    if (materials.attemptId !== existing.attemptId) {
      throw new FinalDemoError(
        "Materials attemptId mismatch vs durable attempt",
        "MATERIALS_MISMATCH",
      );
    }
    if (materials.runBaseTime !== existing.runBaseTime) {
      throw new FinalDemoError(
        "runBaseTime must remain stable across restart",
        "AUCTION_WINDOW_RESET_FORBIDDEN",
      );
    }
    attempt = existing;
  } else {
    // Fresh start: generate materials then attempt.
    // Align fake/real clock base before generation when injectable.
    if (deps.runBaseTime && clock.setClockMs) {
      clock.setClockMs(Date.parse(deps.runBaseTime));
    }
    materials = generateFinalDemoAuthoritativeMaterials({
      ...(deps.templatePath ? { templatePath: deps.templatePath } : {}),
      runBaseTime: deps.runBaseTime ?? clock.nowIso(),
      ...(deps.auctionWindowSeconds !== undefined
        ? { auctionWindowSeconds: deps.auctionWindowSeconds }
        : {}),
      ...(deps.prepBufferSeconds !== undefined
        ? { prepBufferSeconds: deps.prepBufferSeconds }
        : !isLive
          ? { prepBufferSeconds: 0 }
          : {}),
      materialsPath: paths.materials,
      persist: true,
    });
    // Independent reload
    materials = loadFinalDemoAuthoritativeMaterials(paths.materials);
    // Keep clock coherent with durable runBaseTime (never invent a new window).
    if (clock.setClockMs) {
      const baseMs = Date.parse(materials.runBaseTime);
      if (!Number.isNaN(baseMs) && clock.nowMs() < baseMs) {
        clock.setClockMs(baseMs);
      }
    }
    attempt = createFinalDemoAttempt({
      mode: deps.mode,
      attemptId: materials.attemptId,
      shortAttemptId: materials.shortAttemptId,
      runBaseTime: materials.runBaseTime,
      tenderId: materials.identifiers.tenderId,
      reservationId: materials.identifiers.reservationId,
      attemptPath: paths.attempt,
      materialsPath: paths.materials,
    });
    attempt = withFinalDemoAttemptUpdate(attempt, {
      status: "MATERIALS_PERSISTED",
    });
    attempt = await persistAttempt(attemptStore, attempt);
  }

  // Resume path: also align clock to at least runBaseTime
  if (clock.setClockMs && materials.runBaseTime) {
    const baseMs = Date.parse(materials.runBaseTime);
    if (!Number.isNaN(baseMs) && clock.nowMs() < baseMs) {
      clock.setClockMs(baseMs);
    }
  }

  // ---- 6–8. Topic create (exactly one) ----
  if (!attempt.topicId) {
    if (attempt.topicCreateClaim.status === "NONE") {
      const claimId = `topic-claim-${randomUUID()}`;
      attempt = claimTopicCreate(attempt, claimId);
      attempt = await persistAttempt(attemptStore, attempt);
    }
    if (attempt.topicCreateClaim.status === "CLAIMED" && !attempt.topicId) {
      try {
        const topicMemo = `routeguard-final:${materials.shortAttemptId}`;
        const topicResult = await deps.topicTransport.createTopic(topicMemo);
        if (topicResult.topicId === HISTORICAL_PHASE5_TOPIC_ID) {
          throw new FinalDemoError(
            "Historical topic must never be used",
            "HISTORICAL_TOPIC_FORBIDDEN",
          );
        }
        if (!topicResult.topicId || !topicResult.transactionId) {
          throw new FinalDemoError(
            "Topic create result incomplete",
            "TOPIC_CREATE_FAILED",
          );
        }
        attempt = finalizeTopicCreate(attempt, {
          topicId: topicResult.topicId,
          topicCreateTransactionId: topicResult.transactionId,
          topicMemo: topicResult.topicMemo,
          createdAt: topicResult.createdAt,
        });
        attempt = await persistAttempt(attemptStore, attempt);
      } catch (e) {
        if (
          e instanceof FinalDemoError &&
          e.code === "TOPIC_CREATE_AMBIGUOUS"
        ) {
          attempt = markTopicCreateAmbiguous(attempt, e.message);
          await persistAttempt(attemptStore, attempt);
        }
        throw e;
      }
    }
  }

  const topicId = attempt.topicId!;
  if (topicId === HISTORICAL_PHASE5_TOPIC_ID) {
    throw new FinalDemoError(
      "Historical topic forbidden",
      "HISTORICAL_TOPIC_FORBIDDEN",
    );
  }
  if (deps.topicTransport.getCreateCount() > 1) {
    throw new FinalDemoError(
      "Topic create budget exceeded",
      "TOPIC_CREATE_BUDGET",
    );
  }

  const runMeta = {
    topicId,
    runId: materials.runId,
    tenderId: materials.identifiers.tenderId,
  };

  // ---- Helper: claim → submit → mirror-confirm one sequence ----
  async function publishSequence(
    label: FinalDemoMessageLabel,
    envelope: HcsEnvelope,
  ): Promise<{
    sequence: number;
    envelopeHash: string;
    transactionId: string;
    consensusTimestamp: string;
    byteCount: number;
  }> {
    const expectedSeq =
      label === "AUCTION_OPEN"
        ? 1
        : label === "BID_COMMITMENT_ALPHA"
          ? 2
          : label === "BID_COMMITMENT_BETA"
            ? 3
            : label === "AUCTION_CLOSE_BARRIER"
              ? 4
              : 5;

    const existingMsg = getOutboxMessage(attempt, label);
    if (existingMsg.status === "CONFIRMED") {
      return {
        sequence: existingMsg.sequence!,
        envelopeHash: existingMsg.envelopeHash!,
        transactionId: existingMsg.transactionId!,
        consensusTimestamp: existingMsg.consensusTimestamp!,
        byteCount: existingMsg.encodedByteCount ?? 0,
      };
    }
    if (
      existingMsg.status === "CLAIMED" ||
      existingMsg.status === "SUBMITTED" ||
      existingMsg.status === "AMBIGUOUS"
    ) {
      // Resolve via Mirror — never auto-resubmit.
      const msgs = await deps.topicMirrorReader.listMessages(topicId);
      const found = msgs.find(
        (m) =>
          m.sequence === expectedSeq &&
          existingMsg.envelopeHash &&
          m.envelopeHash === existingMsg.envelopeHash,
      );
      if (!found) {
        throw new FinalDemoError(
          `HCS ${label} claimed/submitted without Mirror confirmation — manual resolution`,
          "HCS_AMBIGUOUS",
        );
      }
      const recoveredTx =
        found.transactionId?.trim() || existingMsg.transactionId?.trim();
      if (!recoveredTx) {
        throw new FinalDemoError(
          `HCS ${label} Mirror FOUND without transaction ID — RESOLUTION_INCOMPLETE`,
          "HCS_MISSING_TRANSACTION_ID",
        );
      }
      if (!found.consensusTimestamp?.trim()) {
        throw new FinalDemoError(
          `HCS ${label} Mirror FOUND without consensus timestamp`,
          "HCS_MISSING_CONSENSUS",
        );
      }
      attempt = confirmMessageOutbox(attempt, label, {
        topicId,
        sequence: found.sequence,
        transactionId: recoveredTx,
        consensusTimestamp: found.consensusTimestamp,
        envelopeHash: found.envelopeHash,
      });
      attempt = await persistAttempt(attemptStore, attempt);
      return {
        sequence: found.sequence,
        envelopeHash: found.envelopeHash,
        transactionId: recoveredTx,
        consensusTimestamp: found.consensusTimestamp,
        byteCount: existingMsg.encodedByteCount ?? 0,
      };
    }

    const mirrorMsgs = await deps.topicMirrorReader.listMessages(topicId);
    assertMirrorReadyForSequence(mirrorMsgs, expectedSeq, runMeta);

    if (label === "BID_COMMITMENT_ALPHA" || label === "BID_COMMITMENT_BETA") {
      assertCommitmentTimeRemaining(
        materials.auctionEndsAt,
        clock.nowMs(),
        FINAL_DEMO_COMMITMENT_SAFETY_MARGIN_MS,
      );
    }
    if (label === "AUCTION_CLOSE_BARRIER") {
      assertBarrierAfterAuctionEnd(materials.auctionEndsAt, clock.nowMs());
    }

    const hash = envelopeHash(envelope);
    const exactBytes = serializeEnvelopeForSubmit(envelope);
    if (exactBytes.byteLength > HCS_MAX_MESSAGE_BYTES) {
      throw new FinalDemoError(
        `Envelope ${exactBytes.byteLength} exceeds ${HCS_MAX_MESSAGE_BYTES}`,
        "HCS_MESSAGE_TOO_LARGE",
      );
    }
    const submitAttemptId = `submit-${label}-${randomUUID()}`;

    attempt = claimMessageOutbox(attempt, label, {
      expectedTopic: topicId,
      envelope,
      envelopeHash: hash,
      encodedByteCount: exactBytes.byteLength,
      submitAttemptId,
    });
    attempt = await persistAttempt(attemptStore, attempt);

    let submitted;
    try {
      submitted = await deps.hcsTransport.submitMessage({
        topicId,
        envelope,
        label,
        exactBytes,
      });
    } catch (e) {
      attempt = withFinalDemoAttemptUpdate(attempt, {
        messageOutbox: attempt.messageOutbox.map((m) =>
          m.logicalLabel === label
            ? { ...m, status: "AMBIGUOUS" as const }
            : m,
        ),
        failureCode: "HCS_SUBMIT_AMBIGUOUS",
        failureReason: e instanceof Error ? e.message : String(e),
      });
      await persistAttempt(attemptStore, attempt);
      throw new FinalDemoError(
        `HCS submit ambiguous for ${label} — no auto-resubmit`,
        "HCS_SUBMIT_AMBIGUOUS",
      );
    }

    if (submitted.sequence !== expectedSeq) {
      throw new FinalDemoError(
        `Expected sequence ${expectedSeq}, got ${submitted.sequence}`,
        "WRONG_SEQUENCE",
      );
    }
    if (submitted.topicId !== topicId) {
      throw new FinalDemoError("Returned topic mismatch", "WRONG_TOPIC");
    }
    if (submitted.envelopeHash !== hash) {
      throw new FinalDemoError(
        "Submitted envelope hash mismatch",
        "ENVELOPE_HASH_MISMATCH",
      );
    }
    if (!submitted.transactionId?.trim()) {
      throw new FinalDemoError(
        "Missing transaction ID on HCS submit",
        "HCS_MISSING_TRANSACTION_ID",
      );
    }

    // Mirror confirm identical envelope hash
    let found: ObservedHcsMessage | undefined;
    if (deps.topicMirrorReader.waitForEnvelopeHash) {
      found = await deps.topicMirrorReader.waitForEnvelopeHash(topicId, hash, {
        timeoutMs: isLive ? 60_000 : 1_000,
        pollIntervalMs: isLive ? 1_000 : 10,
      });
    } else {
      const list = await deps.topicMirrorReader.listMessages(topicId);
      found = list.find(
        (m) => m.sequence === expectedSeq && m.envelopeHash === hash,
      );
    }
    if (!found || found.envelopeHash !== hash || found.sequence !== expectedSeq) {
      throw new FinalDemoError(
        "Mirror did not confirm envelope hash",
        "MIRROR_CONFIRM_FAILED",
      );
    }

    attempt = confirmMessageOutbox(attempt, label, {
      topicId,
      sequence: found.sequence,
      transactionId: submitted.transactionId,
      consensusTimestamp: found.consensusTimestamp,
      envelopeHash: hash,
    });
    attempt = await persistAttempt(attemptStore, attempt);

    return {
      sequence: found.sequence,
      envelopeHash: hash,
      transactionId: submitted.transactionId,
      consensusTimestamp: found.consensusTimestamp,
      byteCount: exactBytes.byteLength,
    };
  }

  // ---- 9–14. Sequences 1–3 ----
  const seq1 = await publishSequence(
    "AUCTION_OPEN",
    materials.auctionOpenEnvelope,
  );
  const seq2 = await publishSequence(
    "BID_COMMITMENT_ALPHA",
    materials.commitmentPayloads.alpha,
  );
  const seq3 = await publishSequence(
    "BID_COMMITMENT_BETA",
    materials.commitmentPayloads.beta,
  );

  // ---- 15. Wait until auctionEndsAt + barrier safety margin ----
  const endsMs = Date.parse(materials.auctionEndsAt);
  const waitUntil = endsMs + FINAL_DEMO_BARRIER_SAFETY_MARGIN_MS;
  const now = clock.nowMs();
  if (now < waitUntil) {
    const remaining = waitUntil - now;
    if (clock.advanceMs && !isLive) {
      // Dry-run: advance fake clock instead of sleeping wall time
      clock.advanceMs(remaining + 1);
    } else {
      await clock.sleep(remaining + 1);
    }
  }

  // ---- 16–18. Barrier from exact submitted commitment hashes ----
  const barrierEnvelope = createCloseBarrierEnvelope({
    runId: materials.runId,
    tenderId: materials.identifiers.tenderId,
    tenderVersion: materials.tenderBody.version,
    tenderHash: materials.tenderHash,
    createdAt: clock.nowIso(),
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
  const seq4 = await publishSequence("AUCTION_CLOSE_BARRIER", barrierEnvelope);

  // ---- 19. Mirror reconcile 1–4 ----
  // Complete observation set — never filter before validation (C2).
  const mirrorComplete = await deps.topicMirrorReader.listMessages(topicId);
  const materialsReloaded = loadFinalDemoAuthoritativeMaterials(paths.materials);
  const reconciliation: FinalDemoReconciliationResult =
    reconcileFinalDemoSequences1to4(
      {
        topicId,
        runId: materials.runId,
        tenderId: materials.identifiers.tenderId,
        tenderVersion: materials.tenderBody.version,
        tenderHash: materials.tenderHash,
        auctionEndsAt: materials.auctionEndsAt,
        messages: mirrorComplete,
        expectedCommitmentEnvelopeHashes: [
          materials.commitmentEnvelopeHashes.alpha,
          materials.commitmentEnvelopeHashes.beta,
        ],
      },
      materialsReloaded,
    );

  attempt = withFinalDemoAttemptUpdate(attempt, {
    status: "MIRROR_RECONCILED",
  });
  attempt = await persistAttempt(attemptStore, attempt);

  // ---- 20–21. Independent double proof reconstruction from disk ----
  const { doubleReconstructFinalDemoProofFromDisk } = await import("./proof");
  const materialsReadCount = { n: 0 };
  const { first: reconstructed, finalHashes } =
    doubleReconstructFinalDemoProofFromDisk({
      materialsPath: paths.materials,
      mirrorMessages: mirrorComplete,
      topicId,
      runId: materials.runId,
      tenderId: materials.identifiers.tenderId,
      tenderVersion: materials.tenderBody.version,
      tenderHash: materials.tenderHash,
      auctionEndsAt: materials.auctionEndsAt,
      expectedCommitmentEnvelopeHashes: [
        materials.commitmentEnvelopeHashes.alpha,
        materials.commitmentEnvelopeHashes.beta,
      ],
      onMaterialsRead: () => {
        materialsReadCount.n += 1;
      },
    });
  if (materialsReadCount.n < 2) {
    throw new FinalDemoError(
      "Double reconstruction must independently read materials twice",
      "PROOF_NOT_INDEPENDENT",
    );
  }

  attempt = withFinalDemoAttemptUpdate(attempt, {
    status: "PROOF_RECONSTRUCTED",
    finalHashes: {
      tenderHash: finalHashes.tenderHash,
      winningBidHash: finalHashes.winningBidHash,
      evaluatedBidSetHash: finalHashes.evaluatedBidSetHash,
      decisionManifestHash: finalHashes.decisionManifestHash,
    },
  });
  attempt = await persistAttempt(attemptStore, attempt);

  // ---- 22–25. ReservationService + conservative envelope ----
  const conservative = measureFinalDemoConservativeEnvelope({
    reservationId: materials.identifiers.reservationId,
    tenderId: reconstructed.tender.tenderId,
    tenderVersion: reconstructed.tender.version,
    tenderHash: reconstructed.tenderHash,
    winningBidId: reconstructed.winningBidId,
    winningBidHash: reconstructed.winningBidHash,
    carrierId: reconstructed.winningCarrierId,
    carrierAccount: reconstructed.winningCarrierAccount,
    decisionManifestHash: reconstructed.decisionManifestHash,
    evaluatedBidSetHash: reconstructed.evaluatedBidSetHash,
    hcsTopicId: topicId,
  });
  if (conservative.byteCount > HCS_MAX_MESSAGE_BYTES) {
    throw new FinalDemoError(
      `Conservative envelope ${conservative.byteCount} exceeds limit`,
      "HCS_MESSAGE_TOO_LARGE",
    );
  }

  // Filesystem store for both dry and live (separate directories).
  const store: ReservationStore =
    deps.reservationStore ??
    new FileSystemReservationStore(paths.reservationDir);

  // HCS publisher for ReservationService: publishes ROUTE_RESERVED as seq 5
  // through final-demo outbox + hcsTransport (same path as seq 1–4).
  const seq5Holder: {
    result: {
      sequence: number;
      envelopeHash: string;
      transactionId: string;
      consensusTimestamp: string;
      byteCount: number;
    } | null;
  } = { result: null };

  const reservationHcs: HcsPublisherTransport = {
    async publish(envelope) {
      if (envelope.messageType !== "ROUTE_RESERVED") {
        throw new FinalDemoError(
          "Reservation HCS publisher only accepts ROUTE_RESERVED",
          "HCS_MESSAGE_TYPE_MISMATCH",
        );
      }
      // Preflight: highest must be 4
      const msgs = await deps.topicMirrorReader.listMessages(topicId);
      assertMirrorReadyForSequence(msgs, 5, {
        topicId,
        runId: materials.runId,
        tenderId: materials.identifiers.tenderId,
      });
      // Note: ROUTE_RESERVED uses runId reservation-* — preflight checks
      // auction runId on prior messages only (seqs 1–4). Seq 5 runId differs.
      // Use a relaxed preflight: max sequence 4, no foreign messages.
      const max = msgs.reduce((a, m) => Math.max(a, m.sequence), 0);
      if (max !== 4) {
        throw new FinalDemoError(
          `Cannot publish seq 5: highest sequence is ${max}`,
          "TOPIC_SEQUENCE_UNEXPECTED",
        );
      }
      for (const m of msgs) {
        if (m.topicId !== topicId) {
          throw new FinalDemoError("Wrong topic on Mirror", "WRONG_TOPIC");
        }
        if (m.topicId === HISTORICAL_PHASE5_TOPIC_ID) {
          throw new FinalDemoError(
            "Historical topic",
            "HISTORICAL_TOPIC_FORBIDDEN",
          );
        }
      }

      const result = await publishSequence("ROUTE_RESERVED", envelope);
      seq5Holder.result = result;
      return {
        topicId,
        sequence: result.sequence,
        transactionId: result.transactionId,
        consensusTimestamp: result.consensusTimestamp,
      };
    },
  };

  // Override publishSequence for ROUTE_RESERVED runId check on mirror ready:
  // For seq 5, assertMirrorReadyForSequence checks runId on ALL messages —
  // prior messages have auction runId. That's fine. New message not yet present.

  const service = new ReservationService({
    store,
    registry: reconstructed.registry,
    challenge: new LocalX402ChallengeAdapter(),
    facilitator: deps.facilitatorTransport,
    mirror: deps.paymentMirrorTransport,
    webhooks: deps.webhookTransport,
    hcs: reservationHcs,
    webhookSigningPrivateKey:
      deps.webhookSigningPrivateKey ?? DEFAULT_WEBHOOK_KEY,
    now: () => clock.nowIso(),
    nowMs: () => clock.nowMs(),
    sleep: async (ms) => {
      if (clock.advanceMs && !isLive) {
        clock.advanceMs(ms);
      } else {
        await clock.sleep(ms);
      }
    },
    confirmationTimeoutMs: deps.confirmationTimeoutMs ?? (isLive ? 60_000 : 2_000),
    mirrorPollIntervalMs: deps.mirrorPollIntervalMs ?? (isLive ? 2_000 : 10),
  });
  deps.onReservationServiceCreated?.(service);

  // assertUsdcOnlySelection uses phase6b constants — same accounts/token/amount
  void assertPhase6bUsdc;

  let reservation = await store.get(materials.identifiers.reservationId);

  if (!reservation) {
    const created = await service.createReservation(
      {
        reservationId: materials.identifiers.reservationId,
        tenderId: reconstructed.tender.tenderId,
        tenderVersion: reconstructed.tender.version,
        tenderHash: reconstructed.tenderHash,
        winningBidId: reconstructed.winningBidId,
        winningBidHash: reconstructed.winningBidHash,
        winningCarrierId: reconstructed.winningCarrierId,
        winningCarrierAccount: reconstructed.winningCarrierAccount,
        decisionManifestHash: reconstructed.decisionManifestHash,
        evaluatedBidSetHash: reconstructed.evaluatedBidSetHash,
        hcsTopicId: topicId,
        closeBarrierSequence: 4,
        closeBarrierConsensusTimestamp:
          reconciliation.closeBarrierConsensusTimestamp,
        closureProof: reconstructed.proof,
        reservationOfferVersion: 1,
        createdAt: clock.nowIso(),
        expiresAt: new Date(clock.nowMs() + 3_600_000).toISOString(),
      },
      reconstructed.tender,
    );
    reservation = created;
  }

  // Cross-check topic/reservation id
  if (reservation.reservationId !== materials.identifiers.reservationId) {
    throw new FinalDemoError("reservationId mismatch", "RESERVATION_MISMATCH");
  }
  if (reservation.hcsTopicId !== topicId) {
    throw new FinalDemoError("hcsTopicId mismatch", "WRONG_TOPIC");
  }

  if (!reservation.selected || reservation.selected.optionId !== "USDC") {
    reservation = await service.selectOption({
      reservationId: reservation.reservationId,
      optionId: "USDC",
      offerHash: reservation.offer.offerHash,
      offerVersion: reservation.offer.offerVersion,
      payerAccount: FINAL_DEMO_PAYER_ACCOUNT,
    });
  }

  if (reservation.selected!.optionId !== "USDC") {
    throw new FinalDemoError("USDC only", "USDC_ONLY");
  }
  if (reservation.selected!.payTo !== FINAL_DEMO_WINNER_ACCOUNT) {
    throw new FinalDemoError("Receiver mismatch", "WRONG_RECEIVER");
  }
  if (reservation.selected!.asset !== FINAL_DEMO_USDC_TOKEN) {
    throw new FinalDemoError("Token mismatch", "WRONG_TOKEN");
  }
  if (reservation.selected!.amountAtomic !== FINAL_DEMO_USDC_AMOUNT_ATOMIC) {
    throw new FinalDemoError("Amount mismatch", "WRONG_AMOUNT");
  }
  if (reservation.selected!.payerAccount !== FINAL_DEMO_PAYER_ACCOUNT) {
    throw new FinalDemoError("Payer mismatch", "WRONG_PAYER");
  }

  if (!reservation.paymentChallenge) {
    const issued = await service.issueChallenge(reservation.reservationId, "USDC");
    reservation = issued.record;
  }
  const challenge = reservation.paymentChallenge;
  if (!challenge) {
    throw new FinalDemoError(
      "Payment challenge missing after issue",
      "NO_CHALLENGE",
    );
  }

  // ---- 26–30. Payment via ReservationService ----
  if (
    attempt.paymentSubmissionClaim.status === "CLAIMED" &&
    !attempt.paymentSubmissionClaim.transactionId &&
    !reservation.transactionId
  ) {
    // Outer claim without tx — try ReservationService recovery only if safe
    if (reservation.settleClaim && !reservation.transactionId) {
      throw new FinalDemoError(
        "Payment claimed without transaction ID — manual review (no second sign/settle)",
        "PAYMENT_AMBIGUOUS",
      );
    }
    if (reservation.transactionId) {
      reservation = await service.resumePaymentConfirmation(
        reservation.reservationId,
      );
    } else {
      throw new FinalDemoError(
        "PAYMENT_SUBMISSION_CLAIMED without safe resume path",
        "PAYMENT_AMBIGUOUS",
      );
    }
  } else if (!reservation.routeReserved) {
    if (
      reservation.transactionId &&
      (reservation.state === "FACILITATOR_SETTLED" ||
        reservation.state === "MIRROR_CONFIRMATION_PENDING")
    ) {
      reservation = await service.resumePaymentConfirmation(
        reservation.reservationId,
      );
    } else if (
      reservation.state === "ROUTE_RESERVED" ||
      reservation.state === "WEBHOOKS_DISPATCHED" ||
      reservation.state === "HCS_EVIDENCE_RECORDED" ||
      reservation.state === "COMPLETED" ||
      reservation.state === "HCS_EVIDENCE_FAILED" ||
      reservation.state === "WEBHOOK_DELIVERY_FAILED"
    ) {
      // continue to outbox / evidence
    } else {
      // Fresh payment path
      // Payment payload generation gate (H5): only from PAYMENT_CHALLENGE_ISSUED
      // with no prior claim/hash/tx.
      if (
        reservation.state !== "PAYMENT_CHALLENGE_ISSUED" ||
        reservation.paymentPayloadHash ||
        reservation.settleClaim ||
        reservation.facilitatorSettle ||
        reservation.transactionId
      ) {
        throw new FinalDemoError(
          `Cannot generate payment payload from reservation state ${reservation.state}`,
          "PAYMENT_PAYLOAD_GATE",
        );
      }
      // Pristine topic re-check immediately before signing
      const prePayMsgs = await deps.topicMirrorReader.listMessages(topicId);
      assertPristineTopicSequences1to4(prePayMsgs, {
        topicId,
        runId: materials.runId,
        tenderId: materials.identifiers.tenderId,
        tenderVersion: materials.tenderBody.version,
        tenderHash: materials.tenderHash,
      });

      if (attempt.paymentSubmissionClaim.status === "NONE") {
        attempt = withFinalDemoAttemptUpdate(attempt, {
          status: "PAYMENT_SUBMISSION_CLAIMED",
          paymentSubmissionClaim: {
            claimedAt: clock.nowIso(),
            claimId: `pay-claim-${randomUUID()}`,
            status: "CLAIMED",
            transactionId: null,
          },
        });
        attempt = await persistAttempt(attemptStore, attempt);
      } else if (attempt.paymentSubmissionClaim.status === "CLAIMED") {
        throw new FinalDemoError(
          "Payment submission already claimed — no second payload generation",
          "PAYMENT_ALREADY_CLAIMED",
        );
      }

      // Signed payload in process memory only
      const { paymentPayload, requirement, paymentPayloadHash } =
        await deps.paymentPayloadFactory({
          selected: {
            optionId: "USDC",
            scheme: reservation.selected!.scheme,
            network: reservation.selected!.network,
            asset: reservation.selected!.asset,
            amountAtomic: reservation.selected!.amountAtomic,
            payTo: reservation.selected!.payTo,
            payerAccount: reservation.selected!.payerAccount,
            reservationId: reservation.reservationId,
            offerHash: reservation.selected!.offerHash,
            offerVersion: reservation.selected!.offerVersion,
            selectedAt: reservation.selected!.selectedAt,
            resourcePath: reservation.selected!.resourcePath,
          },
          challenge: {
            x402Version: challenge.x402Version,
            scheme: challenge.scheme,
            network: challenge.network,
            asset: challenge.asset,
            amount: challenge.amount,
            payTo: challenge.payTo,
            resource: challenge.resource,
            maxTimeoutSeconds: challenge.maxTimeoutSeconds,
            description: challenge.description,
          },
        });

      // Ensure payload is not retained beyond this scope after submit
      deps.facilitatorTransport.bindPaymentSession({
        paymentPayload: paymentPayload as PaymentPayload,
        requirement,
        paymentPayloadHash,
        challengeHash: challenge.challengeHash,
      });

      try {
        reservation = await service.submitPayment({
          reservationId: reservation.reservationId,
          optionId: "USDC",
          paymentPayloadHash,
        });
      } finally {
        deps.facilitatorTransport.clearPaymentSession();
      }

      if (reservation.transactionId) {
        attempt = withFinalDemoAttemptUpdate(attempt, {
          status: reservation.routeReserved
            ? "PAYMENT_CONFIRMED"
            : "PAYMENT_SUBMITTED",
          paymentSubmissionClaim: {
            claimedAt: attempt.paymentSubmissionClaim.claimedAt,
            claimId: attempt.paymentSubmissionClaim.claimId,
            status: reservation.routeReserved ? "CONFIRMED" : "SUBMITTED",
            transactionId: reservation.transactionId,
          },
        });
        attempt = await persistAttempt(attemptStore, attempt);
      }
    }
  }

  // Resume webhooks / HCS if payment done but seq 5 not confirmed
  if (
    reservation.routeReserved &&
    getOutboxMessage(attempt, "ROUTE_RESERVED").status !== "CONFIRMED"
  ) {
    if (
      reservation.hcsPublicationClaim?.status === "PUBLISHED" &&
      reservation.hcsPublicationClaim.sequence === 5
    ) {
      attempt = confirmMessageOutbox(attempt, "ROUTE_RESERVED", {
        topicId,
        sequence: 5,
        transactionId: reservation.hcsPublicationClaim.transactionId!,
        consensusTimestamp:
          reservation.hcsPublicationClaim.consensusTimestamp!,
        envelopeHash: reservation.hcsPublicationClaim.envelopeHash,
      });
      attempt = await persistAttempt(attemptStore, attempt);
      seq5Holder.result = {
        sequence: 5,
        envelopeHash: reservation.hcsPublicationClaim.envelopeHash,
        transactionId: reservation.hcsPublicationClaim.transactionId!,
        consensusTimestamp:
          reservation.hcsPublicationClaim.consensusTimestamp!,
        byteCount: reservation.hcsPublicationClaim.encodedByteCount,
      };
    } else {
      reservation = await service.resumeWebhookDispatch(
        reservation.reservationId,
      );
      reservation = await service.resumeHcsPublication(
        reservation.reservationId,
      );
    }
  }

  if (!reservation.routeReserved) {
    throw new FinalDemoError(
      `Payment/reservation incomplete: state=${reservation.state}`,
      "PAYMENT_INCOMPLETE",
    );
  }

  // Cross-checks
  if (reservation.hcsTopicId !== topicId) {
    throw new FinalDemoError("Topic binding mismatch", "WRONG_TOPIC");
  }
  if (reservation.closeBarrierSequence !== 4) {
    throw new FinalDemoError("Barrier sequence must be 4", "BARRIER_MISMATCH");
  }
  if (reservation.routeReserved.hcsAuctionTopicId !== topicId) {
    throw new FinalDemoError(
      "ROUTE_RESERVED topic mismatch",
      "WRONG_TOPIC",
    );
  }
  if (reservation.routeReserved.closeBarrierSequence !== 4) {
    throw new FinalDemoError("RR barrier mismatch", "BARRIER_MISMATCH");
  }
  if (
    attempt.paymentSubmissionClaim.transactionId &&
    reservation.transactionId &&
    attempt.paymentSubmissionClaim.transactionId !== reservation.transactionId
  ) {
    throw new FinalDemoError(
      "Payment transaction ID mismatch between attempt and reservation",
      "PAYMENT_TX_MISMATCH",
    );
  }

  const seq5Out = getOutboxMessage(attempt, "ROUTE_RESERVED");
  if (seq5Out.status !== "CONFIRMED") {
    throw new FinalDemoError(
      "Sequence 5 not confirmed on final-demo outbox",
      "SEQ5_NOT_CONFIRMED",
    );
  }
  if (seq5Out.sequence !== 5) {
    throw new FinalDemoError("Sequence must be 5", "WRONG_SEQUENCE");
  }

  const actualByteCount =
    seq5Holder.result?.byteCount ??
    seq5Out.encodedByteCount ??
    measureRouteReservedEnvelope(
      createRouteReservedHcsEnvelope({
        runId: `reservation-${reservation.reservationId}`,
        tenderId: reservation.tenderId,
        tenderVersion: reservation.tenderVersion,
        tenderHash: reservation.tenderHash,
        createdAt: clock.nowIso(),
        payload: buildRouteReservedPayload(
          reservation.routeReserved,
          reservation.winningCarrierId,
        ),
      }),
    );

  if (actualByteCount > HCS_MAX_MESSAGE_BYTES) {
    throw new FinalDemoError(
      `Actual ROUTE_RESERVED ${actualByteCount} exceeds limit`,
      "HCS_MESSAGE_TOO_LARGE",
    );
  }

  // ---- 33–34. Evidence state machine BEFORE COMPLETED (H3) ----
  attempt = withFinalDemoAttemptUpdate(attempt, {
    status: "EVIDENCE_PENDING",
    routeReservedRecordHash: reservation.routeReserved.reservationRecordHash,
    reservationServiceRecordPath: `reservation:${reservation.reservationId}`,
    paymentSubmissionClaim: {
      claimedAt: attempt.paymentSubmissionClaim.claimedAt,
      claimId: attempt.paymentSubmissionClaim.claimId,
      status: "CONFIRMED",
      transactionId: reservation.transactionId,
    },
    evidenceWrite: {
      status: "PENDING",
      claimedAt: clock.nowIso(),
      claimId: `ev-${randomUUID()}`,
      expectedEvidenceHash: null,
      jsonHash: null,
      mdHash: null,
    },
    evidencePaths: {
      materials: paths.materials,
      attempt: paths.attempt,
      resultJson: paths.json,
      resultMd: paths.md,
    },
  });
  attempt = await persistAttempt(attemptStore, attempt);

  attempt = withFinalDemoAttemptUpdate(attempt, {
    status: "EVIDENCE_WRITING",
    evidenceWrite: {
      ...attempt.evidenceWrite,
      status: "WRITING",
    },
  });
  attempt = await persistAttempt(attemptStore, attempt);

  const sequences = [1, 2, 3, 4, 5].map((seq) => {
    const label = labelForSequence(seq);
    const m = getOutboxMessage(attempt, label);
    return {
      sequence: seq,
      label,
      envelopeHash: m.envelopeHash!,
      transactionId: m.transactionId!,
      consensusTimestamp: m.consensusTimestamp!,
    };
  });

  const tokenTransfers =
    reservation.mirrorConfirmation?.tokenTransfers?.map((t) => {
      const row: { account: string; tokenId?: string; amount: string } = {
        account: t.account,
        amount: t.amount,
      };
      if (t.tokenId !== undefined) row.tokenId = t.tokenId;
      return row;
    }) ?? [];

  const settleCount =
    typeof deps.facilitatorTransport.settleCallCount === "number"
      ? deps.facilitatorTransport.settleCallCount
      : null;

  const result: FinalDemoOrchestrationResult = {
    mode: deps.mode,
    disclosure: SYNTHETIC_DATA_DISCLOSURE,
    historicalTopicDisclosure: HISTORICAL_TOPIC_DISCLOSURE,
    attempt,
    materials: {
      attemptId: materials.attemptId,
      shortAttemptId: materials.shortAttemptId,
      tenderId: materials.identifiers.tenderId,
      bidAlphaId: materials.identifiers.bidAlphaId,
      bidBetaId: materials.identifiers.bidBetaId,
      reservationId: materials.identifiers.reservationId,
      tenderHash: materials.tenderHash,
      bidHashes: materials.bidHashes,
      receiptHashes: materials.receiptHashes,
      commitmentEnvelopeHashes: materials.commitmentEnvelopeHashes,
    },
    topic: {
      topicId,
      topicCreateTransactionId: attempt.topicCreateTransactionId!,
      topicMemo: attempt.topicMemo ?? `routeguard-final:${materials.shortAttemptId}`,
    },
    sequences,
    auctionEndsAt: materials.auctionEndsAt,
    barrierConsensusTimestamp: reconciliation.closeBarrierConsensusTimestamp,
    reconciliationReference: reconciliation.reconciliationReference,
    finalHashes,
    winner: {
      bidId: reconstructed.winningBidId,
      carrierId: reconstructed.winningCarrierId,
      carrierAccount: reconstructed.winningCarrierAccount,
    },
    payment: {
      selectedOptionId: "USDC",
      payer: FINAL_DEMO_PAYER_ACCOUNT,
      receiver: FINAL_DEMO_WINNER_ACCOUNT,
      token: FINAL_DEMO_USDC_TOKEN,
      amount: FINAL_DEMO_USDC_AMOUNT_ATOMIC,
      carrierReceivedAmountAtomic: FINAL_DEMO_USDC_AMOUNT_ATOMIC,
      challengeStatedHederaNetworkTransferCostUsd:
        STABLECOIN_NETWORK_TRANSFER_COST_USD,
      economics: buildPaymentEconomicsSummary({
        optionId: "USDC",
        asset: FINAL_DEMO_USDC_TOKEN,
        amountAtomic: FINAL_DEMO_USDC_AMOUNT_ATOMIC,
        displayAmount: "0.01",
        currencyLabel: "USDC",
      }),
      transactionId: reservation.transactionId!,
      consensusTimestamp:
        reservation.routeReserved.consensusTimestamp ??
        reservation.mirrorConfirmation?.consensusTimestamp ??
        "",
      tokenTransfers,
    },
    reservationRecordHash: reservation.routeReserved.reservationRecordHash,
    routeReserved: {
      sequence: 5,
      envelopeHash: seq5Out.envelopeHash!,
      byteCount: actualByteCount,
      transactionId: seq5Out.transactionId!,
      consensusTimestamp: seq5Out.consensusTimestamp!,
    },
    conservativeEnvelopeByteCount: conservative.byteCount,
    dryRunEnvelopeByteCount: actualByteCount,
    envelopeWithinLimit:
      actualByteCount <= HCS_MAX_MESSAGE_BYTES &&
      conservative.byteCount <= HCS_MAX_MESSAGE_BYTES,
    networkWrites: {
      topicCreates: deps.topicTransport.getCreateCount(),
      hcsSubmits: deps.hcsTransport.getSubmitCount(),
      payments: settleCount ?? (reservation.transactionId ? 1 : 0),
      realNetwork: isLive,
    },
    evidencePaths: paths,
    finalState: isLive ? "COMPLETED" : "DRY_RUN_COMPLETE",
    settleCallCount: settleCount,
    reservation,
    webhookEventIds: reservation.webhookEvents.map((e) => e.eventId),
    webhookPayloadHashes: reservation.webhookEvents.map((e) => e.payloadHash),
  };

  assertNoPrivateKeyFields(result, "final-demo-result");
  // Write evidence then CAS to EVIDENCE_WRITTEN then COMPLETED
  const evidenceBody = sanitizeEvidence(result);
  atomicWriteJson(paths.json, evidenceBody);
  // Independent reload of JSON
  const reloadedJson = JSON.parse(
    (await import("node:fs")).readFileSync(paths.json, "utf8"),
  ) as Record<string, unknown>;
  assertNoPrivateKeyFields(reloadedJson, "final-demo-result-reload");
  atomicWriteText(paths.md, formatEvidenceMarkdown(result));
  const mdText = (await import("node:fs")).readFileSync(paths.md, "utf8");
  if (!mdText.includes(result.topic.topicId) || !mdText.includes(result.materials.attemptId)) {
    throw new FinalDemoError(
      "Evidence markdown missing required identifiers",
      "EVIDENCE_INVALID",
    );
  }

  const finalStatus = isLive ? ("COMPLETED" as const) : ("DRY_RUN_COMPLETE" as const);
  attempt = withFinalDemoAttemptUpdate(attempt, {
    status: "EVIDENCE_WRITTEN",
    evidenceWrite: {
      ...attempt.evidenceWrite,
      status: "WRITTEN",
      jsonHash: null,
      mdHash: null,
    },
  });
  attempt = await persistAttempt(attemptStore, attempt);
  attempt = withFinalDemoAttemptUpdate(attempt, {
    status: finalStatus,
  });
  attempt = await persistAttempt(attemptStore, attempt);
  result.attempt = attempt;
  result.finalState = finalStatus;

  return result;
}

function sanitizeEvidence(
  r: FinalDemoOrchestrationResult,
): Record<string, unknown> {
  // Drop live reservation object internals that may be large; keep public summary
  const {
    reservation: _res,
    attempt: attemptRecord,
    ...rest
  } = r;
  void _res;
  return {
    ...rest,
    attempt: {
      attemptId: attemptRecord.attemptId,
      shortAttemptId: attemptRecord.shortAttemptId,
      mode: attemptRecord.mode,
      status: attemptRecord.status,
      topicId: attemptRecord.topicId,
      topicCreateTransactionId: attemptRecord.topicCreateTransactionId,
      plannedTopicCreates: attemptRecord.plannedTopicCreates,
      plannedHcsSubmissions: attemptRecord.plannedHcsSubmissions,
      plannedPaymentSubmissions: attemptRecord.plannedPaymentSubmissions,
      paymentTransactionId: attemptRecord.paymentSubmissionClaim.transactionId,
      routeReservedRecordHash: attemptRecord.routeReservedRecordHash,
      finalHashes: attemptRecord.finalHashes,
    },
    hashScanTopic: r.topic.topicId
      ? `https://hashscan.io/testnet/topic/${r.topic.topicId}`
      : null,
    hashScanTopicCreate: r.topic.topicCreateTransactionId
      ? `https://hashscan.io/testnet/transaction/${r.topic.topicCreateTransactionId}`
      : null,
    hashScanPayment: r.payment.transactionId
      ? `https://hashscan.io/testnet/transaction/${r.payment.transactionId}`
      : null,
    mirrorTopic: r.topic.topicId
      ? `https://testnet.mirrornode.hedera.com/api/v1/topics/${r.topic.topicId}/messages`
      : null,
  };
}

function formatEvidenceMarkdown(r: FinalDemoOrchestrationResult): string {
  return `# Final Demo ${r.mode === FINAL_DEMO_MODE_LIVE ? "Live" : "Dry-Run"} Evidence

## Disclosure

${r.disclosure}

## Historical topic

${r.historicalTopicDisclosure}

**Authority topic: \`${r.topic.topicId}\` — not ${HISTORICAL_PHASE5_TOPIC_ID}.**

## Attempt

- Mode: \`${r.mode}\`
- Attempt ID: \`${r.materials.attemptId}\`
- Short ID: \`${r.materials.shortAttemptId}\`
- Final state: \`${r.finalState}\`

## Topic

- Topic ID: \`${r.topic.topicId}\`
- Create tx: \`${r.topic.topicCreateTransactionId}\`
- Memo: \`${r.topic.topicMemo}\`

## HCS sequences 1–5

| Seq | Label | Envelope hash | Consensus |
|-----|-------|---------------|-----------|
${r.sequences
  .map(
    (s) =>
      `| ${s.sequence} | ${s.label} | \`${s.envelopeHash}\` | \`${s.consensusTimestamp}\` |`,
  )
  .join("\n")}

## Proof

- Winner: \`${r.winner.carrierId}\` / \`${r.winner.bidId}\` / \`${r.winner.carrierAccount}\`
- winningBidHash: \`${r.finalHashes.winningBidHash}\`
- evaluatedBidSetHash: \`${r.finalHashes.evaluatedBidSetHash}\`
- decisionManifestHash: \`${r.finalHashes.decisionManifestHash}\`
- Reconciliation: \`${r.reconciliationReference}\`
- Barrier consensus: \`${r.barrierConsensusTimestamp}\`
- Auction ends: \`${r.auctionEndsAt}\`

## Payment (ReservationService)

- Selected rail: \`${r.payment.selectedOptionId}\`
- Carrier reservation payment: \`${r.payment.amount}\` atomic of token \`${r.payment.token}\`
- Carrier-received amount: \`${r.payment.carrierReceivedAmountAtomic}\` (network cost not deducted)
- Challenge-stated fixed Hedera network transfer cost: \`$${r.payment.challengeStatedHederaNetworkTransferCostUsd}\` USD
- Facilitator fee: \`${r.payment.economics.facilitatorFee.status}\`
- RouteGuard platform fee: \`${r.payment.economics.routeGuardPlatformFee.status}\`
- Payer \`${r.payment.payer}\` → receiver \`${r.payment.receiver}\`
- Tx: \`${r.payment.transactionId}\`
- Consensus: \`${r.payment.consensusTimestamp}\`
- Settle count (process): ${r.settleCallCount ?? "n/a"}

### Payment economics lines

${formatPaymentEconomicsLines(r.payment.economics)
  .map((line) => `- ${line}`)
  .join("\n")}

## ROUTE_RESERVED

- Sequence: 5
- Byte count: ${r.routeReserved.byteCount} (limit ${HCS_MAX_MESSAGE_BYTES})
- Conservative budget: ${r.conservativeEnvelopeByteCount}
- Record hash: \`${r.reservationRecordHash}\`

## Webhooks

${r.webhookEventIds.map((id, i) => `- \`${id}\` hash \`${r.webhookPayloadHashes[i]}\``).join("\n")}

## Network writes

Real network: **${r.networkWrites.realNetwork}**
Counts: topicCreates=${r.networkWrites.topicCreates}, hcs=${r.networkWrites.hcsSubmits}, payments=${r.networkWrites.payments}
`;
}

