/**
 * Canonical protected-resource builders for v2 x402 access actions.
 * Resources bind tenderId + tenderVersion (+ bidId for bid submit).
 */

function assertId(label: string, value: string): void {
  if (!value || value.length === 0 || value.length > 128) {
    throw new Error(`${label} must be a non-empty id <= 128 chars`);
  }
  if (value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new Error(`${label} must not contain path separators`);
  }
}

function assertVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1 || !Number.isSafeInteger(version)) {
    throw new Error("tenderVersion must be a positive safe integer");
  }
}

/**
 * Tender activation resource — exact path form used in challenges and receipts.
 * Includes tenderVersion so payments cannot be replayed across versions.
 */
export function tenderActivateResource(
  tenderId: string,
  tenderVersion: number,
): string {
  assertId("tenderId", tenderId);
  assertVersion(tenderVersion);
  return `/api/v2/tenders/${encodeURIComponent(tenderId)}/v/${tenderVersion}/activate`;
}

/**
 * Durable bid-submission resource — binds tender version and bid id.
 */
export function bidSubmitResource(
  tenderId: string,
  tenderVersion: number,
  bidId: string,
): string {
  assertId("tenderId", tenderId);
  assertId("bidId", bidId);
  assertVersion(tenderVersion);
  return `/api/v2/tenders/${encodeURIComponent(tenderId)}/v/${tenderVersion}/bids/${encodeURIComponent(bidId)}`;
}
