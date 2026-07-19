/**
 * Application-level payment economics for display, receipts, and evidence.
 *
 * Intentionally separate from x402 protocol challenge fields. Network transfer
 * costs are never subtracted from the carrier reservation payment and never
 * mixed into same-unit totals across HBAR and USD.
 */

import {
  CHALLENGE_STATED_NETWORK_TRANSFER_COST_LABEL,
  challengeStatedNetworkTransferCostUsd,
  hederaTransferCostEntry,
  type ReservationPaymentRail,
} from "./hedera-transfer-costs";

export const FACILITATOR_FEE_STATUS =
  "NOT_MODELED_AS_SEPARATE_X402_CHARGE" as const;

export const FACILITATOR_FEE_NOTE =
  "Hosted Blocky402 testnet facilitator acts as Hedera transaction fee payer for settlement submission. RouteGuard does not add a separate facilitator fee line to the x402 reservation payment amount, and does not claim that fee is zero." as const;

export const ROUTEGUARD_PLATFORM_FEE_STATUS =
  "NOT_MODELED_AS_SEPARATE_CHARGE" as const;

export const ROUTEGUARD_PLATFORM_FEE_NOTE =
  "Bounty demo reservation payment is the exact carrier-bound amount only. No separate RouteGuard platform fee is deducted from or added to the reservation payment amount." as const;

export type PaymentEconomicsSummary = {
  readonly reservationPaymentAmountAtomic: string;
  readonly reservationPaymentAsset: string;
  readonly reservationPaymentOptionId: ReservationPaymentRail;
  readonly reservationPaymentDisplayAmount: string;
  readonly reservationPaymentCurrencyLabel: string;
  readonly hederaNetworkTransferCost: {
    readonly label: typeof CHALLENGE_STATED_NETWORK_TRANSFER_COST_LABEL;
    readonly rail: "HBAR" | "HTS_STABLECOIN";
    readonly networkFeeUsd: "0.0001" | "0.001";
    readonly unit: "USD";
    readonly deductedFromCarrier: false;
    readonly includedInX402PaymentAmount: false;
  };
  readonly facilitatorFee: {
    readonly status: typeof FACILITATOR_FEE_STATUS;
    readonly note: typeof FACILITATOR_FEE_NOTE;
  };
  readonly routeGuardPlatformFee: {
    readonly status: typeof ROUTEGUARD_PLATFORM_FEE_STATUS;
    readonly note: typeof ROUTEGUARD_PLATFORM_FEE_NOTE;
  };
  /** Carrier-received reservation amount — identical to reservation payment. */
  readonly carrierReceivedAmountAtomic: string;
  readonly carrierReceivedAsset: string;
  /**
   * Honest multi-unit note. Never sums HBAR tinybars with USD network fees.
   */
  readonly totalPayerEconomicsNote: string;
};

export type RailPresentation = {
  readonly optionId: ReservationPaymentRail;
  readonly asset: string;
  readonly amountAtomic: string;
  readonly displayAmount: string;
  readonly currencyLabel: string;
  readonly challengeStatedHederaNetworkTransferCostUsd: "0.0001" | "0.001";
  readonly challengeStatedHederaNetworkTransferCostLabel: typeof CHALLENGE_STATED_NETWORK_TRANSFER_COST_LABEL;
  readonly selectorLabel: string;
};

export function buildRailPresentation(input: {
  optionId: ReservationPaymentRail;
  asset: string;
  amountAtomic: string;
  displayAmount: string;
  currencyLabel: string;
}): RailPresentation {
  const cost = hederaTransferCostEntry(input.optionId);
  return {
    optionId: input.optionId,
    asset: input.asset,
    amountAtomic: input.amountAtomic,
    displayAmount: input.displayAmount,
    currencyLabel: input.currencyLabel,
    challengeStatedHederaNetworkTransferCostUsd: cost.networkFeeUsd,
    challengeStatedHederaNetworkTransferCostLabel: cost.label,
    selectorLabel: `${input.optionId}\n${cost.label}: $${cost.networkFeeUsd}`,
  };
}

export function buildPaymentEconomicsSummary(input: {
  optionId: ReservationPaymentRail;
  asset: string;
  amountAtomic: string;
  displayAmount: string;
  currencyLabel: string;
}): PaymentEconomicsSummary {
  const cost = hederaTransferCostEntry(input.optionId);
  const networkFeeUsd = challengeStatedNetworkTransferCostUsd(input.optionId);

  const totalPayerEconomicsNote =
    input.optionId === "HBAR"
      ? `Carrier reservation payment is ${input.displayAmount} HBAR (${input.amountAtomic} tinybars). Challenge-stated fixed Hedera network transfer cost is $${networkFeeUsd} USD. These are different units and must not be summed into a single same-unit total.`
      : `Carrier reservation payment is ${input.displayAmount} ${input.currencyLabel} (${input.amountAtomic} atomic units). Challenge-stated fixed Hedera network transfer cost is $${networkFeeUsd} USD and is not deducted from the ${input.displayAmount} ${input.currencyLabel} carrier payment.`;

  return {
    reservationPaymentAmountAtomic: input.amountAtomic,
    reservationPaymentAsset: input.asset,
    reservationPaymentOptionId: input.optionId,
    reservationPaymentDisplayAmount: input.displayAmount,
    reservationPaymentCurrencyLabel: input.currencyLabel,
    hederaNetworkTransferCost: {
      label: CHALLENGE_STATED_NETWORK_TRANSFER_COST_LABEL,
      rail: cost.rail,
      networkFeeUsd: cost.networkFeeUsd,
      unit: "USD",
      deductedFromCarrier: false,
      includedInX402PaymentAmount: false,
    },
    facilitatorFee: {
      status: FACILITATOR_FEE_STATUS,
      note: FACILITATOR_FEE_NOTE,
    },
    routeGuardPlatformFee: {
      status: ROUTEGUARD_PLATFORM_FEE_STATUS,
      note: ROUTEGUARD_PLATFORM_FEE_NOTE,
    },
    carrierReceivedAmountAtomic: input.amountAtomic,
    carrierReceivedAsset: input.asset,
    totalPayerEconomicsNote,
  };
}

/**
 * Format multi-line payment summary for CLI / judge narration.
 * Keeps units on separate lines; never merges HBAR + USD.
 */
export function formatPaymentEconomicsLines(
  economics: PaymentEconomicsSummary,
): string[] {
  return [
    `Carrier reservation payment: ${economics.reservationPaymentDisplayAmount} ${economics.reservationPaymentCurrencyLabel} (${economics.reservationPaymentAmountAtomic} atomic; asset ${economics.reservationPaymentAsset})`,
    `Selected asset / rail: ${economics.reservationPaymentOptionId}`,
    `${economics.hederaNetworkTransferCost.label}: $${economics.hederaNetworkTransferCost.networkFeeUsd} USD`,
    `Facilitator fee: ${economics.facilitatorFee.status}`,
    `RouteGuard platform fee: ${economics.routeGuardPlatformFee.status}`,
    `Carrier-received amount: ${economics.carrierReceivedAmountAtomic} atomic of ${economics.carrierReceivedAsset} (equals reservation payment; network transfer cost not deducted)`,
    economics.totalPayerEconomicsNote,
  ];
}
