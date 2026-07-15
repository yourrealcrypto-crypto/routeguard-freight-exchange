/**
 * Verified winner input — requires authentic closure proof + independent winner check.
 */

import {
  isVerifiedAuctionClosureProof,
  type VerifiedAuctionClosureProof,
} from "../auction/closure-proof";
import { verifyDecisionManifestIntegrity } from "../auction/decision-manifest";
import { selectWinner } from "../auction/ranking";
import type { CarrierRegistry } from "../domain/carrier";
import type { FreightTender } from "../domain/tender";
import { isAfterUtc, isUtcIsoTimestamp } from "../domain/time";
import {
  ReservationError,
  type CreateReservationInput,
} from "./types";

export type ValidatedWinnerReservation = CreateReservationInput & {
  closureProof: VerifiedAuctionClosureProof;
};

/**
 * Validate reservation creation input against authentic auction proof.
 * Plain/spread/JSON proof objects fail closed via WeakSet identity.
 */
export function validateWinnerReservationInput(
  input: CreateReservationInput,
  registry: CarrierRegistry,
  tender?: FreightTender,
): ValidatedWinnerReservation {
  if (!isVerifiedAuctionClosureProof(input.closureProof)) {
    throw new ReservationError(
      "FORGED_PROOF",
      "closureProof is not a runtime-authentic VerifiedAuctionClosureProof",
    );
  }
  const proof = input.closureProof;

  if (!isUtcIsoTimestamp(input.createdAt) || !isUtcIsoTimestamp(input.expiresAt)) {
    throw new ReservationError(
      "INVALID_TIMESTAMP",
      "createdAt/expiresAt must be valid UTC ISO timestamps",
    );
  }
  if (!isAfterUtc(input.expiresAt, input.createdAt)) {
    throw new ReservationError(
      "INVALID_EXPIRY",
      "expiresAt must be after createdAt",
    );
  }
  if (!isUtcIsoTimestamp(input.closeBarrierConsensusTimestamp)) {
    throw new ReservationError(
      "INVALID_TIMESTAMP",
      "closeBarrierConsensusTimestamp must be UTC",
    );
  }

  if (input.tenderId !== proof.tenderId) {
    throw new ReservationError("TENDER_MISMATCH", "tenderId does not match proof");
  }
  if (input.tenderVersion !== proof.tenderVersion) {
    throw new ReservationError(
      "TENDER_MISMATCH",
      "tenderVersion does not match proof",
    );
  }
  if (input.tenderHash !== proof.manifest.tenderHash) {
    throw new ReservationError(
      "TENDER_MISMATCH",
      "tenderHash does not match proof manifest",
    );
  }
  if (input.closeBarrierSequence !== proof.closeBarrierSequence) {
    throw new ReservationError(
      "BARRIER_MISMATCH",
      "closeBarrierSequence does not match proof",
    );
  }
  if (
    input.closeBarrierConsensusTimestamp !==
    proof.closeBarrierConsensusTimestamp
  ) {
    throw new ReservationError(
      "BARRIER_MISMATCH",
      "closeBarrierConsensusTimestamp does not match proof",
    );
  }

  if (proof.manifest.decisionManifestHash !== input.decisionManifestHash) {
    throw new ReservationError(
      "MANIFEST_MISMATCH",
      "decisionManifestHash does not match proof",
    );
  }
  if (proof.manifest.evaluatedBidSetHash !== input.evaluatedBidSetHash) {
    throw new ReservationError(
      "MANIFEST_MISMATCH",
      "evaluatedBidSetHash does not match proof",
    );
  }

  if (!proof.integrityOk) {
    throw new ReservationError("PROOF_INTEGRITY", "Proof integrityOk is false");
  }

  if (tender) {
    if (tender.tenderId !== input.tenderId || tender.version !== input.tenderVersion) {
      throw new ReservationError(
        "TENDER_MISMATCH",
        "Provided tender does not match reservation identity",
      );
    }
    const integrity = verifyDecisionManifestIntegrity({
      tender,
      results: proof.results,
      evaluationTimestamp: proof.evaluationTimestamp,
      barrierSequence: proof.closeBarrierSequence,
      reconciliationReference: proof.reconciliationReference,
      manifest: proof.manifest,
    });
    if (!integrity.ok) {
      throw new ReservationError(
        "MANIFEST_INTEGRITY",
        integrity.errors.join("; "),
      );
    }
  }

  const ranked = selectWinner(proof.results);
  if (!ranked) {
    throw new ReservationError("NO_WINNER", "Proof has no ranked winner");
  }
  if (ranked.bidId !== input.winningBidId) {
    throw new ReservationError(
      "WRONG_WINNER",
      `winningBidId ${input.winningBidId} !== ranked ${ranked.bidId}`,
    );
  }
  if (ranked.bidHash !== input.winningBidHash) {
    throw new ReservationError(
      "WRONG_WINNER",
      "winningBidHash does not match independent ranking",
    );
  }
  if (proof.manifest.winningBidId !== input.winningBidId) {
    throw new ReservationError(
      "WRONG_WINNER",
      "manifest winningBidId mismatch",
    );
  }
  if (ranked.carrierId !== input.winningCarrierId) {
    throw new ReservationError(
      "WRONG_CARRIER",
      "winningCarrierId does not match ranked winner",
    );
  }

  const carrier = registry.getById(input.winningCarrierId);
  if (!carrier) {
    throw new ReservationError(
      "CARRIER_NOT_REGISTERED",
      `Carrier ${input.winningCarrierId} not registered`,
    );
  }
  if (carrier.carrierAccountId !== input.winningCarrierAccount) {
    throw new ReservationError(
      "WRONG_CARRIER_ACCOUNT",
      "winningCarrierAccount does not match registry",
    );
  }
  if (!carrier.active) {
    throw new ReservationError("CARRIER_INACTIVE", "Winner carrier is inactive");
  }

  return input as ValidatedWinnerReservation;
}
