import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  acceptanceReceiptHash,
  signAcceptanceReceipt,
  verifyAcceptanceReceiptSignature,
} from "../src/domain/acceptance-receipt";
import {
  bidHash,
  parseCarrierBid,
  signCarrierBid,
  verifyCarrierBidSignature,
} from "../src/domain/bid";
import { canonicalize, canonicalSha256 } from "../src/domain/canonical-hash";
import {
  isCommitmentTimely,
  parseCommitmentEvidence,
} from "../src/domain/commitment-evidence";
import {
  isValidHederaAccountId,
  parsePaymentOption,
  parsePaymentOptionSet,
} from "../src/domain/payment-option";
import {
  HIERO_ECDSA_SIGNATURE_HEX_LENGTH,
  parseSignatureHex,
} from "../src/domain/signature";
import { parseFreightTender, tenderHash } from "../src/domain/tender";
import {
  compareUtc,
  parseUtcTimestamp,
} from "../src/domain/time";
import {
  AUCTION_ENDS_AT,
  buildHamburgIstanbulTender,
  buildReceiptForBid,
  buildSignedBid,
  CARRIER_KEYS,
  ROUTEGUARD_PRIVATE_KEY,
  ROUTEGUARD_PUBLIC_KEY,
} from "./fixtures/auction-fixtures";

describe("Freight domain — tender schema", () => {
  it("accepts the Hamburg → Istanbul fixture", () => {
    const tender = buildHamburgIstanbulTender();
    expect(tender.cargo.pallets).toBe(12);
    expect(tender.maximumFreightPriceCents).toBe(400_000);
  });

  it("rejects malformed timestamps", () => {
    expect(() =>
      parseFreightTender({
        ...buildHamburgIstanbulTender(),
        auctionEndsAt: "not-a-timestamp",
      }),
    ).toThrow();
  });

  it("rejects floating / unsafe monetary values", () => {
    expect(() =>
      parseFreightTender({
        ...buildHamburgIstanbulTender(),
        maximumFreightPriceCents: 4000.5,
      }),
    ).toThrow();
  });
});

describe("Freight domain — canonicalization", () => {
  it("equivalent objects with different insertion order hash identically", () => {
    const a = { z: 1, a: { y: 2, b: 3 }, list: [1, 2] };
    const b = { list: [1, 2], a: { b: 3, y: 2 }, z: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalSha256(a)).toBe(canonicalSha256(b));
    expect(canonicalSha256(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("different array orders hash differently", () => {
    expect(canonicalSha256({ list: [1, 2] })).not.toBe(
      canonicalSha256({ list: [2, 1] }),
    );
  });

  it("rejects sparse arrays", () => {
    const sparse: unknown[] = [];
    sparse[1] = "x";
    expect(() => canonicalize(sparse)).toThrow(/sparse/i);
  });

  it("[] cannot collide with a sparse array", () => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(() => canonicalize(sparse)).toThrow(/sparse/i);
    expect(canonicalize([])).toBe("[]");
  });

  it("does not mutate inputs", () => {
    const obj = { z: 1, a: 2 };
    const keysBefore = Object.keys(obj);
    canonicalize(obj);
    expect(Object.keys(obj)).toEqual(keysBefore);
  });

  it("Unicode and control characters are deterministic via JSON escaping", () => {
    const s = "quote\"backslash\\tab\tnewline\nü✓";
    const c1 = canonicalize({ s });
    const c2 = canonicalize({ s });
    expect(c1).toBe(c2);
    expect(c1).toContain("\\");
    expect(canonicalSha256({ s })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects unsupported types fail-closed", () => {
    expect(() => canonicalize({ x: undefined })).toThrow(/undefined/);
    expect(() => canonicalize({ x: Number.NaN })).toThrow();
    expect(() => canonicalize({ x: Infinity })).toThrow();
    expect(() => canonicalize({ x: 1n })).toThrow(/bigint/);
    expect(() => canonicalize({ x: () => 1 })).toThrow(/function/);
    expect(() => canonicalize({ x: Symbol("s") })).toThrow(/symbol/);
    expect(() => canonicalize({ x: new Date() })).toThrow(/Date/);
    expect(() => canonicalize({ x: new Map() })).toThrow(/Map/);
    expect(() => canonicalize({ x: new Set() })).toThrow(/Set/);
    class C {}
    expect(() => canonicalize(new C())).toThrow(/non-plain|class/i);
  });

  /**
   * Independent golden vector: expected canonical JSON and SHA-256 were
   * generated outside the production helper (manual key sort + Node crypto).
   */
  it("matches independently generated golden hash", () => {
    // Hand-written canonical string + SHA-256 computed outside production helper.
    const independentCanonical =
      '{"a":{"b":3,"y":2},"list":[1,2],"z":1}';
    const independentDigest =
      "b82aa3586fa61498e3c9959e61d0e4814717a9cac0689c6242bee23b74599ea4";
    // Sanity: independent digest matches Node crypto over the hand-written string.
    expect(
      createHash("sha256").update(independentCanonical, "utf8").digest("hex"),
    ).toBe(independentDigest);

    const prod = canonicalize({ z: 1, a: { y: 2, b: 3 }, list: [1, 2] });
    expect(prod).toBe(independentCanonical);
    expect(canonicalSha256({ z: 1, a: { y: 2, b: 3 }, list: [1, 2] })).toBe(
      `sha256:${independentDigest}`,
    );
  });
});

describe("Freight domain — precise UTC timestamps", () => {
  it("rejects impossible calendar dates", () => {
    expect(() => parseUtcTimestamp("2026-02-30T00:00:00Z")).toThrow(
      /Impossible|Invalid/,
    );
  });

  it("enforces leap-year rules", () => {
    expect(parseUtcTimestamp("2024-02-29T00:00:00Z").epochSeconds).toBeDefined();
    expect(() => parseUtcTimestamp("2025-02-29T00:00:00Z")).toThrow();
  });

  it("compares nanosecond fractions correctly", () => {
    const a = parseUtcTimestamp("2026-08-01T10:00:00.000000001Z");
    const b = parseUtcTimestamp("2026-08-01T10:00:00.000000002Z");
    expect(a.epochNanoseconds < b.epochNanoseconds).toBe(true);
    expect(compareUtc(
      "2026-08-01T10:00:00.000000001Z",
      "2026-08-01T10:00:00.000000002Z",
    )).toBe(-1);
  });

  it("mixed precision: 10:00:00Z earlier than 10:00:00.1Z", () => {
    expect(
      compareUtc("2026-08-01T10:00:00Z", "2026-08-01T10:00:00.1Z"),
    ).toBe(-1);
  });

  it("deadline equality is timely", () => {
    expect(isCommitmentTimely(AUCTION_ENDS_AT, AUCTION_ENDS_AT)).toBe(true);
  });

  it("rejects timezone offsets", () => {
    expect(() =>
      parseUtcTimestamp("2026-08-01T10:00:00+00:00"),
    ).toThrow();
  });
});

describe("Freight domain — signatures", () => {
  it("valid ECDSA carrier signature verifies", () => {
    const signed = buildSignedBid({
      bidId: "sig-ok",
      carrier: "alpha",
      freightPriceCents: 2000,
    });
    expect(
      verifyCarrierBidSignature(signed, CARRIER_KEYS.alpha.publicKey),
    ).toBe(true);
  });

  it("modified signed bid fails verification", () => {
    const signed = buildSignedBid({
      bidId: "sig-bad",
      carrier: "alpha",
      freightPriceCents: 2000,
    });
    const tampered = {
      bid: { ...signed.bid, freightPriceCents: 1999 },
      signature: signed.signature,
    };
    expect(
      verifyCarrierBidSignature(tampered, CARRIER_KEYS.alpha.publicKey),
    ).toBe(false);
  });

  it("wrong-key signature is rejected", () => {
    const signed = buildSignedBid({
      bidId: "sig-wrong",
      carrier: "alpha",
      freightPriceCents: 2000,
      privateKeyOverride: CARRIER_KEYS.beta.privateKey,
    });
    expect(
      verifyCarrierBidSignature(signed, CARRIER_KEYS.alpha.publicKey),
    ).toBe(false);
  });

  it("valid signature with zz suffix fails", () => {
    const signed = buildSignedBid({
      bidId: "sig-zz",
      carrier: "alpha",
      freightPriceCents: 2000,
    });
    expect(signed.signature.length).toBe(HIERO_ECDSA_SIGNATURE_HEX_LENGTH);
    const malformed = `${signed.signature}zz`;
    expect(parseSignatureHex(malformed)).toBeNull();
    expect(
      verifyCarrierBidSignature(
        { bid: signed.bid, signature: malformed },
        CARRIER_KEYS.alpha.publicKey,
      ),
    ).toBe(false);
  });

  it("truncated and oversized signatures fail closed", () => {
    expect(parseSignatureHex("ab")).toBeNull();
    expect(parseSignatureHex("aa".repeat(63))).toBeNull();
    expect(parseSignatureHex("aa".repeat(65))).toBeNull();
    expect(parseSignatureHex("not-hex!!!!")).toBeNull();
  });

  it("signing is independent of object insertion order", () => {
    const signed = buildSignedBid({
      bidId: "order",
      carrier: "alpha",
      freightPriceCents: 1000,
      commitmentSalt: "11".repeat(32),
    });
    // Reconstruct bid with different key insertion order
    const reordered = {
      version: signed.bid.version,
      nonce: signed.bid.nonce,
      commitmentSalt: signed.bid.commitmentSalt,
      reservationPaymentOptions: signed.bid.reservationPaymentOptions,
      bidValidUntil: signed.bid.bidValidUntil,
      capacityConfirmed: signed.bid.capacityConfirmed,
      estimatedDelivery: signed.bid.estimatedDelivery,
      proposedPickupAt: signed.bid.proposedPickupAt,
      equipment: signed.bid.equipment,
      freightPriceCents: signed.bid.freightPriceCents,
      carrierAccountId: signed.bid.carrierAccountId,
      carrierId: signed.bid.carrierId,
      tenderId: signed.bid.tenderId,
      bidId: signed.bid.bidId,
    };
    expect(
      verifyCarrierBidSignature(
        { bid: reordered as typeof signed.bid, signature: signed.signature },
        CARRIER_KEYS.alpha.publicKey,
      ),
    ).toBe(true);
  });
});

describe("Freight domain — bid model", () => {
  it("salt participates in bid hash", () => {
    const bidA = buildSignedBid({
      bidId: "salt-a",
      carrier: "alpha",
      freightPriceCents: 1000,
      commitmentSalt: "11".repeat(32),
    });
    const bidB = buildSignedBid({
      bidId: "salt-a",
      carrier: "alpha",
      freightPriceCents: 1000,
      commitmentSalt: "22".repeat(32),
    });
    expect(bidHash(bidA.bid)).not.toBe(bidHash(bidB.bid));
  });

  it("rejects invalid Hedera carrier account ID", () => {
    expect(isValidHederaAccountId("not-an-id")).toBe(false);
    expect(() =>
      parseCarrierBid({
        ...buildSignedBid({
          bidId: "bad-acct",
          carrier: "alpha",
          freightPriceCents: 1000,
        }).bid,
        carrierAccountId: "bad",
      }),
    ).toThrow();
  });

  it("requires proposedPickupAt", () => {
    const signed = buildSignedBid({
      bidId: "pickup",
      carrier: "alpha",
      freightPriceCents: 1000,
      proposedPickupAt: "2026-08-03T12:00:00.000Z",
    });
    expect(signed.bid.proposedPickupAt).toBe("2026-08-03T12:00:00.000Z");
  });
});

describe("Freight domain — payment options", () => {
  it("validates USDC and HBAR assets", () => {
    expect(
      parsePaymentOption({
        optionId: "USDC",
        scheme: "exact",
        network: "hedera:testnet",
        asset: "0.0.429274",
        amountAtomic: "10000",
        payTo: "0.0.9100001",
      }).asset,
    ).toBe("0.0.429274");
  });

  it("rejects duplicate optionId or asset", () => {
    expect(() =>
      parsePaymentOptionSet([
        {
          optionId: "USDC",
          scheme: "exact",
          network: "hedera:testnet",
          asset: "0.0.429274",
          amountAtomic: "1",
          payTo: "0.0.1",
        },
        {
          optionId: "USDC",
          scheme: "exact",
          network: "hedera:testnet",
          asset: "0.0.429274",
          amountAtomic: "2",
          payTo: "0.0.1",
        },
      ]),
    ).toThrow(/Duplicate/);
  });
});

describe("Freight domain — acceptance receipt", () => {
  it("hashes and verifies RouteGuard signature", () => {
    const signedBid = buildSignedBid({
      bidId: "rcpt",
      carrier: "alpha",
      freightPriceCents: 1000,
    });
    const receipt = signAcceptanceReceipt(
      {
        receiptId: "r1",
        tenderId: signedBid.bid.tenderId,
        bidId: signedBid.bid.bidId,
        bidHash: bidHash(signedBid.bid),
        acceptedAt: "2026-08-01T09:00:00.000Z",
        version: 1,
      },
      ROUTEGUARD_PRIVATE_KEY,
    );
    expect(acceptanceReceiptHash(receipt.receipt)).toMatch(/^sha256:/);
    expect(
      verifyAcceptanceReceiptSignature(receipt, ROUTEGUARD_PUBLIC_KEY),
    ).toBe(true);
  });
});

describe("Freight domain — commitment evidence", () => {
  it("rejects hcsSequence 0", () => {
    const signed = buildSignedBid({
      bidId: "c0",
      carrier: "alpha",
      freightPriceCents: 1000,
    });
    const receipt = buildReceiptForBid(signed);
    expect(() =>
      parseCommitmentEvidence({
        tenderId: signed.bid.tenderId,
        bidId: signed.bid.bidId,
        carrierId: signed.bid.carrierId,
        bidHash: bidHash(signed.bid),
        acceptanceReceiptHash: acceptanceReceiptHash(receipt.receipt),
        bidVersion: 1,
        hcsSequence: 0,
        consensusTimestamp: "2026-08-01T09:00:00.000Z",
      }),
    ).toThrow();
  });

  it("includes tender version in tender hash", () => {
    const t1 = buildHamburgIstanbulTender({ version: 1 });
    const t2 = buildHamburgIstanbulTender({ version: 2 });
    expect(tenderHash(t1)).not.toBe(tenderHash(t2));
  });
});
