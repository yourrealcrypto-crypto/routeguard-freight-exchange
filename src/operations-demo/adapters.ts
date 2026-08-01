import { canonicalSha256 } from "../domain/canonical-hash";
import type { MirrorReader } from "../v2/live/mirror-reader";
import type { ContractExecutor } from "../v2/live/contract-executor";
import type { HcsV2Submitter } from "../v2/live/hcs-submitter";
import type { X402Payer } from "../v2/live/x402-payer";
import {
  LIVE_SUCCESSFUL_PATH_WRITES,
  IMMUTABLE_PROOF_CONTRACT_ID,
  IMMUTABLE_PROOF_TOPIC_ID,
} from "./constants";
import { DemoError } from "./errors";
import type {
  DemoActionRequest, DemoStepRecord, OperationsDemoSession, PublicTransactionReference,
} from "./types";

export type AdapterActionResult = {
  readonly steps: readonly DemoStepRecord[];
  readonly transactions: readonly PublicTransactionReference[];
  readonly hcsSequences: readonly number[];
  readonly evidenceHashes: readonly string[];
  readonly writes: number;
};

export type AdapterExecutionContext = { readonly podResult?: unknown };

export interface OperationsModeAdapter {
  execute(session: OperationsDemoSession, request: DemoActionRequest, intendedState: OperationsDemoSession["workflowState"], context?: AdapterExecutionContext): Promise<AdapterActionResult>;
}

export class SimulationAdapter implements OperationsModeAdapter {
  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  async execute(session: OperationsDemoSession, request: DemoActionRequest, intendedState: OperationsDemoSession["workflowState"]): Promise<AdapterActionResult> {
    const writeCount = LIVE_SUCCESSFUL_PATH_WRITES[request.action as keyof typeof LIVE_SUCCESSFUL_PATH_WRITES] ?? 0;
    const createdAt = this.now();
    const identity = canonicalSha256({ sessionId: session.sessionId, action: request.action, actionId: request.actionId, payload: request.payload });
    const transactions = Array.from({ length: writeCount }, (_, index): PublicTransactionReference => ({
      action: request.action,
      transactionId: `sim:${session.runId}:${request.action.toLowerCase()}:${index + 1}`,
      hashScanUrl: null,
      simulated: true,
      receiptStatus: "SUCCESS",
      mirrorVerified: true,
    }));
    const hcsWrites = ["SUBMIT_POD", "RUN_ADVISORY", "ACCEPT_POD"].includes(request.action)
      ? 1 : request.action === "RELEASE_FREIGHT" ? 2 : 0;
    const priorSequence = session.hcsSequences.at(-1) ?? 0;
    const hcsSequences = Array.from({ length: hcsWrites }, (_, index) => priorSequence + index + 1);
    const step: DemoStepRecord = {
      schemaVersion: 1,
      action: request.action,
      actionId: request.actionId,
      idempotencyKeyHash: canonicalSha256(request.idempotencyKey),
      payloadHash: canonicalSha256(request.payload),
      expectedPreviousState: session.workflowState,
      intendedNextState: intendedState,
      subStep: "SIMULATED_CANONICAL_EXECUTION",
      status: "VERIFIED",
      publicTransactionId: transactions[0]?.transactionId ?? null,
      receiptStatus: transactions.length ? "SUCCESS" : null,
      verificationStatus: transactions.length ? "VERIFIED" : null,
      hcsSequence: hcsSequences[0] ?? null,
      safeEvidenceHash: identity,
      createdAt,
      updatedAt: createdAt,
      retryCount: 0,
      publicErrorCode: null,
    };
    return { steps: [step], transactions, hcsSequences, evidenceHashes: [identity], writes: 0 };
  }
}

export type LiveActionExecutor = (
  session: OperationsDemoSession,
  request: DemoActionRequest,
  intendedState: OperationsDemoSession["workflowState"],
  context?: AdapterExecutionContext,
) => Promise<AdapterActionResult>;

export type LiveHederaServiceComposition = {
  readonly contractExecutor: ContractExecutor;
  readonly hcsSubmitter: HcsV2Submitter;
  readonly x402Payer: X402Payer;
  readonly mirror: MirrorReader;
  /** Action coordinator that uses only the supplied extracted services. */
  readonly execute: LiveActionExecutor;
};

export class LiveHederaAdapter implements OperationsModeAdapter {
  static fromServices(input: {
    readonly contractId: string;
    readonly topicId: string;
    readonly services: LiveHederaServiceComposition;
  }): LiveHederaAdapter {
    if (input.services.contractExecutor.binding().contractId !== input.contractId) {
      throw new DemoError("DEMO_CONFIG_INVALID", "contract executor binding mismatch", 503);
    }
    if (input.services.hcsSubmitter.binding().topicId !== input.topicId) {
      throw new DemoError("DEMO_CONFIG_INVALID", "HCS submitter binding mismatch", 503);
    }
    return new LiveHederaAdapter(input.contractId, input.topicId, input.services.execute, input.services.mirror);
  }

  constructor(
    readonly contractId: string,
    readonly topicId: string,
    private readonly executeLiveAction: LiveActionExecutor,
    readonly mirror: MirrorReader,
  ) {
    if (contractId === IMMUTABLE_PROOF_CONTRACT_ID) throw new DemoError("DEMO_CONFIG_INVALID", "immutable proof contract is frozen", 503);
    if (topicId === IMMUTABLE_PROOF_TOPIC_ID) throw new DemoError("DEMO_CONFIG_INVALID", "immutable proof topic is frozen", 503);
  }

  execute(session: OperationsDemoSession, request: DemoActionRequest, intendedState: OperationsDemoSession["workflowState"], context?: AdapterExecutionContext): Promise<AdapterActionResult> {
    return this.executeLiveAction(session, request, intendedState, context);
  }
}

export class DisabledLiveAdapter implements OperationsModeAdapter {
  constructor(private readonly reason: "DEMO_LIVE_DISABLED" | "DEMO_INFRASTRUCTURE_PENDING" | "DEMO_CONFIG_INVALID") {}
  async execute(): Promise<AdapterActionResult> { throw new DemoError(this.reason, "live Operations Demo is not available", 503); }
}
