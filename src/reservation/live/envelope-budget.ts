/**
 * Conservative and actual ROUTE_RESERVED envelope byte budgeting.
 */

import { HCS_MAX_MESSAGE_BYTES } from "../../hcs/types";
import {
  buildRouteReservedPayload,
  createRouteReservedHcsEnvelope,
  measureRouteReservedEnvelope,
} from "../hcs-evidence";
import { createRouteReservedRecord } from "../route-reserved-record";
import {
  PHASE6B_CARRIER_ACCOUNT,
  PHASE6B_CLOSE_BARRIER_SEQUENCE,
  PHASE6B_HCS_TOPIC,
  PHASE6B_PAYER_ACCOUNT,
  PHASE6B_USDC_AMOUNT_ATOMIC,
  PHASE6B_USDC_TOKEN,
} from "./constants";

/** Max length of a Hedera transaction id string (account@seconds.nanos). */
const MAX_TX_ID =
  "0.0.999999999@9999999999.999999999"; // conservative upper bound length

/** 9-digit fractional consensus timestamp. */
const MAX_CONSENSUS_TS = "2026-12-31T23:59:59.123456789Z";

export function measureConservativeRouteReservedEnvelope(input: {
  reservationId: string;
  tenderId: string;
  tenderVersion: number;
  tenderHash: string;
  winningBidId: string;
  winningBidHash: string;
  carrierId: string;
  carrierAccount: string;
  decisionManifestHash: string;
  evaluatedBidSetHash: string;
}): { byteCount: number; margin: number; envelopeRunId: string } {
  const rr = createRouteReservedRecord({
    reservationId: input.reservationId,
    tenderId: input.tenderId,
    tenderVersion: input.tenderVersion,
    tenderHash: input.tenderHash,
    winningBidId: input.winningBidId,
    winningBidHash: input.winningBidHash,
    carrierId: input.carrierId,
    carrierAccount: input.carrierAccount,
    selectedOptionId: "USDC",
    paymentAsset: PHASE6B_USDC_TOKEN,
    paymentAmountAtomic: PHASE6B_USDC_AMOUNT_ATOMIC,
    payerAccount: PHASE6B_PAYER_ACCOUNT,
    transactionId: MAX_TX_ID,
    consensusTimestamp: MAX_CONSENSUS_TS,
    decisionManifestHash: input.decisionManifestHash,
    evaluatedBidSetHash: input.evaluatedBidSetHash,
    hcsAuctionTopicId: PHASE6B_HCS_TOPIC,
    closeBarrierSequence: PHASE6B_CLOSE_BARRIER_SEQUENCE,
    reservedAt: MAX_CONSENSUS_TS,
  });
  const runId = `reservation-${input.reservationId}`;
  const envelope = createRouteReservedHcsEnvelope({
    runId,
    tenderId: input.tenderId,
    tenderVersion: input.tenderVersion,
    tenderHash: input.tenderHash,
    createdAt: MAX_CONSENSUS_TS,
    payload: buildRouteReservedPayload(rr, input.carrierId),
  });
  const byteCount = measureRouteReservedEnvelope(envelope);
  return {
    byteCount,
    margin: HCS_MAX_MESSAGE_BYTES - byteCount,
    envelopeRunId: runId,
  };
}

export function measureActualRouteReservedEnvelope(input: {
  reservationId: string;
  tenderId: string;
  tenderVersion: number;
  tenderHash: string;
  winningBidId: string;
  winningBidHash: string;
  carrierId: string;
  carrierAccount: string;
  decisionManifestHash: string;
  evaluatedBidSetHash: string;
  transactionId: string;
  consensusTimestamp: string;
  createdAt: string;
}): { byteCount: number; margin: number } {
  const rr = createRouteReservedRecord({
    reservationId: input.reservationId,
    tenderId: input.tenderId,
    tenderVersion: input.tenderVersion,
    tenderHash: input.tenderHash,
    winningBidId: input.winningBidId,
    winningBidHash: input.winningBidHash,
    carrierId: input.carrierId,
    carrierAccount: input.carrierAccount,
    selectedOptionId: "USDC",
    paymentAsset: PHASE6B_USDC_TOKEN,
    paymentAmountAtomic: PHASE6B_USDC_AMOUNT_ATOMIC,
    payerAccount: PHASE6B_PAYER_ACCOUNT,
    transactionId: input.transactionId,
    consensusTimestamp: input.consensusTimestamp,
    decisionManifestHash: input.decisionManifestHash,
    evaluatedBidSetHash: input.evaluatedBidSetHash,
    hcsAuctionTopicId: PHASE6B_HCS_TOPIC,
    closeBarrierSequence: PHASE6B_CLOSE_BARRIER_SEQUENCE,
    reservedAt: input.consensusTimestamp,
  });
  const envelope = createRouteReservedHcsEnvelope({
    runId: `reservation-${input.reservationId}`,
    tenderId: input.tenderId,
    tenderVersion: input.tenderVersion,
    tenderHash: input.tenderHash,
    createdAt: input.createdAt,
    payload: buildRouteReservedPayload(rr, input.carrierId),
  });
  const byteCount = measureRouteReservedEnvelope(envelope);
  return { byteCount, margin: HCS_MAX_MESSAGE_BYTES - byteCount };
}

void PHASE6B_CARRIER_ACCOUNT;
