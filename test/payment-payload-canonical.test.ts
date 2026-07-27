/**
 * Regression: x402 PaymentPayload may carry `extensions: undefined`.
 * Strict canonicalize must remain fail-closed; optional undefined is omitted
 * *before* hashing so payment construction can complete.
 */

import { describe, expect, it } from "vitest";

import {
  canonicalize,
  canonicalSha256,
} from "../src/domain/canonical-hash";
import {
  omitUndefinedObjectProperties,
  paymentPayloadForCanonicalHash,
} from "../src/domain/payment-payload-canonical";

describe("payment payload canonical preparation", () => {
  it("omits an absent optional extensions value (undefined property)", () => {
    // Real defect shape from @x402/core createPaymentPayload (v2):
    // extensions is always assigned; mergeExtensions returns undefined.
    const raw = {
      x402Version: 2,
      resource: {
        url: "/api/reservations/reservation-final-8b73c264/pay/usdc",
        description: "Demo reservation fee only — not payment of the freight price.",
        mimeType: "application/json",
      },
      accepted: {
        scheme: "exact",
        network: "hedera:testnet",
        asset: "0.0.429274",
        amount: "10000",
        payTo: "0.0.9215954",
        maxTimeoutSeconds: 180,
        extra: { feePayer: "0.0.7162784" },
      },
      payload: {
        transaction: "dGVzdA==",
      },
      extensions: undefined,
    };

    expect(() => canonicalize(raw)).toThrow(
      /Unsupported value at \$\.extensions: undefined object property/,
    );

    const prepared = paymentPayloadForCanonicalHash(raw) as Record<
      string,
      unknown
    >;
    expect(Object.prototype.hasOwnProperty.call(prepared, "extensions")).toBe(
      false,
    );
    expect(Object.keys(prepared).sort()).toEqual(
      ["accepted", "payload", "resource", "x402Version"].sort(),
    );

    const hash = canonicalSha256(prepared);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Deterministic: same content without the key hashes identically.
    const withoutKey = {
      x402Version: 2,
      resource: raw.resource,
      accepted: raw.accepted,
      payload: raw.payload,
    };
    expect(hash).toBe(canonicalSha256(withoutKey));
  });

  it("does not send any object with an undefined property to canonicalize", () => {
    const prepared = paymentPayloadForCanonicalHash({
      a: 1,
      extensions: undefined,
      b: "x",
    }) as Record<string, unknown>;
    for (const key of Object.keys(prepared)) {
      expect(prepared[key]).not.toBe(undefined);
    }
    expect(() => canonicalize(prepared)).not.toThrow();
  });

  it("preserves supported non-empty extensions", () => {
    const withExt = {
      x402Version: 2,
      payload: { transaction: "abc" },
      accepted: {
        scheme: "exact",
        network: "hedera:testnet",
        asset: "0.0.429274",
        amount: "10000",
        payTo: "0.0.9215954",
        maxTimeoutSeconds: 180,
      },
      extensions: {
        "payment-identifier": { id: "pid-1" },
      },
    };
    const prepared = paymentPayloadForCanonicalHash(withExt) as {
      extensions: { "payment-identifier": { id: string } };
    };
    expect(prepared.extensions).toEqual({
      "payment-identifier": { id: "pid-1" },
    });
    const hash = canonicalSha256(prepared);
    expect(hash).toBe(canonicalSha256(withExt));
    expect(hash).not.toBe(
      canonicalSha256({
        x402Version: 2,
        payload: withExt.payload,
        accepted: withExt.accepted,
      }),
    );
  });

  it("still fails closed on nested undefined values", () => {
    const nested = {
      x402Version: 2,
      payload: { transaction: "abc", nested: { bad: undefined as unknown } },
      accepted: { scheme: "exact" },
    };
    // Shallow omit does not strip nested undefined — canonicalize rejects.
    const prepared = paymentPayloadForCanonicalHash(nested);
    expect(() => canonicalize(prepared)).toThrow(
      /undefined object property/,
    );
  });

  it("does not convert undefined to null", () => {
    const raw = { extensions: undefined, keep: "yes" };
    const prepared = omitUndefinedObjectProperties(raw) as Record<
      string,
      unknown
    >;
    expect(Object.prototype.hasOwnProperty.call(prepared, "extensions")).toBe(
      false,
    );
    expect(prepared.keep).toBe("yes");
    // Explicit null is preserved (schema may require null elsewhere).
    expect(
      omitUndefinedObjectProperties({ extensions: null, keep: 1 }),
    ).toEqual({ extensions: null, keep: 1 });
  });

  it("payment payload can be constructed/hashed from a persisted challenge shape", () => {
    // Mirrors reservation-final-8b73c264 challenge + x402 payload shape.
    const challenge = {
      x402Version: 2,
      scheme: "exact",
      network: "hedera:testnet",
      asset: "0.0.429274",
      amount: "10000",
      payTo: "0.0.9215954",
      resource: "/api/reservations/reservation-final-8b73c264/pay/usdc",
      maxTimeoutSeconds: 180,
      description: "Demo reservation fee only — not payment of the freight price.",
    };
    const syntheticPayload = {
      x402Version: challenge.x402Version,
      resource: {
        url: challenge.resource,
        description: challenge.description,
        mimeType: "application/json",
      },
      accepted: {
        scheme: challenge.scheme,
        network: challenge.network,
        asset: challenge.asset,
        amount: challenge.amount,
        payTo: challenge.payTo,
        maxTimeoutSeconds: challenge.maxTimeoutSeconds,
        extra: { feePayer: "0.0.7162784" },
      },
      payload: {
        // Synthetic base64; real factory would place signed bytes here.
        transaction: Buffer.from("client-frozen-tx-bytes").toString("base64"),
      },
      extensions: undefined,
    };
    const hash = canonicalSha256(
      paymentPayloadForCanonicalHash(syntheticPayload),
    );
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("strict canonicalize is unchanged — still rejects bare undefined properties", () => {
    expect(() => canonicalize({ extensions: undefined })).toThrow(
      /\$\.extensions: undefined object property/,
    );
    expect(() => canonicalize({ x: undefined })).toThrow(/undefined/);
  });
});
