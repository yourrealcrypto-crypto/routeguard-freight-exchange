/**
 * Precise UTC timestamp model for trust-critical auction logic.
 *
 * Comparison uses epoch nanoseconds (bigint), not Date milliseconds and not
 * lexical string order.
 */

export type ParsedUtcTimestamp = {
  epochSeconds: bigint;
  /** 0..999_999_999 inclusive */
  nanoseconds: number;
  epochNanoseconds: bigint;
  /** Original accepted string (not re-normalized away from fractional width). */
  canonical: string;
};

const UTC_ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month1to12: number): number {
  if (month1to12 === 2 && isLeapYear(year)) {
    return 29;
  }
  return DAYS_IN_MONTH[month1to12 - 1] ?? 0;
}

/**
 * Parse an explicit UTC Z timestamp with 0–9 fractional digits.
 * Rejects timezone offsets and impossible calendar dates.
 */
export function parseUtcTimestamp(value: string): ParsedUtcTimestamp {
  if (typeof value !== "string") {
    throw new Error("UTC timestamp must be a string.");
  }
  // Reject offsets (+00:00, -05:00, etc.) and missing Z.
  if (/[+-]\d{2}:\d{2}$/.test(value) || value.endsWith("+00:00")) {
    throw new Error(`Timezone offsets are not allowed: ${value}`);
  }

  const match = UTC_ISO_RE.exec(value);
  if (!match) {
    throw new Error(`Invalid UTC ISO-8601 timestamp: ${value}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const frac = match[7] ?? "";

  if (month < 1 || month > 12) {
    throw new Error(`Invalid month in timestamp: ${value}`);
  }
  const dim = daysInMonth(year, month);
  if (day < 1 || day > dim) {
    throw new Error(`Impossible calendar date in timestamp: ${value}`);
  }
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error(`Invalid clock component in timestamp: ${value}`);
  }

  // Exact UTC round-trip of calendar components via Date.UTC (ms precision floor).
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const roundTrip = new Date(ms);
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() + 1 !== month ||
    roundTrip.getUTCDate() !== day ||
    roundTrip.getUTCHours() !== hour ||
    roundTrip.getUTCMinutes() !== minute ||
    roundTrip.getUTCSeconds() !== second
  ) {
    throw new Error(`UTC round-trip failed for timestamp: ${value}`);
  }

  // Fractional seconds → nanoseconds (pad right to 9 digits).
  const nanoStr = frac.padEnd(9, "0");
  const nanoseconds = Number(nanoStr);
  if (
    !Number.isInteger(nanoseconds) ||
    nanoseconds < 0 ||
    nanoseconds > 999_999_999
  ) {
    throw new Error(`Invalid fractional seconds in timestamp: ${value}`);
  }

  const epochSeconds = BigInt(Math.floor(ms / 1000));
  // Date.UTC gives whole seconds in ms; nanoseconds are only from the fraction.
  const epochNanoseconds = epochSeconds * 1_000_000_000n + BigInt(nanoseconds);

  return {
    epochSeconds,
    nanoseconds,
    epochNanoseconds,
    canonical: value,
  };
}

export function isUtcIsoTimestamp(value: string): boolean {
  try {
    parseUtcTimestamp(value);
    return true;
  } catch {
    return false;
  }
}

export function compareUtc(a: string, b: string): number {
  const left = parseUtcTimestamp(a).epochNanoseconds;
  const right = parseUtcTimestamp(b).epochNanoseconds;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function isBeforeOrEqualUtc(a: string, b: string): boolean {
  return compareUtc(a, b) <= 0;
}

export function isBeforeUtc(a: string, b: string): boolean {
  return compareUtc(a, b) < 0;
}

export function isAfterUtc(a: string, b: string): boolean {
  return compareUtc(a, b) > 0;
}
