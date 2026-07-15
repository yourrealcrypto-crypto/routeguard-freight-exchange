/**
 * Phase 6B controlled live-reservation script.
 *
 * DEFAULT: OFFLINE_DRY_RUN (no payment, no HCS, no external webhook).
 *
 * Live execution requires ALL independent guards (process-scoped):
 *   ENABLE_LIVE_RESERVATION=true
 *   ENABLE_LIVE_HEDERA=true
 *   ENABLE_LIVE_USDC_PAYMENTS=true
 *   ENABLE_LIVE_HCS_WRITES=true
 *   CONFIRM_PHASE6B_RESERVATION=EXECUTE_ONE_USDC_ROUTE_RESERVATION
 *
 * Plus explicit execute latch:
 *   ENABLE_PHASE6B_LIVE_EXECUTE=true
 *
 * Settlement authority is always ReservationService (never direct settle).
 */

import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTHORITATIVE_HASHES,
  CONFIRM_PHASE6B_RESERVATION_VALUE,
  PHASE6B_DRY_RUN_ATTEMPT_PATH,
  PHASE6B_DRY_RUN_EVIDENCE_JSON,
  PHASE6B_DRY_RUN_EVIDENCE_MD,
  PHASE6B_HCS_TOPIC,
  PHASE6B_RESERVATION_ID,
} from "../src/reservation/live/constants";
import { runPhase6bDryRun } from "../src/reservation/live/dry-run";
import { assertPhase6bLiveExecutionAuthorized } from "../src/reservation/live/guards";
import { Phase6bAttemptError } from "../src/reservation/live/attempt-store";
import { runPhase6bLiveExecution } from "../src/reservation/live/live-execution";
import { createLivePayerPaymentPayloadFactory } from "../src/reservation/live/payer-payload";

function writeJson(filePath: string, data: unknown): void {
  const absolute = path.resolve(filePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  const tmp = `${absolute}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmp, absolute);
}

function writeText(filePath: string, content: string): void {
  const absolute = path.resolve(filePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

export async function main(): Promise<void> {
  await import("dotenv/config");

  let liveAuthorized = false;
  try {
    assertPhase6bLiveExecutionAuthorized();
    liveAuthorized = true;
  } catch {
    liveAuthorized = false;
  }

  // Extra latch so default operation never fires live side effects until audited.
  const liveExecuteLatch = process.env.ENABLE_PHASE6B_LIVE_EXECUTE === "true";

  if (liveAuthorized && liveExecuteLatch) {
    console.log(
      "Phase 6B LIVE execution path engaged (ReservationService only)",
    );
    const webhookKey = process.env.WEBHOOK_SIGNING_PRIVATE_KEY?.trim();
    if (!webhookKey) {
      throw new Phase6bAttemptError(
        "WEBHOOK_SIGNING_PRIVATE_KEY required for live execution",
        "WEBHOOK_KEY_REQUIRED",
      );
    }
    await runPhase6bLiveExecution({
      env: process.env,
      webhookSigningPrivateKey: webhookKey,
      createPaymentPayload: createLivePayerPaymentPayloadFactory({
        env: process.env,
      }),
    });
    return;
  }

  if (liveAuthorized && !liveExecuteLatch) {
    console.log(
      [
        "All five live guards are set, but ENABLE_PHASE6B_LIVE_EXECUTE is not true.",
        "Live execution code is implemented (runPhase6bLiveExecution) and testable offline.",
        "Refusing unattended live side effects. Running OFFLINE_DRY_RUN instead.",
        `Confirmation phrase (insufficient alone): ${CONFIRM_PHASE6B_RESERVATION_VALUE}`,
      ].join("\n"),
    );
  }

  console.log("Phase 6B — OFFLINE_DRY_RUN (zero network writes)");
  console.log(`Reservation ID: ${PHASE6B_RESERVATION_ID}`);
  console.log(`Expected topic: ${PHASE6B_HCS_TOPIC}`);

  const result = await runPhase6bDryRun({
    env: process.env,
    attemptPath: PHASE6B_DRY_RUN_ATTEMPT_PATH,
  });

  const evidence = {
    status: "OFFLINE_DRY_RUN_COMPLETE",
    mode: "OFFLINE_DRY_RUN",
    network: "hedera:testnet",
    reservationId: result.reservationId,
    tenderId: result.reconstructed.tenderId,
    winningBidId: result.reconstructed.winningBidId,
    winningCarrierAccount: result.reconstructed.winningCarrierAccount,
    tenderHash: result.reconstructed.tenderHash,
    winningBidHash: result.reconstructed.winningBidHash,
    evaluatedBidSetHash: result.reconstructed.evaluatedBidSetHash,
    decisionManifestHash: result.reconstructed.decisionManifestHash,
    authoritativeHashes: AUTHORITATIVE_HASHES,
    hcsTopicId: result.reconstructed.hcsTopicId,
    closeBarrierSequence: result.reconstructed.closeBarrierSequence,
    selectedOptionId: result.selectedOptionId,
    payer: result.binding.payer,
    receiver: result.binding.receiver,
    token: result.binding.token,
    amountAtomic: result.binding.amount,
    challenge: result.challenge,
    conservativeEnvelopeByteCount: result.conservativeEnvelopeByteCount,
    dryRunEnvelopeByteCount: result.dryRunEnvelopeByteCount,
    conservativeMargin:
      result.hcsMaxBytes - result.conservativeEnvelopeByteCount,
    hcsMaxMessageBytes: result.hcsMaxBytes,
    envelopeWithinLimit: result.envelopeWithinLimit,
    topicPreflight: result.topicPreflight,
    networkWrites: result.networkWrites,
    notes: [
      "OFFLINE_DRY_RUN only — not live evidence.",
      "No payment payload, facilitator settle, HCS submit, or external webhook.",
      "Dry-run attempt file is separate from live attempt file.",
      "Authoritative hashes reproduced from sealed phase5-authoritative-source.json via createAuctionClosureProof.",
      "No public-identity-only validation path exists.",
    ],
  };

  writeJson(PHASE6B_DRY_RUN_EVIDENCE_JSON, evidence);
  writeText(
    PHASE6B_DRY_RUN_EVIDENCE_MD,
    [
      "# Phase 6B Offline Dry-Run Evidence",
      "",
      `- Mode: **OFFLINE_DRY_RUN** (not live)`,
      `- Reservation: \`${result.reservationId}\``,
      `- USDC only; payer \`${result.binding.payer}\` → receiver \`${result.binding.receiver}\``,
      `- evaluatedBidSetHash: \`${result.reconstructed.evaluatedBidSetHash}\``,
      `- decisionManifestHash: \`${result.reconstructed.decisionManifestHash}\``,
      `- Conservative envelope: **${result.conservativeEnvelopeByteCount}** bytes (margin ${result.hcsMaxBytes - result.conservativeEnvelopeByteCount})`,
      `- Dry-run placeholder envelope: **${result.dryRunEnvelopeByteCount}** bytes`,
      `- Limit: ${result.hcsMaxBytes}`,
      `- settleCalls=${result.networkWrites.facilitatorSettle} hcsPublish=${result.networkWrites.hcsPublish}`,
      "",
    ].join("\n"),
  );

  console.log("OFFLINE_DRY_RUN_COMPLETE");
  console.log(
    `  conservativeEnvelopeByteCount=${result.conservativeEnvelopeByteCount}`,
  );
  console.log(
    `  conservativeMargin=${result.hcsMaxBytes - result.conservativeEnvelopeByteCount}`,
  );
  console.log(`  dryRunEnvelopeByteCount=${result.dryRunEnvelopeByteCount}`);
  console.log(`  evaluatedBidSetHash=${result.reconstructed.evaluatedBidSetHash}`);
  console.log(
    `  decisionManifestHash=${result.reconstructed.decisionManifestHash}`,
  );
  console.log(`  settleCalls=${result.networkWrites.facilitatorSettle}`);
  console.log(`  hcsPublishCalls=${result.networkWrites.hcsPublish}`);
}

const isDirect =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isDirect) {
  main().catch((e) => {
    console.error(
      e instanceof Phase6bAttemptError
        ? `${e.code}: ${e.message}`
        : e instanceof Error
          ? e.message
          : String(e),
    );
    process.exitCode = 1;
  });
}
