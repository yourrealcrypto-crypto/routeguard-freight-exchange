import type { SignedAcceptanceReceipt } from "../domain/acceptance-receipt";
import type { SignedCarrierBid } from "../domain/bid";
import type { CommitmentEvidence } from "../domain/commitment-evidence";
import type { FreightTender } from "../domain/tender";

export const ENGINE_VERSION = "routeguard-auction-1.0" as const;
export const SELECTION_POLICY = "LOWEST_QUALIFIED_PRICE_V1" as const;

export type EligibilityReasonCode =
  | "LATE_COMMITMENT"
  | "FULL_BID_MISSING"
  | "BID_HASH_MISMATCH"
  | "BID_VERSION_MISMATCH"
  | "ACCEPTANCE_RECEIPT_MISMATCH"
  | "INVALID_BID_SIGNATURE"
  | "INVALID_COMMITMENT_SCHEMA"
  | "INVALID_BID_SCHEMA"
  | "INVALID_ACCEPTANCE_RECEIPT"
  | "CARRIER_NOT_REGISTERED"
  | "CARRIER_INACTIVE"
  | "CARRIER_ACCOUNT_MISMATCH"
  | "TENDER_MISMATCH"
  | "BID_EXPIRED"
  | "EQUIPMENT_MISMATCH"
  | "EQUIPMENT_NOT_AUTHORIZED"
  | "CAPACITY_NOT_CONFIRMED"
  | "PICKUP_WINDOW_INFEASIBLE"
  | "DELIVERY_DEADLINE_MISSED"
  | "PRICE_ABOVE_MAXIMUM"
  | "PAYMENT_RECIPIENT_MISMATCH"
  | "INVALID_PAYMENT_OPTIONS";

/** Deterministic output order for reason codes. */
export const REASON_CODE_ORDER: readonly EligibilityReasonCode[] = [
  "INVALID_COMMITMENT_SCHEMA",
  "LATE_COMMITMENT",
  "TENDER_MISMATCH",
  "FULL_BID_MISSING",
  "INVALID_BID_SCHEMA",
  "BID_VERSION_MISMATCH",
  "BID_HASH_MISMATCH",
  "INVALID_ACCEPTANCE_RECEIPT",
  "ACCEPTANCE_RECEIPT_MISMATCH",
  "CARRIER_NOT_REGISTERED",
  "CARRIER_INACTIVE",
  "CARRIER_ACCOUNT_MISMATCH",
  "INVALID_BID_SIGNATURE",
  "BID_EXPIRED",
  "EQUIPMENT_MISMATCH",
  "EQUIPMENT_NOT_AUTHORIZED",
  "CAPACITY_NOT_CONFIRMED",
  "PICKUP_WINDOW_INFEASIBLE",
  "DELIVERY_DEADLINE_MISSED",
  "PRICE_ABOVE_MAXIMUM",
  "INVALID_PAYMENT_OPTIONS",
  "PAYMENT_RECIPIENT_MISMATCH",
] as const;

export type BidDecision = "QUALIFIED" | "REJECTED";

export type EligibilityResult = {
  bidId: string;
  carrierId: string;
  decision: BidDecision;
  reasonCodes: EligibilityReasonCode[];
  freightPriceCents: number | null;
  estimatedDelivery: string | null;
  consensusTimestamp: string;
  hcsSequence: number;
  bidHash: string | null;
  /** Evidence fields for evaluatedBidSetHash */
  timely: boolean;
  /** Submitted signed-bid envelope present (raw input, pre-schema). */
  submittedSignedBidPresent: boolean;
  /** Hash of submitted signed-bid envelope (binds malformed content). */
  submittedSignedBidEnvelopeHash: string | null;
  /** Submitted receipt present (raw input, pre-schema). */
  submittedReceiptPresent: boolean;
  /** Hash of submitted receipt envelope (binds malformed content). */
  submittedReceiptEnvelopeHash: string | null;
  fullBidSchemaValid: boolean | null;
  receiptSchemaValid: boolean | null;
  fullBidPresent: boolean;
  validatedFullBidHash: string | null;
  /** Hash of validated signed-bid envelope, or null if schema failed. */
  signedBidEnvelopeHash: string | null;
  receiptPresent: boolean;
  validatedReceiptHash: string | null;
  bidVersionMatch: boolean | null;
  signatureValid: boolean | null;
  commitment: CommitmentEvidence | null;
};

export type ManifestEntry = {
  bidId: string;
  carrierId: string;
  hcsSequence: number;
  consensusTimestamp: string;
  decision: BidDecision;
  reasonCodes: EligibilityReasonCode[];
};

export type DecisionManifest = {
  tenderId: string;
  tenderVersion: number;
  tenderHash: string;
  engineVersion: typeof ENGINE_VERSION;
  selectionPolicy: typeof SELECTION_POLICY;
  rulesHash: string;
  evaluationTimestamp: string;
  barrierSequence: number;
  reconciliationReference: string;
  commitments: ManifestEntry[];
  winningBidId: string | null;
  winningBidHash: string | null;
  evaluatedBidSetHash: string;
  decisionManifestHash: string;
};

export type AuctionEvaluationInput = {
  tender: FreightTender;
  commitments: CommitmentEvidence[];
  fullBids: ReadonlyMap<string, SignedCarrierBid>;
  acceptanceReceipts: ReadonlyMap<string, SignedAcceptanceReceipt>;
  evaluationTimestamp: string;
  barrierSequence: number;
  reconciliationReference: string;
  routeGuardPublicKey: string;
};

export type AuctionState =
  | "DRAFT"
  | "OPEN"
  | "BIDDING"
  | "AUCTION_RECONCILIATION_PENDING"
  | "AUCTION_CLOSED"
  | "WINNER_SELECTED"
  | "NO_QUALIFIED_BID"
  | "INCOMPLETE_HCS_WINDOW";

export type ReconciliationErrorCode =
  | "DUPLICATE_HCS_SEQUENCE"
  | "DUPLICATE_BID_ID"
  | "DUPLICATE_COMMITMENT"
  | "DUPLICATE_FULL_BID"
  | "DUPLICATE_ACCEPTANCE_RECEIPT"
  | "AMBIGUOUS_BID_ASSIGNMENT"
  | "INCOMPLETE_SEQUENCE_RANGE"
  | "INVALID_CLOSURE_PROOF"
  | "MANIFEST_INTEGRITY_FAILURE"
  | "UNSUPPORTED_EVIDENCE_TYPE";
