/**
 * Guarded Phase 6B live execution path.
 *
 * Fully implemented for auditability; default script entry refuses to call
 * this without all live flags. Tests exercise it with mocked transports only.
 *
 * Settlement authority is ALWAYS ReservationService — never direct settle.
 */

import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

import { canonicalSha256 } from "../../domain/canonical-hash";
import { HCS_MAX_MESSAGE_BYTES } from "../../hcs/types";
import {
  FileSystemReservationStore,
  InMemoryReservationStore,
  type ReservationStore,
} from "../attempt-store";
import { ReservationService } from "../reservation-service";
import type {
  FacilitatorTransport,
  HcsPublisherTransport,
  MirrorConfirmationTransport,
  WebhookDeliveryTransport,
  X402ChallengeTransport,
} from "../transports";
import type { ReservationRecord } from "../types";
import {
  assertHcsNotYetClaimed,
  assertPaymentNotYetSubmitted,
  assertSafeToStartPhase6bLive,
  createPlannedPhase6bAttempt,
  loadPhase6bAttempt,
  persistPhase6bAttempt,
  Phase6bAttemptError,
  withAttemptUpdate,
  type Phase6bAttemptRecord,
} from "./attempt-store";
import {
  LocalDemoWebhookTransport,
  LocalX402ChallengeAdapter,
  LiveFacilitatorAdapter,
  LiveHcsPublisherAdapter,
  LiveMirrorTransactionAdapter,
  assertUsdcOnlySelection,
  createSdkHcsSubmitViaSdk,
} from "./adapters";
import {
  AUTHORITATIVE_HASHES,
  PHASE6B_CARRIER_ACCOUNT,
  PHASE6B_CLOSE_BARRIER_SEQUENCE,
  PHASE6B_HCS_TOPIC,
  PHASE6B_LIVE_ATTEMPT_ID,
  PHASE6B_LIVE_ATTEMPT_PATH,
  PHASE6B_LIVE_EVIDENCE_JSON,
  PHASE6B_LIVE_EVIDENCE_MD,
  PHASE6B_PAYER_ACCOUNT,
  PHASE6B_RESERVATION_ID,
  PHASE6B_USDC_AMOUNT_ATOMIC,
  PHASE6B_USDC_TOKEN,
} from "./constants";
import { assertAuthoritativeHashes, assertTopicPreflight } from "./dry-run";
import {
  measureActualRouteReservedEnvelope,
  measureConservativeRouteReservedEnvelope,
} from "./envelope-budget";
import { assertPhase6bLiveExecutionAuthorized } from "./guards";
import { reconstructPhase5WinnerProof } from "./proof-reconstruction";
import { readTopicPreflight } from "./topic-preflight";
import type { TopicPreflightResult } from "./dry-run";

export type PayerPaymentPayloadFactory = (input: {
  selected: NonNullable<ReservationRecord["selected"]>;
  challenge: {
    x402Version: number;
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    resource: string;
    maxTimeoutSeconds: number;
    description: string;
  };
}) => Promise<{
  paymentPayload: PaymentPayload;
  requirement: PaymentRequirements;
  paymentPayloadHash: string;
}>;

/** Facilitator that can hold an in-memory signed payload session. */
export type SessionFacilitator = FacilitatorTransport & {
  bindPaymentSession(input: {
    paymentPayload: PaymentPayload;
    requirement: PaymentRequirements;
    paymentPayloadHash: string;
    challengeHash: string;
  }): void;
  clearPaymentSession(): void;
};

export type LiveExecutionDeps = {
  env?: NodeJS.ProcessEnv;
  attemptPath?: string;
  reservationStoreDir?: string;
  /** Inject store (tests). Default: FileSystemReservationStore. */
  store?: ReservationStore;
  webhookSigningPrivateKey: string;
  facilitatorUrl?: string;
  /** Required: creates signed payload in memory only. */
  createPaymentPayload: PayerPaymentPayloadFactory;
  /** When set, used instead of real Mirror topic preflight (tests only). */
  topicPreflightOverride?: TopicPreflightResult;
  /**
   * When set, used instead of real SDK HCS submit (tests).
   * Required for offline live-path tests.
   */
  hcsSubmitViaSdk?: (input: {
    topicId: string;
    envelope: import("../../hcs/types").HcsEnvelope;
    exactBytes: Uint8Array;
  }) => Promise<{
    topicId: string;
    sequence: number;
    transactionId: string;
    consensusTimestamp: string;
  }>;
  /** Inject facilitator (tests). Must support session bind for real adapter. */
  facilitator?: SessionFacilitator;
  /** Inject mirror (tests). */
  mirror?: MirrorConfirmationTransport;
  /** Inject HCS publisher (tests). */
  hcs?: HcsPublisherTransport;
  /** Inject challenge transport (tests). */
  challenge?: X402ChallengeTransport;
  /** Inject webhooks (tests). */
  webhooks?: WebhookDeliveryTransport;
  /** Skip env live-flag check (tests that inject mocks). */
  skipEnvLiveGuard?: boolean;
  /**
   * When true, topic preflight may be synthetic override without Mirror source
   * (tests only). Live production always requires MIRROR_LIVE.
   */
  allowSyntheticTopicPreflight?: boolean;
  now?: () => string;
  authoritativeSourcePath?: string;
};

export type LiveExecutionResult = {
  mode: "LIVE";
  attempt: Phase6bAttemptRecord;
  reservation: ReservationRecord;
  conservativeEnvelopeByteCount: number;
  actualEnvelopeByteCount: number | null;
  /** Exposed for tests: settle went through ReservationService. */
  serviceSettleAuthority: "ReservationService";
};

/**
 * Guarded live execution. Must only be invoked when all flags are set
 * (or under test with skipEnvLiveGuard + mocks).
 */
export async function runPhase6bLiveExecution(
  deps: LiveExecutionDeps,
): Promise<LiveExecutionResult> {
  const env = deps.env ?? process.env;
  if (!deps.skipEnvLiveGuard) {
    assertPhase6bLiveExecutionAuthorized({
      enableLiveReservation: env.ENABLE_LIVE_RESERVATION,
      enableLiveHedera: env.ENABLE_LIVE_HEDERA,
      enableLiveUsdcPayments: env.ENABLE_LIVE_USDC_PAYMENTS,
      enableLiveHcsWrites: env.ENABLE_LIVE_HCS_WRITES,
      confirmPhase6bReservation: env.CONFIRM_PHASE6B_RESERVATION,
    });
  }

  const attemptPath = deps.attemptPath ?? PHASE6B_LIVE_ATTEMPT_PATH;
  const existing = loadPhase6bAttempt(attemptPath);
  assertSafeToStartPhase6bLive(existing);

  // 2. Reconstruct exact authentic auction proof
  const reconstructed = reconstructPhase5WinnerProof(
    deps.authoritativeSourcePath
      ? { sourcePath: deps.authoritativeSourcePath }
      : undefined,
  );
  assertAuthoritativeHashes(reconstructed);

  // Exact binding checks
  if (reconstructed.winningCarrierAccount !== PHASE6B_CARRIER_ACCOUNT) {
    throw new Phase6bAttemptError("Receiver mismatch", "WRONG_RECEIVER");
  }
  if (
    reconstructed.proof.manifest.evaluatedBidSetHash !==
      AUTHORITATIVE_HASHES.evaluatedBidSetHash ||
    reconstructed.proof.manifest.decisionManifestHash !==
      AUTHORITATIVE_HASHES.decisionManifestHash
  ) {
    throw new Phase6bAttemptError(
      "Authoritative hash mismatch after reconstruction",
      "HASH_MISMATCH",
    );
  }

  // 6. Live Mirror topic preflight (never synthetic in production live path)
  const topicPreflight =
    deps.topicPreflightOverride ??
    (await readTopicPreflight({
      reservationId: PHASE6B_RESERVATION_ID,
    }));
  // Production live path requires Mirror-sourced preflight.
  // Offline tests may pass allowSyntheticTopicPreflight with an override.
  assertTopicPreflight(topicPreflight, PHASE6B_RESERVATION_ID, {
    requireLiveMirror: !deps.allowSyntheticTopicPreflight,
  });

  // Conservative envelope before payment
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
  if (conservative.byteCount > HCS_MAX_MESSAGE_BYTES) {
    throw new Phase6bAttemptError(
      `Conservative envelope ${conservative.byteCount} exceeds limit — abort before payment`,
      "HCS_MESSAGE_TOO_LARGE",
    );
  }

  // 1. Durable live attempt before any side effect
  let attempt =
    existing ??
    createPlannedPhase6bAttempt({
      kind: "LIVE",
      attemptId: PHASE6B_LIVE_ATTEMPT_ID,
      reservationId: PHASE6B_RESERVATION_ID,
      expectedPreRunTopicSequence: topicPreflight.maxSequence,
      attemptPath,
    });
  persistPhase6bAttempt(attempt, attemptPath);

  const store: ReservationStore =
    deps.store ??
    (deps.reservationStoreDir
      ? new FileSystemReservationStore(deps.reservationStoreDir)
      : new FileSystemReservationStore("data/phase6b-reservations"));

  const challengeAdapter = deps.challenge ?? new LocalX402ChallengeAdapter();

  const facilitator: SessionFacilitator =
    deps.facilitator ??
    new LiveFacilitatorAdapter({
      facilitatorUrl:
        deps.facilitatorUrl ?? "https://api.testnet.blocky402.com",
      allowNetwork: true,
    });

  const mirror: MirrorConfirmationTransport =
    deps.mirror ?? new LiveMirrorTransactionAdapter();
  const webhooks = deps.webhooks ?? new LocalDemoWebhookTransport();

  let hcs: HcsPublisherTransport;
  if (deps.hcs) {
    hcs = deps.hcs;
  } else {
    let hcsSubmit = deps.hcsSubmitViaSdk;
    if (!hcsSubmit) {
      const opAccount = env.SHIPPER_ACCOUNT_ID?.trim();
      const opKey = env.SHIPPER_PRIVATE_KEY?.trim();
      if (!opAccount || !opKey) {
        throw new Phase6bAttemptError(
          "SHIPPER_ACCOUNT_ID and SHIPPER_PRIVATE_KEY required for live HCS",
          "OPERATOR_REQUIRED",
        );
      }
      if (opAccount !== PHASE6B_PAYER_ACCOUNT) {
        throw new Phase6bAttemptError(
          "Live operator must be payer account 0.0.9197513",
          "WRONG_PAYER",
        );
      }
      hcsSubmit = await createSdkHcsSubmitViaSdk({
        operatorAccountId: opAccount,
        operatorPrivateKey: opKey,
        expectedTopicId: PHASE6B_HCS_TOPIC,
      });
    }
    hcs = new LiveHcsPublisherAdapter({
      allowNetwork: true,
      expectedTopicId: PHASE6B_HCS_TOPIC,
      submitViaSdk: hcsSubmit,
    });
  }

  const service = new ReservationService({
    store,
    registry: reconstructed.registry,
    challenge: challengeAdapter,
    facilitator,
    mirror,
    webhooks,
    hcs,
    webhookSigningPrivateKey: deps.webhookSigningPrivateKey,
    now: () => deps.now?.() ?? new Date().toISOString(),
    confirmationTimeoutMs: deps.store ? 5_000 : 60_000,
    mirrorPollIntervalMs: deps.store ? 10 : 2_000,
  });

  // 3–5. create / select USDC / challenge
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
      createdAt: deps.now?.() ?? new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
    reconstructed.tender,
  );

  const afterSelect = await service.selectOption({
    reservationId: created.reservationId,
    optionId: "USDC",
    offerHash: created.offer.offerHash,
    offerVersion: created.offer.offerVersion,
    payerAccount: PHASE6B_PAYER_ACCOUNT,
  });
  assertUsdcOnlySelection(afterSelect.selected!);

  const { challenge, record: challenged } = await service.issueChallenge(
    created.reservationId,
    "USDC",
  );

  // Outer attempt: payment submission claimed before payload generation
  assertPaymentNotYetSubmitted(attempt);
  attempt = withAttemptUpdate(attempt, {
    status: "PAYMENT_SUBMISSION_CLAIMED",
    paymentSubmissionClaimedAt: new Date().toISOString(),
  });
  persistPhase6bAttempt(attempt, attemptPath);

  // 6–7. Payer-side payload in memory; only hash enters ReservationService
  const { paymentPayload, requirement, paymentPayloadHash } =
    await deps.createPaymentPayload({
      selected: challenged.selected!,
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
  const recomputedHash = canonicalSha256(paymentPayload);
  if (recomputedHash !== paymentPayloadHash) {
    throw new Phase6bAttemptError(
      "paymentPayloadHash mismatch vs in-memory payload",
      "PAYLOAD_HASH_MISMATCH",
    );
  }

  facilitator.bindPaymentSession({
    paymentPayload,
    requirement,
    paymentPayloadHash,
    challengeHash: challenge.challengeHash,
  });

  // 8–16. ReservationService orchestration (verify → claim → settle → mirror → RR → webhooks → HCS)
  // NEVER call facilitator.settle directly from this script.
  let final: ReservationRecord;
  try {
    final = await service.submitPayment({
      reservationId: PHASE6B_RESERVATION_ID,
      optionId: "USDC",
      paymentPayloadHash,
    });
  } catch (e) {
    attempt = withAttemptUpdate(attempt, {
      status: "AMBIGUOUS",
      failureCode: "LIVE_SUBMIT_FAILED",
      failureReason: e instanceof Error ? e.message : String(e),
    });
    persistPhase6bAttempt(attempt, attemptPath);
    facilitator.clearPaymentSession();
    throw e;
  }

  facilitator.clearPaymentSession();

  if (final.transactionId) {
    attempt = withAttemptUpdate(attempt, {
      status: "PAYMENT_SUBMITTED",
      paymentSubmittedAt: new Date().toISOString(),
      transactionId: final.transactionId,
      paymentConsensusTimestamp:
        final.routeReserved?.consensusTimestamp ??
        final.mirrorConfirmation?.consensusTimestamp ??
        null,
    });
    persistPhase6bAttempt(attempt, attemptPath);
  }

  if (final.routeReserved) {
    const actual = measureActualRouteReservedEnvelope({
      reservationId: final.reservationId,
      tenderId: final.tenderId,
      tenderVersion: final.tenderVersion,
      tenderHash: final.tenderHash,
      winningBidId: final.winningBidId,
      winningBidHash: final.winningBidHash,
      carrierId: final.winningCarrierId,
      carrierAccount: final.winningCarrierAccount,
      decisionManifestHash: final.decisionManifestHash,
      evaluatedBidSetHash: final.evaluatedBidSetHash,
      transactionId: final.routeReserved.transactionId,
      consensusTimestamp: final.routeReserved.consensusTimestamp,
      createdAt: final.updatedAt,
    });
    if (actual.byteCount > HCS_MAX_MESSAGE_BYTES) {
      attempt = withAttemptUpdate(attempt, {
        status: "FAILED",
        failureCode: "HCS_MESSAGE_TOO_LARGE",
        failureReason: `Actual envelope ${actual.byteCount} > ${HCS_MAX_MESSAGE_BYTES}`,
      });
      persistPhase6bAttempt(attempt, attemptPath);
      throw new Phase6bAttemptError(
        attempt.failureReason!,
        "HCS_MESSAGE_TOO_LARGE",
      );
    }

    if (final.hcsPublicationClaim?.status === "PUBLISHED") {
      attempt = withAttemptUpdate(attempt, {
        status: "SUCCESS",
        hcsPublishAttemptId: final.hcsPublicationClaim.publishAttemptId,
        hcsTransactionId: final.hcsPublicationClaim.transactionId,
        hcsSequence: final.hcsPublicationClaim.sequence,
        hcsConsensusTimestamp: final.hcsPublicationClaim.consensusTimestamp,
        paymentConsensusTimestamp: final.routeReserved.consensusTimestamp,
        evidencePaths: {
          json: PHASE6B_LIVE_EVIDENCE_JSON,
          md: PHASE6B_LIVE_EVIDENCE_MD,
          attempt: attemptPath,
        },
      });
    } else if (final.hcsPublicationClaim) {
      attempt = withAttemptUpdate(attempt, {
        status: "HCS_CLAIMED",
        hcsPublishAttemptId: final.hcsPublicationClaim.publishAttemptId,
      });
    } else {
      attempt = withAttemptUpdate(attempt, {
        status: "PAYMENT_CONFIRMED",
      });
    }
    persistPhase6bAttempt(attempt, attemptPath);

    return {
      mode: "LIVE",
      attempt,
      reservation: final,
      conservativeEnvelopeByteCount: conservative.byteCount,
      actualEnvelopeByteCount: actual.byteCount,
      serviceSettleAuthority: "ReservationService",
    };
  }

  attempt = withAttemptUpdate(attempt, {
    status: "AMBIGUOUS",
    failureCode: final.failureCode ?? "LIVE_INCOMPLETE",
    failureReason: final.failureReason ?? `state=${final.state}`,
  });
  persistPhase6bAttempt(attempt, attemptPath);

  return {
    mode: "LIVE",
    attempt,
    reservation: final,
    conservativeEnvelopeByteCount: conservative.byteCount,
    actualEnvelopeByteCount: null,
    serviceSettleAuthority: "ReservationService",
  };
}

void assertHcsNotYetClaimed;
void PHASE6B_USDC_TOKEN;
void PHASE6B_USDC_AMOUNT_ATOMIC;
void InMemoryReservationStore;
