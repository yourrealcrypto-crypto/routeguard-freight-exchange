import type { WriteBudgetSnapshot } from "../v2/live/write-budget";

export const DEMO_MODES = ["REPLAY", "LIVE", "SIMULATION"] as const;
export type DemoMode = (typeof DEMO_MODES)[number];
export type DemoRole = "SHIPPER" | "CARRIER";
export const DEMO_ACTIONS = [
  "OPEN_TENDER", "FUND_ESCROW", "SUBMIT_OFFER", "SELECT_WINNER", "SUBMIT_POD",
  "RUN_ADVISORY", "ACCEPT_POD", "RELEASE_FREIGHT", "REQUEST_CORRECTION", "OPEN_DISPUTE",
] as const;
export type DemoAction = (typeof DEMO_ACTIONS)[number];
export type DemoProgress =
  | "READY" | "VALIDATING" | "SIGNING" | "SUBMITTING" | "AWAITING_CONSENSUS"
  | "VERIFYING_THROUGH_MIRROR" | "CONFIRMED" | "FAILED" | "RECOVERABLE";
export type DemoWorkflowState =
  | "CREATED" | "ESCROW_FUNDED" | "ACCESS_ACTIVATED" | "OFFER_ACCEPTED"
  | "WINNER_ALLOCATED" | "POD_SUBMITTED" | "ADVISORY_ANCHORED" | "POD_ACCEPTED"
  | "COMPLETED" | "FAILED" | "EXPIRED" | "ABORTED";

export type PublicTransactionReference = {
  readonly action: DemoAction;
  readonly transactionId: string;
  readonly hashScanUrl: string | null;
  readonly simulated: boolean;
  readonly receiptStatus: "SUCCESS" | null;
  readonly mirrorVerified: boolean;
};

export type DemoStepStatus = "PLANNED" | "SUBMITTING" | "RECEIPT_CONFIRMED" | "VERIFIED" | "FAILED" | "RECOVERABLE";
export type DemoStepRecord = {
  readonly schemaVersion: 1;
  readonly action: DemoAction;
  readonly actionId: string;
  readonly idempotencyKeyHash: string;
  readonly payloadHash: string;
  readonly expectedPreviousState: DemoWorkflowState;
  readonly intendedNextState: DemoWorkflowState;
  readonly subStep: string;
  readonly status: DemoStepStatus;
  readonly publicTransactionId: string | null;
  readonly receiptStatus: "SUCCESS" | null;
  readonly verificationStatus: "PENDING" | "VERIFIED" | "FAILED" | null;
  readonly hcsSequence: number | null;
  readonly safeEvidenceHash: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly retryCount: number;
  readonly publicErrorCode: string | null;
};

export type DemoEvent = {
  readonly id: number;
  readonly type: "SESSION_SNAPSHOT" | "PROGRESS_CHANGE" | "TRANSACTION_SUBMITTED" | "AWAITING_CONSENSUS" | "MIRROR_VERIFICATION" | "CONFIRMED_STATE" | "RECOVERABLE_ERROR" | "TERMINAL_STATE" | "SESSION_EXPIRY";
  readonly at: string;
  readonly data: Readonly<Record<string, unknown>>;
};

export type OperationsDemoSession = {
  readonly storageSchema: "routeguard-operations-demo-session-1.0";
  readonly recordVersion: number;
  readonly sessionId: string;
  readonly runId: string;
  readonly mode: DemoMode;
  readonly role: DemoRole;
  readonly scenario: {
    readonly label: string;
    readonly syntheticData: true;
    readonly illustrativeCommercialQuoteUsdc: "1850";
    readonly tenderId: string;
    readonly tenderVersion: number;
    readonly tenderKey: string;
    readonly podId: string;
    readonly shipperActionId: string;
  };
  readonly workflowState: DemoWorkflowState;
  readonly lastConfirmedState: DemoWorkflowState;
  readonly progress: DemoProgress;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly writeBudget: WriteBudgetSnapshot;
  readonly writesUsed: number;
  readonly fixedAmounts: {
    readonly tokenId: "0.0.429274";
    readonly tokenDecimals: 6;
    readonly maximumBudgetAtomic: "20000";
    readonly winningAmountAtomic: "15000";
    readonly excessRefundAtomic: "5000";
    readonly accessFeeAtomic: "1000";
  };
  readonly availableActions: readonly DemoAction[];
  readonly transactions: readonly PublicTransactionReference[];
  readonly contractId: string | null;
  readonly topicId: string | null;
  readonly hcsSequences: readonly number[];
  readonly escrowState: "UNFUNDED" | "FUNDED" | "ALLOCATED" | "RELEASED";
  readonly lockedAmountAtomic: string;
  readonly publicEvidenceHashes: readonly string[];
  readonly syntheticDataLabel: "SYNTHETIC_BUSINESS_DATA";
  readonly recoverableError: { readonly code: string; readonly message: string } | null;
  readonly operatorRecoveryRequired: boolean;
  readonly inFlightActionId: string | null;
  readonly steps: readonly DemoStepRecord[];
  readonly events: readonly DemoEvent[];
  readonly actionResults: Readonly<Record<string, { readonly identityHash: string; readonly response: DemoActionResult }>>;
};

export type DemoActionRequest = {
  readonly action: DemoAction;
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

export type DemoActionResult = {
  readonly outcome: "APPLIED" | "REPLAYED" | "RECOVERABLE";
  readonly sessionId: string;
  readonly action: DemoAction;
  readonly workflowState: DemoWorkflowState;
  readonly progress: DemoProgress;
  readonly writesUsed: number;
  readonly transactions: readonly PublicTransactionReference[];
};

export type DemoCapabilities = {
  readonly replayAvailable: boolean;
  readonly simulationAvailable: boolean;
  readonly liveModeEnabled: boolean;
  readonly liveModeReason: string;
  readonly activeLiveSession: { readonly active: boolean; readonly sessionId: string | null; readonly expiresAt: string | null };
  readonly effectiveAmountCaps: OperationsDemoSession["fixedAmounts"];
  readonly perSessionWriteLimit: number;
  readonly dailyWriteLimit: number;
  readonly contractConfigured: boolean;
  readonly topicConfigured: boolean;
  readonly mirrorReady: boolean;
  readonly controlledBalancesReady: boolean;
  readonly testnetOnly: true;
};
