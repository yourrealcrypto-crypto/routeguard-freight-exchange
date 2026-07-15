/**
 * Complete x402 payment challenge binding and durable challenge hashing.
 * Challenge is issued once; retries reuse the identical persisted record.
 */

import { canonicalSha256 } from "../domain/canonical-hash";
import { isUtcIsoTimestamp } from "../domain/time";
import { resourcePathForOption } from "./offer";
import {
  CHALLENGE_MAX_TIMEOUT_SECONDS,
  CHALLENGE_X402_VERSION,
  DEMO_RESERVATION_FEE_NOTE,
  ReservationError,
  RESERVATION_NETWORK,
  RESERVATION_SCHEME,
  type PaymentChallenge,
  type PaymentChallengeRecord,
  type SelectedPaymentOption,
} from "./types";

/** Fields hashed into challengeHash (everything except the hash itself). */
export type ChallengeHashInput = {
  readonly x402Version: typeof CHALLENGE_X402_VERSION;
  readonly scheme: typeof RESERVATION_SCHEME;
  readonly network: typeof RESERVATION_NETWORK;
  readonly asset: string;
  readonly amount: string;
  readonly payTo: string;
  readonly resource: string;
  readonly maxTimeoutSeconds: typeof CHALLENGE_MAX_TIMEOUT_SECONDS;
  readonly description: string;
  readonly issuedAt: string;
};

/** Exact expected public challenge shape for the locked selection. */
export function expectedChallengeFields(
  selected: SelectedPaymentOption,
): Omit<ChallengeHashInput, "issuedAt" | "description"> & {
  description: typeof DEMO_RESERVATION_FEE_NOTE;
} {
  return {
    x402Version: CHALLENGE_X402_VERSION,
    scheme: RESERVATION_SCHEME,
    network: RESERVATION_NETWORK,
    asset: selected.asset,
    amount: selected.amountAtomic,
    payTo: selected.payTo,
    resource: resourcePathForOption(selected.reservationId, selected.optionId),
    maxTimeoutSeconds: CHALLENGE_MAX_TIMEOUT_SECONDS,
    description: DEMO_RESERVATION_FEE_NOTE,
  };
}

export function buildChallengeHashInput(
  fields: ChallengeHashInput,
): ChallengeHashInput {
  return {
    x402Version: fields.x402Version,
    scheme: fields.scheme,
    network: fields.network,
    asset: fields.asset,
    amount: fields.amount,
    payTo: fields.payTo,
    resource: fields.resource,
    maxTimeoutSeconds: fields.maxTimeoutSeconds,
    description: fields.description,
    issuedAt: fields.issuedAt,
  };
}

export function computeChallengeHash(fields: ChallengeHashInput): string {
  return canonicalSha256(buildChallengeHashInput(fields));
}

/**
 * Fail closed unless the transport challenge matches the locked selection on
 * every bound field (version, scheme, network, asset, amount, payTo, resource,
 * maxTimeoutSeconds). Description must equal the demo fee label.
 */
export function assertExactChallenge(
  selected: SelectedPaymentOption,
  challenge: PaymentChallenge,
): void {
  const expected = expectedChallengeFields(selected);

  if (challenge.x402Version !== expected.x402Version) {
    throw new ReservationError(
      "CHALLENGE_MISMATCH",
      `x402Version must be ${expected.x402Version}`,
    );
  }
  if (challenge.scheme !== expected.scheme) {
    throw new ReservationError("CHALLENGE_MISMATCH", "scheme mismatch");
  }
  if (challenge.network !== expected.network) {
    throw new ReservationError("CHALLENGE_MISMATCH", "network mismatch");
  }
  if (challenge.asset !== expected.asset) {
    throw new ReservationError("CHALLENGE_MISMATCH", "asset mismatch");
  }
  if (challenge.amount !== expected.amount) {
    throw new ReservationError("CHALLENGE_MISMATCH", "amount mismatch");
  }
  if (challenge.payTo !== expected.payTo) {
    throw new ReservationError("CHALLENGE_MISMATCH", "payTo / recipient mismatch");
  }
  if (challenge.resource !== expected.resource) {
    throw new ReservationError("CHALLENGE_MISMATCH", "resource mismatch");
  }
  if (challenge.maxTimeoutSeconds !== expected.maxTimeoutSeconds) {
    throw new ReservationError(
      "CHALLENGE_MISMATCH",
      `maxTimeoutSeconds must be ${expected.maxTimeoutSeconds}`,
    );
  }
  if (challenge.description !== expected.description) {
    throw new ReservationError(
      "CHALLENGE_MISMATCH",
      "description must match demo reservation fee label",
    );
  }
  if (challenge.payTo !== selected.payTo) {
    throw new ReservationError("CHALLENGE_MISMATCH", "payTo mismatch");
  }
}

export function createPaymentChallengeRecord(
  selected: SelectedPaymentOption,
  challenge: PaymentChallenge,
  issuedAt: string,
): PaymentChallengeRecord {
  if (!isUtcIsoTimestamp(issuedAt)) {
    throw new ReservationError("INVALID_TIMESTAMP", "issuedAt must be UTC");
  }
  assertExactChallenge(selected, challenge);

  const hashInput: ChallengeHashInput = {
    x402Version: CHALLENGE_X402_VERSION,
    scheme: RESERVATION_SCHEME,
    network: RESERVATION_NETWORK,
    asset: challenge.asset,
    amount: challenge.amount,
    payTo: challenge.payTo,
    resource: challenge.resource,
    maxTimeoutSeconds: CHALLENGE_MAX_TIMEOUT_SECONDS,
    description: challenge.description,
    issuedAt,
  };
  const challengeHash = computeChallengeHash(hashInput);

  return Object.freeze({
    ...hashInput,
    challengeHash,
  });
}

/** Public PaymentChallenge view from a durable record (no hash/issuedAt required by clients). */
export function challengeFromRecord(
  record: PaymentChallengeRecord,
): PaymentChallenge {
  return {
    x402Version: record.x402Version,
    scheme: record.scheme,
    network: record.network,
    asset: record.asset,
    amount: record.amount,
    payTo: record.payTo,
    resource: record.resource,
    maxTimeoutSeconds: record.maxTimeoutSeconds,
    description: record.description,
  };
}

/** Full durable challenge including hash — returned for idempotent GET equality. */
export function durableChallengeView(
  record: PaymentChallengeRecord,
): PaymentChallenge & { challengeHash: string; issuedAt: string } {
  return {
    ...challengeFromRecord(record),
    challengeHash: record.challengeHash,
    issuedAt: record.issuedAt,
  };
}
