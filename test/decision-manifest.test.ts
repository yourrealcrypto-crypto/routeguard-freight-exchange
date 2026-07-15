import { describe, expect, it } from "vitest";

import {
  evaluateAuction,
  verifyDecisionManifestIntegrity,
} from "../src/auction/decision-manifest";
import { evaluateAllCommitments } from "../src/auction/eligibility";
import {
  computeRulesHash,
  LOWEST_QUALIFIED_PRICE_V1_RULES,
} from "../src/auction/rules";
import { ENGINE_VERSION, SELECTION_POLICY } from "../src/auction/types";
import { canonicalSha256 } from "../src/domain/canonical-hash";
import {
  buildCarrierRegistry,
  buildCommitment,
  buildFullScenario,
  buildHamburgIstanbulTender,
  buildReceiptForBid,
  buildSignedBid,
  EVALUATION_TIMESTAMP,
  ROUTEGUARD_PUBLIC_KEY,
} from "./fixtures/auction-fixtures";

describe("Decision Manifest", () => {
  it("accounts for every commitment including missing full bid", () => {
    const scenario = buildFullScenario();
    const manifest = evaluateAuction({
      tender: scenario.tender,
      commitments: scenario.commitments,
      fullBids: scenario.fullBids,
      acceptanceReceipts: scenario.receipts,
      registry: scenario.registry,
      routeGuardPublicKey: scenario.routeGuardPublicKey,
      evaluationTimestamp: scenario.evaluationTimestamp,
      barrierSequence: 42,
      reconciliationReference: "topic-1:seq-10-31",
    });

    expect(manifest.commitments).toHaveLength(scenario.commitments.length);
    expect(manifest.engineVersion).toBe(ENGINE_VERSION);
    expect(manifest.selectionPolicy).toBe(SELECTION_POLICY);
    expect(manifest.winningBidId).toBe("bid-winner-low");
    expect(manifest.winningBidHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.decisionManifestHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const missing = manifest.commitments.find(
      (c) => c.bidId === "bid-missing-full",
    );
    expect(missing).toEqual(
      expect.objectContaining({
        decision: "REJECTED",
        reasonCodes: ["FULL_BID_MISSING"],
      }),
    );
  });

  it("orders commitments by HCS sequence then bidId", () => {
    const scenario = buildFullScenario();
    const manifest = evaluateAuction({
      tender: scenario.tender,
      commitments: [...scenario.commitments].reverse(),
      fullBids: scenario.fullBids,
      acceptanceReceipts: scenario.receipts,
      registry: scenario.registry,
      routeGuardPublicKey: scenario.routeGuardPublicKey,
      evaluationTimestamp: scenario.evaluationTimestamp,
      barrierSequence: 1,
      reconciliationReference: "ref",
    });

    for (let i = 1; i < manifest.commitments.length; i++) {
      const prev = manifest.commitments[i - 1]!;
      const curr = manifest.commitments[i]!;
      if (prev.hcsSequence === curr.hcsSequence) {
        expect(prev.bidId <= curr.bidId).toBe(true);
      } else {
        expect(prev.hcsSequence).toBeLessThan(curr.hcsSequence);
      }
    }
  });

  it("manifest hash is stable across input reorder", () => {
    const scenario = buildFullScenario();
    const base = {
      tender: scenario.tender,
      fullBids: scenario.fullBids,
      acceptanceReceipts: scenario.receipts,
      registry: scenario.registry,
      routeGuardPublicKey: scenario.routeGuardPublicKey,
      evaluationTimestamp: scenario.evaluationTimestamp,
      barrierSequence: 7,
      reconciliationReference: "stable-ref",
    };
    const m1 = evaluateAuction({
      ...base,
      commitments: scenario.commitments,
    });
    const m2 = evaluateAuction({
      ...base,
      commitments: [...scenario.commitments].reverse(),
    });
    expect(m1.decisionManifestHash).toBe(m2.decisionManifestHash);
    expect(m1.winningBidId).toBe(m2.winningBidId);
  });

  it("no qualified bid yields null winner", () => {
    const tender = buildHamburgIstanbulTender();
    const signed = buildSignedBid({
      bidId: "only-bad",
      carrier: "alpha",
      freightPriceCents: 500_000,
    });
    const receipt = buildReceiptForBid(signed);
    const manifest = evaluateAuction({
      tender,
      commitments: [
        buildCommitment(signed, receipt, 1, "2026-08-01T09:00:00.000Z"),
      ],
      fullBids: new Map([[signed.bid.bidId, signed]]),
      acceptanceReceipts: new Map([[signed.bid.bidId, receipt]]),
      registry: buildCarrierRegistry(),
      routeGuardPublicKey: ROUTEGUARD_PUBLIC_KEY,
      evaluationTimestamp: EVALUATION_TIMESTAMP,
      barrierSequence: 1,
      reconciliationReference: "ref-none",
    });
    expect(manifest.winningBidId).toBeNull();
    expect(manifest.winningBidHash).toBeNull();
  });

  it("verifyDecisionManifestIntegrity passes for authentic manifest", () => {
    const scenario = buildFullScenario();
    const manifest = evaluateAuction({
      tender: scenario.tender,
      commitments: scenario.commitments,
      fullBids: scenario.fullBids,
      acceptanceReceipts: scenario.receipts,
      registry: scenario.registry,
      routeGuardPublicKey: scenario.routeGuardPublicKey,
      evaluationTimestamp: scenario.evaluationTimestamp,
      barrierSequence: 1,
      reconciliationReference: "r",
    });
    const results = evaluateAllCommitments(
      scenario.tender,
      scenario.commitments,
      scenario.fullBids,
      scenario.receipts,
      scenario.registry,
      scenario.routeGuardPublicKey,
      scenario.evaluationTimestamp,
    );
    const check = verifyDecisionManifestIntegrity({
      manifest,
      tender: scenario.tender,
      results,
      evaluationTimestamp: scenario.evaluationTimestamp,
      barrierSequence: 1,
      reconciliationReference: "r",
    });
    expect(check.ok).toBe(true);
  });

  it("rulesHash matches frozen policy document", () => {
    const scenario = buildFullScenario();
    const manifest = evaluateAuction({
      tender: scenario.tender,
      commitments: scenario.commitments,
      fullBids: scenario.fullBids,
      acceptanceReceipts: scenario.receipts,
      registry: scenario.registry,
      routeGuardPublicKey: scenario.routeGuardPublicKey,
      evaluationTimestamp: scenario.evaluationTimestamp,
      barrierSequence: 1,
      reconciliationReference: "r",
    });
    expect(manifest.rulesHash).toBe(computeRulesHash());
    expect(manifest.rulesHash).toBe(
      canonicalSha256(LOWEST_QUALIFIED_PRICE_V1_RULES),
    );
  });
});
