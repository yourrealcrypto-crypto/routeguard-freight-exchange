/**
 * Final demonstration CLI (Phase 6B.3).
 *
 * Default: OFFLINE_DRY_RUN — zero network writes.
 *
 * Live mode requires ALL of:
 *   ENABLE_FINAL_DEMO_LIVE=true
 *   ENABLE_LIVE_HEDERA=true
 *   ENABLE_LIVE_USDC_PAYMENTS=true
 *   ENABLE_LIVE_HCS_WRITES=true
 *   ENABLE_LIVE_TOPIC_CREATE=true
 *   ENABLE_PHASE6B_LIVE_EXECUTE=true
 *   CONFIRM_FINAL_DEMO=CREATE_NEW_TOPIC_AND_EXECUTE_ONE_USDC_RESERVATION
 *
 * When all flags are set, production real transports are wired and the shared
 * orchestration engine runs (no stub, no post-audit source edit).
 *
 * Importing this module is side-effect free; main() runs only under direct execution.
 */

import { fileURLToPath } from "node:url";

import { formatPaymentEconomicsLines } from "../src/domain/payment-economics";
import {
  HBAR_NETWORK_TRANSFER_COST_USD,
  STABLECOIN_NETWORK_TRANSFER_COST_USD,
} from "../src/domain/hedera-transfer-costs";
import { runFinalDemoDryRun } from "../src/final-demo/dry-run";
import { isFinalDemoDryRun } from "../src/final-demo/guards";
import { runFinalDemoLiveExecution } from "../src/final-demo/live-execution";
import { FinalDemoError } from "../src/final-demo/errors";
import {
  DRY_SYNTHETIC_DATA_DISCLOSURE,
  HISTORICAL_PHASE5_TOPIC_ID,
  HISTORICAL_TOPIC_DISCLOSURE,
  SYNTHETIC_DATA_DISCLOSURE,
} from "../src/final-demo/constants";

export async function main(): Promise<void> {
  await import("dotenv/config");

  console.log("RouteGuard final auction demonstration");
  console.log(
    `Historical topic ${HISTORICAL_PHASE5_TOPIC_ID}: ${HISTORICAL_TOPIC_DISCLOSURE}`,
  );
  console.log(
    "Hedera makes machine-scale payment viable because the challenge specifies a fixed $0.0001 cost for an HBAR transfer and $0.001 for a stablecoin transfer.",
  );
  console.log(
    `Challenge-stated fixed Hedera network transfer costs: HBAR=$${HBAR_NETWORK_TRANSFER_COST_USD}; Stablecoin/HTS=$${STABLECOIN_NETWORK_TRANSFER_COST_USD}`,
  );

  if (isFinalDemoDryRun(process.env)) {
    console.log("Mode: OFFLINE_DRY_RUN (default — no network writes)");
    console.log(`Disclosure: ${DRY_SYNTHETIC_DATA_DISCLOSURE}`);
    const result = await runFinalDemoDryRun();
    console.log("Dry-run COMPLETED");
    console.log(`  attemptId     : ${result.materials.attemptId}`);
    console.log(`  tenderId      : ${result.materials.tenderId}`);
    console.log(`  topicId       : ${result.topic.topicId}`);
    console.log(`  winner        : ${result.winner.carrierId} / ${result.winner.bidId}`);
    console.log(`  evaluatedBidSetHash : ${result.finalHashes.evaluatedBidSetHash}`);
    console.log(`  decisionManifestHash: ${result.finalHashes.decisionManifestHash}`);
    console.log(
      `  ROUTE_RESERVED bytes: ${result.dryRunEnvelopeByteCount} (conservative ${result.conservativeEnvelopeByteCount})`,
    );
    console.log(
      `  settleCalls (facilitator): ${result.settleCallCount ?? "n/a"}`,
    );
    console.log(`  selected rail : ${result.payment.selectedOptionId}`);
    console.log(
      `  reservation payment: ${result.payment.amount} atomic USDC (carrier receives ${result.payment.carrierReceivedAmountAtomic})`,
    );
    console.log(
      `  challenge-stated Hedera transfer cost: $${result.payment.challengeStatedHederaNetworkTransferCostUsd}`,
    );
    for (const line of formatPaymentEconomicsLines(result.payment.economics)) {
      console.log(`  economics     : ${line}`);
    }
    console.log(`  evidence      : ${result.evidencePaths.json}`);
    console.log(
      `  real network writes: none (simulated topicCreates=${result.networkWrites.topicCreates}, hcs=${result.networkWrites.hcsSubmits}, payments=${result.networkWrites.payments})`,
    );
    return;
  }

  console.log("Mode: LIVE_FINAL_DEMO (all live flags detected)");
  console.log(`Disclosure: ${SYNTHETIC_DATA_DISCLOSURE}`);
  console.log("Wiring production transports (topic/HCS/Mirror/x402/facilitator)...");
  const result = await runFinalDemoLiveExecution({
    env: process.env,
    useProductionTransports: true,
  });
  console.log("Live final-demo COMPLETED");
  console.log(`  attemptId     : ${result.materials.attemptId}`);
  console.log(`  topicId       : ${result.topic.topicId}`);
  console.log(`  winner        : ${result.winner.carrierId}`);
  console.log(`  payment tx    : ${result.payment.transactionId}`);
  console.log(`  evidence      : ${result.evidencePaths.json}`);
}

const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] && fileURLToPath(`file://${process.argv[1].replace(/\\/g, "/")}`);
const isDirect =
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("final-auction-demo.ts") ||
    process.argv[1].endsWith("final-auction-demo.js") ||
    thisFile === process.argv[1]);

if (isDirect || process.argv[1]?.includes("final-auction-demo")) {
  main().catch((err) => {
    if (err instanceof FinalDemoError) {
      console.error(`[${err.code}] ${err.message}`);
    } else {
      console.error(err instanceof Error ? err.message : err);
    }
    process.exitCode = 1;
  });
}

void invoked;
