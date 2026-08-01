import { createHash, randomUUID } from "node:crypto";

import { canonicalSha256 } from "../domain/canonical-hash";
import { WriteBudget } from "../v2/live/write-budget";
import type { PodService } from "../v2/pod/service";
import type { OperationsDemoConfig } from "./config";
import { adminTokenMatches } from "./config";
import {
  DEMO_EXCESS_REFUND_ATOMIC, DEMO_MAX_BUDGET_ATOMIC, DEMO_TOKEN_DECIMALS, DEMO_TOKEN_ID,
  DEMO_WINNING_AMOUNT_ATOMIC, DEMO_X402_ACCESS_FEE_ATOMIC, LIVE_PROJECTED_WRITES,
} from "./constants";
import type { OperationsModeAdapter } from "./adapters";
import { SimulationAdapter } from "./adapters";
import { DemoError } from "./errors";
import { CompletedReplayAdapter } from "./replay";
import { actionIdentityHash, assertSafeActionRequest, availableActions, transitionFor } from "./state-machine";
import { OperationsDemoStore } from "./store";
import type {
  DemoActionRequest, DemoActionResult, DemoEvent, DemoMode, DemoRole, DemoWorkflowState, OperationsDemoSession,
} from "./types";

function addMinutes(iso: string, minutes: number): string { return new Date(Date.parse(iso) + minutes * 60_000).toISOString(); }
function hexHash(value: unknown): string { return `0x${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }

export type OperationsPodWorkflow = {
  readonly service: Pick<PodService, "submitPod" | "startReview" | "shipperReview">;
  readonly buildSubmission: (session: OperationsDemoSession, request: DemoActionRequest) => Parameters<PodService["submitPod"]>[0];
  readonly buildReview: (session: OperationsDemoSession, request: DemoActionRequest) => Parameters<PodService["startReview"]>[0];
  readonly buildAcceptance: (session: OperationsDemoSession, request: DemoActionRequest) => Parameters<PodService["shipperReview"]>[0];
};

export class OperationsDemoOrchestrator {
  private readonly simulation: OperationsModeAdapter;

  constructor(
    readonly config: OperationsDemoConfig,
    readonly store: OperationsDemoStore,
    readonly replay = new CompletedReplayAdapter(),
    simulation: OperationsModeAdapter = new SimulationAdapter(),
    private readonly live: OperationsModeAdapter | null = null,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly podWorkflow: OperationsPodWorkflow | null = null,
  ) { this.simulation = simulation; }

  get liveAdapterReady(): boolean { return this.live !== null; }

  initialize(): void { this.replay.load(); this.store.initialize(); }

  private event(session: OperationsDemoSession, type: DemoEvent["type"], data: Record<string, unknown>): DemoEvent {
    return { id: (session.events.at(-1)?.id ?? 0) + 1, type, at: this.now(), data };
  }

  private initialSession(mode: DemoMode, role: DemoRole): OperationsDemoSession {
    const now = this.now();
    const sessionId = `demo-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    const tenderId = `RG-DEMO-${randomUUID()}`;
    const tenderVersion = 1;
    const tenderKey = hexHash({ tenderId, tenderVersion });
    const evidenceHashes = [
      canonicalSha256({ domain: "ROUTEGUARD_DEMO_CREATION", sessionId, tenderId, tenderVersion }),
      canonicalSha256({ domain: "ROUTEGUARD_DEMO_ALLOCATION", sessionId, tenderId, tenderVersion }),
      canonicalSha256({ domain: "ROUTEGUARD_DEMO_RELEASE", sessionId, tenderId, tenderVersion }),
    ];
    const budget = new WriteBudget(mode === "LIVE" ? LIVE_PROJECTED_WRITES : 0, this.config.maxWritesPerSession, this.store.dailySuccessfulWrites(), this.config.maxWritesPerDay);
    const base: OperationsDemoSession = {
      storageSchema: "routeguard-operations-demo-session-1.0",
      recordVersion: 1,
      sessionId, runId, mode, role,
      scenario: {
        label: "Synthetic Munich freight delivery",
        syntheticData: true,
        illustrativeCommercialQuoteUsdc: "1850",
        tenderId, tenderVersion, tenderKey,
        podId: `POD-${randomUUID()}`,
        shipperActionId: `shipper-${randomUUID()}`,
      },
      workflowState: "CREATED", lastConfirmedState: "CREATED", progress: "READY",
      createdAt: now, updatedAt: now,
      idleExpiresAt: addMinutes(now, this.config.idleTtlMinutes),
      absoluteExpiresAt: addMinutes(now, this.config.absoluteTtlMinutes),
      writeBudget: budget.snapshot(), writesUsed: 0,
      fixedAmounts: {
        tokenId: DEMO_TOKEN_ID, tokenDecimals: DEMO_TOKEN_DECIMALS,
        maximumBudgetAtomic: DEMO_MAX_BUDGET_ATOMIC, winningAmountAtomic: DEMO_WINNING_AMOUNT_ATOMIC,
        excessRefundAtomic: DEMO_EXCESS_REFUND_ATOMIC, accessFeeAtomic: DEMO_X402_ACCESS_FEE_ATOMIC,
      },
      availableActions: ["OPEN_TENDER"], transactions: [],
      contractId: mode === "LIVE" ? this.config.contractId : null,
      topicId: mode === "LIVE" ? this.config.topicId : null,
      hcsSequences: [], escrowState: "UNFUNDED", lockedAmountAtomic: "0",
      publicEvidenceHashes: evidenceHashes, syntheticDataLabel: "SYNTHETIC_BUSINESS_DATA",
      recoverableError: null, operatorRecoveryRequired: false, inFlightActionId: null,
      steps: [], events: [], actionResults: {},
    };
    return { ...base, events: [this.event(base, "SESSION_SNAPSHOT", { workflowState: base.workflowState, mode })] };
  }

  async createSession(mode: DemoMode, role: DemoRole = "SHIPPER", adminToken: string | null = null): Promise<OperationsDemoSession> {
    if (mode === "LIVE") {
      if (!this.config.liveEnabled) {
        const code = this.config.liveReason === "DISABLED_DEMO_INFRASTRUCTURE_PENDING" ? "DEMO_INFRASTRUCTURE_PENDING" : this.config.liveReason === "DEMO_CONFIG_INVALID" ? "DEMO_CONFIG_INVALID" : "DEMO_LIVE_DISABLED";
        throw new DemoError(code, "live Operations Demo is disabled", 503);
      }
      if (!this.live) throw new DemoError("DEMO_INFRASTRUCTURE_PENDING", "live adapter infrastructure is pending", 503);
      if (!adminTokenMatches(this.config, adminToken)) throw new DemoError("DEMO_ADMIN_REQUIRED", "live demo authorization is required", 401);
    }
    let session = this.initialSession(mode, role);
    if (mode === "REPLAY") {
      const proof = this.replay.load();
      session = {
        ...session, workflowState: "COMPLETED", lastConfirmedState: "COMPLETED", progress: "CONFIRMED",
        availableActions: [], contractId: proof.contractId, topicId: proof.topicId,
        hcsSequences: proof.hcsSequence.map((item) => item.sequenceNumber), escrowState: "RELEASED", lockedAmountAtomic: "0",
        publicEvidenceHashes: [...session.publicEvidenceHashes, proof.evidenceHash],
      };
    }
    await this.store.create(session);
    return session;
  }

  async getSession(sessionId: string): Promise<OperationsDemoSession> {
    let session = this.store.get(sessionId);
    if (!session) throw new DemoError("DEMO_SESSION_NOT_FOUND", "session not found", 404);
    const expiresAt = Math.min(Date.parse(session.idleExpiresAt), Date.parse(session.absoluteExpiresAt));
    if (!["COMPLETED", "EXPIRED", "ABORTED"].includes(session.workflowState) && Date.parse(this.now()) >= expiresAt) {
      session = await this.store.mutate(sessionId, (current) => {
        const financial = ["ESCROW_FUNDED", "WINNER_ALLOCATED", "POD_SUBMITTED", "ADVISORY_ANCHORED", "POD_ACCEPTED"].includes(current.lastConfirmedState);
        const next: OperationsDemoSession = {
          ...current, recordVersion: current.recordVersion + 1, workflowState: "EXPIRED", progress: "FAILED",
          updatedAt: this.now(), availableActions: [], operatorRecoveryRequired: financial,
          recoverableError: financial ? { code: "DEMO_OPERATOR_RECOVERY_REQUIRED", message: "expired financial session requires operator recovery" } : null,
        };
        return { ...next, events: [...next.events, this.event(next, "SESSION_EXPIRY", { operatorRecoveryRequired: financial })] };
      });
    }
    return session;
  }

  async act(sessionId: string, request: DemoActionRequest): Promise<DemoActionResult> {
    assertSafeActionRequest(request);
    let session = await this.getSession(sessionId);
    if (session.mode === "REPLAY") throw new DemoError("DEMO_ACTION_NOT_ALLOWED", "replay is immutable", 409);
    const identityHash = actionIdentityHash(request);
    const prior = session.actionResults[request.actionId];
    if (prior) {
      if (prior.identityHash !== identityHash) throw new DemoError("DEMO_ACTION_CONFLICT", "action identity conflicts with the committed action", 409);
      return prior.response;
    }
    const intendedState = transitionFor(session.workflowState === "FAILED" ? session.lastConfirmedState : session.workflowState, request.action);
    session = await this.store.mutate(sessionId, (current) => {
      const existing = current.actionResults[request.actionId];
      if (existing) {
        if (existing.identityHash !== identityHash) throw new DemoError("DEMO_ACTION_CONFLICT", "action identity conflicts with the committed action", 409);
        return { ...current, recordVersion: current.recordVersion + 1 };
      }
      if (current.inFlightActionId) throw new DemoError("DEMO_ACTION_IN_PROGRESS", "another action is in progress", 409);
      const next: OperationsDemoSession = {
        ...current, recordVersion: current.recordVersion + 1, inFlightActionId: request.actionId,
        progress: "VALIDATING", updatedAt: this.now(),
      };
      return { ...next, events: [...next.events, this.event(next, "PROGRESS_CHANGE", { action: request.action, progress: "VALIDATING" })] };
    });
    const committedByConcurrentCaller = session.actionResults[request.actionId];
    if (committedByConcurrentCaller) return committedByConcurrentCaller.response;
    const adapter = session.mode === "SIMULATION" ? this.simulation : this.live;
    if (!adapter) throw new DemoError("DEMO_INFRASTRUCTURE_PENDING", "live adapter infrastructure is pending", 503);
    try {
      let podResult: unknown;
      if (session.mode === "LIVE" && ["SUBMIT_POD", "RUN_ADVISORY", "ACCEPT_POD"].includes(request.action)) {
        if (!this.podWorkflow) throw new DemoError("DEMO_INFRASTRUCTURE_PENDING", "direct POD service composition is pending", 503);
        if (request.action === "SUBMIT_POD") podResult = await this.podWorkflow.service.submitPod(this.podWorkflow.buildSubmission(session, request));
        else if (request.action === "RUN_ADVISORY") podResult = await this.podWorkflow.service.startReview(this.podWorkflow.buildReview(session, request));
        else podResult = await this.podWorkflow.service.shipperReview(this.podWorkflow.buildAcceptance(session, request));
      }
      const executed = await adapter.execute(session, request, intendedState, podResult === undefined ? undefined : { podResult });
      const committed = await this.store.mutate(sessionId, (current) => {
        if (current.inFlightActionId !== request.actionId) throw new DemoError("DEMO_PERSISTENCE_CONFLICT", "in-flight action ownership changed", 409);
        const writesUsed = current.writesUsed + executed.writes;
        if (writesUsed > this.config.maxWritesPerSession) throw new DemoError("DEMO_WRITE_BUDGET_EXCEEDED", "session write ceiling exceeded", 409);
        let escrowState = current.escrowState;
        let lockedAmountAtomic = current.lockedAmountAtomic;
        if (intendedState === "ESCROW_FUNDED") { escrowState = "FUNDED"; lockedAmountAtomic = DEMO_MAX_BUDGET_ATOMIC; }
        if (intendedState === "WINNER_ALLOCATED") { escrowState = "ALLOCATED"; lockedAmountAtomic = DEMO_WINNING_AMOUNT_ATOMIC; }
        if (intendedState === "COMPLETED") { escrowState = "RELEASED"; lockedAmountAtomic = "0"; }
        const response: DemoActionResult = {
          outcome: "APPLIED", sessionId, action: request.action, workflowState: intendedState,
          progress: "CONFIRMED", writesUsed, transactions: executed.transactions,
        };
        const next: OperationsDemoSession = {
          ...current, recordVersion: current.recordVersion + 1, workflowState: intendedState,
          lastConfirmedState: intendedState, progress: "CONFIRMED", updatedAt: this.now(),
          idleExpiresAt: addMinutes(this.now(), this.config.idleTtlMinutes),
          availableActions: availableActions(intendedState),
          transactions: [...current.transactions, ...executed.transactions],
          hcsSequences: [...current.hcsSequences, ...executed.hcsSequences],
          publicEvidenceHashes: [...current.publicEvidenceHashes, ...executed.evidenceHashes],
          steps: [...current.steps, ...executed.steps], writesUsed,
          writeBudget: { ...current.writeBudget, attemptedWrites: current.writeBudget.attemptedWrites + executed.writes, successfulStateChangingWrites: writesUsed, currentAction: null },
          escrowState, lockedAmountAtomic, inFlightActionId: null, recoverableError: null,
          actionResults: { ...current.actionResults, [request.actionId]: { identityHash, response } },
        };
        const terminal = intendedState === "COMPLETED";
        return { ...next, events: [...next.events, this.event(next, terminal ? "TERMINAL_STATE" : "CONFIRMED_STATE", { action: request.action, workflowState: intendedState })] };
      });
      if (executed.writes > 0) await this.store.recordDailyWriteSuccess(executed.writes);
      return committed.actionResults[request.actionId]!.response;
    } catch (error) {
      await this.store.mutate(sessionId, (current) => {
        const recoverable = current.steps.some((step) => step.actionId === request.actionId && step.receiptStatus === "SUCCESS");
        const code = recoverable ? "DEMO_TRANSACTION_SUBMITTED_VERIFICATION_PENDING" : error instanceof DemoError ? error.code : "DEMO_CONFIG_INVALID";
        const next: OperationsDemoSession = {
          ...current, recordVersion: current.recordVersion + 1, inFlightActionId: null,
          workflowState: recoverable ? current.lastConfirmedState : "FAILED",
          progress: recoverable ? "RECOVERABLE" : "FAILED", updatedAt: this.now(),
          recoverableError: { code, message: recoverable ? "submitted transaction awaits verification" : "action failed safely" },
        };
        return { ...next, events: [...next.events, this.event(next, recoverable ? "RECOVERABLE_ERROR" : "PROGRESS_CHANGE", { action: request.action, code })] };
      });
      throw error;
    }
  }
}
