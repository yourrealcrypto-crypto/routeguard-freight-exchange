import { canonicalSha256 } from "../domain/canonical-hash";
import { ReconciliationError } from "./reconciliation";

/**
 * Deterministic hash of submitted evidence as plain JSON-compatible data.
 * Used to bind raw submissions into evaluatedBidSetHash even when schema fails.
 *
 * Rejects non-JSON-compatible runtime values (functions, class instances, etc.)
 * with a controlled typed error at the evidence boundary.
 */
export function hashSubmittedEvidence(value: unknown): string {
  try {
    return canonicalSha256(value);
  } catch (error: unknown) {
    throw new ReconciliationError(
      "UNSUPPORTED_EVIDENCE_TYPE",
      `Submitted evidence is not JSON-compatible for hashing: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Hash when present; null when absent. Throws on present-but-unsupported values.
 */
export function hashSubmittedEvidenceOrNull(
  value: unknown | undefined | null,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return hashSubmittedEvidence(value);
}
