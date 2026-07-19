/**
 * Final-demo offline dry-run — zero network writes.
 * Simulates topic create, sequences 1–5, Mirror reconcile, proof, payment, evidence.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";

import { createCloseBarrierEnvelope, envelopeHash } from "../hcs/message-envelope";
import { serializeEnvelopeForSubmit } from "../hcs/message-envelope";
import { CLOSE_POLICY, HCS_MAX_MESSAGE_BYTES } from "../hcs/types";
import { InMemoryReservationStore } from "../reservation/attempt-store";
import {
  buildRouteReservedPayload,
  createRouteReservedHcsEnvelope,
  measureRouteReservedEnvelope,
} from "../reservation/hcs-evidence";
import {
  LocalDemoWebhookTransport,
  LocalX402ChallengeAdapter,
  LiveFacilitatorAdapter,
  LiveHcsPublisherAdapter,
  assertUsdcOnlySelection,
} from "../reservation/live/adapters";
import { ReservationService } from "../reservation/reservation-service";
import { createRouteReservedRecord } from "../reservation/route-reserved-record";
import { atomicWriteJson, atomicWriteText } from "./atomic-write";
import {
  claimMessageOutbox,
  claimTopicCreate,
  confirmMessageOutbox,
  createFinalDemoAttempt,
  finalizeTopicCreate,
  persistFinalDemoAttempt,
  withFinalDemoAttemptUpdate,
  type FinalDemoAttemptRecord,
} from "./attempt-store";
import {
  FINAL_DEMO_BARRIER_SAFETY_MARGIN_MS,
  FINAL_DEMO_COMMITMENT_SAFETY_MARGIN_MS,
  FINAL_DEMO_DRY_RUN_ATTEMPT_PATH,
  FINAL_DEMO_DRY_RUN_JSON_PATH,
  FINAL_DEMO_DRY_RUN_MD_PATH,
  FINAL_DEMO_MATERIALS_PATH,
  FINAL_DEMO_MODE_DRY,
  FINAL_DEMO_PAYER_ACCOUNT,
  FINAL_DEMO_USDC_AMOUNT_ATOMIC,
  FINAL_DEMO_USDC_TOKEN,
  FINAL_DEMO_WINNER_ACCOUNT,
  HISTORICAL_PHASE5_TOPIC_ID,
  HISTORICAL_TOPIC_DISCLOSURE,
  SYNTHETIC_DATA_DISCLOSURE,
} from "./constants";
import { measureFinalDemoConservativeEnvelope } from "./envelope-budget";
import { FinalDemoError } from "./errors";
import {
  generateFinalDemoAuthoritativeMaterials,
  loadFinalDemoAuthoritativeMaterials,
  parseFinalDemoAuthoritativeMaterials,
  type FinalDemoAuthoritativeMaterials,
} from "./materials";
import { MockFinalDemoNetwork } from "./mock-network";
import { doubleReconstructFinalDemoProof } from "./proof";
import {
  assertMirrorReadyForSequence,
  reconcileFinalDemoSequences1to4,
} from "./reconciliation";
import { assertNoPrivateKeyFields, assertSecretScanPass } from "./secret-scan";
import {
  assertBarrierAfterAuctionEnd,
  assertCommitmentTimeRemaining,
} from "./timing";
import {
  buildPaymentEconomicsSummary,
  formatPaymentEconomicsLines,
} from "../domain/payment-economics";
import { STABLECOIN_NETWORK_TRANSFER_COST_USD } from "../domain/hedera-transfer-costs";

const DRY_RUN_WEBHOOK_KEY =
  "7a8b9c0d1e2f30415263748596a7b8c9d0e1f2031425364758697a8b9c0d1e2f";

export type FinalDemoDryRunResult = {
  mode: "OFFLINE_DRY_RUN";
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
      tokenId: string;
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
    realNetwork: false;
  };
  evidencePaths: {
    materials: string;
    attempt: string;
    json: string;
    md: string;
  };
  finalState: "COMPLETED";
};

export type FinalDemoDryRunDeps = {
  workDir?: string;
  templatePath?: string;
  runBaseTime?: string;
  auctionWindowSeconds?: number;
  /** Skip repo-wide secret scan (unit tests with temp dirs). */
  skipSecretScan?: boolean;
  now?: () => string;
};

export async function runFinalDemoDryRun(
  deps: FinalDemoDryRunDeps = {},
): Promise<FinalDemoDryRunResult> {
  const workDir = deps.workDir ?? process.cwd();
  const materialsPath = path.join(
    workDir,
    path.basename(FINAL_DEMO_MATERIALS_PATH) === "final-demo-authoritative-materials.json" &&
      workDir !== process.cwd()
      ? "final-demo-authoritative-materials.json"
      : FINAL_DEMO_MATERIALS_PATH,
  );
  // When workDir is a temp dir, write all artifacts under it
  const useTemp = Boolean(deps.workDir);
  const paths = {
    materials: useTemp
      ? path.join(workDir, "final-demo-authoritative-materials.json")
      : path.resolve(FINAL_DEMO_MATERIALS_PATH),
    attempt: useTemp
      ? path.join(workDir, "final-demo-dry-run-attempt.json")
      : path.resolve(FINAL_DEMO_DRY_RUN_ATTEMPT_PATH),
    json: useTemp
      ? path.join(workDir, "final-demo-dry-run.json")
      : path.resolve(FINAL_DEMO_DRY_RUN_JSON_PATH),
    md: useTemp
      ? path.join(workDir, "final-demo-dry-run.md")
      : path.resolve(FINAL_DEMO_DRY_RUN_MD_PATH),
  };
  void materialsPath;

  if (!deps.skipSecretScan) {
    assertSecretScanPass({ rootDir: process.cwd() });
  }

  // 1. Generate authoritative materials (ephemeral keys, public package)
  const materials = generateFinalDemoAuthoritativeMaterials({
    ...(deps.templatePath ? { templatePath: deps.templatePath } : {}),
    ...(deps.runBaseTime ? { runBaseTime: deps.runBaseTime } : {}),
    auctionWindowSeconds: deps.auctionWindowSeconds ?? 90,
    materialsPath: paths.materials,
    persist: true,
  });

  // Independent reload (simulates restart before network writes)
  const materialsReloaded = loadFinalDemoAuthoritativeMaterials(paths.materials);
  const materialsClone = parseFinalDemoAuthoritativeMaterials(
    JSON.parse(JSON.stringify(materialsReloaded)),
  );

  let attempt = createFinalDemoAttempt({
    mode: FINAL_DEMO_MODE_DRY,
    attemptId: materials.attemptId,
    shortAttemptId: materials.shortAttemptId,
    runBaseTime: materials.runBaseTime,
    tenderId: materials.identifiers.tenderId,
    reservationId: materials.identifiers.reservationId,
    attemptPath: paths.attempt,
    materialsPath: paths.materials,
  });
  attempt = withFinalDemoAttemptUpdate(attempt, { status: "MATERIALS_PERSISTED" });
  persistFinalDemoAttempt(attempt, paths.attempt);

  // Mock clock starts at runBaseTime
  const baseMs = Date.parse(materials.runBaseTime);
  const network = new MockFinalDemoNetwork({ clockMs: baseMs + 1_000 });

  // 2. Topic create claim + create
  const claimId = `topic-claim-${randomUUID()}`;
  attempt = claimTopicCreate(attempt, claimId);
  persistFinalDemoAttempt(attempt, paths.attempt);

  const topicMemo = `routeguard-final:${materials.shortAttemptId}`;
  const topicResult = await network.createTopic(topicMemo);
  if (topicResult.topicId === HISTORICAL_PHASE5_TOPIC_ID) {
    throw new FinalDemoError(
      "Historical topic must never be used",
      "HISTORICAL_TOPIC_FORBIDDEN",
    );
  }
  attempt = finalizeTopicCreate(attempt, {
    topicId: topicResult.topicId,
    topicCreateTransactionId: topicResult.transactionId,
    topicMemo: topicResult.topicMemo,
    createdAt: topicResult.createdAt,
  });
  persistFinalDemoAttempt(attempt, paths.attempt);

  const topicId = topicResult.topicId;
  const runMeta = {
    topicId,
    runId: materials.runId,
    tenderId: materials.identifiers.tenderId,
  };

  // Helper: claim, submit, confirm one HCS message
  async function publishSequence(
    label:
      | "AUCTION_OPEN"
      | "BID_COMMITMENT_ALPHA"
      | "BID_COMMITMENT_BETA"
      | "AUCTION_CLOSE_BARRIER"
      | "ROUTE_RESERVED",
    envelope: Parameters<typeof serializeEnvelopeForSubmit>[0],
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

    assertMirrorReadyForSequence(
      network.listMessages(topicId),
      expectedSeq,
      runMeta,
    );

    if (label === "BID_COMMITMENT_ALPHA" || label === "BID_COMMITMENT_BETA") {
      assertCommitmentTimeRemaining(
        materials.auctionEndsAt,
        network.getClockMs(),
        FINAL_DEMO_COMMITMENT_SAFETY_MARGIN_MS,
      );
    }
    if (label === "AUCTION_CLOSE_BARRIER") {
      assertBarrierAfterAuctionEnd(
        materials.auctionEndsAt,
        network.getClockMs(),
      );
    }

    const hash = envelopeHash(envelope);
    const serialized = serializeEnvelopeForSubmit(envelope);
    const encodedByteCount = serialized.length;
    const submitAttemptId = `submit-${label}-${randomUUID()}`;

    attempt = claimMessageOutbox(attempt, label, {
      expectedTopic: topicId,
      envelope,
      envelopeHash: hash,
      encodedByteCount,
      submitAttemptId,
    });
    persistFinalDemoAttempt(attempt, paths.attempt);

    const submitted = await network.submitMessage({
      topicId,
      envelope,
      label,
    });

    if (submitted.sequence !== expectedSeq) {
      throw new FinalDemoError(
        `Expected sequence ${expectedSeq}, got ${submitted.sequence}`,
        "WRONG_SEQUENCE",
      );
    }
    if (submitted.envelopeHash !== hash) {
      throw new FinalDemoError(
        "Submitted envelope hash mismatch",
        "ENVELOPE_HASH_MISMATCH",
      );
    }

    // Mirror confirm (mock list)
    const mirrorMsgs = network.listMessages(topicId);
    const found = mirrorMsgs.find(
      (m) => m.sequence === expectedSeq && m.envelopeHash === hash,
    );
    if (!found) {
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
    persistFinalDemoAttempt(attempt, paths.attempt);

    return {
      sequence: found.sequence,
      envelopeHash: hash,
      transactionId: submitted.transactionId,
      consensusTimestamp: found.consensusTimestamp,
      byteCount: encodedByteCount,
    };
  }

  // Sequence 1–3
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

  // Advance clock past auctionEndsAt + safety margin
  const endsMs = Date.parse(materials.auctionEndsAt);
  const waitUntil = endsMs + FINAL_DEMO_BARRIER_SAFETY_MARGIN_MS;
  if (network.getClockMs() < waitUntil) {
    network.setClock(waitUntil + 1);
  }

  const barrierEnvelope = createCloseBarrierEnvelope({
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

  const seq4 = await publishSequence("AUCTION_CLOSE_BARRIER", barrierEnvelope);

  // Mirror reconciliation 1–4
  const mirrorWindow = network.listMessages(topicId).filter((m) => m.sequence <= 4);
  const reconciliation = reconcileFinalDemoSequences1to4(
    {
      topicId,
      runId: materials.runId,
      tenderId: materials.identifiers.tenderId,
      tenderVersion: materials.tenderBody.version,
      tenderHash: materials.tenderHash,
      auctionEndsAt: materials.auctionEndsAt,
      messages: mirrorWindow,
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
  persistFinalDemoAttempt(attempt, paths.attempt);

  // Double proof reconstruction
  const { first: reconstructed, finalHashes } = doubleReconstructFinalDemoProof({
    materialsA: materialsReloaded,
    materialsB: materialsClone,
    reconciliation,
  });

  attempt = withFinalDemoAttemptUpdate(attempt, {
    status: "PROOF_RECONSTRUCTED",
    finalHashes: {
      tenderHash: finalHashes.tenderHash,
      winningBidHash: finalHashes.winningBidHash,
      evaluatedBidSetHash: finalHashes.evaluatedBidSetHash,
      decisionManifestHash: finalHashes.decisionManifestHash,
    },
  });
  persistFinalDemoAttempt(attempt, paths.attempt);

  // Conservative envelope before payment
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

  // ReservationService path (USDC only) — mocked facilitator/hcs
  const store = new InMemoryReservationStore();
  const challengeAdapter = new LocalX402ChallengeAdapter();
  const facilitator = new LiveFacilitatorAdapter({
    facilitatorUrl: "https://api.testnet.blocky402.com",
    allowNetwork: false,
  });
  const webhooks = new LocalDemoWebhookTransport();
  const hcs = new LiveHcsPublisherAdapter({ allowNetwork: false });

  // Patch assertUsdcOnlySelection uses PHASE6B constants which match our accounts
  const service = new ReservationService({
    store,
    registry: reconstructed.registry,
    challenge: challengeAdapter,
    facilitator,
    mirror: {
      async getTransaction() {
        return {
          status: "NOT_FOUND",
          transactionId: "",
          consensusTimestamp: null,
          result: null,
          hbarTransfers: [],
          tokenTransfers: [],
        };
      },
    },
    webhooks,
    hcs,
    webhookSigningPrivateKey: DRY_RUN_WEBHOOK_KEY,
    now: () => deps.now?.() ?? network.nowIso(),
    confirmationTimeoutMs: 1000,
    mirrorPollIntervalMs: 100,
  });

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
      closeBarrierConsensusTimestamp: reconciliation.closeBarrierConsensusTimestamp,
      closureProof: reconstructed.proof,
      reservationOfferVersion: 1,
      createdAt: network.nowIso(),
      expiresAt: new Date(network.getClockMs() + 3_600_000).toISOString(),
    },
    reconstructed.tender,
  );

  await service.selectOption({
    reservationId: created.reservationId,
    optionId: "USDC",
    offerHash: created.offer.offerHash,
    offerVersion: created.offer.offerVersion,
    payerAccount: FINAL_DEMO_PAYER_ACCOUNT,
  });

  // HBAR must not become the selected path for final demo
  try {
    await service.selectOption({
      reservationId: created.reservationId,
      optionId: "HBAR",
      offerHash: created.offer.offerHash,
      offerVersion: created.offer.offerVersion,
      payerAccount: FINAL_DEMO_PAYER_ACCOUNT,
    });
    throw new FinalDemoError(
      "HBAR selection must remain locked after USDC",
      "USDC_ONLY",
    );
  } catch (e) {
    if (e instanceof FinalDemoError) throw e;
  }

  const { challenge, record: challenged } = await service.issueChallenge(
    created.reservationId,
    "USDC",
  );
  assertUsdcOnlySelection(challenged.selected!);

  if (challenged.selected!.payTo !== FINAL_DEMO_WINNER_ACCOUNT) {
    throw new FinalDemoError("Receiver mismatch", "WRONG_RECEIVER");
  }
  if (challenged.selected!.asset !== FINAL_DEMO_USDC_TOKEN) {
    throw new FinalDemoError("Token mismatch", "WRONG_TOKEN");
  }
  if (challenged.selected!.amountAtomic !== FINAL_DEMO_USDC_AMOUNT_ATOMIC) {
    throw new FinalDemoError("Amount mismatch", "WRONG_AMOUNT");
  }
  if (challenged.selected!.payerAccount !== FINAL_DEMO_PAYER_ACCOUNT) {
    throw new FinalDemoError("Payer mismatch", "WRONG_PAYER");
  }

  // Payment claim + mock settle (memory-only payload; no real x402)
  attempt = withFinalDemoAttemptUpdate(attempt, {
    status: "PAYMENT_SUBMISSION_CLAIMED",
    paymentSubmissionClaim: {
      claimedAt: network.nowIso(),
      status: "CLAIMED",
      transactionId: null,
    },
  });
  persistFinalDemoAttempt(attempt, paths.attempt);

  // Signed payment payload stays in memory only (mock object, never persisted)
  const memoryOnlyPaymentPayload = {
    x402Version: 2,
    mock: true,
    note: "in-memory-only-never-persisted",
  };
  void memoryOnlyPaymentPayload;

  const payment = await network.mockPaymentSettle();

  attempt = withFinalDemoAttemptUpdate(attempt, {
    status: "PAYMENT_CONFIRMED",
    paymentSubmissionClaim: {
      claimedAt: attempt.paymentSubmissionClaim.claimedAt,
      status: "CONFIRMED",
      transactionId: payment.transactionId,
    },
  });
  persistFinalDemoAttempt(attempt, paths.attempt);

  const reservedAt = payment.consensusTimestamp;
  const rr = createRouteReservedRecord({
    reservationId: materials.identifiers.reservationId,
    tenderId: reconstructed.tender.tenderId,
    tenderVersion: reconstructed.tender.version,
    tenderHash: reconstructed.tenderHash,
    winningBidId: reconstructed.winningBidId,
    winningBidHash: reconstructed.winningBidHash,
    carrierId: reconstructed.winningCarrierId,
    carrierAccount: reconstructed.winningCarrierAccount,
    selectedOptionId: "USDC",
    paymentAsset: FINAL_DEMO_USDC_TOKEN,
    paymentAmountAtomic: FINAL_DEMO_USDC_AMOUNT_ATOMIC,
    payerAccount: FINAL_DEMO_PAYER_ACCOUNT,
    transactionId: payment.transactionId,
    consensusTimestamp: payment.consensusTimestamp,
    decisionManifestHash: reconstructed.decisionManifestHash,
    evaluatedBidSetHash: reconstructed.evaluatedBidSetHash,
    hcsAuctionTopicId: topicId,
    closeBarrierSequence: 4,
    reservedAt,
  });

  const rrEnvelope = createRouteReservedHcsEnvelope({
    runId: `reservation-${materials.identifiers.reservationId}`,
    tenderId: reconstructed.tender.tenderId,
    tenderVersion: reconstructed.tender.version,
    tenderHash: reconstructed.tenderHash,
    createdAt: network.nowIso(),
    payload: buildRouteReservedPayload(rr, reconstructed.winningCarrierId),
  });
  const dryRunEnvelopeByteCount = measureRouteReservedEnvelope(rrEnvelope);
  if (dryRunEnvelopeByteCount > HCS_MAX_MESSAGE_BYTES) {
    throw new FinalDemoError(
      `ROUTE_RESERVED ${dryRunEnvelopeByteCount} exceeds limit`,
      "HCS_MESSAGE_TOO_LARGE",
    );
  }

  // Bind reservation to NEW topic + barrier sequence 4
  if (rr.hcsAuctionTopicId !== topicId || rr.hcsAuctionTopicId === HISTORICAL_PHASE5_TOPIC_ID) {
    throw new FinalDemoError(
      "ROUTE_RESERVED must bind new final-demo topic",
      "WRONG_TOPIC",
    );
  }
  if (rr.closeBarrierSequence !== 4) {
    throw new FinalDemoError("Barrier sequence must be 4", "BARRIER_MISMATCH");
  }

  const seq5 = await publishSequence("ROUTE_RESERVED", rrEnvelope);

  attempt = withFinalDemoAttemptUpdate(attempt, {
    status: "DRY_RUN_COMPLETE",
    routeReservedRecordHash: rr.reservationRecordHash,
    reservationServiceRecordPath: `memory:${materials.identifiers.reservationId}`,
    evidencePaths: {
      ...attempt.evidencePaths,
      resultJson: paths.json,
      resultMd: paths.md,
    },
  });
  // For dry-run evidence, also mark COMPLETED semantically in result
  persistFinalDemoAttempt(attempt, paths.attempt);

  const sequences = [
    { ...seq1, label: "AUCTION_OPEN" },
    { ...seq2, label: "BID_COMMITMENT_ALPHA" },
    { ...seq3, label: "BID_COMMITMENT_BETA" },
    { ...seq4, label: "AUCTION_CLOSE_BARRIER" },
    { ...seq5, label: "ROUTE_RESERVED" },
  ].map((s) => ({
    sequence: s.sequence,
    label: s.label,
    envelopeHash: s.envelopeHash,
    transactionId: s.transactionId,
    consensusTimestamp: s.consensusTimestamp,
  }));

  const result: FinalDemoDryRunResult = {
    mode: "OFFLINE_DRY_RUN",
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
      topicCreateTransactionId: topicResult.transactionId,
      topicMemo,
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
      transactionId: payment.transactionId,
      consensusTimestamp: payment.consensusTimestamp,
      tokenTransfers: payment.tokenTransfers,
    },
    reservationRecordHash: rr.reservationRecordHash,
    routeReserved: {
      sequence: 5,
      envelopeHash: seq5.envelopeHash,
      byteCount: dryRunEnvelopeByteCount,
      transactionId: seq5.transactionId,
      consensusTimestamp: seq5.consensusTimestamp,
    },
    conservativeEnvelopeByteCount: conservative.byteCount,
    dryRunEnvelopeByteCount,
    envelopeWithinLimit:
      dryRunEnvelopeByteCount <= HCS_MAX_MESSAGE_BYTES &&
      conservative.byteCount <= HCS_MAX_MESSAGE_BYTES,
    networkWrites: {
      topicCreates: network.createCount,
      hcsSubmits: network.submitCount,
      payments: network.paymentSubmitCount,
      realNetwork: false,
    },
    evidencePaths: paths,
    finalState: "COMPLETED",
  };

  assertNoPrivateKeyFields(result, "final-demo-dry-run-result");
  atomicWriteJson(paths.json, result);
  atomicWriteText(paths.md, formatDryRunMarkdown(result));

  // challenge used for binding check only
  void challenge;

  return result;
}

function formatDryRunMarkdown(r: FinalDemoDryRunResult): string {
  return `# Final Demo Dry-Run Evidence

## Disclosure

${r.disclosure}

## Historical topic

${r.historicalTopicDisclosure}

**This dry-run used synthetic topic \`${r.topic.topicId}\` — not ${HISTORICAL_PHASE5_TOPIC_ID}.**

## Attempt

- Mode: \`${r.mode}\`
- Attempt ID: \`${r.materials.attemptId}\`
- Short ID: \`${r.materials.shortAttemptId}\`
- Final state: \`${r.finalState}\`

## Auction materials

- Tender: \`${r.materials.tenderId}\`
- Bid alpha: \`${r.materials.bidAlphaId}\`
- Bid beta: \`${r.materials.bidBetaId}\`
- Reservation: \`${r.materials.reservationId}\`
- Tender hash: \`${r.materials.tenderHash}\`
- Auction ends: \`${r.auctionEndsAt}\`

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

## Payment (simulated)

- Selected rail: \`${r.payment.selectedOptionId}\`
- Carrier reservation payment: \`${r.payment.amount}\` atomic of token \`${r.payment.token}\`
- Carrier-received amount: \`${r.payment.carrierReceivedAmountAtomic}\` (network cost not deducted)
- Challenge-stated fixed Hedera network transfer cost: \`$${r.payment.challengeStatedHederaNetworkTransferCostUsd}\` USD
- Facilitator fee: \`${r.payment.economics.facilitatorFee.status}\`
- RouteGuard platform fee: \`${r.payment.economics.routeGuardPlatformFee.status}\`
- Payer \`${r.payment.payer}\` → receiver \`${r.payment.receiver}\`
- Tx: \`${r.payment.transactionId}\`

### Payment economics lines

${formatPaymentEconomicsLines(r.payment.economics)
  .map((line) => `- ${line}`)
  .join("\n")}

## ROUTE_RESERVED

- Sequence: 5
- Byte count: ${r.routeReserved.byteCount} (limit ${HCS_MAX_MESSAGE_BYTES})
- Conservative budget: ${r.conservativeEnvelopeByteCount}
- Record hash: \`${r.reservationRecordHash}\`

## Network writes

Real network writes: **none** (mocked transports only).
Simulated: ${r.networkWrites.topicCreates} topic create, ${r.networkWrites.hcsSubmits} HCS submits, ${r.networkWrites.payments} payment.
`;
}

/** Expose materials type for tests. */
export type { FinalDemoAuthoritativeMaterials };
