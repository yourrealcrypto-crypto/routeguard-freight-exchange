import { canonicalSha256 } from "../domain/canonical-hash";
import { hashScanTransactionUrl } from "../v2/access/mirror-reconcile";
import { DemoError } from "./errors";
import { OperationsDemoStore } from "./store";
import type { DemoAction, DemoStepRecord, DemoWorkflowState, OperationsDemoSession } from "./types";

export class TransactionReceiptJournal {
  constructor(private readonly store: OperationsDemoStore, private readonly now: () => string = () => new Date().toISOString()) {}

  findSuccessfulReceipt(session: OperationsDemoSession, actionId: string, subStep: string): DemoStepRecord | null {
    return session.steps.find((step) => step.actionId === actionId && step.subStep === subStep && step.receiptStatus === "SUCCESS") ?? null;
  }

  async plan(input: {
    sessionId: string; action: DemoAction; actionId: string; idempotencyKeyHash: string; payloadHash: string;
    expectedPreviousState: DemoWorkflowState; intendedNextState: DemoWorkflowState; subStep: string;
  }): Promise<DemoStepRecord> {
    const existingSession = this.store.get(input.sessionId);
    const existing = existingSession?.steps.find((step) => step.actionId === input.actionId && step.subStep === input.subStep);
    if (existing) {
      if (existing.idempotencyKeyHash !== input.idempotencyKeyHash || existing.payloadHash !== input.payloadHash) {
        throw new DemoError("DEMO_ACTION_CONFLICT", "step identity conflicts with its journal", 409);
      }
      return existing;
    }
    const at = this.now();
    const planned: DemoStepRecord = {
      schemaVersion: 1, action: input.action, actionId: input.actionId,
      idempotencyKeyHash: input.idempotencyKeyHash, payloadHash: input.payloadHash,
      expectedPreviousState: input.expectedPreviousState, intendedNextState: input.intendedNextState,
      subStep: input.subStep, status: "PLANNED", publicTransactionId: null, receiptStatus: null,
      verificationStatus: null, hcsSequence: null, safeEvidenceHash: null,
      createdAt: at, updatedAt: at, retryCount: 0, publicErrorCode: null,
    };
    await this.store.mutate(input.sessionId, (session) => ({
      ...session, recordVersion: session.recordVersion + 1, updatedAt: at, steps: [...session.steps, planned],
    }));
    return planned;
  }

  async receipt(input: {
    sessionId: string; actionId: string; subStep: string; transactionId: string; hcsSequence?: number;
  }): Promise<DemoStepRecord> {
    const current = this.store.get(input.sessionId);
    if (!current) throw new DemoError("DEMO_SESSION_NOT_FOUND", "session not found", 404);
    const prior = this.findSuccessfulReceipt(current, input.actionId, input.subStep);
    if (prior) {
      if (prior.publicTransactionId !== input.transactionId) throw new DemoError("DEMO_PERSISTENCE_CONFLICT", "receipt transaction identity changed", 409);
      return prior;
    }
    if (current.writesUsed + 1 > current.writeBudget.perSessionCeiling) throw new DemoError("DEMO_WRITE_BUDGET_EXCEEDED", "session write ceiling exceeded", 409);
    if (this.store.dailySuccessfulWrites() + 1 > current.writeBudget.dailyCeiling) throw new DemoError("DEMO_DAILY_LIMIT_REACHED", "daily write ceiling exceeded", 409);
    await this.store.recordDailyWriteSuccess(1); // fail-safe accounting: count before session commit
    const updated = await this.store.mutate(input.sessionId, (session) => {
      const index = session.steps.findIndex((step) => step.actionId === input.actionId && step.subStep === input.subStep);
      if (index < 0) throw new DemoError("DEMO_PERSISTENCE_CONFLICT", "receipt has no planned journal step", 409);
      const step = session.steps[index]!;
      const at = this.now();
      const nextStep: DemoStepRecord = {
        ...step, status: "RECEIPT_CONFIRMED", publicTransactionId: input.transactionId,
        receiptStatus: "SUCCESS", verificationStatus: "PENDING", hcsSequence: input.hcsSequence ?? null,
        safeEvidenceHash: canonicalSha256({ action: step.action, actionId: step.actionId, subStep: step.subStep, transactionId: input.transactionId, hcsSequence: input.hcsSequence ?? null }),
        updatedAt: at,
      };
      const steps = [...session.steps]; steps[index] = nextStep;
      const eventId = (session.events.at(-1)?.id ?? 0) + 1;
      return {
        ...session, recordVersion: session.recordVersion + 1, updatedAt: at, steps,
        writesUsed: session.writesUsed + 1,
        writeBudget: {
          ...session.writeBudget,
          attemptedWrites: session.writeBudget.attemptedWrites + 1,
          successfulStateChangingWrites: session.writesUsed + 1,
          dailySuccessfulWrites: session.writeBudget.dailySuccessfulWrites + 1,
          currentAction: step.action,
        },
        events: [...session.events, { id: eventId, type: "TRANSACTION_SUBMITTED" as const, at, data: { action: step.action, transactionId: input.transactionId, hashScanUrl: hashScanTransactionUrl(input.transactionId) } }],
      };
    });
    return this.findSuccessfulReceipt(updated, input.actionId, input.subStep)!;
  }

  async verify(input: { sessionId: string; actionId: string; subStep: string; evidenceHash: string; hcsSequence?: number }): Promise<DemoStepRecord> {
    const updated = await this.store.mutate(input.sessionId, (session) => {
      const index = session.steps.findIndex((step) => step.actionId === input.actionId && step.subStep === input.subStep);
      if (index < 0 || session.steps[index]!.receiptStatus !== "SUCCESS") throw new DemoError("DEMO_PERSISTENCE_CONFLICT", "verification requires a successful receipt", 409);
      const step = session.steps[index]!;
      const at = this.now();
      const steps = [...session.steps];
      steps[index] = { ...step, status: "VERIFIED", verificationStatus: "VERIFIED", safeEvidenceHash: input.evidenceHash, hcsSequence: input.hcsSequence ?? step.hcsSequence, updatedAt: at };
      const eventId = (session.events.at(-1)?.id ?? 0) + 1;
      return {
        ...session, recordVersion: session.recordVersion + 1, updatedAt: at, steps,
        events: [...session.events, { id: eventId, type: "MIRROR_VERIFICATION" as const, at, data: { action: step.action, transactionId: step.publicTransactionId, verified: true } }],
      };
    });
    return updated.steps.find((step) => step.actionId === input.actionId && step.subStep === input.subStep)!;
  }
}
