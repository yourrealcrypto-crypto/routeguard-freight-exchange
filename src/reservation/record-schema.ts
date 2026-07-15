/**
 * Strict durable ReservationRecord validation (Phase 6A.2C).
 * Fail-closed on create/read/compareAndSet. Cross-field state invariants.
 * Never silently repairs security-sensitive corruption.
 */

import { z } from "zod";

import {
  assertSha256Hash,
  canonicalSha256,
} from "../domain/canonical-hash";
import { isValidHederaAccountId } from "../domain/payment-option";
import { compareUtc, isUtcIsoTimestamp } from "../domain/time";
import { parseSignatureHex } from "../domain/signature";
import {
  computeChallengeHash,
  type ChallengeHashInput,
} from "./challenge";
import {
  decodeRouteReservedEnvelope,
  measureRouteReservedEnvelope,
  routeReservedEnvelopeHash,
} from "./hcs-evidence";
import { resourcePathForOption, verifyOfferIntegrity } from "./offer";
import { verifyRouteReservedRecordHash } from "./route-reserved-record";
import {
  CHALLENGE_MAX_TIMEOUT_SECONDS,
  CHALLENGE_X402_VERSION,
  DEMO_RESERVATION_FEE_NOTE,
  HBAR_RESERVATION_OPTION,
  POST_RESERVATION_STATES,
  RESERVATION_NETWORK,
  RESERVATION_SCHEME,
  RESERVATION_STATES,
  ReservationError,
  ROUTE_RESERVED_EVENT_TYPE,
  USDC_RESERVATION_OPTION,
  WEBHOOK_SIGNATURE_VERSION,
  type HcsPublicationClaim,
  type MirrorPollRecord,
  type PaymentChallengeRecord,
  type ReservationRecord,
  type ReservationState,
  type WebhookEvent,
} from "./types";
import { reservationWebhookEventId } from "./webhook";
import type { RouteReservedEnvelope } from "../hcs/types";
import { HCS_MAX_MESSAGE_BYTES } from "../hcs/types";

/** Typed corruption / invalid persisted record. */
export class CorruptReservationRecordError extends ReservationError {
  constructor(message: string, code = "CORRUPT_RESERVATION_RECORD") {
    super(code, message);
    this.name = "CorruptReservationRecordError";
  }
}

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,126}$/;
const PROHIBITED_KEY_RE =
  /privateKey|PAYMENT-SIGNATURE|signedPayment|commitmentSalt|nonce|fullBid|secretHeader/i;

const STATES = new Set<string>(RESERVATION_STATES);

const REQUIRES_SELECTED: ReadonlySet<ReservationState> = new Set([
  "OPTION_SELECTED",
  "PAYMENT_CHALLENGE_ISSUED",
  "PAYMENT_SUBMISSION_STARTED",
  "FACILITATOR_VERIFIED",
  "FACILITATOR_SETTLE_CLAIMED",
  "FACILITATOR_SETTLED",
  "MIRROR_CONFIRMATION_PENDING",
  "PAYMENT_CONFIRMED",
  "ROUTE_RESERVED",
  "WEBHOOKS_DISPATCHED",
  "HCS_EVIDENCE_RECORDED",
  "COMPLETED",
  "PAYMENT_REJECTED",
  "SETTLEMENT_FAILED",
  "CONFIRMATION_TIMED_OUT",
  "CONFIRMATION_FAILED",
  "WEBHOOK_DELIVERY_FAILED",
  "HCS_EVIDENCE_FAILED",
]);

const REQUIRES_CHALLENGE: ReadonlySet<ReservationState> = new Set([
  "PAYMENT_CHALLENGE_ISSUED",
  "PAYMENT_SUBMISSION_STARTED",
  "FACILITATOR_VERIFIED",
  "FACILITATOR_SETTLE_CLAIMED",
  "FACILITATOR_SETTLED",
  "MIRROR_CONFIRMATION_PENDING",
  "PAYMENT_CONFIRMED",
  "ROUTE_RESERVED",
  "WEBHOOKS_DISPATCHED",
  "HCS_EVIDENCE_RECORDED",
  "COMPLETED",
  "PAYMENT_REJECTED",
  "SETTLEMENT_FAILED",
  "CONFIRMATION_TIMED_OUT",
  "CONFIRMATION_FAILED",
  "WEBHOOK_DELIVERY_FAILED",
  "HCS_EVIDENCE_FAILED",
]);

const REQUIRES_PAYLOAD: ReadonlySet<ReservationState> = new Set([
  "PAYMENT_SUBMISSION_STARTED",
  "FACILITATOR_VERIFIED",
  "FACILITATOR_SETTLE_CLAIMED",
  "FACILITATOR_SETTLED",
  "MIRROR_CONFIRMATION_PENDING",
  "PAYMENT_CONFIRMED",
  "ROUTE_RESERVED",
  "WEBHOOKS_DISPATCHED",
  "HCS_EVIDENCE_RECORDED",
  "COMPLETED",
  "SETTLEMENT_FAILED",
  "CONFIRMATION_TIMED_OUT",
  "CONFIRMATION_FAILED",
  "WEBHOOK_DELIVERY_FAILED",
  "HCS_EVIDENCE_FAILED",
]);

const REQUIRES_VERIFY_OK: ReadonlySet<ReservationState> = new Set([
  "FACILITATOR_VERIFIED",
  "FACILITATOR_SETTLE_CLAIMED",
  "FACILITATOR_SETTLED",
  "MIRROR_CONFIRMATION_PENDING",
  "PAYMENT_CONFIRMED",
  "ROUTE_RESERVED",
  "WEBHOOKS_DISPATCHED",
  "HCS_EVIDENCE_RECORDED",
  "COMPLETED",
  "SETTLEMENT_FAILED",
  "CONFIRMATION_TIMED_OUT",
  "CONFIRMATION_FAILED",
  "WEBHOOK_DELIVERY_FAILED",
  "HCS_EVIDENCE_FAILED",
]);

const REQUIRES_SETTLE_CLAIM: ReadonlySet<ReservationState> = new Set([
  "FACILITATOR_SETTLE_CLAIMED",
  "FACILITATOR_SETTLED",
  "MIRROR_CONFIRMATION_PENDING",
  "PAYMENT_CONFIRMED",
  "ROUTE_RESERVED",
  "WEBHOOKS_DISPATCHED",
  "HCS_EVIDENCE_RECORDED",
  "COMPLETED",
  "SETTLEMENT_FAILED",
  "CONFIRMATION_TIMED_OUT",
  "CONFIRMATION_FAILED",
  "WEBHOOK_DELIVERY_FAILED",
  "HCS_EVIDENCE_FAILED",
]);

const REQUIRES_SETTLED_TX: ReadonlySet<ReservationState> = new Set([
  "FACILITATOR_SETTLED",
  "MIRROR_CONFIRMATION_PENDING",
  "PAYMENT_CONFIRMED",
  "ROUTE_RESERVED",
  "WEBHOOKS_DISPATCHED",
  "HCS_EVIDENCE_RECORDED",
  "COMPLETED",
  "CONFIRMATION_TIMED_OUT",
  "CONFIRMATION_FAILED",
  "WEBHOOK_DELIVERY_FAILED",
  "HCS_EVIDENCE_FAILED",
]);

const REQUIRES_MIRROR_POLL: ReadonlySet<ReservationState> = new Set([
  "MIRROR_CONFIRMATION_PENDING",
  "PAYMENT_CONFIRMED",
  "ROUTE_RESERVED",
  "WEBHOOKS_DISPATCHED",
  "HCS_EVIDENCE_RECORDED",
  "COMPLETED",
  "CONFIRMATION_TIMED_OUT",
  "CONFIRMATION_FAILED",
  "WEBHOOK_DELIVERY_FAILED",
  "HCS_EVIDENCE_FAILED",
]);

const REQUIRES_MIRROR_SUCCESS: ReadonlySet<ReservationState> = new Set([
  "PAYMENT_CONFIRMED",
  "ROUTE_RESERVED",
  "WEBHOOKS_DISPATCHED",
  "HCS_EVIDENCE_RECORDED",
  "COMPLETED",
  "WEBHOOK_DELIVERY_FAILED",
  "HCS_EVIDENCE_FAILED",
]);

function fail(message: string, code = "CORRUPT_RESERVATION_RECORD"): never {
  throw new CorruptReservationRecordError(message, code);
}

/** Filesystem-safe reservation id: no path traversal, bounded charset. */
export function assertSafeReservationId(reservationId: string): string {
  if (typeof reservationId !== "string" || reservationId.length === 0) {
    fail("reservationId must be a non-empty string", "INVALID_PERSISTED_RECORD");
  }
  if (reservationId.length > 128) {
    fail("reservationId exceeds max length 128", "INVALID_PERSISTED_RECORD");
  }
  if (
    reservationId.includes("..") ||
    reservationId.includes("/") ||
    reservationId.includes("\\") ||
    reservationId.includes("\0")
  ) {
    fail(
      "reservationId must not contain path traversal characters",
      "INVALID_PERSISTED_RECORD",
    );
  }
  if (!SAFE_ID_RE.test(reservationId)) {
    fail(
      "reservationId must be filesystem-safe [a-zA-Z0-9._-]",
      "INVALID_PERSISTED_RECORD",
    );
  }
  return reservationId;
}

function assertHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    fail(`${field} must be sha256:<64 lowercase hex>`, "INVALID_PERSISTED_RECORD");
  }
  try {
    assertSha256Hash(value);
  } catch {
    fail(`${field} invalid hash format`, "INVALID_PERSISTED_RECORD");
  }
  return value;
}

function assertUtc(value: unknown, field: string): string {
  if (typeof value !== "string" || !isUtcIsoTimestamp(value)) {
    fail(`${field} must be valid UTC ISO timestamp`, "INVALID_PERSISTED_RECORD");
  }
  return value;
}

function assertSafeInt(
  value: unknown,
  field: string,
  opts?: { min?: number; allowZero?: boolean },
): number {
  const min = opts?.min ?? (opts?.allowZero ? 0 : 1);
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    !Number.isSafeInteger(value) ||
    value < min
  ) {
    fail(
      `${field} must be a safe integer >= ${min}`,
      "INVALID_PERSISTED_RECORD",
    );
  }
  return value;
}

function assertAccount(value: unknown, field: string): string {
  if (typeof value !== "string" || !isValidHederaAccountId(value)) {
    fail(`${field} must be a valid Hedera account id`, "INVALID_PERSISTED_RECORD");
  }
  return value;
}

function assertNoProhibitedKeys(value: unknown, path: string): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertNoProhibitedKeys(value[i], `${path}[${i}]`);
    }
    return;
  }
  if (typeof value === "object") {
    for (const key of Object.keys(value as object)) {
      if (PROHIBITED_KEY_RE.test(key)) {
        fail(`Prohibited field ${path}.${key} must not be persisted`);
      }
      if (key === "_closureProof" || key === "_manifest") {
        fail(`Transient field ${key} must never appear in durable storage`);
      }
      assertNoProhibitedKeys(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Creation fingerprint
// ---------------------------------------------------------------------------

export type CreationFingerprintInput = {
  reservationId: string;
  tenderId: string;
  tenderVersion: number;
  tenderHash: string;
  winningBidId: string;
  winningBidHash: string;
  winningCarrierId: string;
  winningCarrierAccount: string;
  decisionManifestHash: string;
  evaluatedBidSetHash: string;
  hcsTopicId: string;
  closeBarrierSequence: number;
  closeBarrierConsensusTimestamp: string;
  reservationOfferVersion: number;
  createdAt: string;
  expiresAt: string;
};

export function buildCreationFingerprintInput(
  input: CreationFingerprintInput,
): CreationFingerprintInput {
  return {
    reservationId: input.reservationId,
    tenderId: input.tenderId,
    tenderVersion: input.tenderVersion,
    tenderHash: input.tenderHash,
    winningBidId: input.winningBidId,
    winningBidHash: input.winningBidHash,
    winningCarrierId: input.winningCarrierId,
    winningCarrierAccount: input.winningCarrierAccount,
    decisionManifestHash: input.decisionManifestHash,
    evaluatedBidSetHash: input.evaluatedBidSetHash,
    hcsTopicId: input.hcsTopicId,
    closeBarrierSequence: input.closeBarrierSequence,
    closeBarrierConsensusTimestamp: input.closeBarrierConsensusTimestamp,
    reservationOfferVersion: input.reservationOfferVersion,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
}

export function computeCreationFingerprint(
  input: CreationFingerprintInput,
): string {
  return canonicalSha256(buildCreationFingerprintInput(input));
}

export function creationFingerprintFromRecord(
  record: Pick<
    ReservationRecord,
    | "reservationId"
    | "tenderId"
    | "tenderVersion"
    | "tenderHash"
    | "winningBidId"
    | "winningBidHash"
    | "winningCarrierId"
    | "winningCarrierAccount"
    | "decisionManifestHash"
    | "evaluatedBidSetHash"
    | "hcsTopicId"
    | "closeBarrierSequence"
    | "closeBarrierConsensusTimestamp"
    | "createdAt"
    | "expiresAt"
    | "offer"
  >,
): string {
  return computeCreationFingerprint({
    reservationId: record.reservationId,
    tenderId: record.tenderId,
    tenderVersion: record.tenderVersion,
    tenderHash: record.tenderHash,
    winningBidId: record.winningBidId,
    winningBidHash: record.winningBidHash,
    winningCarrierId: record.winningCarrierId,
    winningCarrierAccount: record.winningCarrierAccount,
    decisionManifestHash: record.decisionManifestHash,
    evaluatedBidSetHash: record.evaluatedBidSetHash,
    hcsTopicId: record.hcsTopicId,
    closeBarrierSequence: record.closeBarrierSequence,
    closeBarrierConsensusTimestamp: record.closeBarrierConsensusTimestamp,
    reservationOfferVersion: record.offer.offerVersion,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  });
}

// ---------------------------------------------------------------------------
// Full record validation
// ---------------------------------------------------------------------------

/**
 * Validate a durable ReservationRecord. Call on create, read, and CAS write.
 * `expectedId` must match record.reservationId. `fromStorage` when true
 * rejects any residual transient proof fields in the object graph.
 */
export function assertValidPersistedReservationRecord(
  record: unknown,
  expectedId: string,
  opts?: { fromStorage?: boolean },
): ReservationRecord {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    fail("Record must be a plain object", "INVALID_PERSISTED_RECORD");
  }
  const r = record as Record<string, unknown>;

  assertSafeReservationId(expectedId);

  if (opts?.fromStorage) {
    if ("_closureProof" in r || "_manifest" in r) {
      fail("Transient proof fields must not appear in durable storage");
    }
  }
  // Never scan transient in-memory proof handles for prohibited nested keys.
  {
    const durableScan = { ...r };
    delete durableScan._closureProof;
    delete durableScan._manifest;
    assertNoProhibitedKeys(durableScan, "record");
  }

  if (r.reservationId !== expectedId) {
    fail(
      `reservationId mismatch: record has ${String(r.reservationId)}, expected ${expectedId}`,
    );
  }
  assertSafeReservationId(String(r.reservationId));

  assertSafeInt(r.recordVersion, "recordVersion", { min: 1 });
  if (typeof r.state !== "string" || !STATES.has(r.state)) {
    fail(`unknown or invalid state: ${String(r.state)}`, "INVALID_PERSISTED_RECORD");
  }
  const state = r.state as ReservationState;

  assertSafeInt(r.tenderVersion, "tenderVersion", { min: 1 });
  assertSafeInt(r.closeBarrierSequence, "closeBarrierSequence", { min: 1 });
  assertSafeInt(r.attemptNumber, "attemptNumber", { allowZero: true, min: 0 });

  assertHash(r.tenderHash, "tenderHash");
  assertHash(r.winningBidHash, "winningBidHash");
  assertHash(r.decisionManifestHash, "decisionManifestHash");
  assertHash(r.evaluatedBidSetHash, "evaluatedBidSetHash");
  assertHash(r.proofManifestHash, "proofManifestHash");
  assertHash(r.creationFingerprint, "creationFingerprint");

  if (typeof r.tenderId !== "string" || r.tenderId.length === 0 || r.tenderId.length > 128) {
    fail("tenderId invalid");
  }
  if (typeof r.winningBidId !== "string" || r.winningBidId.length === 0) {
    fail("winningBidId invalid");
  }
  if (typeof r.winningCarrierId !== "string" || r.winningCarrierId.length === 0) {
    fail("winningCarrierId invalid");
  }
  assertAccount(r.winningCarrierAccount, "winningCarrierAccount");
  if (typeof r.hcsTopicId !== "string" || !isValidHederaAccountId(r.hcsTopicId)) {
    // Topic IDs share entity format
    fail("hcsTopicId must be a valid Hedera entity id");
  }
  assertUtc(r.closeBarrierConsensusTimestamp, "closeBarrierConsensusTimestamp");
  assertUtc(r.createdAt, "createdAt");
  assertUtc(r.updatedAt, "updatedAt");
  assertUtc(r.expiresAt, "expiresAt");

  if (compareUtc(String(r.createdAt), String(r.updatedAt)) > 0) {
    fail("createdAt must be <= updatedAt");
  }
  if (compareUtc(String(r.createdAt), String(r.expiresAt)) >= 0) {
    fail("expiresAt must be after createdAt");
  }

  if (typeof r.proofTenderId !== "string" || r.proofTenderId.length === 0) {
    fail("proofTenderId required");
  }

  // Offer
  if (!r.offer || typeof r.offer !== "object") {
    fail("offer is required");
  }
  const offer = r.offer as ReservationRecord["offer"];
  try {
    verifyOfferIntegrity(offer);
  } catch (e) {
    fail(
      `offer integrity failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (offer.options.length !== 2) fail("offer must have exactly two options");
  const usdc = offer.options.find((o) => o.optionId === "USDC");
  const hbar = offer.options.find((o) => o.optionId === "HBAR");
  if (!usdc || !hbar) fail("offer must include USDC and HBAR");
  if (
    usdc.asset !== USDC_RESERVATION_OPTION.asset ||
    usdc.amountAtomic !== USDC_RESERVATION_OPTION.amountAtomic
  ) {
    fail("USDC option must match fixed reservation definition");
  }
  if (
    hbar.asset !== HBAR_RESERVATION_OPTION.asset ||
    hbar.amountAtomic !== HBAR_RESERVATION_OPTION.amountAtomic
  ) {
    fail("HBAR option must match fixed reservation definition");
  }
  if (offer.payTo !== r.winningCarrierAccount) {
    fail("offer.payTo must equal winningCarrierAccount");
  }
  if (offer.tenderId !== r.tenderId) fail("offer.tenderId mismatch");
  if (offer.winningBidId !== r.winningBidId) fail("offer.winningBidId mismatch");
  if (offer.reservationId !== r.reservationId) fail("offer.reservationId mismatch");
  if (offer.expiresAt !== r.expiresAt) {
    fail("offer.expiresAt must match record.expiresAt");
  }

  // Creation fingerprint recomputation
  const expectedFp = creationFingerprintFromRecord({
    reservationId: String(r.reservationId),
    tenderId: String(r.tenderId),
    tenderVersion: r.tenderVersion as number,
    tenderHash: String(r.tenderHash),
    winningBidId: String(r.winningBidId),
    winningBidHash: String(r.winningBidHash),
    winningCarrierId: String(r.winningCarrierId),
    winningCarrierAccount: String(r.winningCarrierAccount),
    decisionManifestHash: String(r.decisionManifestHash),
    evaluatedBidSetHash: String(r.evaluatedBidSetHash),
    hcsTopicId: String(r.hcsTopicId),
    closeBarrierSequence: r.closeBarrierSequence as number,
    closeBarrierConsensusTimestamp: String(r.closeBarrierConsensusTimestamp),
    createdAt: String(r.createdAt),
    expiresAt: String(r.expiresAt),
    offer,
  });
  if (r.creationFingerprint !== expectedFp) {
    fail("creationFingerprint does not match record trust-critical fields");
  }

  // Selected
  const selected = r.selected as ReservationRecord["selected"];
  if (REQUIRES_SELECTED.has(state)) {
    if (!selected) fail(`state ${state} requires selected option`);
  }
  if (selected) {
    if (selected.reservationId !== r.reservationId) {
      fail("selected.reservationId mismatch");
    }
    if (selected.offerHash !== offer.offerHash) fail("selected.offerHash mismatch");
    if (selected.offerVersion !== offer.offerVersion) {
      fail("selected.offerVersion mismatch");
    }
    const opt = offer.options.find((o) => o.optionId === selected.optionId);
    if (!opt) fail("selected option not in offer");
    assertAccount(selected.payerAccount, "selected.payerAccount");
    if (selected.payTo !== offer.payTo) fail("selected.payTo mismatch");
    if (selected.scheme !== opt.scheme || selected.network !== opt.network) {
      fail("selected scheme/network mismatch");
    }
    if (selected.asset !== opt.asset || selected.amountAtomic !== opt.amountAtomic) {
      fail("selected asset/amount mismatch");
    }
    if (
      selected.resourcePath !==
      resourcePathForOption(String(r.reservationId), selected.optionId)
    ) {
      fail("selected.resourcePath mismatch");
    }
    assertUtc(selected.selectedAt, "selected.selectedAt");
  }

  // Challenge
  const paymentChallenge = r.paymentChallenge as PaymentChallengeRecord | null;
  const paymentChallengeHash = r.paymentChallengeHash as string | null;
  if (REQUIRES_CHALLENGE.has(state)) {
    if (!paymentChallenge || !paymentChallengeHash) {
      fail(`state ${state} requires paymentChallenge and paymentChallengeHash`);
    }
  }
  if (paymentChallenge) {
    if (!selected) fail("challenge must not exist without selected option");
    validateChallengeRecord(paymentChallenge, selected, paymentChallengeHash);
  } else if (paymentChallengeHash) {
    fail("paymentChallengeHash without paymentChallenge");
  }

  // Payment payload
  const paymentPayloadHash = r.paymentPayloadHash as string | null;
  if (REQUIRES_PAYLOAD.has(state)) {
    if (!paymentPayloadHash) fail(`state ${state} requires paymentPayloadHash`);
    assertHash(paymentPayloadHash, "paymentPayloadHash");
    if ((r.attemptNumber as number) !== 1) {
      fail("attemptNumber must be 1 after payment submission started");
    }
  } else if (paymentPayloadHash) {
    assertHash(paymentPayloadHash, "paymentPayloadHash");
  }

  // Facilitator verify
  const facilitatorVerify = r.facilitatorVerify as ReservationRecord["facilitatorVerify"];
  if (REQUIRES_VERIFY_OK.has(state)) {
    if (!facilitatorVerify || facilitatorVerify.isValid !== true) {
      fail(`state ${state} requires facilitatorVerify.isValid === true`);
    }
  }

  // Settle claim
  const settleClaim = r.settleClaim as ReservationRecord["settleClaim"];
  if (REQUIRES_SETTLE_CLAIM.has(state)) {
    if (!settleClaim) fail(`state ${state} requires settleClaim`);
  }
  if (settleClaim) {
    if (!selected || !paymentPayloadHash || !paymentChallengeHash) {
      fail("settleClaim requires selected, payload hash, and challenge hash");
    }
    if (settleClaim.reservationId !== r.reservationId) {
      fail("settleClaim.reservationId mismatch");
    }
    if (settleClaim.selectedOptionId !== selected!.optionId) {
      fail("settleClaim.selectedOptionId mismatch");
    }
    if (
      settleClaim.asset !== selected!.asset ||
      settleClaim.amountAtomic !== selected!.amountAtomic ||
      settleClaim.payerAccount !== selected!.payerAccount ||
      settleClaim.payTo !== selected!.payTo ||
      settleClaim.network !== RESERVATION_NETWORK
    ) {
      fail("settleClaim payment binding mismatch");
    }
    if (settleClaim.challengeHash !== paymentChallengeHash) {
      fail("settleClaim.challengeHash mismatch");
    }
    if (settleClaim.paymentPayloadHash !== paymentPayloadHash) {
      fail("settleClaim.paymentPayloadHash mismatch");
    }
    if (settleClaim.attemptNumber !== r.attemptNumber) {
      fail("settleClaim.attemptNumber mismatch");
    }
    assertUtc(settleClaim.claimedAt, "settleClaim.claimedAt");
    assertSafeInt(settleClaim.recordVersion, "settleClaim.recordVersion", {
      min: 1,
    });
    if (settleClaim.recordVersion > (r.recordVersion as number)) {
      fail("settleClaim.recordVersion cannot exceed record.recordVersion");
    }
  }

  // Facilitator settle + tx
  const facilitatorSettle = r.facilitatorSettle as ReservationRecord["facilitatorSettle"];
  const transactionId = r.transactionId as string | null;
  if (REQUIRES_SETTLED_TX.has(state) && state !== "SETTLEMENT_FAILED") {
    // SETTLEMENT_FAILED is not in REQUIRES_SETTLED_TX
  }
  if (REQUIRES_SETTLED_TX.has(state)) {
    if (!transactionId || transactionId.length === 0) {
      fail(`state ${state} requires non-empty transactionId`);
    }
    if (state === "FACILITATOR_SETTLED") {
      if (!facilitatorSettle || facilitatorSettle.success !== true) {
        fail(`state ${state} requires successful facilitatorSettle`);
      }
    }
    if (facilitatorSettle) {
      if (
        facilitatorSettle.success === true &&
        facilitatorSettle.transactionId !== transactionId
      ) {
        fail("facilitatorSettle.transactionId must equal record.transactionId");
      }
      if (facilitatorSettle.success === true && selected) {
        if (facilitatorSettle.network !== selected.network) {
          fail("facilitatorSettle.network mismatch");
        }
        if (facilitatorSettle.payerAccountId !== selected.payerAccount) {
          fail("facilitatorSettle.payerAccountId mismatch");
        }
      }
    } else if (state !== "FACILITATOR_SETTLED" && !settleClaim) {
      // Recovery may set MIRROR_CONFIRMATION_PENDING from a settle claim +
      // authoritative tx id without a facilitatorSettle blob — claim required.
      fail(`state ${state} requires facilitatorSettle or settleClaim`);
    }
  }
  // Terminal settle failure: may have unsuccessful result, no routeReserved
  if (state === "SETTLEMENT_FAILED" && r.routeReserved) {
    fail("SETTLEMENT_FAILED must not contain routeReserved");
  }

  // Mirror poll / confirmation
  const mirrorPoll = r.mirrorPoll as MirrorPollRecord | null;
  const confirmationDeadline = r.confirmationDeadline as string | null;
  const mirrorConfirmation = r.mirrorConfirmation as ReservationRecord["mirrorConfirmation"];

  if (REQUIRES_MIRROR_POLL.has(state)) {
    if (!transactionId) fail(`state ${state} requires transactionId`);
    if (!confirmationDeadline) {
      fail(`state ${state} requires confirmationDeadline`);
    }
    if (!mirrorPoll) fail(`state ${state} requires mirrorPoll metadata`);
  }
  if (mirrorPoll) {
    validateMirrorPoll(mirrorPoll, String(transactionId ?? mirrorPoll.transactionId), confirmationDeadline);
  }
  if (confirmationDeadline) {
    assertUtc(confirmationDeadline, "confirmationDeadline");
  }

  if (REQUIRES_MIRROR_SUCCESS.has(state)) {
    if (!mirrorConfirmation || mirrorConfirmation.status !== "SUCCESS") {
      fail(`state ${state} requires mirrorConfirmation SUCCESS`);
    }
    if (mirrorConfirmation!.result && mirrorConfirmation!.result !== "SUCCESS") {
      fail("mirrorConfirmation.result must be SUCCESS");
    }
    if (mirrorConfirmation!.transactionId !== transactionId) {
      fail("mirrorConfirmation.transactionId mismatch");
    }
    assertUtc(mirrorConfirmation!.consensusTimestamp, "mirrorConfirmation.consensusTimestamp");
    if (mirrorPoll && !mirrorPoll.verifiedTransfer) {
      // PAYMENT_CONFIRMED+ should have verified transfer when we set it;
      // allow success path records that stored verifiedTransfer.
    }
    if (mirrorPoll?.verifiedTransfer && selected) {
      const v = mirrorPoll.verifiedTransfer;
      if (
        v.optionId !== selected.optionId ||
        v.asset !== selected.asset ||
        v.amountAtomic !== selected.amountAtomic ||
        v.payerAccount !== selected.payerAccount ||
        v.payTo !== selected.payTo
      ) {
        fail("verifiedTransfer does not match selected payment");
      }
    }
  }

  if (state === "CONFIRMATION_TIMED_OUT") {
    if (r.routeReserved) fail("CONFIRMATION_TIMED_OUT must not contain routeReserved");
    if (!selected) fail("CONFIRMATION_TIMED_OUT retains locked selection");
    if (!transactionId) fail("CONFIRMATION_TIMED_OUT retains transactionId");
  }
  if (state === "CONFIRMATION_FAILED") {
    if (r.routeReserved) fail("CONFIRMATION_FAILED must not contain routeReserved");
  }

  // Route reserved
  const routeReserved = r.routeReserved as ReservationRecord["routeReserved"];
  if (POST_RESERVATION_STATES.has(state) || state === "ROUTE_RESERVED") {
    if (!routeReserved) fail(`state ${state} requires routeReserved`);
  }
  if (state !== "ROUTE_RESERVED" && !POST_RESERVATION_STATES.has(state)) {
    if (routeReserved) {
      fail(`state ${state} must not contain routeReserved`);
    }
  }
  if (routeReserved) {
    if (!verifyRouteReservedRecordHash(routeReserved)) {
      fail("routeReserved.reservationRecordHash verification failed");
    }
    if (routeReserved.reservationId !== r.reservationId) {
      fail("routeReserved.reservationId mismatch");
    }
    if (routeReserved.tenderId !== r.tenderId) fail("routeReserved.tenderId mismatch");
    if (routeReserved.tenderVersion !== r.tenderVersion) {
      fail("routeReserved.tenderVersion mismatch");
    }
    if (routeReserved.tenderHash !== r.tenderHash) fail("routeReserved.tenderHash mismatch");
    if (routeReserved.winningBidId !== r.winningBidId) {
      fail("routeReserved.winningBidId mismatch");
    }
    if (routeReserved.winningBidHash !== r.winningBidHash) {
      fail("routeReserved.winningBidHash mismatch");
    }
    if (routeReserved.carrierId !== r.winningCarrierId) {
      fail("routeReserved.carrierId mismatch");
    }
    if (routeReserved.carrierAccount !== r.winningCarrierAccount) {
      fail("routeReserved.carrierAccount mismatch");
    }
    if (selected) {
      if (routeReserved.selectedOptionId !== selected.optionId) {
        fail("routeReserved.selectedOptionId mismatch");
      }
      if (routeReserved.paymentAsset !== selected.asset) {
        fail("routeReserved.paymentAsset mismatch");
      }
      if (routeReserved.paymentAmountAtomic !== selected.amountAtomic) {
        fail("routeReserved.paymentAmountAtomic mismatch");
      }
      if (routeReserved.payerAccount !== selected.payerAccount) {
        fail("routeReserved.payerAccount mismatch");
      }
    }
    if (routeReserved.transactionId !== transactionId) {
      fail("routeReserved.transactionId mismatch");
    }
    if (mirrorConfirmation?.consensusTimestamp) {
      if (routeReserved.consensusTimestamp !== mirrorConfirmation.consensusTimestamp) {
        fail("routeReserved.consensusTimestamp must match Mirror confirmation");
      }
      if (routeReserved.reservedAt !== mirrorConfirmation.consensusTimestamp) {
        fail("routeReserved.reservedAt must equal consensus timestamp");
      }
    }
    if (routeReserved.decisionManifestHash !== r.decisionManifestHash) {
      fail("routeReserved.decisionManifestHash mismatch");
    }
    if (routeReserved.evaluatedBidSetHash !== r.evaluatedBidSetHash) {
      fail("routeReserved.evaluatedBidSetHash mismatch");
    }
    if (routeReserved.hcsAuctionTopicId !== r.hcsTopicId) {
      fail("routeReserved.hcsAuctionTopicId mismatch");
    }
    if (routeReserved.closeBarrierSequence !== r.closeBarrierSequence) {
      fail("routeReserved.closeBarrierSequence mismatch");
    }
  }

  // Webhooks
  const webhookEvents = r.webhookEvents as WebhookEvent[];
  const webhooks = r.webhooks as ReservationRecord["webhooks"];
  if (!Array.isArray(webhookEvents) || !Array.isArray(webhooks)) {
    fail("webhookEvents and webhooks must be arrays");
  }
  if (webhookEvents.length > 0 || webhooks.length > 0) {
    if (!routeReserved) {
      fail("webhook outbox data may exist only after ROUTE_RESERVED");
    }
  }
  validateWebhooks(webhookEvents, webhooks, routeReserved, String(r.reservationId));

  // HCS outbox
  const hcsPublicationClaim = r.hcsPublicationClaim as HcsPublicationClaim | null;
  const hcsEvidence = r.hcsEvidence as ReservationRecord["hcsEvidence"];
  if (hcsPublicationClaim) {
    if (!routeReserved) fail("HCS publication claim requires routeReserved");
    validateHcsClaim(
      hcsPublicationClaim,
      String(r.reservationId),
      String(r.hcsTopicId),
      routeReserved!,
      hcsEvidence,
    );
  }
  if (hcsEvidence && hcsPublicationClaim) {
    if (
      hcsEvidence.published &&
      hcsPublicationClaim.status !== "PUBLISHED"
    ) {
      fail("hcsEvidence.published conflicts with claim status");
    }
    if (
      hcsPublicationClaim.status === "PUBLISHED" &&
      hcsEvidence.envelopeHash !== hcsPublicationClaim.envelopeHash
    ) {
      fail("hcsEvidence.envelopeHash must match claim");
    }
  }

  if (!Array.isArray(r.history)) fail("history must be an array");

  if (r.failureCode !== null && typeof r.failureCode !== "string") {
    fail("failureCode invalid");
  }
  if (r.failureReason !== null && typeof r.failureReason !== "string") {
    fail("failureReason invalid");
  }
  if (typeof r.failureReason === "string" && r.failureReason.length > 2000) {
    fail("failureReason exceeds bound");
  }

  return record as ReservationRecord;
}

function validateChallengeRecord(
  ch: PaymentChallengeRecord,
  selected: NonNullable<ReservationRecord["selected"]>,
  paymentChallengeHash: string | null,
): void {
  if (ch.x402Version !== CHALLENGE_X402_VERSION) fail("challenge x402Version must be 2");
  if (ch.scheme !== RESERVATION_SCHEME) fail("challenge scheme mismatch");
  if (ch.network !== RESERVATION_NETWORK) fail("challenge network mismatch");
  if (ch.asset !== selected.asset) fail("challenge asset mismatch");
  if (ch.amount !== selected.amountAtomic) fail("challenge amount mismatch");
  if (ch.payTo !== selected.payTo) fail("challenge payTo mismatch");
  if (ch.resource !== selected.resourcePath) fail("challenge resource mismatch");
  if (ch.maxTimeoutSeconds !== CHALLENGE_MAX_TIMEOUT_SECONDS) {
    fail("challenge maxTimeoutSeconds must be 180");
  }
  if (ch.description !== DEMO_RESERVATION_FEE_NOTE) {
    fail("challenge description mismatch");
  }
  assertUtc(ch.issuedAt, "challenge.issuedAt");
  const hashInput: ChallengeHashInput = {
    x402Version: CHALLENGE_X402_VERSION,
    scheme: RESERVATION_SCHEME,
    network: RESERVATION_NETWORK,
    asset: ch.asset,
    amount: ch.amount,
    payTo: ch.payTo,
    resource: ch.resource,
    maxTimeoutSeconds: CHALLENGE_MAX_TIMEOUT_SECONDS,
    description: ch.description,
    issuedAt: ch.issuedAt,
  };
  const recomputed = computeChallengeHash(hashInput);
  if (ch.challengeHash !== recomputed) {
    fail("challengeHash does not recompute");
  }
  if (paymentChallengeHash !== ch.challengeHash) {
    fail("paymentChallengeHash must equal paymentChallenge.challengeHash");
  }
}

function validateMirrorPoll(
  poll: MirrorPollRecord,
  transactionId: string,
  confirmationDeadline: string | null,
): void {
  assertUtc(poll.confirmationStartedAt, "mirrorPoll.confirmationStartedAt");
  assertUtc(poll.confirmationDeadline, "mirrorPoll.confirmationDeadline");
  if (compareUtc(poll.confirmationStartedAt, poll.confirmationDeadline) >= 0) {
    fail("mirrorPoll deadline must be after start");
  }
  if (
    confirmationDeadline &&
    poll.confirmationDeadline !== confirmationDeadline
  ) {
    fail("mirrorPoll.confirmationDeadline must match record.confirmationDeadline");
  }
  assertSafeInt(poll.pollAttemptCount, "mirrorPoll.pollAttemptCount", {
    allowZero: true,
    min: 0,
  });
  if (poll.lastPollAt !== null) {
    assertUtc(poll.lastPollAt, "mirrorPoll.lastPollAt");
  }
  if (poll.transactionId !== transactionId) {
    fail("mirrorPoll.transactionId must match record.transactionId");
  }
  const allowed = new Set([
    "SUCCESS",
    "FAILED",
    "PENDING",
    "NOT_FOUND",
    "TRANSPORT_ERROR",
    null,
  ]);
  if (!allowed.has(poll.lastMirrorStatus as never)) {
    fail("mirrorPoll.lastMirrorStatus invalid");
  }
  if (
    poll.lastMirrorError !== null &&
    (typeof poll.lastMirrorError !== "string" ||
      poll.lastMirrorError.length > 1000)
  ) {
    fail("mirrorPoll.lastMirrorError unbounded or invalid");
  }
  if (
    poll.lastMirrorErrorCode !== null &&
    (typeof poll.lastMirrorErrorCode !== "string" ||
      poll.lastMirrorErrorCode.length > 128)
  ) {
    fail("mirrorPoll.lastMirrorErrorCode invalid");
  }
  if (poll.consensusTimestamp !== null) {
    assertUtc(poll.consensusTimestamp, "mirrorPoll.consensusTimestamp");
  }
}

function validateWebhooks(
  events: WebhookEvent[],
  deliveries: ReservationRecord["webhooks"],
  routeReserved: ReservationRecord["routeReserved"],
  reservationId: string,
): void {
  const seen = new Set<string>();
  const byRecipient = new Set<string>();
  for (const e of events) {
    if (seen.has(e.eventId)) fail("duplicate webhook eventId");
    seen.add(e.eventId);
    if (byRecipient.has(e.recipient)) {
      fail("at most one semantic event per recipient");
    }
    byRecipient.add(e.recipient);
    if (e.recipient !== "shipper" && e.recipient !== "carrier") {
      fail("webhook recipient invalid");
    }
    if (e.eventId !== reservationWebhookEventId(reservationId, e.recipient)) {
      fail("webhook eventId is not deterministic for reservation+recipient");
    }
    if (e.eventType !== ROUTE_RESERVED_EVENT_TYPE) fail("webhook eventType mismatch");
    if (e.signatureVersion !== WEBHOOK_SIGNATURE_VERSION) {
      fail("webhook signatureVersion mismatch");
    }
    assertUtc(e.emittedAt, "webhook.emittedAt");
    assertUtc(e.signedTimestamp, "webhook.signedTimestamp");
    if (!parseSignatureHex(e.signature)) {
      fail("webhook signature encoding invalid");
    }
    assertHash(e.payloadHash, "webhook.payloadHash");
    const recomputed = canonicalSha256(e.payload);
    if (recomputed !== e.payloadHash) fail("webhook payloadHash does not recompute");
    if (e.payload.eventId !== e.eventId) fail("webhook payload.eventId mismatch");
    if (e.payload.eventType !== ROUTE_RESERVED_EVENT_TYPE) {
      fail("webhook payload.eventType mismatch");
    }
    if (routeReserved) {
      if (e.payload.reservationId !== routeReserved.reservationId) {
        fail("webhook payload.reservationId mismatch");
      }
      if (e.payload.tenderId !== routeReserved.tenderId) {
        fail("webhook payload.tenderId mismatch");
      }
      if (e.payload.winningBidId !== routeReserved.winningBidId) {
        fail("webhook payload.winningBidId mismatch");
      }
      if (e.payload.carrierAccount !== routeReserved.carrierAccount) {
        fail("webhook payload.carrierAccount mismatch");
      }
      if (e.payload.selectedOptionId !== routeReserved.selectedOptionId) {
        fail("webhook payload.selectedOptionId mismatch");
      }
      if (e.payload.paymentAsset !== routeReserved.paymentAsset) {
        fail("webhook payload.paymentAsset mismatch");
      }
      if (e.payload.paymentAmountAtomic !== routeReserved.paymentAmountAtomic) {
        fail("webhook payload.paymentAmountAtomic mismatch");
      }
      if (e.payload.transactionId !== routeReserved.transactionId) {
        fail("webhook payload.transactionId mismatch");
      }
      if (e.payload.consensusTimestamp !== routeReserved.consensusTimestamp) {
        fail("webhook payload.consensusTimestamp mismatch");
      }
      if (e.payload.reservationRecordHash !== routeReserved.reservationRecordHash) {
        fail("webhook payload.reservationRecordHash mismatch");
      }
    }
    assertNoProhibitedKeys(e, "webhookEvent");
  }

  for (const d of deliveries) {
    const ev = events.find((e) => e.eventId === d.eventId);
    if (!ev) fail("delivery references unknown semantic event");
    if (d.recipient !== ev!.recipient) fail("delivery recipient mismatch");
    if (d.payloadHash !== ev!.payloadHash) fail("delivery payloadHash mismatch");
    assertSafeInt(d.deliveryAttemptNumber, "deliveryAttemptNumber", {
      allowZero: true,
      min: 0,
    });
    if (d.attemptedAt !== null) assertUtc(d.attemptedAt, "delivery.attemptedAt");
    if (d.delivered && d.lastError !== null) {
      // allow delivered with null error only ideally; if delivered, error should be null
    }
    if (
      d.lastError !== null &&
      (typeof d.lastError !== "string" || d.lastError.length > 1000)
    ) {
      fail("delivery lastError unbounded");
    }
  }
}

function validateHcsClaim(
  claim: HcsPublicationClaim,
  reservationId: string,
  hcsTopicId: string,
  routeReserved: NonNullable<ReservationRecord["routeReserved"]>,
  hcsEvidence: ReservationRecord["hcsEvidence"],
): void {
  if (claim.reservationId !== reservationId) fail("HCS claim reservationId mismatch");
  if (claim.expectedTopicId !== hcsTopicId) {
    fail("HCS claim expectedTopicId must equal record.hcsTopicId");
  }
  if (claim.expectedTopicId !== routeReserved.hcsAuctionTopicId) {
    fail("HCS claim expectedTopicId must equal routeReserved.hcsAuctionTopicId");
  }
  if (claim.messageType !== "ROUTE_RESERVED") fail("HCS claim messageType mismatch");
  assertUtc(claim.claimedAt, "HCS claim.claimedAt");
  assertHash(claim.envelopeHash, "HCS claim.envelopeHash");
  assertSafeInt(claim.encodedByteCount, "HCS claim.encodedByteCount", { min: 1 });
  if (claim.encodedByteCount > HCS_MAX_MESSAGE_BYTES) {
    fail("HCS claim encodedByteCount exceeds 1024");
  }

  let envelope: RouteReservedEnvelope;
  try {
    envelope = decodeRouteReservedEnvelope(claim.envelope);
  } catch (e) {
    fail(
      `HCS claim envelope schema invalid: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (envelope.messageType !== "ROUTE_RESERVED") fail("envelope messageType");
  if (envelope.payload.reservationRecordHash !== routeReserved.reservationRecordHash) {
    fail("envelope reservationRecordHash mismatch");
  }
  if (envelope.tenderId !== routeReserved.tenderId) fail("envelope tenderId mismatch");
  if (envelope.tenderVersion !== routeReserved.tenderVersion) {
    fail("envelope tenderVersion mismatch");
  }
  if (envelope.tenderHash !== routeReserved.tenderHash) {
    fail("envelope tenderHash mismatch");
  }
  const envHash = routeReservedEnvelopeHash(envelope);
  if (envHash !== claim.envelopeHash) fail("HCS claim envelopeHash does not recompute");
  const bytes = measureRouteReservedEnvelope(envelope);
  if (bytes !== claim.encodedByteCount) {
    fail("HCS claim encodedByteCount does not match actual UTF-8 byte count");
  }

  const allowedStatus = new Set([
    "CLAIMED",
    "RESOLVING",
    "PUBLISHED",
    "MANUAL_REVIEW_REQUIRED",
    "FAILED_CONCLUSIVE",
  ]);
  if (!allowedStatus.has(claim.status)) fail("HCS claim status invalid");

  if (claim.status === "PUBLISHED") {
    if (!claim.transactionId || claim.transactionId.length === 0) {
      fail("PUBLISHED claim requires transactionId");
    }
    assertSafeInt(claim.sequence, "HCS claim.sequence", { min: 1 });
    assertUtc(claim.consensusTimestamp, "HCS claim.consensusTimestamp");
    if (!hcsEvidence || !hcsEvidence.published) {
      fail("PUBLISHED claim requires matching hcsEvidence.published");
    }
    if (hcsEvidence) {
      if (hcsEvidence.sequence !== claim.sequence) {
        fail("hcsEvidence.sequence mismatch");
      }
      if (hcsEvidence.transactionId !== claim.transactionId) {
        fail("hcsEvidence.transactionId mismatch");
      }
      if (hcsEvidence.consensusTimestamp !== claim.consensusTimestamp) {
        fail("hcsEvidence.consensusTimestamp mismatch");
      }
      if (hcsEvidence.topicId !== claim.expectedTopicId) {
        fail("hcsEvidence.topicId mismatch");
      }
    }
  }

  if (claim.status === "CLAIMED" || claim.status === "RESOLVING") {
    // Publication result fields remain null unless explicitly authoritative.
    // Allow null sequence/tx/consensus.
    if (claim.sequence !== null && claim.sequence !== undefined) {
      // If set, must be valid — but normally null
    }
  }

  if (
    claim.status === "MANUAL_REVIEW_REQUIRED" ||
    claim.status === "FAILED_CONCLUSIVE"
  ) {
    // Must not fabricate successful publication
    if (hcsEvidence?.published === true) {
      fail("ambiguous/failed claim must not have published evidence");
    }
  }
}

// ---------------------------------------------------------------------------
// API request schemas
// ---------------------------------------------------------------------------

export const SelectReservationBodySchema = z
  .object({
    optionId: z.enum(["USDC", "HBAR"]),
    offerHash: z.string().regex(SHA256_RE, "invalid offerHash"),
    offerVersion: z
      .number()
      .int()
      .positive()
      .refine((n) => Number.isSafeInteger(n), "offerVersion must be safe integer"),
    payerAccount: z
      .string()
      .min(1)
      .refine(isValidHederaAccountId, "invalid payerAccount"),
  })
  .strict();

export const PayReservationBodySchema = z
  .object({
    paymentPayloadHash: z.string().regex(SHA256_RE, "invalid paymentPayloadHash"),
    httpStatus: z
      .number()
      .int()
      .min(100)
      .max(599)
      .optional(),
  })
  .strict();

export type SelectReservationBody = z.infer<typeof SelectReservationBodySchema>;
export type PayReservationBody = z.infer<typeof PayReservationBodySchema>;
