/**
 * Cross-process durable final-demo attempt store (Phase 6B.4).
 *
 * Guarantees:
 *  1. recordVersion + compareAndSet — stale writers fail closed
 *  2. Filesystem lock (exclusive `wx` create) — one writer across processes
 *  3. Store-owned version: create=1, each CAS increments by 1
 *  4. Strict schema validation on every create/read/write
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { KeyedMutex } from "../reservation/keyed-mutex";
import {
  FINAL_DEMO_ATTEMPT_SCHEMA,
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
    | "FAILED"
    | "RESOLUTION_INCOMPLETE";
  transactionId: string | null;
  consensusTimestamp: string | null;
  sequence: number | null;
  receiptStatus: string | null;
};

export type FinalDemoAttemptRecord = {
  schemaVersion: typeof FINAL_DEMO_ATTEMPT_SCHEMA;
  recordVersion: number;
  attemptId: string;
  shortAttemptId: string;
  mode: typeof FINAL_DEMO_MODE_LIVE | typeof FINAL_DEMO_MODE_DRY;
  status: FinalDemoAttemptStatus;
  network: typeof FINAL_DEMO_NETWORK;
  preparationStartedAt: string | null;
  runBaseTime: string | null;
  auctionOpensAt: string | null;
  auctionEndsAt: string | null;
  tenderId: string | null;
  reservationId: string | null;
  materialsPath: string | null;
  materialsHash: string | null;
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
    claimId: string | null;
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
  evidenceWrite: {
    status: "NONE" | "PENDING" | "WRITING" | "WRITTEN";
    claimedAt: string | null;
    claimId: string | null;
    expectedEvidenceHash: string | null;
    jsonHash: string | null;
    mdHash: string | null;
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

export class FinalDemoVersionConflictError extends FinalDemoError {
  constructor(
    public readonly attemptId: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(
      `Final-demo attempt version conflict: expected ${expectedVersion}, actual ${actualVersion}`,
      "VERSION_CONFLICT",
    );
    this.name = "FinalDemoVersionConflictError";
  }
}

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

const SAFE_ID_RE = /^[a-zA-Z0-9._-]+$/;
const OUTBOX_STATUSES = new Set([
  "PENDING",
  "CLAIMED",
  "SUBMITTED",
  "CONFIRMED",
  "AMBIGUOUS",
  "FAILED",
  "RESOLUTION_INCOMPLETE",
]);

function nowIso(): string {
  return new Date().toISOString();
}

function isStatus(v: unknown): v is FinalDemoAttemptStatus {
  return (
    typeof v === "string" &&
    (FINAL_DEMO_ATTEMPT_STATUSES as readonly string[]).includes(v)
  );
}

export function assertSafeAttemptId(id: string): string {
  if (typeof id !== "string" || id.length === 0 || id.length > 128) {
    throw new FinalDemoError("attemptId invalid length", "CORRUPT_ATTEMPT");
  }
  if (!SAFE_ID_RE.test(id) || id.includes("..")) {
    throw new FinalDemoError(
      "attemptId must be filesystem-safe [a-zA-Z0-9._-]",
      "CORRUPT_ATTEMPT",
    );
  }
  return id;
}

export function emptyMessageOutbox(): FinalDemoMessageOutboxRecord[] {
  const labels: Array<{ label: FinalDemoMessageLabel; sequence: number }> = [
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
  auctionOpensAt?: string | null;
  auctionEndsAt?: string | null;
  preparationStartedAt?: string | null;
  tenderId?: string | null;
  reservationId?: string | null;
  attemptPath?: string;
  materialsPath?: string | null;
  materialsHash?: string | null;
}): FinalDemoAttemptRecord {
  assertSafeAttemptId(input.attemptId);
  const ts = nowIso();
  const attemptPath =
    input.attemptPath ??
    (input.mode === FINAL_DEMO_MODE_DRY
      ? FINAL_DEMO_DRY_RUN_ATTEMPT_PATH
      : FINAL_DEMO_LIVE_ATTEMPT_PATH);
  return {
    schemaVersion: FINAL_DEMO_ATTEMPT_SCHEMA,
    recordVersion: 1,
    attemptId: input.attemptId,
    shortAttemptId: input.shortAttemptId,
    mode: input.mode,
    status: "PLANNED",
    network: FINAL_DEMO_NETWORK,
    preparationStartedAt: input.preparationStartedAt ?? ts,
    runBaseTime: input.runBaseTime ?? null,
    auctionOpensAt: input.auctionOpensAt ?? null,
    auctionEndsAt: input.auctionEndsAt ?? null,
    tenderId: input.tenderId ?? null,
    reservationId: input.reservationId ?? null,
    materialsPath: input.materialsPath ?? null,
    materialsHash: input.materialsHash ?? null,
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
      claimId: null,
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
    evidenceWrite: {
      status: "NONE",
      claimedAt: null,
      claimId: null,
      expectedEvidenceHash: null,
      jsonHash: null,
      mdHash: null,
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

export function parseFinalDemoAttempt(raw: unknown): FinalDemoAttemptRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FinalDemoError("Attempt must be an object", "CORRUPT_ATTEMPT");
  }
  const o = raw as Record<string, unknown>;

  // Reject unknown trust-sensitive keys
  const known = new Set([
    "schemaVersion",
    "recordVersion",
    "attemptId",
    "shortAttemptId",
    "mode",
    "status",
    "network",
    "preparationStartedAt",
    "runBaseTime",
    "auctionOpensAt",
    "auctionEndsAt",
    "tenderId",
    "reservationId",
    "materialsPath",
    "materialsHash",
    "payerAccount",
    "expectedWinnerAccount",
    "usdcToken",
    "usdcAmount",
    "plannedTopicCreates",
    "plannedHcsSubmissions",
    "plannedPaymentSubmissions",
    "topicCreateClaim",
    "topicId",
    "topicCreateTransactionId",
    "topicMemo",
    "topicCreatedAt",
    "messageOutbox",
    "paymentSubmissionClaim",
    "reservationServiceRecordPath",
    "routeReservedRecordHash",
    "finalHashes",
    "evidenceWrite",
    "evidencePaths",
    "failureCode",
    "failureReason",
    "createdAt",
    "updatedAt",
  ]);
  for (const k of Object.keys(o)) {
    if (
      !known.has(k) &&
      /private|secret|payload|key|signature|PAYMENT/i.test(k)
    ) {
      throw new FinalDemoError(
        `Unknown trust-sensitive field: ${k}`,
        "CORRUPT_ATTEMPT",
      );
    }
  }

  // Migrate schemaVersion 1.0 → 1.1 defaults for older dry-run artifacts in tests
  const schema = o.schemaVersion;
  if (
    schema !== FINAL_DEMO_ATTEMPT_SCHEMA &&
    schema !== "final-demo-live-attempt-1.0"
  ) {
    throw new FinalDemoError("Unsupported attempt schema", "CORRUPT_ATTEMPT");
  }

  const attemptId = assertSafeAttemptId(String(o.attemptId ?? ""));
  if (o.mode !== FINAL_DEMO_MODE_LIVE && o.mode !== FINAL_DEMO_MODE_DRY) {
    throw new FinalDemoError("Invalid attempt mode", "CORRUPT_ATTEMPT");
  }
  if (!isStatus(o.status)) {
    throw new FinalDemoError(
      `Invalid status ${String(o.status)}`,
      "CORRUPT_ATTEMPT",
    );
  }
  const recordVersion =
    typeof o.recordVersion === "number" &&
    Number.isInteger(o.recordVersion) &&
    o.recordVersion >= 1
      ? o.recordVersion
      : schema === "final-demo-live-attempt-1.0"
        ? 1
        : (() => {
            throw new FinalDemoError(
              "recordVersion must be positive integer",
              "CORRUPT_ATTEMPT",
            );
          })();

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
    throw new FinalDemoError(
      "expectedWinnerAccount mismatch",
      "WRONG_RECEIVER",
    );
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
  if (o.network !== FINAL_DEMO_NETWORK) {
    throw new FinalDemoError("network must be hedera:testnet", "WRONG_NETWORK");
  }

  if (!Array.isArray(o.messageOutbox) || o.messageOutbox.length !== 5) {
    throw new FinalDemoError(
      "messageOutbox must have exactly 5 entries",
      "CORRUPT_ATTEMPT",
    );
  }
  for (const m of o.messageOutbox) {
    if (!m || typeof m !== "object") {
      throw new FinalDemoError("Invalid outbox entry", "CORRUPT_ATTEMPT");
    }
    const msg = m as FinalDemoMessageOutboxRecord;
    if (!OUTBOX_STATUSES.has(msg.status)) {
      throw new FinalDemoError(
        `Invalid outbox status ${String(msg.status)}`,
        "CORRUPT_ATTEMPT",
      );
    }
    if (
      msg.status === "CONFIRMED" &&
      (!msg.transactionId || !String(msg.transactionId).trim()) &&
      !(
        msg.logicalLabel === "ROUTE_RESERVED" &&
        msg.receiptStatus === "MIRROR_RESOLVED"
      )
    ) {
      throw new FinalDemoError(
        "CONFIRMED HCS outbox requires transactionId unless Mirror resolved ROUTE_RESERVED",
        "CORRUPT_ATTEMPT",
      );
    }
  }

  assertNoPrivateKeyFields(raw, "final-demo-attempt");

  const evidencePaths = o.evidencePaths as FinalDemoAttemptRecord["evidencePaths"];
  if (!evidencePaths || typeof evidencePaths.attempt !== "string") {
    throw new FinalDemoError("evidencePaths.attempt required", "CORRUPT_ATTEMPT");
  }

  const rec: FinalDemoAttemptRecord = {
    schemaVersion: FINAL_DEMO_ATTEMPT_SCHEMA,
    recordVersion,
    attemptId,
    shortAttemptId: String(o.shortAttemptId ?? ""),
    mode: o.mode,
    status: o.status,
    network: FINAL_DEMO_NETWORK,
    preparationStartedAt:
      typeof o.preparationStartedAt === "string" ? o.preparationStartedAt : null,
    runBaseTime: typeof o.runBaseTime === "string" ? o.runBaseTime : null,
    auctionOpensAt:
      typeof o.auctionOpensAt === "string" ? o.auctionOpensAt : null,
    auctionEndsAt: typeof o.auctionEndsAt === "string" ? o.auctionEndsAt : null,
    tenderId: typeof o.tenderId === "string" ? o.tenderId : null,
    reservationId:
      typeof o.reservationId === "string" ? o.reservationId : null,
    materialsPath:
      typeof o.materialsPath === "string" ? o.materialsPath : null,
    materialsHash:
      typeof o.materialsHash === "string" ? o.materialsHash : null,
    payerAccount: FINAL_DEMO_PAYER_ACCOUNT,
    expectedWinnerAccount: FINAL_DEMO_WINNER_ACCOUNT,
    usdcToken: FINAL_DEMO_USDC_TOKEN,
    usdcAmount: FINAL_DEMO_USDC_AMOUNT_ATOMIC,
    plannedTopicCreates: 1,
    plannedHcsSubmissions: 5,
    plannedPaymentSubmissions: 1,
    topicCreateClaim: (o.topicCreateClaim ?? {
      claimedAt: null,
      claimId: null,
      status: "NONE",
    }) as FinalDemoAttemptRecord["topicCreateClaim"],
    topicId: typeof o.topicId === "string" ? o.topicId : null,
    topicCreateTransactionId:
      typeof o.topicCreateTransactionId === "string"
        ? o.topicCreateTransactionId
        : null,
    topicMemo: typeof o.topicMemo === "string" ? o.topicMemo : null,
    topicCreatedAt:
      typeof o.topicCreatedAt === "string" ? o.topicCreatedAt : null,
    messageOutbox: o.messageOutbox as FinalDemoMessageOutboxRecord[],
    paymentSubmissionClaim: {
      claimedAt:
        typeof (o.paymentSubmissionClaim as { claimedAt?: unknown })
          ?.claimedAt === "string"
          ? ((o.paymentSubmissionClaim as { claimedAt: string }).claimedAt)
          : null,
      claimId:
        typeof (o.paymentSubmissionClaim as { claimId?: unknown })?.claimId ===
        "string"
          ? ((o.paymentSubmissionClaim as { claimId: string }).claimId)
          : null,
      status:
        ((o.paymentSubmissionClaim as { status?: string })?.status as
          | FinalDemoAttemptRecord["paymentSubmissionClaim"]["status"]) ??
        "NONE",
      transactionId:
        typeof (o.paymentSubmissionClaim as { transactionId?: unknown })
          ?.transactionId === "string"
          ? ((o.paymentSubmissionClaim as { transactionId: string })
              .transactionId)
          : null,
    },
    reservationServiceRecordPath:
      typeof o.reservationServiceRecordPath === "string"
        ? o.reservationServiceRecordPath
        : null,
    routeReservedRecordHash:
      typeof o.routeReservedRecordHash === "string"
        ? o.routeReservedRecordHash
        : null,
    finalHashes: (o.finalHashes ?? {
      tenderHash: null,
      winningBidHash: null,
      evaluatedBidSetHash: null,
      decisionManifestHash: null,
    }) as FinalDemoAttemptRecord["finalHashes"],
    evidenceWrite: (o.evidenceWrite ?? {
      status: "NONE",
      claimedAt: null,
      claimId: null,
      expectedEvidenceHash: null,
      jsonHash: null,
      mdHash: null,
    }) as FinalDemoAttemptRecord["evidenceWrite"],
    evidencePaths,
    failureCode: typeof o.failureCode === "string" ? o.failureCode : null,
    failureReason:
      typeof o.failureReason === "string" ? o.failureReason : null,
    createdAt: String(o.createdAt ?? ""),
    updatedAt: String(o.updatedAt ?? ""),
  };

  if (!rec.createdAt || !rec.updatedAt) {
    throw new FinalDemoError(
      "createdAt/updatedAt required",
      "CORRUPT_ATTEMPT",
    );
  }
  return rec;
}

// ---------------------------------------------------------------------------
// CAS store
// ---------------------------------------------------------------------------

type LockHandle = { path: string; token: string };
type LockMetadata = {
  v: number;
  pid: number;
  host: string;
  token: string;
  acquiredAt: string;
};

export class FinalDemoAttemptStore {
  private readonly mutex = new KeyedMutex();
  private readonly filePath: string;
  private readonly lockFilePath: string;
  private readonly dir: string;

  constructor(
    attemptPath: string,
    private readonly maxLockAttempts: number = 1,
  ) {
    this.filePath = path.resolve(attemptPath);
    this.dir = path.dirname(this.filePath);
    mkdirSync(this.dir, { recursive: true });
    const base = path.basename(this.filePath, path.extname(this.filePath));
    this.lockFilePath = path.join(this.dir, `${base}.lock`);
  }

  async get(): Promise<FinalDemoAttemptRecord | null> {
    if (!existsSync(this.filePath)) return null;
    return this.readRecord();
  }

  async create(
    record: FinalDemoAttemptRecord,
  ): Promise<FinalDemoAttemptRecord> {
    return this.mutex.runExclusive("attempt", async () => {
      const lock = await this.acquireLock();
      try {
        if (existsSync(this.filePath)) {
          throw new FinalDemoError(
            "Final-demo attempt already exists",
            "ATTEMPT_EXISTS",
          );
        }
        const persisted: FinalDemoAttemptRecord = {
          ...record,
          recordVersion: 1,
          schemaVersion: FINAL_DEMO_ATTEMPT_SCHEMA,
        };
        parseFinalDemoAttempt(persisted); // strict validate
        this.writeAtomic(persisted, lock.token);
        return persisted;
      } finally {
        this.releaseLock(lock);
      }
    });
  }

  async compareAndSet(
    expectedVersion: number,
    nextRecord: FinalDemoAttemptRecord,
  ): Promise<FinalDemoAttemptRecord> {
    return this.mutex.runExclusive("attempt", async () => {
      const lock = await this.acquireLock();
      try {
        const current = this.readRecord();
        if (!current) {
          throw new FinalDemoError(
            "Attempt does not exist for CAS",
            "ATTEMPT_MISSING",
          );
        }
        if (current.recordVersion !== expectedVersion) {
          throw new FinalDemoVersionConflictError(
            current.attemptId,
            expectedVersion,
            current.recordVersion,
          );
        }
        if (nextRecord.attemptId !== current.attemptId) {
          throw new FinalDemoError(
            "Cannot change attemptId on CAS",
            "CORRUPT_ATTEMPT",
          );
        }
        if (nextRecord.mode !== current.mode) {
          throw new FinalDemoError(
            "Cannot change mode on CAS",
            "CORRUPT_ATTEMPT",
          );
        }
        const persisted: FinalDemoAttemptRecord = {
          ...nextRecord,
          attemptId: current.attemptId,
          mode: current.mode,
          recordVersion: current.recordVersion + 1,
          schemaVersion: FINAL_DEMO_ATTEMPT_SCHEMA,
          updatedAt: nowIso(),
        };
        if (persisted.topicId === HISTORICAL_PHASE5_TOPIC_ID) {
          throw new FinalDemoError(
            "Historical topic forbidden",
            "HISTORICAL_TOPIC_FORBIDDEN",
          );
        }
        parseFinalDemoAttempt(persisted);
        this.writeAtomic(persisted, lock.token);
        return persisted;
      } finally {
        this.releaseLock(lock);
      }
    });
  }

  private readRecord(): FinalDemoAttemptRecord {
    const raw = readFileSync(this.filePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new FinalDemoError(
        "Final-demo attempt is not valid JSON",
        "CORRUPT_ATTEMPT",
      );
    }
    return parseFinalDemoAttempt(parsed);
  }

  private writeAtomic(record: FinalDemoAttemptRecord, lockToken: string): void {
    assertNoPrivateKeyFields(record, "final-demo-attempt");
    const tmp = path.join(
      this.dir,
      `.${path.basename(this.filePath)}.${process.pid}.${lockToken}.tmp`,
    );
    const payload = `${JSON.stringify(record, null, 2)}\n`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, payload, null, "utf8");
      try {
        fsyncSync(fd);
      } catch {
        // best effort
      }
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.filePath);
  }

  private async acquireLock(): Promise<LockHandle> {
    const token = randomUUID();
    const meta: LockMetadata = {
      v: 1,
      pid: process.pid,
      host: os.hostname(),
      token,
      acquiredAt: nowIso(),
    };
    for (let attempt = 0; attempt < Math.max(1, this.maxLockAttempts); attempt++) {
      let fd: number;
      try {
        fd = openSync(this.lockFilePath, "wx");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") {
          this.inspectExistingLock();
          if (attempt + 1 < Math.max(1, this.maxLockAttempts)) {
            await new Promise((r) => setTimeout(r, 5));
            continue;
          }
          throw new FinalDemoError(
            "Final-demo attempt is locked by another writer — fail closed",
            "LOCK_HELD",
          );
        }
        throw e;
      }
      try {
        writeSync(fd, JSON.stringify(meta), null, "utf8");
        try {
          fsyncSync(fd);
        } catch {
          // best effort
        }
      } finally {
        closeSync(fd);
      }
      return { path: this.lockFilePath, token };
    }
    throw new FinalDemoError("Lock could not be acquired", "LOCK_HELD");
  }

  private inspectExistingLock(): void {
    let raw: string;
    try {
      raw = readFileSync(this.lockFilePath, "utf8");
    } catch {
      throw new FinalDemoError(
        "Lock exists but is unreadable — manual review",
        "LOCK_AMBIGUOUS",
      );
    }
    if (raw.trim().length === 0) {
      throw new FinalDemoError(
        "Lock is empty/partial — manual review",
        "LOCK_AMBIGUOUS",
      );
    }
    let meta: unknown;
    try {
      meta = JSON.parse(raw);
    } catch {
      throw new FinalDemoError(
        "Lock metadata malformed — manual review",
        "LOCK_AMBIGUOUS",
      );
    }
    const m = meta as Partial<LockMetadata>;
    if (
      typeof m.pid !== "number" ||
      typeof m.token !== "string" ||
      !m.token ||
      typeof m.acquiredAt !== "string"
    ) {
      throw new FinalDemoError(
        "Lock metadata incomplete — manual review",
        "LOCK_AMBIGUOUS",
      );
    }
  }

  private releaseLock(lock: LockHandle): void {
    try {
      const raw = readFileSync(lock.path, "utf8");
      const meta = JSON.parse(raw) as Partial<LockMetadata>;
      if (meta.token !== lock.token) return;
      unlinkSync(lock.path);
    } catch {
      // nothing safe to remove
    }
  }
}

// ---------------------------------------------------------------------------
// Functional helpers (CAS-backed patches used by orchestration)
// ---------------------------------------------------------------------------

export function withFinalDemoAttemptUpdate(
  attempt: FinalDemoAttemptRecord,
  patch: Partial<FinalDemoAttemptRecord>,
): FinalDemoAttemptRecord {
  return {
    ...attempt,
    ...patch,
    recordVersion: attempt.recordVersion, // store owns version
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
  for (const m of attempt.messageOutbox) {
    if (
      m.expectedSequence < current.expectedSequence &&
      m.status !== "CONFIRMED"
    ) {
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
    transactionId: string | null;
    consensusTimestamp: string;
    envelopeHash: string;
    confirmationSource?: "SUBMIT_RESPONSE" | "MIRROR_RESOLVER";
  },
): FinalDemoAttemptRecord {
  const confirmationSource = input.confirmationSource ?? "SUBMIT_RESPONSE";
  if (!input.transactionId?.trim() && confirmationSource !== "MIRROR_RESOLVER") {
    throw new FinalDemoError(
      "Cannot confirm HCS without transaction ID",
      "HCS_MISSING_TRANSACTION_ID",
    );
  }
  if (
    confirmationSource === "MIRROR_RESOLVER" &&
    label !== "ROUTE_RESERVED"
  ) {
    throw new FinalDemoError(
      "Only ROUTE_RESERVED may be confirmed from the publication resolver",
      "HCS_CONFIRM_INVALID",
    );
  }
  if (!input.consensusTimestamp?.trim()) {
    throw new FinalDemoError(
      "Cannot confirm HCS without consensus timestamp",
      "HCS_MISSING_CONSENSUS",
    );
  }
  const idx = attempt.messageOutbox.findIndex((m) => m.logicalLabel === label);
  if (idx < 0) {
    throw new FinalDemoError(`Unknown outbox label ${label}`, "OUTBOX_MISSING");
  }
  const current = attempt.messageOutbox[idx]!;
  if (
    current.status !== "CLAIMED" &&
    current.status !== "SUBMITTED" &&
    !(
      current.status === "AMBIGUOUS" &&
      confirmationSource === "MIRROR_RESOLVER"
    )
  ) {
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
          transactionId: input.transactionId?.trim() || null,
          consensusTimestamp: input.consensusTimestamp,
          sequence: input.sequence,
          receiptStatus:
            confirmationSource === "MIRROR_RESOLVER"
              ? "MIRROR_RESOLVED"
              : "SUCCESS",
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
    throw new FinalDemoError(
      "Topic create result incomplete",
      "TOPIC_CREATE_FAILED",
    );
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

/**
 * Successful, ambiguous, or side-effect-started live attempts block a second start.
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
  if (existing.status === "COMPLETED" || existing.status === "EVIDENCE_WRITTEN") {
    throw new FinalDemoError(
      "Prior successful final-demo live attempt exists",
      "ATTEMPT_ALREADY_SUCCESS",
    );
  }
  if (
    existing.status === "AMBIGUOUS" ||
    existing.status === "TOPIC_CREATE_AMBIGUOUS" ||
    existing.status === "MANUAL_REVIEW_REQUIRED" ||
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
    // Resume path is allowed; starting a *second* attempt is not.
    // Callers that want a fresh start must not find these.
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

/** @deprecated Use FinalDemoAttemptStore — kept for tests that only need parse. */
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

/**
 * Synchronous durable write for unit tests and offline helpers.
 * Production orchestration must use FinalDemoAttemptStore.create/compareAndSet.
 */
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
  mkdirSync(path.dirname(absolute), { recursive: true });
  const validated = parseFinalDemoAttempt({
    ...record,
    schemaVersion: FINAL_DEMO_ATTEMPT_SCHEMA,
    recordVersion: record.recordVersion >= 1 ? record.recordVersion : 1,
  });
  const tmp = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const payload = `${JSON.stringify(validated, null, 2)}\n`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, payload, null, "utf8");
    try {
      fsyncSync(fd);
    } catch {
      // best effort
    }
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, absolute);
}
