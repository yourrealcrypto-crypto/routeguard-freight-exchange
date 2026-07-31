/**
 * RouteGuard v2 tender lifecycle vocabulary.
 *
 * Phase A1: states and categories only — no reducer / transition graph.
 */

export const V2_LIFECYCLE_STATES = [
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

export type V2LifecycleState = (typeof V2_LIFECYCLE_STATES)[number];

/** Pre-award auction and funding states. */
export const V2_PRE_AWARD_STATES: readonly V2LifecycleState[] = [
  "DRAFT",
  "ESCROW_FUNDED",
  "TENDER_OPENED",
  "BIDDING",
  "AUCTION_CLOSED",
  "NO_QUALIFIED_BID",
  "WINNER_SELECTED",
] as const;

/** Award and operational transport states. */
export const V2_AWARD_AND_TRANSPORT_STATES: readonly V2LifecycleState[] = [
  "WINNING_AMOUNT_LOCKED",
  "ROUTE_RESERVED",
  "IN_TRANSIT",
  "DELIVERY_REPORTED",
] as const;

/** POD submission and shipper-review states. */
export const V2_POD_REVIEW_STATES: readonly V2LifecycleState[] = [
  "POD_SUBMITTED",
  "POD_UNDER_REVIEW",
  "POD_CORRECTION_REQUESTED",
  "POD_RESUBMITTED",
  "POD_ACCEPTED",
  "POD_DEEMED_ACCEPTED",
  "POD_DISPUTED",
] as const;

/** Dispute and fund-release terminal path states. */
export const V2_DISPUTE_AND_SETTLEMENT_STATES: readonly V2LifecycleState[] = [
  "REFEREE_DECISION",
  "PAYMENT_RELEASED",
  "PARTIAL_RELEASE",
  "REFUNDED",
  "TENDER_COMPLETED",
] as const;

/** States where freight funds remain locked in escrow. */
export const V2_FUNDS_LOCKED_STATES: readonly V2LifecycleState[] = [
  "WINNING_AMOUNT_LOCKED",
  "ROUTE_RESERVED",
  "IN_TRANSIT",
  "DELIVERY_REPORTED",
  "POD_SUBMITTED",
  "POD_UNDER_REVIEW",
  "POD_CORRECTION_REQUESTED",
  "POD_RESUBMITTED",
  "POD_DISPUTED",
  "REFEREE_DECISION",
] as const;

/** States that conclude the tender economic path. */
export const V2_ECONOMIC_TERMINAL_STATES: readonly V2LifecycleState[] = [
  "PAYMENT_RELEASED",
  "PARTIAL_RELEASE",
  "REFUNDED",
  "TENDER_COMPLETED",
] as const;

export function isV2LifecycleState(value: string): value is V2LifecycleState {
  return (V2_LIFECYCLE_STATES as readonly string[]).includes(value);
}
