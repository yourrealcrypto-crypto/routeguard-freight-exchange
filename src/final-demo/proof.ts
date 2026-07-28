/**
 * Exact proof reconstruction from public materials + Mirror evidence.
 * No historical expected-hash constants — fresh-run values are the authority.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  createAuctionClosureProof,
  isVerifiedAuctionClosureProof,
  type VerifiedAuctionClosureProof,
} from "../auction/closure-proof";
import { verifyDecisionManifestIntegrity } from "../auction/decision-manifest";
import { bidHash, type SignedCarrierBid } from "../domain/bid";
import { InMemoryCarrierRegistry } from "../domain/carrier";
import type { SignedAcceptanceReceipt } from "../domain/acceptance-receipt";
import { parseFreightTender, tenderHash } from "../domain/tender";
import { FINAL_DEMO_WINNER_ACCOUNT } from "./constants";
import { FinalDemoError } from "./errors";
import {
  loadFinalDemoAuthoritativeMaterials,
  parseFinalDemoAuthoritativeMaterials,
  type FinalDemoAuthoritativeMaterials,
} from "./materials";
import type { FinalDemoReconciliationResult } from "./reconciliation";
import {
  reconcileFinalDemoSequences1to4,
  type FinalDemoMirrorWindow,
} from "./reconciliation";
import type { ObservedHcsMessage } from "../hcs/types";

export type FinalDemoReconstructedProof = {
  tender: ReturnType<typeof parseFreightTender>;
  tenderHash: string;
  registry: InMemoryCarrierRegistry;
  proof: VerifiedAuctionClosureProof;
  winningBidId: string;
  winningBidHash: string;
  winningCarrierId: string;
  winningCarrierAccount: string;
  evaluatedBidSetHash: string;
  decisionManifestHash: string;
  evaluationTimestamp: string;
  reconciliationReference: string;
  hcsTopicId: string;
  closeBarrierSequence: 4;
};

export function reconstructFinalDemoProof(input: {
  materials: FinalDemoAuthoritativeMaterials;
  reconciliation: FinalDemoReconciliationResult;
}): FinalDemoReconstructedProof {
  const { materials, reconciliation } = input;

  const tender = parseFreightTender(materials.tenderBody);
  const tHash = tenderHash(tender);
  if (tHash !== materials.tenderHash) {
    throw new FinalDemoError("Tender hash reparse mismatch", "HASH_MISMATCH");
  }
  if (tHash !== reconciliation.barrierEnvelope.payload.tenderHash) {
    throw new FinalDemoError(
      "Tender hash vs barrier mismatch",
      "HASH_MISMATCH",
    );
  }

  const registry = new InMemoryCarrierRegistry(
    materials.carriers.map((c) => ({
      carrierId: c.carrierId,
      carrierAccountId: c.carrierAccountId,
      signingPublicKey: c.signingPublicKey,
      active: c.active,
      allowedEquipment: c.allowedEquipment,
      registryVersion: c.registryVersion,
    })),
  );

  const fullBids = new Map<string, SignedCarrierBid>();
  for (const b of materials.signedBids) {
    fullBids.set(b.bid.bidId, b);
  }
  const receipts = new Map<string, SignedAcceptanceReceipt>();
  for (const r of materials.signedReceipts) {
    receipts.set(r.receipt.bidId, r);
  }

  const proof = createAuctionClosureProof({
    tender,
    auctionEndsAt: materials.auctionEndsAt,
    closeBarrierSequence: 4,
    closeBarrierConsensusTimestamp:
      reconciliation.closeBarrierConsensusTimestamp,
    reconciledStartSequence: 1,
    reconciledEndSequence: 4,
    observedSequences: [1, 2, 3, 4],
    evaluationTimestamp: reconciliation.evaluationTimestamp,
    reconciliationReference: reconciliation.reconciliationReference,
    commitments: reconciliation.commitmentEvidence,
    fullBids,
    acceptanceReceipts: receipts,
    registry,
    routeGuardPublicKey: materials.routeGuardPublicKey,
    now: reconciliation.evaluationTimestamp,
  });

  if (!isVerifiedAuctionClosureProof(proof) || !proof.integrityOk) {
    throw new FinalDemoError(
      "Reconstructed proof is not runtime-authentic",
      "FORGED_PROOF",
    );
  }

  const integrity = verifyDecisionManifestIntegrity({
    manifest: proof.manifest,
    tender,
    results: proof.results,
    evaluationTimestamp: reconciliation.evaluationTimestamp,
    barrierSequence: 4,
    reconciliationReference: reconciliation.reconciliationReference,
  });
  if (!integrity.ok) {
    throw new FinalDemoError(
      `Manifest integrity failed: ${integrity.errors.join("; ")}`,
      "MANIFEST_INTEGRITY",
    );
  }

  const winningBidId = proof.manifest.winningBidId;
  if (winningBidId !== materials.expectedWinner.bidId) {
    throw new FinalDemoError(
      `Deterministic winner bid mismatch: got ${winningBidId}`,
      "WINNER_MISMATCH",
    );
  }
  if (!winningBidId) {
    throw new FinalDemoError("No winning bid selected", "WINNER_MISMATCH");
  }

  const winnerBid = fullBids.get(winningBidId);
  if (!winnerBid) {
    throw new FinalDemoError("Winning bid missing", "WINNER_MISMATCH");
  }
  if (winnerBid.bid.carrierId !== materials.expectedWinner.carrierId) {
    throw new FinalDemoError("Winner carrier id mismatch", "WINNER_MISMATCH");
  }
  if (winnerBid.bid.carrierAccountId !== FINAL_DEMO_WINNER_ACCOUNT) {
    throw new FinalDemoError(
      "Winner account must be 0.0.9215954",
      "WRONG_RECEIVER",
    );
  }
  if (
    winnerBid.bid.carrierAccountId !== materials.expectedWinner.carrierAccountId
  ) {
    throw new FinalDemoError("Winner account vs materials", "WRONG_RECEIVER");
  }

  const winningBidHash = bidHash(winnerBid.bid);
  if (winningBidHash !== proof.manifest.winningBidHash) {
    throw new FinalDemoError("winningBidHash mismatch", "HASH_MISMATCH");
  }

  return {
    tender,
    tenderHash: tHash,
    registry,
    proof,
    winningBidId,
    winningBidHash,
    winningCarrierId: winnerBid.bid.carrierId,
    winningCarrierAccount: winnerBid.bid.carrierAccountId,
    evaluatedBidSetHash: proof.manifest.evaluatedBidSetHash,
    decisionManifestHash: proof.manifest.decisionManifestHash,
    evaluationTimestamp: reconciliation.evaluationTimestamp,
    reconciliationReference: reconciliation.reconciliationReference,
    hcsTopicId: reconciliation.topicId,
    closeBarrierSequence: 4,
  };
}

/**
 * True independent double reconstruction:
 * - two separate disk reads of materials
 * - two separate Mirror observation parses
 * - two independent createAuctionClosureProof calls
 */
export function doubleReconstructFinalDemoProofFromDisk(input: {
  materialsPath: string;
  mirrorMessages: ObservedHcsMessage[];
  topicId: string;
  runId: string;
  tenderId: string;
  tenderVersion: number;
  tenderHash: string;
  auctionEndsAt: string;
  expectedCommitmentEnvelopeHashes: [string, string];
  /** Test counters */
  onMaterialsRead?: (path: string) => void;
}): {
  first: FinalDemoReconstructedProof;
  second: FinalDemoReconstructedProof;
  finalHashes: {
    tenderHash: string;
    winningBidHash: string;
    evaluatedBidSetHash: string;
    decisionManifestHash: string;
  };
} {
  const materialsPath = path.resolve(input.materialsPath);

  // Pass A: independent disk read + parse + reconcile
  input.onMaterialsRead?.(materialsPath);
  const rawA = readFileSync(materialsPath, "utf8");
  const materialsA = parseFinalDemoAuthoritativeMaterials(JSON.parse(rawA));
  const messagesA = JSON.parse(
    JSON.stringify(input.mirrorMessages),
  ) as ObservedHcsMessage[];
  const reconA = reconcileFinalDemoSequences1to4(
    {
      topicId: input.topicId,
      runId: input.runId,
      tenderId: input.tenderId,
      tenderVersion: input.tenderVersion,
      tenderHash: input.tenderHash,
      auctionEndsAt: input.auctionEndsAt,
      messages: messagesA,
      expectedCommitmentEnvelopeHashes: input.expectedCommitmentEnvelopeHashes,
    },
    materialsA,
  );
  const first = reconstructFinalDemoProof({
    materials: materialsA,
    reconciliation: reconA,
  });

  // Pass B: second independent disk read + parse + reconcile (no clone of A)
  input.onMaterialsRead?.(materialsPath);
  const rawB = readFileSync(materialsPath, "utf8");
  const materialsB = parseFinalDemoAuthoritativeMaterials(JSON.parse(rawB));
  const messagesB = JSON.parse(
    JSON.stringify(input.mirrorMessages),
  ) as ObservedHcsMessage[];
  const reconB = reconcileFinalDemoSequences1to4(
    {
      topicId: input.topicId,
      runId: input.runId,
      tenderId: input.tenderId,
      tenderVersion: input.tenderVersion,
      tenderHash: input.tenderHash,
      auctionEndsAt: input.auctionEndsAt,
      messages: messagesB,
      expectedCommitmentEnvelopeHashes: input.expectedCommitmentEnvelopeHashes,
    },
    materialsB,
  );
  const second = reconstructFinalDemoProof({
    materials: materialsB,
    reconciliation: reconB,
  });

  if (first.winningBidId !== second.winningBidId) {
    throw new FinalDemoError(
      "Double reconstruction winner mismatch",
      "HASH_MISMATCH",
    );
  }
  if (first.winningBidHash !== second.winningBidHash) {
    throw new FinalDemoError(
      "Double reconstruction winningBidHash mismatch",
      "HASH_MISMATCH",
    );
  }
  if (first.evaluatedBidSetHash !== second.evaluatedBidSetHash) {
    throw new FinalDemoError(
      "Double reconstruction evaluatedBidSetHash mismatch",
      "HASH_MISMATCH",
    );
  }
  if (first.decisionManifestHash !== second.decisionManifestHash) {
    throw new FinalDemoError(
      "Double reconstruction decisionManifestHash mismatch",
      "HASH_MISMATCH",
    );
  }

  return {
    first,
    second,
    finalHashes: {
      tenderHash: first.tenderHash,
      winningBidHash: first.winningBidHash,
      evaluatedBidSetHash: first.evaluatedBidSetHash,
      decisionManifestHash: first.decisionManifestHash,
    },
  };
}

/**
 * @deprecated Prefer doubleReconstructFinalDemoProofFromDisk for true independence.
 * Kept for unit tests that inject already-loaded materials.
 */
export function doubleReconstructFinalDemoProof(input: {
  materialsA: FinalDemoAuthoritativeMaterials;
  materialsB: FinalDemoAuthoritativeMaterials;
  reconciliation: FinalDemoReconciliationResult;
}): {
  first: FinalDemoReconstructedProof;
  second: FinalDemoReconstructedProof;
  finalHashes: {
    tenderHash: string;
    winningBidHash: string;
    evaluatedBidSetHash: string;
    decisionManifestHash: string;
  };
} {
  const first = reconstructFinalDemoProof({
    materials: input.materialsA,
    reconciliation: input.reconciliation,
  });
  const second = reconstructFinalDemoProof({
    materials: input.materialsB,
    reconciliation: input.reconciliation,
  });

  if (first.winningBidId !== second.winningBidId) {
    throw new FinalDemoError("Double reconstruction winner mismatch", "HASH_MISMATCH");
  }
  if (first.winningBidHash !== second.winningBidHash) {
    throw new FinalDemoError(
      "Double reconstruction winningBidHash mismatch",
      "HASH_MISMATCH",
    );
  }
  if (first.evaluatedBidSetHash !== second.evaluatedBidSetHash) {
    throw new FinalDemoError(
      "Double reconstruction evaluatedBidSetHash mismatch",
      "HASH_MISMATCH",
    );
  }
  if (first.decisionManifestHash !== second.decisionManifestHash) {
    throw new FinalDemoError(
      "Double reconstruction decisionManifestHash mismatch",
      "HASH_MISMATCH",
    );
  }

  return {
    first,
    second,
    finalHashes: {
      tenderHash: first.tenderHash,
      winningBidHash: first.winningBidHash,
      evaluatedBidSetHash: first.evaluatedBidSetHash,
      decisionManifestHash: first.decisionManifestHash,
    },
  };
}

void loadFinalDemoAuthoritativeMaterials;
type _UnusedMirror = FinalDemoMirrorWindow;
