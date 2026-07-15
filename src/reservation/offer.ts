/**
 * Immutable dual-asset reservation offer (demo fee, not freight price).
 */

import { canonicalSha256 } from "../domain/canonical-hash";
import { isPositiveIntegerString } from "../domain/money";
import { isValidHederaAccountId } from "../domain/payment-option";
import { isBeforeUtc, isUtcIsoTimestamp } from "../domain/time";
import {
  DEMO_RESERVATION_FEE_NOTE,
  HBAR_RESERVATION_OPTION,
  RESERVATION_OFFER_VERSION,
  ReservationError,
  USDC_RESERVATION_OPTION,
  type OfferOption,
  type ReservationOffer,
  type ReservationOptionId,
  type SelectedPaymentOption,
} from "./types";

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

export function resourcePathForOption(
  reservationId: string,
  optionId: ReservationOptionId,
): string {
  const base = `/api/reservations/${encodeURIComponent(reservationId)}/pay`;
  return optionId === "USDC" ? `${base}/usdc` : `${base}/hbar`;
}

function buildCanonicalOptions(): OfferOption[] {
  return [
    {
      optionId: USDC_RESERVATION_OPTION.optionId,
      scheme: USDC_RESERVATION_OPTION.scheme,
      network: USDC_RESERVATION_OPTION.network,
      asset: USDC_RESERVATION_OPTION.asset,
      amountAtomic: USDC_RESERVATION_OPTION.amountAtomic,
      displayAmount: USDC_RESERVATION_OPTION.displayAmount,
      currencyLabel: USDC_RESERVATION_OPTION.currencyLabel,
    },
    {
      optionId: HBAR_RESERVATION_OPTION.optionId,
      scheme: HBAR_RESERVATION_OPTION.scheme,
      network: HBAR_RESERVATION_OPTION.network,
      asset: HBAR_RESERVATION_OPTION.asset,
      amountAtomic: HBAR_RESERVATION_OPTION.amountAtomic,
      displayAmount: HBAR_RESERVATION_OPTION.displayAmount,
      currencyLabel: HBAR_RESERVATION_OPTION.currencyLabel,
    },
  ];
}

/** Body used for offerHash (excludes offerHash itself). */
export function buildOfferHashInput(input: {
  reservationId: string;
  offerVersion: number;
  tenderId: string;
  winningBidId: string;
  payTo: string;
  expiresAt: string;
  feeLabel: string;
  options: readonly OfferOption[];
}): unknown {
  return {
    reservationId: input.reservationId,
    offerVersion: input.offerVersion,
    tenderId: input.tenderId,
    winningBidId: input.winningBidId,
    payTo: input.payTo,
    expiresAt: input.expiresAt,
    feeLabel: input.feeLabel,
    options: input.options.map((o) => ({
      optionId: o.optionId,
      scheme: o.scheme,
      network: o.network,
      asset: o.asset,
      amountAtomic: o.amountAtomic,
      displayAmount: o.displayAmount,
      currencyLabel: o.currencyLabel,
    })),
  };
}

export function createReservationOffer(input: {
  reservationId: string;
  tenderId: string;
  winningBidId: string;
  payTo: string;
  expiresAt: string;
  offerVersion?: number;
}): ReservationOffer {
  if (!input.reservationId || input.reservationId.length > 128) {
    throw new ReservationError("INVALID_OFFER", "Invalid reservationId");
  }
  if (!isValidHederaAccountId(input.payTo)) {
    throw new ReservationError("INVALID_OFFER", "payTo must be a valid account");
  }
  if (!isUtcIsoTimestamp(input.expiresAt)) {
    throw new ReservationError("INVALID_OFFER", "expiresAt must be UTC ISO");
  }

  const offerVersion = input.offerVersion ?? RESERVATION_OFFER_VERSION;
  const options = buildCanonicalOptions();

  if (options.length !== 2) {
    throw new ReservationError("INVALID_OFFER", "Exactly two options required");
  }
  const ids = new Set(options.map((o) => o.optionId));
  const assets = new Set(options.map((o) => o.asset));
  if (ids.size !== 2) {
    throw new ReservationError("INVALID_OFFER", "Duplicate option IDs");
  }
  if (assets.size !== 2) {
    throw new ReservationError("INVALID_OFFER", "Duplicate assets");
  }
  for (const o of options) {
    if (!isPositiveIntegerString(o.amountAtomic)) {
      throw new ReservationError(
        "INVALID_OFFER",
        `Invalid amountAtomic for ${o.optionId}`,
      );
    }
  }

  if (options[0]!.amountAtomic !== USDC_RESERVATION_OPTION.amountAtomic) {
    throw new ReservationError("INVALID_OFFER", "USDC amount fixed to 10000");
  }
  if (options[1]!.amountAtomic !== HBAR_RESERVATION_OPTION.amountAtomic) {
    throw new ReservationError(
      "INVALID_OFFER",
      "HBAR amount fixed to 1000000 tinybars",
    );
  }

  const hashInput = buildOfferHashInput({
    reservationId: input.reservationId,
    offerVersion,
    tenderId: input.tenderId,
    winningBidId: input.winningBidId,
    payTo: input.payTo,
    expiresAt: input.expiresAt,
    feeLabel: DEMO_RESERVATION_FEE_NOTE,
    options,
  });

  const offer: ReservationOffer = {
    reservationId: input.reservationId,
    offerVersion,
    tenderId: input.tenderId,
    winningBidId: input.winningBidId,
    payTo: input.payTo,
    expiresAt: input.expiresAt,
    feeLabel: DEMO_RESERVATION_FEE_NOTE,
    options,
    offerHash: canonicalSha256(hashInput),
  };

  return deepFreeze(offer);
}

export function verifyOfferIntegrity(offer: ReservationOffer): void {
  const recomputed = canonicalSha256(
    buildOfferHashInput({
      reservationId: offer.reservationId,
      offerVersion: offer.offerVersion,
      tenderId: offer.tenderId,
      winningBidId: offer.winningBidId,
      payTo: offer.payTo,
      expiresAt: offer.expiresAt,
      feeLabel: offer.feeLabel,
      options: offer.options,
    }),
  );
  if (recomputed !== offer.offerHash) {
    throw new ReservationError(
      "OFFER_HASH_MISMATCH",
      "Offer hash does not match canonical content",
    );
  }
  if (offer.options.length !== 2) {
    throw new ReservationError(
      "INVALID_OFFER",
      "Offer must have exactly 2 options",
    );
  }
}

export function isOfferExpired(offer: ReservationOffer, now: string): boolean {
  if (!isUtcIsoTimestamp(now)) {
    throw new ReservationError("INVALID_TIMESTAMP", "now must be UTC");
  }
  return !isBeforeUtc(now, offer.expiresAt);
}

export function selectPaymentOption(input: {
  offer: ReservationOffer;
  optionId: ReservationOptionId;
  payerAccount: string;
  offerHash: string;
  offerVersion: number;
  selectedAt: string;
  now: string;
}): SelectedPaymentOption {
  verifyOfferIntegrity(input.offer);

  if (input.offerHash !== input.offer.offerHash) {
    throw new ReservationError(
      "STALE_OFFER",
      "offerHash does not match published offer",
    );
  }
  if (input.offerVersion !== input.offer.offerVersion) {
    throw new ReservationError(
      "STALE_OFFER",
      "offerVersion does not match published offer",
    );
  }
  if (!isUtcIsoTimestamp(input.selectedAt) || !isUtcIsoTimestamp(input.now)) {
    throw new ReservationError(
      "INVALID_TIMESTAMP",
      "selectedAt/now must be UTC",
    );
  }
  if (!isBeforeUtc(input.now, input.offer.expiresAt)) {
    throw new ReservationError("OFFER_EXPIRED", "Reservation offer has expired");
  }
  if (!isValidHederaAccountId(input.payerAccount)) {
    throw new ReservationError("INVALID_PAYER", "payerAccount invalid");
  }

  const option = input.offer.options.find((o) => o.optionId === input.optionId);
  if (!option) {
    throw new ReservationError(
      "UNKNOWN_OPTION",
      `Unknown optionId: ${input.optionId}`,
    );
  }

  const selected: SelectedPaymentOption = {
    reservationId: input.offer.reservationId,
    offerHash: input.offer.offerHash,
    offerVersion: input.offer.offerVersion,
    optionId: option.optionId,
    payerAccount: input.payerAccount,
    payTo: input.offer.payTo,
    asset: option.asset,
    amountAtomic: option.amountAtomic,
    scheme: option.scheme,
    network: option.network,
    selectedAt: input.selectedAt,
    resourcePath: resourcePathForOption(
      input.offer.reservationId,
      option.optionId,
    ),
  };

  return deepFreeze(selected);
}

export function assertSelectionMatchesChallenge(
  selected: SelectedPaymentOption,
  challenge: {
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
  },
): void {
  if (challenge.scheme !== selected.scheme) {
    throw new ReservationError("CHALLENGE_MISMATCH", "scheme mismatch");
  }
  if (challenge.network !== selected.network) {
    throw new ReservationError("CHALLENGE_MISMATCH", "network mismatch");
  }
  if (challenge.asset !== selected.asset) {
    throw new ReservationError("CHALLENGE_MISMATCH", "asset mismatch");
  }
  if (challenge.amount !== selected.amountAtomic) {
    throw new ReservationError("CHALLENGE_MISMATCH", "amount mismatch");
  }
  if (challenge.payTo !== selected.payTo) {
    throw new ReservationError("CHALLENGE_MISMATCH", "payTo mismatch");
  }
}
