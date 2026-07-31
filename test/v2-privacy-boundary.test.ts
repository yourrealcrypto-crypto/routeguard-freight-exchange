import { describe, expect, it } from "vitest";

import { parseAdvisoryReport } from "../src/v2/schemas/advisory";
import {
  assertNoProhibitedPiiFields,
  HCS_V2_SCHEMA_VERSION,
  PROHIBITED_PII_FIELD_NAMES,
} from "../src/v2/schemas/common";
import { parsePodPackageMeta } from "../src/v2/schemas/pod";

const HASH =
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TS = "2026-07-31T15:00:00.000Z";

function validPod(overrides: Record<string, unknown> = {}) {
  return {
    podId: "pod-1",
    tenderId: "tender-v2-1",
    bidId: "bid-1",
    carrierId: "carrier-alpha",
    ciphertextBlobRef: "s3://pods/pod-1.enc",
    encryption: {
      alg: "AES-256-GCM",
      keyId: "key-1",
      iv: "iv-base64-or-hex",
      aadBinding: HASH,
    },
    contentHash: HASH,
    ciphertextHash: HASH,
    manifest: {
      documentCount: 2,
      totalBytes: 4096,
      mimeTypes: ["application/pdf"],
    },
    submittedAt: TS,
    ...overrides,
  };
}

describe("v2 privacy boundary", () => {
  it("uses HCS schema identifier routeguard-hcs-2.0", () => {
    expect(HCS_V2_SCHEMA_VERSION).toBe("routeguard-hcs-2.0");
  });

  it("accepts public-safe POD metadata without plaintext", () => {
    const pod = parsePodPackageMeta(validPod());
    expect(pod.encryption.alg).toBe("AES-256-GCM");
    expect(pod).not.toHaveProperty("plaintext");
    expect(pod).not.toHaveProperty("podPlaintext");
  });

  it("rejects obvious PII field names on POD objects", () => {
    expect(() =>
      parsePodPackageMeta(validPod({ phoneNumber: "+491234" })),
    ).toThrow(/Prohibited personal-data field/);
    expect(() =>
      parsePodPackageMeta(validPod({ postalAddress: "Hafenstr. 1" })),
    ).toThrow(/Prohibited personal-data field/);
    expect(() =>
      parsePodPackageMeta(validPod({ plateNumber: "HH-AB-123" })),
    ).toThrow(/Prohibited personal-data field/);
    expect(() =>
      parsePodPackageMeta(validPod({ privateKey: "deadbeef" })),
    ).toThrow(/Prohibited personal-data field/);
    expect(() =>
      parsePodPackageMeta(validPod({ paymentPayload: {} })),
    ).toThrow(/Prohibited personal-data field/);
    expect(() =>
      parsePodPackageMeta(validPod({ disputeNarrative: "long free text" })),
    ).toThrow(/Prohibited personal-data field/);
    expect(() =>
      parsePodPackageMeta(validPod({ podImage: "base64..." })),
    ).toThrow(/Prohibited personal-data field/);
    expect(() =>
      parsePodPackageMeta(validPod({ name: "John Carrier" })),
    ).toThrow(/Prohibited personal-data field/);
  });

  it("lists required prohibited field vocabulary", () => {
    for (const name of [
      "phone",
      "postalAddress",
      "privateKey",
      "paymentPayload",
      "plateNumber",
      "signatureImage",
    ]) {
      expect(
        (PROHIBITED_PII_FIELD_NAMES as readonly string[]).includes(name),
      ).toBe(true);
    }
    expect(() =>
      assertNoProhibitedPiiFields({ fullName: "x" }),
    ).toThrow(/fullName/);
  });

  it("advisory schema cannot contain release/refund authorization", () => {
    const base = {
      reportId: "adv-1",
      podId: "pod-1",
      tenderId: "tender-v2-1",
      engine: "stub-v0",
      findings: [
        {
          code: "ANOMALY",
          severity: "WARN",
          message: "Minor inconsistency",
        },
      ],
      reportHash: HASH,
      createdAt: TS,
      binding: "NON_BINDING_ADVISORY" as const,
    };

    expect(parseAdvisoryReport(base).binding).toBe("NON_BINDING_ADVISORY");

    expect(() =>
      parseAdvisoryReport({
        ...base,
        releaseAuthorization: true,
      }),
    ).toThrow(/authorization field/);

    expect(() =>
      parseAdvisoryReport({
        ...base,
        refundAuthorization: { amount: "1000" },
      }),
    ).toThrow(/authorization field/);

    expect(() =>
      parseAdvisoryReport({
        ...base,
        canRelease: true,
      }),
    ).toThrow(/authorization field/);
  });
});
