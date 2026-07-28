/**
 * Challenge-stated fixed Hedera network transfer costs.
 *
 * These exact USD amounts are binding bounty submission requirements from the
 * official Hedera x402 challenge wording. They are NOT:
 * - the reservation payment amount paid to the carrier;
 * - a RouteGuard platform charge;
 * - a separate facilitator charge line item;
 * - deducted from the carrier's reservation payment;
 * - dynamically measured from a live transaction.
 *
 * Use exact decimal strings only — never JavaScript floating point.
 */

export const CHALLENGE_STATED_NETWORK_TRANSFER_COST_LABEL =
  "Challenge-stated fixed Hedera network transfer cost" as const;

export const HEDERA_TRANSFER_COSTS = {
  HBAR: {
    rail: "HBAR",
    optionId: "HBAR",
    networkFeeUsd: "0.0001",
  },
  HTS_STABLECOIN: {
    rail: "HTS_STABLECOIN",
    optionId: "USDC",
    networkFeeUsd: "0.001",
  },
} as const;

export type HederaTransferCostRail = keyof typeof HEDERA_TRANSFER_COSTS;

export type ReservationPaymentRail = "USDC" | "HBAR";

export function challengeStatedNetworkTransferCostUsd(
  optionId: ReservationPaymentRail,
): "0.0001" | "0.001" {
  if (optionId === "HBAR") {
    return HEDERA_TRANSFER_COSTS.HBAR.networkFeeUsd;
  }
  return HEDERA_TRANSFER_COSTS.HTS_STABLECOIN.networkFeeUsd;
}

export function hederaTransferCostEntry(optionId: ReservationPaymentRail): {
  readonly rail: "HBAR" | "HTS_STABLECOIN";
  readonly optionId: ReservationPaymentRail;
  readonly networkFeeUsd: "0.0001" | "0.001";
  readonly label: typeof CHALLENGE_STATED_NETWORK_TRANSFER_COST_LABEL;
} {
  if (optionId === "HBAR") {
    return {
      rail: HEDERA_TRANSFER_COSTS.HBAR.rail,
      optionId: "HBAR",
      networkFeeUsd: HEDERA_TRANSFER_COSTS.HBAR.networkFeeUsd,
      label: CHALLENGE_STATED_NETWORK_TRANSFER_COST_LABEL,
    };
  }
  return {
    rail: HEDERA_TRANSFER_COSTS.HTS_STABLECOIN.rail,
    optionId: "USDC",
    networkFeeUsd: HEDERA_TRANSFER_COSTS.HTS_STABLECOIN.networkFeeUsd,
    label: CHALLENGE_STATED_NETWORK_TRANSFER_COST_LABEL,
  };
}

/** Exact string constants for tests and compliance assertions. */
export const HBAR_NETWORK_TRANSFER_COST_USD = HEDERA_TRANSFER_COSTS.HBAR
  .networkFeeUsd;
export const STABLECOIN_NETWORK_TRANSFER_COST_USD =
  HEDERA_TRANSFER_COSTS.HTS_STABLECOIN.networkFeeUsd;
