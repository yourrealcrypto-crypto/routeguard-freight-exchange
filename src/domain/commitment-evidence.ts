import { z } from "zod";

import { assertSha256Hash } from "./canonical-hash";
import { isSafePositiveInteger } from "./money";
import { isBeforeOrEqualUtc, isUtcIsoTimestamp } from "./time";

/**
 * Reconciled HCS commitment input — no network calls.
 * Authoritative timeliness (nanosecond compare):
 *   consensusTimestamp <= auctionEndsAt → timely
 */
export const CommitmentEvidenceSchema = z
  .object({
    tenderId: z.string().min(1).max(128),
    bidId: z.string().min(1).max(128),
    carrierId: z.string().min(1).max(128),
    bidHash: z.string().min(1),
    acceptanceReceiptHash: z.string().min(1),
    bidVersion: z.number(),
    /** Positive safe integer; minimum 1 (0 rejected). */
    hcsSequence: z.number(),
    consensusTimestamp: z.string(),
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
    try {
      assertSha256Hash(value.acceptanceReceiptHash);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "acceptanceReceiptHash must be sha256:<64 lowercase hex>",
        path: ["acceptanceReceiptHash"],
      });
    }
    if (!isSafePositiveInteger(value.bidVersion)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "bidVersion must be a positive safe integer",
        path: ["bidVersion"],
      });
    }
    if (!isSafePositiveInteger(value.hcsSequence)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "hcsSequence must be a positive safe integer (minimum 1)",
        path: ["hcsSequence"],
      });
    }
    if (!isUtcIsoTimestamp(value.consensusTimestamp)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "consensusTimestamp must be a valid UTC ISO-8601 timestamp",
        path: ["consensusTimestamp"],
      });
    }
  });

export type CommitmentEvidence = z.infer<typeof CommitmentEvidenceSchema>;

export function parseCommitmentEvidence(input: unknown): CommitmentEvidence {
  return CommitmentEvidenceSchema.parse(input);
}

/** Equality at the deadline is timely (epoch-nanosecond compare). */
export function isCommitmentTimely(
  consensusTimestamp: string,
  auctionEndsAt: string,
): boolean {
  return isBeforeOrEqualUtc(consensusTimestamp, auctionEndsAt);
}

export function withTimelyFlag(
  evidence: CommitmentEvidence,
  auctionEndsAt: string,
): CommitmentEvidence & { timely: boolean } {
  const validated = parseCommitmentEvidence(evidence);
  return {
    ...validated,
    timely: isCommitmentTimely(validated.consensusTimestamp, auctionEndsAt),
  };
}
