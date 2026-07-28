/**
 * F-006 — fresh USDC readiness immediately before payment payload creation.
 * A readiness that passes at start-of-run but fails just before signing must
 * abort before any signature or settlement, leaving no reservation.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runFinalDemoOrchestration } from "../src/final-demo/orchestration";
import { createFinalDemoDryRunTransports } from "../src/final-demo/dry-transports";
import { FINAL_DEMO_MODE_DRY } from "../src/final-demo/constants";
import {
  offlineUsdcReadinessPass,
} from "../src/final-demo/usdc-readiness";
import type { UsdcReadinessResult } from "../src/final-demo/transports";

const FAIL: UsdcReadinessResult = {
  ok: false,
  tokenId: "0.0.429274",
  payerAccountId: "0.0.9197513",
  receiverAccountId: "0.0.9215954",
  payerAssociated: false,
  payerBalanceAtomic: "0",
  receiverUsable: false,
  reasons: ["payer is not associated with USDC"],
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rg-f006-"));
  dirs.push(dir);
  return dir;
}

describe("F-006 fresh USDC readiness before signing", () => {
  it("passes at start then fails at the pre-signing gate → no settle, no reservation", async () => {
    const t = createFinalDemoDryRunTransports({
      clockMs: Date.parse("2026-07-19T12:00:00.000Z"),
    });
    let calls = 0;
    await expect(
      runFinalDemoOrchestration({
        mode: FINAL_DEMO_MODE_DRY,
        clock: t.clock,
        workDir: tempDir(),
        prepBufferSeconds: 0,
        topicTransport: t.topicTransport,
        hcsTransport: t.hcsTransport,
        topicMirrorReader: t.topicMirrorReader,
        paymentPayloadFactory: t.paymentPayloadFactory,
        facilitatorTransport: t.facilitatorTransport,
        paymentMirrorTransport: t.paymentMirrorTransport,
        webhookTransport: t.webhookTransport,
        readiness: {
          secretScan: () => {},
          usdcReadiness: async () => {
            calls += 1;
            // First call (start-of-run) passes; second (pre-signing) fails.
            return calls === 1 ? offlineUsdcReadinessPass() : FAIL;
          },
        },
      }),
    ).rejects.toThrow(/USDC readiness failed/i);

    // The pre-signing check ran (≥ 2 calls) and blocked before settlement.
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(t.facilitatorTransport.settleCallCount).toBe(0);
    expect(t.facilitatorTransport.verifyCallCount).toBe(0);
  });

  it("stable readiness completes the dry run with exactly one settle", async () => {
    const t = createFinalDemoDryRunTransports({
      clockMs: Date.parse("2026-07-19T12:00:00.000Z"),
    });
    const result = await runFinalDemoOrchestration({
      mode: FINAL_DEMO_MODE_DRY,
      clock: t.clock,
      workDir: tempDir(),
      prepBufferSeconds: 0,
      topicTransport: t.topicTransport,
      hcsTransport: t.hcsTransport,
      topicMirrorReader: t.topicMirrorReader,
      paymentPayloadFactory: t.paymentPayloadFactory,
      facilitatorTransport: t.facilitatorTransport,
      paymentMirrorTransport: t.paymentMirrorTransport,
      webhookTransport: t.webhookTransport,
      readiness: {
        secretScan: () => {},
        usdcReadiness: async () => offlineUsdcReadinessPass(),
      },
    });
    expect(result.reservation?.routeReserved).not.toBeNull();
    expect(t.facilitatorTransport.settleCallCount).toBe(1);
  });
});
