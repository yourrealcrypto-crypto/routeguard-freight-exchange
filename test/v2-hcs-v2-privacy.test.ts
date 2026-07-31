import { describe, expect, it } from "vitest";

import { buildHcsV2Envelope } from "../src/hcs/v2/envelope";
import { assertHcsV2PublicSafe } from "../src/hcs/v2/privacy";

const HASH =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TS = "2026-07-31T12:00:00.000Z";

describe("v2 HCS privacy boundary", () => {
  it("rejects prohibited PII field names on payloads", () => {
    expect(() =>
      assertHcsV2PublicSafe({ phoneNumber: "+49" }),
    ).toThrow(/privacy violation/);
    expect(() =>
      assertHcsV2PublicSafe({ postalAddress: "x" }),
    ).toThrow(/privacy violation/);
    expect(() =>
      assertHcsV2PublicSafe({ privateKey: "k" }),
    ).toThrow(/privacy violation/);
    expect(() =>
      assertHcsV2PublicSafe({ paymentPayload: {} }),
    ).toThrow(/privacy violation/);
    expect(() =>
      assertHcsV2PublicSafe({ disputeNarrative: "long story" }),
    ).toThrow(/privacy violation/);
    expect(() =>
      assertHcsV2PublicSafe({ podPlaintext: "doc" }),
    ).toThrow(/privacy violation/);
    expect(() =>
      assertHcsV2PublicSafe({ email: "a@b.c" }),
    ).toThrow(/privacy violation/);
  });

  it("fails envelope build when payload contains prohibited fields", () => {
    expect(() =>
      buildHcsV2Envelope({
        messageType: "DISPUTE_OPENED",
        tenderId: "t1",
        tenderVersion: 1,
        tenderHash: HASH,
        createdAt: TS,
        payload: {
          disputeId: "d1",
          podId: "p1",
          reasonCode: "X",
          // @ts-expect-error intentional privacy violation
          phoneNumber: "+1",
        },
      }),
    ).toThrow(/privacy violation/);
  });

  it("accepts public-safe dispute and POD messages", () => {
    expect(() =>
      buildHcsV2Envelope({
        messageType: "POD_SUBMITTED",
        tenderId: "t1",
        tenderVersion: 1,
        tenderHash: HASH,
        createdAt: TS,
        payload: {
          podId: "pod-1",
          contentHash: HASH,
          ciphertextHash: HASH,
          sizeBytes: 100,
        },
      }),
    ).not.toThrow();
  });
});
