/**
 * Strict POD file policy — MIME allowlist and size budgets.
 * MIME validation is not a malware scan; a scanning boundary is provided for
 * production integration.
 */

import { PodError } from "./errors";

export const POD_MAX_FILES = 10 as const;
export const POD_MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
export const POD_MAX_PACKAGE_BYTES = 25 * 1024 * 1024; // 25 MB

export const POD_ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "application/json",
] as const;

export type PodAllowedMime = (typeof POD_ALLOWED_MIME_TYPES)[number];

export type PodFilePolicy = {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxPackageBytes: number;
  readonly allowedMimeTypes: readonly string[];
};

export const DEFAULT_POD_FILE_POLICY: PodFilePolicy = Object.freeze({
  maxFiles: POD_MAX_FILES,
  maxFileBytes: POD_MAX_FILE_BYTES,
  maxPackageBytes: POD_MAX_PACKAGE_BYTES,
  allowedMimeTypes: POD_ALLOWED_MIME_TYPES,
});

/** Production scanning boundary — Phase D1 uses a deterministic safe stub. */
export interface PodContentScanner {
  scan(input: {
    readonly fileId: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
}

/** Deterministic stub: accepts policy-passing files; rejects empty/suspicious headers. */
export class DeterministicSafePodScanner implements PodContentScanner {
  async scan(input: {
    readonly fileId: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
    if (input.bytes.length === 0) {
      return { ok: false, reason: "empty file" };
    }
    // Reject obvious executable PE/ELF headers.
    if (
      (input.bytes[0] === 0x4d && input.bytes[1] === 0x5a) || // MZ
      (input.bytes[0] === 0x7f &&
        input.bytes[1] === 0x45 &&
        input.bytes[2] === 0x4c &&
        input.bytes[3] === 0x46) // ELF
    ) {
      return { ok: false, reason: "executable content" };
    }
    if (input.mimeType === "application/pdf") {
      const head = Buffer.from(input.bytes.subarray(0, 5)).toString("ascii");
      if (!head.startsWith("%PDF-")) {
        return { ok: false, reason: "pdf magic mismatch" };
      }
    }
    if (input.mimeType === "image/png") {
      const sig = [0x89, 0x50, 0x4e, 0x47];
      if (!sig.every((b, i) => input.bytes[i] === b)) {
        return { ok: false, reason: "png magic mismatch" };
      }
    }
    if (input.mimeType === "image/jpeg") {
      if (input.bytes[0] !== 0xff || input.bytes[1] !== 0xd8) {
        return { ok: false, reason: "jpeg magic mismatch" };
      }
    }
    if (input.mimeType === "application/json") {
      try {
        JSON.parse(Buffer.from(input.bytes).toString("utf8"));
      } catch {
        return { ok: false, reason: "invalid json" };
      }
    }
    return { ok: true };
  }
}

export function assertSafeFilename(name: string): string {
  if (typeof name !== "string" || name.length === 0 || name.length > 128) {
    throw new PodError("POD_INVALID", "filename length invalid");
  }
  if (name.includes("\0")) {
    throw new PodError("POD_INVALID", "filename contains null byte");
  }
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw new PodError("POD_INVALID", "path traversal filename rejected");
  }
  if (!/^[A-Za-z0-9._@+-]+$/.test(name)) {
    throw new PodError("POD_INVALID", "filename charset rejected");
  }
  return name;
}

export function assertMimeAllowed(
  mimeType: string,
  policy: PodFilePolicy = DEFAULT_POD_FILE_POLICY,
): void {
  if (!policy.allowedMimeTypes.includes(mimeType)) {
    throw new PodError("POD_FILE_TYPE_REJECTED", "MIME type not permitted");
  }
}
