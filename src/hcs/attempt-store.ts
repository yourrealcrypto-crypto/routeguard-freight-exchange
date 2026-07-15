/**
 * Durable one-run HCS demo attempt record with atomic write-then-rename.
 */

import { mkdirSync, renameSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  ATTEMPT_STATUSES,
  type AttemptStatus,
  type HcsAttemptRecord,
  type MessageAttemptRecord,
} from "./types";

export const DEFAULT_ATTEMPT_PATH = path.join(
  "evidence",
  "hcs-auction-demo-attempt.json",
);

export class AttemptStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttemptStoreError";
  }
}

const TERMINAL: ReadonlySet<AttemptStatus> = new Set(["SUCCESS", "FAILED"]);

function isAttemptStatus(value: unknown): value is AttemptStatus {
  return (
    typeof value === "string" &&
    (ATTEMPT_STATUSES as readonly string[]).includes(value)
  );
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

export function createPlannedAttempt(input: {
  runId: string;
  plannedTenderId: string;
  plannedTenderHash: string;
  plannedAuctionEndsAt?: string | null;
}): HcsAttemptRecord {
  const ts = nowIso();
  return {
    runId: input.runId,
    status: "PLANNED",
    network: "hedera:testnet",
    plannedTenderId: input.plannedTenderId,
    plannedTenderHash: input.plannedTenderHash,
    plannedAuctionEndsAt: input.plannedAuctionEndsAt ?? null,
    approvedWriteBudget: {
      topicCreates: 1,
      messageSubmits: 4,
    },
    topicId: null,
    topicCreateTransactionId: null,
    topicMemo: null,
    messages: {
      open: null,
      commitmentA: null,
      commitmentB: null,
      barrier: null,
    },
    finalResult: null,
    error: null,
    createdAt: ts,
    updatedAt: ts,
  };
}

export function emptyMessageRecord(
  messageType: MessageAttemptRecord["messageType"],
  label: string,
): MessageAttemptRecord {
  return {
    messageType,
    label,
    transactionId: null,
    sequence: null,
    consensusTimestamp: null,
    envelopeHash: null,
    submittedAt: null,
  };
}

/**
 * Atomic persistence: write temp sibling, then rename over target.
 */
export function persistAttempt(
  record: HcsAttemptRecord,
  filePath: string = DEFAULT_ATTEMPT_PATH,
): void {
  const absolute = path.resolve(filePath);
  const dir = path.dirname(absolute);
  mkdirSync(dir, { recursive: true });

  const payload = `${JSON.stringify(record, null, 2)}\n`;
  const tmp = path.join(
    dir,
    `.${path.basename(absolute)}.${process.pid}.${Date.now()}.tmp`,
  );
  writeFileSync(tmp, payload, { encoding: "utf8", flag: "w" });
  renameSync(tmp, absolute);
}

export function loadAttempt(
  filePath: string = DEFAULT_ATTEMPT_PATH,
): HcsAttemptRecord | null {
  const absolute = path.resolve(filePath);
  if (!existsSync(absolute)) {
    return null;
  }
  const raw = readFileSync(absolute, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new AttemptStoreError(
      `Attempt record at ${absolute} is not valid JSON — manual review required.`,
    );
  }
  return parseAttemptRecord(parsed);
}

export function parseAttemptRecord(raw: unknown): HcsAttemptRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AttemptStoreError("Attempt record must be an object");
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.runId !== "string" || !o.runId) {
    throw new AttemptStoreError("Attempt record missing runId");
  }
  if (!isAttemptStatus(o.status)) {
    throw new AttemptStoreError(`Invalid attempt status: ${String(o.status)}`);
  }
  return raw as HcsAttemptRecord;
}

/**
 * Guard before any network write.
 * - SUCCESS → abort (do not write again)
 * - nonterminal with topic ID or any transaction IDs → abort (manual review)
 */
export function assertSafeToStartWrites(
  existing: HcsAttemptRecord | null,
): void {
  if (!existing) {
    return;
  }
  if (existing.status === "SUCCESS") {
    throw new AttemptStoreError(
      `Attempt ${existing.runId} already SUCCESS — abort without writes. Manual review required if a new run is intended.`,
    );
  }
  if (existing.topicId) {
    throw new AttemptStoreError(
      `Nonterminal attempt ${existing.runId} already has topicId ${existing.topicId}. Do not create another topic. Manual review required.`,
    );
  }
  if (existing.topicCreateTransactionId) {
    throw new AttemptStoreError(
      `Nonterminal attempt ${existing.runId} already has topicCreateTransactionId. Manual review required.`,
    );
  }
  const msgs = existing.messages;
  for (const key of ["open", "commitmentA", "commitmentB", "barrier"] as const) {
    const m = msgs[key];
    if (m?.transactionId) {
      throw new AttemptStoreError(
        `Nonterminal attempt ${existing.runId} already has message transaction IDs (${key}). Manual review required.`,
      );
    }
  }
}

export function transitionAttempt(
  record: HcsAttemptRecord,
  status: AttemptStatus,
  patch: Partial<
    Omit<HcsAttemptRecord, "status" | "updatedAt" | "runId" | "createdAt">
  > = {},
): HcsAttemptRecord {
  if (TERMINAL.has(record.status) && status !== record.status) {
    throw new AttemptStoreError(
      `Cannot transition terminal attempt ${record.status} → ${status}`,
    );
  }
  return {
    ...record,
    ...patch,
    status,
    messages: patch.messages ?? record.messages,
    updatedAt: nowIso(),
  };
}

export function hasNetworkWrites(record: HcsAttemptRecord): boolean {
  if (record.topicId || record.topicCreateTransactionId) {
    return true;
  }
  for (const key of ["open", "commitmentA", "commitmentB", "barrier"] as const) {
    if (record.messages[key]?.transactionId) {
      return true;
    }
  }
  return false;
}
