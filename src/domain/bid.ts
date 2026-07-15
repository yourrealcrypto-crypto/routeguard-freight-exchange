import { z } from "zod";

import { canonicalSha256 } from "./canonical-hash";
import { isSafePositiveInteger } from "./money";
import {
  isValidHederaAccountId,
  parsePaymentOptionSet,
  type PaymentOption,
} from "./payment-option";
import { signCanonicalPayload, verifyCanonicalPayload } from "./signature";
import { isUtcIsoTimestamp } from "./time";

/**
 * commitmentSalt must be exactly 32 bytes encoded as 64 lowercase hex chars.
 * Encoding and length are validated; real entropy of generation is NOT proven.
 */
const COMMITMENT_SALT_RE = /^[0-9a-f]{64}$/;

export const CarrierBidSchema = z
  .object({
    bidId: z.string().min(1).max(128),
    tenderId: z.string().min(1).max(128),
    carrierId: z.string().min(1).max(128),
    carrierAccountId: z.string().min(1).max(64),
    freightPriceCents: z.number(),
    equipment: z.string().min(1).max(128),
    proposedPickupAt: z.string(),
    estimatedDelivery: z.string(),
    capacityConfirmed: z.boolean(),
    bidValidUntil: z.string(),
    reservationPaymentOptions: z.array(z.unknown()).min(1),
    /**
     * 32-byte salt as 64 lowercase hex characters.
     * Validates size/encoding only — does not prove entropy of generation.
     */
    commitmentSalt: z.string().min(1),
    nonce: z.string().min(1).max(128),
    version: z.number(),
  })
  .superRefine((value, ctx) => {
    if (!isValidHederaAccountId(value.carrierAccountId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "carrierAccountId must be a valid Hedera account ID",
        path: ["carrierAccountId"],
      });
    }

    if (!isSafePositiveInteger(value.freightPriceCents)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "freightPriceCents must be a positive safe integer",
        path: ["freightPriceCents"],
      });
    }

    if (!isSafePositiveInteger(value.version)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "version must be a positive safe integer",
        path: ["version"],
      });
    }

    for (const [field, ts] of [
      ["proposedPickupAt", value.proposedPickupAt],
      ["estimatedDelivery", value.estimatedDelivery],
      ["bidValidUntil", value.bidValidUntil],
    ] as const) {
      if (!isUtcIsoTimestamp(ts)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} must be a valid UTC ISO-8601 timestamp`,
          path: [field],
        });
      }
    }

    if (!COMMITMENT_SALT_RE.test(value.commitmentSalt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "commitmentSalt must be exactly 32 bytes as 64 lowercase hex characters (encoding/size only; entropy not proven)",
        path: ["commitmentSalt"],
      });
    }

    try {
      parsePaymentOptionSet(value.reservationPaymentOptions);
    } catch (error: unknown) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          error instanceof Error
            ? error.message
            : "Invalid reservationPaymentOptions",
        path: ["reservationPaymentOptions"],
      });
    }
  })
  .transform((value) => {
    const reservationPaymentOptions = parsePaymentOptionSet(
      value.reservationPaymentOptions,
    );
    return {
      ...value,
      reservationPaymentOptions,
    };
  });

export type CarrierBid = {
  bidId: string;
  tenderId: string;
  carrierId: string;
  carrierAccountId: string;
  freightPriceCents: number;
  equipment: string;
  proposedPickupAt: string;
  estimatedDelivery: string;
  capacityConfirmed: boolean;
  bidValidUntil: string;
  reservationPaymentOptions: PaymentOption[];
  commitmentSalt: string;
  nonce: string;
  version: number;
};

export type SignedCarrierBid = {
  bid: CarrierBid;
  /** Hex-encoded 64-byte ECDSA r||s over UTF-8(canonicalize(bid)). */
  signature: string;
};

export function parseCarrierBid(input: unknown): CarrierBid {
  return CarrierBidSchema.parse(input) as CarrierBid;
}

export function bidHash(bid: CarrierBid): string {
  const validated = parseCarrierBid(bid);
  return canonicalSha256(validated);
}

/** Hash of the full signed envelope (bid + signature), for evidence binding. */
export function signedBidEnvelopeHash(signed: SignedCarrierBid): string {
  const bid = parseCarrierBid(signed.bid);
  return canonicalSha256({
    bid,
    signature: signed.signature,
  });
}

export function signCarrierBid(
  bid: CarrierBid,
  privateKeyHex: string,
): SignedCarrierBid {
  const validated = parseCarrierBid(bid);
  const signature = signCanonicalPayload(validated, privateKeyHex);
  return { bid: validated, signature };
}

/**
 * Verify using the **registered** carrier public key only.
 * Never trust a public key supplied inside the bid.
 */
export function verifyCarrierBidSignature(
  signed: SignedCarrierBid,
  registeredPublicKeyHex: string,
): boolean {
  try {
    const validated = parseCarrierBid(signed.bid);
    return verifyCanonicalPayload(
      validated,
      signed.signature,
      registeredPublicKeyHex,
    );
  } catch {
    return false;
  }
}
