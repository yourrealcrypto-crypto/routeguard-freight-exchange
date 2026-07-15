/**
 * Canonical ROUTE_RESERVED record and deterministic hash.
 */

import { assertSha256Hash, canonicalSha256 } from "../domain/canonical-hash";
import { isValidHederaAccountId } from "../domain/payment-option";
import { isUtcIsoTimestamp } from "../domain/time";
import {
  RESERVATION_NETWORK,
  RESERVATION_SCHEMA_VERSION,
  ReservationError,
  type ReservationOptionId,
  type RouteReservedRecord,
} from "./types";

export type RouteReservedRecordBody = Omit<
  RouteReservedRecord,
  "reservationRecordHash"
>;

export function buildRouteReservedRecordBody(input: {
  reservationId: string;
  tenderId: string;
  tenderVersion: number;
  tenderHash: string;
  winningBidId: string;
  winningBidHash: string;
  carrierId: string;
  carrierAccount: string;
  selectedOptionId: ReservationOptionId;
  paymentAsset: string;
  paymentAmountAtomic: string;
  payerAccount: string;
  transactionId: string;
  consensusTimestamp: string;
  decisionManifestHash: string;
  evaluatedBidSetHash: string;
  hcsAuctionTopicId: string;
  closeBarrierSequence: number;
  reservedAt: string;
}): RouteReservedRecordBody {
  assertSha256Hash(input.tenderHash);
  assertSha256Hash(input.winningBidHash);
  assertSha256Hash(input.decisionManifestHash);
  assertSha256Hash(input.evaluatedBidSetHash);
  if (!isValidHederaAccountId(input.carrierAccount)) {
    throw new ReservationError("INVALID_RECORD", "carrierAccount invalid");
  }
  if (!isValidHederaAccountId(input.payerAccount)) {
    throw new ReservationError("INVALID_RECORD", "payerAccount invalid");
  }
  if (!isUtcIsoTimestamp(input.consensusTimestamp)) {
    throw new ReservationError(
      "INVALID_RECORD",
      "consensusTimestamp must be UTC",
    );
  }
  if (!isUtcIsoTimestamp(input.reservedAt)) {
    throw new ReservationError("INVALID_RECORD", "reservedAt must be UTC");
  }
  if (!input.transactionId.trim()) {
    throw new ReservationError("INVALID_RECORD", "transactionId required");
  }

  return {
    schemaVersion: RESERVATION_SCHEMA_VERSION,
    reservationId: input.reservationId,
    tenderId: input.tenderId,
    tenderVersion: input.tenderVersion,
    tenderHash: input.tenderHash,
    winningBidId: input.winningBidId,
    winningBidHash: input.winningBidHash,
    carrierId: input.carrierId,
    carrierAccount: input.carrierAccount,
    selectedOptionId: input.selectedOptionId,
    paymentNetwork: RESERVATION_NETWORK,
    paymentAsset: input.paymentAsset,
    paymentAmountAtomic: input.paymentAmountAtomic,
    payerAccount: input.payerAccount,
    transactionId: input.transactionId,
    consensusTimestamp: input.consensusTimestamp,
    decisionManifestHash: input.decisionManifestHash,
    evaluatedBidSetHash: input.evaluatedBidSetHash,
    hcsAuctionTopicId: input.hcsAuctionTopicId,
    closeBarrierSequence: input.closeBarrierSequence,
    reservedAt: input.reservedAt,
  };
}

export function createRouteReservedRecord(
  input: Parameters<typeof buildRouteReservedRecordBody>[0],
): RouteReservedRecord {
  const body = buildRouteReservedRecordBody(input);
  return Object.freeze({
    ...body,
    reservationRecordHash: canonicalSha256(body),
  });
}

export function verifyRouteReservedRecordHash(
  record: RouteReservedRecord,
): boolean {
  const { reservationRecordHash: _h, ...body } = record;
  return canonicalSha256(body) === record.reservationRecordHash;
}
