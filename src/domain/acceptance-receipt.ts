import { z } from "zod";

import { assertSha256Hash, canonicalSha256 } from "./canonical-hash";
import { isSafePositiveInteger } from "./money";
import { signCanonicalPayload, verifyCanonicalPayload } from "./signature";
import { isUtcIsoTimestamp } from "./time";

export const AcceptanceReceiptBodySchema = z
  .object({
    receiptId: z.string().min(1).max(128),
    tenderId: z.string().min(1).max(128),
    bidId: z.string().min(1).max(128),
    bidHash: z.string().min(1),
    acceptedAt: z.string(),
    version: z.number(),
  })
  .superRefine((value, ctx) => {
    try {
      assertSha256Hash(value.bidHash);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "bidHash must be sha256:<64 lowercase hex>",
        path: ["bidHash"],
      });
    }
    if (!isUtcIsoTimestamp(value.acceptedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "acceptedAt must be a valid UTC ISO-8601 timestamp",
        path: ["acceptedAt"],
      });
    }
    if (!isSafePositiveInteger(value.version)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "version must be a positive safe integer",
        path: ["version"],
      });
    }
  });

export type AcceptanceReceiptBody = z.infer<typeof AcceptanceReceiptBodySchema>;

export type SignedAcceptanceReceipt = {
  receipt: AcceptanceReceiptBody;
  signature: string;
};

export function parseAcceptanceReceiptBody(
  input: unknown,
): AcceptanceReceiptBody {
  return AcceptanceReceiptBodySchema.parse(input);
}

export function acceptanceReceiptHash(receipt: AcceptanceReceiptBody): string {
  const validated = parseAcceptanceReceiptBody(receipt);
  return canonicalSha256(validated);
}

export function signedReceiptEnvelopeHash(
  signed: SignedAcceptanceReceipt,
): string {
  const receipt = parseAcceptanceReceiptBody(signed.receipt);
  return canonicalSha256({
    receipt,
    signature: signed.signature,
  });
}

export function signAcceptanceReceipt(
  receipt: AcceptanceReceiptBody,
  routeGuardPrivateKeyHex: string,
): SignedAcceptanceReceipt {
  const validated = parseAcceptanceReceiptBody(receipt);
  return {
    receipt: validated,
    signature: signCanonicalPayload(validated, routeGuardPrivateKeyHex),
  };
}

export function verifyAcceptanceReceiptSignature(
  signed: SignedAcceptanceReceipt,
  routeGuardPublicKeyHex: string,
): boolean {
  try {
    const validated = parseAcceptanceReceiptBody(signed.receipt);
    return verifyCanonicalPayload(
      validated,
      signed.signature,
      routeGuardPublicKeyHex,
    );
  } catch {
    return false;
  }
}

export function receiptMatchesBid(
  receipt: AcceptanceReceiptBody,
  bidId: string,
  tenderId: string,
  expectedBidHash: string,
): boolean {
  return (
    receipt.bidId === bidId &&
    receipt.tenderId === tenderId &&
    receipt.bidHash === expectedBidHash
  );
}
