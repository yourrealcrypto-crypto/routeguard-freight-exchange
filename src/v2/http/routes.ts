/**
 * RouteGuard v2 x402-protected access routes.
 *
 * Two protected actions, each priced at the exact product access fee
 * (0.001 USDC = 1000 atomic units of token 0.0.429274), paid to the configured
 * RouteGuard access treasury:
 *
 *   POST /api/v2/tenders/:tenderId/v/:tenderVersion/activate
 *   POST /api/v2/tenders/:tenderId/v/:tenderVersion/bids/:bidId
 *
 * The access fee is an application access price. It is never the Hedera network
 * fee, the freight principal, escrow funding, freight payment, or a payment to
 * a carrier.
 *
 * Requests that can never legally succeed are rejected **before** any payment
 * challenge is issued, so nobody is charged for an action that cannot happen.
 */

import { Hono, type Context } from "hono";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { ZodError, z } from "zod";

import type { CarrierRegistry } from "../../domain/carrier";
import { isBeforeOrEqualUtc, isUtcIsoTimestamp } from "../../domain/time";
import { bidSubmitResource, tenderActivateResource } from "../access/resource";
import {
  AccessPaymentError,
  readAccessPaymentHeader,
  type AccessActionBinding,
  type SettledAccessPayment,
  type X402AccessGate,
} from "../access/x402-gate";
import { verifyCarrierBid, AuthorizationError } from "../auth/verify";
import { assertUsableV2AccessConfig, type V2AccessConfig } from "../config";
import { bidCommitmentPayloadHash } from "../hcs/outbox";
import {
  LifecycleActionConflictError,
  LifecycleGuardError,
  LifecycleVersionConflictError,
} from "../lifecycle/errors";
import type { BidSubmissionPaid, TenderActivationPaid } from "../lifecycle/events";
import type { LifecycleRecord } from "../lifecycle/record";
import {
  parseV2CarrierBid,
  signedV2BidEnvelopeHash,
  v2BidHash,
  type SignedV2CarrierBid,
} from "../schemas/bid";
import type { V2FreightTender } from "../schemas/tender";
import type { BidBodyStore } from "../store/bid-body-store";
import { BidBodyConflictError } from "../store/bid-body-store";
import type { LifecycleService } from "../store/lifecycle-service";
import { LifecyclePersistenceError } from "../store/persistence-errors";
import { V2AccessError, v2AccessErrorStatus } from "./errors";

export const V2_TENDER_ACTIVATE_PATH =
  "/api/v2/tenders/:tenderId/v/:tenderVersion/activate" as const;
export const V2_BID_SUBMIT_PATH =
  "/api/v2/tenders/:tenderId/v/:tenderVersion/bids/:bidId" as const;

/** Read-only source of v2 tender definitions used for bid eligibility. */
export interface V2TenderCatalog {
  get(tenderId: string, tenderVersion: number): Promise<V2FreightTender | null>;
}

export type V2AccessRouteDeps = {
  readonly lifecycle: LifecycleService;
  readonly bidBodies: BidBodyStore;
  readonly tenders: V2TenderCatalog;
  readonly carriers: CarrierRegistry;
  readonly gate: X402AccessGate;
  readonly config: V2AccessConfig;
  /** Injected UTC server clock — the sole time source for these routes. */
  readonly now: () => string;
  readonly onInternalError?: (info: { code: string; message: string }) => void;
};

const ActivateBodySchema = z
  .object({
    actionId: z.string().min(1).max(128),
  })
  .strict();

const BidBodySchema = z
  .object({
    actionId: z.string().min(1).max(128),
    signedAt: z.string().min(1).max(64),
    signature: z.string().min(1).max(256),
    bid: z.unknown(),
  })
  .strict();

export function createV2AccessApp(deps: V2AccessRouteDeps): Hono {
  const app = new Hono();
  registerV2AccessRoutes(app, deps);
  return app;
}

export function registerV2AccessRoutes(
  app: Hono,
  deps: V2AccessRouteDeps,
): void {
  // Fail closed at route initialization when the treasury is absent/malformed.
  assertUsableV2AccessConfig(deps.config);

  app.post(V2_TENDER_ACTIVATE_PATH, async (c) => {
    try {
      return await handleActivate(c, deps);
    } catch (error) {
      return handleError(c, error, deps);
    }
  });

  app.post(V2_BID_SUBMIT_PATH, async (c) => {
    try {
      return await handleBid(c, deps);
    } catch (error) {
      return handleError(c, error, deps);
    }
  });
}

// ---------------------------------------------------------------------------
// Tender activation
// ---------------------------------------------------------------------------

async function handleActivate(
  c: HonoContext,
  deps: V2AccessRouteDeps,
): Promise<Response> {
  const tenderId = c.req.param("tenderId");
  const tenderVersion = parseTenderVersion(c.req.param("tenderVersion"));
  const body = ActivateBodySchema.parse(await parseJsonBody(c));

  const record = await loadRecord(deps, tenderId, tenderVersion);
  assertTreasuryConsistent(record, deps.config);

  // Replay of an already-committed activation returns the original resource
  // without touching the facilitator.
  const prior = record.processedActions[body.actionId];
  if (prior) {
    if (prior.eventType !== "TENDER_ACTIVATION_PAID") {
      throw new V2AccessError(
        "ACTION_ID_CONFLICT",
        "actionId was already used for a different action",
      );
    }
    return c.json(activationView(record, "REPLAYED"), 200);
  }

  if (record.state !== "ESCROW_FUNDED") {
    if (record.state === "DRAFT") {
      throw new V2AccessError(
        "ESCROW_NOT_CONFIRMED",
        "tender escrow funding is not confirmed",
      );
    }
    throw new V2AccessError(
      "INVALID_LIFECYCLE_STATE",
      "tender cannot be activated in its current state",
    );
  }

  const binding: AccessActionBinding = {
    actionType: "TENDER_ACTIVATE",
    tenderId: record.tenderId,
    tenderVersion: record.tenderVersion,
    bidId: null,
    resource: tenderActivateResource(record.tenderId, record.tenderVersion),
    description: "RouteGuard v2 tender activation access fee",
  };

  const rawPayment = readAccessPaymentHeader((name) => c.req.header(name));
  if (!rawPayment) {
    return await paymentRequiredResponse(c, deps, binding);
  }

  const settled = await settleAccessPayment(deps, record, rawPayment, binding);

  const event: TenderActivationPaid = {
    type: "TENDER_ACTIVATION_PAID",
    actionId: body.actionId,
    eventTime: settled.settledAt,
    accessActionType: "TENDER_ACTIVATE",
    asset: settled.asset,
    amountAtomic: settled.amountAtomic,
    resource: settled.resource,
    paymentTransactionId: settled.transactionId,
    paymentPayloadHash: settled.paymentPayloadHash,
    payerAccount: settled.payerAccount,
    payTo: settled.payTo,
  };
  const applied = await deps.lifecycle.apply(record.tenderId, event);

  return c.json(
    activationView(applied.record, applied.outcome === "REPLAYED" ? "REPLAYED" : "PAID"),
    200,
  );
}

// ---------------------------------------------------------------------------
// Durable carrier bid
// ---------------------------------------------------------------------------

async function handleBid(
  c: HonoContext,
  deps: V2AccessRouteDeps,
): Promise<Response> {
  const tenderId = c.req.param("tenderId");
  const tenderVersion = parseTenderVersion(c.req.param("tenderVersion"));
  const bidId = c.req.param("bidId");
  const body = BidBodySchema.parse(await parseJsonBody(c));

  const record = await loadRecord(deps, tenderId, tenderVersion);
  assertTreasuryConsistent(record, deps.config);

  const prior = record.processedActions[body.actionId];
  if (prior) {
    if (prior.eventType !== "BID_SUBMISSION_PAID") {
      throw new V2AccessError(
        "ACTION_ID_CONFLICT",
        "actionId was already used for a different action",
      );
    }
    const existing = record.bidRegistry.find(
      (entry) => entry.actionId === body.actionId,
    );
    if (!existing || existing.bidId !== bidId) {
      throw new V2AccessError(
        "ACTION_ID_CONFLICT",
        "actionId was already used for a different bid",
      );
    }
    return c.json(bidView(record, existing.bidId, "REPLAYED"), 200);
  }

  if (record.state !== "TENDER_OPENED" && record.state !== "BIDDING") {
    if (record.state === "DRAFT" || record.state === "ESCROW_FUNDED") {
      throw new V2AccessError(
        "INVALID_LIFECYCLE_STATE",
        "tender is not open for bidding",
      );
    }
    throw new V2AccessError(
      "AUCTION_CLOSED",
      "tender no longer accepts bids",
    );
  }

  // --- pre-payment bid validation (never charge an unusable bid) -----------

  if (!isUtcIsoTimestamp(body.signedAt)) {
    throw new V2AccessError("BID_INVALID", "signedAt must be a UTC timestamp");
  }

  let bid;
  try {
    bid = parseV2CarrierBid(body.bid);
  } catch {
    throw new V2AccessError("BID_INVALID", "bid failed schema validation");
  }
  if (
    bid.bidId !== bidId ||
    bid.tenderId !== record.tenderId ||
    bid.tenderVersion !== record.tenderVersion
  ) {
    throw new V2AccessError(
      "BID_INVALID",
      "bid does not match the requested tender version and bid id",
    );
  }

  const now = deps.now();
  if (!isBeforeOrEqualUtc(now, record.auctionEndsAt)) {
    throw new V2AccessError("AUCTION_CLOSED", "the auction has already ended");
  }
  if (record.bidRegistry.some((entry) => entry.bidId === bid.bidId)) {
    throw new V2AccessError(
      "PERSISTENCE_CONFLICT",
      "this bid has already been durably accepted",
    );
  }

  const tender = await deps.tenders.get(record.tenderId, record.tenderVersion);
  if (!tender) {
    throw new V2AccessError("TENDER_NOT_FOUND", "tender definition not found");
  }
  assertBidEligible({ bid, tender, record, carriers: deps.carriers, now });

  const bidHash = v2BidHash(bid);
  const signed: SignedV2CarrierBid = { bid, signature: body.signature };
  const carrier = deps.carriers.getById(bid.carrierId);
  let auth;
  try {
    auth = verifyCarrierBid({
      registeredPublicKey: carrier!.signingPublicKey,
      tenderId: record.tenderId,
      tenderVersion: record.tenderVersion,
      bidId: bid.bidId,
      carrierId: bid.carrierId,
      carrierAccountId: bid.carrierAccountId,
      bidHash,
      signedAt: body.signedAt,
      actionId: body.actionId,
      signature: body.signature,
    });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      throw new V2AccessError("BID_INVALID", "bid signature is not valid");
    }
    throw error;
  }

  const binding: AccessActionBinding = {
    actionType: "BID_SUBMIT",
    tenderId: record.tenderId,
    tenderVersion: record.tenderVersion,
    bidId: bid.bidId,
    resource: bidSubmitResource(
      record.tenderId,
      record.tenderVersion,
      bid.bidId,
    ),
    description: "RouteGuard v2 durable bid submission access fee",
  };

  const rawPayment = readAccessPaymentHeader((name) => c.req.header(name));
  if (!rawPayment) {
    return await paymentRequiredResponse(c, deps, binding);
  }

  // The private bid body is stored before settlement: it is content-addressed
  // and idempotent, and an orphan body is never an acceptance.
  const stored = await deps.bidBodies.put({
    tenderId: record.tenderId,
    tenderVersion: record.tenderVersion,
    signed,
    storedAt: now,
  });

  const settled = await settleAccessPayment(deps, record, rawPayment, binding);

  const event: BidSubmissionPaid = {
    type: "BID_SUBMISSION_PAID",
    actionId: body.actionId,
    eventTime: settled.settledAt,
    accessActionType: "BID_SUBMIT",
    bidId: bid.bidId,
    carrierId: bid.carrierId,
    carrierAccountId: bid.carrierAccountId,
    bidHash,
    signedBidEnvelopeHash: signedV2BidEnvelopeHash(signed),
    commitmentPayloadHash: bidCommitmentPayloadHash({
      bidId: bid.bidId,
      carrierId: bid.carrierId,
      bidHash,
      accessPaymentTxId: settled.transactionId,
    }),
    carrierSignature: body.signature,
    signedAt: body.signedAt,
    asset: settled.asset,
    amountAtomic: settled.amountAtomic,
    resource: settled.resource,
    paymentTransactionId: settled.transactionId,
    paymentPayloadHash: settled.paymentPayloadHash,
    payerAccount: settled.payerAccount,
    payTo: settled.payTo,
  };

  // The service re-verifies the carrier signature against the trusted registry
  // before the reducer accepts the sealed authorization.
  void auth;
  void stored;
  const applied = await deps.lifecycle.apply(record.tenderId, event);

  return c.json(
    bidView(
      applied.record,
      bid.bidId,
      applied.outcome === "REPLAYED" ? "REPLAYED" : "ACCEPTED",
    ),
    200,
  );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type HonoContext = Context;

function parseTenderVersion(raw: string): number {
  const parsed = Number(raw);
  if (
    !/^\d{1,9}$/.test(raw) ||
    !Number.isSafeInteger(parsed) ||
    parsed < 1
  ) {
    throw new V2AccessError(
      "TENDER_VERSION_MISMATCH",
      "tenderVersion must be a positive integer",
    );
  }
  return parsed;
}

async function parseJsonBody(c: HonoContext): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new V2AccessError("BID_INVALID", "request body must be valid JSON");
  }
}

async function loadRecord(
  deps: V2AccessRouteDeps,
  tenderId: string,
  tenderVersion: number,
): Promise<LifecycleRecord> {
  let record: LifecycleRecord | null;
  try {
    record = await deps.lifecycle.get(tenderId);
  } catch (error) {
    if (error instanceof LifecyclePersistenceError) {
      throw error;
    }
    throw new V2AccessError("TENDER_NOT_FOUND", "tender not found");
  }
  if (!record) {
    throw new V2AccessError("TENDER_NOT_FOUND", "tender not found");
  }
  if (record.tenderVersion !== tenderVersion) {
    throw new V2AccessError(
      "TENDER_VERSION_MISMATCH",
      "tenderVersion does not match the tender record",
    );
  }
  return record;
}

/**
 * The durable trust snapshot owns payTo. A server whose configured treasury
 * disagrees with the record is misconfigured and must not charge anyone.
 */
function assertTreasuryConsistent(
  record: LifecycleRecord,
  config: V2AccessConfig,
): void {
  if (record.trust.accessTreasuryAccountId !== config.accessTreasuryAccountId) {
    throw new V2AccessError(
      "ACCESS_NOT_CONFIGURED",
      "configured access treasury does not match the tender trust policy",
    );
  }
}

function assertBidEligible(input: {
  bid: ReturnType<typeof parseV2CarrierBid>;
  tender: V2FreightTender;
  record: LifecycleRecord;
  carriers: CarrierRegistry;
  now: string;
}): void {
  const { bid, tender, record, carriers, now } = input;

  const carrier = carriers.getById(bid.carrierId);
  if (!carrier || !carrier.active) {
    throw new V2AccessError(
      "BID_INELIGIBLE",
      "carrier is not registered or not active",
    );
  }
  if (carrier.carrierAccountId !== bid.carrierAccountId) {
    throw new V2AccessError(
      "BID_INELIGIBLE",
      "carrier account does not match the registry",
    );
  }
  if (!carrier.allowedEquipment.includes(bid.equipment)) {
    throw new V2AccessError(
      "BID_INELIGIBLE",
      "carrier is not authorized for the offered equipment",
    );
  }
  if (bid.equipment !== tender.requiredEquipment) {
    throw new V2AccessError(
      "BID_INELIGIBLE",
      "equipment does not match the tender requirement",
    );
  }
  if (!bid.capacityConfirmed) {
    throw new V2AccessError("BID_INELIGIBLE", "capacity is not confirmed");
  }
  if (!isBeforeOrEqualUtc(now, bid.bidValidUntil)) {
    throw new V2AccessError("BID_INELIGIBLE", "bid validity has expired");
  }
  if (
    !isBeforeOrEqualUtc(tender.pickupWindow.earliest, bid.proposedPickupAt) ||
    !isBeforeOrEqualUtc(bid.proposedPickupAt, tender.pickupWindow.latest)
  ) {
    throw new V2AccessError(
      "BID_INELIGIBLE",
      "proposed pickup is outside the tender pickup window",
    );
  }
  if (!isBeforeOrEqualUtc(bid.estimatedDelivery, tender.deliveryDeadline)) {
    throw new V2AccessError(
      "BID_INELIGIBLE",
      "estimated delivery misses the tender deadline",
    );
  }
  if (
    BigInt(bid.freightAmountAtomic) >
    BigInt(record.maximumFreightBudgetAtomic)
  ) {
    throw new V2AccessError(
      "BID_INELIGIBLE",
      "freight amount exceeds the maximum freight budget",
    );
  }
}

async function paymentRequiredResponse(
  c: HonoContext,
  deps: V2AccessRouteDeps,
  binding: AccessActionBinding,
): Promise<Response> {
  const paymentRequired = await deps.gate.paymentRequired(
    binding,
    "PAYMENT_REQUIRED",
  );
  c.header("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
  return c.json(
    {
      error: "PAYMENT_REQUIRED",
      message: "RouteGuard access fee required for this action",
      accessFee: {
        purpose:
          binding.actionType === "TENDER_ACTIVATE"
            ? "TENDER_ACTIVATION_ACCESS"
            : "BID_SUBMISSION_ACCESS",
        note: "Application access price — not the freight principal, escrow funding, or a payment to a carrier",
      },
      ...paymentRequired,
    },
    402,
  );
}

/**
 * Settle exactly once. A payload that already authorized an action for this
 * tender is refused before the facilitator is contacted.
 */
async function settleAccessPayment(
  deps: V2AccessRouteDeps,
  record: LifecycleRecord,
  rawPayment: string,
  binding: AccessActionBinding,
): Promise<SettledAccessPayment> {
  const payload = deps.gate.decodePayment(rawPayment);
  const settled = await deps.gate.verifyAndSettle({ payload, binding });
  if (
    record.accessPayments.some(
      (payment) =>
        payment.paymentTransactionId === settled.transactionId ||
        payment.paymentPayloadHash === settled.paymentPayloadHash,
    )
  ) {
    throw new V2AccessError(
      "PAYMENT_REPLAY",
      "this settlement has already authorized an access action",
    );
  }
  return settled;
}

function receiptView(record: LifecycleRecord, actionId: string | null) {
  const payment = actionId
    ? record.accessPayments.find((p) => p.actionId === actionId)
    : record.accessPayments[record.accessPayments.length - 1];
  if (!payment) return null;
  return {
    actionType: payment.accessActionType,
    asset: payment.asset,
    amountAtomic: payment.amountAtomic,
    payTo: payment.payTo,
    payerAccount: payment.payerAccount,
    resource: payment.resource,
    transactionId: payment.paymentTransactionId,
    settledAt: payment.settledAt,
    status: "PAID" as const,
  };
}

function activationView(record: LifecycleRecord, outcome: string) {
  const receipt = record.accessReceipt;
  return {
    outcome,
    tender: {
      tenderId: record.tenderId,
      tenderVersion: record.tenderVersion,
      state: record.state,
      recordVersion: record.recordVersion,
      auctionEndsAt: record.auctionEndsAt,
      maximumFreightBudgetAtomic: record.maximumFreightBudgetAtomic,
    },
    accessPayment: receipt
      ? {
          actionType: "TENDER_ACTIVATE" as const,
          asset: receipt.asset,
          amountAtomic: receipt.amountAtomic,
          payTo: receipt.payTo,
          payerAccount: receipt.payerAccount,
          resource: receipt.resource,
          transactionId: receipt.paymentTransactionId,
          settledAt: receipt.paidAt,
          status: "PAID" as const,
        }
      : null,
  };
}

function bidView(record: LifecycleRecord, bidId: string, outcome: string) {
  const entry = record.bidRegistry.find((b) => b.bidId === bidId);
  return {
    outcome,
    accepted: Boolean(entry),
    bidId,
    tender: {
      tenderId: record.tenderId,
      tenderVersion: record.tenderVersion,
      state: record.state,
      recordVersion: record.recordVersion,
    },
    // Public commitment only — never the freight amount, the salt, or the body.
    commitment: entry
      ? {
          bidHash: entry.bidHash,
          commitmentPayloadHash: entry.commitmentPayloadHash,
          carrierId: entry.carrierId,
          acceptedAt: entry.acceptedAt,
        }
      : null,
    accessPayment: entry ? receiptView(record, entry.actionId) : null,
  };
}

function handleError(
  c: HonoContext,
  error: unknown,
  deps: V2AccessRouteDeps,
): Response {
  if (error instanceof V2AccessError) {
    return c.json(
      { error: error.code, message: error.message },
      v2AccessErrorStatus(error.code) as 400,
    );
  }
  if (error instanceof AccessPaymentError) {
    return c.json(
      { error: error.code, message: error.message },
      v2AccessErrorStatus(error.code as never) as 400,
    );
  }
  if (error instanceof ZodError) {
    return c.json(
      { error: "BID_INVALID", message: "request body failed validation" },
      400,
    );
  }
  if (error instanceof LifecycleActionConflictError) {
    return c.json(
      {
        error: "ACTION_ID_CONFLICT",
        message: "actionId was already used with a different payload",
      },
      409,
    );
  }
  if (error instanceof LifecycleVersionConflictError) {
    return c.json(
      { error: "PERSISTENCE_CONFLICT", message: "concurrent update conflict" },
      409,
    );
  }
  if (error instanceof BidBodyConflictError) {
    return c.json(
      {
        error: "PERSISTENCE_CONFLICT",
        message: "a different bid body is already stored for this bid",
      },
      409,
    );
  }
  if (error instanceof LifecycleGuardError) {
    const code =
      error.code === "ACCESS_PAYMENT_REPLAY"
        ? "PAYMENT_REPLAY"
        : error.code === "AUCTION_CLOSED"
          ? "AUCTION_CLOSED"
          : error.code === "BID_ALREADY_ACCEPTED"
            ? "PERSISTENCE_CONFLICT"
            : "INVALID_LIFECYCLE_STATE";
    return c.json(
      { error: code, message: "lifecycle guard rejected the action" },
      v2AccessErrorStatus(code) as 400,
    );
  }
  if (error instanceof LifecyclePersistenceError) {
    deps.onInternalError?.({ code: error.code, message: "persistence failure" });
    return c.json(
      { error: "PERSISTENCE_CONFLICT", message: "durable state is unavailable" },
      409,
    );
  }
  deps.onInternalError?.({
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.name : "unknown",
  });
  // Never expose stack traces, payloads, signatures, or filesystem paths.
  return c.json({ error: "INTERNAL_ERROR" }, 500);
}
