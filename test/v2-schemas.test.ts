import { describe, expect, it } from "vitest";

import {
  ACCESS_FEE_AMOUNT_ATOMIC,
  ACCESS_FEE_TOKEN_ID,
  centsToUsdcAtomic,
} from "../src/v2/access/fee";
import { parseAccessReceipt } from "../src/v2/schemas/access-receipt";
import { parseAdvisoryReport } from "../src/v2/schemas/advisory";
import { parseEscrowAllocation } from "../src/v2/schemas/escrow-allocation";
import { parseRefereeResolution } from "../src/v2/schemas/referee";
import { parseShipperReview } from "../src/v2/schemas/shipper-review";
import {
  DEFAULT_CORRECTION_WINDOW_SECONDS,
  DEFAULT_POST_RESUBMIT_REVIEW_WINDOW_SECONDS,
  DEFAULT_REVIEW_WINDOW_SECONDS,
  parseV2FreightTender,
} from "../src/v2/schemas/tender";

const HASH =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SIG = "ab".repeat(64);
const TS = "2026-07-31T12:00:00.000Z";

function baseTender(overrides: Record<string, unknown> = {}) {
  return {
    tenderId: "tender-v2-1",
    shipperId: "shipper-1",
    origin: "Hamburg",
    destination: "Istanbul",
    cargo: {
      type: "general",
      weightKg: 1000,
      pallets: 12,
      dangerousGoods: false,
    },
    requiredEquipment: "Curtainsider",
    pickupWindow: {
      earliest: "2026-08-10T08:00:00.000Z",
      latest: "2026-08-10T18:00:00.000Z",
    },
    deliveryDeadline: "2026-08-15T18:00:00.000Z",
    auctionEndsAt: "2026-08-09T18:00:00.000Z",
    maximumFreightBudgetAtomic: centsToUsdcAtomic(400_000),
    selectionPolicy: "LOWEST_QUALIFIED_PRICE_V1",
    version: 1,
    ...overrides,
  };
}

describe("v2 schemas — tender", () => {
  it("accepts authoritative maximumFreightBudgetAtomic with review defaults", () => {
    const tender = parseV2FreightTender(baseTender());
    expect(tender.maximumFreightBudgetAtomic).toBe("4000000000");
    expect(tender.reviewWindowSeconds).toBe(DEFAULT_REVIEW_WINDOW_SECONDS);
    expect(tender.reviewWindowSeconds).toBe(172_800);
    expect(tender.correctionWindowSeconds).toBe(
      DEFAULT_CORRECTION_WINDOW_SECONDS,
    );
    expect(tender.correctionWindowSeconds).toBe(86_400);
    expect(tender.postResubmitReviewWindowSeconds).toBe(
      DEFAULT_POST_RESUBMIT_REVIEW_WINDOW_SECONDS,
    );
    expect(tender.postResubmitReviewWindowSeconds).toBe(86_400);
  });

  it("binds optional legacy cents to atomic budget", () => {
    const tender = parseV2FreightTender(
      baseTender({ freightPriceCentsLegacy: 400_000 }),
    );
    expect(tender.freightPriceCentsLegacy).toBe(400_000);

    expect(() =>
      parseV2FreightTender(
        baseTender({
          freightPriceCentsLegacy: 100,
          maximumFreightBudgetAtomic: "1",
        }),
      ),
    ).toThrow();
  });

  it("rejects negative or non-integer atomic budgets", () => {
    expect(() =>
      parseV2FreightTender(
        baseTender({ maximumFreightBudgetAtomic: "-1" }),
      ),
    ).toThrow();
    expect(() =>
      parseV2FreightTender(
        baseTender({ maximumFreightBudgetAtomic: "1.5" }),
      ),
    ).toThrow();
    expect(() =>
      parseV2FreightTender(baseTender({ maximumFreightBudgetAtomic: "0" })),
    ).toThrow();
  });
});

describe("v2 schemas — access receipt", () => {
  const baseReceipt = {
    actionType: "TENDER_ACTIVATE" as const,
    actionId: "act-1",
    tenderId: "tender-v2-1",
    tenderVersion: 1,
    payerAccount: "0.0.9197513",
    payTo: "0.0.9197513",
    asset: ACCESS_FEE_TOKEN_ID,
    amountAtomic: ACCESS_FEE_AMOUNT_ATOMIC,
    resource: "/api/v2/tenders/tender-v2-1/activate",
    paymentTransactionId: "0.0.7162784@1785173890.867086556",
    paymentConsensusTimestamp: TS,
    paymentPayloadHash: HASH,
    status: "PAID" as const,
  };

  it("requires amountAtomic to match configured exact fee", () => {
    expect(parseAccessReceipt(baseReceipt).amountAtomic).toBe("1000");
    expect(() =>
      parseAccessReceipt({ ...baseReceipt, amountAtomic: "10000" }),
    ).toThrow();
  });

  it("requires asset to match 0.0.429274", () => {
    expect(parseAccessReceipt(baseReceipt).asset).toBe("0.0.429274");
    expect(() =>
      parseAccessReceipt({ ...baseReceipt, asset: "0.0.0" }),
    ).toThrow();
  });

  it("requires bidId for BID_SUBMIT", () => {
    expect(() =>
      parseAccessReceipt({
        ...baseReceipt,
        actionType: "BID_SUBMIT",
      }),
    ).toThrow();
    expect(
      parseAccessReceipt({
        ...baseReceipt,
        actionType: "BID_SUBMIT",
        bidId: "bid-1",
        resource: "/api/v2/tenders/tender-v2-1/bids",
      }).bidId,
    ).toBe("bid-1");
  });
});

describe("v2 schemas — shipper review", () => {
  const baseReview = {
    tenderId: "tender-v2-1",
    podId: "pod-1",
    shipperId: "shipper-1",
    shipperSignature: SIG,
    signedAt: TS,
    reviewDeadlineAt: "2026-08-02T12:00:00.000Z",
  };

  it("accepts ACCEPT without reasons", () => {
    expect(
      parseShipperReview({ ...baseReview, action: "ACCEPT" }).action,
    ).toBe("ACCEPT");
  });

  it("fails correction/rejection without structured reasons", () => {
    expect(() =>
      parseShipperReview({
        ...baseReview,
        action: "REQUEST_CORRECTION",
      }),
    ).toThrow();
    expect(() =>
      parseShipperReview({
        ...baseReview,
        action: "REJECT_DISPUTE",
        reasons: [],
      }),
    ).toThrow();
    expect(
      parseShipperReview({
        ...baseReview,
        action: "REQUEST_CORRECTION",
        reasons: [{ code: "MISSING_STAMP", message: "Stamp missing" }],
      }).reasons,
    ).toHaveLength(1);
  });
});

describe("v2 schemas — referee", () => {
  const baseRef = {
    disputeId: "disp-1",
    tenderId: "tender-v2-1",
    podId: "pod-1",
    rationaleCode: "CARRIER_PARTIAL_FAULT",
    refereeId: "ref-1",
    refereePublicKey: "02" + "ab".repeat(32),
    signature: SIG,
    signedPayloadHash: HASH,
    decidedAt: TS,
    signerKind: "HUMAN_REFEREE" as const,
  };

  it("requires non-negative atomic strings for partial amounts", () => {
    expect(() =>
      parseRefereeResolution({
        ...baseRef,
        resolution: "PARTIAL",
        releaseAmountAtomic: "-1",
        refundAmountAtomic: "1",
      }),
    ).toThrow();
    expect(() =>
      parseRefereeResolution({
        ...baseRef,
        resolution: "PARTIAL",
        releaseAmountAtomic: "1.5",
        refundAmountAtomic: "0",
      }),
    ).toThrow();
    expect(
      parseRefereeResolution({
        ...baseRef,
        resolution: "PARTIAL",
        releaseAmountAtomic: "5000",
        refundAmountAtomic: "5000",
      }).resolution,
    ).toBe("PARTIAL");
  });

  it("rejects AI signer", () => {
    expect(() =>
      parseRefereeResolution({
        ...baseRef,
        resolution: "RELEASE_FULL",
        releaseAmountAtomic: "10000",
        refundAmountAtomic: "0",
        aiSigner: "gpt",
      }),
    ).toThrow(/AI signer/);
  });
});

describe("v2 schemas — escrow allocation", () => {
  it("enforces max = win + excess conservation", () => {
    expect(
      parseEscrowAllocation({
        tenderId: "tender-v2-1",
        tenderVersion: 1,
        maxBudgetAtomic: "10000",
        winningAmountAtomic: "7000",
        excessRefundAtomic: "3000",
        winnerAccount: "0.0.9215954",
        shipperAccount: "0.0.9197513",
        decisionManifestHash: HASH,
        allocateTxId: "0.0.1@1.1",
        refundExcessTxId: "0.0.1@1.2",
        allocatedAt: TS,
      }).excessRefundAtomic,
    ).toBe("3000");

    expect(() =>
      parseEscrowAllocation({
        tenderId: "tender-v2-1",
        tenderVersion: 1,
        maxBudgetAtomic: "10000",
        winningAmountAtomic: "7000",
        excessRefundAtomic: "2000",
        winnerAccount: "0.0.9215954",
        shipperAccount: "0.0.9197513",
        decisionManifestHash: HASH,
        allocateTxId: "0.0.1@1.1",
        refundExcessTxId: "0.0.1@1.2",
        allocatedAt: TS,
      }),
    ).toThrow(/conservation/);
  });
});

describe("v2 schemas — advisory non-binding marker", () => {
  it("requires NON_BINDING_ADVISORY binding", () => {
    const report = parseAdvisoryReport({
      reportId: "adv-1",
      podId: "pod-1",
      tenderId: "tender-v2-1",
      engine: "stub-v0",
      findings: [
        {
          code: "COMPLETE",
          severity: "INFO",
          message: "Package looks complete",
        },
      ],
      reportHash: HASH,
      createdAt: TS,
      binding: "NON_BINDING_ADVISORY",
    });
    expect(report.binding).toBe("NON_BINDING_ADVISORY");
  });
});
