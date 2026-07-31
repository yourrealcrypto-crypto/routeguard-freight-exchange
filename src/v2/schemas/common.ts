/**
 * Shared v2 schema helpers (hashes, atomic strings, account ids).
 */

import { z } from "zod";

import { assertSha256Hash } from "../../domain/canonical-hash";
import { isSafePositiveInteger } from "../../domain/money";
import { isValidHederaAccountId } from "../../domain/payment-option";
import { isUtcIsoTimestamp } from "../../domain/time";
import {
  isNonNegativeAtomicString,
  isPositiveAtomicString,
} from "../access/fee";

export const BoundedId = z.string().min(1).max(128);
export const BoundedString = z.string().min(1).max(256);

export const Sha256HashSchema = z
  .string()
  .min(1)
  .max(80)
  .superRefine((value, ctx) => {
    try {
      assertSha256Hash(value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must be sha256:<64 lowercase hex>",
      });
    }
  });

export const NonNegativeAtomicSchema = z
  .string()
  .superRefine((value, ctx) => {
    if (!isNonNegativeAtomicString(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "must be a non-negative integer string (atomic USDC units; no floats, signs, or exponents)",
      });
    }
  });

export const PositiveAtomicSchema = z
  .string()
  .superRefine((value, ctx) => {
    if (!isPositiveAtomicString(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "must be a positive integer string (atomic USDC units; no floats, signs, or exponents)",
      });
    }
  });

export const HederaAccountIdSchema = z
  .string()
  .min(1)
  .max(64)
  .superRefine((value, ctx) => {
    if (!isValidHederaAccountId(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must be a valid Hedera account id",
      });
    }
  });

export const UtcTimestampSchema = z.string().superRefine((value, ctx) => {
  if (!isUtcIsoTimestamp(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "must be a valid UTC ISO-8601 timestamp",
    });
  }
});

export const PositiveSafeIntSchema = z.number().superRefine((value, ctx) => {
  if (!isSafePositiveInteger(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "must be a positive safe integer",
    });
  }
});

/** HCS v2 schema identifier (public evidence only). */
export const HCS_V2_SCHEMA_VERSION = "routeguard-hcs-2.0" as const;

/**
 * Field names that must never appear on public POD / HCS-bound objects.
 * Used by privacy-boundary validation.
 */
export const PROHIBITED_PII_FIELD_NAMES = [
  "name",
  "names",
  "fullName",
  "postalAddress",
  "address",
  "phone",
  "phoneNumber",
  "signatureImage",
  "podImage",
  "podImages",
  "plateNumber",
  "licensePlate",
  "privateKey",
  "paymentPayload",
  "signedPaymentPayload",
  "disputeNarrative",
  "unrestrictedNarrative",
  "plaintext",
  "podPlaintext",
  "documentBytes",
] as const;

export function assertNoProhibitedPiiFields(
  value: Record<string, unknown>,
  pathPrefix = "",
): void {
  for (const key of Object.keys(value)) {
    const lower = key.toLowerCase();
    for (const banned of PROHIBITED_PII_FIELD_NAMES) {
      if (key === banned || lower === banned.toLowerCase()) {
        throw new Error(
          `Prohibited personal-data field "${pathPrefix}${key}" is not allowed`,
        );
      }
    }
  }
}
