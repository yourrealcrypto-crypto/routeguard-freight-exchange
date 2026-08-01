import { describe, expect, it } from "vitest";

import {
  isV2LifecycleState,
  V2_DISPUTE_AND_SETTLEMENT_STATES,
  V2_ECONOMIC_TERMINAL_STATES,
  V2_FUNDS_LOCKED_STATES,
  V2_LIFECYCLE_STATES,
  V2_POD_REVIEW_STATES,
  V2_PRE_AWARD_STATES,
} from "../src/v2/lifecycle/states";

const REQUIRED_STATES = [
  "DRAFT",
  "ESCROW_FUNDED",
  "TENDER_OPENED",
  "BIDDING",
  "AUCTION_CLOSED",
  "NO_QUALIFIED_BID",
  "WINNER_SELECTED",
  "WINNING_AMOUNT_LOCKED",
  "ROUTE_RESERVED",
  "IN_TRANSIT",
  "DELIVERY_REPORTED",
  "POD_SUBMITTED",
  "POD_UNDER_REVIEW",
  "POD_CORRECTION_REQUESTED",
  "POD_RESUBMITTED",
  "POD_ACCEPTED",
  "POD_DEEMED_ACCEPTED",
  "POD_DISPUTED",
  "REFEREE_DECISION",
  "PAYMENT_RELEASED",
  "PARTIAL_RELEASE",
  "REFUNDED",
  "TENDER_COMPLETED",
] as const;

describe("v2 lifecycle vocabulary", () => {
  it("includes all required lifecycle states", () => {
    for (const state of REQUIRED_STATES) {
      expect(V2_LIFECYCLE_STATES).toContain(state);
      expect(isV2LifecycleState(state)).toBe(true);
    }
    expect(V2_LIFECYCLE_STATES).toHaveLength(REQUIRED_STATES.length);
  });

  it("rejects unknown state labels", () => {
    expect(isV2LifecycleState("PAYMENT_CONFIRMED")).toBe(false);
    expect(isV2LifecycleState("")).toBe(false);
  });

  it("exposes non-empty category sets without implementing a reducer", () => {
    expect(V2_PRE_AWARD_STATES.length).toBeGreaterThan(0);
    expect(V2_POD_REVIEW_STATES).toContain("POD_DEEMED_ACCEPTED");
    expect(V2_FUNDS_LOCKED_STATES).toContain("POD_DISPUTED");
    expect(V2_DISPUTE_AND_SETTLEMENT_STATES).toContain("REFEREE_DECISION");
    expect(V2_ECONOMIC_TERMINAL_STATES).toContain("TENDER_COMPLETED");
  });
});
