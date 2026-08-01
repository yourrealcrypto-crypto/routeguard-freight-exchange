/**
 * AI POD Assurance Adviser report — explicitly non-binding.
 * Must never carry release/refund authorization fields.
 */

import { z } from "zod";

import {
  BoundedId,
  BoundedString,
  Sha256HashSchema,
  UtcTimestampSchema,
} from "./common";

export const ADVISORY_BINDING = "NON_BINDING_ADVISORY" as const;

export const AdvisoryFindingSeverity = z.enum(["INFO", "WARN", "FAIL"]);

export const AdvisoryFindingCode = z.enum([
  "MISSING_SIGNATURE",
  "INCONSISTENT_DATES",
  "DUPLICATE",
  "ANOMALY",
  "COMPLETE",
  "INCOMPLETE",
  "OTHER",
]);

export const AdvisoryFindingSchema = z
  .object({
    code: AdvisoryFindingCode,
    severity: AdvisoryFindingSeverity,
    message: BoundedString,
  })
  .strict();

/**
 * Forbidden keys that would imply AI can authorize fund movement.
 * Validated fail-closed if present on input objects.
 */
export const ADVISORY_FORBIDDEN_AUTHORIZATION_KEYS = [
  "releaseAuthorization",
  "refundAuthorization",
  "authorizeRelease",
  "authorizeRefund",
  "canRelease",
  "canRefund",
  "releaseFunds",
  "refundFunds",
  "escrowRelease",
  "escrowRefund",
  "paymentAuthorization",
  "fundRelease",
] as const;

function rejectAuthorizationFields(
  value: Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  for (const key of Object.keys(value)) {
    for (const banned of ADVISORY_FORBIDDEN_AUTHORIZATION_KEYS) {
      if (key === banned) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Advisory report must not contain authorization field "${key}"`,
          path: [key],
        });
      }
    }
  }
}

export const AdvisoryReportSchema = z
  .object({
    reportId: BoundedId,
    podId: BoundedId,
    tenderId: BoundedId,
    engine: z.string().min(1).max(256),
    findings: z.array(AdvisoryFindingSchema).max(64),
    completenessScore: z.number().int().min(0).max(100).nullable().optional(),
    reportHash: Sha256HashSchema,
    createdAt: UtcTimestampSchema,
    binding: z.literal(ADVISORY_BINDING),
  })
  .strict()
  .superRefine((value, ctx) => {
    rejectAuthorizationFields(
      value as unknown as Record<string, unknown>,
      ctx,
    );
  });

export type AdvisoryReport = z.infer<typeof AdvisoryReportSchema>;

export function parseAdvisoryReport(input: unknown): AdvisoryReport {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    for (const banned of ADVISORY_FORBIDDEN_AUTHORIZATION_KEYS) {
      if (banned in record) {
        throw new Error(
          `Advisory report must not contain authorization field "${banned}"`,
        );
      }
    }
  }
  return AdvisoryReportSchema.parse(input);
}
