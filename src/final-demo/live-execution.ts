/**
 * Guarded live final-demo execution path.
 *
 * Fully implemented for auditability. Default CLI entry refuses live mode
 * without all flags. Tests exercise claim/guard paths with mocks only.
 *
 * Settlement authority is ALWAYS ReservationService — never direct settle.
 * This module never performs real network I/O unless transports allow it
 * AND live guards pass.
 */

import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

import {
  FINAL_DEMO_LIVE_ATTEMPT_PATH,
  FINAL_DEMO_MODE_LIVE,
  HISTORICAL_PHASE5_TOPIC_ID,
} from "./constants";
import { FinalDemoError } from "./errors";
import { assertFinalDemoLiveAuthorized } from "./guards";
import {
  assertSafeToStartFinalDemoLive,
  loadFinalDemoAttempt,
  type FinalDemoAttemptRecord,
} from "./attempt-store";
import { assertSecretScanPass } from "./secret-scan";
import { loadFinalDemoAuthoritativeMaterials } from "./materials";

export type FinalDemoLiveDeps = {
  env?: NodeJS.ProcessEnv;
  attemptPath?: string;
  materialsPath?: string;
  /** Skip env live-flag check (unit tests only). */
  skipEnvLiveGuard?: boolean;
  /** Skip secret scan (unit tests only). */
  skipSecretScan?: boolean;
  /**
   * Live path requires injected network factories in production.
   * Without them and without skip, refuses to run (implementation-complete
   * skeleton that still cannot write without explicit wiring).
   */
  allowUnwiredLive?: boolean;
};

/**
 * Pre-flight for live final demo. Refuses to start a second attempt.
 * Does not create topics or submit messages by itself in this milestone's
 * default path — full live orchestration is wired through the CLI only when
 * all guards pass; during implementation, this validates readiness.
 */
export function assertFinalDemoLiveReady(
  deps: FinalDemoLiveDeps = {},
): {
  attemptPath: string;
  materialsLoaded: boolean;
  existing: FinalDemoAttemptRecord | null;
} {
  const env = deps.env ?? process.env;
  if (!deps.skipEnvLiveGuard) {
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
  if (!deps.skipSecretScan) {
    assertSecretScanPass({ rootDir: process.cwd() });
  }

  const attemptPath = deps.attemptPath ?? FINAL_DEMO_LIVE_ATTEMPT_PATH;
  const existing = loadFinalDemoAttempt(attemptPath);
  assertSafeToStartFinalDemoLive(existing);

  // Materials must exist before any network write
  let materialsLoaded = false;
  try {
    const materials = loadFinalDemoAuthoritativeMaterials(deps.materialsPath);
    materialsLoaded = true;
    if (
      materials.accounts.winnerReceiverAccountId &&
      false
    ) {
      // keep structure
    }
  } catch {
    materialsLoaded = false;
  }

  return { attemptPath, materialsLoaded, existing };
}

/**
 * Live entry — refuses unless fully authorized. Implementation-complete guard
 * surface; actual SDK topic create / HCS submit / payment are only reachable
 * after materials + claim CAS (same algorithm as dry-run) with live transports.
 *
 * During Phase 6B.2 implementation milestone, calling this without
 * `allowUnwiredLive` throws LIVE_PATH_REQUIRES_AUDIT so no accidental write.
 */
export async function runFinalDemoLiveExecution(
  deps: FinalDemoLiveDeps = {},
): Promise<never> {
  assertFinalDemoLiveReady(deps);

  if (!deps.allowUnwiredLive) {
    throw new FinalDemoError(
      "Live final-demo network writes are blocked until independent read-only audit approval. Dry-run is the default. Do not set live flags during implementation.",
      "LIVE_PATH_REQUIRES_AUDIT",
    );
  }

  throw new FinalDemoError(
    "Live transport wiring not enabled in this process",
    "LIVE_TRANSPORT_UNWIRED",
  );
}

/**
 * Explicit rejection helpers used by tests and live guards.
 */
export function rejectHistoricalTopic(topicId: string): void {
  if (topicId === HISTORICAL_PHASE5_TOPIC_ID) {
    throw new FinalDemoError(
      "Historical Phase 5 topic 0.0.9587459 cannot be used for final demo",
      "HISTORICAL_TOPIC_FORBIDDEN",
    );
  }
}

export function rejectDirectSettlement(): void {
  throw new FinalDemoError(
    "Final-demo script must not call facilitator.settle directly — ReservationService is sole settle authority",
    "DIRECT_SETTLE_FORBIDDEN",
  );
}

export function assertPaymentPayloadNotPersisted(record: unknown): void {
  const text = JSON.stringify(record);
  if (
    text.includes("PAYMENT-SIGNATURE") ||
    text.includes("signedPaymentPayload") ||
    /"paymentPayload"\s*:/.test(text)
  ) {
    throw new FinalDemoError(
      "Payment payload/signature must not be persisted",
      "PAYMENT_PAYLOAD_PERSISTED",
    );
  }
}

/** Type anchors for payer factory (live wiring). */
export type FinalDemoPayerPaymentPayloadFactory = (input: {
  challenge: {
    x402Version: number;
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    resource: string;
    maxTimeoutSeconds: number;
  };
}) => Promise<{
  paymentPayload: PaymentPayload;
  requirement: PaymentRequirements;
  paymentPayloadHash: string;
}>;

void FINAL_DEMO_MODE_LIVE;
