/**
 * Durable reservation state machine — illegal transitions throw.
 */

import {
  POST_RESERVATION_STATES,
  ReservationError,
  TERMINAL_PAYMENT_FAILURE_STATES,
  type ReservationState,
} from "./types";

export class IllegalReservationTransitionError extends Error {
  constructor(
    public readonly from: ReservationState,
    public readonly to: ReservationState,
    message?: string,
  ) {
    super(message ?? `Illegal reservation transition: ${from} → ${to}`);
    this.name = "IllegalReservationTransitionError";
  }
}

const LEGAL: ReadonlyMap<ReservationState, readonly ReservationState[]> =
  new Map([
    ["OFFER_CREATED", ["OPTION_SELECTED", "EXPIRED"]],
    [
      "OPTION_SELECTED",
      ["PAYMENT_CHALLENGE_ISSUED", "EXPIRED"],
    ],
    [
      "PAYMENT_CHALLENGE_ISSUED",
      ["PAYMENT_SUBMISSION_STARTED", "EXPIRED", "PAYMENT_REJECTED"],
    ],
    [
      "PAYMENT_SUBMISSION_STARTED",
      [
        "FACILITATOR_VERIFIED",
        "PAYMENT_REJECTED",
        "SETTLEMENT_FAILED",
        "MANUAL_REVIEW_REQUIRED",
      ],
    ],
    [
      "FACILITATOR_VERIFIED",
      [
        "FACILITATOR_SETTLE_CLAIMED",
        "SETTLEMENT_FAILED",
        "MANUAL_REVIEW_REQUIRED",
      ],
    ],
    [
      "FACILITATOR_SETTLE_CLAIMED",
      [
        "FACILITATOR_SETTLED",
        "SETTLEMENT_FAILED",
        "MANUAL_REVIEW_REQUIRED",
      ],
    ],
    [
      "FACILITATOR_SETTLED",
      ["MIRROR_CONFIRMATION_PENDING"],
    ],
    [
      "MIRROR_CONFIRMATION_PENDING",
      [
        "PAYMENT_CONFIRMED",
        "CONFIRMATION_TIMED_OUT",
        "CONFIRMATION_FAILED",
        "MANUAL_REVIEW_REQUIRED",
      ],
    ],
    ["PAYMENT_CONFIRMED", ["ROUTE_RESERVED"]],
    [
      "ROUTE_RESERVED",
      [
        "WEBHOOKS_DISPATCHED",
        "WEBHOOK_DELIVERY_FAILED",
        "HCS_EVIDENCE_RECORDED",
        "HCS_EVIDENCE_FAILED",
      ],
    ],
    [
      "WEBHOOKS_DISPATCHED",
      ["HCS_EVIDENCE_RECORDED", "HCS_EVIDENCE_FAILED"],
    ],
    [
      "WEBHOOK_DELIVERY_FAILED",
      [
        "WEBHOOKS_DISPATCHED",
        "HCS_EVIDENCE_RECORDED",
        "HCS_EVIDENCE_FAILED",
      ],
    ],
    [
      "HCS_EVIDENCE_RECORDED",
      ["COMPLETED"],
    ],
    [
      "HCS_EVIDENCE_FAILED",
      ["HCS_EVIDENCE_RECORDED", "COMPLETED"],
    ],
    ["COMPLETED", []],
    // Guarded replacement only — see SETTLEMENT_FAILED note below. Applies to
    // pre-verify conclusive failures classified as PAYMENT_REJECTED.
    ["PAYMENT_REJECTED", ["OFFER_CREATED"]],
    // Guarded replacement only (v1.5 §23.2): after the deterministic
    // conclusive-failure rule concludes (exact lookup empty AND
    // validStart + validDuration + 60 s elapsed), a fresh attempt may be
    // authorized. No other exit exists.
    ["SETTLEMENT_FAILED", ["OFFER_CREATED"]],
    // Guarded recovery only (F-001): a settled payment whose Mirror confirmation
    // exceeded the bounded window may re-enter confirmation for the SAME
    // transaction, or be routed to manual review. No other exit exists.
    [
      "CONFIRMATION_TIMED_OUT",
      ["MIRROR_CONFIRMATION_PENDING", "MANUAL_REVIEW_REQUIRED"],
    ],
    ["CONFIRMATION_FAILED", []],
    ["EXPIRED", []],
    ["MANUAL_REVIEW_REQUIRED", []],
  ]);

/**
 * Terminal-state exits permitted ONLY through dedicated guarded recovery code
 * paths (never through submitPayment). Each entry is "<from>→<to>".
 */
const GUARDED_RECOVERY_TRANSITIONS: ReadonlySet<string> = new Set([
  "CONFIRMATION_TIMED_OUT→MIRROR_CONFIRMATION_PENDING",
  "CONFIRMATION_TIMED_OUT→MANUAL_REVIEW_REQUIRED",
  // v1.5 §23.2 replacement attempt — service-enforced: only after the
  // deterministic conclusive-failure rule marked the attempt CONCLUSIVELY_FAILED.
  "SETTLEMENT_FAILED→OFFER_CREATED",
  "PAYMENT_REJECTED→OFFER_CREATED",
]);

export function assertLegalTransition(
  from: ReservationState,
  to: ReservationState,
): void {
  if (from === to) {
    return; // idempotent no-op
  }
  const allowed = LEGAL.get(from) ?? [];
  if (!allowed.includes(to)) {
    throw new IllegalReservationTransitionError(from, to);
  }

  // Never reverse ROUTE_RESERVED into pre-reservation payment states
  if (
    POST_RESERVATION_STATES.has(from) &&
    !POST_RESERVATION_STATES.has(to) &&
    to !== "COMPLETED"
  ) {
    // HCS_EVIDENCE_FAILED and WEBHOOK_DELIVERY_FAILED are post-reservation
    if (!POST_RESERVATION_STATES.has(to)) {
      throw new IllegalReservationTransitionError(
        from,
        to,
        "Cannot reverse ROUTE_RESERVED",
      );
    }
  }

  // Terminal payment failures cannot transition to alternate asset attempts.
  // The single exception is the guarded same-transaction confirmation recovery.
  if (
    TERMINAL_PAYMENT_FAILURE_STATES.has(from) &&
    from !== to &&
    !GUARDED_RECOVERY_TRANSITIONS.has(`${from}→${to}`)
  ) {
    throw new IllegalReservationTransitionError(
      from,
      to,
      "Terminal payment failure cannot transition",
    );
  }
}

export function isTerminalPaymentFailure(state: ReservationState): boolean {
  return TERMINAL_PAYMENT_FAILURE_STATES.has(state);
}

export function isPostReservation(state: ReservationState): boolean {
  return POST_RESERVATION_STATES.has(state);
}

/** States where payment submission has begun — selection locked. */
export function isPaymentSubmissionLocked(state: ReservationState): boolean {
  if (state === "PAYMENT_SUBMISSION_STARTED") return true;
  if (state === "FACILITATOR_VERIFIED") return true;
  if (state === "FACILITATOR_SETTLE_CLAIMED") return true;
  if (state === "FACILITATOR_SETTLED") return true;
  if (state === "MIRROR_CONFIRMATION_PENDING") return true;
  if (state === "PAYMENT_CONFIRMED") return true;
  if (POST_RESERVATION_STATES.has(state)) return true;
  if (TERMINAL_PAYMENT_FAILURE_STATES.has(state) && state !== "EXPIRED") {
    return true;
  }
  return false;
}

export function requireTransactionIdForSettlement(
  transactionId: string | null | undefined,
): string {
  if (!transactionId || typeof transactionId !== "string" || !transactionId.trim()) {
    throw new ReservationError(
      "MISSING_TRANSACTION_ID",
      "Settlement requires an authoritative transaction ID",
    );
  }
  return transactionId.trim();
}

export function assertCanEnterRouteReserved(input: {
  state: ReservationState;
  mirrorStatus: string | null | undefined;
  transactionId: string | null | undefined;
}): void {
  if (input.state !== "PAYMENT_CONFIRMED") {
    throw new ReservationError(
      "ILLEGAL_TRANSITION",
      "ROUTE_RESERVED requires PAYMENT_CONFIRMED",
    );
  }
  if (input.mirrorStatus !== "SUCCESS") {
    throw new ReservationError(
      "MIRROR_NOT_SUCCESS",
      "ROUTE_RESERVED requires Mirror Node SUCCESS",
    );
  }
  requireTransactionIdForSettlement(input.transactionId);
}
