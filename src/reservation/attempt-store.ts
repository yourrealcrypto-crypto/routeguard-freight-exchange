/**
 * Durable reservation attempt store — atomic write-then-rename filesystem + memory.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { ReservationError, type ReservationRecord, type ReservationState } from "./types";

export interface ReservationStore {
  get(reservationId: string): Promise<ReservationRecord | null>;
  put(record: ReservationRecord): Promise<void>;
  listInProgress(): Promise<ReservationRecord[]>;
}

/** Fields never persisted (WeakSet proof identity, secrets). */
const TRANSIENT_KEYS = new Set(["_closureProof", "_manifest"]);

export function toPersistedShape(
  record: ReservationRecord,
): Omit<ReservationRecord, "_closureProof" | "_manifest"> {
  const copy = { ...record };
  delete copy._closureProof;
  delete copy._manifest;
  return copy;
}

export function serializeReservationRecord(record: ReservationRecord): string {
  return `${JSON.stringify(toPersistedShape(record), null, 2)}\n`;
}

export class InMemoryReservationStore implements ReservationStore {
  private readonly byId = new Map<string, ReservationRecord>();

  async get(reservationId: string): Promise<ReservationRecord | null> {
    const r = this.byId.get(reservationId);
    return r ? structuredClone(r) : null;
  }

  async put(record: ReservationRecord): Promise<void> {
    // Preserve in-memory proof handle if present on existing
    const existing = this.byId.get(record.reservationId);
    const next = { ...record };
    if (!next._closureProof && existing?._closureProof) {
      next._closureProof = existing._closureProof;
    }
    if (!next._manifest && existing?._manifest) {
      next._manifest = existing._manifest;
    }
    this.byId.set(record.reservationId, next);
  }

  async listInProgress(): Promise<ReservationRecord[]> {
    const terminal: ReservationState[] = [
      "COMPLETED",
      "PAYMENT_REJECTED",
      "SETTLEMENT_FAILED",
      "CONFIRMATION_TIMED_OUT",
      "CONFIRMATION_FAILED",
      "EXPIRED",
      "MANUAL_REVIEW_REQUIRED",
    ];
    return [...this.byId.values()]
      .filter((r) => !terminal.includes(r.state))
      .map((r) => structuredClone(r));
  }
}

export class FileSystemReservationStore implements ReservationStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private filePath(reservationId: string): string {
    const safe = reservationId.replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(this.dir, `${safe}.json`);
  }

  async get(reservationId: string): Promise<ReservationRecord | null> {
    const fp = this.filePath(reservationId);
    if (!existsSync(fp)) return null;
    const raw = readFileSync(fp, "utf8");
    try {
      return JSON.parse(raw) as ReservationRecord;
    } catch {
      throw new ReservationError(
        "STORE_CORRUPT",
        `Corrupt reservation record at ${fp} — manual review required`,
      );
    }
  }

  async put(record: ReservationRecord): Promise<void> {
    const fp = this.filePath(record.reservationId);
    const dir = path.dirname(fp);
    mkdirSync(dir, { recursive: true });
    const tmp = path.join(
      dir,
      `.${path.basename(fp)}.${process.pid}.${Date.now()}.tmp`,
    );
    const payload = serializeReservationRecord(record);
    writeFileSync(tmp, payload, { encoding: "utf8", flag: "w" });
    renameSync(tmp, fp);
  }

  async listInProgress(): Promise<ReservationRecord[]> {
    // Demo: scan directory for non-terminal
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    const out: ReservationRecord[] = [];
    for (const f of files) {
      const raw = readFileSync(path.join(this.dir, f), "utf8");
      try {
        const rec = JSON.parse(raw) as ReservationRecord;
        if (
          rec.state !== "COMPLETED" &&
          rec.state !== "PAYMENT_REJECTED" &&
          rec.state !== "SETTLEMENT_FAILED" &&
          rec.state !== "EXPIRED" &&
          rec.state !== "MANUAL_REVIEW_REQUIRED" &&
          rec.state !== "CONFIRMATION_TIMED_OUT" &&
          rec.state !== "CONFIRMATION_FAILED"
        ) {
          out.push(rec);
        }
      } catch {
        throw new ReservationError(
          "STORE_CORRUPT",
          `Corrupt file ${f} — manual review required`,
        );
      }
    }
    return out;
  }
}

/**
 * Startup recovery: ambiguous in-progress settlement → MANUAL_REVIEW_REQUIRED
 * unless caller supplies resolved mirror status.
 */
export function recoverInProgressState(
  record: ReservationRecord,
  resolution?: {
    mirror?: MirrorLike;
  },
): ReservationRecord {
  const state = record.state;

  if (state === "FACILITATOR_SETTLED" || state === "MIRROR_CONFIRMATION_PENDING") {
    if (!record.transactionId) {
      return {
        ...record,
        state: "MANUAL_REVIEW_REQUIRED",
        failureCode: "AMBIGUOUS_SETTLEMENT",
        failureReason:
          "In-progress settlement without conclusive transaction ID — manual review required",
        updatedAt: new Date().toISOString(),
      };
    }
    if (resolution?.mirror) {
      if (resolution.mirror.status === "SUCCESS") {
        return record; // caller continues confirmation
      }
      if (resolution.mirror.status === "FAILED") {
        return {
          ...record,
          state: "CONFIRMATION_FAILED",
          failureCode: "MIRROR_FAILED",
          failureReason: "Mirror confirmed failure on recovery",
          updatedAt: new Date().toISOString(),
        };
      }
      // PENDING / NOT_FOUND without timeout evidence → manual review, not auto-fail
      return {
        ...record,
        state: "MANUAL_REVIEW_REQUIRED",
        failureCode: "AMBIGUOUS_MIRROR",
        failureReason:
          "In-progress settlement without conclusive Mirror result — manual review required",
        updatedAt: new Date().toISOString(),
      };
    }
    return {
      ...record,
      state: "MANUAL_REVIEW_REQUIRED",
      failureCode: "AMBIGUOUS_SETTLEMENT",
      failureReason:
        "Restart during settlement without resolved Mirror status — manual review required",
      updatedAt: new Date().toISOString(),
    };
  }

  if (state === "PAYMENT_SUBMISSION_STARTED") {
    // Do not infer failure from timeout alone
    return {
      ...record,
      state: "MANUAL_REVIEW_REQUIRED",
      failureCode: "AMBIGUOUS_SUBMISSION",
      failureReason:
        "Restart during payment submission — manual review required (do not auto-retry)",
      updatedAt: new Date().toISOString(),
    };
  }

  if (state === "FACILITATOR_VERIFIED") {
    return {
      ...record,
      state: "MANUAL_REVIEW_REQUIRED",
      failureCode: "AMBIGUOUS_VERIFIED",
      failureReason:
        "Restart after verify before settle — manual review required (settle at most once)",
      updatedAt: new Date().toISOString(),
    };
  }

  return record;
}

type MirrorLike = { status: string };

export function assertSinglePaymentAttempt(record: ReservationRecord): void {
  if (record.attemptNumber > 1) {
    throw new ReservationError(
      "ATTEMPT_REUSE",
      "Payment attempt number cannot be reused or incremented for alternate option",
    );
  }
}

export function assertNotReplaceSubmittedPayment(
  existing: ReservationRecord,
  incoming: Partial<ReservationRecord>,
): void {
  if (
    existing.transactionId &&
    incoming.transactionId &&
    incoming.transactionId !== existing.transactionId
  ) {
    throw new ReservationError(
      "CONFLICT",
      "Cannot replace an existing settlement transaction ID",
    );
  }
  if (
    existing.selected &&
    incoming.selected &&
    existing.selected.optionId !== incoming.selected.optionId &&
    (existing.state === "PAYMENT_SUBMISSION_STARTED" ||
      existing.paymentPayloadHash)
  ) {
    throw new ReservationError(
      "SELECTION_LOCKED",
      "Cannot change selected option after payment submission",
    );
  }
  void TRANSIENT_KEYS;
}
