/**
 * Durable final-demo attempt store — independent from Phase 5 / Phase 6B.1A.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { atomicWriteJson } from "./atomic-write";
import {
  FINAL_DEMO_ATTEMPT_STATUSES,
  FINAL_DEMO_DRY_RUN_ATTEMPT_PATH,
  FINAL_DEMO_LIVE_ATTEMPT_PATH,
  FINAL_DEMO_MODE_DRY,
  FINAL_DEMO_MODE_LIVE,
  FINAL_DEMO_NETWORK,
  FINAL_DEMO_PAYER_ACCOUNT,
  FINAL_DEMO_PLANNED_HCS_SUBMISSIONS,
  FINAL_DEMO_PLANNED_PAYMENT_SUBMISSIONS,
  FINAL_DEMO_PLANNED_TOPIC_CREATES,
  FINAL_DEMO_USDC_AMOUNT_ATOMIC,
  FINAL_DEMO_USDC_TOKEN,
  FINAL_DEMO_WINNER_ACCOUNT,
  HISTORICAL_PHASE5_TOPIC_ID,
  type FinalDemoAttemptStatus,
  type FinalDemoMessageLabel,
} from "./constants";
import { FinalDemoError } from "./errors";
import { assertNoPrivateKeyFields } from "./secret-scan";

export type FinalDemoMessageOutboxRecord = {
  logicalLabel: FinalDemoMessageLabel;
  expectedSequence: number;
  expectedTopic: string | null;
  envelope: unknown | null;
  envelopeHash: string | null;
  encodedByteCount: number | null;
  claimedAt: string | null;
  submitAttemptId: string | null;
  status:
    | "PENDING"
    | "CLAIMED"
    | "SUBMITTED"
    | "CONFIRMED"
    | "AMBIGUOUS"
    | "FAILED";
  transactionId: string | null;
  consensusTimestamp: string | null;
  sequence: number | null;
  receiptStatus: string | null;
};

export type FinalDemoAttemptRecord = {
  schemaVersion: "final-demo-live-attempt-1.0";
  attemptId: string;
  shortAttemptId: string;
  mode: typeof FINAL_DEMO_MODE_LIVE | typeof FINAL_DEMO_MODE_DRY;
  status: FinalDemoAttemptStatus;
  network: typeof FINAL_DEMO_NETWORK;
  runBaseTime: string | null;
  tenderId: string | null;
  reservationId: string | null;
  payerAccount: typeof FINAL_DEMO_PAYER_ACCOUNT;
  expectedWinnerAccount: typeof FINAL_DEMO_WINNER_ACCOUNT;
  usdcToken: typeof FINAL_DEMO_USDC_TOKEN;
  usdcAmount: typeof FINAL_DEMO_USDC_AMOUNT_ATOMIC;
  plannedTopicCreates: typeof FINAL_DEMO_PLANNED_TOPIC_CREATES;
  plannedHcsSubmissions: typeof FINAL_DEMO_PLANNED_HCS_SUBMISSIONS;
  plannedPaymentSubmissions: typeof FINAL_DEMO_PLANNED_PAYMENT_SUBMISSIONS;
  topicCreateClaim: {
    claimedAt: string | null;
    claimId: string | null;
    status: "NONE" | "CLAIMED" | "CREATED" | "AMBIGUOUS" | "FAILED";
  };
  topicId: string | null;
  topicCreateTransactionId: string | null;
  topicMemo: string | null;
  topicCreatedAt: string | null;
  messageOutbox: FinalDemoMessageOutboxRecord[];
  paymentSubmissionClaim: {
    claimedAt: string | null;
    status: "NONE" | "CLAIMED" | "SUBMITTED" | "CONFIRMED" | "AMBIGUOUS";
    transactionId: string | null;
  };
  reservationServiceRecordPath: string | null;
  routeReservedRecordHash: string | null;
  finalHashes: {
    tenderHash: string | null;
    winningBidHash: string | null;
    evaluatedBidSetHash: string | null;
    decisionManifestHash: string | null;
  };
  evidencePaths: {
    materials: string | null;
    attempt: string;
    resultJson: string | null;
    resultMd: string | null;
  };
  failureCode: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function isStatus(v: unknown): v is FinalDemoAttemptStatus {
  return (
    typeof v === "string" &&
    (FINAL_DEMO_ATTEMPT_STATUSES as readonly string[]).includes(v)
  );
}

export function emptyMessageOutbox(): FinalDemoMessageOutboxRecord[] {
  const labels: Array<{
    label: FinalDemoMessageLabel;
    sequence: number;
  }> = [
    { label: "AUCTION_OPEN", sequence: 1 },
    { label: "BID_COMMITMENT_ALPHA", sequence: 2 },
    { label: "BID_COMMITMENT_BETA", sequence: 3 },
    { label: "AUCTION_CLOSE_BARRIER", sequence: 4 },
    { label: "ROUTE_RESERVED", sequence: 5 },
  ];
  return labels.map(({ label, sequence }) => ({
    logicalLabel: label,
    expectedSequence: sequence,
    expectedTopic: null,
    envelope: null,
    envelopeHash: null,
    encodedByteCount: null,
    claimedAt: null,
    submitAttemptId: null,
    status: "PENDING",
    transactionId: null,
    consensusTimestamp: null,
    sequence: null,
    receiptStatus: null,
  }));
}

export function createFinalDemoAttempt(input: {
  mode: typeof FINAL_DEMO_MODE_LIVE | typeof FINAL_DEMO_MODE_DRY;
  attemptId: string;
  shortAttemptId: string;
  runBaseTime?: string | null;
  tenderId?: string | null;
  reservationId?: string | null;
  attemptPath?: string;
  materialsPath?: string | null;
}): FinalDemoAttemptRecord {
  const ts = nowIso();
  const attemptPath =
    input.attemptPath ??
    (input.mode === FINAL_DEMO_MODE_DRY
      ? FINAL_DEMO_DRY_RUN_ATTEMPT_PATH
      : FINAL_DEMO_LIVE_ATTEMPT_PATH);
  return {
    schemaVersion: "final-demo-live-attempt-1.0",
    attemptId: input.attemptId,
    shortAttemptId: input.shortAttemptId,
    mode: input.mode,
    status: "PLANNED",
    network: FINAL_DEMO_NETWORK,
    runBaseTime: input.runBaseTime ?? null,
    tenderId: input.tenderId ?? null,
    reservationId: input.reservationId ?? null,
    payerAccount: FINAL_DEMO_PAYER_ACCOUNT,
    expectedWinnerAccount: FINAL_DEMO_WINNER_ACCOUNT,
    usdcToken: FINAL_DEMO_USDC_TOKEN,
    usdcAmount: FINAL_DEMO_USDC_AMOUNT_ATOMIC,
    plannedTopicCreates: FINAL_DEMO_PLANNED_TOPIC_CREATES,
    plannedHcsSubmissions: FINAL_DEMO_PLANNED_HCS_SUBMISSIONS,
    plannedPaymentSubmissions: FINAL_DEMO_PLANNED_PAYMENT_SUBMISSIONS,
    topicCreateClaim: {
      claimedAt: null,
      claimId: null,
      status: "NONE",
    },
    topicId: null,
    topicCreateTransactionId: null,
    topicMemo: null,
    topicCreatedAt: null,
    messageOutbox: emptyMessageOutbox(),
    paymentSubmissionClaim: {
      claimedAt: null,
      status: "NONE",
      transactionId: null,
    },
    reservationServiceRecordPath: null,
    routeReservedRecordHash: null,
    finalHashes: {
      tenderHash: null,
      winningBidHash: null,
      evaluatedBidSetHash: null,
      decisionManifestHash: null,
    },
    evidencePaths: {
      materials: input.materialsPath ?? null,
      attempt: attemptPath,
      resultJson: null,
      resultMd: null,
    },
    failureCode: null,
    failureReason: null,
    createdAt: ts,
    updatedAt: ts,
  };
}

export function persistFinalDemoAttempt(
  record: FinalDemoAttemptRecord,
  filePath?: string,
): void {
  assertNoPrivateKeyFields(record, "final-demo-attempt");
  if (record.topicId === HISTORICAL_PHASE5_TOPIC_ID) {
    throw new FinalDemoError(
      "Historical Phase 5 topic must never be the final-demo topic",
      "HISTORICAL_TOPIC_FORBIDDEN",
    );
  }
  const absolute = path.resolve(filePath ?? record.evidencePaths.attempt);
  atomicWriteJson(absolute, record);
}

export function loadFinalDemoAttempt(
  filePath: string,
): FinalDemoAttemptRecord | null {
  const absolute = path.resolve(filePath);
  if (!existsSync(absolute)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch {
    throw new FinalDemoError(
      "Final-demo attempt is not valid JSON",
      "CORRUPT_ATTEMPT",
    );
  }
  return parseFinalDemoAttempt(parsed);
}

export function parseFinalDemoAttempt(raw: unknown): FinalDemoAttemptRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FinalDemoError("Attempt must be an object", "CORRUPT_ATTEMPT");
  }
  const o = raw as FinalDemoAttemptRecord;
  if (o.schemaVersion !== "final-demo-live-attempt-1.0") {
    throw new FinalDemoError("Unsupported attempt schema", "CORRUPT_ATTEMPT");
  }
  if (o.mode !== FINAL_DEMO_MODE_LIVE && o.mode !== FINAL_DEMO_MODE_DRY) {
    throw new FinalDemoError("Invalid attempt mode", "CORRUPT_ATTEMPT");
  }
  if (!isStatus(o.status)) {
    throw new FinalDemoError(`Invalid status ${String(o.status)}`, "CORRUPT_ATTEMPT");
  }
  if (o.plannedTopicCreates !== 1) {
    throw new FinalDemoError("plannedTopicCreates must be 1", "WRITE_BUDGET");
  }
  if (o.plannedHcsSubmissions !== 5) {
    throw new FinalDemoError("plannedHcsSubmissions must be 5", "WRITE_BUDGET");
  }
  if (o.plannedPaymentSubmissions !== 1) {
    throw new FinalDemoError(
      "plannedPaymentSubmissions must be 1",
      "WRITE_BUDGET",
    );
  }
  if (o.payerAccount !== FINAL_DEMO_PAYER_ACCOUNT) {
    throw new FinalDemoError("payerAccount mismatch", "WRONG_PAYER");
  }
  if (o.expectedWinnerAccount !== FINAL_DEMO_WINNER_ACCOUNT) {
    throw new FinalDemoError("expectedWinnerAccount mismatch", "WRONG_RECEIVER");
  }
  if (o.usdcToken !== FINAL_DEMO_USDC_TOKEN) {
    throw new FinalDemoError("usdcToken mismatch", "WRONG_TOKEN");
  }
  if (o.usdcAmount !== FINAL_DEMO_USDC_AMOUNT_ATOMIC) {
    throw new FinalDemoError("usdcAmount mismatch", "WRONG_AMOUNT");
  }
  if (o.topicId === HISTORICAL_PHASE5_TOPIC_ID) {
    throw new FinalDemoError(
      "Historical topic cannot be loaded as final-demo attempt topic",
      "HISTORICAL_TOPIC_FORBIDDEN",
    );
  }
  assertNoPrivateKeyFields(raw, "final-demo-attempt");
  return o;
}

/**
 * Successful, ambiguous, or side-effect-started live attempts block a second run.
 * Dry-run attempts never block live.
 */
export function assertSafeToStartFinalDemoLive(
  existing: FinalDemoAttemptRecord | null,
): void {
  if (!existing) return;
  if (existing.mode !== FINAL_DEMO_MODE_LIVE) {
    throw new FinalDemoError(
      "Refusing to treat non-LIVE attempt as live final demo",
      "WRONG_ATTEMPT_KIND",
    );
  }
  if (existing.status === "COMPLETED") {
    throw new FinalDemoError(
      "Prior successful final-demo live attempt exists",
      "ATTEMPT_ALREADY_SUCCESS",
    );
  }
  if (
    existing.status === "AMBIGUOUS" ||
    existing.status === "TOPIC_CREATE_AMBIGUOUS" ||
    existing.topicCreateClaim.status === "AMBIGUOUS"
  ) {
    throw new FinalDemoError(
      "Prior ambiguous final-demo attempt — manual resolution required",
      "ATTEMPT_AMBIGUOUS",
    );
  }
  if (
    existing.topicCreateClaim.status === "CLAIMED" ||
    existing.topicCreateClaim.status === "CREATED" ||
    existing.topicId ||
    existing.topicCreateTransactionId
  ) {
    throw new FinalDemoError(
      "Topic create already claimed/created — will not create another topic",
      "TOPIC_CREATE_ALREADY_CLAIMED",
    );
  }
  if (
    existing.paymentSubmissionClaim.status !== "NONE" ||
    existing.paymentSubmissionClaim.transactionId
  ) {
    throw new FinalDemoError(
      "Payment already claimed/submitted — will not settle again",
      "PAYMENT_ALREADY_SUBMITTED",
    );
  }
  for (const m of existing.messageOutbox) {
    if (
      m.status === "CLAIMED" ||
      m.status === "SUBMITTED" ||
      m.status === "CONFIRMED" ||
      m.status === "AMBIGUOUS" ||
      m.transactionId
    ) {
      throw new FinalDemoError(
        `HCS message ${m.logicalLabel} already claimed/submitted — no auto re-run`,
        "HCS_ALREADY_CLAIMED",
      );
    }
  }
  if (existing.status === "FAILED") {
    throw new FinalDemoError(
      "Prior failed final-demo attempt — manual review (no auto-reset)",
      "ATTEMPT_FAILED_BLOCKS_RERUN",
    );
  }
}

export function withFinalDemoAttemptUpdate(
  attempt: FinalDemoAttemptRecord,
  patch: Partial<FinalDemoAttemptRecord>,
): FinalDemoAttemptRecord {
  return {
    ...attempt,
    ...patch,
    updatedAt: nowIso(),
  };
}

export function getOutboxMessage(
  attempt: FinalDemoAttemptRecord,
  label: FinalDemoMessageLabel,
): FinalDemoMessageOutboxRecord {
  const msg = attempt.messageOutbox.find((m) => m.logicalLabel === label);
  if (!msg) {
    throw new FinalDemoError(
      `Outbox missing label ${label}`,
      "OUTBOX_MISSING",
    );
  }
  return msg;
}

/**
 * CAS claim for a single logical HCS message. Only the claim holder may submit.
 */
export function claimMessageOutbox(
  attempt: FinalDemoAttemptRecord,
  label: FinalDemoMessageLabel,
  input: {
    expectedTopic: string;
    envelope: unknown;
    envelopeHash: string;
    encodedByteCount: number;
    submitAttemptId: string;
  },
): FinalDemoAttemptRecord {
  if (input.expectedTopic === HISTORICAL_PHASE5_TOPIC_ID) {
    throw new FinalDemoError(
      "Cannot claim message against historical Phase 5 topic",
      "HISTORICAL_TOPIC_FORBIDDEN",
    );
  }
  const idx = attempt.messageOutbox.findIndex((m) => m.logicalLabel === label);
  if (idx < 0) {
    throw new FinalDemoError(`Unknown outbox label ${label}`, "OUTBOX_MISSING");
  }
  const current = attempt.messageOutbox[idx]!;
  if (current.status !== "PENDING") {
    throw new FinalDemoError(
      `Message ${label} already ${current.status} — no auto re-claim`,
      "HCS_ALREADY_CLAIMED",
    );
  }
  // Preceding sequences must be CONFIRMED
  for (const m of attempt.messageOutbox) {
    if (m.expectedSequence < current.expectedSequence && m.status !== "CONFIRMED") {
      throw new FinalDemoError(
        `Cannot claim ${label}: preceding sequence ${m.expectedSequence} not CONFIRMED`,
        "HCS_ORDER_VIOLATION",
      );
    }
  }
  const next = attempt.messageOutbox.map((m, i) =>
    i === idx
      ? {
          ...m,
          expectedTopic: input.expectedTopic,
          envelope: input.envelope,
          envelopeHash: input.envelopeHash,
          encodedByteCount: input.encodedByteCount,
          claimedAt: nowIso(),
          submitAttemptId: input.submitAttemptId,
          status: "CLAIMED" as const,
        }
      : m,
  );
  return withFinalDemoAttemptUpdate(attempt, {
    messageOutbox: next,
    status:
      label === "AUCTION_OPEN"
        ? "SEQ1_CLAIMED"
        : label === "BID_COMMITMENT_ALPHA"
          ? "SEQ2_CLAIMED"
          : label === "BID_COMMITMENT_BETA"
            ? "SEQ3_CLAIMED"
            : label === "AUCTION_CLOSE_BARRIER"
              ? "SEQ4_CLAIMED"
              : "SEQ5_CLAIMED",
  });
}

export function confirmMessageOutbox(
  attempt: FinalDemoAttemptRecord,
  label: FinalDemoMessageLabel,
  input: {
    topicId: string;
    sequence: number;
    transactionId: string;
    consensusTimestamp: string;
    envelopeHash: string;
  },
): FinalDemoAttemptRecord {
  const idx = attempt.messageOutbox.findIndex((m) => m.logicalLabel === label);
  if (idx < 0) {
    throw new FinalDemoError(`Unknown outbox label ${label}`, "OUTBOX_MISSING");
  }
  const current = attempt.messageOutbox[idx]!;
  if (current.status !== "CLAIMED" && current.status !== "SUBMITTED") {
    throw new FinalDemoError(
      `Cannot confirm ${label} from status ${current.status}`,
      "HCS_CONFIRM_INVALID",
    );
  }
  if (current.expectedTopic && current.expectedTopic !== input.topicId) {
    throw new FinalDemoError("Topic mismatch on confirm", "WRONG_TOPIC");
  }
  if (input.topicId === HISTORICAL_PHASE5_TOPIC_ID) {
    throw new FinalDemoError(
      "Historical topic forbidden",
      "HISTORICAL_TOPIC_FORBIDDEN",
    );
  }
  if (input.sequence !== current.expectedSequence) {
    throw new FinalDemoError(
      `Expected sequence ${current.expectedSequence}, got ${input.sequence}`,
      "WRONG_SEQUENCE",
    );
  }
  if (current.envelopeHash && current.envelopeHash !== input.envelopeHash) {
    throw new FinalDemoError(
      "Envelope hash mismatch on Mirror confirm",
      "ENVELOPE_HASH_MISMATCH",
    );
  }
  const next = attempt.messageOutbox.map((m, i) =>
    i === idx
      ? {
          ...m,
          status: "CONFIRMED" as const,
          transactionId: input.transactionId,
          consensusTimestamp: input.consensusTimestamp,
          sequence: input.sequence,
          receiptStatus: "SUCCESS",
          expectedTopic: input.topicId,
        }
      : m,
  );
  return withFinalDemoAttemptUpdate(attempt, {
    messageOutbox: next,
    status:
      label === "AUCTION_OPEN"
        ? "SEQ1_CONFIRMED"
        : label === "BID_COMMITMENT_ALPHA"
          ? "SEQ2_CONFIRMED"
          : label === "BID_COMMITMENT_BETA"
            ? "SEQ3_CONFIRMED"
            : label === "AUCTION_CLOSE_BARRIER"
              ? "SEQ4_CONFIRMED"
              : "SEQ5_CONFIRMED",
  });
}

export function claimTopicCreate(
  attempt: FinalDemoAttemptRecord,
  claimId: string,
): FinalDemoAttemptRecord {
  if (attempt.topicCreateClaim.status !== "NONE") {
    throw new FinalDemoError(
      "Topic create already claimed",
      "TOPIC_CREATE_ALREADY_CLAIMED",
    );
  }
  if (attempt.topicId || attempt.topicCreateTransactionId) {
    throw new FinalDemoError(
      "Topic create already has side effects",
      "TOPIC_CREATE_ALREADY_CLAIMED",
    );
  }
  return withFinalDemoAttemptUpdate(attempt, {
    status: "TOPIC_CREATE_CLAIMED",
    topicCreateClaim: {
      claimedAt: nowIso(),
      claimId,
      status: "CLAIMED",
    },
  });
}

export function finalizeTopicCreate(
  attempt: FinalDemoAttemptRecord,
  input: {
    topicId: string;
    topicCreateTransactionId: string;
    topicMemo: string;
    createdAt: string;
  },
): FinalDemoAttemptRecord {
  if (attempt.topicCreateClaim.status !== "CLAIMED") {
    throw new FinalDemoError(
      "Topic create not claimed",
      "TOPIC_CREATE_NOT_CLAIMED",
    );
  }
  if (input.topicId === HISTORICAL_PHASE5_TOPIC_ID) {
    throw new FinalDemoError(
      "Cannot finalize historical topic as final-demo topic",
      "HISTORICAL_TOPIC_FORBIDDEN",
    );
  }
  if (!input.topicId || !input.topicCreateTransactionId) {
    throw new FinalDemoError("Topic create result incomplete", "TOPIC_CREATE_FAILED");
  }
  return withFinalDemoAttemptUpdate(attempt, {
    status: "TOPIC_CREATED",
    topicId: input.topicId,
    topicCreateTransactionId: input.topicCreateTransactionId,
    topicMemo: input.topicMemo,
    topicCreatedAt: input.createdAt,
    topicCreateClaim: {
      ...attempt.topicCreateClaim,
      status: "CREATED",
    },
    messageOutbox: attempt.messageOutbox.map((m) => ({
      ...m,
      expectedTopic: input.topicId,
    })),
  });
}

export function markTopicCreateAmbiguous(
  attempt: FinalDemoAttemptRecord,
  reason: string,
): FinalDemoAttemptRecord {
  return withFinalDemoAttemptUpdate(attempt, {
    status: "TOPIC_CREATE_AMBIGUOUS",
    topicCreateClaim: {
      ...attempt.topicCreateClaim,
      status: "AMBIGUOUS",
    },
    failureCode: "TOPIC_CREATE_AMBIGUOUS",
    failureReason: reason,
  });
}
