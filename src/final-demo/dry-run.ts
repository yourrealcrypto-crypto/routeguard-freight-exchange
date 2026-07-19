/**
 * Final-demo offline dry-run — zero network writes.
 * Uses the shared orchestration engine with mocked transports.
 * Payment settlement goes through ReservationService (not mockPaymentSettle).
 */

import {
  FINAL_DEMO_MODE_DRY,
  type FinalDemoMessageLabel,
} from "./constants";
import {
  runFinalDemoOrchestration,
  type FinalDemoOrchestrationResult,
} from "./orchestration";
import { createFinalDemoDryRunTransports } from "./dry-transports";
import { offlineUsdcReadinessPass } from "./usdc-readiness";
import { assertSecretScanPass } from "./secret-scan";

export type FinalDemoDryRunResult = FinalDemoOrchestrationResult & {
  mode: typeof FINAL_DEMO_MODE_DRY;
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

/**
 * Offline dry-run entry. Same orchestration algorithm as live.
 */
export async function runFinalDemoDryRun(
  deps: FinalDemoDryRunDeps = {},
): Promise<FinalDemoDryRunResult> {
  const transports = createFinalDemoDryRunTransports(
    deps.runBaseTime
      ? { clockMs: Date.parse(deps.runBaseTime) }
      : undefined,
  );

  if (deps.runBaseTime) {
    transports.clock.setClockMs?.(Date.parse(deps.runBaseTime));
  }

  const result = await runFinalDemoOrchestration({
    mode: FINAL_DEMO_MODE_DRY,
    clock: transports.clock,
    ...(deps.workDir !== undefined ? { workDir: deps.workDir } : {}),
    ...(deps.templatePath !== undefined
      ? { templatePath: deps.templatePath }
      : {}),
    ...(deps.runBaseTime !== undefined ? { runBaseTime: deps.runBaseTime } : {}),
    ...(deps.auctionWindowSeconds !== undefined
      ? { auctionWindowSeconds: deps.auctionWindowSeconds }
      : {}),
    // Dry-run tests use prepBuffer 0 so auction opens at runBaseTime.
    prepBufferSeconds: 0,
    topicTransport: transports.topicTransport,
    hcsTransport: transports.hcsTransport,
    topicMirrorReader: transports.topicMirrorReader,
    paymentPayloadFactory: transports.paymentPayloadFactory,
    facilitatorTransport: transports.facilitatorTransport,
    paymentMirrorTransport: transports.paymentMirrorTransport,
    webhookTransport: transports.webhookTransport,
    readiness: {
      secretScan: () => {
        if (!deps.skipSecretScan) {
          assertSecretScanPass({ rootDir: process.cwd() });
        }
      },
      usdcReadiness: async () => offlineUsdcReadinessPass(),
    },
    confirmationTimeoutMs: 2_000,
    mirrorPollIntervalMs: 10,
  });

  return result as FinalDemoDryRunResult;
}

/** @deprecated Prefer orchestration result type. */
export type { FinalDemoMessageLabel };
