/**
 * Deterministic HCS 2.0 outbox builders for the v2 access gates.
 *
 * Phase B1 builds and validates public evidence envelopes **offline**; nothing
 * here submits to a topic, opens a network connection, or signs a transaction.
 * Envelopes are rebuildable from durable lifecycle state alone, so no envelope
 * body needs to be stored beside the record: only the canonical payload hash is
 * committed with the transition.
 */

import { canonicalSha256 } from "../../domain/canonical-hash";
import { buildHcsV2Envelope } from "../../hcs/v2/envelope";
import type { HcsV2Envelope } from "../../hcs/v2/types";
import type { LifecycleBidEntry, LifecycleRecord } from "../lifecycle/record";

export const SELECTION_POLICY = "LOWEST_QUALIFIED_PRICE_V1" as const;

/**
 * Canonical hash of the BID_COMMITMENT payload for a bid.
 * Computed before the lifecycle commit so the committed entry binds the exact
 * public evidence that Phase B2 will submit.
 */
export function bidCommitmentPayloadHash(input: {
  bidId: string;
  carrierId: string;
  bidHash: string;
  accessPaymentTxId: string;
}): string {
  return canonicalSha256({
    bidId: input.bidId,
    carrierId: input.carrierId,
    bidHash: input.bidHash,
    accessPaymentTxId: input.accessPaymentTxId,
  });
}

/**
 * TENDER_OPENED public evidence for an activated tender.
 * Validated and size-checked; never submitted in Phase B1.
 */
export function buildTenderOpenedEnvelope(
  record: LifecycleRecord,
): HcsV2Envelope {
  if (!record.accessReceipt || !record.activationPaymentTxId) {
    throw new Error("tender is not activated");
  }
  return buildHcsV2Envelope({
    messageType: "TENDER_OPENED",
    tenderId: record.tenderId,
    tenderVersion: record.tenderVersion,
    tenderHash: record.tenderHash,
    createdAt: record.accessReceipt.paidAt,
    payload: {
      accessPaymentTxId: record.activationPaymentTxId,
      maxBudgetAtomic: record.maximumFreightBudgetAtomic,
      auctionEndsAt: record.auctionEndsAt,
      selectionPolicy: SELECTION_POLICY,
    },
  });
}

/**
 * BID_COMMITMENT public evidence for a durably accepted bid.
 * Publishes the salted commitment only — never the freight amount or the salt.
 */
export function buildBidCommitmentEnvelope(
  record: LifecycleRecord,
  entry: LifecycleBidEntry,
): HcsV2Envelope {
  const envelope = buildHcsV2Envelope({
    messageType: "BID_COMMITMENT",
    tenderId: record.tenderId,
    tenderVersion: record.tenderVersion,
    tenderHash: record.tenderHash,
    createdAt: entry.acceptedAt,
    payload: {
      bidId: entry.bidId,
      carrierId: entry.carrierId,
      bidHash: entry.bidHash,
      accessPaymentTxId: entry.accessPaymentTxId,
    },
  });
  if (envelope.payloadHash !== entry.commitmentPayloadHash) {
    throw new Error("bid commitment payload hash does not match durable entry");
  }
  return envelope;
}

/** All pending (unsubmitted) commitment envelopes for a tender. */
export function pendingBidCommitmentEnvelopes(
  record: LifecycleRecord,
): HcsV2Envelope[] {
  return record.bidRegistry.map((entry) =>
    buildBidCommitmentEnvelope(record, entry),
  );
}
