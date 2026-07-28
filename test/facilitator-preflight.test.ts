/**
 * F-002 — facilitator capability preflight (v1.5 §17).
 * Pure validation + fetch behavior + orchestration wiring: a failing preflight
 * produces zero topic creates, zero HCS submissions, zero payment actions.
 */

import { describe, expect, it } from "vitest";

import {
  assertFacilitatorCapability,
  checkFacilitatorPreflight,
} from "../src/final-demo/facilitator-preflight";
import { FinalDemoError } from "../src/final-demo/errors";
import { runFinalDemoOrchestration } from "../src/final-demo/orchestration";
import { createFinalDemoDryRunTransports } from "../src/final-demo/dry-transports";
import { FINAL_DEMO_MODE_DRY } from "../src/final-demo/constants";

const GOOD = {
  kinds: [
    { x402Version: 2, scheme: "exact", network: "eip155:80002" },
    {
      x402Version: 2,
      scheme: "exact",
      network: "hedera:testnet",
      extra: { feePayer: "0.0.7162784" },
    },
  ],
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("F-002 facilitator capability preflight — pure validation", () => {
  it("accepts a well-formed Hedera capability with the expected fee payer", () => {
    const cap = assertFacilitatorCapability(GOOD);
    expect(cap).toEqual({
      x402Version: 2,
      scheme: "exact",
      network: "hedera:testnet",
      feePayer: "0.0.7162784",
    });
  });

  it("rejects missing hedera:testnet exact v2 kind", () => {
    expect(() =>
      assertFacilitatorCapability({
        kinds: [{ x402Version: 2, scheme: "exact", network: "solana:x" }],
      }),
    ).toThrow(/does not advertise/i);
  });

  it("rejects wrong x402 version / scheme", () => {
    expect(() =>
      assertFacilitatorCapability({
        kinds: [
          { x402Version: 1, scheme: "exact", network: "hedera:testnet", extra: { feePayer: "0.0.1" } },
        ],
      }),
    ).toThrow(/does not advertise/i);
  });

  it("rejects missing / malformed fee payer", () => {
    expect(() =>
      assertFacilitatorCapability({
        kinds: [{ x402Version: 2, scheme: "exact", network: "hedera:testnet" }],
      }),
    ).toThrow(/fee payer/i);
    expect(() =>
      assertFacilitatorCapability({
        kinds: [
          { x402Version: 2, scheme: "exact", network: "hedera:testnet", extra: { feePayer: "not-an-id" } },
        ],
      }),
    ).toThrow(/valid Hedera entity/i);
  });

  it("rejects fee-payer drift from the expected value", () => {
    expect(() =>
      assertFacilitatorCapability({
        kinds: [
          { x402Version: 2, scheme: "exact", network: "hedera:testnet", extra: { feePayer: "0.0.9999999" } },
        ],
      }),
    ).toThrow(/capability drift/i);
  });

  it("throws a typed FinalDemoError", () => {
    try {
      assertFacilitatorCapability({ nope: true });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(FinalDemoError);
      expect((e as FinalDemoError).code).toBe("FACILITATOR_PREFLIGHT_INVALID");
    }
  });
});

describe("F-002 facilitator preflight — fetch behavior", () => {
  it("passes with a good /supported response", async () => {
    const cap = await checkFacilitatorPreflight({
      facilitatorUrl: "https://facilitator.example",
      fetchImpl: (async () => jsonResponse(GOOD)) as unknown as typeof fetch,
    });
    expect(cap.feePayer).toBe("0.0.7162784");
  });

  it("fails closed when the facilitator is unreachable", async () => {
    await expect(
      checkFacilitatorPreflight({
        fetchImpl: (async () => {
          throw new Error("network down");
        }) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/unreachable/i);
  });

  it("fails closed on non-OK HTTP", async () => {
    await expect(
      checkFacilitatorPreflight({
        fetchImpl: (async () => jsonResponse({}, false, 503)) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/HTTP 503/);
  });
});

describe("F-002 preflight gates irreversible writes", () => {
  it("a failing preflight yields zero topic creates, HCS submits, and payments", async () => {
    const t = createFinalDemoDryRunTransports({ clockMs: Date.parse("2026-07-19T12:00:00.000Z") });
    await expect(
      runFinalDemoOrchestration({
        mode: FINAL_DEMO_MODE_DRY,
        clock: t.clock,
        workDir: "F:/tmp/rg-f002-fail",
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
          facilitatorPreflight: async () => {
            throw new FinalDemoError(
              "capability drift",
              "FACILITATOR_CAPABILITY_DRIFT",
            );
          },
          usdcReadiness: async () => {
            throw new Error("must not reach USDC readiness");
          },
        },
      }),
    ).rejects.toThrow(/capability drift/i);

    expect(t.topicTransport.getCreateCount()).toBe(0);
    expect(t.hcsTransport.getSubmitCount()).toBe(0);
    expect(t.facilitatorTransport.settleCallCount).toBe(0);
  });
});
