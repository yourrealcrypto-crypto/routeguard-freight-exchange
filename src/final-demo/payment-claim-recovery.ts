/**
 * Safe recovery for a pre-submission payment claim.
 *
 * The live final-demo can reach:
 *   attempt.status = PAYMENT_SUBMISSION_CLAIMED
 *   paymentSubmissionClaim.status = CLAIMED
 *   paymentSubmissionClaim.transactionId = null
 *
 * when the outer claim is written before payment construction completes, and
 * construction then fails (e.g. x402 `extensions: undefined` vs strict
 * canonicalize). In that exact pre-submission state nothing was client-frozen
 * for submission, transmitted, verified, or settled — so the claim may be
 * cleared by a validated recovery transition and payment construction may
 * resume once, reusing the existing topic and HCS sequences 1–4.
 *
 * Any persisted transaction identity, payload hash, settle claim, facilitator
 * result, or mid-payment reservation state fails closed (not this path).
 */

import type { FinalDemoAttemptRecord } from "./attempt-store";
import { withFinalDemoAttemptUpdate } from "./attempt-store";
import { FinalDemoError } from "./errors";
import type { ReservationRecord } from "../reservation/types";

/** Minimal reservation view required to prove pre-submission emptiness. */
export type PreSubmissionReservationView = Pick<
  ReservationRecord,
  | "state"
  | "paymentPayloadHash"
  | "clientTransaction"
  | "settleClaim"
  | "facilitatorSettle"
  | "facilitatorVerify"
  | "transactionId"
  | "mirrorConfirmation"
  | "routeReserved"
>;

/**
 * True only when the durable attempt + reservation prove that no payment was
 * built for submission, signed identity persisted, transmitted, verified, or
 * settled. Fail closed on any doubt.
 */
export function isSafePreSubmissionPaymentClaim(
  attempt: FinalDemoAttemptRecord,
  reservation: PreSubmissionReservationView,
): boolean {
  // Durable claim fields are authoritative. Attempt `status` may have been
  // advanced by resume re-walk of mirror/proof (e.g. PROOF_RECONSTRUCTED)
  // even while the outer payment claim remains CLAIMED with no tx identity.
  if (attempt.paymentSubmissionClaim.status !== "CLAIMED") return false;
  if (attempt.paymentSubmissionClaim.transactionId) return false;

  if (reservation.state !== "PAYMENT_CHALLENGE_ISSUED") return false;
  if (reservation.paymentPayloadHash) return false;
  if (reservation.clientTransaction) return false;
  if (reservation.settleClaim) return false;
  if (reservation.facilitatorSettle) return false;
  if (reservation.facilitatorVerify) return false;
  if (reservation.transactionId) return false;
  if (reservation.mirrorConfirmation) return false;
  if (reservation.routeReserved) return false;

  // Sequence 5 must still be unclaimed; sequences 1–4 should already be confirmed
  // for a normal resume, but this guard only blocks if seq 5 has progressed.
  const seq5 = attempt.messageOutbox.find(
    (m) => m.logicalLabel === "ROUTE_RESERVED",
  );
  if (
    seq5 &&
    (seq5.status === "CLAIMED" ||
      seq5.status === "SUBMITTED" ||
      seq5.status === "CONFIRMED" ||
      seq5.status === "AMBIGUOUS" ||
      seq5.transactionId ||
      seq5.sequence != null)
  ) {
    return false;
  }

  return true;
}

/**
 * Validated recovery transition: clear a proven pre-submission claim so the
 * orchestrator may construct (and claim) payment exactly once more.
 *
 * Throws if the state is not the safe pre-submission case — never clears by hand
 * without this check.
 */
export function clearSafePreSubmissionPaymentClaim(
  attempt: FinalDemoAttemptRecord,
  reservation: PreSubmissionReservationView,
): FinalDemoAttemptRecord {
  if (!isSafePreSubmissionPaymentClaim(attempt, reservation)) {
    throw new FinalDemoError(
      "Cannot clear payment claim — not a proven pre-submission state",
      "PAYMENT_CLAIM_CLEAR_FORBIDDEN",
    );
  }
  return withFinalDemoAttemptUpdate(attempt, {
    status: "PAYMENT_READY",
    paymentSubmissionClaim: {
      claimedAt: null,
      claimId: null,
      status: "NONE",
      transactionId: null,
    },
    failureCode: null,
    failureReason: null,
  });
}
