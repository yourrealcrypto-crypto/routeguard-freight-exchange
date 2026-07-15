import { z } from "zod";

import { isPositiveIntegerString } from "./money";

/**
 * Strict Hedera entity ID: shard.realm.num with non-negative integers,
 * no leading-plus, no whitespace. Shared by payTo and carrier accounts.
 */
export const HEDERA_ACCOUNT_ID_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function isValidHederaAccountId(value: string): boolean {
  if (!HEDERA_ACCOUNT_ID_RE.test(value)) {
    return false;
  }
  // Bound component sizes to safe integer range.
  const parts = value.split(".").map((p) => Number(p));
  return parts.every(
    (n) => Number.isSafeInteger(n) && n >= 0,
  );
}

export const USDC_TESTNET_ASSET = "0.0.429274" as const;
export const HBAR_ASSET = "0.0.0" as const;

export const PaymentOptionIdSchema = z.enum(["USDC", "HBAR"]);
export type PaymentOptionId = z.infer<typeof PaymentOptionIdSchema>;

export const PaymentOptionSchema = z
  .object({
    optionId: PaymentOptionIdSchema,
    scheme: z.literal("exact"),
    network: z.literal("hedera:testnet"),
    asset: z.string().min(1),
    amountAtomic: z.string().min(1),
    payTo: z.string().min(1),
  })
  .superRefine((value, ctx) => {
    if (value.optionId === "USDC" && value.asset !== USDC_TESTNET_ASSET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `USDC asset must be ${USDC_TESTNET_ASSET}`,
        path: ["asset"],
      });
    }
    if (value.optionId === "HBAR" && value.asset !== HBAR_ASSET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `HBAR asset must be ${HBAR_ASSET}`,
        path: ["asset"],
      });
    }
    if (!isPositiveIntegerString(value.amountAtomic)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "amountAtomic must be a positive integer string",
        path: ["amountAtomic"],
      });
    }
    if (!isValidHederaAccountId(value.payTo)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "payTo must be a valid Hedera account ID",
        path: ["payTo"],
      });
    }
  });

export type PaymentOption = z.infer<typeof PaymentOptionSchema>;

export function parsePaymentOption(input: unknown): PaymentOption {
  return PaymentOptionSchema.parse(input);
}

export function parsePaymentOptionSet(input: unknown): PaymentOption[] {
  const arraySchema = z.array(PaymentOptionSchema).min(1);
  const options = arraySchema.parse(input);

  const optionIds = new Set<string>();
  const assets = new Set<string>();

  for (const option of options) {
    if (optionIds.has(option.optionId)) {
      throw new Error(`Duplicate payment optionId: ${option.optionId}`);
    }
    if (assets.has(option.asset)) {
      throw new Error(`Duplicate payment asset offer: ${option.asset}`);
    }
    optionIds.add(option.optionId);
    assets.add(option.asset);
  }

  return options;
}

export function assertPaymentRecipientsMatch(
  options: PaymentOption[],
  carrierAccountId: string,
): boolean {
  return options.every((option) => option.payTo === carrierAccountId);
}
