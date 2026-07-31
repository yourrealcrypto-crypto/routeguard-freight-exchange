/**
 * Human referee resolution — single allowlisted key model in Phase A1.
 * No AI signer. Multisig / on-chain verify is future work (documented only).
 */

import { z } from "zod";

import {
  BoundedId,
  NonNegativeAtomicSchema,
  Sha256HashSchema,
  UtcTimestampSchema,
} from "./common";

export const RefereeResolutionOutcome = z.enum([
  "RELEASE_FULL",
  "REFUND_FULL",
  "PARTIAL",
]);

export const RefereeResolutionSchema = z
  .object({
    disputeId: BoundedId,
    tenderId: BoundedId,
    podId: BoundedId,
    resolution: RefereeResolutionOutcome,
    releaseAmountAtomic: NonNegativeAtomicSchema,
    refundAmountAtomic: NonNegativeAtomicSchema,
    rationaleCode: z.string().min(1).max(64),
    refereeId: BoundedId,
    /** Allowlisted referee public key (hex). Not an AI model id. */
    refereePublicKey: z.string().min(1).max(256),
    signature: z
      .string()
      .regex(/^[0-9a-fA-F]{128}$/, "signature must be 128 hex chars"),
    signedPayloadHash: Sha256HashSchema,
    decidedAt: UtcTimestampSchema,
    /** Explicit marker: human-only; AI must not sign resolutions. */
    signerKind: z.literal("HUMAN_REFEREE"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ("aiSigner" in (value as object)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "AI signer is not permitted on referee resolutions",
      });
    }

    if (value.resolution === "RELEASE_FULL") {
      if (value.refundAmountAtomic !== "0") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "RELEASE_FULL requires refundAmountAtomic of 0",
          path: ["refundAmountAtomic"],
        });
      }
    }

    if (value.resolution === "REFUND_FULL") {
      if (value.releaseAmountAtomic !== "0") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "REFUND_FULL requires releaseAmountAtomic of 0",
          path: ["releaseAmountAtomic"],
        });
      }
    }

    if (value.resolution === "PARTIAL") {
      if (
        value.releaseAmountAtomic === "0" &&
        value.refundAmountAtomic === "0"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "PARTIAL requires at least one positive release or refund amount",
          path: ["releaseAmountAtomic"],
        });
      }
    }
  });

export type RefereeResolution = z.infer<typeof RefereeResolutionSchema>;

export function parseRefereeResolution(input: unknown): RefereeResolution {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if ("aiSigner" in record || record.signerKind === "AI") {
      throw new Error("AI signer is not permitted on referee resolutions");
    }
  }
  return RefereeResolutionSchema.parse(input);
}
