/**
 * HCS 2.0 public-safe field enforcement.
 */

export const HCS_V2_PROHIBITED_FIELD_NAMES = [
  "name",
  "names",
  "fullName",
  "postalAddress",
  "address",
  "phone",
  "phoneNumber",
  "email",
  "emailAddress",
  "signatureImage",
  "podImage",
  "podImages",
  "plateNumber",
  "licensePlate",
  "privateKey",
  "paymentPayload",
  "signedPaymentPayload",
  "disputeNarrative",
  "unrestrictedNarrative",
  "plaintext",
  "podPlaintext",
  "documentBytes",
  "ciphertext",
  "encryptedDocument",
] as const;

export function assertHcsV2PublicSafe(
  value: unknown,
  path = "$",
): void {
  if (value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertHcsV2PublicSafe(item, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const lower = key.toLowerCase();
      for (const banned of HCS_V2_PROHIBITED_FIELD_NAMES) {
        if (key === banned || lower === banned.toLowerCase()) {
          throw new Error(
            `HCS v2 privacy violation: prohibited field "${key}" at ${path}`,
          );
        }
      }
      assertHcsV2PublicSafe(obj[key], `${path}.${key}`);
    }
  }
}
