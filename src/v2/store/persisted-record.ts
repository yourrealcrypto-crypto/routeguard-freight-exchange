/**
 * Authoritative persisted-envelope format for the v2 lifecycle file store, and
 * complete fail-closed validation of everything read back from disk.
 *
 * Nothing loaded from storage is trusted: bytes are decoded, parsed inside
 * controlled error handling, then structurally and cross-field validated. No
 * `as` cast substitutes for validation, and no malformed authoritative state is
 * partially recovered — corruption always surfaces as a typed error.
 */

import { canonicalSha256 } from "../../domain/canonical-hash";
import { isValidHederaAccountId } from "../../domain/payment-option";
import { compareUtc, isUtcIsoTimestamp } from "../../domain/time";
import {
  ACCESS_FEE_TOKEN_ID,
  deriveAccessFeeAtomic,
  isNonNegativeAtomicString,
  isPositiveAtomicString,
} from "../access/fee";
import { tenderActivateResource } from "../access/resource";
import { LIFECYCLE_EVENT_TYPES } from "../lifecycle/events";
import {
  LIFECYCLE_RECORD_SCHEMA,
  type LifecycleAccessReceipt,
  type LifecycleRecord,
  type LifecycleTransitionRecord,
  type ProcessedActionRecord,
} from "../lifecycle/record";
import {
  isV2LifecycleState,
  type V2LifecycleState,
} from "../lifecycle/states";
import {
  publicKeyFingerprint,
  SIGNATURE_ALGORITHM_HIERO_ECDSA,
  TRUST_POLICY_SCHEMA,
  type TrustPolicySnapshot,
} from "../trust/policy";
import {
  CorruptLifecycleRecordError,
  UnsupportedStorageVersionError,
} from "./persistence-errors";

/** Stable on-disk format identifier. Unknown identifiers are never accepted. */
export const LIFECYCLE_STORE_SCHEMA = "routeguard-v2-lifecycle-store-1.0" as const;
/** Supported storage schema version. Unknown versions fail closed. */
export const LIFECYCLE_STORE_SCHEMA_VERSION = 1 as const;
export const LIFECYCLE_STORE_INTEGRITY_ALGORITHM = "sha256" as const;

const SAFE_TENDER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const MAX_STRING = 512;
const MAX_HISTORY = 10_000;

const EVENT_TYPES = new Set<string>(LIFECYCLE_EVENT_TYPES);

/** Processed-action entry duplicated at envelope level for durable indexing. */
export type PersistedActionEntry = {
  readonly actionId: string;
  readonly tenderId: string;
  readonly tenderVersion: number;
  readonly eventType: string;
  readonly eventPayloadHash: string;
  readonly resultingState: V2LifecycleState;
  readonly recordVersionAfter: number;
  readonly at: string;
};

export type PersistedLifecycleIntegrity = {
  readonly algorithm: typeof LIFECYCLE_STORE_INTEGRITY_ALGORITHM;
  readonly recordHash: string;
  readonly actionsHash: string;
};

export type PersistedLifecycleEnvelope = {
  readonly storageSchema: typeof LIFECYCLE_STORE_SCHEMA;
  readonly storageSchemaVersion: typeof LIFECYCLE_STORE_SCHEMA_VERSION;
  readonly tenderId: string;
  readonly tenderVersion: number;
  /** Monotonic lifecycle record version (mirrors record.recordVersion). */
  readonly recordVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly record: LifecycleRecord;
  readonly trustPolicy: TrustPolicySnapshot;
  /** Idempotency index committed atomically with the lifecycle transition. */
  readonly actions: readonly PersistedActionEntry[];
  readonly integrity: PersistedLifecycleIntegrity;
};

// ---------------------------------------------------------------------------
// Allowed key sets — unknown persisted fields are rejected (strict).
// ---------------------------------------------------------------------------

const ENVELOPE_KEYS = new Set([
  "storageSchema",
  "storageSchemaVersion",
  "tenderId",
  "tenderVersion",
  "recordVersion",
  "createdAt",
  "updatedAt",
  "record",
  "trustPolicy",
  "actions",
  "integrity",
]);

const INTEGRITY_KEYS = new Set(["algorithm", "recordHash", "actionsHash"]);

const ACTION_ENTRY_KEYS = new Set([
  "actionId",
  "tenderId",
  "tenderVersion",
  "eventType",
  "eventPayloadHash",
  "resultingState",
  "recordVersionAfter",
  "at",
]);

const PROCESSED_ACTION_KEYS = new Set([
  "actionId",
  "eventType",
  "eventPayloadHash",
  "resultingState",
  "recordVersionAfter",
  "at",
]);

const TRANSITION_KEYS = new Set([
  "from",
  "to",
  "eventType",
  "actionId",
  "at",
  "reason",
]);

const TRUST_SNAPSHOT_KEYS = new Set([
  "schemaVersion",
  "shipperPublicKey",
  "shipperKeyFingerprint",
  "referees",
  "accessTreasuryAccountId",
  "signatureAlgorithm",
]);

const REFEREE_KEYS = new Set(["refereeId", "publicKey"]);

const ACCESS_RECEIPT_KEYS = new Set([
  "accessActionType",
  "asset",
  "amountAtomic",
  "resource",
  "payTo",
  "payerAccount",
  "paymentTransactionId",
  "paymentPayloadHash",
  "paidAt",
]);

const RECORD_KEYS = new Set([
  "schemaVersion",
  "tenderId",
  "tenderVersion",
  "tenderHash",
  "maximumFreightBudgetAtomic",
  "auctionEndsAt",
  "state",
  "recordVersion",
  "createdAt",
  "updatedAt",
  "lastActionId",
  "history",
  "processedActions",
  "trust",
  "fundingTxId",
  "fundedAmountAtomic",
  "activationPaymentTxId",
  "accessReceipt",
  "closureProofRef",
  "authoritativeBidSetHash",
  "decisionManifestHash",
  "winningBidId",
  "winningCarrierId",
  "winningCarrierAccount",
  "winningAmountAtomic",
  "lockedAmountAtomic",
  "excessRefundAtomic",
  "allocateTxId",
  "refundExcessTxId",
  "reservationEvidenceRef",
  "podId",
  "podContentHash",
  "reviewStartedAt",
  "reviewDeadlineAt",
  "correctionDeadlineAt",
  "shipperActionTaken",
  "advisoryReportHash",
  "disputeId",
  "lastShipperAuthPayloadHash",
  "lastShipperKeyFingerprint",
  "refereeResolution",
  "releaseAmountAtomic",
  "refundAmountAtomic",
  "resolutionPayloadHash",
  "refereeId",
  "refereeKeyFingerprint",
  "releaseTxId",
  "refundTxId",
]);

// ---------------------------------------------------------------------------
// State-dependent metadata requirements
// ---------------------------------------------------------------------------

const set = (...states: V2LifecycleState[]): ReadonlySet<V2LifecycleState> =>
  new Set(states);

const POST_FUNDING = set(
  "ESCROW_FUNDED",
  "TENDER_OPENED",
  "BIDDING",
  "AUCTION_CLOSED",
  "NO_QUALIFIED_BID",
  "WINNER_SELECTED",
  "WINNING_AMOUNT_LOCKED",
  "ROUTE_RESERVED",
  "IN_TRANSIT",
  "DELIVERY_REPORTED",
  "POD_SUBMITTED",
  "POD_UNDER_REVIEW",
  "POD_CORRECTION_REQUESTED",
  "POD_RESUBMITTED",
  "POD_ACCEPTED",
  "POD_DEEMED_ACCEPTED",
  "POD_DISPUTED",
  "REFEREE_DECISION",
  "PAYMENT_RELEASED",
  "PARTIAL_RELEASE",
  "REFUNDED",
  "TENDER_COMPLETED",
);

const POST_ACTIVATION = set(
  "TENDER_OPENED",
  "BIDDING",
  "AUCTION_CLOSED",
  "NO_QUALIFIED_BID",
  "WINNER_SELECTED",
  "WINNING_AMOUNT_LOCKED",
  "ROUTE_RESERVED",
  "IN_TRANSIT",
  "DELIVERY_REPORTED",
  "POD_SUBMITTED",
  "POD_UNDER_REVIEW",
  "POD_CORRECTION_REQUESTED",
  "POD_RESUBMITTED",
  "POD_ACCEPTED",
  "POD_DEEMED_ACCEPTED",
  "POD_DISPUTED",
  "REFEREE_DECISION",
  "PAYMENT_RELEASED",
  "PARTIAL_RELEASE",
  "REFUNDED",
  "TENDER_COMPLETED",
);

const POST_AUCTION_CLOSE = set(
  "AUCTION_CLOSED",
  "NO_QUALIFIED_BID",
  "WINNER_SELECTED",
  "WINNING_AMOUNT_LOCKED",
  "ROUTE_RESERVED",
  "IN_TRANSIT",
  "DELIVERY_REPORTED",
  "POD_SUBMITTED",
  "POD_UNDER_REVIEW",
  "POD_CORRECTION_REQUESTED",
  "POD_RESUBMITTED",
  "POD_ACCEPTED",
  "POD_DEEMED_ACCEPTED",
  "POD_DISPUTED",
  "REFEREE_DECISION",
  "PAYMENT_RELEASED",
  "PARTIAL_RELEASE",
  "REFUNDED",
  "TENDER_COMPLETED",
);

/** Award branch only (never the NO_QUALIFIED_BID branch). */
const REQUIRES_WINNER = set(
  "WINNER_SELECTED",
  "WINNING_AMOUNT_LOCKED",
  "ROUTE_RESERVED",
  "IN_TRANSIT",
  "DELIVERY_REPORTED",
  "POD_SUBMITTED",
  "POD_UNDER_REVIEW",
  "POD_CORRECTION_REQUESTED",
  "POD_RESUBMITTED",
  "POD_ACCEPTED",
  "POD_DEEMED_ACCEPTED",
  "POD_DISPUTED",
  "REFEREE_DECISION",
  "PARTIAL_RELEASE",
);

const REQUIRES_LOCK = set(
  "WINNING_AMOUNT_LOCKED",
  "ROUTE_RESERVED",
  "IN_TRANSIT",
  "DELIVERY_REPORTED",
  "POD_SUBMITTED",
  "POD_UNDER_REVIEW",
  "POD_CORRECTION_REQUESTED",
  "POD_RESUBMITTED",
  "POD_ACCEPTED",
  "POD_DEEMED_ACCEPTED",
  "POD_DISPUTED",
  "REFEREE_DECISION",
  "PARTIAL_RELEASE",
);

const REQUIRES_POD = set(
  "POD_SUBMITTED",
  "POD_UNDER_REVIEW",
  "POD_CORRECTION_REQUESTED",
  "POD_RESUBMITTED",
  "POD_ACCEPTED",
  "POD_DEEMED_ACCEPTED",
  "POD_DISPUTED",
  "REFEREE_DECISION",
  "PARTIAL_RELEASE",
);

const REQUIRES_REVIEW_WINDOW = set(
  "POD_UNDER_REVIEW",
  "POD_CORRECTION_REQUESTED",
  "POD_RESUBMITTED",
  "POD_ACCEPTED",
  "POD_DEEMED_ACCEPTED",
  "POD_DISPUTED",
);

const REQUIRES_CORRECTION_DEADLINE = set(
  "POD_CORRECTION_REQUESTED",
  "POD_RESUBMITTED",
);

const REQUIRES_DISPUTE = set(
  "POD_DISPUTED",
  "REFEREE_DECISION",
  "PARTIAL_RELEASE",
);

const REQUIRES_REFEREE_DECISION = set("REFEREE_DECISION", "PARTIAL_RELEASE");

/** States in which referee-decision metadata may legitimately be present. */
const ALLOWS_REFEREE_DECISION = set(
  "REFEREE_DECISION",
  "PAYMENT_RELEASED",
  "PARTIAL_RELEASE",
  "REFUNDED",
  "TENDER_COMPLETED",
);

/** States in which settlement amounts / transaction ids may be present. */
const ALLOWS_SETTLEMENT = set(
  "REFEREE_DECISION",
  "PAYMENT_RELEASED",
  "PARTIAL_RELEASE",
  "REFUNDED",
  "TENDER_COMPLETED",
);

const ALLOWS_SETTLEMENT_TX = set(
  "PAYMENT_RELEASED",
  "PARTIAL_RELEASE",
  "REFUNDED",
  "TENDER_COMPLETED",
);

const RESOLUTIONS = new Set(["RELEASE_FULL", "REFUND_FULL", "PARTIAL"]);

// ---------------------------------------------------------------------------
// Primitive assertions
// ---------------------------------------------------------------------------

class Ctx {
  constructor(readonly tenderId: string) {}

  fail(reason: string): never {
    throw new CorruptLifecycleRecordError(this.tenderId, reason);
  }
}

export function assertSafeTenderId(tenderId: unknown): string {
  if (
    typeof tenderId !== "string" ||
    tenderId.length === 0 ||
    tenderId.length > 128 ||
    tenderId.includes("..") ||
    !SAFE_TENDER_ID_RE.test(tenderId)
  ) {
    throw new CorruptLifecycleRecordError(
      typeof tenderId === "string" ? tenderId.slice(0, 32) : "<invalid>",
      "tenderId must be a filesystem-safe id of [a-zA-Z0-9._-]",
    );
  }
  return tenderId;
}

function plainObject(ctx: Ctx, value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    ctx.fail(`${field} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function strictKeys(
  ctx: Ctx,
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      ctx.fail(`${field} contains unknown persisted field "${key}"`);
    }
  }
}

function requireKeys(
  ctx: Ctx,
  value: Record<string, unknown>,
  required: ReadonlySet<string>,
  field: string,
): void {
  for (const key of required) {
    if (!(key in value)) {
      ctx.fail(`${field} is missing required field "${key}"`);
    }
  }
}

function str(ctx: Ctx, value: unknown, field: string, max = MAX_STRING): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    ctx.fail(`${field} must be a non-empty string of at most ${max} characters`);
  }
  return value as string;
}

function nullableStr(
  ctx: Ctx,
  value: unknown,
  field: string,
  max = MAX_STRING,
): string | null {
  if (value === null) return null;
  return str(ctx, value, field, max);
}

function safeInt(ctx: Ctx, value: unknown, field: string, min: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    !Number.isSafeInteger(value) ||
    value < min
  ) {
    ctx.fail(`${field} must be a safe integer >= ${min}`);
  }
  return value as number;
}

function hash(ctx: Ctx, value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    ctx.fail(`${field} must be sha256:<64 lowercase hex>`);
  }
  return value as string;
}

function nullableHash(ctx: Ctx, value: unknown, field: string): string | null {
  if (value === null) return null;
  return hash(ctx, value, field);
}

function utc(ctx: Ctx, value: unknown, field: string): string {
  if (typeof value !== "string" || !isUtcIsoTimestamp(value)) {
    ctx.fail(`${field} must be a valid UTC ISO-8601 timestamp`);
  }
  return value as string;
}

function nullableUtc(ctx: Ctx, value: unknown, field: string): string | null {
  if (value === null) return null;
  return utc(ctx, value, field);
}

function nonNegAtomic(ctx: Ctx, value: unknown, field: string): string {
  if (typeof value !== "string" || !isNonNegativeAtomicString(value)) {
    ctx.fail(
      `${field} must be a non-negative atomic integer string (no signs, floats, or exponents)`,
    );
  }
  return value as string;
}

function nullableNonNegAtomic(
  ctx: Ctx,
  value: unknown,
  field: string,
): string | null {
  if (value === null) return null;
  return nonNegAtomic(ctx, value, field);
}

function positiveAtomic(ctx: Ctx, value: unknown, field: string): string {
  if (typeof value !== "string" || !isPositiveAtomicString(value)) {
    ctx.fail(`${field} must be a positive atomic integer string`);
  }
  return value as string;
}

function account(ctx: Ctx, value: unknown, field: string): string {
  if (typeof value !== "string" || !isValidHederaAccountId(value)) {
    ctx.fail(`${field} must be a valid Hedera account id`);
  }
  return value as string;
}

function nullableFingerprint(
  ctx: Ctx,
  value: unknown,
  field: string,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !FINGERPRINT_RE.test(value)) {
    ctx.fail(`${field} must be 64 lowercase hex characters`);
  }
  return value as string;
}

function bool(ctx: Ctx, value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    ctx.fail(`${field} must be a boolean`);
  }
  return value as boolean;
}

function requirePresent(
  ctx: Ctx,
  value: unknown,
  field: string,
  state: V2LifecycleState,
): void {
  if (value === null || value === undefined) {
    ctx.fail(`state ${state} requires ${field}`);
  }
}

function requireAbsent(
  ctx: Ctx,
  value: unknown,
  field: string,
  state: V2LifecycleState,
): void {
  if (value !== null && value !== undefined) {
    ctx.fail(`state ${state} must not carry ${field}`);
  }
}

// ---------------------------------------------------------------------------
// Nested validators
// ---------------------------------------------------------------------------

function validateTrustSnapshot(
  ctx: Ctx,
  value: unknown,
  field: string,
): TrustPolicySnapshot {
  const t = plainObject(ctx, value, field);
  strictKeys(ctx, t, TRUST_SNAPSHOT_KEYS, field);
  requireKeys(ctx, t, TRUST_SNAPSHOT_KEYS, field);

  if (t.schemaVersion !== TRUST_POLICY_SCHEMA) {
    ctx.fail(`${field}.schemaVersion must be ${TRUST_POLICY_SCHEMA}`);
  }
  if (t.signatureAlgorithm !== SIGNATURE_ALGORITHM_HIERO_ECDSA) {
    ctx.fail(
      `${field}.signatureAlgorithm must be ${SIGNATURE_ALGORITHM_HIERO_ECDSA}`,
    );
  }
  const shipperPublicKey = str(ctx, t.shipperPublicKey, `${field}.shipperPublicKey`, 256);
  if (shipperPublicKey.length < 32 || shipperPublicKey !== shipperPublicKey.trim()) {
    ctx.fail(`${field}.shipperPublicKey is not a valid key encoding`);
  }
  const fingerprint = str(
    ctx,
    t.shipperKeyFingerprint,
    `${field}.shipperKeyFingerprint`,
    64,
  );
  if (!FINGERPRINT_RE.test(fingerprint)) {
    ctx.fail(`${field}.shipperKeyFingerprint must be 64 lowercase hex characters`);
  }
  if (fingerprint !== publicKeyFingerprint(shipperPublicKey)) {
    ctx.fail(`${field}.shipperKeyFingerprint does not match shipperPublicKey`);
  }
  account(ctx, t.accessTreasuryAccountId, `${field}.accessTreasuryAccountId`);

  if (!Array.isArray(t.referees) || t.referees.length < 1) {
    ctx.fail(`${field}.referees must be a non-empty array`);
  }
  const referees = t.referees as unknown[];
  if (referees.length > 64) {
    ctx.fail(`${field}.referees exceeds the supported registry size`);
  }
  const seen = new Set<string>();
  const parsed = referees.map((entry, i) => {
    const r = plainObject(ctx, entry, `${field}.referees[${i}]`);
    strictKeys(ctx, r, REFEREE_KEYS, `${field}.referees[${i}]`);
    requireKeys(ctx, r, REFEREE_KEYS, `${field}.referees[${i}]`);
    const refereeId = str(ctx, r.refereeId, `${field}.referees[${i}].refereeId`, 128);
    const publicKey = str(ctx, r.publicKey, `${field}.referees[${i}].publicKey`, 256);
    if (publicKey.length < 32) {
      ctx.fail(`${field}.referees[${i}].publicKey is not a valid key encoding`);
    }
    if (seen.has(refereeId)) {
      ctx.fail(`${field}.referees contains duplicate refereeId "${refereeId}"`);
    }
    seen.add(refereeId);
    return { refereeId, publicKey };
  });

  return {
    schemaVersion: TRUST_POLICY_SCHEMA,
    shipperPublicKey,
    shipperKeyFingerprint: fingerprint,
    referees: parsed,
    accessTreasuryAccountId: t.accessTreasuryAccountId as string,
    signatureAlgorithm: SIGNATURE_ALGORITHM_HIERO_ECDSA,
  };
}

function validateAccessReceipt(
  ctx: Ctx,
  value: unknown,
  record: {
    tenderId: string;
    tenderVersion: number;
    treasury: string;
    activationPaymentTxId: string | null;
  },
): LifecycleAccessReceipt {
  const r = plainObject(ctx, value, "accessReceipt");
  strictKeys(ctx, r, ACCESS_RECEIPT_KEYS, "accessReceipt");
  requireKeys(ctx, r, ACCESS_RECEIPT_KEYS, "accessReceipt");

  if (r.accessActionType !== "TENDER_ACTIVATE") {
    ctx.fail("accessReceipt.accessActionType must be TENDER_ACTIVATE");
  }
  if (r.asset !== ACCESS_FEE_TOKEN_ID) {
    ctx.fail(`accessReceipt.asset must be ${ACCESS_FEE_TOKEN_ID}`);
  }
  const expectedFee = deriveAccessFeeAtomic();
  if (r.amountAtomic !== expectedFee) {
    ctx.fail(`accessReceipt.amountAtomic must be ${expectedFee} atomic units`);
  }
  const expectedResource = tenderActivateResource(
    record.tenderId,
    record.tenderVersion,
  );
  if (r.resource !== expectedResource) {
    ctx.fail("accessReceipt.resource must be the canonical tender-versioned resource");
  }
  if (r.payTo !== record.treasury) {
    ctx.fail("accessReceipt.payTo must equal the configured access treasury account");
  }
  account(ctx, r.payerAccount, "accessReceipt.payerAccount");
  const paymentTransactionId = str(
    ctx,
    r.paymentTransactionId,
    "accessReceipt.paymentTransactionId",
    128,
  );
  if (
    record.activationPaymentTxId !== null &&
    record.activationPaymentTxId !== paymentTransactionId
  ) {
    ctx.fail("accessReceipt.paymentTransactionId must equal activationPaymentTxId");
  }
  hash(ctx, r.paymentPayloadHash, "accessReceipt.paymentPayloadHash");
  utc(ctx, r.paidAt, "accessReceipt.paidAt");

  return {
    accessActionType: "TENDER_ACTIVATE",
    asset: r.asset as string,
    amountAtomic: r.amountAtomic as string,
    resource: r.resource as string,
    payTo: r.payTo as string,
    payerAccount: r.payerAccount as string,
    paymentTransactionId,
    paymentPayloadHash: r.paymentPayloadHash as string,
    paidAt: r.paidAt as string,
  };
}

function validateTransition(
  ctx: Ctx,
  value: unknown,
  index: number,
): LifecycleTransitionRecord {
  const field = `history[${index}]`;
  const h = plainObject(ctx, value, field);
  strictKeys(ctx, h, TRANSITION_KEYS, field);

  const from = str(ctx, h.from, `${field}.from`, 64);
  const to = str(ctx, h.to, `${field}.to`, 64);
  if (!isV2LifecycleState(from) || !isV2LifecycleState(to)) {
    ctx.fail(`${field} references an unknown lifecycle state`);
  }
  const eventType = str(ctx, h.eventType, `${field}.eventType`, 64);
  if (!EVENT_TYPES.has(eventType)) {
    ctx.fail(`${field}.eventType is not a known lifecycle event type`);
  }
  const actionId = str(ctx, h.actionId, `${field}.actionId`, 128);
  const at = utc(ctx, h.at, `${field}.at`);
  const reason = h.reason === undefined ? undefined : str(ctx, h.reason, `${field}.reason`);

  return {
    from: from as V2LifecycleState,
    to: to as V2LifecycleState,
    eventType: eventType as LifecycleTransitionRecord["eventType"],
    actionId,
    at,
    ...(reason !== undefined ? { reason } : {}),
  };
}

function validateProcessedAction(
  ctx: Ctx,
  key: string,
  value: unknown,
  recordVersion: number,
): ProcessedActionRecord {
  const field = `processedActions["${key}"]`;
  const a = plainObject(ctx, value, field);
  strictKeys(ctx, a, PROCESSED_ACTION_KEYS, field);
  requireKeys(ctx, a, PROCESSED_ACTION_KEYS, field);

  const actionId = str(ctx, a.actionId, `${field}.actionId`, 128);
  if (actionId !== key) {
    ctx.fail(`${field}.actionId does not match its index key`);
  }
  const eventType = str(ctx, a.eventType, `${field}.eventType`, 64);
  if (!EVENT_TYPES.has(eventType)) {
    ctx.fail(`${field}.eventType is not a known lifecycle event type`);
  }
  hash(ctx, a.eventPayloadHash, `${field}.eventPayloadHash`);
  const resultingState = str(ctx, a.resultingState, `${field}.resultingState`, 64);
  if (!isV2LifecycleState(resultingState)) {
    ctx.fail(`${field}.resultingState is not a known lifecycle state`);
  }
  const recordVersionAfter = safeInt(
    ctx,
    a.recordVersionAfter,
    `${field}.recordVersionAfter`,
    1,
  );
  if (recordVersionAfter > recordVersion) {
    ctx.fail(`${field}.recordVersionAfter exceeds the record version`);
  }
  const at = utc(ctx, a.at, `${field}.at`);

  return {
    actionId,
    eventType: eventType as ProcessedActionRecord["eventType"],
    eventPayloadHash: a.eventPayloadHash as string,
    resultingState: resultingState as V2LifecycleState,
    recordVersionAfter,
    at,
  };
}

// ---------------------------------------------------------------------------
// Full record validation
// ---------------------------------------------------------------------------

/**
 * Validate a complete lifecycle record: structure, field formats, and
 * cross-field / state invariants. Throws CorruptLifecycleRecordError on any
 * failure. Used by both the file store and the in-memory store so lifecycle
 * semantics stay identical across adapters.
 */
export function assertValidLifecycleRecord(
  value: unknown,
  expectedTenderId: string,
): LifecycleRecord {
  const safeId = assertSafeTenderId(expectedTenderId);
  const ctx = new Ctx(safeId);

  const r = plainObject(ctx, value, "record");
  strictKeys(ctx, r, RECORD_KEYS, "record");
  requireKeys(ctx, r, RECORD_KEYS, "record");

  if (r.schemaVersion !== LIFECYCLE_RECORD_SCHEMA) {
    throw new UnsupportedStorageVersionError(
      safeId,
      `record schemaVersion must be ${LIFECYCLE_RECORD_SCHEMA}`,
    );
  }

  const tenderId = assertSafeTenderId(r.tenderId);
  if (tenderId !== safeId) {
    ctx.fail("record tenderId does not match the requested tender");
  }
  const tenderVersion = safeInt(ctx, r.tenderVersion, "tenderVersion", 1);
  hash(ctx, r.tenderHash, "tenderHash");
  const budget = positiveAtomic(
    ctx,
    r.maximumFreightBudgetAtomic,
    "maximumFreightBudgetAtomic",
  );
  utc(ctx, r.auctionEndsAt, "auctionEndsAt");

  const stateRaw = str(ctx, r.state, "state", 64);
  if (!isV2LifecycleState(stateRaw)) {
    ctx.fail(`unknown lifecycle state "${stateRaw}"`);
  }
  const state = stateRaw as V2LifecycleState;

  const recordVersion = safeInt(ctx, r.recordVersion, "recordVersion", 1);
  const createdAt = utc(ctx, r.createdAt, "createdAt");
  const updatedAt = utc(ctx, r.updatedAt, "updatedAt");
  if (compareUtc(createdAt, updatedAt) > 0) {
    ctx.fail("createdAt must be <= updatedAt");
  }
  nullableStr(ctx, r.lastActionId, "lastActionId", 128);

  // History
  if (!Array.isArray(r.history)) {
    ctx.fail("history must be an array");
  }
  const historyRaw = r.history as unknown[];
  if (historyRaw.length > MAX_HISTORY) {
    ctx.fail("history exceeds the supported length");
  }
  const history = historyRaw.map((h, i) => validateTransition(ctx, h, i));

  // Processed actions
  const processedRaw = plainObject(ctx, r.processedActions, "processedActions");
  const processedActions: Record<string, ProcessedActionRecord> = {};
  for (const key of Object.keys(processedRaw)) {
    processedActions[key] = validateProcessedAction(
      ctx,
      key,
      processedRaw[key],
      recordVersion,
    );
  }

  // One committed transition ⇔ one processed action ⇔ exactly one version bump.
  const actionCount = Object.keys(processedActions).length;
  if (history.length !== actionCount) {
    ctx.fail(
      "history length must equal the processed-action count (action-id state and lifecycle state must be committed together)",
    );
  }
  if (recordVersion !== history.length + 1) {
    ctx.fail("recordVersion must equal the committed transition count + 1");
  }
  if (history.length === 0) {
    if (state !== "DRAFT") {
      ctx.fail("a record without history must be in DRAFT");
    }
    if (r.lastActionId !== null) {
      ctx.fail("a record without history must not carry lastActionId");
    }
  } else {
    const last = history[history.length - 1]!;
    if (last.to !== state) {
      ctx.fail("the final history entry does not match the persisted state");
    }
    if (last.at !== updatedAt) {
      ctx.fail("the final history entry timestamp does not match updatedAt");
    }
    if (r.lastActionId !== last.actionId) {
      ctx.fail("lastActionId does not match the final history entry");
    }
    for (const entry of history) {
      const processed = processedActions[entry.actionId];
      if (!processed) {
        ctx.fail(
          `history entry "${entry.actionId}" has no processed-action record (non-atomic idempotency state)`,
        );
      }
      if (processed!.eventType !== entry.eventType) {
        ctx.fail(`processed action "${entry.actionId}" event type does not match history`);
      }
      if (processed!.resultingState !== entry.to) {
        ctx.fail(`processed action "${entry.actionId}" resulting state does not match history`);
      }
    }
  }

  const trust = validateTrustSnapshot(ctx, r.trust, "trust");

  // Funding / access
  const fundingTxId = nullableStr(ctx, r.fundingTxId, "fundingTxId", 128);
  const fundedAmountAtomic = nullableNonNegAtomic(
    ctx,
    r.fundedAmountAtomic,
    "fundedAmountAtomic",
  );
  const activationPaymentTxId = nullableStr(
    ctx,
    r.activationPaymentTxId,
    "activationPaymentTxId",
    128,
  );
  const accessReceipt =
    r.accessReceipt === null
      ? null
      : validateAccessReceipt(ctx, r.accessReceipt, {
          tenderId,
          tenderVersion,
          treasury: trust.accessTreasuryAccountId,
          activationPaymentTxId,
        });

  // Auction / award
  const closureProofRef = nullableStr(ctx, r.closureProofRef, "closureProofRef", 256);
  nullableHash(ctx, r.authoritativeBidSetHash, "authoritativeBidSetHash");
  nullableHash(ctx, r.decisionManifestHash, "decisionManifestHash");
  const winningBidId = nullableStr(ctx, r.winningBidId, "winningBidId", 128);
  const winningCarrierId = nullableStr(ctx, r.winningCarrierId, "winningCarrierId", 128);
  const winningCarrierAccount =
    r.winningCarrierAccount === null
      ? null
      : account(ctx, r.winningCarrierAccount, "winningCarrierAccount");
  const winningAmountAtomic = nullableNonNegAtomic(
    ctx,
    r.winningAmountAtomic,
    "winningAmountAtomic",
  );
  const lockedAmountAtomic = nullableNonNegAtomic(
    ctx,
    r.lockedAmountAtomic,
    "lockedAmountAtomic",
  );
  const excessRefundAtomic = nullableNonNegAtomic(
    ctx,
    r.excessRefundAtomic,
    "excessRefundAtomic",
  );
  const allocateTxId = nullableStr(ctx, r.allocateTxId, "allocateTxId", 128);
  nullableStr(ctx, r.refundExcessTxId, "refundExcessTxId", 128);
  nullableStr(ctx, r.reservationEvidenceRef, "reservationEvidenceRef", 256);

  // POD / review
  const podId = nullableStr(ctx, r.podId, "podId", 128);
  const podContentHash = nullableHash(ctx, r.podContentHash, "podContentHash");
  const reviewStartedAt = nullableUtc(ctx, r.reviewStartedAt, "reviewStartedAt");
  const reviewDeadlineAt = nullableUtc(ctx, r.reviewDeadlineAt, "reviewDeadlineAt");
  const correctionDeadlineAt = nullableUtc(
    ctx,
    r.correctionDeadlineAt,
    "correctionDeadlineAt",
  );
  bool(ctx, r.shipperActionTaken, "shipperActionTaken");
  nullableHash(ctx, r.advisoryReportHash, "advisoryReportHash");
  const disputeId = nullableStr(ctx, r.disputeId, "disputeId", 128);
  nullableHash(ctx, r.lastShipperAuthPayloadHash, "lastShipperAuthPayloadHash");
  nullableFingerprint(ctx, r.lastShipperKeyFingerprint, "lastShipperKeyFingerprint");

  // Settlement
  const refereeResolution = nullableStr(ctx, r.refereeResolution, "refereeResolution", 32);
  if (refereeResolution !== null && !RESOLUTIONS.has(refereeResolution)) {
    ctx.fail("refereeResolution must be RELEASE_FULL, REFUND_FULL, or PARTIAL");
  }
  const releaseAmountAtomic = nullableNonNegAtomic(
    ctx,
    r.releaseAmountAtomic,
    "releaseAmountAtomic",
  );
  const refundAmountAtomic = nullableNonNegAtomic(
    ctx,
    r.refundAmountAtomic,
    "refundAmountAtomic",
  );
  const resolutionPayloadHash = nullableHash(
    ctx,
    r.resolutionPayloadHash,
    "resolutionPayloadHash",
  );
  const refereeId = nullableStr(ctx, r.refereeId, "refereeId", 128);
  const refereeKeyFingerprint = nullableFingerprint(
    ctx,
    r.refereeKeyFingerprint,
    "refereeKeyFingerprint",
  );
  const releaseTxId = nullableStr(ctx, r.releaseTxId, "releaseTxId", 128);
  const refundTxId = nullableStr(ctx, r.refundTxId, "refundTxId", 128);

  // -- cross-field state invariants ----------------------------------------

  if (POST_FUNDING.has(state)) {
    requirePresent(ctx, fundingTxId, "fundingTxId", state);
    requirePresent(ctx, fundedAmountAtomic, "fundedAmountAtomic", state);
    if (BigInt(fundedAmountAtomic!) < BigInt(budget)) {
      ctx.fail("fundedAmountAtomic must be >= maximumFreightBudgetAtomic");
    }
  } else {
    requireAbsent(ctx, fundingTxId, "fundingTxId", state);
    requireAbsent(ctx, fundedAmountAtomic, "fundedAmountAtomic", state);
  }

  if (POST_ACTIVATION.has(state)) {
    requirePresent(ctx, activationPaymentTxId, "activationPaymentTxId", state);
    requirePresent(ctx, accessReceipt, "accessReceipt", state);
  } else {
    requireAbsent(ctx, activationPaymentTxId, "activationPaymentTxId", state);
    requireAbsent(ctx, accessReceipt, "accessReceipt", state);
  }

  if (POST_AUCTION_CLOSE.has(state)) {
    requirePresent(ctx, closureProofRef, "closureProofRef", state);
    requirePresent(ctx, r.authoritativeBidSetHash, "authoritativeBidSetHash", state);
  }

  if (REQUIRES_WINNER.has(state)) {
    requirePresent(ctx, winningBidId, "winningBidId", state);
    requirePresent(ctx, winningCarrierId, "winningCarrierId", state);
    requirePresent(ctx, winningCarrierAccount, "winningCarrierAccount", state);
    requirePresent(ctx, winningAmountAtomic, "winningAmountAtomic", state);
    requirePresent(ctx, r.decisionManifestHash, "decisionManifestHash", state);
  }
  if (winningAmountAtomic !== null) {
    if (BigInt(winningAmountAtomic) > BigInt(budget)) {
      ctx.fail("winningAmountAtomic exceeds maximumFreightBudgetAtomic");
    }
  }

  if (REQUIRES_LOCK.has(state)) {
    requirePresent(ctx, lockedAmountAtomic, "lockedAmountAtomic", state);
    requirePresent(ctx, excessRefundAtomic, "excessRefundAtomic", state);
    requirePresent(ctx, allocateTxId, "allocateTxId", state);
  } else if (!ALLOWS_SETTLEMENT_TX.has(state)) {
    requireAbsent(ctx, lockedAmountAtomic, "lockedAmountAtomic", state);
  }
  if (lockedAmountAtomic !== null) {
    if (BigInt(lockedAmountAtomic) > BigInt(budget)) {
      ctx.fail("lockedAmountAtomic exceeds maximumFreightBudgetAtomic");
    }
    if (winningAmountAtomic !== null && lockedAmountAtomic !== winningAmountAtomic) {
      ctx.fail("lockedAmountAtomic must equal winningAmountAtomic");
    }
    if (
      excessRefundAtomic !== null &&
      BigInt(lockedAmountAtomic) + BigInt(excessRefundAtomic) !== BigInt(budget)
    ) {
      ctx.fail(
        "lockedAmountAtomic + excessRefundAtomic must equal maximumFreightBudgetAtomic",
      );
    }
  }

  if (REQUIRES_POD.has(state)) {
    requirePresent(ctx, podId, "podId", state);
    requirePresent(ctx, podContentHash, "podContentHash", state);
  }
  if (REQUIRES_REVIEW_WINDOW.has(state)) {
    requirePresent(ctx, reviewStartedAt, "reviewStartedAt", state);
    requirePresent(ctx, reviewDeadlineAt, "reviewDeadlineAt", state);
    if (compareUtc(reviewStartedAt!, reviewDeadlineAt!) >= 0) {
      ctx.fail("reviewDeadlineAt must be after reviewStartedAt");
    }
  }
  if (REQUIRES_CORRECTION_DEADLINE.has(state)) {
    requirePresent(ctx, correctionDeadlineAt, "correctionDeadlineAt", state);
  }
  if (REQUIRES_DISPUTE.has(state)) {
    requirePresent(ctx, disputeId, "disputeId", state);
  }

  if (!ALLOWS_REFEREE_DECISION.has(state)) {
    requireAbsent(ctx, refereeResolution, "refereeResolution", state);
    requireAbsent(ctx, resolutionPayloadHash, "resolutionPayloadHash", state);
    requireAbsent(ctx, refereeId, "refereeId", state);
    requireAbsent(ctx, refereeKeyFingerprint, "refereeKeyFingerprint", state);
  }
  if (!ALLOWS_SETTLEMENT.has(state)) {
    requireAbsent(ctx, releaseAmountAtomic, "releaseAmountAtomic", state);
    requireAbsent(ctx, refundAmountAtomic, "refundAmountAtomic", state);
  }
  if (!ALLOWS_SETTLEMENT_TX.has(state)) {
    requireAbsent(ctx, releaseTxId, "releaseTxId", state);
    requireAbsent(ctx, refundTxId, "refundTxId", state);
  }

  if (REQUIRES_REFEREE_DECISION.has(state)) {
    requirePresent(ctx, refereeResolution, "refereeResolution", state);
    requirePresent(ctx, resolutionPayloadHash, "resolutionPayloadHash", state);
    requirePresent(ctx, refereeId, "refereeId", state);
    requirePresent(ctx, refereeKeyFingerprint, "refereeKeyFingerprint", state);
  }
  if (refereeResolution !== null) {
    requirePresent(ctx, releaseAmountAtomic, "releaseAmountAtomic", state);
    requirePresent(ctx, refundAmountAtomic, "refundAmountAtomic", state);
    requirePresent(ctx, lockedAmountAtomic, "lockedAmountAtomic", state);
    const rel = BigInt(releaseAmountAtomic!);
    const ref = BigInt(refundAmountAtomic!);
    if (rel + ref !== BigInt(lockedAmountAtomic!)) {
      ctx.fail(
        "recorded referee decision does not conserve the locked amount (release + refund must equal lockedAmountAtomic)",
      );
    }
    if (refereeResolution === "RELEASE_FULL" && ref !== 0n) {
      ctx.fail("RELEASE_FULL requires a zero refund amount");
    }
    if (refereeResolution === "REFUND_FULL" && rel !== 0n) {
      ctx.fail("REFUND_FULL requires a zero release amount");
    }
    if (refereeResolution === "PARTIAL" && rel === 0n && ref === 0n) {
      ctx.fail("PARTIAL requires a positive split");
    }
    requirePresent(ctx, disputeId, "disputeId", state);
    if (refereeId !== null && !trust.referees.some((x) => x.refereeId === refereeId)) {
      ctx.fail("refereeId is not present in the persisted trusted referee registry");
    }
  }

  if (state === "PAYMENT_RELEASED" || state === "PARTIAL_RELEASE") {
    requirePresent(ctx, releaseTxId, "releaseTxId", state);
    requirePresent(ctx, releaseAmountAtomic, "releaseAmountAtomic", state);
    requirePresent(ctx, lockedAmountAtomic, "lockedAmountAtomic", state);
  }
  if (state === "PAYMENT_RELEASED") {
    if (releaseAmountAtomic !== lockedAmountAtomic) {
      ctx.fail("PAYMENT_RELEASED requires releaseAmountAtomic to equal lockedAmountAtomic");
    }
    if (refundAmountAtomic !== "0") {
      ctx.fail("PAYMENT_RELEASED requires a zero refund amount");
    }
    if (refereeResolution !== null && refereeResolution !== "RELEASE_FULL") {
      ctx.fail("PAYMENT_RELEASED is inconsistent with the recorded referee decision");
    }
  }
  if (state === "PARTIAL_RELEASE") {
    requirePresent(ctx, refundTxId, "refundTxId", state);
    if (refereeResolution !== "PARTIAL") {
      ctx.fail("PARTIAL_RELEASE requires a PARTIAL referee decision");
    }
    if (
      BigInt(releaseAmountAtomic!) + BigInt(refundAmountAtomic!) !==
      BigInt(lockedAmountAtomic!)
    ) {
      ctx.fail("PARTIAL_RELEASE amounts do not conserve the locked amount");
    }
  }
  if (state === "REFUNDED") {
    requirePresent(ctx, refundTxId, "refundTxId", state);
    requirePresent(ctx, refundAmountAtomic, "refundAmountAtomic", state);
    if (refereeResolution === null) {
      // NO_QUALIFIED_BID branch: nothing was ever locked.
      if (lockedAmountAtomic !== null) {
        ctx.fail("REFUNDED without a referee decision must not carry a locked amount");
      }
      if (refundAmountAtomic !== budget) {
        ctx.fail(
          "REFUNDED without a referee decision must refund the full maximum freight budget",
        );
      }
    } else {
      if (refereeResolution !== "REFUND_FULL") {
        ctx.fail("REFUNDED is inconsistent with the recorded referee decision");
      }
      if (refundAmountAtomic !== lockedAmountAtomic) {
        ctx.fail("REFUNDED requires refundAmountAtomic to equal lockedAmountAtomic");
      }
      if (releaseAmountAtomic !== "0") {
        ctx.fail("REFUNDED requires a zero release amount");
      }
    }
  }
  if (state === "TENDER_COMPLETED" && releaseTxId === null && refundTxId === null) {
    ctx.fail("TENDER_COMPLETED requires a settlement transaction reference");
  }

  return value as LifecycleRecord;
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

function actionEntriesFromRecord(record: LifecycleRecord): PersistedActionEntry[] {
  return Object.keys(record.processedActions)
    .sort()
    .map((actionId) => {
      const a = record.processedActions[actionId]!;
      return {
        actionId: a.actionId,
        tenderId: record.tenderId,
        tenderVersion: record.tenderVersion,
        eventType: a.eventType,
        eventPayloadHash: a.eventPayloadHash,
        resultingState: a.resultingState,
        recordVersionAfter: a.recordVersionAfter,
        at: a.at,
      };
    });
}

/** Build the authoritative envelope for a validated lifecycle record. */
export function buildPersistedLifecycleEnvelope(
  record: LifecycleRecord,
): PersistedLifecycleEnvelope {
  const actions = actionEntriesFromRecord(record);
  return {
    storageSchema: LIFECYCLE_STORE_SCHEMA,
    storageSchemaVersion: LIFECYCLE_STORE_SCHEMA_VERSION,
    tenderId: record.tenderId,
    tenderVersion: record.tenderVersion,
    recordVersion: record.recordVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    record,
    trustPolicy: record.trust,
    actions,
    integrity: {
      algorithm: LIFECYCLE_STORE_INTEGRITY_ALGORITHM,
      recordHash: canonicalSha256(record),
      actionsHash: canonicalSha256(actions),
    },
  };
}

export function serializePersistedLifecycleEnvelope(
  envelope: PersistedLifecycleEnvelope,
): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

/**
 * Validate a complete persisted envelope, including every nested lifecycle,
 * trust-policy, access-receipt, settlement, and idempotency record.
 */
export function assertValidPersistedLifecycleEnvelope(
  value: unknown,
  expectedTenderId: string,
): PersistedLifecycleEnvelope {
  const safeId = assertSafeTenderId(expectedTenderId);
  const ctx = new Ctx(safeId);

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    ctx.fail("persisted envelope must be a plain object");
  }
  const e = value as Record<string, unknown>;

  // Schema gate first so an unknown format never reaches record validation.
  if (e.storageSchema !== LIFECYCLE_STORE_SCHEMA) {
    throw new UnsupportedStorageVersionError(
      safeId,
      `storageSchema must be "${LIFECYCLE_STORE_SCHEMA}"`,
    );
  }
  if (e.storageSchemaVersion !== LIFECYCLE_STORE_SCHEMA_VERSION) {
    throw new UnsupportedStorageVersionError(
      safeId,
      `storageSchemaVersion must be ${LIFECYCLE_STORE_SCHEMA_VERSION}`,
    );
  }

  strictKeys(ctx, e, ENVELOPE_KEYS, "envelope");
  requireKeys(ctx, e, ENVELOPE_KEYS, "envelope");

  const record = assertValidLifecycleRecord(e.record, safeId);

  const tenderId = assertSafeTenderId(e.tenderId);
  if (tenderId !== record.tenderId) {
    ctx.fail("envelope tenderId does not match the lifecycle record");
  }
  const tenderVersion = safeInt(ctx, e.tenderVersion, "envelope.tenderVersion", 1);
  if (tenderVersion !== record.tenderVersion) {
    ctx.fail("envelope tenderVersion does not match the lifecycle record");
  }
  const recordVersion = safeInt(ctx, e.recordVersion, "envelope.recordVersion", 1);
  if (recordVersion !== record.recordVersion) {
    ctx.fail("envelope recordVersion does not match the lifecycle record");
  }
  const createdAt = utc(ctx, e.createdAt, "envelope.createdAt");
  const updatedAt = utc(ctx, e.updatedAt, "envelope.updatedAt");
  if (compareUtc(createdAt, updatedAt) > 0) {
    ctx.fail("envelope createdAt must be <= updatedAt");
  }
  if (createdAt !== record.createdAt || updatedAt !== record.updatedAt) {
    ctx.fail("envelope timestamps do not match the lifecycle record");
  }

  const trustPolicy = validateTrustSnapshot(ctx, e.trustPolicy, "envelope.trustPolicy");
  if (canonicalSha256(trustPolicy) !== canonicalSha256(record.trust)) {
    ctx.fail("envelope trust-policy snapshot does not match the record trust binding");
  }

  // Idempotency index
  if (!Array.isArray(e.actions)) {
    ctx.fail("envelope.actions must be an array");
  }
  const rawActions = e.actions as unknown[];
  const seenActionIds = new Set<string>();
  const actions: PersistedActionEntry[] = rawActions.map((entry, i) => {
    const field = `envelope.actions[${i}]`;
    const a = plainObject(ctx, entry, field);
    strictKeys(ctx, a, ACTION_ENTRY_KEYS, field);
    requireKeys(ctx, a, ACTION_ENTRY_KEYS, field);

    const actionId = str(ctx, a.actionId, `${field}.actionId`, 128);
    if (seenActionIds.has(actionId)) {
      ctx.fail(`envelope.actions contains duplicate actionId "${actionId}"`);
    }
    seenActionIds.add(actionId);
    if (a.tenderId !== record.tenderId || a.tenderVersion !== record.tenderVersion) {
      ctx.fail(
        `envelope.actions entry "${actionId}" belongs to a different tender or tender version`,
      );
    }
    const persisted = record.processedActions[actionId];
    if (!persisted) {
      ctx.fail(
        `envelope.actions entry "${actionId}" has no matching processed-action record`,
      );
    }
    if (
      a.eventType !== persisted!.eventType ||
      a.eventPayloadHash !== persisted!.eventPayloadHash ||
      a.resultingState !== persisted!.resultingState ||
      a.recordVersionAfter !== persisted!.recordVersionAfter ||
      a.at !== persisted!.at
    ) {
      ctx.fail(
        `envelope.actions entry "${actionId}" does not match its processed-action record`,
      );
    }
    return {
      actionId,
      tenderId: record.tenderId,
      tenderVersion: record.tenderVersion,
      eventType: persisted!.eventType,
      eventPayloadHash: persisted!.eventPayloadHash,
      resultingState: persisted!.resultingState,
      recordVersionAfter: persisted!.recordVersionAfter,
      at: persisted!.at,
    };
  });
  if (actions.length !== Object.keys(record.processedActions).length) {
    ctx.fail("envelope.actions does not cover every processed action");
  }

  // Integrity
  const integrity = plainObject(ctx, e.integrity, "envelope.integrity");
  strictKeys(ctx, integrity, INTEGRITY_KEYS, "envelope.integrity");
  requireKeys(ctx, integrity, INTEGRITY_KEYS, "envelope.integrity");
  if (integrity.algorithm !== LIFECYCLE_STORE_INTEGRITY_ALGORITHM) {
    ctx.fail(
      `envelope.integrity.algorithm must be ${LIFECYCLE_STORE_INTEGRITY_ALGORITHM}`,
    );
  }
  hash(ctx, integrity.recordHash, "envelope.integrity.recordHash");
  hash(ctx, integrity.actionsHash, "envelope.integrity.actionsHash");
  if (integrity.recordHash !== canonicalSha256(record)) {
    ctx.fail("envelope.integrity.recordHash does not recompute over the record");
  }
  if (integrity.actionsHash !== canonicalSha256(actionEntriesFromRecord(record))) {
    ctx.fail("envelope.integrity.actionsHash does not recompute over the action index");
  }

  return {
    storageSchema: LIFECYCLE_STORE_SCHEMA,
    storageSchemaVersion: LIFECYCLE_STORE_SCHEMA_VERSION,
    tenderId,
    tenderVersion,
    recordVersion,
    createdAt,
    updatedAt,
    record,
    trustPolicy,
    actions,
    integrity: {
      algorithm: LIFECYCLE_STORE_INTEGRITY_ALGORITHM,
      recordHash: integrity.recordHash as string,
      actionsHash: integrity.actionsHash as string,
    },
  };
}

/**
 * Decode + parse + fully validate persisted bytes.
 * Invalid UTF-8, invalid/truncated JSON, and structural corruption all fail
 * closed with a typed error; nothing is partially recovered.
 */
export function parsePersistedLifecycleEnvelope(
  bytes: Buffer | string,
  expectedTenderId: string,
): PersistedLifecycleEnvelope {
  const safeId = assertSafeTenderId(expectedTenderId);
  let text: string;
  if (typeof bytes === "string") {
    text = bytes;
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        bytes,
      );
    } catch (err) {
      throw new CorruptLifecycleRecordError(
        safeId,
        "persisted state is not valid UTF-8",
        { cause: err },
      );
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new CorruptLifecycleRecordError(
      safeId,
      "persisted state is not valid JSON",
      { cause: err },
    );
  }
  return assertValidPersistedLifecycleEnvelope(parsed, safeId);
}
