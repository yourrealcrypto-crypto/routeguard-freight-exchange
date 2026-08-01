/**
 * RouteGuard v2 carrier bid — freight amount authoritative in atomic USDC.
 *
 * The bid body is private: it carries the commitment salt and the freight price
 * and must never appear in public evidence or an HTTP response. Only the salted
 * bid hash (the commitment) is public.
 */

import { z } from "zod";

import { canonicalSha256 } from "../../domain/canonical-hash";
import { isUtcIsoTimestamp } from "../../domain/time";
import {
  BoundedId,
  HederaAccountIdSchema,
  PositiveAtomicSchema,
  PositiveSafeIntSchema,
  UtcTimestampSchema,
} from "./common";

/**
 * 32-byte commitment salt as 64 lowercase hex characters.
 * Encoding and length are validated; entropy of generation is not proven.
 */
export const COMMITMENT_SALT_RE = /^[0-9a-f]{64}$/;

export const V2CarrierBidSchema = z
  .object({
    bidId: BoundedId,
    tenderId: BoundedId,
    tenderVersion: PositiveSafeIntSchema,
    carrierId: BoundedId,
    carrierAccountId: HederaAccountIdSchema,
    /** Authoritative freight offer in USDC atomic units. */
    freightAmountAtomic: PositiveAtomicSchema,
    equipment: z.string().min(1).max(128),
    proposedPickupAt: UtcTimestampSchema,
    estimatedDelivery: UtcTimestampSchema,
    capacityConfirmed: z.boolean(),
    bidValidUntil: UtcTimestampSchema,
    /** Private commitment salt — never published, never returned. */
    commitmentSalt: z.string(),
    nonce: z.string().min(1).max(128),
    version: PositiveSafeIntSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!COMMITMENT_SALT_RE.test(value.commitmentSalt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "commitmentSalt must be exactly 32 bytes as 64 lowercase hex characters",
        path: ["commitmentSalt"],
      });
    }
    if (
      isUtcIsoTimestamp(value.proposedPickupAt) &&
      isUtcIsoTimestamp(value.estimatedDelivery) &&
      value.estimatedDelivery < value.proposedPickupAt
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "estimatedDelivery must not precede proposedPickupAt",
        path: ["estimatedDelivery"],
      });
    }
  });

export type V2CarrierBid = z.infer<typeof V2CarrierBidSchema>;

export type SignedV2CarrierBid = {
  readonly bid: V2CarrierBid;
  /** Hex-encoded 64-byte ECDSA r||s over UTF-8(canonicalize(bid)). */
  readonly signature: string;
};

export function parseV2CarrierBid(input: unknown): V2CarrierBid {
  return V2CarrierBidSchema.parse(input);
}

/**
 * Salted commitment hash of the complete private bid.
 * Public evidence only ever carries this value, never the bid body.
 */
export function v2BidHash(bid: V2CarrierBid): string {
  return canonicalSha256(parseV2CarrierBid(bid));
}

/** Hash of the signed envelope (bid + signature) for durable evidence binding. */
export function signedV2BidEnvelopeHash(signed: SignedV2CarrierBid): string {
  return canonicalSha256({
    bid: parseV2CarrierBid(signed.bid),
    signature: signed.signature,
  });
}

/** Public-safe projection of an accepted bid (no salt, no freight price). */
export function publicV2BidSummary(bid: V2CarrierBid): {
  bidId: string;
  carrierId: string;
  tenderId: string;
  tenderVersion: number;
} {
  return {
    bidId: bid.bidId,
    carrierId: bid.carrierId,
    tenderId: bid.tenderId,
    tenderVersion: bid.tenderVersion,
  };
}
