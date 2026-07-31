/**
 * POD Assurance Adviser — non-binding, never authorizes funds.
 *
 * Phase D1 ships a deterministic rules-based stub compatible with a future
 * model-backed implementation. It is not a live AI model.
 */

import { createHash } from "node:crypto";

import { canonicalSha256 } from "../../domain/canonical-hash";
import type {
  PodAdvisoryFinding,
  PodAdvisoryRecommendation,
  PodAdvisoryReport,
  PodCanonicalManifest,
  PodPackageFields,
} from "./types";

export const ADVISER_ENGINE_ID =
  "routeguard-deterministic-pod-assurance-v1" as const;

export type PodAssuranceAdviserInput = {
  readonly fields: PodPackageFields;
  readonly manifest: PodCanonicalManifest;
  readonly requiredDocumentTypes?: readonly string[];
  readonly expectedTenderId: string;
  readonly expectedTenderVersion: number;
  readonly expectedWinningBidId: string;
  readonly expectedEscrowTenderKey: string;
  readonly deliveryDeadlineAt?: string;
  readonly createdAt: string;
  readonly reportId: string;
};

export interface PodAssuranceAdviser {
  advise(input: PodAssuranceAdviserInput): Promise<PodAdvisoryReport>;
}

function reportHashOf(
  body: Omit<PodAdvisoryReport, "reportHash">,
): string {
  return canonicalSha256(body);
}

/**
 * Deterministic POD assurance adviser stub.
 * Identical inputs always produce identical outputs (including report hash).
 */
export class DeterministicPodAssuranceAdviser implements PodAssuranceAdviser {
  async advise(input: PodAssuranceAdviserInput): Promise<PodAdvisoryReport> {
    const findings: PodAdvisoryFinding[] = [];
    const required = input.requiredDocumentTypes ?? [
      "ELECTRONIC_DELIVERY_RECEIPT",
      "RECIPIENT_CONFIRMATION",
    ];

    const presentTypes = new Set(
      input.manifest.entries.map((e) => e.documentType),
    );
    for (const req of required) {
      if (!presentTypes.has(req as never)) {
        findings.push({
          code: "INCOMPLETE",
          severity: "FAIL",
          message: `required document type missing: ${req}`,
          evidenceRef: `doc:${req}`,
        });
      }
    }

    if (input.fields.tenderId !== input.expectedTenderId) {
      findings.push({
        code: "INCONSISTENT_IDENTIFIER",
        severity: "FAIL",
        message: "tenderId does not match expected tender",
        evidenceRef: "field:tenderId",
      });
    }
    if (input.fields.tenderVersion !== input.expectedTenderVersion) {
      findings.push({
        code: "INCONSISTENT_IDENTIFIER",
        severity: "FAIL",
        message: "tenderVersion does not match expected tender",
        evidenceRef: "field:tenderVersion",
      });
    }
    if (input.fields.winningBidId !== input.expectedWinningBidId) {
      findings.push({
        code: "INCONSISTENT_IDENTIFIER",
        severity: "FAIL",
        message: "winningBidId does not match bound winner",
        evidenceRef: "field:winningBidId",
      });
    }
    if (input.fields.escrowTenderKey !== input.expectedEscrowTenderKey) {
      findings.push({
        code: "INCONSISTENT_IDENTIFIER",
        severity: "FAIL",
        message: "escrowTenderKey does not match expected key",
        evidenceRef: "field:escrowTenderKey",
      });
    }

    if (!input.fields.recipientConfirmationPresent) {
      findings.push({
        code: "MISSING_RECIPIENT_CONFIRMATION",
        severity: "WARN",
        message: "recipient confirmation flag is false",
        evidenceRef: "field:recipientConfirmationPresent",
      });
    }

    if (input.deliveryDeadlineAt) {
      if (input.fields.deliveryTimestamp > input.deliveryDeadlineAt) {
        findings.push({
          code: "INCONSISTENT_DATES",
          severity: "WARN",
          message: "delivery timestamp is after delivery deadline",
          evidenceRef: "field:deliveryTimestamp",
        });
      }
    }

    // Duplicate plaintext hashes within the package.
    const hashCounts = new Map<string, number>();
    for (const e of input.manifest.entries) {
      hashCounts.set(
        e.plaintextSha256,
        (hashCounts.get(e.plaintextSha256) ?? 0) + 1,
      );
    }
    for (const [h, n] of hashCounts) {
      if (n > 1) {
        findings.push({
          code: "DUPLICATE",
          severity: "WARN",
          message: "duplicate file content hash within package",
          evidenceRef: h,
        });
      }
    }

    if (
      input.fields.exceptionCodes.some((c) => c !== "NONE") ||
      input.fields.cargoConditionCode === "DAMAGED"
    ) {
      findings.push({
        code: "ANOMALY",
        severity: "WARN",
        message: "cargo exception or damage declared",
        evidenceRef: "field:exceptionCodes",
      });
    }

    if (findings.length === 0) {
      findings.push({
        code: "COMPLETE",
        severity: "INFO",
        message: "no structured anomalies detected",
      });
    }

    // Stable order for determinism.
    findings.sort((a, b) => {
      const ka = `${a.code}|${a.severity}|${a.message}|${a.evidenceRef ?? ""}`;
      const kb = `${b.code}|${b.severity}|${b.message}|${b.evidenceRef ?? ""}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

    const hasFail = findings.some((f) => f.severity === "FAIL");
    const hasWarn = findings.some((f) => f.severity === "WARN");
    let recommendation: PodAdvisoryRecommendation = "ACCEPT";
    if (hasFail) recommendation = "REQUEST_CORRECTION";
    else if (hasWarn) recommendation = "MANUAL_REVIEW";

    const body: Omit<PodAdvisoryReport, "reportHash"> = {
      reportId: input.reportId,
      podId: input.fields.podId,
      podVersion: input.fields.podVersion,
      tenderId: input.fields.tenderId,
      engine: ADVISER_ENGINE_ID,
      binding: "NON_BINDING_ADVISORY",
      recommendation,
      findings: Object.freeze([...findings]),
      createdAt: input.createdAt,
    };

    return Object.freeze({
      ...body,
      reportHash: reportHashOf(body),
    });
  }
}

/** Deterministic report id from inputs (tests can also pass explicit ids). */
export function deterministicReportId(seed: string): string {
  const hex = createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 16);
  return `adv-${hex}`;
}
