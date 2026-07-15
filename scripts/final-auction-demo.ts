/**
 * Final demonstration CLI (Phase 6B.2).
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
 * Importing this module is side-effect free; main() runs only under direct execution.
 */

import { fileURLToPath } from "node:url";

import { runFinalDemoDryRun } from "../src/final-demo/dry-run";
import { isFinalDemoDryRun } from "../src/final-demo/guards";
import { runFinalDemoLiveExecution } from "../src/final-demo/live-execution";
import { FinalDemoError } from "../src/final-demo/errors";
import {
  HISTORICAL_PHASE5_TOPIC_ID,
  HISTORICAL_TOPIC_DISCLOSURE,
  SYNTHETIC_DATA_DISCLOSURE,
} from "../src/final-demo/constants";

export async function main(): Promise<void> {
  await import("dotenv/config");

  console.log("RouteGuard final auction demonstration");
  console.log(`Disclosure: ${SYNTHETIC_DATA_DISCLOSURE}`);
  console.log(
    `Historical topic ${HISTORICAL_PHASE5_TOPIC_ID}: ${HISTORICAL_TOPIC_DISCLOSURE}`,
  );

  if (isFinalDemoDryRun(process.env)) {
    console.log("Mode: OFFLINE_DRY_RUN (default — no network writes)");
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
    console.log(`  evidence      : ${result.evidencePaths.json}`);
    console.log(
      `  real network writes: none (simulated topicCreates=${result.networkWrites.topicCreates}, hcs=${result.networkWrites.hcsSubmits}, payments=${result.networkWrites.payments})`,
    );
    return;
  }

  console.log("Mode: LIVE_FINAL_DEMO (all live flags detected)");
  try {
    await runFinalDemoLiveExecution({ env: process.env });
  } catch (e) {
    if (e instanceof FinalDemoError && e.code === "LIVE_PATH_REQUIRES_AUDIT") {
      console.error(e.message);
      process.exitCode = 2;
      return;
    }
    throw e;
  }
}

const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] && fileURLToPath(`file://${process.argv[1].replace(/\\/g, "/")}`);
// Robust direct-execution check for Windows paths
const isDirect =
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("final-auction-demo.ts") ||
    process.argv[1].endsWith("final-auction-demo.js") ||
    thisFile === process.argv[1]);

if (isDirect || process.argv[1]?.includes("final-auction-demo")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}

void invoked;
