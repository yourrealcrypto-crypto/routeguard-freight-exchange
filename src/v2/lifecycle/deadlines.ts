/**
 * Deterministic deadline arithmetic for v2 POD review windows.
 * All times are supplied UTC ISO strings — never reads the system clock.
 */

import { parseUtcTimestamp } from "../../domain/time";

/** Default shipper review window: 48 hours. */
export const REVIEW_WINDOW_SECONDS = 172_800 as const;

/** Default correction window: 24 hours. */
export const CORRECTION_WINDOW_SECONDS = 86_400 as const;

/** Post-resubmit review window: 24 hours. */
export const POST_RESUBMIT_REVIEW_WINDOW_SECONDS = 86_400 as const;

const NANOS_PER_SECOND = 1_000_000_000n;

/**
 * Add a non-negative whole-second offset to a UTC ISO-8601 timestamp.
 * Uses epoch-nanosecond arithmetic; calendar formatting only (no Date.now).
 */
export function addUtcSeconds(isoTimestamp: string, seconds: number): string {
  if (!Number.isInteger(seconds) || seconds < 0 || !Number.isSafeInteger(seconds)) {
    throw new Error("seconds must be a non-negative safe integer");
  }
  const parsed = parseUtcTimestamp(isoTimestamp);
  const totalNanos =
    parsed.epochNanoseconds + BigInt(seconds) * NANOS_PER_SECOND;
  return formatUtcFromEpochNanos(totalNanos);
}

export function computeReviewDeadline(eventTime: string): string {
  return addUtcSeconds(eventTime, REVIEW_WINDOW_SECONDS);
}

export function computeCorrectionDeadline(eventTime: string): string {
  return addUtcSeconds(eventTime, CORRECTION_WINDOW_SECONDS);
}

export function computePostResubmitReviewDeadline(eventTime: string): string {
  return addUtcSeconds(eventTime, POST_RESUBMIT_REVIEW_WINDOW_SECONDS);
}

function formatUtcFromEpochNanos(epochNanos: bigint): string {
  if (epochNanos < 0n) {
    throw new Error("epoch nanoseconds must not be negative");
  }
  const epochSeconds = epochNanos / NANOS_PER_SECOND;
  const nanoseconds = Number(epochNanos % NANOS_PER_SECOND);

  // Whole-second calendar components via Date.UTC inverse (no wall clock).
  const ms = Number(epochSeconds) * 1000;
  if (!Number.isSafeInteger(ms)) {
    throw new Error("timestamp out of safe millisecond range");
  }
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");

  if (nanoseconds === 0) {
    return `${y}-${mo}-${day}T${h}:${mi}:${s}.000Z`;
  }
  const frac = String(nanoseconds).padStart(9, "0").replace(/0+$/, "");
  return `${y}-${mo}-${day}T${h}:${mi}:${s}.${frac}Z`;
}
