/**
 * RouteGuard v2 tender schema — freight budget authoritative in atomic USDC.
 */

import { z } from "zod";

import { SELECTION_POLICY_V1 } from "../../domain/tender";
import {
  isBeforeOrEqualUtc,
  isBeforeUtc,
  isUtcIsoTimestamp,
} from "../../domain/time";
import { centsToUsdcAtomic } from "../access/fee";
import {
  BoundedId,
  BoundedString,
  HederaAccountIdSchema,
  NonNegativeAtomicSchema,
  PositiveAtomicSchema,
  PositiveSafeIntSchema,
  UtcTimestampSchema,
} from "./common";

/** Default shipper review window: 48 hours. */
export const DEFAULT_REVIEW_WINDOW_SECONDS = 172_800 as const;

/** Default correction window: 24 hours. */
export const DEFAULT_CORRECTION_WINDOW_SECONDS = 86_400 as const;

/** Default post-resubmit review window: 24 hours. */
export const DEFAULT_POST_RESUBMIT_REVIEW_WINDOW_SECONDS = 86_400 as const;

export const V2FreightTenderSchema = z
  .object({
    tenderId: BoundedId,
    shipperId: BoundedId,
    origin: BoundedString,
    destination: BoundedString,
    cargo: z.object({
      type: z.string().min(1).max(128),
      weightKg: PositiveSafeIntSchema,
      pallets: PositiveSafeIntSchema,
      dangerousGoods: z.boolean(),
    }),
    requiredEquipment: z.string().min(1).max(128),
    pickupWindow: z.object({
      earliest: UtcTimestampSchema,
      latest: UtcTimestampSchema,
    }),
    deliveryDeadline: UtcTimestampSchema,
    auctionEndsAt: UtcTimestampSchema,
    /**
     * Authoritative maximum freight budget in USDC atomic units
     * (non-negative integer string).
     */
    maximumFreightBudgetAtomic: PositiveAtomicSchema,
    /**
     * Legacy / display-only USD cents. Not authoritative for escrow.
     * When present, must convert exactly to maximumFreightBudgetAtomic.
     */
    freightPriceCentsLegacy: z.number().int().positive().optional(),
    selectionPolicy: z.literal(SELECTION_POLICY_V1),
    version: PositiveSafeIntSchema,
    reviewWindowSeconds: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_REVIEW_WINDOW_SECONDS),
    correctionWindowSeconds: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_CORRECTION_WINDOW_SECONDS),
    postResubmitReviewWindowSeconds: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_POST_RESUBMIT_REVIEW_WINDOW_SECONDS),
    escrowContractId: z.string().min(1).max(64).nullable().optional(),
    shipperAccountId: HederaAccountIdSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
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
      !isBeforeOrEqualUtc(
        value.pickupWindow.latest,
        value.deliveryDeadline,
      )
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

    if (value.freightPriceCentsLegacy !== undefined) {
      try {
        const derived = centsToUsdcAtomic(value.freightPriceCentsLegacy);
        if (derived !== value.maximumFreightBudgetAtomic) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "freightPriceCentsLegacy must convert exactly to maximumFreightBudgetAtomic",
            path: ["freightPriceCentsLegacy"],
          });
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "freightPriceCentsLegacy is not a valid cents value",
          path: ["freightPriceCentsLegacy"],
        });
      }
    }

    // Reject accidental float-like pollution if someone bypasses types at runtime.
    for (const [field, raw] of [
      ["reviewWindowSeconds", value.reviewWindowSeconds],
      ["correctionWindowSeconds", value.correctionWindowSeconds],
      ["postResubmitReviewWindowSeconds", value.postResubmitReviewWindowSeconds],
    ] as const) {
      if (typeof raw === "number" && !Number.isInteger(raw)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} must be an integer (no floats)`,
          path: [field],
        });
      }
    }

    void NonNegativeAtomicSchema; // re-export path for tests via positive budget
  });

export type V2FreightTender = z.infer<typeof V2FreightTenderSchema>;

export function parseV2FreightTender(input: unknown): V2FreightTender {
  return V2FreightTenderSchema.parse(input);
}
