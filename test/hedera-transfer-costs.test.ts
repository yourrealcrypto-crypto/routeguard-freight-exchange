import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CHALLENGE_STATED_NETWORK_TRANSFER_COST_LABEL,
  HBAR_NETWORK_TRANSFER_COST_USD,
  HEDERA_TRANSFER_COSTS,
  STABLECOIN_NETWORK_TRANSFER_COST_USD,
  challengeStatedNetworkTransferCostUsd,
  hederaTransferCostEntry,
} from "../src/domain/hedera-transfer-costs";
import {
  buildPaymentEconomicsSummary,
  buildRailPresentation,
  formatPaymentEconomicsLines,
} from "../src/domain/payment-economics";
import {
  createReservationOffer,
  selectPaymentOption,
} from "../src/reservation/offer";
import {
  paymentEconomicsForSelection,
  publicPaymentRailsFromOffer,
  publicReservationView,
} from "../src/reservation/reservation-service";
import {
  HBAR_RESERVATION_OPTION,
  USDC_RESERVATION_OPTION,
} from "../src/reservation/types";
import { renderDevelopmentPage } from "../src/server/page";
import { DEMO_WINNER_ACCOUNT } from "./fixtures/reservation-fixtures";

const ROOT = path.resolve(__dirname, "..");

function readRepo(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

describe("Challenge-stated Hedera transfer costs", () => {
  it("HBAR returns exactly 0.0001 as a string", () => {
    expect(HBAR_NETWORK_TRANSFER_COST_USD).toBe("0.0001");
    expect(HEDERA_TRANSFER_COSTS.HBAR.networkFeeUsd).toBe("0.0001");
    expect(challengeStatedNetworkTransferCostUsd("HBAR")).toBe("0.0001");
    expect(typeof HBAR_NETWORK_TRANSFER_COST_USD).toBe("string");
    expect(Number.isInteger(Number(HBAR_NETWORK_TRANSFER_COST_USD))).toBe(
      false,
    );
  });

  it("USDC/HTS returns exactly 0.001 as a string", () => {
    expect(STABLECOIN_NETWORK_TRANSFER_COST_USD).toBe("0.001");
    expect(HEDERA_TRANSFER_COSTS.HTS_STABLECOIN.networkFeeUsd).toBe("0.001");
    expect(challengeStatedNetworkTransferCostUsd("USDC")).toBe("0.001");
    expect(typeof STABLECOIN_NETWORK_TRANSFER_COST_USD).toBe("string");
  });

  it("selected rail determines the correct transfer cost", () => {
    expect(hederaTransferCostEntry("HBAR").networkFeeUsd).toBe("0.0001");
    expect(hederaTransferCostEntry("USDC").networkFeeUsd).toBe("0.001");
  });

  it("network transfer cost is not deducted from carrier payment", () => {
    const usdc = buildPaymentEconomicsSummary({
      optionId: "USDC",
      asset: USDC_RESERVATION_OPTION.asset,
      amountAtomic: USDC_RESERVATION_OPTION.amountAtomic,
      displayAmount: USDC_RESERVATION_OPTION.displayAmount,
      currencyLabel: USDC_RESERVATION_OPTION.currencyLabel,
    });
    const hbar = buildPaymentEconomicsSummary({
      optionId: "HBAR",
      asset: HBAR_RESERVATION_OPTION.asset,
      amountAtomic: HBAR_RESERVATION_OPTION.amountAtomic,
      displayAmount: HBAR_RESERVATION_OPTION.displayAmount,
      currencyLabel: HBAR_RESERVATION_OPTION.currencyLabel,
    });

    expect(usdc.carrierReceivedAmountAtomic).toBe(
      USDC_RESERVATION_OPTION.amountAtomic,
    );
    expect(hbar.carrierReceivedAmountAtomic).toBe(
      HBAR_RESERVATION_OPTION.amountAtomic,
    );
    expect(usdc.hederaNetworkTransferCost.deductedFromCarrier).toBe(false);
    expect(usdc.hederaNetworkTransferCost.includedInX402PaymentAmount).toBe(
      false,
    );
    expect(usdc.reservationPaymentAmountAtomic).toBe(
      USDC_RESERVATION_OPTION.amountAtomic,
    );
    expect(hbar.reservationPaymentAmountAtomic).toBe(
      HBAR_RESERVATION_OPTION.amountAtomic,
    );
  });

  it("does not add USD network fee into HBAR amount as a same-unit total", () => {
    const hbar = buildPaymentEconomicsSummary({
      optionId: "HBAR",
      asset: HBAR_RESERVATION_OPTION.asset,
      amountAtomic: HBAR_RESERVATION_OPTION.amountAtomic,
      displayAmount: HBAR_RESERVATION_OPTION.displayAmount,
      currencyLabel: HBAR_RESERVATION_OPTION.currencyLabel,
    });
    expect(hbar.totalPayerEconomicsNote).toMatch(/different units/i);
    expect(hbar.totalPayerEconomicsNote).toMatch(/must not be summed/i);
    // No single same-unit total field that merges tinybars + USD.
    expect(hbar).not.toHaveProperty("totalPayerAmountAtomic");
    expect(hbar).not.toHaveProperty("totalPayerAmountUsd");
    // Reservation atomic remains pure tinybars string.
    expect(hbar.reservationPaymentAmountAtomic).toBe("1000000");
    expect(hbar.hederaNetworkTransferCost.networkFeeUsd).toBe("0.0001");
    expect(hbar.hederaNetworkTransferCost.unit).toBe("USD");
  });

  it("USDC preserves reservation amount separately from $0.001 transfer cost", () => {
    const usdc = buildPaymentEconomicsSummary({
      optionId: "USDC",
      asset: USDC_RESERVATION_OPTION.asset,
      amountAtomic: USDC_RESERVATION_OPTION.amountAtomic,
      displayAmount: USDC_RESERVATION_OPTION.displayAmount,
      currencyLabel: USDC_RESERVATION_OPTION.currencyLabel,
    });
    expect(usdc.reservationPaymentAmountAtomic).toBe("10000");
    expect(usdc.hederaNetworkTransferCost.networkFeeUsd).toBe("0.001");
    expect(usdc.totalPayerEconomicsNote).toMatch(/not deducted/i);
  });

  it("asset selector presentation includes exact costs", () => {
    const usdc = buildRailPresentation({
      optionId: "USDC",
      asset: USDC_RESERVATION_OPTION.asset,
      amountAtomic: USDC_RESERVATION_OPTION.amountAtomic,
      displayAmount: USDC_RESERVATION_OPTION.displayAmount,
      currencyLabel: "USDC",
    });
    const hbar = buildRailPresentation({
      optionId: "HBAR",
      asset: HBAR_RESERVATION_OPTION.asset,
      amountAtomic: HBAR_RESERVATION_OPTION.amountAtomic,
      displayAmount: HBAR_RESERVATION_OPTION.displayAmount,
      currencyLabel: "HBAR",
    });
    expect(usdc.selectorLabel).toContain("USDC");
    expect(usdc.selectorLabel).toContain("$0.001");
    expect(hbar.selectorLabel).toContain("HBAR");
    expect(hbar.selectorLabel).toContain("$0.0001");
    expect(usdc.challengeStatedHederaNetworkTransferCostLabel).toBe(
      CHALLENGE_STATED_NETWORK_TRANSFER_COST_LABEL,
    );
  });

  it("payment summary lines keep concepts separate", () => {
    const economics = buildPaymentEconomicsSummary({
      optionId: "USDC",
      asset: USDC_RESERVATION_OPTION.asset,
      amountAtomic: USDC_RESERVATION_OPTION.amountAtomic,
      displayAmount: USDC_RESERVATION_OPTION.displayAmount,
      currencyLabel: "USDC",
    });
    const lines = formatPaymentEconomicsLines(economics);
    expect(lines.some((l) => /Carrier reservation payment/i.test(l))).toBe(
      true,
    );
    expect(lines.some((l) => /Selected asset/i.test(l))).toBe(true);
    expect(
      lines.some((l) =>
        l.includes(CHALLENGE_STATED_NETWORK_TRANSFER_COST_LABEL),
      ),
    ).toBe(true);
    expect(lines.some((l) => /Facilitator fee/i.test(l))).toBe(true);
    expect(lines.some((l) => /RouteGuard platform fee/i.test(l))).toBe(true);
    expect(lines.some((l) => /Carrier-received amount/i.test(l))).toBe(true);
    expect(lines.join("\n")).toContain("$0.001");
  });

  it("receipts / public view preserve payment amount, asset, and transfer-cost reference", () => {
    const offer = createReservationOffer({
      reservationId: "res-fee-1",
      tenderId: "tender-fee",
      winningBidId: "bid-a",
      payTo: DEMO_WINNER_ACCOUNT,
      expiresAt: "2026-07-15T20:00:00.000Z",
    });
    const selected = selectPaymentOption({
      offer,
      optionId: "HBAR",
      payerAccount: "0.0.9197513",
      offerHash: offer.offerHash,
      offerVersion: offer.offerVersion,
      selectedAt: "2026-07-15T19:00:00.000Z",
      now: "2026-07-15T19:00:00.000Z",
    });
    const economics = paymentEconomicsForSelection(selected);
    expect(economics.hederaNetworkTransferCost.networkFeeUsd).toBe("0.0001");
    expect(economics.reservationPaymentAmountAtomic).toBe(
      HBAR_RESERVATION_OPTION.amountAtomic,
    );

    const rails = publicPaymentRailsFromOffer(offer);
    expect(rails).toHaveLength(2);
    expect(
      rails.find((r) => r.optionId === "USDC")
        ?.challengeStatedHederaNetworkTransferCostUsd,
    ).toBe("0.001");
    expect(
      rails.find((r) => r.optionId === "HBAR")
        ?.challengeStatedHederaNetworkTransferCostUsd,
    ).toBe("0.0001");

    const view = publicReservationView({
      recordVersion: 1,
      reservationId: "res-fee-1",
      state: "OPTION_SELECTED",
      tenderId: "tender-fee",
      tenderVersion: 1,
      tenderHash: "sha256:" + "aa".repeat(32),
      winningBidId: "bid-a",
      winningBidHash: "sha256:" + "bb".repeat(32),
      winningCarrierId: "carrier-a",
      winningCarrierAccount: DEMO_WINNER_ACCOUNT,
      decisionManifestHash: "sha256:" + "cc".repeat(32),
      evaluatedBidSetHash: "sha256:" + "dd".repeat(32),
      hcsTopicId: "0.0.1",
      closeBarrierSequence: 4,
      closeBarrierConsensusTimestamp: "2026-07-15T19:00:00.000Z",
      creationFingerprint: "fp",
      proofTenderId: "tender-fee",
      proofManifestHash: "sha256:" + "cc".repeat(32),
      offer,
      selected,
      attemptNumber: 1,
      paymentChallenge: null,
      paymentChallengeHash: null,
      paymentPayloadHash: null,
      facilitatorVerify: null,
      settleClaim: null,
      facilitatorSettle: null,
      transactionId: null,
      mirrorConfirmation: null,
      mirrorPoll: null,
      confirmationDeadline: null,
      routeReserved: null,
      webhookEvents: [],
      webhooks: [],
      hcsPublicationClaim: null,
      hcsEvidence: null,
      history: [],
      createdAt: "2026-07-15T18:00:00.000Z",
      updatedAt: "2026-07-15T19:00:00.000Z",
      expiresAt: "2026-07-15T20:00:00.000Z",
      failureCode: null,
      failureReason: null,
    }) as {
      paymentEconomics: { hederaNetworkTransferCost: { networkFeeUsd: string } };
      selectedSummary: { amountAtomic: string; asset: string };
    };

    expect(view.paymentEconomics.hederaNetworkTransferCost.networkFeeUsd).toBe(
      "0.0001",
    );
    expect(view.selectedSummary.amountAtomic).toBe(
      HBAR_RESERVATION_OPTION.amountAtomic,
    );
    expect(view.selectedSummary.asset).toBe(HBAR_RESERVATION_OPTION.asset);
  });

  it("UI includes exact transfer costs", () => {
    const html = renderDevelopmentPage();
    expect(html).toContain("Challenge-stated Hedera transfer cost: $0.001");
    expect(html).toContain("Challenge-stated Hedera transfer cost: $0.0001");
    expect(html).toContain("Carrier reservation");
    expect(html).toContain("network cost not deducted");
  });

  it("README includes both exact values and Why Hedera section", () => {
    const readme = readRepo("README.md");
    expect(readme).toMatch(/Why Hedera: Fixed and Predictable Machine-Payment Costs/);
    expect(readme).toContain("$0.0001");
    expect(readme).toContain("$0.001");
    expect(readme).toMatch(/HBAR/);
    expect(readme).toMatch(/Stablecoin/);
  });

  it("compliance matrix maps both cost requirements to proof", () => {
    const matrix = readRepo("docs/challenge-compliance-matrix.md");
    expect(matrix).toMatch(/HBAR transfer cost \$0\.0001/);
    expect(matrix).toMatch(/Stablecoin transfer cost \$0\.001/);
    expect(matrix).toContain("src/domain/hedera-transfer-costs.ts");
    expect(matrix).toContain("test/hedera-transfer-costs.test.ts");
    expect(matrix).toMatch(/x402 through HTTP 402/);
    expect(matrix).toMatch(/Wrong-recipient prevention/);
  });

  it("demo script states exact values", () => {
    const script = readRepo("docs/demo-script.md");
    expect(script).toContain(
      "fixed $0.0001 cost for an HBAR transfer and $0.001 for a stablecoin transfer",
    );
  });

  it("does not describe costs only as vague low fees where exact amounts belong", () => {
    const trackedDocs = [
      "README.md",
      "docs/ADR-001-frozen-architecture.md",
      "docs/challenge-compliance-matrix.md",
      "docs/demo-script.md",
      "src/domain/hedera-transfer-costs.ts",
      "src/domain/payment-economics.ts",
      "src/server/page.ts",
    ];
    for (const rel of trackedDocs) {
      const text = readRepo(rel);
      // Allowed elsewhere only if exact amounts also present; ban standalone vague fee marketing.
      if (/low fees?|near-?zero|sub-?cent|cheap payments?/i.test(text)) {
        expect(text).toContain("0.0001");
        expect(text).toContain("0.001");
      }
    }
  });

  it("x402 challenge amount remains reservation amount only", () => {
    // Network fee must not be baked into reservation atomic amounts.
    expect(USDC_RESERVATION_OPTION.amountAtomic).toBe("10000");
    expect(HBAR_RESERVATION_OPTION.amountAtomic).toBe("1000000");
    expect(USDC_RESERVATION_OPTION.amountAtomic).not.toContain("0.001");
    expect(HBAR_RESERVATION_OPTION.amountAtomic).not.toContain("0.0001");
  });
});
