import { randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync,
} from "node:fs";
import path from "node:path";

import { canonicalSha256 } from "../domain/canonical-hash";
import { acquireFileLock, releaseFileLock, resolveFileLockConfig } from "../v2/store/file-lock";
import { DemoError } from "./errors";
import type { OperationsDemoSession } from "./types";

const STORE_SCHEMA = "routeguard-operations-demo-store-1.0" as const;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

type StoredEnvelope = {
  readonly storageSchema: typeof STORE_SCHEMA;
  readonly session: OperationsDemoSession;
  readonly integrityHash: string;
};

type ActiveLiveRecord = { readonly sessionId: string; readonly idleExpiresAt: string; readonly absoluteExpiresAt: string };
type DailyLedger = { readonly schemaVersion: 1; readonly utcDate: string; readonly successfulWrites: number };

function atomicWriteJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(temp, "wx");
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`, null, "utf8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temp, filePath);
}

function parseJson(filePath: string): unknown {
  try { return JSON.parse(readFileSync(filePath, "utf8")); }
  catch (error) { throw new DemoError("DEMO_PERSISTENCE_CONFLICT", "persisted demo state is unreadable", 503); }
}

function assertSession(value: unknown): OperationsDemoSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DemoError("DEMO_PERSISTENCE_CONFLICT", "session record is invalid", 503);
  const session = value as OperationsDemoSession;
  if (session.storageSchema !== "routeguard-operations-demo-session-1.0" || !SAFE_ID.test(session.sessionId) || !SAFE_ID.test(session.runId)) {
    throw new DemoError("DEMO_PERSISTENCE_CONFLICT", "session record is invalid", 503);
  }
  if (!Number.isSafeInteger(session.recordVersion) || session.recordVersion < 1 || !Array.isArray(session.steps) || !Array.isArray(session.events)) {
    throw new DemoError("DEMO_PERSISTENCE_CONFLICT", "session record validation failed", 503);
  }
  return session;
}

function envelope(session: OperationsDemoSession): StoredEnvelope {
  return { storageSchema: STORE_SCHEMA, session, integrityHash: canonicalSha256(session) };
}

export class OperationsDemoStore {
  private readonly sessionsDir: string;
  private readonly locksDir: string;
  private readonly activePath: string;
  private readonly dailyPath: string;
  private readonly lockConfig = resolveFileLockConfig({ acquireTimeoutMs: 5_000, retryIntervalMs: 10, staleAfterMs: 60_000 });

  constructor(readonly rootDir: string, private readonly nowMs: () => number = Date.now) {
    this.sessionsDir = path.join(rootDir, "sessions");
    this.locksDir = path.join(rootDir, "locks");
    this.activePath = path.join(rootDir, "active-live-session.json");
    this.dailyPath = path.join(rootDir, "daily-write-ledger.json");
  }

  initialize(): void {
    try {
      mkdirSync(this.sessionsDir, { recursive: true });
      mkdirSync(this.locksDir, { recursive: true });
      const probe = path.join(this.rootDir, `.health-${process.pid}-${randomUUID()}`);
      const fd = openSync(probe, "wx");
      writeSync(fd, "ok", null, "utf8"); fsyncSync(fd); closeSync(fd); unlinkSync(probe);
    } catch { throw new DemoError("DEMO_VOLUME_UNAVAILABLE", "demo persistence is unavailable", 503); }
  }

  private pathFor(sessionId: string): string {
    if (!SAFE_ID.test(sessionId)) throw new DemoError("DEMO_SESSION_NOT_FOUND", "session not found", 404);
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  get(sessionId: string): OperationsDemoSession | null {
    const filePath = this.pathFor(sessionId);
    if (!existsSync(filePath)) return null;
    const value = parseJson(filePath) as Partial<StoredEnvelope>;
    if (value.storageSchema !== STORE_SCHEMA || !value.session || value.integrityHash !== canonicalSha256(value.session)) {
      throw new DemoError("DEMO_PERSISTENCE_CONFLICT", "session integrity validation failed", 503);
    }
    return assertSession(value.session);
  }

  private write(session: OperationsDemoSession): void { atomicWriteJson(this.pathFor(session.sessionId), envelope(session)); }

  async create(session: OperationsDemoSession): Promise<void> {
    const lock = await acquireFileLock(path.join(this.locksDir, "create.lock"), "demo-create", this.lockConfig, this.nowMs);
    try {
      if (existsSync(this.pathFor(session.sessionId))) throw new DemoError("DEMO_PERSISTENCE_CONFLICT", "session already exists", 409);
      if (session.mode === "LIVE") {
        const active = this.activeLive();
        if (active) throw new DemoError("DEMO_SESSION_ACTIVE", "a live session is already active", 409);
        atomicWriteJson(this.activePath, { sessionId: session.sessionId, idleExpiresAt: session.idleExpiresAt, absoluteExpiresAt: session.absoluteExpiresAt });
      }
      this.write(session);
    } finally { releaseFileLock(lock); }
  }

  async mutate(sessionId: string, fn: (session: OperationsDemoSession) => OperationsDemoSession | Promise<OperationsDemoSession>): Promise<OperationsDemoSession> {
    const lock = await acquireFileLock(path.join(this.locksDir, `${sessionId}.lock`), sessionId, this.lockConfig, this.nowMs);
    try {
      const current = this.get(sessionId);
      if (!current) throw new DemoError("DEMO_SESSION_NOT_FOUND", "session not found", 404);
      const next = await fn(structuredClone(current));
      if (next.sessionId !== current.sessionId || next.recordVersion !== current.recordVersion + 1) {
        throw new DemoError("DEMO_PERSISTENCE_CONFLICT", "invalid session compare-and-swap", 409);
      }
      this.write(next);
      if (next.mode === "LIVE") {
        if (["COMPLETED", "EXPIRED", "ABORTED"].includes(next.workflowState)) this.releaseActive(next.sessionId);
        else atomicWriteJson(this.activePath, { sessionId: next.sessionId, idleExpiresAt: next.idleExpiresAt, absoluteExpiresAt: next.absoluteExpiresAt });
      }
      return next;
    } finally { releaseFileLock(lock); }
  }

  activeLive(): ActiveLiveRecord | null {
    if (!existsSync(this.activePath)) return null;
    const record = parseJson(this.activePath) as Partial<ActiveLiveRecord>;
    if (!record.sessionId || !record.idleExpiresAt || !record.absoluteExpiresAt) throw new DemoError("DEMO_PERSISTENCE_CONFLICT", "active-session lock is corrupt", 503);
    const expiresAt = Math.min(Date.parse(record.idleExpiresAt), Date.parse(record.absoluteExpiresAt));
    if (this.nowMs() >= expiresAt) {
      const session = this.get(record.sessionId);
      if (session && session.workflowState !== "EXPIRED") {
        const financial = ["ESCROW_FUNDED", "WINNER_ALLOCATED", "POD_SUBMITTED", "ADVISORY_ANCHORED", "POD_ACCEPTED"].includes(session.lastConfirmedState);
        const expired: OperationsDemoSession = {
          ...session, recordVersion: session.recordVersion + 1, workflowState: "EXPIRED", progress: "FAILED",
          updatedAt: new Date(this.nowMs()).toISOString(), operatorRecoveryRequired: financial,
          recoverableError: financial ? { code: "DEMO_OPERATOR_RECOVERY_REQUIRED", message: "expired financial session requires operator recovery" } : null,
        };
        this.write(expired);
      }
      this.releaseActive(record.sessionId);
      return null;
    }
    return record as ActiveLiveRecord;
  }

  releaseActive(sessionId: string): void {
    if (!existsSync(this.activePath)) return;
    const record = parseJson(this.activePath) as Partial<ActiveLiveRecord>;
    if (record.sessionId !== sessionId) return;
    try { unlinkSync(this.activePath); } catch { throw new DemoError("DEMO_PERSISTENCE_CONFLICT", "active-session lock could not be released", 503); }
  }

  dailySuccessfulWrites(): number {
    const today = new Date(this.nowMs()).toISOString().slice(0, 10);
    if (!existsSync(this.dailyPath)) return 0;
    const ledger = parseJson(this.dailyPath) as Partial<DailyLedger>;
    if (ledger.schemaVersion !== 1 || typeof ledger.utcDate !== "string" || !Number.isSafeInteger(ledger.successfulWrites)) {
      throw new DemoError("DEMO_PERSISTENCE_CONFLICT", "daily write ledger is corrupt", 503);
    }
    return ledger.utcDate === today ? ledger.successfulWrites! : 0;
  }

  async recordDailyWriteSuccess(count = 1): Promise<number> {
    const lock = await acquireFileLock(path.join(this.locksDir, "daily.lock"), "daily-writes", this.lockConfig, this.nowMs);
    try {
      const today = new Date(this.nowMs()).toISOString().slice(0, 10);
      const next = this.dailySuccessfulWrites() + count;
      atomicWriteJson(this.dailyPath, { schemaVersion: 1, utcDate: today, successfulWrites: next } satisfies DailyLedger);
      return next;
    } finally { releaseFileLock(lock); }
  }
}
