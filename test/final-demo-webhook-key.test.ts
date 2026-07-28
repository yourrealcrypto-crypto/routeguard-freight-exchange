/**
 * F-009 — live webhook signing key. Live mode requires an owner-supplied key
 * and rejects the tracked dry-only fallback; dry mode uses the fallback.
 */

import { describe, expect, it } from "vitest";

import { resolveWebhookSigningKey } from "../src/final-demo/orchestration";
import { FinalDemoError } from "../src/final-demo/errors";

const DRY_KEY =
  "7a8b9c0d1e2f30415263748596a7b8c9d0e1f2031425364758697a8b9c0d1e2f";
const OWNER_KEY =
  "1122334455667788990011223344556677889900112233445566778899001122";

describe("F-009 webhook signing key resolution", () => {
  it("dry mode falls back to the tracked dry-only key", () => {
    expect(resolveWebhookSigningKey({ isLive: false, env: {} })).toBe(DRY_KEY);
  });

  it("dry mode still honors an explicit provided key", () => {
    expect(
      resolveWebhookSigningKey({ isLive: false, provided: OWNER_KEY, env: {} }),
    ).toBe(OWNER_KEY);
  });

  it("live mode requires a key — absent fails closed", () => {
    try {
      resolveWebhookSigningKey({ isLive: true, env: {} });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(FinalDemoError);
      expect((e as FinalDemoError).code).toBe("LIVE_WEBHOOK_KEY_REQUIRED");
    }
  });

  it("live mode rejects the tracked dry default key", () => {
    expect(() =>
      resolveWebhookSigningKey({ isLive: true, provided: DRY_KEY, env: {} }),
    ).toThrow(/must not be used for a live run/i);
    // Also rejected when supplied via env.
    expect(() =>
      resolveWebhookSigningKey({
        isLive: true,
        env: { WEBHOOK_SIGNING_KEY: DRY_KEY } as NodeJS.ProcessEnv,
      }),
    ).toThrow(/must not be used for a live run/i);
  });

  it("live mode rejects a malformed key", () => {
    expect(() =>
      resolveWebhookSigningKey({ isLive: true, provided: "too-short", env: {} }),
    ).toThrow(/32-byte hex/i);
  });

  it("live mode accepts an owner-supplied key via deps or env", () => {
    expect(
      resolveWebhookSigningKey({ isLive: true, provided: OWNER_KEY, env: {} }),
    ).toBe(OWNER_KEY);
    expect(
      resolveWebhookSigningKey({
        isLive: true,
        env: { WEBHOOK_SIGNING_KEY: OWNER_KEY } as NodeJS.ProcessEnv,
      }),
    ).toBe(OWNER_KEY);
  });
});
