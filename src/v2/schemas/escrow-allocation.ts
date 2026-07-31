/**
 * Escrow allocation after winner selection — strict amount conservation.
 */

import { z } from "zod";

import {
  BoundedId,
  HederaAccountIdSchema,
  NonNegativeAtomicSchema,
  PositiveAtomicSchema,
  PositiveSafeIntSchema,
  Sha256HashSchema,
  UtcTimestampSchema,
} from "./common";

export const EscrowAllocationSchema = z
  .object({
    tenderId: BoundedId,
    tenderVersion: PositiveSafeIntSchema,
    maxBudgetAtomic: PositiveAtomicSchema,
    winningAmountAtomic: PositiveAtomicSchema,
    excessRefundAtomic: NonNegativeAtomicSchema,
    winnerAccount: HederaAccountIdSchema,
    shipperAccount: HederaAccountIdSchema,
    decisionManifestHash: Sha256HashSchema,
    allocateTxId: z.string().min(1).max(128),
    refundExcessTxId: z.string().min(1).max(128).nullable(),
    allocatedAt: UtcTimestampSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      const max = BigInt(value.maxBudgetAtomic);
      const win = BigInt(value.winningAmountAtomic);
      const excess = BigInt(value.excessRefundAtomic);

      if (win + excess !== max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "conservation failed: winningAmountAtomic + excessRefundAtomic must equal maxBudgetAtomic",
          path: ["excessRefundAtomic"],
        });
      }

      if (win > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "winningAmountAtomic must not exceed maxBudgetAtomic",
          path: ["winningAmountAtomic"],
        });
      }

      if (excess === 0n && value.refundExcessTxId !== null) {
        // Allow null-only when no excess; if excess is 0, refund tx should be null.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "refundExcessTxId must be null when excessRefundAtomic is 0",
          path: ["refundExcessTxId"],
        });
      }

      if (excess > 0n && value.refundExcessTxId === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "refundExcessTxId is required when excessRefundAtomic is positive",
          path: ["refundExcessTxId"],
        });
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "atomic amount fields must be valid integer strings",
      });
    }
  });

export type EscrowAllocation = z.infer<typeof EscrowAllocationSchema>;

export function parseEscrowAllocation(input: unknown): EscrowAllocation {
  return EscrowAllocationSchema.parse(input);
}
