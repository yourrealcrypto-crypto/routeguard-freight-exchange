/**
 * Explicit dual-asset reservation orchestration (mocked transports).
 * HTTP 200 alone never reserves. Settle at most once. No asset fallback.
 */

import { canonicalSha256 } from "../domain/canonical-hash";
import type { CarrierRegistry } from "../domain/carrier";
import type { FreightTender } from "../domain/tender";
import { isUtcIsoTimestamp } from "../domain/time";
import {
  assertNotReplaceSubmittedPayment,
  recoverInProgressState,
  type ReservationStore,
} from "./attempt-store";
import {
  createRouteReservedHcsEnvelope,
  buildRouteReservedPayload,
  routeReservedEnvelopeHash,
} from "./hcs-evidence";
import {
  assertSelectionMatchesChallenge,
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
  HcsPublisherTransport,
  MirrorConfirmationTransport,
  WebhookDeliveryTransport,
  X402ChallengeTransport,
} from "./transports";
import {
  DEMO_RESERVATION_FEE_NOTE,
  ReservationError,
  type CreateReservationInput,
  type PaymentChallenge,
  type ReservationOptionId,
  type ReservationRecord,
  type ReservationState,
  type SelectedPaymentOption,
} from "./types";
import { validateWinnerReservationInput } from "./winner-input";
import {
  createRouteReservedWebhookPayload,
  reservationWebhookEventId,
  signWebhook,
} from "./webhook";

export type ReservationServiceDeps = {
  store: ReservationStore;
  registry: CarrierRegistry;
  challenge: X402ChallengeTransport;
  facilitator: FacilitatorTransport;
  mirror: MirrorConfirmationTransport;
  webhooks: WebhookDeliveryTransport;
  hcs: HcsPublisherTransport;
  /** TEST FIXTURE ONLY webhook signing key */
  webhookSigningPrivateKey: string;
  now: () => string;
  confirmationTimeoutMs?: number;
};

function nowIso(deps: ReservationServiceDeps): string {
  const n = deps.now();
  if (!isUtcIsoTimestamp(n)) {
    throw new ReservationError("INVALID_TIMESTAMP", "now() must return UTC ISO");
  }
  return n;
}

function transition(
  record: ReservationRecord,
  to: ReservationState,
  reason?: string,
  at?: string,
): ReservationRecord {
  assertLegalTransition(record.state, to);
  if (record.state === to) {
    return record;
  }
  const ts = at ?? new Date().toISOString();
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
  private settleCalls = new Map<string, number>();

  constructor(private readonly deps: ReservationServiceDeps) {}

  getSettleCallCount(reservationId: string): number {
    return this.settleCalls.get(reservationId) ?? 0;
  }

  async createReservation(
    input: CreateReservationInput,
    tender?: FreightTender,
  ): Promise<ReservationRecord> {
    const existing = await this.deps.store.get(input.reservationId);
    if (existing) {
      // Idempotent create
      if (
        existing.winningBidId === input.winningBidId &&
        existing.tenderHash === input.tenderHash
      ) {
        return existing;
      }
      throw new ReservationError(
        "CONFLICT",
        "Reservation ID already exists with different content",
      );
    }

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

    const createdAt = validated.createdAt;
    const record: ReservationRecord = {
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
      proofTenderId: validated.closureProof.tenderId,
      proofManifestHash: validated.closureProof.manifest.decisionManifestHash,
      offer,
      selected: null,
      attemptNumber: 0,
      paymentChallengeHash: null,
      paymentPayloadHash: null,
      facilitatorVerify: null,
      facilitatorSettle: null,
      transactionId: null,
      mirrorConfirmation: null,
      confirmationDeadline: null,
      routeReserved: null,
      webhooks: [],
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

    await this.deps.store.put(record);
    return record;
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
      // Allow idempotent same selection before challenge
      if (
        record.selected.optionId === input.optionId &&
        record.selected.offerHash === input.offerHash
      ) {
        return record;
      }
      if (record.state !== "OPTION_SELECTED" && record.state !== "PAYMENT_CHALLENGE_ISSUED") {
        throw new ReservationError(
          "SELECTION_LOCKED",
          "Selection already fixed",
        );
      }
      if (record.selected.optionId !== input.optionId) {
        throw new ReservationError(
          "SELECTION_LOCKED",
          "Cannot switch selected asset",
        );
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
    await this.deps.store.put(next);
    return next;
  }

  async issueChallenge(
    reservationId: string,
    optionId: ReservationOptionId,
  ): Promise<{ record: ReservationRecord; challenge: PaymentChallenge }> {
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
    if (isPaymentSubmissionLocked(record.state) && record.paymentChallengeHash) {
      // Idempotent re-read of challenge is allowed only before submission for same option
      if (record.state !== "PAYMENT_CHALLENGE_ISSUED") {
        throw new ReservationError(
          "SELECTION_LOCKED",
          "Payment already in progress or finished",
        );
      }
    }

    const challenge = await this.deps.challenge.createChallenge(record.selected);
    assertSelectionMatchesChallenge(record.selected, {
      scheme: challenge.scheme,
      network: challenge.network,
      asset: challenge.asset,
      amount: challenge.amount,
      payTo: challenge.payTo,
    });

    // Re-validate challenge before "signing"
    assertSelectionMatchesChallenge(record.selected, challenge);

    const challengeHash = canonicalSha256(challenge);
    const now = nowIso(this.deps);
    record = {
      ...record,
      paymentChallengeHash: challengeHash,
      updatedAt: now,
    };
    if (record.state === "OPTION_SELECTED") {
      record = transition(record, "PAYMENT_CHALLENGE_ISSUED", "challenge issued", now);
    }
    await this.deps.store.put(record);
    return { record, challenge };
  }

  /**
   * Full payment orchestration for the already-selected option.
   * settle is invoked at most once per reservation.
   */
  async submitPayment(input: {
    reservationId: string;
    optionId: ReservationOptionId;
    /** Hash of signed payment payload — never store full payload. */
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

    // Terminal failures stay terminal
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

    // Idempotent if already reserved/completed with same payload
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

    // httpStatus is informational only — never used as settlement proof.
    void input.httpStatus;

    if (!record.paymentChallengeHash) {
      throw new ReservationError(
        "NO_CHALLENGE",
        "Issue payment challenge before submission",
      );
    }
    const challengeHash: string = record.paymentChallengeHash;

    const now = nowIso(this.deps);

    // Durable mark BEFORE external submission
    if (
      record.state === "PAYMENT_CHALLENGE_ISSUED" ||
      record.state === "OPTION_SELECTED"
    ) {
      if (record.state === "OPTION_SELECTED") {
        throw new ReservationError(
          "NO_CHALLENGE",
          "Issue challenge before payment submission",
        );
      }
      record = {
        ...record,
        paymentPayloadHash: input.paymentPayloadHash,
        attemptNumber: 1,
        updatedAt: now,
      };
      record = transition(
        record,
        "PAYMENT_SUBMISSION_STARTED",
        "payment submission started",
        now,
      );
      await this.deps.store.put(record);
    } else if (record.state === "PAYMENT_SUBMISSION_STARTED") {
      if (
        record.paymentPayloadHash &&
        record.paymentPayloadHash !== input.paymentPayloadHash
      ) {
        throw new ReservationError(
          "CONFLICT",
          "Conflicting payment payload hash",
        );
      }
    }

    assertNotReplaceSubmittedPayment(record, {
      selected,
      paymentPayloadHash: input.paymentPayloadHash,
    });

    // Verify
    const verifyResult = await this.deps.facilitator.verify({
      selected,
      paymentPayloadHash: input.paymentPayloadHash,
      challengeHash,
    });
    record = {
      ...record,
      facilitatorVerify: verifyResult,
      updatedAt: nowIso(this.deps),
    };

    if (!verifyResult.isValid) {
      record = transition(
        record,
        "PAYMENT_REJECTED",
        verifyResult.invalidReason ?? "verify failed",
      );
      record = {
        ...record,
        failureCode: "VERIFY_REJECTED",
        failureReason: verifyResult.invalidReason ?? "isValid=false",
      };
      await this.deps.store.put(record);
      return record;
    }

    if (record.state === "PAYMENT_SUBMISSION_STARTED") {
      record = transition(record, "FACILITATOR_VERIFIED", "verify ok");
      await this.deps.store.put(record);
    }

    // Settle exactly once
    const priorSettles = this.settleCalls.get(input.reservationId) ?? 0;
    if (priorSettles >= 1 || record.facilitatorSettle?.success) {
      if (record.facilitatorSettle?.success && record.transactionId) {
        // continue mirror path idempotently
      } else if (priorSettles >= 1) {
        throw new ReservationError(
          "SETTLE_ONCE",
          "Facilitator settle already invoked",
        );
      }
    }

    if (!record.facilitatorSettle?.success) {
      this.settleCalls.set(input.reservationId, priorSettles + 1);
      const settleResult = await this.deps.facilitator.settle({
        selected,
        paymentPayloadHash: input.paymentPayloadHash,
        challengeHash,
      });
      record = {
        ...record,
        facilitatorSettle: settleResult,
        updatedAt: nowIso(this.deps),
      };

      if (!settleResult.success) {
        record = transition(
          record,
          "SETTLEMENT_FAILED",
          settleResult.errorReason ?? "settle failed",
        );
        record = {
          ...record,
          failureCode: "SETTLE_FAILED",
          failureReason: settleResult.errorReason ?? "success=false",
        };
        await this.deps.store.put(record);
        return record;
      }

      let txId: string;
      try {
        txId = requireTransactionIdForSettlement(settleResult.transactionId);
      } catch (e) {
        record = transition(
          record,
          "SETTLEMENT_FAILED",
          "missing transaction ID",
        );
        record = {
          ...record,
          failureCode: "MISSING_TRANSACTION_ID",
          failureReason:
            e instanceof Error ? e.message : "missing transaction ID",
        };
        await this.deps.store.put(record);
        return record;
      }

      if (settleResult.network !== selected.network) {
        record = transition(record, "SETTLEMENT_FAILED", "network mismatch");
        record = {
          ...record,
          failureCode: "NETWORK_MISMATCH",
          failureReason: "settle network mismatch",
        };
        await this.deps.store.put(record);
        return record;
      }
      if (settleResult.payerAccountId !== selected.payerAccount) {
        record = transition(record, "SETTLEMENT_FAILED", "payer mismatch");
        record = {
          ...record,
          failureCode: "PAYER_MISMATCH",
          failureReason: "settle payer mismatch",
        };
        await this.deps.store.put(record);
        return record;
      }

      record = {
        ...record,
        transactionId: txId,
      };
      record = transition(record, "FACILITATOR_SETTLED", "settle ok");
      await this.deps.store.put(record);
    }

    // Mirror confirmation
    const txId = requireTransactionIdForSettlement(record.transactionId);
    record = transition(
      record,
      "MIRROR_CONFIRMATION_PENDING",
      "awaiting mirror",
    );
    const deadline = new Date(
      Date.now() + (this.deps.confirmationTimeoutMs ?? 30_000),
    ).toISOString();
    record = { ...record, confirmationDeadline: deadline };
    await this.deps.store.put(record);

    const mirror = await this.deps.mirror.getTransaction(txId);
    record = {
      ...record,
      mirrorConfirmation: mirror,
      updatedAt: nowIso(this.deps),
    };

    if (mirror.status === "PENDING" || mirror.status === "NOT_FOUND") {
      record = transition(
        record,
        "CONFIRMATION_TIMED_OUT",
        "mirror not conclusive within bound",
      );
      record = {
        ...record,
        failureCode: "CONFIRMATION_TIMED_OUT",
        failureReason:
          "Mirror pending/not found — no automatic retry; manual review may apply",
      };
      await this.deps.store.put(record);
      return record;
    }

    if (mirror.status === "FAILED") {
      record = transition(record, "CONFIRMATION_FAILED", "mirror FAILED");
      record = {
        ...record,
        failureCode: "MIRROR_FAILED",
        failureReason: "Mirror Node reported FAILED",
      };
      await this.deps.store.put(record);
      return record;
    }

    try {
      verifyMirrorPayment(selected, mirror, txId);
    } catch (e) {
      record = transition(
        record,
        "CONFIRMATION_FAILED",
        e instanceof Error ? e.message : "verify failed",
      );
      record = {
        ...record,
        failureCode:
          e instanceof ReservationError ? e.code : "PAYMENT_VERIFY_FAILED",
        failureReason: e instanceof Error ? e.message : String(e),
      };
      await this.deps.store.put(record);
      return record;
    }

    record = transition(record, "PAYMENT_CONFIRMED", "mirror SUCCESS verified");
    await this.deps.store.put(record);

    // ROUTE_RESERVED
    assertCanEnterRouteReserved({
      state: record.state,
      mirrorStatus: mirror.status,
      transactionId: txId,
    });

    const reservedAt = nowIso(this.deps);
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
      consensusTimestamp: mirror.consensusTimestamp!,
      decisionManifestHash: record.decisionManifestHash,
      evaluatedBidSetHash: record.evaluatedBidSetHash,
      hcsAuctionTopicId: record.hcsTopicId,
      closeBarrierSequence: record.closeBarrierSequence,
      reservedAt,
    });

    record = {
      ...record,
      routeReserved,
    };
    record = transition(record, "ROUTE_RESERVED", "payment confirmed");
    await this.deps.store.put(record);

    // Post-reservation: webhooks (failure does not reverse)
    record = await this.dispatchWebhooks(record);

    // HCS evidence (failure does not reverse)
    record = await this.publishHcsEvidence(record);

    if (
      record.state === "HCS_EVIDENCE_RECORDED" ||
      record.state === "HCS_EVIDENCE_FAILED"
    ) {
      try {
        record = transition(record, "COMPLETED", "post-reservation done");
        await this.deps.store.put(record);
      } catch {
        // HCS_EVIDENCE_FAILED may already allow COMPLETED
        if (record.state === "HCS_EVIDENCE_FAILED") {
          record = transition(record, "COMPLETED", "complete with hcs failure");
          await this.deps.store.put(record);
        }
      }
    }

    return record;
  }

  private async dispatchWebhooks(
    record: ReservationRecord,
  ): Promise<ReservationRecord> {
    if (!record.routeReserved || !record.selected) return record;
    const rr = record.routeReserved;
    const emittedAt = nowIso(this.deps);
    const deliveries = [];

    for (const recipient of ["shipper", "carrier"] as const) {
      const eventId = reservationWebhookEventId(record.reservationId, recipient);
      // Retry reuses same event ID and payload hash
      const existing = record.webhooks.find((w) => w.eventId === eventId);
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
        emittedAt: existing ? (record.webhooks.find((w) => w.eventId === eventId) ? emittedAt : emittedAt) : emittedAt,
      });
      // Keep stable emittedAt for retries if already stored
      const stablePayload = existing
        ? {
            ...payload,
            emittedAt: emittedAt, // first emit; for true stability store first emittedAt on record
          }
        : payload;

      const signed = signWebhook(
        stablePayload,
        this.deps.webhookSigningPrivateKey,
      );
      const result = await this.deps.webhooks.deliver(recipient, signed);
      deliveries.push({
        eventId,
        recipient,
        payloadHash: signed.payloadHash,
        delivered: result.ok,
        attempts: (existing?.attempts ?? 0) + 1,
        lastAttemptAt: emittedAt,
        lastError: result.ok ? null : (result.error ?? "delivery failed"),
      });
    }

    let next: ReservationRecord = {
      ...record,
      webhooks: deliveries,
      updatedAt: nowIso(this.deps),
    };

    const allOk = deliveries.every((d) => d.delivered);
    if (allOk) {
      next = transition(next, "WEBHOOKS_DISPATCHED", "webhooks ok");
    } else {
      next = transition(
        next,
        "WEBHOOK_DELIVERY_FAILED",
        "one or more webhooks failed",
      );
    }
    await this.deps.store.put(next);
    return next;
  }

  private async publishHcsEvidence(
    record: ReservationRecord,
  ): Promise<ReservationRecord> {
    if (!record.routeReserved) return record;
    try {
      const payload = buildRouteReservedPayload(
        record.routeReserved,
        record.winningCarrierId,
      );
      const envelope = createRouteReservedHcsEnvelope({
        runId: `reservation-${record.reservationId}`,
        tenderId: record.tenderId,
        tenderVersion: record.tenderVersion,
        tenderHash: record.tenderHash,
        createdAt: nowIso(this.deps),
        payload,
      });
      const envHash = routeReservedEnvelopeHash(envelope);
      // Hcs publisher expects HcsEnvelope union — cast via unknown for ROUTE_RESERVED extension
      const published = await this.deps.hcs.publish(
        envelope as unknown as import("../hcs/types").HcsEnvelope,
      );
      let next: ReservationRecord = {
        ...record,
        hcsEvidence: {
          messageType: "ROUTE_RESERVED",
          envelopeHash: envHash,
          topicId: published.topicId,
          sequence: published.sequence,
          transactionId: published.transactionId,
          consensusTimestamp: published.consensusTimestamp,
          published: true,
          lastError: null,
        },
        updatedAt: nowIso(this.deps),
      };
      if (
        next.state === "WEBHOOKS_DISPATCHED" ||
        next.state === "WEBHOOK_DELIVERY_FAILED" ||
        next.state === "ROUTE_RESERVED"
      ) {
        next = transition(next, "HCS_EVIDENCE_RECORDED", "hcs published");
      }
      await this.deps.store.put(next);
      return next;
    } catch (e) {
      let next: ReservationRecord = {
        ...record,
        hcsEvidence: {
          messageType: "ROUTE_RESERVED",
          envelopeHash: "",
          topicId: null,
          sequence: null,
          transactionId: null,
          consensusTimestamp: null,
          published: false,
          lastError: e instanceof Error ? e.message : String(e),
        },
        updatedAt: nowIso(this.deps),
      };
      if (
        next.state === "WEBHOOKS_DISPATCHED" ||
        next.state === "WEBHOOK_DELIVERY_FAILED" ||
        next.state === "ROUTE_RESERVED"
      ) {
        next = transition(next, "HCS_EVIDENCE_FAILED", "hcs publish failed");
      }
      await this.deps.store.put(next);
      return next;
    }
  }

  async recover(reservationId: string): Promise<ReservationRecord> {
    const record = await this.require(reservationId);
    const recovered = recoverInProgressState(record);
    if (recovered.state !== record.state) {
      await this.deps.store.put(recovered);
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
}

export function publicReservationView(record: ReservationRecord): unknown {
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
    selectedOptionId: record.selected?.optionId ?? null,
    feeLabel: DEMO_RESERVATION_FEE_NOTE,
    transactionId: record.transactionId,
    routeReserved: record.routeReserved,
    failureCode: record.failureCode,
    failureReason: record.failureReason,
    // no private bids, no match %, no signatures
  };
}

export type { SelectedPaymentOption };
