/**
 * RouteGuard Phase 5 live HCS auction demo (Hedera Testnet only).
 *
 * Controlled write budget:
 *   1 × TopicCreateTransaction
 *   4 × TopicMessageSubmitTransaction (OPEN, COMMITMENT A, COMMITMENT B, BARRIER)
 *
 * Requires process-scoped:
 *   ENABLE_LIVE_HEDERA=true
 *   ENABLE_LIVE_HCS_WRITES=true
 *   CONFIRM_HCS_DEMO_WRITE=ONE_TOPIC_FOUR_MESSAGES
 *
 * Does NOT execute HBAR/USDC payments or token associations.
 * Importing this module is side-effect free; main() runs only under direct execution.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAuctionClosureProof,
  isVerifiedAuctionClosureProof,
} from "../src/auction/closure-proof";
import { verifyDecisionManifestIntegrity } from "../src/auction/decision-manifest";
import { computeRulesHash } from "../src/auction/rules";
import {
  createAuctionMachine,
  transitionToBidding,
  transitionToClosed,
  transitionToOpen,
  transitionToReconciliation,
  transitionToWinnerSelected,
} from "../src/auction/state-machine";
import { ENGINE_VERSION, SELECTION_POLICY } from "../src/auction/types";
import {
  acceptanceReceiptHash,
  signAcceptanceReceipt,
} from "../src/domain/acceptance-receipt";
import { bidHash, signCarrierBid, type CarrierBid } from "../src/domain/bid";
import {
  InMemoryCarrierRegistry,
  type CarrierRecord,
} from "../src/domain/carrier";
import { isCommitmentTimely } from "../src/domain/commitment-evidence";
import {
  HBAR_ASSET,
  USDC_TESTNET_ASSET,
} from "../src/domain/payment-option";
import { parseFreightTender, tenderHash } from "../src/domain/tender";
import {
  assertSafeToStartWrites,
  createPlannedAttempt,
  emptyMessageRecord,
  loadAttempt,
  persistAttempt,
  transitionAttempt,
  DEFAULT_ATTEMPT_PATH,
} from "../src/hcs/attempt-store";
import {
  createAuctionOpenEnvelope,
  createBidCommitmentEnvelope,
  createCloseBarrierEnvelope,
  envelopeHash,
} from "../src/hcs/message-envelope";
import { MirrorNodeClient } from "../src/hcs/mirror-node-client";
import { reconcileMirrorMessages } from "../src/hcs/reconciliation";
import {
  assertLiveWriteAuthorized,
  HcsTopicClient,
  loadAndVerifyOperator,
} from "../src/hcs/topic-client";
import {
  CLOSE_POLICY,
  COMMITMENT_SCHEMA_VERSION,
  HCS_DEMO_CARRIER_PAYMENT_ACCOUNT,
  HCS_DEMO_OPERATOR_ACCOUNT,
  type HcsAttemptRecord,
  type HcsEnvelope,
  type ObservedHcsMessage,
} from "../src/hcs/types";
import {
  CARRIER_KEYS,
  ROUTEGUARD_PRIVATE_KEY,
  ROUTEGUARD_PUBLIC_KEY,
} from "../test/fixtures/auction-fixtures";

const EVIDENCE_JSON = path.join("evidence", "hcs-auction-demo.json");
const EVIDENCE_MD = path.join("evidence", "hcs-auction-demo.md");
const TOPIC_MEMO = "RouteGuard Freight Exchange Phase 5 HCS auction demo";

/** Auction open → deadline window (seconds). */
const AUCTION_WINDOW_SECONDS = 75;
/** Extra wait after auctionEndsAt before barrier (ms). */
const BARRIER_SAFETY_MARGIN_MS = 5_000;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function utcNowIso(): string {
  // millisecond precision ISO ending with Z
  return new Date().toISOString().replace(/\.\d{3}Z$/, (m) =>
    m.replace("Z", "Z"),
  );
}

function addSecondsIso(iso: string, seconds: number): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid ISO for addSeconds: ${iso}`);
  }
  return new Date(ms + seconds * 1000).toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashScanTx(sdkTransactionId: string): string {
  return `https://hashscan.io/testnet/transaction/${sdkTransactionId}`;
}

function hashScanTopic(topicId: string): string {
  return `https://hashscan.io/testnet/topic/${topicId}`;
}

function paymentOptions(accountId: string) {
  return [
    {
      optionId: "USDC" as const,
      scheme: "exact" as const,
      network: "hedera:testnet" as const,
      asset: USDC_TESTNET_ASSET,
      amountAtomic: "10000",
      payTo: accountId,
    },
    {
      optionId: "HBAR" as const,
      scheme: "exact" as const,
      network: "hedera:testnet" as const,
      asset: HBAR_ASSET,
      amountAtomic: "1000000",
      payTo: accountId,
    },
  ];
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

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

  const network = process.env.HEDERA_NETWORK?.trim() || "hedera:testnet";
  if (network !== "hedera:testnet") {
    throw new Error(`Unsupported network "${network}". HCS demo is testnet-only.`);
  }

  // Live-write authorization (process-scoped only — do not edit .env)
  assertLiveWriteAuthorized();

  const operatorAccount = requireEnv("SHIPPER_ACCOUNT_ID");
  const operatorKey = requireEnv("SHIPPER_PRIVATE_KEY");
  if (operatorAccount !== HCS_DEMO_OPERATOR_ACCOUNT) {
    throw new Error(
      `Operator account must be ${HCS_DEMO_OPERATOR_ACCOUNT}, got ${operatorAccount}`,
    );
  }

  const operator = loadAndVerifyOperator(operatorAccount, operatorKey);

  // Durable attempt guard
  const existing = loadAttempt(DEFAULT_ATTEMPT_PATH);
  assertSafeToStartWrites(existing);

  const runId = `hcs-demo-${Date.now()}-${randomHex(4)}`;
  const prepNow = utcNowIso();
  const auctionEndsAt = addSecondsIso(prepNow, AUCTION_WINDOW_SECONDS);
  const pickupEarliest = addSecondsIso(auctionEndsAt, 24 * 3600);
  const pickupLatest = addSecondsIso(pickupEarliest, 12 * 3600);
  const deliveryDeadline = addSecondsIso(pickupLatest, 3 * 24 * 3600);
  const bidValidUntil = addSecondsIso(auctionEndsAt, 12 * 3600);

  const tender = parseFreightTender({
    tenderId: `tender-ham-ist-hcs-${runId.slice(-8)}`,
    shipperId: "shipper-nordic-logistics",
    origin: "Hamburg, DE",
    destination: "Istanbul, TR",
    cargo: {
      type: "electronics",
      weightKg: 8200,
      pallets: 12,
      dangerousGoods: false,
    },
    requiredEquipment: "Curtainsider",
    pickupWindow: {
      earliest: pickupEarliest,
      latest: pickupLatest,
    },
    deliveryDeadline,
    auctionEndsAt,
    maximumFreightPriceCents: 400_000,
    selectionPolicy: SELECTION_POLICY,
    version: 1,
  });
  const tHash = tenderHash(tender);
  const rulesHash = computeRulesHash();

  let attempt: HcsAttemptRecord = createPlannedAttempt({
    runId,
    plannedTenderId: tender.tenderId,
    plannedTenderHash: tHash,
    plannedAuctionEndsAt: auctionEndsAt,
  });
  persistAttempt(attempt, DEFAULT_ATTEMPT_PATH);

  // Local private bids (never published to HCS)
  const registry = new InMemoryCarrierRegistry([
    {
      carrierId: CARRIER_KEYS.alpha.carrierId,
      carrierAccountId: HCS_DEMO_CARRIER_PAYMENT_ACCOUNT,
      signingPublicKey: CARRIER_KEYS.alpha.publicKey,
      active: true,
      allowedEquipment: ["Curtainsider", "Box"],
      registryVersion: 1,
    } satisfies CarrierRecord,
    {
      carrierId: CARRIER_KEYS.beta.carrierId,
      carrierAccountId: CARRIER_KEYS.beta.accountId,
      signingPublicKey: CARRIER_KEYS.beta.publicKey,
      active: true,
      allowedEquipment: ["Curtainsider"],
      registryVersion: 1,
    } satisfies CarrierRecord,
  ]);

  const bidABody: CarrierBid = {
    bidId: `bid-a-${runId.slice(-6)}`,
    tenderId: tender.tenderId,
    carrierId: CARRIER_KEYS.alpha.carrierId,
    carrierAccountId: HCS_DEMO_CARRIER_PAYMENT_ACCOUNT,
    freightPriceCents: 350_000,
    equipment: "Curtainsider",
    proposedPickupAt: addSecondsIso(pickupEarliest, 3600),
    estimatedDelivery: addSecondsIso(pickupLatest, 48 * 3600),
    capacityConfirmed: true,
    bidValidUntil,
    reservationPaymentOptions: paymentOptions(HCS_DEMO_CARRIER_PAYMENT_ACCOUNT),
    commitmentSalt: randomHex(32),
    nonce: `nonce-a-${randomHex(8)}`,
    version: 1,
  };
  const bidBBody: CarrierBid = {
    bidId: `bid-b-${runId.slice(-6)}`,
    tenderId: tender.tenderId,
    carrierId: CARRIER_KEYS.beta.carrierId,
    carrierAccountId: CARRIER_KEYS.beta.accountId,
    freightPriceCents: 375_000,
    equipment: "Curtainsider",
    proposedPickupAt: addSecondsIso(pickupEarliest, 7200),
    estimatedDelivery: addSecondsIso(pickupLatest, 36 * 3600),
    capacityConfirmed: true,
    bidValidUntil,
    reservationPaymentOptions: paymentOptions(CARRIER_KEYS.beta.accountId),
    commitmentSalt: randomHex(32),
    nonce: `nonce-b-${randomHex(8)}`,
    version: 1,
  };

  const signedA = signCarrierBid(bidABody, CARRIER_KEYS.alpha.privateKey);
  const signedB = signCarrierBid(bidBBody, CARRIER_KEYS.beta.privateKey);
  const acceptAtA = utcNowIso();
  const receiptA = signAcceptanceReceipt(
    {
      receiptId: `receipt-${signedA.bid.bidId}`,
      tenderId: tender.tenderId,
      bidId: signedA.bid.bidId,
      bidHash: bidHash(signedA.bid),
      acceptedAt: acceptAtA,
      version: 1,
    },
    ROUTEGUARD_PRIVATE_KEY,
  );
  const acceptAtB = utcNowIso();
  const receiptB = signAcceptanceReceipt(
    {
      receiptId: `receipt-${signedB.bid.bidId}`,
      tenderId: tender.tenderId,
      bidId: signedB.bid.bidId,
      bidHash: bidHash(signedB.bid),
      acceptedAt: acceptAtB,
      version: 1,
    },
    ROUTEGUARD_PRIVATE_KEY,
  );

  const bidHashA = bidHash(signedA.bid);
  const bidHashB = bidHash(signedB.bid);
  const receiptHashA = acceptanceReceiptHash(receiptA.receipt);
  const receiptHashB = acceptanceReceiptHash(receiptB.receipt);

  const envMeta = {
    runId,
    tenderId: tender.tenderId,
    tenderVersion: tender.version,
    tenderHash: tHash,
  };

  const openEnvelope = createAuctionOpenEnvelope({
    ...envMeta,
    createdAt: utcNowIso(),
    payload: {
      tenderId: tender.tenderId,
      tenderVersion: tender.version,
      tenderHash: tHash,
      auctionEndsAt,
      selectionPolicy: SELECTION_POLICY,
      engineVersion: ENGINE_VERSION,
      rulesHash,
    },
  });

  const commitmentAEnvelope = createBidCommitmentEnvelope({
    ...envMeta,
    createdAt: utcNowIso(),
    payload: {
      bidId: signedA.bid.bidId,
      carrierId: signedA.bid.carrierId,
      bidHash: bidHashA,
      acceptanceReceiptHash: receiptHashA,
      bidVersion: signedA.bid.version,
      commitmentSchemaVersion: COMMITMENT_SCHEMA_VERSION,
    },
  });

  const commitmentBEnvelope = createBidCommitmentEnvelope({
    ...envMeta,
    createdAt: utcNowIso(),
    payload: {
      bidId: signedB.bid.bidId,
      carrierId: signedB.bid.carrierId,
      bidHash: bidHashB,
      acceptanceReceiptHash: receiptHashB,
      bidVersion: signedB.bid.version,
      commitmentSchemaVersion: COMMITMENT_SCHEMA_VERSION,
    },
  });

  const commitmentAHash = envelopeHash(commitmentAEnvelope);
  const commitmentBHash = envelopeHash(commitmentBEnvelope);

  const client = new HcsTopicClient({ maxTopicCreates: 1, maxMessageSubmits: 4 });
  const mirror = new MirrorNodeClient();

  const observedMessages: ObservedHcsMessage[] = [];
  let topicId = "";
  let topicCreateTxId = "";

  try {
    client.connect(operator);

    // --- Topic create ---
    console.log("Creating HCS topic...");
    const topicResult = await client.createTopic(TOPIC_MEMO);
    topicId = topicResult.topicId;
    topicCreateTxId = topicResult.transactionId;
    console.log(`  topicId     : ${topicId}`);
    console.log(`  transaction : ${topicCreateTxId}`);
    console.log(`  hashscan    : ${hashScanTopic(topicId)}`);

    attempt = transitionAttempt(attempt, "TOPIC_CREATED", {
      topicId,
      topicCreateTransactionId: topicCreateTxId,
      topicMemo: TOPIC_MEMO,
    });
    persistAttempt(attempt, DEFAULT_ATTEMPT_PATH);

    // Confirm topic on Mirror (best-effort poll)
    await sleep(2000);

    async function submitAndConfirm(
      label: string,
      messageType: "AUCTION_OPEN" | "BID_COMMITMENT" | "AUCTION_CLOSE_BARRIER",
      envelope: HcsEnvelope,
      nextStatus: HcsAttemptRecord["status"],
      messageKey: "open" | "commitmentA" | "commitmentB" | "barrier",
    ): Promise<ObservedHcsMessage> {
      // Commitments must be before auctionEndsAt
      if (messageType === "BID_COMMITMENT") {
        if (Date.now() >= Date.parse(auctionEndsAt)) {
          throw new Error(
            `Cannot submit ${label}: auctionEndsAt ${auctionEndsAt} already passed`,
          );
        }
      }

      console.log(`Submitting ${label}...`);
      const result = await client.submitMessage(topicId, envelope);
      console.log(`  transaction : ${result.transactionId}`);
      console.log(`  envelope    : ${result.envelopeHash}`);

      const rec = emptyMessageRecord(messageType, label);
      rec.transactionId = result.transactionId;
      rec.envelopeHash = result.envelopeHash;
      rec.submittedAt = utcNowIso();

      attempt = transitionAttempt(attempt, nextStatus, {
        messages: {
          ...attempt.messages,
          [messageKey]: rec,
        },
      });
      persistAttempt(attempt, DEFAULT_ATTEMPT_PATH);

      const observed = await mirror.waitForEnvelopeHash(
        topicId,
        result.envelopeHash,
        { timeoutMs: 120_000, pollIntervalMs: 1500 },
      );
      console.log(`  sequence    : ${observed.sequence}`);
      console.log(`  consensus   : ${observed.consensusTimestamp}`);

      rec.sequence = observed.sequence;
      rec.consensusTimestamp = observed.consensusTimestamp;
      attempt = transitionAttempt(attempt, nextStatus, {
        messages: {
          ...attempt.messages,
          [messageKey]: rec,
        },
      });
      persistAttempt(attempt, DEFAULT_ATTEMPT_PATH);

      observedMessages.push(observed);
      return observed;
    }

    await submitAndConfirm(
      "AUCTION_OPEN",
      "AUCTION_OPEN",
      openEnvelope,
      "OPEN_SUBMITTED",
      "open",
    );

    await submitAndConfirm(
      "BID_COMMITMENT A",
      "BID_COMMITMENT",
      commitmentAEnvelope,
      "COMMITMENT_A_SUBMITTED",
      "commitmentA",
    );

    await submitAndConfirm(
      "BID_COMMITMENT B",
      "BID_COMMITMENT",
      commitmentBEnvelope,
      "COMMITMENT_B_SUBMITTED",
      "commitmentB",
    );

    // Wait until auctionEndsAt + safety margin
    const endsMs = Date.parse(auctionEndsAt);
    const waitUntil = endsMs + BARRIER_SAFETY_MARGIN_MS;
    const remaining = waitUntil - Date.now();
    if (remaining > 0) {
      console.log(
        `Waiting ${Math.ceil(remaining / 1000)}s until after auctionEndsAt (${auctionEndsAt}) + safety margin...`,
      );
      await sleep(remaining);
    }

    const barrierEnvelope = createCloseBarrierEnvelope({
      ...envMeta,
      createdAt: utcNowIso(),
      payload: {
        barrierId: `barrier-${runId.slice(-8)}`,
        tenderId: tender.tenderId,
        tenderVersion: tender.version,
        tenderHash: tHash,
        auctionEndsAt,
        expectedCommitmentCount: 2,
        commitmentEnvelopeHashes: [commitmentAHash, commitmentBHash],
        closePolicy: CLOSE_POLICY,
      },
    });

    const barrierObs = await submitAndConfirm(
      "AUCTION_CLOSE_BARRIER",
      "AUCTION_CLOSE_BARRIER",
      barrierEnvelope,
      "BARRIER_SUBMITTED",
      "barrier",
    );

    if (client.getSubmitCount() !== 4) {
      throw new Error(
        `Expected exactly 4 message submits, got ${client.getSubmitCount()}`,
      );
    }
    if (client.getTopicCreateCount() !== 1) {
      throw new Error(
        `Expected exactly 1 topic create, got ${client.getTopicCreateCount()}`,
      );
    }

    // --- Mirror reconciliation ---
    console.log("Reconciling Mirror Node messages...");
    const rawMessages = await mirror.waitForTopicMessages(topicId, 4, {
      timeoutMs: 60_000,
    });
    const allObserved = mirror.decodeAll(topicId, rawMessages);

    const reconciled = reconcileMirrorMessages({
      topicId,
      messages: allObserved,
      expectedRunId: runId,
      expectedTenderId: tender.tenderId,
      expectedTenderVersion: tender.version,
      expectedTenderHash: tHash,
      expectedCommitmentCount: 2,
    });

    attempt = transitionAttempt(attempt, "MIRROR_RECONCILED");
    persistAttempt(attempt, DEFAULT_ATTEMPT_PATH);

    console.log(
      `  sequences   : ${reconciled.completeness.observedSequences.join(", ")}`,
    );
    console.log(`  complete    : ${reconciled.completeness.complete}`);
    console.log(`  barrier seq : ${reconciled.barrier.sequence}`);
    console.log(`  barrier ts  : ${reconciled.barrier.consensusTimestamp}`);

    // Timely determination
    const timelyFlags = reconciled.commitmentEvidence.map((c) => ({
      bidId: c.bidId,
      timely: isCommitmentTimely(c.consensusTimestamp, auctionEndsAt),
      consensusTimestamp: c.consensusTimestamp,
    }));
    for (const t of timelyFlags) {
      if (!t.timely) {
        throw new Error(`Commitment ${t.bidId} is LATE — demo expects both timely`);
      }
    }

    // --- Phase 4 auction engine ---
    const fullBids = new Map([
      [signedA.bid.bidId, signedA],
      [signedB.bid.bidId, signedB],
    ]);
    const receipts = new Map([
      [signedA.bid.bidId, receiptA],
      [signedB.bid.bidId, receiptB],
    ]);

    const evaluationTimestamp = reconciled.barrier.consensusTimestamp;
    const reconciliationReference = `hcs-topic:${topicId}:1-${reconciled.barrier.sequence}`;

    const proof = createAuctionClosureProof({
      tender,
      auctionEndsAt,
      closeBarrierSequence: reconciled.barrier.sequence,
      closeBarrierConsensusTimestamp: reconciled.barrier.consensusTimestamp,
      reconciledStartSequence: 1,
      reconciledEndSequence: reconciled.barrier.sequence,
      observedSequences: reconciled.completeness.observedSequences,
      evaluationTimestamp,
      reconciliationReference,
      commitments: reconciled.commitmentEvidence,
      fullBids,
      acceptanceReceipts: receipts,
      registry,
      routeGuardPublicKey: ROUTEGUARD_PUBLIC_KEY,
      now: evaluationTimestamp,
    });

    if (!isVerifiedAuctionClosureProof(proof)) {
      throw new Error("Closure proof factory did not register authentic proof");
    }

    const integrity = verifyDecisionManifestIntegrity({
      tender,
      results: proof.results,
      evaluationTimestamp,
      barrierSequence: reconciled.barrier.sequence,
      reconciliationReference,
      manifest: proof.manifest,
    });
    if (!integrity.ok) {
      throw new Error(
        `Decision Manifest verification failed: ${integrity.errors.join("; ")}`,
      );
    }

    let machine = createAuctionMachine(auctionEndsAt);
    machine = transitionToOpen(machine);
    machine = transitionToBidding(machine);
    machine = transitionToReconciliation(machine, evaluationTimestamp);
    machine = transitionToClosed(machine, proof);
    machine = transitionToWinnerSelected(machine);

    if (machine.state !== "WINNER_SELECTED") {
      throw new Error(`Expected WINNER_SELECTED, got ${machine.state}`);
    }
    if (proof.manifest.winningBidId !== signedA.bid.bidId) {
      throw new Error(
        `Expected winner ${signedA.bid.bidId}, got ${proof.manifest.winningBidId}`,
      );
    }

    attempt = transitionAttempt(attempt, "AUCTION_EVALUATED");
    persistAttempt(attempt, DEFAULT_ATTEMPT_PATH);

    console.log(`  winner      : ${proof.manifest.winningBidId}`);
    console.log(`  carrier     : ${signedA.bid.carrierId}`);
    console.log(`  account     : ${signedA.bid.carrierAccountId}`);
    console.log(`  state       : ${machine.state}`);

    // Map message evidence (sanitized)
    const msgEvidence = (key: "open" | "commitmentA" | "commitmentB" | "barrier") => {
      const rec = attempt.messages[key];
      const obs =
        key === "open"
          ? reconciled.open
          : key === "barrier"
            ? reconciled.barrier
            : reconciled.commitments[
                key === "commitmentA" ? 0 : 1
              ];
      return {
        type:
          key === "open"
            ? "AUCTION_OPEN"
            : key === "barrier"
              ? "AUCTION_CLOSE_BARRIER"
              : "BID_COMMITMENT",
        label: rec?.label ?? key,
        envelopeHash: obs?.envelopeHash ?? rec?.envelopeHash,
        transactionId: rec?.transactionId,
        sequence: obs?.sequence ?? rec?.sequence,
        consensusTimestamp: obs?.consensusTimestamp ?? rec?.consensusTimestamp,
        hashScanTransactionLink: rec?.transactionId
          ? hashScanTx(rec.transactionId)
          : null,
      };
    };

    const evidence = {
      status: "SUCCESS",
      runId,
      network: "hedera:testnet" as const,
      topicId,
      topicCreateTransactionId: topicCreateTxId,
      topicMemo: TOPIC_MEMO,
      hashScanTopicLink: hashScanTopic(topicId),
      hashScanTopicCreateTransactionLink: hashScanTx(topicCreateTxId),
      tenderId: tender.tenderId,
      tenderVersion: tender.version,
      tenderHash: tHash,
      auctionEndsAt,
      engineVersion: ENGINE_VERSION,
      selectionPolicy: SELECTION_POLICY,
      rulesHash,
      operatorAccount: HCS_DEMO_OPERATOR_ACCOUNT,
      operatorPublicKeyMatch: "PASS",
      parserUsed: "PrivateKey.fromStringECDSA",
      topicCreates: 1,
      messagesSubmitted: 4,
      messages: {
        open: msgEvidence("open"),
        commitmentA: msgEvidence("commitmentA"),
        commitmentB: msgEvidence("commitmentB"),
        barrier: msgEvidence("barrier"),
      },
      barrierId: (reconciled.barrier.envelope.payload as { barrierId: string })
        .barrierId,
      barrierSequence: reconciled.barrier.sequence,
      barrierConsensusTimestamp: reconciled.barrier.consensusTimestamp,
      completeSequenceRange: {
        start: 1,
        end: reconciled.barrier.sequence,
      },
      observedSequences: reconciled.completeness.observedSequences,
      completenessResult: reconciled.completeness.complete,
      commitmentCount: reconciled.commitmentEvidence.length,
      commitmentEnvelopeHashes: reconciled.commitmentEnvelopeHashes,
      reconciledBidIds: reconciled.commitmentEvidence.map((c) => c.bidId),
      timelyStatus: timelyFlags,
      winnerBidId: proof.manifest.winningBidId,
      winnerBidHash: proof.manifest.winningBidHash,
      winnerCarrierId: signedA.bid.carrierId,
      winnerCarrierAccount: signedA.bid.carrierAccountId,
      evaluatedBidSetHash: proof.manifest.evaluatedBidSetHash,
      decisionManifestHash: proof.manifest.decisionManifestHash,
      manifestVerificationResult: integrity.ok ? "PASS" : "FAIL",
      closureProofResult: isVerifiedAuctionClosureProof(proof)
        ? "PASS"
        : "FAIL",
      finalAuctionState: machine.state,
      paymentsExecuted: 0,
      tokenAssociationsExecuted: 0,
      evidenceGeneratedAt: utcNowIso(),
      notes: [
        "The full bids remained private. HCS contains only hashes and public evidence references. Mirror Node consensus order and timestamps determine timeliness.",
        "No HBAR or USDC payment was executed.",
        "No token association was executed.",
        "Barrier consensus timestamp is authoritative for close; createdAt is informational only.",
      ],
    };

    writeJson(EVIDENCE_JSON, evidence);

    const md = buildMarkdownEvidence(evidence, barrierObs);
    writeText(EVIDENCE_MD, md);

    attempt = transitionAttempt(attempt, "SUCCESS", {
      finalResult: "HCS auction demo completed; winner selected",
    });
    persistAttempt(attempt, DEFAULT_ATTEMPT_PATH);

    console.log("");
    console.log("HCS_AUCTION_DEMO_SUCCESS");
    console.log(`  evidence    : ${EVIDENCE_JSON}`);
    console.log(`  markdown    : ${EVIDENCE_MD}`);
    console.log(`  topic       : ${hashScanTopic(topicId)}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      attempt = transitionAttempt(attempt, "FAILED", {
        error: message,
        finalResult: "FAILED",
      });
      persistAttempt(attempt, DEFAULT_ATTEMPT_PATH);
    } catch {
      // best-effort
    }
    throw error;
  } finally {
    client.close();
  }
}

function buildMarkdownEvidence(
  evidence: Record<string, unknown>,
  _barrierObs: ObservedHcsMessage,
): string {
  const messages = evidence.messages as Record<
    string,
    {
      type: string;
      transactionId?: string | null;
      sequence?: number | null;
      consensusTimestamp?: string | null;
      envelopeHash?: string | null;
      hashScanTransactionLink?: string | null;
    }
  >;

  const lines: string[] = [
    "# RouteGuard HCS Auction Demo Evidence",
    "",
    `**Status:** ${evidence.status}`,
    `**Generated:** ${evidence.evidenceGeneratedAt}`,
    "",
    "## Summary",
    "",
    "The full bids remained private. HCS contains only hashes and public evidence references. Mirror Node consensus order and timestamps determine timeliness.",
    "",
    "No HBAR or USDC payment was executed. No token association was executed.",
    "",
    "## Network & Topic",
    "",
    `| Field | Value |`,
    `| --- | --- |`,
    `| Network | ${evidence.network} |`,
    `| Run ID | ${evidence.runId} |`,
    `| Topic ID | ${evidence.topicId} |`,
    `| Topic create tx | ${evidence.topicCreateTransactionId} |`,
    `| Topic memo | ${evidence.topicMemo} |`,
    `| HashScan topic | ${evidence.hashScanTopicLink} |`,
    `| HashScan topic-create | ${evidence.hashScanTopicCreateTransactionLink} |`,
    `| Operator public-key match | ${evidence.operatorPublicKeyMatch} |`,
    `| Messages submitted | ${evidence.messagesSubmitted} |`,
    "",
    "## Tender",
    "",
    `| Field | Value |`,
    `| --- | --- |`,
    `| Tender ID | ${evidence.tenderId} |`,
    `| Version | ${evidence.tenderVersion} |`,
    `| Tender hash | ${evidence.tenderHash} |`,
    `| Auction ends at | ${evidence.auctionEndsAt} |`,
    `| Engine | ${evidence.engineVersion} |`,
    `| Policy | ${evidence.selectionPolicy} |`,
    `| Rules hash | ${evidence.rulesHash} |`,
    "",
    "## HCS Messages",
    "",
  ];

  for (const key of ["open", "commitmentA", "commitmentB", "barrier"] as const) {
    const m = messages[key]!;
    lines.push(`### ${m.type} (${key})`, "");
    lines.push(`| Field | Value |`);
    lines.push(`| --- | --- |`);
    lines.push(`| Envelope hash | ${m.envelopeHash} |`);
    lines.push(`| Transaction ID | ${m.transactionId} |`);
    lines.push(`| Sequence | ${m.sequence} |`);
    lines.push(`| Consensus timestamp | ${m.consensusTimestamp} |`);
    lines.push(`| HashScan | ${m.hashScanTransactionLink} |`);
    lines.push("");
  }

  lines.push(
    "## Barrier & Completeness",
    "",
    `| Field | Value |`,
    `| --- | --- |`,
    `| Barrier ID | ${evidence.barrierId} |`,
    `| Barrier sequence | ${evidence.barrierSequence} |`,
    `| Barrier consensus | ${evidence.barrierConsensusTimestamp} |`,
    `| Sequence range | 1..${(evidence.completeSequenceRange as { end: number }).end} |`,
    `| Observed sequences | ${(evidence.observedSequences as number[]).join(", ")} |`,
    `| Completeness | ${evidence.completenessResult} |`,
    `| Commitment count | ${evidence.commitmentCount} |`,
    `| Commitment envelope hashes | ${(evidence.commitmentEnvelopeHashes as string[]).join(", ")} |`,
    "",
    "## Auction Outcome",
    "",
    `| Field | Value |`,
    `| --- | --- |`,
    `| Reconciled bid IDs | ${(evidence.reconciledBidIds as string[]).join(", ")} |`,
    `| Winner bid ID | ${evidence.winnerBidId} |`,
    `| Winner bid hash | ${evidence.winnerBidHash} |`,
    `| Winner carrier ID | ${evidence.winnerCarrierId} |`,
    `| Winner carrier account | ${evidence.winnerCarrierAccount} |`,
    `| evaluatedBidSetHash | ${evidence.evaluatedBidSetHash} |`,
    `| decisionManifestHash | ${evidence.decisionManifestHash} |`,
    `| Manifest verification | ${evidence.manifestVerificationResult} |`,
    `| Closure proof | ${evidence.closureProofResult} |`,
    `| Final auction state | ${evidence.finalAuctionState} |`,
    `| Payments executed | ${evidence.paymentsExecuted} |`,
    `| Token associations | ${evidence.tokenAssociationsExecuted} |`,
    "",
    "## Timely Status",
    "",
  );

  for (const t of evidence.timelyStatus as Array<{
    bidId: string;
    timely: boolean;
    consensusTimestamp: string;
  }>) {
    lines.push(
      `- \`${t.bidId}\`: ${t.timely ? "TIMELY" : "LATE"} @ ${t.consensusTimestamp}`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

const isDirect =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isDirect) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`HCS_AUCTION_DEMO_FAILED: ${message}`);
    process.exitCode = 1;
  });
}
