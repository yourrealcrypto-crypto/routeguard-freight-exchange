/**
 * Durable x402 access-payment receipt for tender activation and bid submit.
 */

import { z } from "zod";

import {
  ACCESS_ACTION_TYPES,
  ACCESS_FEE_TOKEN_ID,
  assertAccessFeeAmountAtomic,
  assertAccessFeeAsset,
  deriveAccessFeeAtomic,
} from "../access/fee";
import {
  BoundedId,
  HederaAccountIdSchema,
  PositiveSafeIntSchema,
  Sha256HashSchema,
  UtcTimestampSchema,
} from "./common";

export const AccessReceiptStatus = z.literal("PAID");

export const AccessReceiptSchema = z
  .object({
    actionType: z.enum(ACCESS_ACTION_TYPES),
    actionId: BoundedId,
    tenderId: BoundedId,
    tenderVersion: PositiveSafeIntSchema,
    bidId: BoundedId.optional(),
    payerAccount: HederaAccountIdSchema,
    payTo: HederaAccountIdSchema,
    asset: z.string().min(1).max(64),
    amountAtomic: z.string().min(1).max(78),
    resource: z.string().min(1).max(512),
    paymentTransactionId: z.string().min(1).max(128),
    paymentConsensusTimestamp: UtcTimestampSchema,
    paymentPayloadHash: Sha256HashSchema,
    status: AccessReceiptStatus,
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      assertAccessFeeAsset(value.asset);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `asset must be ${ACCESS_FEE_TOKEN_ID}`,
        path: ["asset"],
      });
    }

    try {
      assertAccessFeeAmountAtomic(value.amountAtomic);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `amountAtomic must equal derived access fee ${deriveAccessFeeAtomic()}`,
        path: ["amountAtomic"],
      });
    }

    if (value.actionType === "BID_SUBMIT" && !value.bidId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "bidId is required for BID_SUBMIT",
        path: ["bidId"],
      });
    }

    if (value.actionType === "TENDER_ACTIVATE" && value.bidId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "bidId must not be set for TENDER_ACTIVATE",
        path: ["bidId"],
      });
    }
  });

export type AccessReceipt = z.infer<typeof AccessReceiptSchema>;

export function parseAccessReceipt(input: unknown): AccessReceipt {
  return AccessReceiptSchema.parse(input);
}
