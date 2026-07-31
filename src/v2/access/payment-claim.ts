import type { AccessActionType } from "./fee";
import type { SettledAccessPayment } from "./x402-gate";

export const PAYMENT_CLAIM_SCHEMA = "routeguard-v2-payment-claim-1.0" as const;
export const PAYMENT_CLAIM_STATES = [
  "CLAIMED",
  "SETTLING",
  "SETTLED_PENDING_COMMIT",
  "COMMITTED",
  "FAILED",
] as const;
export type PaymentClaimState = (typeof PAYMENT_CLAIM_STATES)[number];

export type PaymentClaimBinding = {
  readonly actionType: AccessActionType;
  readonly actionId: string;
  readonly tenderId: string;
  readonly tenderVersion: number;
  readonly bidId: string | null;
  readonly payerAccount: string;
  readonly payTo: string;
  readonly asset: string;
  readonly amountAtomic: string;
  readonly resource: string;
  readonly paymentPayloadHash: string;
  /** Binds the validated protected-resource request without storing its body. */
  readonly requestHash: string;
};

export type PaymentClaimResultRef = {
  readonly kind: "TENDER_ACTIVATION" | "CARRIER_BID";
  readonly tenderId: string;
  readonly tenderVersion: number;
  readonly bidId: string | null;
  readonly actionId: string;
};

export type PaymentClaim = {
  readonly schemaVersion: typeof PAYMENT_CLAIM_SCHEMA;
  readonly claimVersion: number;
  readonly binding: PaymentClaimBinding;
  readonly state: PaymentClaimState;
  readonly settlement: SettledAccessPayment | null;
  readonly resultRef: PaymentClaimResultRef | null;
  readonly failureCode: string | null;
  readonly retryable: boolean | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type PaymentReconciliationResult =
  | { readonly status: "CONFIRMED"; readonly settlement: SettledAccessPayment }
  | { readonly status: "FAILED"; readonly failureCode: string }
  | { readonly status: "UNKNOWN" };

export interface PaymentSettlementReconciler {
  reconcile(claim: PaymentClaim): Promise<PaymentReconciliationResult>;
}

/** Production-safe default: never performs a network read and never resettles. */
export class UnknownPaymentSettlementReconciler
  implements PaymentSettlementReconciler
{
  async reconcile(): Promise<PaymentReconciliationResult> {
    return { status: "UNKNOWN" };
  }
}

export type PaymentRecoveryFaultBoundary =
  | "AFTER_CLAIM_CREATED"
  | "AFTER_SETTLEMENT"
  | "BEFORE_RESOURCE_COMMIT"
  | "AFTER_RESOURCE_COMMIT"
  | "BEFORE_CLAIM_FINALIZATION";

export type PaymentRecoveryFaultInjector = (
  boundary: PaymentRecoveryFaultBoundary,
  claim: PaymentClaim,
) => void | Promise<void>;
