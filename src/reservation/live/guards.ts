/**
 * Process-scoped live-execution guards for Phase 6B.
 * Multiple independent flags + exact confirmation phrase required.
 */

import { Phase6bAttemptError } from "./attempt-store";
import { CONFIRM_PHASE6B_RESERVATION_VALUE } from "./constants";

export type Phase6bLiveGuardInput = {
  enableLiveReservation?: string | undefined;
  enableLiveHedera?: string | undefined;
  enableLiveUsdcPayments?: string | undefined;
  enableLiveHcsWrites?: string | undefined;
  confirmPhase6bReservation?: string | undefined;
};

/**
 * Live execution requires ALL of:
 * - ENABLE_LIVE_RESERVATION=true (process-scoped Phase 6B flag)
 * - ENABLE_LIVE_HEDERA=true
 * - ENABLE_LIVE_USDC_PAYMENTS=true (payment-write)
 * - ENABLE_LIVE_HCS_WRITES=true
 * - CONFIRM_PHASE6B_RESERVATION=EXECUTE_ONE_USDC_ROUTE_RESERVATION
 */
export function assertPhase6bLiveExecutionAuthorized(
  env: Phase6bLiveGuardInput = {
    enableLiveReservation: process.env.ENABLE_LIVE_RESERVATION,
    enableLiveHedera: process.env.ENABLE_LIVE_HEDERA,
    enableLiveUsdcPayments: process.env.ENABLE_LIVE_USDC_PAYMENTS,
    enableLiveHcsWrites: process.env.ENABLE_LIVE_HCS_WRITES,
    confirmPhase6bReservation: process.env.CONFIRM_PHASE6B_RESERVATION,
  },
): void {
  if (env.enableLiveReservation !== "true") {
    throw new Phase6bAttemptError(
      "Live reservation disabled: set ENABLE_LIVE_RESERVATION=true (process-scoped)",
      "LIVE_RESERVATION_FLAG_REQUIRED",
    );
  }
  if (env.enableLiveHedera !== "true") {
    throw new Phase6bAttemptError(
      "Live reservation disabled: set ENABLE_LIVE_HEDERA=true",
      "LIVE_HEDERA_FLAG_REQUIRED",
    );
  }
  if (env.enableLiveUsdcPayments !== "true") {
    throw new Phase6bAttemptError(
      "Live reservation disabled: set ENABLE_LIVE_USDC_PAYMENTS=true",
      "LIVE_PAYMENT_WRITE_FLAG_REQUIRED",
    );
  }
  if (env.enableLiveHcsWrites !== "true") {
    throw new Phase6bAttemptError(
      "Live reservation disabled: set ENABLE_LIVE_HCS_WRITES=true",
      "LIVE_HCS_WRITE_FLAG_REQUIRED",
    );
  }
  if (env.confirmPhase6bReservation !== CONFIRM_PHASE6B_RESERVATION_VALUE) {
    throw new Phase6bAttemptError(
      `Live reservation disabled: CONFIRM_PHASE6B_RESERVATION must be exactly ${CONFIRM_PHASE6B_RESERVATION_VALUE}`,
      "CONFIRMATION_PHRASE_REQUIRED",
    );
  }
}

export function isPhase6bDryRun(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    assertPhase6bLiveExecutionAuthorized({
      enableLiveReservation: env.ENABLE_LIVE_RESERVATION,
      enableLiveHedera: env.ENABLE_LIVE_HEDERA,
      enableLiveUsdcPayments: env.ENABLE_LIVE_USDC_PAYMENTS,
      enableLiveHcsWrites: env.ENABLE_LIVE_HCS_WRITES,
      confirmPhase6bReservation: env.CONFIRM_PHASE6B_RESERVATION,
    });
    return false;
  } catch {
    return true;
  }
}
