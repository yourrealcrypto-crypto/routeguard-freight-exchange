import { z } from "zod";

import { canonicalSha256 } from "./canonical-hash";
import { isSafePositiveInteger } from "./money";
import {
  isBeforeOrEqualUtc,
  isBeforeUtc,
  isUtcIsoTimestamp,
} from "./time";

export const SELECTION_POLICY_V1 = "LOWEST_QUALIFIED_PRICE_V1" as const;

export const FreightTenderSchema = z
  .object({
    tenderId: z.string().min(1).max(128),
    shipperId: z.string().min(1).max(128),
    origin: z.string().min(1).max(256),
    destination: z.string().min(1).max(256),
    cargo: z.object({
      type: z.string().min(1).max(128),
      weightKg: z.number(),
      pallets: z.number(),
      dangerousGoods: z.boolean(),
    }),
    requiredEquipment: z.string().min(1).max(128),
    pickupWindow: z.object({
      earliest: z.string(),
      latest: z.string(),
    }),
    deliveryDeadline: z.string(),
    auctionEndsAt: z.string(),
    maximumFreightPriceCents: z.number(),
    selectionPolicy: z.literal(SELECTION_POLICY_V1),
    version: z.number(),
  })
  .superRefine((value, ctx) => {
    const timestamps: Array<[string, string]> = [
      ["pickupWindow.earliest", value.pickupWindow.earliest],
      ["pickupWindow.latest", value.pickupWindow.latest],
      ["deliveryDeadline", value.deliveryDeadline],
      ["auctionEndsAt", value.auctionEndsAt],
    ];

    for (const [path, ts] of timestamps) {
      if (!isUtcIsoTimestamp(ts)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid UTC ISO-8601 timestamp at ${path}`,
          path: path.split("."),
        });
      }
    }

    if (
      isUtcIsoTimestamp(value.pickupWindow.earliest) &&
      isUtcIsoTimestamp(value.pickupWindow.latest) &&
      !isBeforeOrEqualUtc(
        value.pickupWindow.earliest,
        value.pickupWindow.latest,
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "pickupWindow.earliest must be <= pickupWindow.latest",
        path: ["pickupWindow", "latest"],
      });
    }

    if (
      isUtcIsoTimestamp(value.pickupWindow.latest) &&
      isUtcIsoTimestamp(value.deliveryDeadline) &&
      !isBeforeOrEqualUtc(value.pickupWindow.latest, value.deliveryDeadline)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "pickupWindow.latest must not be after deliveryDeadline",
        path: ["deliveryDeadline"],
      });
    }

    if (
      isUtcIsoTimestamp(value.auctionEndsAt) &&
      isUtcIsoTimestamp(value.pickupWindow.earliest) &&
      !isBeforeUtc(value.auctionEndsAt, value.pickupWindow.earliest)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "auctionEndsAt must be before operational pickupWindow.earliest",
        path: ["auctionEndsAt"],
      });
    }

    if (!isSafePositiveInteger(value.maximumFreightPriceCents)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "maximumFreightPriceCents must be a positive safe integer (cents)",
        path: ["maximumFreightPriceCents"],
      });
    }

    if (!isSafePositiveInteger(value.version)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "version must be a positive safe integer",
        path: ["version"],
      });
    }

    if (!isSafePositiveInteger(value.cargo.weightKg)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "cargo.weightKg must be a positive safe integer",
        path: ["cargo", "weightKg"],
      });
    }

    if (!isSafePositiveInteger(value.cargo.pallets)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "cargo.pallets must be a positive safe integer",
        path: ["cargo", "pallets"],
      });
    }
  });

export type FreightTender = z.infer<typeof FreightTenderSchema>;

export function parseFreightTender(input: unknown): FreightTender {
  return FreightTenderSchema.parse(input);
}

export function tenderHash(tender: FreightTender): string {
  const validated = parseFreightTender(tender);
  return canonicalSha256(validated);
}
