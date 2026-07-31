/**
 * Shipper POD review actions: accept, request correction, or open dispute.
 */

import { z } from "zod";

import {
  BoundedId,
  BoundedString,
  UtcTimestampSchema,
} from "./common";

export const ShipperReviewAction = z.enum([
  "ACCEPT",
  "REQUEST_CORRECTION",
  "REJECT_DISPUTE",
]);

export const StructuredReasonSchema = z
  .object({
    code: z.string().min(1).max(64),
    message: BoundedString,
  })
  .strict();

export const ShipperReviewSchema = z
  .object({
    action: ShipperReviewAction,
    tenderId: BoundedId,
    podId: BoundedId,
    shipperId: BoundedId,
    reasons: z.array(StructuredReasonSchema).max(32).optional(),
    shipperSignature: z
      .string()
      .regex(/^[0-9a-fA-F]{128}$/, "shipperSignature must be 128 hex chars"),
    signedAt: UtcTimestampSchema,
    reviewDeadlineAt: UtcTimestampSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.action === "REQUEST_CORRECTION" ||
      value.action === "REJECT_DISPUTE"
    ) {
      if (!value.reasons || value.reasons.length < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "structured reasons are required for REQUEST_CORRECTION and REJECT_DISPUTE",
          path: ["reasons"],
        });
      }
    }
  });

export type ShipperReview = z.infer<typeof ShipperReviewSchema>;

export function parseShipperReview(input: unknown): ShipperReview {
  return ShipperReviewSchema.parse(input);
}
