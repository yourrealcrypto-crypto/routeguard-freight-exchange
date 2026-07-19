/**
 * Winning Demo report generator tests — read-only over evidence shapes.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HEDERA_TRANSFER_COSTS,
  challengeStatedNetworkTransferCostUsd,
} from "../src/domain/hedera-transfer-costs";
import {
  DRY_SYNTHETIC_DATA_DISCLOSURE,
  FINAL_DEMO_MODE_DRY,
  FINAL_DEMO_MODE_LIVE,
  HEDERA_NON_AFFILIATION_DISCLAIMER,
  PRIVATE_BID_COMMITMENT_SENTENCE,
} from "../src/final-demo/constants";
import {
  assertLiveEvidenceReady,
  FinalDemoReportError,
  renderFinalDemoReportHtml,
  type FinalDemoEvidenceJson,
} from "../scripts/render-final-demo-report";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function baseSequences() {
  return [1, 2, 3, 4, 5].map((sequence) => ({
    sequence,
    label:
      sequence === 1
        ? "AUCTION_OPEN"
        : sequence === 2
          ? "BID_COMMITMENT_ALPHA"
          : sequence === 3
            ? "BID_COMMITMENT_BETA"
            : sequence === 4
              ? "AUCTION_CLOSE_BARRIER"
              : "ROUTE_RESERVED",
    envelopeHash: `sha256:${String(sequence).repeat(64).slice(0, 64)}`,
    transactionId: `0.0.9197513@1784500000.10000000${sequence}`,
    consensusTimestamp: `2026-08-01T12:00:0${sequence}.000000000Z`,
  }));
}

function dryEvidence(
  overrides: Partial<FinalDemoEvidenceJson> = {},
): FinalDemoEvidenceJson {
  return {
    mode: FINAL_DEMO_MODE_DRY,
    disclosure: DRY_SYNTHETIC_DATA_DISCLOSURE,
    materials: {
      attemptId: "final-demo-dry-test",
      shortAttemptId: "drytest01",
      tenderId: "tender-final-drytest01",
      bidAlphaId: "bid-alpha-final-drytest01",
      bidBetaId: "bid-beta-final-drytest01",
      reservationId: "reservation-final-drytest01",
    },
    topic: {
      topicId: "0.0.9700000",
      topicCreateTransactionId: "0.0.9197513@1784500000.1",
      topicMemo: "routeguard-final:drytest01",
    },
    sequences: baseSequences(),
    auctionEndsAt: "2026-08-01T12:05:00.000Z",
    barrierConsensusTimestamp: "2026-08-01T12:00:04.000000000Z",
    finalHashes: {
      tenderHash: "sha256:" + "11".repeat(32),
      winningBidHash: "sha256:" + "22".repeat(32),
      evaluatedBidSetHash: "sha256:" + "33".repeat(32),
      decisionManifestHash: "sha256:" + "44".repeat(32),
    },
    winner: {
      bidId: "bid-alpha-final-drytest01",
      carrierId: "carrier-alpha",
      carrierAccount: "0.0.9215954",
    },
    payment: {
      selectedOptionId: "USDC",
      payer: "0.0.9197513",
      receiver: "0.0.9215954",
      token: "0.0.429274",
      amount: "10000",
      carrierReceivedAmountAtomic: "10000",
      challengeStatedHederaNetworkTransferCostUsd: "0.001",
      economics: {
        reservationPaymentDisplayAmount: "0.01",
        reservationPaymentCurrencyLabel: "USDC",
        facilitatorFee: { status: "NOT_MODELED_AS_SEPARATE_X402_CHARGE" },
        routeGuardPlatformFee: { status: "NOT_MODELED_AS_SEPARATE_CHARGE" },
      },
      transactionId: "0.0.9197513@1784500100.100000000",
      consensusTimestamp: "2026-08-01T12:00:05.000000000Z",
    },
    routeReserved: {
      sequence: 5,
      envelopeHash: "sha256:" + "55".repeat(32),
      byteCount: 900,
      transactionId: null,
      consensusTimestamp: "2026-08-01T12:00:05.100000000Z",
    },
    reservationRecordHash: "sha256:" + "66".repeat(32),
    networkWrites: {
      topicCreates: 1,
      hcsSubmits: 5,
      payments: 1,
      realNetwork: false,
    },
    settleCallCount: 1,
    hashScanTopic: null,
    hashScanPayment: null,
    hashScanTopicCreate: null,
    ...overrides,
  };
}

function liveEvidence(
  overrides: Partial<FinalDemoEvidenceJson> = {},
): FinalDemoEvidenceJson {
  return {
    ...dryEvidence(),
    mode: FINAL_DEMO_MODE_LIVE,
    disclosure:
      "All auction and carrier data in this final demonstration is deliberately synthetic and publicly disclosed for reproducibility. The Hedera payment and consensus transactions are real testnet transactions.",
    networkWrites: {
      topicCreates: 1,
      hcsSubmits: 5,
      payments: 1,
      realNetwork: true,
    },
    hashScanTopic: "https://hashscan.io/testnet/topic/0.0.9700000",
    hashScanPayment:
      "https://hashscan.io/testnet/transaction/0.0.9197513@1784500100.100000000",
    hashScanTopicCreate:
      "https://hashscan.io/testnet/transaction/0.0.9197513@1784500000.1",
    ...overrides,
  };
}

describe("Winning Demo report generator", () => {
  it("dry report has no active HashScan URLs", () => {
    const html = renderFinalDemoReportHtml(dryEvidence());
    expect(html).not.toMatch(/href=["']https:\/\/hashscan\.io\//i);
    expect(html).toMatch(/OFFLINE_DRY_RUN/);
    expect(html).toMatch(/zero network writes/i);
    expect(html).toMatch(/simulated/i);
  });

  it("dry and live reports cannot be confused", () => {
    const dry = renderFinalDemoReportHtml(dryEvidence());
    const live = renderFinalDemoReportHtml(liveEvidence());
    expect(dry).toMatch(/OFFLINE_DRY_RUN/);
    expect(dry).not.toMatch(/LIVE_FINAL_DEMO — real Hedera/);
    expect(live).toMatch(/LIVE_FINAL_DEMO/);
    expect(live).not.toMatch(/OFFLINE_DRY_RUN — rehearsal only/);
    expect(live).toMatch(/href=["']https:\/\/hashscan\.io\/testnet\/topic\//i);
  });

  it("live generator rejects dry evidence", () => {
    expect(() => assertLiveEvidenceReady(dryEvidence())).toThrow(
      /rejects OFFLINE_DRY_RUN/i,
    );
    expect(() => assertLiveEvidenceReady(dryEvidence())).toThrow(
      FinalDemoReportError,
    );
  });

  it("exact fee strings come from the domain source", () => {
    const html = renderFinalDemoReportHtml(dryEvidence());
    expect(challengeStatedNetworkTransferCostUsd("USDC")).toBe(
      HEDERA_TRANSFER_COSTS.HTS_STABLECOIN.networkFeeUsd,
    );
    expect(challengeStatedNetworkTransferCostUsd("HBAR")).toBe(
      HEDERA_TRANSFER_COSTS.HBAR.networkFeeUsd,
    );
    expect(html).toContain(`$${HEDERA_TRANSFER_COSTS.HTS_STABLECOIN.networkFeeUsd}`);
    expect(html).toContain(`$${HEDERA_TRANSFER_COSTS.HBAR.networkFeeUsd}`);
  });

  it("settlement appears before reservation in the timeline", () => {
    const html = renderFinalDemoReportHtml(dryEvidence());
    const payIdx = html.indexOf("6 · x402 payment");
    const resIdx = html.indexOf("7 · HCS");
    const arrowIdx = html.indexOf("Settlement precedes reservation");
    expect(payIdx).toBeGreaterThan(0);
    expect(resIdx).toBeGreaterThan(payIdx);
    expect(arrowIdx).toBeGreaterThan(resIdx);
  });

  it("sequences 1–5 appear", () => {
    const html = renderFinalDemoReportHtml(dryEvidence());
    for (const n of [1, 2, 3, 4, 5]) {
      expect(html).toMatch(new RegExp(`<th scope="row">${n}</th>`));
    }
    expect(html).toMatch(/HCS sequences 1–5|sequences 1–5/i);
  });

  it("disclaimer and differentiator exist", () => {
    const html = renderFinalDemoReportHtml(dryEvidence());
    expect(html).toContain(HEDERA_NON_AFFILIATION_DISCLAIMER);
    expect(html).toContain(PRIVATE_BID_COMMITMENT_SENTENCE);
  });

  it("does not render secret/private evidence fields", () => {
    const html = renderFinalDemoReportHtml(dryEvidence());
    expect(html).not.toMatch(/privateKey|signingPrivateKey|SHIPPER_PRIVATE_KEY|PAYMENT-SIGNATURE/i);
  });

  it("unsupported evidence schema fails closed", () => {
    expect(() =>
      renderFinalDemoReportHtml({
        mode: "NOT_A_MODE",
      } as FinalDemoEvidenceJson),
    ).toThrow(/Unsupported evidence mode|schema/i);
  });

  it("live fail-closed on missing payment, topic, sequences, settlement, reservation", () => {
    expect(() =>
      assertLiveEvidenceReady(
        liveEvidence({ payment: { ...liveEvidence().payment!, transactionId: "" } }),
      ),
    ).toThrow(/payment transaction/i);

    expect(() =>
      assertLiveEvidenceReady(
        liveEvidence({ topic: { topicId: "PLACEHOLDER" } }),
      ),
    ).toThrow(/topic/i);

    expect(() =>
      assertLiveEvidenceReady(liveEvidence({ sequences: baseSequences().slice(0, 3) })),
    ).toThrow(/sequences/i);

    expect(() =>
      assertLiveEvidenceReady(
        liveEvidence({
          payment: {
            ...liveEvidence().payment!,
            consensusTimestamp: "",
          },
        }),
      ),
    ).toThrow(/settlement confirmation/i);

    const missingReservation = liveEvidence();
    delete (missingReservation as { routeReserved?: unknown }).routeReserved;
    expect(() => assertLiveEvidenceReady(missingReservation)).toThrow(
      /reservation proof/i,
    );
  });

  it("writes dry report without hashscan href when given a fixture file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rg-report-"));
    dirs.push(dir);
    const evidencePath = path.join(dir, "dry.json");
    writeFileSync(evidencePath, JSON.stringify(dryEvidence()), "utf8");
    const mod = await import("../scripts/render-final-demo-report");
    const evidence = mod.loadFinalDemoEvidence(evidencePath);
    expect(evidence.mode).toBe(FINAL_DEMO_MODE_DRY);
    const out = path.join(dir, "out.html");
    mod.writeFinalDemoReport({
      evidencePath,
      outputPath: out,
      expectMode: FINAL_DEMO_MODE_DRY,
    });
    const { readFileSync } = await import("node:fs");
    const html = readFileSync(out, "utf8");
    expect(html).not.toMatch(/href=["']https:\/\/hashscan\.io\//i);
  });
});
