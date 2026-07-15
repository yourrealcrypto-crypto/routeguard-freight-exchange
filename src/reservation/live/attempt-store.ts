/**
 * Durable Phase 6B attempt records — separate dry-run and live files.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  PHASE6B_ATTEMPT_STATUSES,
  PHASE6B_CARRIER_ACCOUNT,
  PHASE6B_DRY_RUN_ATTEMPT_PATH,
  PHASE6B_HCS_TOPIC,
  PHASE6B_LIVE_ATTEMPT_PATH,
  PHASE6B_NETWORK,
  PHASE6B_PAYER_ACCOUNT,
  PHASE6B_USDC_AMOUNT_ATOMIC,
  PHASE6B_USDC_TOKEN,
  type Phase6bAttemptStatus,
} from "./constants";

export class Phase6bAttemptError extends Error {
  constructor(
    message: string,
    public readonly code: string = "PHASE6B_ATTEMPT_ERROR",
  ) {
    super(message);
    this.name = "Phase6bAttemptError";
  }
}

export type Phase6bAttemptKind = "DRY_RUN" | "LIVE";

export type Phase6bAttemptRecord = {
  readonly kind: Phase6bAttemptKind;
  readonly attemptId: string;
  readonly reservationId: string;
  readonly network: typeof PHASE6B_NETWORK;
  readonly payer: typeof PHASE6B_PAYER_ACCOUNT;
  readonly receiver: typeof PHASE6B_CARRIER_ACCOUNT;
  readonly asset: typeof PHASE6B_USDC_TOKEN;
  readonly amount: typeof PHASE6B_USDC_AMOUNT_ATOMIC;
  readonly expectedTopic: typeof PHASE6B_HCS_TOPIC;
  readonly expectedPreRunTopicSequence: number | null;
  readonly plannedMaxPaymentSubmissions: 1;
  readonly plannedMaxHcsSubmissions: 1;
  status: Phase6bAttemptStatus;
  readonly createdAt: string;
  paymentSubmissionClaimedAt: string | null;
  paymentSubmittedAt: string | null;
  transactionId: string | null;
  paymentConsensusTimestamp: string | null;
  hcsPublishAttemptId: string | null;
  hcsTransactionId: string | null;
  hcsSequence: number | null;
  hcsConsensusTimestamp: string | null;
  evidencePaths: {
    json: string | null;
    md: string | null;
    attempt: string;
  };
  failureCode: string | null;
  failureReason: string | null;
  updatedAt: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function isStatus(value: unknown): value is Phase6bAttemptStatus {
  return (
    typeof value === "string" &&
    (PHASE6B_ATTEMPT_STATUSES as readonly string[]).includes(value)
  );
}

export function createPlannedPhase6bAttempt(input: {
  kind: Phase6bAttemptKind;
  attemptId: string;
  reservationId: string;
  expectedPreRunTopicSequence?: number | null;
  attemptPath?: string;
}): Phase6bAttemptRecord {
  const ts = nowIso();
  const attemptPath =
    input.attemptPath ??
    (input.kind === "DRY_RUN"
      ? PHASE6B_DRY_RUN_ATTEMPT_PATH
      : PHASE6B_LIVE_ATTEMPT_PATH);
  return {
    kind: input.kind,
    attemptId: input.attemptId,
    reservationId: input.reservationId,
    network: PHASE6B_NETWORK,
    payer: PHASE6B_PAYER_ACCOUNT,
    receiver: PHASE6B_CARRIER_ACCOUNT,
    asset: PHASE6B_USDC_TOKEN,
    amount: PHASE6B_USDC_AMOUNT_ATOMIC,
    expectedTopic: PHASE6B_HCS_TOPIC,
    expectedPreRunTopicSequence: input.expectedPreRunTopicSequence ?? null,
    plannedMaxPaymentSubmissions: 1,
    plannedMaxHcsSubmissions: 1,
    status: "PLANNED",
    createdAt: ts,
    paymentSubmissionClaimedAt: null,
    paymentSubmittedAt: null,
    transactionId: null,
    paymentConsensusTimestamp: null,
    hcsPublishAttemptId: null,
    hcsTransactionId: null,
    hcsSequence: null,
    hcsConsensusTimestamp: null,
    evidencePaths: {
      json: null,
      md: null,
      attempt: attemptPath,
    },
    failureCode: null,
    failureReason: null,
    updatedAt: ts,
  };
}

export function persistPhase6bAttempt(
  record: Phase6bAttemptRecord,
  filePath?: string,
): void {
  const absolute = path.resolve(
    filePath ?? record.evidencePaths.attempt,
  );
  mkdirSync(path.dirname(absolute), { recursive: true });
  const payload = `${JSON.stringify(record, null, 2)}\n`;
  const tmp = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.${process.pid}.${Date.now()}.tmp`,
  );
  writeFileSync(tmp, payload, { encoding: "utf8", flag: "w" });
  renameSync(tmp, absolute);
}

export function loadPhase6bAttempt(
  filePath: string,
): Phase6bAttemptRecord | null {
  const absolute = path.resolve(filePath);
  if (!existsSync(absolute)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch {
    throw new Phase6bAttemptError(
      "Phase 6B attempt record is not valid JSON — manual review required",
      "CORRUPT_ATTEMPT",
    );
  }
  return parsePhase6bAttempt(parsed);
}

export function parsePhase6bAttempt(raw: unknown): Phase6bAttemptRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Phase6bAttemptError("Attempt record must be an object");
  }
  const o = raw as Record<string, unknown>;
  if (o.kind !== "DRY_RUN" && o.kind !== "LIVE") {
    throw new Phase6bAttemptError("Attempt kind must be DRY_RUN or LIVE");
  }
  if (typeof o.attemptId !== "string" || !o.attemptId) {
    throw new Phase6bAttemptError("Missing attemptId");
  }
  if (typeof o.reservationId !== "string" || !o.reservationId) {
    throw new Phase6bAttemptError("Missing reservationId");
  }
  if (!isStatus(o.status)) {
    throw new Phase6bAttemptError(`Invalid status: ${String(o.status)}`);
  }
  if (o.plannedMaxPaymentSubmissions !== 1 || o.plannedMaxHcsSubmissions !== 1) {
    throw new Phase6bAttemptError("Write budgets must be exactly 1");
  }
  if (o.asset !== PHASE6B_USDC_TOKEN) {
    throw new Phase6bAttemptError("Attempt asset must be USDC testnet token");
  }
  if (o.amount !== PHASE6B_USDC_AMOUNT_ATOMIC) {
    throw new Phase6bAttemptError("Attempt amount must be 10000 atomic USDC");
  }
  if (o.payer !== PHASE6B_PAYER_ACCOUNT || o.receiver !== PHASE6B_CARRIER_ACCOUNT) {
    throw new Phase6bAttemptError("Attempt payer/receiver mismatch");
  }
  if (o.expectedTopic !== PHASE6B_HCS_TOPIC) {
    throw new Phase6bAttemptError("Attempt expected topic mismatch");
  }
  return raw as Phase6bAttemptRecord;
}

/** Live-side-effect guard: never confuses dry-run with live. */
export function assertSafeToStartPhase6bLive(
  existing: Phase6bAttemptRecord | null,
): void {
  if (!existing) return;
  if (existing.kind !== "LIVE") {
    throw new Phase6bAttemptError(
      "Refusing to treat non-LIVE attempt as live",
      "WRONG_ATTEMPT_KIND",
    );
  }
  if (existing.status === "SUCCESS") {
    throw new Phase6bAttemptError(
      "Prior successful live attempt exists — will not re-run",
      "ATTEMPT_ALREADY_SUCCESS",
    );
  }
  if (existing.status === "AMBIGUOUS") {
    throw new Phase6bAttemptError(
      "Prior ambiguous live attempt — manual review required",
      "ATTEMPT_AMBIGUOUS",
    );
  }
  if (
    existing.status === "PAYMENT_SUBMISSION_CLAIMED" ||
    existing.status === "PAYMENT_SUBMITTED" ||
    existing.status === "PAYMENT_CONFIRMED" ||
    existing.paymentSubmissionClaimedAt ||
    existing.paymentSubmittedAt ||
    existing.transactionId
  ) {
    // Resumable only through explicit recovery APIs — not a fresh start.
    throw new Phase6bAttemptError(
      "Live payment already claimed/submitted — will not settle again automatically",
      "PAYMENT_ALREADY_SUBMITTED",
    );
  }
  if (
    existing.status === "HCS_CLAIMED" ||
    existing.status === "HCS_PUBLISHED" ||
    existing.hcsPublishAttemptId ||
    existing.hcsTransactionId
  ) {
    throw new Phase6bAttemptError(
      "HCS publication already claimed — will not auto-resubmit",
      "HCS_ALREADY_CLAIMED",
    );
  }
  if (existing.status === "FAILED") {
    throw new Phase6bAttemptError(
      "Prior failed live attempt — manual review required (no auto-reset)",
      "ATTEMPT_FAILED_BLOCKS_RERUN",
    );
  }
}

export function assertPaymentNotYetSubmitted(
  attempt: Phase6bAttemptRecord,
): void {
  if (
    attempt.paymentSubmittedAt ||
    attempt.transactionId ||
    attempt.status === "PAYMENT_SUBMITTED" ||
    attempt.status === "PAYMENT_CONFIRMED" ||
    attempt.status === "SUCCESS"
  ) {
    throw new Phase6bAttemptError(
      "Payment already submitted — cannot settle again",
      "PAYMENT_ALREADY_SUBMITTED",
    );
  }
}

export function assertHcsNotYetClaimed(attempt: Phase6bAttemptRecord): void {
  if (
    attempt.hcsPublishAttemptId ||
    attempt.hcsTransactionId ||
    attempt.status === "HCS_CLAIMED" ||
    attempt.status === "HCS_PUBLISHED" ||
    attempt.status === "SUCCESS"
  ) {
    throw new Phase6bAttemptError(
      "HCS publication already claimed — cannot duplicate publish",
      "HCS_ALREADY_CLAIMED",
    );
  }
}

export function withAttemptUpdate(
  attempt: Phase6bAttemptRecord,
  patch: Partial<Phase6bAttemptRecord>,
): Phase6bAttemptRecord {
  return {
    ...attempt,
    ...patch,
    updatedAt: nowIso(),
  };
}
