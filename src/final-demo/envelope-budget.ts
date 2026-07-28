/**
 * Conservative ROUTE_RESERVED envelope budgeting for final-demo (dynamic topic).
 */

import { HCS_MAX_MESSAGE_BYTES } from "../hcs/types";
import {
  buildRouteReservedPayload,
  createRouteReservedHcsEnvelope,
  measureRouteReservedEnvelope,
} from "../reservation/hcs-evidence";
import { createRouteReservedRecord } from "../reservation/route-reserved-record";
import {
  FINAL_DEMO_PAYER_ACCOUNT,
  FINAL_DEMO_USDC_AMOUNT_ATOMIC,
  FINAL_DEMO_USDC_TOKEN,
} from "./constants";
import { FinalDemoError } from "./errors";

const MAX_TX_ID = "0.0.999999999@9999999999.999999999";
const MAX_CONSENSUS_TS = "2026-12-31T23:59:59.123456789Z";
/** Conservative max topic id length for budgeting. */
const MAX_TOPIC_ID = "0.0.999999999";

export function measureFinalDemoConservativeEnvelope(input: {
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
  hcsTopicId?: string;
}): { byteCount: number; margin: number; envelopeRunId: string } {
  const topicId = input.hcsTopicId ?? MAX_TOPIC_ID;
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
    paymentAsset: FINAL_DEMO_USDC_TOKEN,
    paymentAmountAtomic: FINAL_DEMO_USDC_AMOUNT_ATOMIC,
    payerAccount: FINAL_DEMO_PAYER_ACCOUNT,
    transactionId: MAX_TX_ID,
    consensusTimestamp: MAX_CONSENSUS_TS,
    decisionManifestHash: input.decisionManifestHash,
    evaluatedBidSetHash: input.evaluatedBidSetHash,
    hcsAuctionTopicId: topicId,
    closeBarrierSequence: 4,
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
  if (byteCount >= HCS_MAX_MESSAGE_BYTES) {
    throw new FinalDemoError(
      `Conservative ROUTE_RESERVED envelope ${byteCount} exceeds ${HCS_MAX_MESSAGE_BYTES}`,
      "HCS_MESSAGE_TOO_LARGE",
    );
  }
  return {
    byteCount,
    margin: HCS_MAX_MESSAGE_BYTES - byteCount,
    envelopeRunId: runId,
  };
}

export function measureFinalDemoActualEnvelope(input: {
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
  hcsTopicId: string;
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
    paymentAsset: FINAL_DEMO_USDC_TOKEN,
    paymentAmountAtomic: FINAL_DEMO_USDC_AMOUNT_ATOMIC,
    payerAccount: FINAL_DEMO_PAYER_ACCOUNT,
    transactionId: input.transactionId,
    consensusTimestamp: input.consensusTimestamp,
    decisionManifestHash: input.decisionManifestHash,
    evaluatedBidSetHash: input.evaluatedBidSetHash,
    hcsAuctionTopicId: input.hcsTopicId,
    closeBarrierSequence: 4,
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
  if (byteCount >= HCS_MAX_MESSAGE_BYTES) {
    throw new FinalDemoError(
      `Actual ROUTE_RESERVED envelope ${byteCount} exceeds ${HCS_MAX_MESSAGE_BYTES}`,
      "HCS_MESSAGE_TOO_LARGE",
    );
  }
  return { byteCount, margin: HCS_MAX_MESSAGE_BYTES - byteCount };
}
