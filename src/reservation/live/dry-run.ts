/**
 * Phase 6B offline dry-run — zero network writes.
 * Uses synthetic topic preflight only when mode is OFFLINE_DRY_RUN.
 */

import { randomUUID } from "node:crypto";

import { HCS_MAX_MESSAGE_BYTES } from "../../hcs/types";
import { InMemoryReservationStore } from "../attempt-store";
import {
  buildRouteReservedPayload,
  createRouteReservedHcsEnvelope,
  measureRouteReservedEnvelope,
} from "../hcs-evidence";
import { ReservationService } from "../reservation-service";
import { createRouteReservedRecord } from "../route-reserved-record";
import {
  createPlannedPhase6bAttempt,
  loadPhase6bAttempt,
  persistPhase6bAttempt,
  Phase6bAttemptError,
  type Phase6bAttemptRecord,
  withAttemptUpdate,
} from "./attempt-store";
import {
  LocalDemoWebhookTransport,
  LocalX402ChallengeAdapter,
  LiveFacilitatorAdapter,
  LiveHcsPublisherAdapter,
  assertUsdcOnlySelection,
} from "./adapters";
import {
  AUTHORITATIVE_HASHES,
  PHASE6B_CARRIER_ACCOUNT,
  PHASE6B_CLOSE_BARRIER_SEQUENCE,
  PHASE6B_DRY_RUN_ATTEMPT_PATH,
  PHASE6B_HCS_TOPIC,
  PHASE6B_PAYER_ACCOUNT,
  PHASE6B_RESERVATION_ID,
  PHASE6B_USDC_AMOUNT_ATOMIC,
  PHASE6B_USDC_TOKEN,
} from "./constants";
import {
  reconstructPhase5WinnerProof,
  type ReconstructedPhase5Winner,
} from "./proof-reconstruction";
import {
  measureConservativeRouteReservedEnvelope,
} from "./envelope-budget";

const DRY_RUN_WEBHOOK_KEY =
  "7a8b9c0d1e2f30415263748596a7b8c9d0e1f2031425364758697a8b9c0d1e2f";

export type TopicPreflightResult = {
  topicId: string;
  messageCount: number;
  maxSequence: number;
  hasOpen: boolean;
  hasBarrierAt4: boolean;
  sequences1to4Valid: boolean;
  hasRouteReservedForReservation: boolean;
  nextSequence: number;
  source: "OFFLINE_SYNTHETIC" | "MIRROR_LIVE";
};

export type Phase6bDryRunResult = {
  mode: "OFFLINE_DRY_RUN";
  attempt: Phase6bAttemptRecord;
  reconstructed: {
    tenderId: string;
    winningBidId: string;
    winningCarrierAccount: string;
    tenderHash: string;
    winningBidHash: string;
    evaluatedBidSetHash: string;
    decisionManifestHash: string;
    hcsTopicId: string;
    closeBarrierSequence: number;
  };
  reservationId: string;
  selectedOptionId: "USDC";
  challenge: {
    x402Version: number;
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    resource: string;
    maxTimeoutSeconds: number;
    challengeHash: string;
  };
  binding: {
    payer: string;
    receiver: string;
    token: string;
    amount: string;
    topic: string;
  };
  conservativeEnvelopeByteCount: number;
  dryRunEnvelopeByteCount: number;
  envelopeWithinLimit: boolean;
  hcsMaxBytes: number;
  topicPreflight: TopicPreflightResult;
  networkWrites: {
    facilitatorVerify: number;
    facilitatorSettle: number;
    hcsPublish: number;
    externalWebhook: number;
  };
  finalReservationState: string;
};

export type DryRunDeps = {
  env?: NodeJS.ProcessEnv;
  attemptPath?: string;
  topicPreflight?: TopicPreflightResult;
  now?: () => string;
  webhookSigningPrivateKey?: string;
  authoritativeSourcePath?: string;
};

export async function runPhase6bDryRun(
  deps: DryRunDeps = {},
): Promise<Phase6bDryRunResult> {
  const attemptPath = deps.attemptPath ?? PHASE6B_DRY_RUN_ATTEMPT_PATH;

  // Dry-run attempts never block live (separate file). May overwrite dry-run.
  const reconstructed = reconstructPhase5WinnerProof(
    deps.authoritativeSourcePath
      ? { sourcePath: deps.authoritativeSourcePath }
      : undefined,
  );

  // Exact authoritative hash gate (no public-ID-only).
  assertAuthoritativeHashes(reconstructed);

  const topicPreflight =
    deps.topicPreflight ?? syntheticOfflineTopicPreflight();
  if (topicPreflight.source !== "OFFLINE_SYNTHETIC") {
    throw new Phase6bAttemptError(
      "Dry-run must not use live Mirror topic data unless explicitly tested",
      "DRY_RUN_TOPIC_SOURCE",
    );
  }
  assertTopicPreflight(topicPreflight, PHASE6B_RESERVATION_ID);

  const attempt = createPlannedPhase6bAttempt({
    kind: "DRY_RUN",
    attemptId: `phase6b-dry-${randomUUID()}`,
    reservationId: PHASE6B_RESERVATION_ID,
    expectedPreRunTopicSequence: topicPreflight.maxSequence,
    attemptPath,
  });
  persistPhase6bAttempt(attempt, attemptPath);

  const store = new InMemoryReservationStore();
  const challengeAdapter = new LocalX402ChallengeAdapter();
  const facilitator = new LiveFacilitatorAdapter({
    facilitatorUrl: "https://api.testnet.blocky402.com",
    allowNetwork: false,
  });
  const webhooks = new LocalDemoWebhookTransport();
  const hcs = new LiveHcsPublisherAdapter({ allowNetwork: false });

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
    webhookSigningPrivateKey:
      deps.webhookSigningPrivateKey ?? DRY_RUN_WEBHOOK_KEY,
    now: () => deps.now?.() ?? "2026-07-15T19:01:00.000Z",
    confirmationTimeoutMs: 1000,
    mirrorPollIntervalMs: 100,
  });

  const created = await service.createReservation(
    {
      reservationId: PHASE6B_RESERVATION_ID,
      tenderId: reconstructed.tender.tenderId,
      tenderVersion: reconstructed.tender.version,
      tenderHash: reconstructed.tenderHash,
      winningBidId: reconstructed.winningBidId,
      winningBidHash: reconstructed.winningBidHash,
      winningCarrierId: reconstructed.winningCarrierId,
      winningCarrierAccount: reconstructed.winningCarrierAccount,
      decisionManifestHash: reconstructed.proof.manifest.decisionManifestHash,
      evaluatedBidSetHash: reconstructed.proof.manifest.evaluatedBidSetHash,
      hcsTopicId: PHASE6B_HCS_TOPIC,
      closeBarrierSequence: PHASE6B_CLOSE_BARRIER_SEQUENCE,
      closeBarrierConsensusTimestamp: reconstructed.evaluationTimestamp,
      closureProof: reconstructed.proof,
      reservationOfferVersion: 1,
      createdAt: "2026-07-15T19:00:00.000Z",
      expiresAt: "2026-07-15T20:00:00.000Z",
    },
    reconstructed.tender,
  );

  await service.selectOption({
    reservationId: created.reservationId,
    optionId: "USDC",
    offerHash: created.offer.offerHash,
    offerVersion: created.offer.offerVersion,
    payerAccount: PHASE6B_PAYER_ACCOUNT,
  });

  try {
    await service.selectOption({
      reservationId: created.reservationId,
      optionId: "HBAR",
      offerHash: created.offer.offerHash,
      offerVersion: created.offer.offerVersion,
      payerAccount: PHASE6B_PAYER_ACCOUNT,
    });
    throw new Phase6bAttemptError(
      "HBAR selection must remain locked after USDC",
      "USDC_ONLY",
    );
  } catch (e) {
    if (e instanceof Phase6bAttemptError) throw e;
  }

  const { challenge, record: challenged } = await service.issueChallenge(
    created.reservationId,
    "USDC",
  );
  assertUsdcOnlySelection(challenged.selected!);

  const conservative = measureConservativeRouteReservedEnvelope({
    reservationId: PHASE6B_RESERVATION_ID,
    tenderId: reconstructed.tender.tenderId,
    tenderVersion: reconstructed.tender.version,
    tenderHash: reconstructed.tenderHash,
    winningBidId: reconstructed.winningBidId,
    winningBidHash: reconstructed.winningBidHash,
    carrierId: reconstructed.winningCarrierId,
    carrierAccount: reconstructed.winningCarrierAccount,
    decisionManifestHash: reconstructed.proof.manifest.decisionManifestHash,
    evaluatedBidSetHash: reconstructed.proof.manifest.evaluatedBidSetHash,
  });
  if (conservative.byteCount >= HCS_MAX_MESSAGE_BYTES) {
    throw new Phase6bAttemptError(
      `Conservative envelope ${conservative.byteCount} exceeds ${HCS_MAX_MESSAGE_BYTES}`,
      "HCS_MESSAGE_TOO_LARGE",
    );
  }

  // Placeholder post-payment-shaped envelope for dry-run size check
  const placeholderTx = "0.0.9197513@1784142000.100000000";
  const placeholderTs = "2026-07-15T19:05:00.123456789Z";
  const rr = createRouteReservedRecord({
    reservationId: PHASE6B_RESERVATION_ID,
    tenderId: reconstructed.tender.tenderId,
    tenderVersion: reconstructed.tender.version,
    tenderHash: reconstructed.tenderHash,
    winningBidId: reconstructed.winningBidId,
    winningBidHash: reconstructed.winningBidHash,
    carrierId: reconstructed.winningCarrierId,
    carrierAccount: reconstructed.winningCarrierAccount,
    selectedOptionId: "USDC",
    paymentAsset: PHASE6B_USDC_TOKEN,
    paymentAmountAtomic: PHASE6B_USDC_AMOUNT_ATOMIC,
    payerAccount: PHASE6B_PAYER_ACCOUNT,
    transactionId: placeholderTx,
    consensusTimestamp: placeholderTs,
    decisionManifestHash: reconstructed.proof.manifest.decisionManifestHash,
    evaluatedBidSetHash: reconstructed.proof.manifest.evaluatedBidSetHash,
    hcsAuctionTopicId: PHASE6B_HCS_TOPIC,
    closeBarrierSequence: PHASE6B_CLOSE_BARRIER_SEQUENCE,
    reservedAt: placeholderTs,
  });
  const envelope = createRouteReservedHcsEnvelope({
    runId: `reservation-${PHASE6B_RESERVATION_ID}`,
    tenderId: reconstructed.tender.tenderId,
    tenderVersion: reconstructed.tender.version,
    tenderHash: reconstructed.tenderHash,
    createdAt: "2026-07-15T19:06:01.000000000Z",
    payload: buildRouteReservedPayload(rr, reconstructed.winningCarrierId),
  });
  const dryRunEnvelopeByteCount = measureRouteReservedEnvelope(envelope);

  const done = withAttemptUpdate(attempt, { status: "DRY_RUN_COMPLETE" });
  persistPhase6bAttempt(done, attemptPath);

  return {
    mode: "OFFLINE_DRY_RUN",
    attempt: done,
    reconstructed: {
      tenderId: reconstructed.tender.tenderId,
      winningBidId: reconstructed.winningBidId,
      winningCarrierAccount: reconstructed.winningCarrierAccount,
      tenderHash: reconstructed.tenderHash,
      winningBidHash: reconstructed.winningBidHash,
      evaluatedBidSetHash: reconstructed.proof.manifest.evaluatedBidSetHash,
      decisionManifestHash: reconstructed.proof.manifest.decisionManifestHash,
      hcsTopicId: reconstructed.hcsTopicId,
      closeBarrierSequence: reconstructed.closeBarrierSequence,
    },
    reservationId: challenged.reservationId,
    selectedOptionId: "USDC",
    challenge: {
      x402Version: challenge.x402Version,
      scheme: challenge.scheme,
      network: challenge.network,
      asset: challenge.asset,
      amount: challenge.amount,
      payTo: challenge.payTo,
      resource: challenge.resource,
      maxTimeoutSeconds: challenge.maxTimeoutSeconds,
      challengeHash: challenge.challengeHash,
    },
    binding: {
      payer: PHASE6B_PAYER_ACCOUNT,
      receiver: PHASE6B_CARRIER_ACCOUNT,
      token: PHASE6B_USDC_TOKEN,
      amount: PHASE6B_USDC_AMOUNT_ATOMIC,
      topic: PHASE6B_HCS_TOPIC,
    },
    conservativeEnvelopeByteCount: conservative.byteCount,
    dryRunEnvelopeByteCount,
    envelopeWithinLimit:
      dryRunEnvelopeByteCount <= HCS_MAX_MESSAGE_BYTES &&
      conservative.byteCount <= HCS_MAX_MESSAGE_BYTES,
    hcsMaxBytes: HCS_MAX_MESSAGE_BYTES,
    topicPreflight,
    networkWrites: {
      facilitatorVerify: facilitator.verifyCallCount,
      facilitatorSettle: facilitator.settleCallCount,
      hcsPublish: hcs.publishCallCount,
      externalWebhook: 0,
    },
    finalReservationState: challenged.state,
  };
}

export function assertAuthoritativeHashes(
  reconstructed: ReconstructedPhase5Winner,
): void {
  if (
    reconstructed.proof.manifest.evaluatedBidSetHash !==
    AUTHORITATIVE_HASHES.evaluatedBidSetHash
  ) {
    throw new Phase6bAttemptError(
      "evaluatedBidSetHash does not match AUTHORITATIVE_HASHES",
      "HASH_MISMATCH",
    );
  }
  if (
    reconstructed.proof.manifest.decisionManifestHash !==
    AUTHORITATIVE_HASHES.decisionManifestHash
  ) {
    throw new Phase6bAttemptError(
      "decisionManifestHash does not match AUTHORITATIVE_HASHES",
      "HASH_MISMATCH",
    );
  }
}

export function syntheticOfflineTopicPreflight(): TopicPreflightResult {
  return {
    topicId: PHASE6B_HCS_TOPIC,
    messageCount: 4,
    maxSequence: 4,
    hasOpen: true,
    hasBarrierAt4: true,
    sequences1to4Valid: true,
    hasRouteReservedForReservation: false,
    nextSequence: 5,
    source: "OFFLINE_SYNTHETIC",
  };
}

export function assertTopicPreflight(
  preflight: TopicPreflightResult,
  reservationId: string,
  options?: { requireLiveMirror?: boolean },
): void {
  if (options?.requireLiveMirror && preflight.source !== "MIRROR_LIVE") {
    throw new Phase6bAttemptError(
      "Live topic preflight must use Mirror (not synthetic data)",
      "LIVE_TOPIC_PREFLIGHT_REQUIRED",
    );
  }
  if (preflight.topicId !== PHASE6B_HCS_TOPIC) {
    throw new Phase6bAttemptError("Wrong HCS topic", "WRONG_TOPIC");
  }
  if (!preflight.hasOpen) {
    throw new Phase6bAttemptError(
      "Auction OPEN missing",
      "TOPIC_SEQUENCE_UNEXPECTED",
    );
  }
  if (!preflight.hasBarrierAt4 || !preflight.sequences1to4Valid) {
    throw new Phase6bAttemptError(
      "Sequences 1–4 invalid or barrier not at 4",
      "TOPIC_SEQUENCE_UNEXPECTED",
    );
  }
  if (preflight.hasRouteReservedForReservation) {
    throw new Phase6bAttemptError(
      `ROUTE_RESERVED already exists for ${reservationId}`,
      "ROUTE_RESERVED_ALREADY_EXISTS",
    );
  }
  if (preflight.maxSequence !== PHASE6B_CLOSE_BARRIER_SEQUENCE) {
    throw new Phase6bAttemptError(
      `Highest sequence must be exactly 4 before first execution, got ${preflight.maxSequence}`,
      "TOPIC_SEQUENCE_UNEXPECTED",
    );
  }
  if (preflight.nextSequence !== 5) {
    throw new Phase6bAttemptError(
      `Expected next sequence 5, got ${preflight.nextSequence}`,
      "TOPIC_SEQUENCE_UNEXPECTED",
    );
  }
}
