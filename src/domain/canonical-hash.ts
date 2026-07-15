import { createHash } from "node:crypto";

/**
 * Recursive deterministic canonical JSON for trust-critical hashes.
 *
 * - Recursively sorts plain-object keys (code-point order via < / >)
 * - Preserves array order
 * - Rejects sparse arrays (every index 0..length-1 must exist)
 * - Rejects unsupported types fail-closed
 * - Does not mutate inputs
 * - Uses JSON.stringify string escaping for Unicode/control characters
 */

export function canonicalize(value: unknown): string {
  return canonicalizeInternal(value, "$");
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function canonicalizeInternal(value: unknown, path: string): string {
  if (value === null) {
    return "null";
  }

  const valueType = typeof value;

  if (valueType === "boolean") {
    return value ? "true" : "false";
  }

  if (valueType === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error(
        `Unsupported number at ${path}: NaN/Infinity are not allowed.`,
      );
    }
    return JSON.stringify(value);
  }

  if (valueType === "string") {
    // JSON.stringify applies standard JSON escaping (Unicode, quotes, control chars).
    return JSON.stringify(value);
  }

  if (valueType === "undefined") {
    throw new Error(`Unsupported value at ${path}: undefined.`);
  }

  if (valueType === "function") {
    throw new Error(`Unsupported value at ${path}: function.`);
  }

  if (valueType === "bigint") {
    throw new Error(
      `Unsupported value at ${path}: bigint (convert to an explicit string first).`,
    );
  }

  if (valueType === "symbol") {
    throw new Error(`Unsupported value at ${path}: symbol.`);
  }

  if (Array.isArray(value)) {
    // Reject sparse arrays: every index from 0 to length-1 must exist.
    for (let i = 0; i < value.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) {
        throw new Error(`Unsupported sparse array at ${path}[${i}].`);
      }
    }
    const items: string[] = [];
    for (let i = 0; i < value.length; i++) {
      items.push(canonicalizeInternal(value[i], `${path}[${i}]`));
    }
    return `[${items.join(",")}]`;
  }

  if (valueType === "object") {
    if (value instanceof Date) {
      throw new Error(`Unsupported value at ${path}: Date.`);
    }
    if (value instanceof Map) {
      throw new Error(`Unsupported value at ${path}: Map.`);
    }
    if (value instanceof Set) {
      throw new Error(`Unsupported value at ${path}: Set.`);
    }
    if (!isPlainObject(value as object)) {
      throw new Error(
        `Unsupported value at ${path}: class instance or non-plain object.`,
      );
    }

    const record = value as Record<string, unknown>;
    // Sort keys without mutating the original object.
    const keys = Object.keys(record).slice().sort((a, b) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    });
    const parts: string[] = [];

    for (const key of keys) {
      const child = record[key];
      if (child === undefined) {
        throw new Error(
          `Unsupported value at ${path}.${key}: undefined object property.`,
        );
      }
      parts.push(
        `${JSON.stringify(key)}:${canonicalizeInternal(child, `${path}.${key}`)}`,
      );
    }

    return `{${parts.join(",")}}`;
  }

  throw new Error(`Unsupported value at ${path}: ${valueType}.`);
}

/**
 * SHA-256 of canonical JSON, always:
 *   sha256:<64 lowercase hexadecimal characters>
 */
export function canonicalSha256(value: unknown): string {
  const canonical = canonicalize(value);
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error("Internal error: unexpected SHA-256 digest encoding.");
  }
  return `sha256:${digest}`;
}

export function assertSha256Hash(value: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(
      `Invalid hash format: expected sha256:<64 lowercase hex>, got ${value}`,
    );
  }
}

/** Lexicographic comparison using explicit code-point operators (no localeCompare). */
export function compareCodePointStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
