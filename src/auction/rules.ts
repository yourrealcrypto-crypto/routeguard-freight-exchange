import { canonicalSha256 } from "../domain/canonical-hash";
import { SELECTION_POLICY_V1 } from "../domain/tender";

type RulesDoc = {
  readonly policy: typeof SELECTION_POLICY_V1;
  readonly engineVersion: "routeguard-auction-1.0";
  readonly ranking: readonly string[];
  readonly eligibility: readonly string[];
  readonly deadlineEquality: string;
};

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    const child = (value as Record<string, unknown>)[key];
    if (child && typeof child === "object" && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}

const rulesMutable = {
  policy: SELECTION_POLICY_V1,
  engineVersion: "routeguard-auction-1.0" as const,
  ranking: [
    "lowest_freightPriceCents",
    "earliest_estimatedDelivery_epoch_nanoseconds",
    "earliest_hcs_consensusTimestamp_epoch_nanoseconds",
    "lexicographically_lowest_bidId_code_point",
  ],
  eligibility: [
    "timely_commitment",
    "full_bid_present",
    "bid_hash_match",
    "bid_version_match",
    "acceptance_receipt_match",
    "carrier_signature_valid",
    "carrier_active_in_registry",
    "carrier_identity_match",
    "bid_not_expired",
    "tender_match",
    "equipment_match",
    "equipment_authorized",
    "capacity_confirmed",
    "proposed_pickup_within_window",
    "delivery_deadline_met",
    "price_within_maximum",
    "payment_recipients_match_carrier",
    "payment_options_valid",
  ],
  deadlineEquality: "consensusTimestamp <= auctionEndsAt is timely (epoch ns)",
};

/** Deeply immutable exported rules document. */
export const LOWEST_QUALIFIED_PRICE_V1_RULES: RulesDoc = deepFreeze(
  rulesMutable,
) as RulesDoc;

export function computeRulesHash(): string {
  return canonicalSha256(LOWEST_QUALIFIED_PRICE_V1_RULES);
}
