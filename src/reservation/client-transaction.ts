/**
 * Client-frozen Hedera transaction reference (v1.5 §22.4/§23) — the exact
 * transaction ID and validity window read from the SIGNED payment transaction
 * BEFORE any facilitator call. Values are decoded from real transaction bytes;
 * nothing here is invented or defaulted.
 *
 * Deterministic conclusive-failure rule (v1.5 §23.2): an attempt is
 * conclusively failed only when BOTH hold —
 *   1. an exact-transaction lookup finds no successful transaction; and
 *   2. now > validStartTimestamp + transactionValidDurationSeconds
 *            + SETTLEMENT_SAFETY_BUFFER_SECONDS.
 */

import { ReservationError } from "./types";

/** v1.5 §23.2 bounty configuration. */
export const SETTLEMENT_SAFETY_BUFFER_SECONDS = 60 as const;
/**
 * Expected signed-transaction valid duration for the bounty configuration
 * (v1.5 §23.2). The persisted value is always the ACTUAL duration decoded from
 * the signed transaction; this constant exists for assertions and docs.
 */
export const EXPECTED_TRANSACTION_VALID_DURATION_SECONDS = 180 as const;

export type ClientTransactionRef = {
  /** SDK form `0.0.x@seconds.nanos` exactly as frozen client-side. */
  readonly transactionId: string;
  /** UTC ISO of the transaction valid-start embedded in the ID. */
  readonly validStartTimestamp: string;
  /** ACTUAL valid duration decoded from the signed transaction (1..180 s). */
  readonly transactionValidDurationSeconds: number;
};

const SDK_TX_ID_RE = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/;
const MIRROR_TX_ID_RE = /^(\d+\.\d+\.\d+)-(\d+)-(\d+)$/;

/** Normalize SDK (`0.0.x@s.n`) or Mirror (`0.0.x-s-n`) form to Mirror form. */
export function normalizeTransactionId(id: string): string {
  const trimmed = id.trim();
  const sdk = SDK_TX_ID_RE.exec(trimmed);
  if (sdk) {
    return `${sdk[1]}-${sdk[2]}-${sdk[3]}`;
  }
  if (MIRROR_TX_ID_RE.test(trimmed)) {
    return trimmed;
  }
  throw new ReservationError(
    "INVALID_TRANSACTION_ID",
    `Unrecognized Hedera transaction ID format: ${trimmed}`,
  );
}

export function transactionIdsEqual(a: string, b: string): boolean {
  return normalizeTransactionId(a) === normalizeTransactionId(b);
}

/** Derive the exact valid-start UTC ISO from the SDK-form transaction ID. */
export function validStartIsoFromTransactionId(transactionId: string): string {
  const m = SDK_TX_ID_RE.exec(transactionId.trim());
  if (!m) {
    throw new ReservationError(
      "INVALID_TRANSACTION_ID",
      "validStart derivation requires SDK-form transaction ID (acct@s.n)",
    );
  }
  const seconds = Number(m[2]);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new ReservationError(
      "INVALID_TRANSACTION_ID",
      "Transaction ID valid-start seconds out of range",
    );
  }
  const nanos = (m[3] ?? "0").padStart(9, "0").slice(0, 9);
  const d = new Date(seconds * 1000);
  if (Number.isNaN(d.getTime())) {
    throw new ReservationError(
      "INVALID_TRANSACTION_ID",
      "Unrepresentable transaction valid-start",
    );
  }
  const yyyy = String(d.getUTCFullYear()).padStart(4, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}.${nanos}Z`;
}

/**
 * Validate a client transaction reference: SDK-form ID, validStart consistent
 * with the ID's embedded timestamp, integer duration within Hedera's 1..180 s.
 */
export function parseClientTransactionRef(
  input: unknown,
): ClientTransactionRef {
  if (!input || typeof input !== "object") {
    throw new ReservationError(
      "MISSING_CLIENT_TRANSACTION",
      "clientTransaction is required before payment submission (v1.5 §22.4)",
    );
  }
  const o = input as Record<string, unknown>;
  const transactionId = typeof o.transactionId === "string" ? o.transactionId.trim() : "";
  if (!SDK_TX_ID_RE.test(transactionId)) {
    throw new ReservationError(
      "INVALID_CLIENT_TRANSACTION",
      "clientTransaction.transactionId must be SDK form acct@seconds.nanos",
    );
  }
  const validStartTimestamp =
    typeof o.validStartTimestamp === "string" ? o.validStartTimestamp.trim() : "";
  const derived = validStartIsoFromTransactionId(transactionId);
  if (validStartTimestamp !== derived) {
    throw new ReservationError(
      "INVALID_CLIENT_TRANSACTION",
      `clientTransaction.validStartTimestamp must equal the ID-embedded valid start (${derived})`,
    );
  }
  const duration = o.transactionValidDurationSeconds;
  if (
    typeof duration !== "number" ||
    !Number.isInteger(duration) ||
    duration < 1 ||
    duration > EXPECTED_TRANSACTION_VALID_DURATION_SECONDS
  ) {
    throw new ReservationError(
      "INVALID_CLIENT_TRANSACTION",
      "clientTransaction.transactionValidDurationSeconds must be an integer in 1..180",
    );
  }
  return {
    transactionId,
    validStartTimestamp,
    transactionValidDurationSeconds: duration,
  };
}

/**
 * Epoch-ms boundary after which (and only after which) a NOT-FOUND exact
 * lookup is conclusive: validStart + validDuration + 60 s safety buffer.
 */
export function conclusiveFailureBoundaryMs(ref: {
  validStartTimestamp: string;
  transactionValidDurationSeconds: number;
}): number {
  const startMs = Date.parse(ref.validStartTimestamp);
  if (!Number.isFinite(startMs)) {
    throw new ReservationError(
      "INVALID_CLIENT_TRANSACTION",
      "Invalid validStartTimestamp for conclusive-failure boundary",
    );
  }
  return (
    startMs +
    ref.transactionValidDurationSeconds * 1000 +
    SETTLEMENT_SAFETY_BUFFER_SECONDS * 1000
  );
}

export type SettlementReconciliationOutcome =
  | { readonly outcome: "FOUND_SUCCESS"; readonly transactionId: string }
  | { readonly outcome: "FOUND_FAILED"; readonly result: string | null }
  | {
      readonly outcome: "RECONCILIATION_PENDING";
      readonly boundaryIso: string;
    }
  | { readonly outcome: "CONCLUSIVELY_FAILED"; readonly boundaryIso: string };
