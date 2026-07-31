/**
 * Public-safe POD package metadata — ciphertext off-chain; no plaintext/PII.
 */

import { z } from "zod";

import {
  assertNoProhibitedPiiFields,
  BoundedId,
  PositiveSafeIntSchema,
  Sha256HashSchema,
  UtcTimestampSchema,
} from "./common";

export const PodEncryptionSchema = z
  .object({
    alg: z.literal("AES-256-GCM"),
    keyId: z.string().min(1).max(128),
    iv: z.string().min(1).max(128),
    aadBinding: Sha256HashSchema,
  })
  .strict();

export const PodPublicManifestSchema = z
  .object({
    documentCount: PositiveSafeIntSchema,
    totalBytes: PositiveSafeIntSchema,
    mimeTypes: z.array(z.string().min(1).max(128)).max(32).optional(),
  })
  .strict();

export const PodPackageMetaSchema = z
  .object({
    podId: BoundedId,
    tenderId: BoundedId,
    bidId: BoundedId,
    carrierId: BoundedId,
    ciphertextBlobRef: z.string().min(1).max(512),
    encryption: PodEncryptionSchema,
    contentHash: Sha256HashSchema,
    ciphertextHash: Sha256HashSchema,
    manifest: PodPublicManifestSchema,
    submittedAt: UtcTimestampSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      assertNoProhibitedPiiFields(value as unknown as Record<string, unknown>);
      assertNoProhibitedPiiFields(
        value.encryption as unknown as Record<string, unknown>,
        "encryption.",
      );
      assertNoProhibitedPiiFields(
        value.manifest as unknown as Record<string, unknown>,
        "manifest.",
      );
    } catch (error: unknown) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          error instanceof Error ? error.message : "Prohibited PII field",
      });
    }
  });

export type PodPackageMeta = z.infer<typeof PodPackageMetaSchema>;

export function parsePodPackageMeta(input: unknown): PodPackageMeta {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    assertNoProhibitedPiiFields(input as Record<string, unknown>);
  }
  return PodPackageMetaSchema.parse(input);
}
