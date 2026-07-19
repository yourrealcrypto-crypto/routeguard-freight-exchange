/**
 * Explicit dual-asset reservation orchestration (mocked transports).
 *
 * Safety authorities:
 *   - Durable record version + compareAndSet (a stale writer cannot overwrite a
 *     newer record).
 *   - Durable settle claim persisted with CAS before the external settle call
 *     (settle is invoked at most once; the claim holder alone may settle).
 *   - Mandatory Mirror SUCCESS before ROUTE_RESERVED; reservedAt is the Mirror
 *     consensus timestamp. No asset fallback. HTTP 200 alone never reserves.
 *
 * The in-process KeyedMutex in the store is only an optimization.
 */

import { randomUUID } from "node:crypto";

import type { CarrierRegistry } from "../domain/carrier";
import {
  buildPaymentEconomicsSummary,
  buildRailPresentation,
} from "../domain/payment-economics";
import type { FreightTender } from "../domain/tender";
import { compareUtc, isUtcIsoTimestamp } from "../domain/time";
import {
  assertNotReplaceSubmittedPayment,
  recoverInProgressState,
  type ReservationStore,
} from "./attempt-store";
import {
  assertExactChallenge,
  createPaymentChallengeRecord,
  durableChallengeView,
} from "./challenge";
import {
  assertClaimableRouteReservedPublication,
  assertValidHcsPublicationResult,
  createRouteReservedHcsEnvelope,
  buildRouteReservedPayload,
  measureRouteReservedEnvelope,
  routeReservedEnvelopeHash,
} from "./hcs-evidence";
import {
  computeCreationFingerprint,
  creationFingerprintFromRecord,
} from "./record-schema";
import {
  createReservationOffer,
  selectPaymentOption,
  verifyOfferIntegrity,
} from "./offer";
import { verifyMirrorPayment } from "./payment-verifier";
import { createRouteReservedRecord } from "./route-reserved-record";
import {
  assertCanEnterRouteReserved,
  assertLegalTransition,
  isPaymentSubmissionLocked,
  requireTransactionIdForSettlement,
} from "./state-machine";
import type {
  FacilitatorTransport,
  HcsPublicationResolver,
  HcsPublisherTransport,
  MirrorConfirmationTransport,
  WebhookDeliveryTransport,
  X402ChallengeTransport,
} from "./transports";
import type { RouteReservedEnvelope } from "../hcs/types";
import {
  DEMO_RESERVATION_FEE_NOTE,
  HBAR_RESERVATION_OPTION,
  RESERVATION_NETWORK,
  ReservationError,
  ReservationVersionConflictError,
  USDC_RESERVATION_OPTION,
  type CreateReservationInput,
  type HcsPublicationClaim,
  type MirrorPollRecord,
  type PaymentChallenge,
  type ReservationOptionId,
  type ReservationRecord,
  type ReservationState,
  type SelectedPaymentOption,
  type SettleClaim,
  type WebhookDeliveryRecord,
  type WebhookEvent,
} from "./types";
import { validateWinnerReservationInput } from "./winner-input";
import {
  createRouteReservedWebhookPayload,
  createWebhookEvent,
  rebuildSignedWebhook,
  reservationWebhookEventId,
} from "./webhook";

export type ReservationServiceDeps = {
  store: ReservationStore;
  registry: CarrierRegistry;
  challenge: X402ChallengeTransport;
  facilitator: FacilitatorTransport;
  mirror: MirrorConfirmationTransport;
  webhooks: WebhookDeliveryTransport;
  hcs: HcsPublisherTransport;
  /**
   * Read-only HCS publication resolver for ambiguous CLAIMED outcomes.
   * Optional for backwards compatibility — defaults to NOT_FOUND_CONCLUSIVE.
   */
  hcsResolver?: HcsPublicationResolver;
  /** TEST FIXTURE ONLY webhook signing key */
  webhookSigningPrivateKey: string;
  /** Wall-clock UTC ISO for durable timestamps. */
  now: () => string;
  /**
   * Monotonic-ish deadline clock in epoch milliseconds. Used only for poll
   * deadline comparison; tests inject a controllable clock. Defaults to Date.now.
   */
  nowMs?: () => number;
  /**
   * Deterministic sleep between Mirror polls. Tests inject a fake that advances
   * the clock without real wall waits. Defaults to setTimeout.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Bound for Mirror confirmation polling (default 30s). */
  confirmationTimeoutMs?: number;
  /** Interval between Mirror polls while PENDING/NOT_FOUND (default 200ms). */
  mirrorPollIntervalMs?: number;
};

function nowIso(deps: ReservationServiceDeps): string {
  const n = deps.now();
  if (!isUtcIsoTimestamp(n)) {
    throw new ReservationError("INVALID_TIMESTAMP", "now() must return UTC ISO");
  }
  return n;
}

function clockMs(deps: ReservationServiceDeps): number {
  return deps.nowMs ? deps.nowMs() : Date.now();
}

async function sleepMs(
  deps: ReservationServiceDeps,
  ms: number,
): Promise<void> {
  if (deps.sleep) {
    await deps.sleep(ms);
    return;
  }
  await new Promise<void>((r) => setTimeout(r, ms));
}

function isPastDeadline(
  deps: ReservationServiceDeps,
  deadlineIso: string,
): boolean {
  // Prefer ISO comparison via service now() so tests controlling now() work.
  try {
    return compareUtc(nowIso(deps), deadlineIso) >= 0;
  } catch {
    return clockMs(deps) >= Date.parse(deadlineIso);
  }
}

function transition(
  record: ReservationRecord,
  to: ReservationState,
  reason: string | undefined,
  at: string,
): ReservationRecord {
  assertLegalTransition(record.state, to);
  if (record.state === to) {
    return record;
  }
  if (typeof at !== "string" || !isUtcIsoTimestamp(at)) {
    throw new ReservationError(
      "INVALID_TIMESTAMP",
      "transition requires an explicit valid UTC timestamp",
    );
  }
  const ts = at;
  return {
    ...record,
    state: to,
    updatedAt: ts,
    history: [
      ...record.history,
      { from: record.state, to, at: ts, ...(reason ? { reason } : {}) },
    ],
  };
}

export class ReservationService {
  /**
   * Observability only — NOT the settle-once authority. The durable settle
   * claim persisted via CAS is authoritative.
   */
  private settleCalls = new Map<string, number>();

  constructor(private readonly deps: ReservationServiceDeps) {}

  getSettleCallCount(reservationId: string): number {
    return this.settleCalls.get(reservationId) ?? 0;
  }

  /** Persist a derived next-state via optimistic-concurrency compareAndSet. */
  private async commit(
    current: ReservationRecord,
    next: ReservationRecord,
  ): Promise<ReservationRecord> {
    return this.deps.store.compareAndSet(
      next.reservationId,
      current.recordVersion,
      next,
    );
  }

  async createReservation(
    input: CreateReservationInput,
    tender: FreightTender,
  ): Promise<ReservationRecord> {
    // Compute candidate fingerprint after winner validation so first create
    // still runs authentic winner/manifest checks. Existing record compared
    // by full fingerprint (not only winningBidId/tenderHash).
    const existing = await this.deps.store.get(input.reservationId);

    const validated = validateWinnerReservationInput(
      input,
      this.deps.registry,
      tender,
    );

    const offer = createReservationOffer({
      reservationId: validated.reservationId,
      tenderId: validated.tenderId,
      winningBidId: validated.winningBidId,
      payTo: validated.winningCarrierAccount,
      expiresAt: validated.expiresAt,
      offerVersion: validated.reservationOfferVersion,
    });
    verifyOfferIntegrity(offer);

    if (offer.payTo !== validated.winningCarrierAccount) {
      throw new ReservationError(
        "WRONG_RECIPIENT",
        "Offer payTo must equal winner carrier account",
      );
    }

    const creationFingerprint = computeCreationFingerprint({
      reservationId: validated.reservationId,
      tenderId: validated.tenderId,
      tenderVersion: validated.tenderVersion,
      tenderHash: validated.tenderHash,
      winningBidId: validated.winningBidId,
      winningBidHash: validated.winningBidHash,
      winningCarrierId: validated.winningCarrierId,
      winningCarrierAccount: validated.winningCarrierAccount,
      decisionManifestHash: validated.decisionManifestHash,
      evaluatedBidSetHash: validated.evaluatedBidSetHash,
      hcsTopicId: validated.hcsTopicId,
      closeBarrierSequence: validated.closeBarrierSequence,
      closeBarrierConsensusTimestamp: validated.closeBarrierConsensusTimestamp,
      reservationOfferVersion: validated.reservationOfferVersion,
      createdAt: validated.createdAt,
      expiresAt: validated.expiresAt,
    });

    if (existing) {
      // Idempotent only when the full creation fingerprint matches exactly.
      if (existing.creationFingerprint === creationFingerprint) {
        return existing;
      }
      // Also reject when fingerprint field set differs from recomputed existing.
      const existingRecomputed = creationFingerprintFromRecord(existing);
      if (existing.creationFingerprint !== existingRecomputed) {
        throw new ReservationError(
          "CORRUPT_RESERVATION_RECORD",
          "Existing reservation has invalid creationFingerprint",
        );
      }
      throw new ReservationError(
        "CONFLICT",
        "Reservation ID already exists with different creation fingerprint",
      );
    }

    const createdAt = validated.createdAt;
    const record: ReservationRecord = {
      recordVersion: 1,
      reservationId: validated.reservationId,
      state: "OFFER_CREATED",
      tenderId: validated.tenderId,
      tenderVersion: validated.tenderVersion,
      tenderHash: validated.tenderHash,
      winningBidId: validated.winningBidId,
      winningBidHash: validated.winningBidHash,
      winningCarrierId: validated.winningCarrierId,
      winningCarrierAccount: validated.winningCarrierAccount,
      decisionManifestHash: validated.decisionManifestHash,
      evaluatedBidSetHash: validated.evaluatedBidSetHash,
      hcsTopicId: validated.hcsTopicId,
      closeBarrierSequence: validated.closeBarrierSequence,
      closeBarrierConsensusTimestamp: validated.closeBarrierConsensusTimestamp,
      creationFingerprint,
      proofTenderId: validated.closureProof.tenderId,
      proofManifestHash: validated.closureProof.manifest.decisionManifestHash,
      offer,
      selected: null,
      attemptNumber: 0,
      paymentChallenge: null,
      paymentChallengeHash: null,
      paymentPayloadHash: null,
      facilitatorVerify: null,
      settleClaim: null,
      facilitatorSettle: null,
      transactionId: null,
      mirrorConfirmation: null,
      mirrorPoll: null,
      confirmationDeadline: null,
      routeReserved: null,
      webhookEvents: [],
      webhooks: [],
      hcsPublicationClaim: null,
      hcsEvidence: null,
      history: [
        {
          from: "OFFER_CREATED",
          to: "OFFER_CREATED",
          at: createdAt,
          reason: "created",
        },
      ],
      createdAt,
      updatedAt: createdAt,
      expiresAt: validated.expiresAt,
      failureCode: null,
      failureReason: null,
      _closureProof: validated.closureProof,
      _manifest: validated.closureProof.manifest,
    };

    return this.deps.store.create(record);
  }

  async getReservation(reservationId: string): Promise<ReservationRecord | null> {
    return this.deps.store.get(reservationId);
  }

  async selectOption(input: {
    reservationId: string;
    optionId: ReservationOptionId;
    offerHash: string;
    offerVersion: number;
    payerAccount: string;
  }): Promise<ReservationRecord> {
    const record = await this.require(input.reservationId);
    if (isPaymentSubmissionLocked(record.state)) {
      throw new ReservationError(
        "SELECTION_LOCKED",
        "Cannot change or re-select option after payment submission began",
      );
    }
    if (record.selected && record.state !== "OFFER_CREATED") {
      if (
        record.selected.optionId === input.optionId &&
        record.selected.offerHash === input.offerHash
      ) {
        return record;
      }
      if (record.state !== "OPTION_SELECTED" && record.state !== "PAYMENT_CHALLENGE_ISSUED") {
        throw new ReservationError("SELECTION_LOCKED", "Selection already fixed");
      }
      if (record.selected.optionId !== input.optionId) {
        throw new ReservationError("SELECTION_LOCKED", "Cannot switch selected asset");
      }
    }

    const now = nowIso(this.deps);
    const selected = selectPaymentOption({
      offer: record.offer,
      optionId: input.optionId,
      payerAccount: input.payerAccount,
      offerHash: input.offerHash,
      offerVersion: input.offerVersion,
      selectedAt: now,
      now,
    });

    if (selected.payTo !== record.winningCarrierAccount) {
      throw new ReservationError(
        "WRONG_RECIPIENT",
        "Selected payTo must equal winner carrier account",
      );
    }

    let next: ReservationRecord = {
      ...record,
      selected,
      attemptNumber: 1,
      updatedAt: now,
    };
    if (record.state === "OFFER_CREATED") {
      next = transition(next, "OPTION_SELECTED", "option selected", now);
    }
    return this.commit(record, next);
  }

  async issueChallenge(
    reservationId: string,
    optionId: ReservationOptionId,
  ): Promise<{
    record: ReservationRecord;
    challenge: PaymentChallenge & { challengeHash: string; issuedAt: string };
  }> {
    let record = await this.require(reservationId);
    if (!record.selected) {
      throw new ReservationError("NO_SELECTION", "Select an option first");
    }
    if (record.selected.optionId !== optionId) {
      throw new ReservationError(
        "WRONG_ASSET_ROUTE",
        `Selected ${record.selected.optionId}; cannot use ${optionId} route`,
      );
    }

    // Idempotent: after durable challenge exists, never re-call transport or
    // regenerate issuedAt / challengeHash.
    if (record.paymentChallenge) {
      if (
        isPaymentSubmissionLocked(record.state) &&
        record.state !== "PAYMENT_CHALLENGE_ISSUED" &&
        record.state !== "OPTION_SELECTED"
      ) {
        // Still return the identical challenge for GET; state is already locked.
        return {
          record,
          challenge: durableChallengeView(record.paymentChallenge),
        };
      }
      return {
        record,
        challenge: durableChallengeView(record.paymentChallenge),
      };
    }

    if (isPaymentSubmissionLocked(record.state) && record.paymentChallengeHash) {
      if (record.state !== "PAYMENT_CHALLENGE_ISSUED") {
        throw new ReservationError(
          "SELECTION_LOCKED",
          "Payment already in progress or finished",
        );
      }
    }

    const transportChallenge = await this.deps.challenge.createChallenge(
      record.selected,
    );
    assertExactChallenge(record.selected, transportChallenge);

    const issuedAt = nowIso(this.deps);
    const durable = createPaymentChallengeRecord(
      record.selected,
      transportChallenge,
      issuedAt,
    );

    let next: ReservationRecord = {
      ...record,
      paymentChallenge: durable,
      paymentChallengeHash: durable.challengeHash,
      updatedAt: issuedAt,
    };
    if (record.state === "OPTION_SELECTED") {
      next = transition(
        next,
        "PAYMENT_CHALLENGE_ISSUED",
        "challenge issued",
        issuedAt,
      );
    }

    const r = await this.commitOrConflict(record, next);
    if (r.conflicted) {
      // Concurrent issuer: reuse the durable winner; never overwrite.
      const latest = r.record;
      if (!latest.paymentChallenge) {
        throw new ReservationError(
          "CHALLENGE_PERSIST_CONFLICT",
          "CAS conflict while persisting challenge and no durable challenge found",
        );
      }
      return {
        record: latest,
        challenge: durableChallengeView(latest.paymentChallenge),
      };
    }
    return {
      record: r.record,
      challenge: durableChallengeView(r.record.paymentChallenge!),
    };
  }

  /**
   * Full payment orchestration for the already-selected option.
   * settle is invoked at most once per reservation, gated by a durable claim.
   */
  async submitPayment(input: {
    reservationId: string;
    optionId: ReservationOptionId;
    /** Hash of signed payment payload — never store the full payload. */
    paymentPayloadHash: string;
    /** Optional HTTP status observed by client — never sufficient alone. */
    httpStatus?: number;
  }): Promise<ReservationRecord> {
    let record = await this.require(input.reservationId);
    if (!record.selected) {
      throw new ReservationError("NO_SELECTION", "No selected option");
    }
    const selected: SelectedPaymentOption = record.selected;
    if (selected.optionId !== input.optionId) {
      throw new ReservationError(
        "WRONG_ASSET_ROUTE",
        "Asset route does not match selection — no fallback",
      );
    }

    if (
      record.state === "PAYMENT_REJECTED" ||
      record.state === "SETTLEMENT_FAILED" ||
      record.state === "CONFIRMATION_FAILED" ||
      record.state === "CONFIRMATION_TIMED_OUT" ||
      record.state === "MANUAL_REVIEW_REQUIRED"
    ) {
      throw new ReservationError(
        "TERMINAL_FAILURE",
        `Reservation is terminal: ${record.state}`,
      );
    }

    if (
      record.routeReserved &&
      record.paymentPayloadHash === input.paymentPayloadHash
    ) {
      return record;
    }
    if (record.routeReserved) {
      throw new ReservationError(
        "CONFLICT",
        "Reservation already confirmed with different payload",
      );
    }

    // A durable settle claim binds one exact payment payload. Any conflicting
    // payload against an existing claim fails closed.
    if (
      record.settleClaim &&
      record.settleClaim.paymentPayloadHash !== input.paymentPayloadHash
    ) {
      throw new ReservationError(
        "CONFLICT",
        "Conflicting payment payload against existing settle claim",
      );
    }

    void input.httpStatus; // informational only — never settlement proof

    if (!record.paymentChallengeHash) {
      throw new ReservationError(
        "NO_CHALLENGE",
        "Issue payment challenge before submission",
      );
    }
    const challengeHash: string = record.paymentChallengeHash;

    // Step 2: PAYMENT_SUBMISSION_STARTED persisted (durable, CAS).
    if (record.state === "OPTION_SELECTED") {
      throw new ReservationError(
        "NO_CHALLENGE",
        "Issue challenge before payment submission",
      );
    }
    if (record.state === "PAYMENT_CHALLENGE_ISSUED") {
      const now = nowIso(this.deps);
      let next: ReservationRecord = {
        ...record,
        paymentPayloadHash: input.paymentPayloadHash,
        attemptNumber: 1,
        updatedAt: now,
      };
      next = transition(next, "PAYMENT_SUBMISSION_STARTED", "payment submission started", now);
      const r = await this.commitOrConflict(record, next);
      if (r.conflicted) return r.record;
      record = r.record;
    } else if (record.state === "PAYMENT_SUBMISSION_STARTED") {
      if (
        record.paymentPayloadHash &&
        record.paymentPayloadHash !== input.paymentPayloadHash
      ) {
        throw new ReservationError("CONFLICT", "Conflicting payment payload hash");
      }
    }

    assertNotReplaceSubmittedPayment(record, {
      selected,
      paymentPayloadHash: input.paymentPayloadHash,
    });

    // Steps 3+4: verify, then FACILITATOR_VERIFIED persisted.
    if (record.state === "PAYMENT_SUBMISSION_STARTED") {
      const verifyResult = await this.deps.facilitator.verify({
        selected,
        paymentPayloadHash: input.paymentPayloadHash,
        challengeHash,
      });
      if (!verifyResult.isValid) {
        let next: ReservationRecord = {
          ...record,
          facilitatorVerify: verifyResult,
          updatedAt: nowIso(this.deps),
        };
        next = transition(
          next,
          "PAYMENT_REJECTED",
          verifyResult.invalidReason ?? "verify failed", nowIso(this.deps));
        next = {
          ...next,
          failureCode: "VERIFY_REJECTED",
          failureReason: verifyResult.invalidReason ?? "isValid=false",
        };
        return this.commit(record, next);
      }
      let next: ReservationRecord = {
        ...record,
        facilitatorVerify: verifyResult,
        updatedAt: nowIso(this.deps),
      };
      next = transition(next, "FACILITATOR_VERIFIED", "verify ok", nowIso(this.deps));
      const r = await this.commitOrConflict(record, next);
      if (r.conflicted) return r.record;
      record = r.record;
    }

    // Steps 5+6+7: durable settle claim (CAS gate) then settle at most once.
    const alreadySettled =
      record.facilitatorSettle?.success === true && !!record.transactionId;

    if (!alreadySettled) {
      if (record.state === "FACILITATOR_VERIFIED") {
        // Persist the durable settle claim BEFORE any external settle call.
        const claimedAt = nowIso(this.deps);
        const claim: SettleClaim = {
          settleAttemptId: randomUUID(),
          reservationId: record.reservationId,
          attemptNumber: record.attemptNumber || 1,
          selectedOptionId: selected.optionId,
          asset: selected.asset,
          amountAtomic: selected.amountAtomic,
          payerAccount: selected.payerAccount,
          payTo: selected.payTo,
          network: RESERVATION_NETWORK,
          challengeHash,
          paymentPayloadHash: input.paymentPayloadHash,
          claimedAt,
          recordVersion: record.recordVersion + 1,
        };
        let next: ReservationRecord = {
          ...record,
          settleClaim: claim,
          updatedAt: claimedAt,
        };
        next = transition(
          next,
          "FACILITATOR_SETTLE_CLAIMED",
          "settle claim persisted",
          claimedAt,
        );
        const r = await this.commitOrConflict(record, next);
        if (r.conflicted) return r.record;
        record = r.record;
        // This invocation now holds the durable claim and alone may settle.
      } else if (
        record.state === "FACILITATOR_SETTLE_CLAIMED" &&
        !record.transactionId
      ) {
        // A prior invocation already claimed but no transaction id was
        // persisted. Never auto-settle again — return in-progress; recovery
        // routes to MANUAL_REVIEW_REQUIRED.
        return record;
      }

      // Guard: only the settle-claim holder reaches the external settle call.
      if (record.state !== "FACILITATOR_SETTLE_CLAIMED" || !record.settleClaim) {
        return record;
      }

      this.settleCalls.set(
        input.reservationId,
        (this.settleCalls.get(input.reservationId) ?? 0) + 1,
      );
      const settleResult = await this.deps.facilitator.settle({
        selected,
        paymentPayloadHash: input.paymentPayloadHash,
        challengeHash,
      });

      if (!settleResult.success) {
        let next: ReservationRecord = {
          ...record,
          facilitatorSettle: settleResult,
          updatedAt: nowIso(this.deps),
        };
        next = transition(
          next,
          "SETTLEMENT_FAILED",
          settleResult.errorReason ?? "settle failed", nowIso(this.deps));
        next = {
          ...next,
          failureCode: "SETTLE_FAILED",
          failureReason: settleResult.errorReason ?? "success=false",
        };
        return this.commit(record, next);
      }

      let txId: string;
      try {
        txId = requireTransactionIdForSettlement(settleResult.transactionId);
      } catch (e) {
        let next: ReservationRecord = {
          ...record,
          facilitatorSettle: settleResult,
          updatedAt: nowIso(this.deps),
        };
        next = transition(next, "SETTLEMENT_FAILED", "missing transaction ID", nowIso(this.deps));
        next = {
          ...next,
          failureCode: "MISSING_TRANSACTION_ID",
          failureReason: e instanceof Error ? e.message : "missing transaction ID",
        };
        return this.commit(record, next);
      }

      if (settleResult.network !== selected.network) {
        let next = transition(
          { ...record, facilitatorSettle: settleResult },
          "SETTLEMENT_FAILED",
          "network mismatch",
          nowIso(this.deps),
        );
        next = {
          ...next,
          failureCode: "NETWORK_MISMATCH",
          failureReason: "settle network mismatch",
        };
        return this.commit(record, next);
      }
      if (settleResult.payerAccountId !== selected.payerAccount) {
        let next = transition(
          { ...record, facilitatorSettle: settleResult },
          "SETTLEMENT_FAILED",
          "payer mismatch",
          nowIso(this.deps),
        );
        next = {
          ...next,
          failureCode: "PAYER_MISMATCH",
          failureReason: "settle payer mismatch",
        };
        return this.commit(record, next);
      }

      let next: ReservationRecord = {
        ...record,
        facilitatorSettle: settleResult,
        transactionId: txId,
        updatedAt: nowIso(this.deps),
      };
      next = transition(next, "FACILITATOR_SETTLED", "settle ok", nowIso(this.deps));
      record = await this.commit(record, next);
    }

    // Step 9: bounded Mirror confirmation (no re-settle).
    return this.runMirrorConfirmation(record, selected);
  }

  /**
   * Resume ledger confirmation after restart. Never verifies/settles again,
   * never regenerates the challenge, never changes selected asset.
   */
  async resumePaymentConfirmation(
    reservationId: string,
  ): Promise<ReservationRecord> {
    let record = await this.require(reservationId);

    // Already reserved or later — idempotent no-op for payment ops.
    if (
      record.routeReserved ||
      record.state === "ROUTE_RESERVED" ||
      record.state === "WEBHOOKS_DISPATCHED" ||
      record.state === "WEBHOOK_DELIVERY_FAILED" ||
      record.state === "HCS_EVIDENCE_RECORDED" ||
      record.state === "HCS_EVIDENCE_FAILED" ||
      record.state === "COMPLETED"
    ) {
      return record;
    }

    // Settle claim without authoritative tx id → never settle; manual review.
    if (record.settleClaim && !record.transactionId) {
      if (record.state === "MANUAL_REVIEW_REQUIRED") return record;
      let next = transition(
        record,
        "MANUAL_REVIEW_REQUIRED",
        "settle claim without transaction id", nowIso(this.deps));
      next = {
        ...next,
        failureCode: "AMBIGUOUS_SETTLE_CLAIM",
        failureReason:
          "Settle claim exists without authoritative transaction ID — do not auto-settle",
      };
      return this.commit(record, next);
    }

    if (
      record.state !== "FACILITATOR_SETTLED" &&
      record.state !== "MIRROR_CONFIRMATION_PENDING"
    ) {
      throw new ReservationError(
        "NOT_CONFIRMABLE",
        `Cannot resume payment confirmation from state ${record.state}`,
      );
    }

    if (!record.selected) {
      throw new ReservationError("NO_SELECTION", "No selected option");
    }
    if (!record.transactionId) {
      throw new ReservationError(
        "MISSING_TRANSACTION_ID",
        "Cannot resume confirmation without transaction ID",
      );
    }
    if (!record.settleClaim) {
      throw new ReservationError(
        "NO_SETTLE_CLAIM",
        "Cannot resume confirmation without durable settle claim",
      );
    }

    return this.runMirrorConfirmation(record, record.selected);
  }

  /**
   * Bounded Mirror polling after durable settlement. Settlement is never
   * invoked here. Deadline is persisted and reused after restart.
   */
  private async runMirrorConfirmation(
    record: ReservationRecord,
    selected: SelectedPaymentOption,
  ): Promise<ReservationRecord> {
    const txId = requireTransactionIdForSettlement(record.transactionId);
    const timeoutMs = this.deps.confirmationTimeoutMs ?? 30_000;
    const pollIntervalMs = this.deps.mirrorPollIntervalMs ?? 200;

    // Establish or reuse durable confirmation deadline (never extend on restart).
    if (
      record.state === "FACILITATOR_SETTLED" ||
      (record.state === "MIRROR_CONFIRMATION_PENDING" &&
        !record.confirmationDeadline)
    ) {
      const startedAt = nowIso(this.deps);
      const deadline = new Date(clockMs(this.deps) + timeoutMs).toISOString();
      // Prefer ISO deadline from service now() + timeout when now is controllable.
      const deadlineFromNow = new Date(
        Date.parse(startedAt) + timeoutMs,
      ).toISOString();
      const confirmationDeadline =
        record.confirmationDeadline ??
        (Number.isFinite(Date.parse(startedAt)) ? deadlineFromNow : deadline);

      const poll: MirrorPollRecord = record.mirrorPoll ?? {
        transactionId: txId,
        confirmationStartedAt: startedAt,
        confirmationDeadline,
        pollAttemptCount: 0,
        lastPollAt: null,
        lastMirrorStatus: null,
        lastMirrorErrorCode: null,
        lastMirrorError: null,
        consensusTimestamp: null,
        verifiedTransfer: null,
      };

      let next: ReservationRecord = {
        ...record,
        confirmationDeadline: poll.confirmationDeadline,
        mirrorPoll: {
          ...poll,
          transactionId: txId,
          confirmationDeadline: poll.confirmationDeadline,
        },
        updatedAt: startedAt,
      };
      if (record.state === "FACILITATOR_SETTLED") {
        next = transition(
          next,
          "MIRROR_CONFIRMATION_PENDING",
          "awaiting mirror",
          startedAt,
        );
      }
      const r = await this.commitOrConflict(record, next);
      record = r.record;
    } else if (
      record.state === "MIRROR_CONFIRMATION_PENDING" &&
      record.confirmationDeadline &&
      !record.mirrorPoll
    ) {
      // Restart with deadline but missing poll record — reconstruct.
      const startedAt = record.updatedAt || nowIso(this.deps);
      const poll: MirrorPollRecord = {
        transactionId: txId,
        confirmationStartedAt: startedAt,
        confirmationDeadline: record.confirmationDeadline,
        pollAttemptCount: 0,
        lastPollAt: null,
        lastMirrorStatus: null,
        lastMirrorErrorCode: null,
        lastMirrorError: null,
        consensusTimestamp: null,
        verifiedTransfer: null,
      };
      record = await this.commit(record, {
        ...record,
        mirrorPoll: poll,
        updatedAt: nowIso(this.deps),
      });
    }

    const confirmationDeadline =
      record.confirmationDeadline ??
      record.mirrorPoll?.confirmationDeadline;
    if (!confirmationDeadline) {
      throw new ReservationError(
        "MISSING_CONFIRMATION_DEADLINE",
        "Confirmation deadline must be durable before polling",
      );
    }

    // Bound the loop; each poll is one Mirror call.
    // Max iterations as a safety backstop (deadline is the real authority).
    const maxIterations = Math.max(
      1,
      Math.ceil(timeoutMs / Math.max(1, pollIntervalMs)) + 5,
    );

    for (let i = 0; i < maxIterations; i++) {
      // Re-load for CAS freshness at loop head after sleeps.
      const current = await this.require(record.reservationId);
      record = current;
      if (!record.selected) {
        throw new ReservationError("NO_SELECTION", "No selected option");
      }
      // Asset never switches during confirmation.
      if (record.selected.optionId !== selected.optionId) {
        throw new ReservationError(
          "SELECTION_LOCKED",
          "Selected asset changed during confirmation — fail closed",
        );
      }
      if (record.transactionId !== txId) {
        throw new ReservationError(
          "TRANSACTION_ID_CHANGED",
          "Transaction ID must remain fixed during confirmation",
        );
      }

      if (
        record.state !== "MIRROR_CONFIRMATION_PENDING" &&
        record.state !== "FACILITATOR_SETTLED"
      ) {
        // Concurrent path already terminalized.
        return record;
      }

      const pollAt = nowIso(this.deps);
      let mirrorStatus:
        | "SUCCESS"
        | "FAILED"
        | "PENDING"
        | "NOT_FOUND"
        | "TRANSPORT_ERROR" = "TRANSPORT_ERROR";
      let mirrorError: string | null = null;
      let mirrorErrorCode: string | null = null;
      let mirror = record.mirrorConfirmation;

      try {
        mirror = await this.deps.mirror.getTransaction(txId);
        mirrorStatus = mirror.status;
      } catch (e) {
        mirrorStatus = "TRANSPORT_ERROR";
        mirrorError = e instanceof Error ? e.message : String(e);
        mirrorErrorCode = "MIRROR_TRANSPORT_ERROR";
        mirror = null;
      }

      const priorPoll = record.mirrorPoll;
      const rawTs = mirror?.consensusTimestamp;
      const safeTs =
        typeof rawTs === "string" && isUtcIsoTimestamp(rawTs)
          ? rawTs
          : priorPoll?.consensusTimestamp ?? null;
      const poll: MirrorPollRecord = {
        transactionId: txId,
        confirmationStartedAt:
          priorPoll?.confirmationStartedAt ??
          record.confirmationDeadline ??
          pollAt,
        confirmationDeadline,
        pollAttemptCount: (priorPoll?.pollAttemptCount ?? 0) + 1,
        lastPollAt: pollAt,
        lastMirrorStatus: mirrorStatus,
        lastMirrorErrorCode: mirrorErrorCode,
        lastMirrorError: mirrorError,
        consensusTimestamp: safeTs,
        verifiedTransfer: priorPoll?.verifiedTransfer ?? null,
      };

      {
        const r = await this.commitOrConflict(record, {
          ...record,
          mirrorConfirmation: mirror ?? record.mirrorConfirmation,
          mirrorPoll: poll,
          confirmationDeadline,
          updatedAt: pollAt,
        });
        record = r.record;
      }

      // Conclusive ledger FAILED — stop immediately, no more polls, no settle.
      if (mirrorStatus === "FAILED" && mirror) {
        let next = transition(record, "CONFIRMATION_FAILED", "mirror FAILED", nowIso(this.deps));
        next = {
          ...next,
          failureCode: "MIRROR_FAILED",
          failureReason: "Mirror Node reported FAILED",
          mirrorConfirmation: mirror,
          mirrorPoll: poll,
        };
        return this.commit(record, next);
      }

      if (mirrorStatus === "SUCCESS" && mirror) {
        try {
          if (!mirror.consensusTimestamp || !isUtcIsoTimestamp(mirror.consensusTimestamp)) {
            throw new ReservationError(
              "MISSING_CONSENSUS_TIMESTAMP",
              "Mirror SUCCESS requires a valid UTC consensus timestamp",
            );
          }
          const verified = verifyMirrorPayment(selected, mirror, txId);
          const verifiedTransfer = {
            optionId: verified.optionId,
            asset: verified.asset,
            amountAtomic: verified.amountAtomic,
            payerAccount: verified.payerAccount,
            payTo: verified.payTo,
          };
          const successPoll: MirrorPollRecord = {
            ...poll,
            consensusTimestamp: verified.consensusTimestamp,
            verifiedTransfer,
            lastMirrorStatus: "SUCCESS",
            lastMirrorError: null,
            lastMirrorErrorCode: null,
          };

          let next: ReservationRecord = {
            ...record,
            mirrorConfirmation: mirror,
            mirrorPoll: successPoll,
            updatedAt: nowIso(this.deps),
          };
          next = transition(next, "PAYMENT_CONFIRMED", "mirror SUCCESS verified", nowIso(this.deps));
          record = await this.commit(record, next);

          assertCanEnterRouteReserved({
            state: record.state,
            mirrorStatus: mirror.status,
            transactionId: txId,
          });

          const reservedAt = verified.consensusTimestamp;
          const routeReserved = createRouteReservedRecord({
            reservationId: record.reservationId,
            tenderId: record.tenderId,
            tenderVersion: record.tenderVersion,
            tenderHash: record.tenderHash,
            winningBidId: record.winningBidId,
            winningBidHash: record.winningBidHash,
            carrierId: record.winningCarrierId,
            carrierAccount: record.winningCarrierAccount,
            selectedOptionId: selected.optionId,
            paymentAsset: selected.asset,
            paymentAmountAtomic: selected.amountAtomic,
            payerAccount: selected.payerAccount,
            transactionId: txId,
            consensusTimestamp: verified.consensusTimestamp,
            decisionManifestHash: record.decisionManifestHash,
            evaluatedBidSetHash: record.evaluatedBidSetHash,
            hcsAuctionTopicId: record.hcsTopicId,
            closeBarrierSequence: record.closeBarrierSequence,
            reservedAt,
          });

          record = await this.commit(record, {
            ...transition(record, "ROUTE_RESERVED", "payment confirmed", nowIso(this.deps)),
            routeReserved,
          });

          // Post-reservation: webhooks then HCS (failure never reverses).
          record = await this.dispatchWebhooks(record);
          record = await this.publishHcsEvidence(record);

          if (
            record.state === "HCS_EVIDENCE_RECORDED" ||
            record.state === "HCS_EVIDENCE_FAILED"
          ) {
            record = await this.commit(
              record,
              transition(record, "COMPLETED", "post-reservation done", nowIso(this.deps)),
            );
          }
          return record;
        } catch (e) {
          let next = transition(
            record,
            "CONFIRMATION_FAILED",
            e instanceof Error ? e.message : "verify failed", nowIso(this.deps));
          next = {
            ...next,
            failureCode:
              e instanceof ReservationError ? e.code : "PAYMENT_VERIFY_FAILED",
            failureReason: e instanceof Error ? e.message : String(e),
            mirrorConfirmation: mirror,
            mirrorPoll: {
              ...poll,
              lastMirrorError:
                e instanceof Error ? e.message : String(e),
              lastMirrorErrorCode:
                e instanceof ReservationError ? e.code : "PAYMENT_VERIFY_FAILED",
            },
          };
          return this.commit(record, next);
        }
      }

      // PENDING / NOT_FOUND / TRANSPORT_ERROR — poll until deadline.
      if (isPastDeadline(this.deps, confirmationDeadline)) {
        let next = transition(
          record,
          "CONFIRMATION_TIMED_OUT",
          "mirror not conclusive within bound", nowIso(this.deps));
        next = {
          ...next,
          failureCode: "CONFIRMATION_TIMED_OUT",
          failureReason:
            mirrorStatus === "TRANSPORT_ERROR"
              ? `Mirror transport errors until deadline: ${mirrorError ?? "unknown"}`
              : `Mirror ${mirrorStatus} until confirmation deadline — no settle retry; no asset fallback`,
          mirrorPoll: poll,
        };
        return this.commit(record, next);
      }

      await sleepMs(this.deps, pollIntervalMs);
    }

    // Safety backstop — treat as timeout without settle.
    let next = transition(
      record,
      "CONFIRMATION_TIMED_OUT",
      "mirror poll iteration bound exhausted", nowIso(this.deps));
    next = {
      ...next,
      failureCode: "CONFIRMATION_TIMED_OUT",
      failureReason: "Mirror poll iteration bound exhausted",
    };
    return this.commit(record, next);
  }

  /** Rebuild the signed webhook + operational delivery record for one recipient. */
  private buildDelivery(
    event: WebhookEvent,
    prior: WebhookDeliveryRecord | undefined,
    delivered: boolean,
    attemptedAt: string,
    error: string | null,
    responseCode: number | null = delivered ? 200 : null,
  ): WebhookDeliveryRecord {
    return {
      eventId: event.eventId,
      recipient: event.recipient,
      payloadHash: event.payloadHash,
      delivered,
      deliveryAttemptNumber: (prior?.deliveryAttemptNumber ?? 0) + 1,
      attemptedAt,
      lastResponseCode: responseCode,
      lastError: error,
    };
  }

  /**
   * Create immutable shipper + carrier semantic webhook events and persist them
   * with CAS BEFORE any external delivery. A CAS loser reloads and reuses the
   * already-persisted events — never delivers an unpersisted local event.
   */
  private async ensureWebhookEventsPersisted(
    record: ReservationRecord,
  ): Promise<ReservationRecord> {
    if (!record.routeReserved) return record;
    if (record.webhookEvents.length >= 2) return record;

    const rr = record.routeReserved;
    const emittedAt = nowIso(this.deps);
    const events: WebhookEvent[] = [];

    for (const recipient of ["shipper", "carrier"] as const) {
      const eventId = reservationWebhookEventId(record.reservationId, recipient);
      const existing = record.webhookEvents.find((e) => e.eventId === eventId);
      if (existing) {
        events.push(existing);
        continue;
      }
      const payload = createRouteReservedWebhookPayload({
        eventId,
        reservation: {
          reservationId: record.reservationId,
          tenderId: record.tenderId,
          winningBidId: record.winningBidId,
        },
        carrierAccount: record.winningCarrierAccount,
        selectedOptionId: rr.selectedOptionId,
        paymentAsset: rr.paymentAsset,
        paymentAmountAtomic: rr.paymentAmountAtomic,
        transactionId: rr.transactionId,
        consensusTimestamp: rr.consensusTimestamp,
        reservationRecordHash: rr.reservationRecordHash,
        emittedAt,
      });
      events.push(
        createWebhookEvent({
          eventId,
          recipient,
          payload,
          privateKeyHex: this.deps.webhookSigningPrivateKey,
        }),
      );
    }

    const next: ReservationRecord = {
      ...record,
      webhookEvents: events,
      updatedAt: emittedAt,
    };
    const r = await this.commitOrConflict(record, next);
    if (!r.conflicted) {
      return r.record;
    }
    // CAS loser: reload and reuse durable events only — do not deliver local.
    const latest = r.record;
    if (latest.webhookEvents.length < 2) {
      throw new ReservationError(
        "WEBHOOK_EVENT_PERSIST_CONFLICT",
        "CAS conflict while persisting webhook events and no durable events found",
      );
    }
    return latest;
  }

  /**
   * Deliver only already-persisted webhook events, then persist operational
   * delivery metadata. Never creates or mutates semantic event fields.
   */
  private async deliverPersistedWebhooks(
    record: ReservationRecord,
  ): Promise<ReservationRecord> {
    if (record.webhookEvents.length === 0) {
      throw new ReservationError(
        "NO_WEBHOOK_EVENTS",
        "Cannot deliver: no persisted webhook events",
      );
    }

    const deliveries: WebhookDeliveryRecord[] = [];
    for (const event of record.webhookEvents) {
      const signed = rebuildSignedWebhook(event);
      const result = await this.deps.webhooks.deliver(event.recipient, signed);
      const prior = record.webhooks.find((w) => w.eventId === event.eventId);
      deliveries.push(
        this.buildDelivery(
          event,
          prior,
          result.ok,
          nowIso(this.deps),
          result.ok ? null : (result.error ?? "delivery failed"),
        ),
      );
    }

    const allOk = deliveries.every((d) => d.delivered);
    let next: ReservationRecord = {
      ...record,
      // Semantic events are immutable — never rewrite them after first persist.
      webhookEvents: record.webhookEvents,
      webhooks: deliveries,
      updatedAt: nowIso(this.deps),
    };

    if (allOk) {
      if (
        next.state === "ROUTE_RESERVED" ||
        next.state === "WEBHOOK_DELIVERY_FAILED"
      ) {
        next = transition(next, "WEBHOOKS_DISPATCHED", "webhooks ok", nowIso(this.deps));
      }
    } else if (next.state === "ROUTE_RESERVED") {
      next = transition(
        next,
        "WEBHOOK_DELIVERY_FAILED",
        "one or more webhooks failed", nowIso(this.deps));
    }
    // Already WEBHOOKS_DISPATCHED with a later failed retry: keep state; only
    // operational delivery metadata changes (never reverse ROUTE_RESERVED).
    const r = await this.commitOrConflict(record, next);
    // Concurrent delivery CAS loser: return durable snapshot (at-least-once).
    return r.record;
  }

  /**
   * ROUTE_RESERVED → create+persist immutable events → deliver only persisted.
   * Webhook failure never reverses ROUTE_RESERVED.
   */
  private async dispatchWebhooks(
    record: ReservationRecord,
  ): Promise<ReservationRecord> {
    if (!record.routeReserved || !record.selected) return record;

    // 1–2. Create and durably persist both semantic events before any delivery.
    record = await this.ensureWebhookEventsPersisted(record);
    // 3. Reload is implied by CAS return; re-fetch for a clean durable snapshot.
    const reloaded = await this.deps.store.get(record.reservationId);
    if (!reloaded || reloaded.webhookEvents.length < 2) {
      throw new ReservationError(
        "WEBHOOK_EVENTS_NOT_DURABLE",
        "Webhook events must be persisted before delivery",
      );
    }
    // 4–5. Deliver only persisted events; persist delivery-attempt metadata.
    return this.deliverPersistedWebhooks(reloaded);
  }

  /**
   * Retry webhook delivery reusing the immutable semantic events verbatim.
   * Only operational delivery metadata changes.
   */
  async retryWebhooks(reservationId: string): Promise<ReservationRecord> {
    const record = await this.require(reservationId);
    if (record.webhookEvents.length === 0) {
      throw new ReservationError(
        "NO_WEBHOOK_EVENTS",
        "No webhook events to retry",
      );
    }
    return this.deliverPersistedWebhooks(record);
  }

  /**
   * Public resume entry: ensure semantic events are durable then deliver.
   * Safe for concurrent callers (CAS on event persist; losers reuse events).
   */
  async resumeWebhookDispatch(
    reservationId: string,
  ): Promise<ReservationRecord> {
    const record = await this.require(reservationId);
    if (!record.routeReserved) {
      throw new ReservationError(
        "NOT_ROUTE_RESERVED",
        "Cannot dispatch webhooks before ROUTE_RESERVED",
      );
    }
    return this.dispatchWebhooks(record);
  }

  /**
   * Public resume entry for HCS publication claim / resolve (never re-settles).
   */
  async resumeHcsPublication(
    reservationId: string,
  ): Promise<ReservationRecord> {
    const record = await this.require(reservationId);
    if (!record.routeReserved) {
      throw new ReservationError(
        "NOT_ROUTE_RESERVED",
        "Cannot publish HCS evidence before ROUTE_RESERVED",
      );
    }
    return this.publishHcsEvidence(record);
  }

  private isHcsAlreadyPublished(record: ReservationRecord): boolean {
    if (record.hcsPublicationClaim?.status === "PUBLISHED") return true;
    if (record.hcsEvidence?.published === true) return true;
    return false;
  }

  /**
   * Durable HCS outbox: persist publication claim BEFORE external publish.
   * Concurrent callers: only the CAS claim holder may publish (at most once).
   * Ambiguous outcomes resolve via read-only resolver — never auto-resubmit.
   */
  private async publishHcsEvidence(
    record: ReservationRecord,
  ): Promise<ReservationRecord> {
    if (!record.routeReserved) return record;
    if (this.isHcsAlreadyPublished(record)) {
      return this.ensureHcsRecordedState(record);
    }

    const claim = record.hcsPublicationClaim;
    if (claim) {
      if (claim.status === "MANUAL_REVIEW_REQUIRED") {
        return this.finishHcsFailed(
          record,
          claim.envelopeHash,
          claim.failureReason ?? "manual review required",
          claim,
        );
      }
      if (claim.status === "FAILED_CONCLUSIVE") {
        return this.finishHcsFailed(
          record,
          claim.envelopeHash,
          claim.failureReason ?? "hcs publication failed conclusively",
          claim,
        );
      }
      // CLAIMED / RESOLVING with no recorded result: never auto-publish again.
      if (
        (claim.status === "CLAIMED" || claim.status === "RESOLVING") &&
        !claim.transactionId &&
        claim.sequence == null
      ) {
        return this.resolveAmbiguousHcsClaim(record, claim);
      }
      // Claim already has publication fields but not PUBLISHED status — finalize.
      if (claim.sequence != null && claim.consensusTimestamp) {
        return this.persistHcsPublished(record, claim, {
          topicId: claim.expectedTopicId,
          sequence: claim.sequence,
          transactionId: claim.transactionId,
          consensusTimestamp: claim.consensusTimestamp,
        });
      }
      return this.resolveAmbiguousHcsClaim(record, claim);
    }

    // No claim yet: build, validate, CAS-persist claim, then publish once.
    return this.claimAndPublishHcs(record);
  }

  private async claimAndPublishHcs(
    record: ReservationRecord,
  ): Promise<ReservationRecord> {
    if (!record.routeReserved) return record;
    const rr = record.routeReserved;
    const expectedTopicId = record.hcsTopicId;

    let envelope: RouteReservedEnvelope;
    let envelopeHashValue: string;
    let encodedByteCount: number;
    try {
      const payload = buildRouteReservedPayload(rr, record.winningCarrierId);
      envelope = createRouteReservedHcsEnvelope({
        runId: `reservation-${record.reservationId}`,
        tenderId: record.tenderId,
        tenderVersion: record.tenderVersion,
        tenderHash: record.tenderHash,
        createdAt: nowIso(this.deps),
        payload,
      });
      const checked = assertClaimableRouteReservedPublication({
        envelope,
        expectedTopicId,
        reservation: rr,
        reservationHcsTopicId: record.hcsTopicId,
      });
      envelopeHashValue = checked.envelopeHash;
      encodedByteCount = checked.encodedByteCount;
    } catch (e) {
      return this.finishHcsFailed(
        record,
        "",
        e instanceof Error ? e.message : String(e),
        null,
        "HCS_CLAIM_PRECHECK_FAILED",
      );
    }

    const claimedAt = nowIso(this.deps);
    const claim: HcsPublicationClaim = {
      publishAttemptId: randomUUID(),
      reservationId: record.reservationId,
      expectedTopicId,
      messageType: "ROUTE_RESERVED",
      envelope: Object.freeze(
        JSON.parse(JSON.stringify(envelope)) as Record<string, unknown>,
      ),
      envelopeHash: envelopeHashValue,
      encodedByteCount,
      claimedAt,
      status: "CLAIMED",
      transactionId: null,
      sequence: null,
      consensusTimestamp: null,
      failureCode: null,
      failureReason: null,
    };

    const claimedRecord: ReservationRecord = {
      ...record,
      hcsPublicationClaim: claim,
      updatedAt: claimedAt,
    };
    const r = await this.commitOrConflict(record, claimedRecord);
    if (r.conflicted) {
      // Another caller holds or is creating the claim — never publish as loser.
      // Do not resolve here: the claim holder may still be in-flight. Resolution
      // is for restart/resume when the claim is CLAIMED with no recorded result.
      const latest = r.record;
      if (this.isHcsAlreadyPublished(latest)) {
        return this.ensureHcsRecordedState(latest);
      }
      return latest;
    }

    record = r.record;
    const held = record.hcsPublicationClaim!;
    // Only the claim holder reaches the external publisher.
    return this.invokeHcsPublish(record, held, envelope);
  }

  private async invokeHcsPublish(
    record: ReservationRecord,
    claim: HcsPublicationClaim,
    envelope: RouteReservedEnvelope,
  ): Promise<ReservationRecord> {
    // Publisher must see the exact persisted envelope bytes/hash.
    if (routeReservedEnvelopeHash(envelope) !== claim.envelopeHash) {
      return this.finishHcsFailed(
        record,
        claim.envelopeHash,
        "Publisher envelope hash does not match durable claim",
        {
          ...claim,
          status: "FAILED_CONCLUSIVE",
          failureCode: "HCS_ENVELOPE_HASH_MISMATCH",
          failureReason: "Publisher envelope hash does not match durable claim",
        },
        "HCS_ENVELOPE_HASH_MISMATCH",
      );
    }
    if (measureRouteReservedEnvelope(envelope) !== claim.encodedByteCount) {
      return this.finishHcsFailed(
        record,
        claim.envelopeHash,
        "Publisher envelope size does not match durable claim",
        {
          ...claim,
          status: "FAILED_CONCLUSIVE",
          failureCode: "HCS_ENVELOPE_SIZE_MISMATCH",
          failureReason: "Publisher envelope size does not match durable claim",
        },
        "HCS_ENVELOPE_SIZE_MISMATCH",
      );
    }

    let published: {
      topicId: string;
      sequence: number;
      transactionId: string;
      consensusTimestamp: string;
    };
    try {
      published = await this.deps.hcs.publish(envelope);
    } catch (e) {
      // Ambiguous: submission may or may not have reached consensus.
      // Never auto-resubmit — leave CLAIMED and resolve.
      return this.resolveAmbiguousHcsClaim(record, {
        ...claim,
        failureCode: "HCS_PUBLISH_EXCEPTION",
        failureReason: e instanceof Error ? e.message : String(e),
      });
    }

    try {
      const validated = assertValidHcsPublicationResult({
        topicId: published.topicId,
        expectedTopicId: claim.expectedTopicId,
        transactionId: published.transactionId,
        sequence: published.sequence,
        consensusTimestamp: published.consensusTimestamp,
      });
      return this.persistHcsPublished(record, claim, validated);
    } catch (e) {
      // Response failed validation — do not treat as published; no resubmit.
      return this.finishHcsFailed(
        record,
        claim.envelopeHash,
        e instanceof Error ? e.message : String(e),
        {
          ...claim,
          status: "FAILED_CONCLUSIVE",
          failureCode:
            e instanceof ReservationError ? e.code : "HCS_INVALID_PUBLISH_RESULT",
          failureReason: e instanceof Error ? e.message : String(e),
        },
        e instanceof ReservationError ? e.code : "HCS_INVALID_PUBLISH_RESULT",
      );
    }
  }

  private async resolveAmbiguousHcsClaim(
    record: ReservationRecord,
    claim: HcsPublicationClaim,
  ): Promise<ReservationRecord> {
    const resolving: HcsPublicationClaim = {
      ...claim,
      status: "RESOLVING",
    };
    let working = record;
    if (record.hcsPublicationClaim?.status !== "RESOLVING") {
      const r = await this.commitOrConflict(record, {
        ...record,
        hcsPublicationClaim: resolving,
        updatedAt: nowIso(this.deps),
      });
      if (r.conflicted) {
        return this.publishHcsEvidence(r.record);
      }
      working = r.record;
    }

    const resolver = this.deps.hcsResolver;
    const resolveResult = resolver
      ? await resolver.resolvePublication({
          topicId: claim.expectedTopicId,
          envelopeHash: claim.envelopeHash,
          messageType: "ROUTE_RESERVED",
          reservationId: claim.reservationId,
        })
      : ({ status: "NOT_FOUND_CONCLUSIVE" } as const);

    if (resolveResult.status === "FOUND") {
      try {
        const validated = assertValidHcsPublicationResult({
          topicId: resolveResult.topicId,
          expectedTopicId: claim.expectedTopicId,
          transactionId: resolveResult.transactionId,
          sequence: resolveResult.sequence,
          consensusTimestamp: resolveResult.consensusTimestamp,
          envelopeHash: resolveResult.envelopeHash,
          expectedEnvelopeHash: claim.envelopeHash,
          allowMissingTransactionId: true,
        });
        return this.persistHcsPublished(working, claim, {
          ...validated,
          transactionId: validated.transactionId,
        });
      } catch (e) {
        return this.finishHcsFailed(
          working,
          claim.envelopeHash,
          e instanceof Error ? e.message : String(e),
          {
            ...claim,
            status: "FAILED_CONCLUSIVE",
            failureCode:
              e instanceof ReservationError
                ? e.code
                : "HCS_RESOLVE_FOUND_INVALID",
            failureReason: e instanceof Error ? e.message : String(e),
          },
          e instanceof ReservationError ? e.code : "HCS_RESOLVE_FOUND_INVALID",
        );
      }
    }

    if (resolveResult.status === "AMBIGUOUS") {
      const reviewed: HcsPublicationClaim = {
        ...claim,
        status: "MANUAL_REVIEW_REQUIRED",
        failureCode: "HCS_PUBLICATION_AMBIGUOUS",
        failureReason:
          "Authoritative HCS resolver returned AMBIGUOUS — no automatic resubmit",
      };
      return this.finishHcsFailed(
        working,
        claim.envelopeHash,
        reviewed.failureReason!,
        reviewed,
        "HCS_PUBLICATION_AMBIGUOUS",
      );
    }

    // NOT_FOUND_CONCLUSIVE: controlled state — no automatic republish this milestone.
    const notFound: HcsPublicationClaim = {
      ...claim,
      status: "CLAIMED",
      failureCode: "HCS_NOT_FOUND_CONCLUSIVE",
      failureReason:
        "Resolver returned NOT_FOUND_CONCLUSIVE — no automatic republish",
    };
    return this.finishHcsFailed(
      working,
      claim.envelopeHash,
      notFound.failureReason!,
      notFound,
      "HCS_NOT_FOUND_CONCLUSIVE",
    );
  }

  private async persistHcsPublished(
    record: ReservationRecord,
    claim: HcsPublicationClaim,
    result: {
      topicId: string;
      sequence: number;
      transactionId: string | null;
      consensusTimestamp: string;
    },
  ): Promise<ReservationRecord> {
    const publishedClaim: HcsPublicationClaim = {
      ...claim,
      status: "PUBLISHED",
      transactionId: result.transactionId,
      sequence: result.sequence,
      consensusTimestamp: result.consensusTimestamp,
      failureCode: null,
      failureReason: null,
    };
    let next: ReservationRecord = {
      ...record,
      hcsPublicationClaim: publishedClaim,
      hcsEvidence: {
        messageType: "ROUTE_RESERVED",
        envelopeHash: claim.envelopeHash,
        topicId: result.topicId,
        sequence: result.sequence,
        transactionId: result.transactionId,
        consensusTimestamp: result.consensusTimestamp,
        published: true,
        lastError: null,
      },
      updatedAt: nowIso(this.deps),
    };
    if (
      next.state === "WEBHOOKS_DISPATCHED" ||
      next.state === "WEBHOOK_DELIVERY_FAILED" ||
      next.state === "ROUTE_RESERVED" ||
      next.state === "HCS_EVIDENCE_FAILED"
    ) {
      next = transition(next, "HCS_EVIDENCE_RECORDED", "hcs published", nowIso(this.deps));
    }
    const r = await this.commitOrConflict(record, next);
    return r.record;
  }

  private async finishHcsFailed(
    record: ReservationRecord,
    envelopeHash: string,
    lastError: string,
    claim: HcsPublicationClaim | null,
    _failureCode?: string,
  ): Promise<ReservationRecord> {
    // Post-reservation HCS ambiguity/failure is modeled on the outbox claim and
    // HCS_EVIDENCE_FAILED — never a payment-terminal MANUAL_REVIEW_REQUIRED, and
    // never reverse ROUTE_RESERVED. Do not overwrite payment failureCode.
    let next: ReservationRecord = {
      ...record,
      hcsPublicationClaim: claim ?? record.hcsPublicationClaim,
      hcsEvidence: {
        messageType: "ROUTE_RESERVED",
        envelopeHash,
        topicId: null,
        sequence: null,
        transactionId: null,
        consensusTimestamp: null,
        published: false,
        lastError,
      },
      updatedAt: nowIso(this.deps),
    };
    if (
      next.state === "WEBHOOKS_DISPATCHED" ||
      next.state === "WEBHOOK_DELIVERY_FAILED" ||
      next.state === "ROUTE_RESERVED"
    ) {
      next = transition(next, "HCS_EVIDENCE_FAILED", "hcs publish failed", nowIso(this.deps));
    }
    const r = await this.commitOrConflict(record, next);
    return r.record;
  }

  private async ensureHcsRecordedState(
    record: ReservationRecord,
  ): Promise<ReservationRecord> {
    if (record.state === "HCS_EVIDENCE_RECORDED" || record.state === "COMPLETED") {
      return record;
    }
    if (
      record.state === "WEBHOOKS_DISPATCHED" ||
      record.state === "WEBHOOK_DELIVERY_FAILED" ||
      record.state === "ROUTE_RESERVED" ||
      record.state === "HCS_EVIDENCE_FAILED"
    ) {
      const next = transition(record, "HCS_EVIDENCE_RECORDED", "hcs already published", nowIso(this.deps));
      const r = await this.commitOrConflict(record, next);
      return r.record;
    }
    return record;
  }

  async recover(
    reservationId: string,
    resolution?: { mirror?: { status: string }; transactionId?: string },
  ): Promise<ReservationRecord> {
    const record = await this.require(reservationId);
    const recovered = recoverInProgressState(record, resolution);
    if (recovered.state !== record.state) {
      return this.commit(record, recovered);
    }
    return recovered;
  }

  private async require(reservationId: string): Promise<ReservationRecord> {
    const record = await this.deps.store.get(reservationId);
    if (!record) {
      throw new ReservationError("NOT_FOUND", `Reservation ${reservationId}`);
    }
    return record;
  }

  /**
   * Commit and, on a version conflict, return the current in-progress record so
   * a losing concurrent caller yields an idempotent in-progress result instead
   * of proceeding to settle. `conflicted` distinguishes the two outcomes.
   */
  private async commitOrConflict(
    current: ReservationRecord,
    next: ReservationRecord,
  ): Promise<{ record: ReservationRecord; conflicted: boolean }> {
    try {
      return { record: await this.commit(current, next), conflicted: false };
    } catch (e) {
      if (e instanceof ReservationVersionConflictError) {
        const latest = await this.deps.store.get(current.reservationId);
        if (latest) {
          return { record: latest, conflicted: true };
        }
      }
      throw e;
    }
  }
}

/**
 * Public rail presentation for asset selector surfaces.
 * Application metadata only — not part of the x402 challenge body.
 */
export function publicPaymentRailsFromOffer(offer: ReservationRecord["offer"]) {
  return offer.options.map((option) =>
    buildRailPresentation({
      optionId: option.optionId,
      asset: option.asset,
      amountAtomic: option.amountAtomic,
      displayAmount: option.displayAmount,
      currencyLabel: option.currencyLabel,
    }),
  );
}

export function paymentEconomicsForSelection(
  selected: SelectedPaymentOption,
) {
  const fixed =
    selected.optionId === "USDC"
      ? USDC_RESERVATION_OPTION
      : HBAR_RESERVATION_OPTION;
  return buildPaymentEconomicsSummary({
    optionId: selected.optionId,
    asset: selected.asset,
    amountAtomic: selected.amountAtomic,
    displayAmount: fixed.displayAmount,
    currencyLabel: fixed.currencyLabel,
  });
}

/**
 * Public reservation view — never exposes settle claims, payment payloads,
 * webhook signatures, HCS publishAttemptId, proof handles, or internal paths.
 */
export function publicReservationView(record: ReservationRecord): unknown {
  const hcs =
    record.hcsEvidence?.published === true
      ? {
          messageType: record.hcsEvidence.messageType,
          topicId: record.hcsEvidence.topicId,
          sequence: record.hcsEvidence.sequence,
          transactionId: record.hcsEvidence.transactionId,
          consensusTimestamp: record.hcsEvidence.consensusTimestamp,
          published: true as const,
        }
      : record.hcsEvidence
        ? {
            messageType: record.hcsEvidence.messageType,
            published: false as const,
          }
        : null;

  const paymentEconomics = record.selected
    ? paymentEconomicsForSelection(record.selected)
    : null;

  return {
    reservationId: record.reservationId,
    state: record.state,
    tenderId: record.tenderId,
    tenderVersion: record.tenderVersion,
    tenderHash: record.tenderHash,
    winningBidId: record.winningBidId,
    winningBidHash: record.winningBidHash,
    winningCarrierId: record.winningCarrierId,
    winningCarrierAccount: record.winningCarrierAccount,
    offer: record.offer,
    paymentRails: publicPaymentRailsFromOffer(record.offer),
    selectedOptionId: record.selected?.optionId ?? null,
    selectedSummary: record.selected
      ? {
          optionId: record.selected.optionId,
          asset: record.selected.asset,
          amountAtomic: record.selected.amountAtomic,
          payTo: record.selected.payTo,
          network: record.selected.network,
        }
      : null,
    paymentEconomics,
    feeLabel: DEMO_RESERVATION_FEE_NOTE,
    transactionId: record.transactionId,
    routeReserved: record.routeReserved
      ? {
          reservationId: record.routeReserved.reservationId,
          tenderId: record.routeReserved.tenderId,
          winningBidId: record.routeReserved.winningBidId,
          carrierAccount: record.routeReserved.carrierAccount,
          selectedOptionId: record.routeReserved.selectedOptionId,
          paymentAsset: record.routeReserved.paymentAsset,
          paymentAmountAtomic: record.routeReserved.paymentAmountAtomic,
          /** Carrier receives the full reservation payment; network cost not deducted. */
          carrierReceivedAmountAtomic:
            record.routeReserved.paymentAmountAtomic,
          challengeStatedHederaNetworkTransferCostUsd: paymentEconomics
            ? paymentEconomics.hederaNetworkTransferCost.networkFeeUsd
            : null,
          transactionId: record.routeReserved.transactionId,
          consensusTimestamp: record.routeReserved.consensusTimestamp,
          reservedAt: record.routeReserved.reservedAt,
          reservationRecordHash: record.routeReserved.reservationRecordHash,
        }
      : null,
    hcsEvidence: hcs,
    failureCode: record.failureCode,
    // Sanitized public failure code only — do not expose internal reason text
    // that may include implementation detail (reason kept null for public view).
    failureReason: null,
  };
}

export type { SelectedPaymentOption };
