/**
 * Prepare x402 PaymentPayload objects for RouteGuard strict canonical hashing.
 *
 * Root cause of the live final-demo payment failure:
 *   `@x402/core` v2 always assigns `extensions` on the constructed payload.
 *   When no extensions are declared, `mergeExtensions` returns `undefined`,
 *   producing a plain object property `extensions: undefined`.
 *   `canonicalize` correctly rejects undefined object properties fail-closed.
 *
 * Policy (narrow — does not weaken canonicalize):
 *   - Optional top-level properties whose value is `undefined` are omitted.
 *   - Nested objects are left intact so nested undefined still fails closed.
 *   - `null` is never invented; present null values are preserved.
 *   - Non-empty `extensions` objects pass through unchanged.
 */

/**
 * Shallow-omit keys whose value is strictly `undefined`.
 * Does not recurse; does not convert undefined → null.
 */
export function omitUndefinedObjectProperties(
  value: unknown,
): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    const child = src[key];
    if (child !== undefined) {
      out[key] = child;
    }
  }
  return out;
}

/**
 * Shape a PaymentPayload (or payment-payload-like object) for
 * `canonicalize` / `canonicalSha256`.
 *
 * Call this immediately before hashing; the signed payload used for
 * facilitator verify/settle may still carry the library's original shape.
 */
export function paymentPayloadForCanonicalHash(paymentPayload: unknown): unknown {
  return omitUndefinedObjectProperties(paymentPayload);
}
