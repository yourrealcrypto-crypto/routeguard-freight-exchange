/**
 * Live execution guards for final demo.
 * Multiple independent flags + final-demo-specific phrase required.
 */

import { CONFIRM_FINAL_DEMO_VALUE } from "./constants";
import { FinalDemoError } from "./errors";

export type FinalDemoLiveGuardInput = {
  enableFinalDemoLive?: string | undefined;
  enableLiveHedera?: string | undefined;
  enableLiveUsdcPayments?: string | undefined;
  enableLiveHcsWrites?: string | undefined;
  enableLiveTopicCreate?: string | undefined;
  enablePhase6bLiveExecute?: string | undefined;
  confirmFinalDemo?: string | undefined;
};

/**
 * Live final demo requires ALL of:
 * - ENABLE_FINAL_DEMO_LIVE=true
 * - ENABLE_LIVE_HEDERA=true
 * - ENABLE_LIVE_USDC_PAYMENTS=true
 * - ENABLE_LIVE_HCS_WRITES=true
 * - ENABLE_LIVE_TOPIC_CREATE=true
 * - ENABLE_PHASE6B_LIVE_EXECUTE=true
 * - CONFIRM_FINAL_DEMO=CREATE_NEW_TOPIC_AND_EXECUTE_ONE_USDC_RESERVATION
 *
 * The confirmation phrase alone is never sufficient.
 */
export function assertFinalDemoLiveAuthorized(
  env: FinalDemoLiveGuardInput = {
    enableFinalDemoLive: process.env.ENABLE_FINAL_DEMO_LIVE,
    enableLiveHedera: process.env.ENABLE_LIVE_HEDERA,
    enableLiveUsdcPayments: process.env.ENABLE_LIVE_USDC_PAYMENTS,
    enableLiveHcsWrites: process.env.ENABLE_LIVE_HCS_WRITES,
    enableLiveTopicCreate: process.env.ENABLE_LIVE_TOPIC_CREATE,
    enablePhase6bLiveExecute: process.env.ENABLE_PHASE6B_LIVE_EXECUTE,
    confirmFinalDemo: process.env.CONFIRM_FINAL_DEMO,
  },
): void {
  if (env.enableFinalDemoLive !== "true") {
    throw new FinalDemoError(
      "Live final demo disabled: set ENABLE_FINAL_DEMO_LIVE=true",
      "FINAL_DEMO_LIVE_FLAG_REQUIRED",
    );
  }
  if (env.enableLiveHedera !== "true") {
    throw new FinalDemoError(
      "Live final demo disabled: set ENABLE_LIVE_HEDERA=true",
      "LIVE_HEDERA_FLAG_REQUIRED",
    );
  }
  if (env.enableLiveUsdcPayments !== "true") {
    throw new FinalDemoError(
      "Live final demo disabled: set ENABLE_LIVE_USDC_PAYMENTS=true",
      "LIVE_PAYMENT_WRITE_FLAG_REQUIRED",
    );
  }
  if (env.enableLiveHcsWrites !== "true") {
    throw new FinalDemoError(
      "Live final demo disabled: set ENABLE_LIVE_HCS_WRITES=true",
      "LIVE_HCS_WRITE_FLAG_REQUIRED",
    );
  }
  if (env.enableLiveTopicCreate !== "true") {
    throw new FinalDemoError(
      "Live final demo disabled: set ENABLE_LIVE_TOPIC_CREATE=true",
      "LIVE_TOPIC_CREATE_FLAG_REQUIRED",
    );
  }
  if (env.enablePhase6bLiveExecute !== "true") {
    throw new FinalDemoError(
      "Live final demo disabled: set ENABLE_PHASE6B_LIVE_EXECUTE=true",
      "PHASE6B_LIVE_EXECUTE_FLAG_REQUIRED",
    );
  }
  if (env.confirmFinalDemo !== CONFIRM_FINAL_DEMO_VALUE) {
    throw new FinalDemoError(
      `Live final demo disabled: CONFIRM_FINAL_DEMO must be exactly ${CONFIRM_FINAL_DEMO_VALUE}`,
      "CONFIRMATION_PHRASE_REQUIRED",
    );
  }
}

export function isFinalDemoDryRun(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    assertFinalDemoLiveAuthorized({
      enableFinalDemoLive: env.ENABLE_FINAL_DEMO_LIVE,
      enableLiveHedera: env.ENABLE_LIVE_HEDERA,
      enableLiveUsdcPayments: env.ENABLE_LIVE_USDC_PAYMENTS,
      enableLiveHcsWrites: env.ENABLE_LIVE_HCS_WRITES,
      enableLiveTopicCreate: env.ENABLE_LIVE_TOPIC_CREATE,
      enablePhase6bLiveExecute: env.ENABLE_PHASE6B_LIVE_EXECUTE,
      confirmFinalDemo: env.CONFIRM_FINAL_DEMO,
    });
    return false;
  } catch {
    return true;
  }
}
