/**
 * Reconstruct runtime-authentic auction closure proof from sealed Phase 5
 * authoritative materials. Never trusts JSON-deserialized proofs.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import {
  createAuctionClosureProof,
  isVerifiedAuctionClosureProof,
  type VerifiedAuctionClosureProof,
} from "../../auction/closure-proof";
import { verifyDecisionManifestIntegrity } from "../../auction/decision-manifest";
import type { SignedAcceptanceReceipt } from "../../domain/acceptance-receipt";
import { bidHash, type SignedCarrierBid } from "../../domain/bid";
import {
  InMemoryCarrierRegistry,
  type CarrierRecord,
} from "../../domain/carrier";
import type { CommitmentEvidence } from "../../domain/commitment-evidence";
import { parseFreightTender, tenderHash } from "../../domain/tender";
import {
  AUTHORITATIVE_HASHES,
  AUTHORITATIVE_SOURCE_RELATIVE_PATH,
  PHASE5_LIVE_PUBLIC,
  PHASE6B_CARRIER_ACCOUNT,
  PHASE6B_CLOSE_BARRIER_SEQUENCE,
  PHASE6B_HCS_TOPIC,
  PHASE6B_TENDER_ID,
  PHASE6B_WINNING_BID_ID,
  PHASE6B_WINNING_CARRIER_ID,
} from "./constants";
import { Phase6bAttemptError } from "./attempt-store";

export type AuthoritativePhase5Source = {
  schemaVersion: string;
  tenderBody: unknown;
  tenderHash: string;
  auctionEndsAt: string;
  evaluationTimestamp: string;
  closeBarrierSequence: number;
  closeBarrierConsensusTimestamp: string;
  observedSequences: number[];
  reconciliationReference: string;
  hcsTopicId: string;
  routeGuardPublicKey: string;
  carriers: Array<
    CarrierRecord & { signingPrivateKeyHex?: string }
  >;
  signedBids: SignedCarrierBid[];
  signedReceipts: SignedAcceptanceReceipt[];
  commitments: CommitmentEvidence[];
  expected: {
    tenderId: string;
    winningBidId: string;
    winningBidHash: string;
    winningCarrierId: string;
    winningCarrierAccount: string;
    evaluatedBidSetHash: string;
    decisionManifestHash: string;
    tenderHash: string;
    hcsTopicId: string;
    closeBarrierSequence: number;
  };
};

export type ReconstructedPhase5Winner = {
  tender: ReturnType<typeof parseFreightTender>;
  tenderHash: string;
  registry: InMemoryCarrierRegistry;
  proof: VerifiedAuctionClosureProof;
  winningBidId: string;
  winningBidHash: string;
  winningCarrierId: string;
  winningCarrierAccount: string;
  evaluationTimestamp: string;
  auctionEndsAt: string;
  hcsTopicId: string;
  closeBarrierSequence: number;
  reconciliationReference: string;
  sourcePath: string;
};

export function resolveAuthoritativeSourcePath(
  overridePath?: string,
): string {
  return path.resolve(overridePath ?? AUTHORITATIVE_SOURCE_RELATIVE_PATH);
}

/**
 * Load sealed authoritative materials. Returns null if missing/unreadable
 * (caller maps to AUTHORITATIVE_AUCTION_MATERIAL_UNAVAILABLE).
 */
export function loadAuthoritativePhase5Source(
  sourcePath?: string,
): AuthoritativePhase5Source | null {
  const absolute = resolveAuthoritativeSourcePath(sourcePath);
  if (!existsSync(absolute)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(absolute, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const o = raw as AuthoritativePhase5Source;
    if (!o.tenderBody || !Array.isArray(o.signedBids) || !o.expected) {
      return null;
    }
    return o;
  } catch {
    return null;
  }
}

/**
 * Reconstruct runtime-authentic proof. Fails closed unless exact
 * AUTHORITATIVE_HASHES and public identities match.
 */
export function reconstructPhase5WinnerProof(
  options?: { sourcePath?: string; source?: AuthoritativePhase5Source },
): ReconstructedPhase5Winner {
  const source =
    options?.source ??
    loadAuthoritativePhase5Source(options?.sourcePath);
  if (!source) {
    throw new Phase6bAttemptError(
      "Authoritative Phase 5 auction materials unavailable — live path disabled",
      "AUTHORITATIVE_AUCTION_MATERIAL_UNAVAILABLE",
    );
  }

  const tender = parseFreightTender(source.tenderBody);
  const tHash = tenderHash(tender);
  if (tHash !== source.tenderHash || tHash !== AUTHORITATIVE_HASHES.tenderHash) {
    throw new Phase6bAttemptError(
      "Authoritative tenderHash mismatch after reparse",
      "HASH_MISMATCH",
    );
  }
  if (tHash !== PHASE5_LIVE_PUBLIC.tenderHash) {
    throw new Phase6bAttemptError(
      "Tender hash does not match live Phase 5 public tenderHash",
      "HASH_MISMATCH",
    );
  }

  const registry = new InMemoryCarrierRegistry(
    source.carriers.map((c) => ({
      carrierId: c.carrierId,
      carrierAccountId: c.carrierAccountId,
      signingPublicKey: c.signingPublicKey,
      active: c.active,
      allowedEquipment: c.allowedEquipment,
      registryVersion: c.registryVersion,
    })),
  );

  const fullBids = new Map<string, SignedCarrierBid>();
  for (const b of source.signedBids) {
    fullBids.set(b.bid.bidId, b);
  }
  const receipts = new Map<string, SignedAcceptanceReceipt>();
  for (const r of source.signedReceipts) {
    receipts.set(r.receipt.bidId, r);
  }

  const proof = createAuctionClosureProof({
    tender,
    auctionEndsAt: source.auctionEndsAt,
    closeBarrierSequence: source.closeBarrierSequence,
    closeBarrierConsensusTimestamp: source.closeBarrierConsensusTimestamp,
    reconciledStartSequence: 1,
    reconciledEndSequence: 4,
    observedSequences: source.observedSequences,
    evaluationTimestamp: source.evaluationTimestamp,
    reconciliationReference: source.reconciliationReference,
    commitments: source.commitments,
    fullBids,
    acceptanceReceipts: receipts,
    registry,
    routeGuardPublicKey: source.routeGuardPublicKey,
    now: source.evaluationTimestamp,
  });

  if (!isVerifiedAuctionClosureProof(proof) || !proof.integrityOk) {
    throw new Phase6bAttemptError(
      "Reconstructed proof is not runtime-authentic",
      "FORGED_PROOF",
    );
  }

  const integrity = verifyDecisionManifestIntegrity({
    manifest: proof.manifest,
    tender,
    results: proof.results,
    evaluationTimestamp: source.evaluationTimestamp,
    barrierSequence: source.closeBarrierSequence,
    reconciliationReference: source.reconciliationReference,
  });
  if (!integrity.ok) {
    throw new Phase6bAttemptError(
      `Manifest integrity failed: ${integrity.errors.join("; ")}`,
      "MANIFEST_INTEGRITY",
    );
  }

  // Public identity fail-closed
  if (tender.tenderId !== PHASE6B_TENDER_ID) {
    throw new Phase6bAttemptError("Tender ID mismatch", "TENDER_MISMATCH");
  }
  if (proof.manifest.winningBidId !== PHASE6B_WINNING_BID_ID) {
    throw new Phase6bAttemptError("Winner bid ID mismatch", "WINNER_MISMATCH");
  }
  if (proof.manifest.winningBidHash !== AUTHORITATIVE_HASHES.winningBidHash) {
    throw new Phase6bAttemptError(
      "winningBidHash mismatch vs authoritative expectation",
      "HASH_MISMATCH",
    );
  }
  if (
    proof.manifest.evaluatedBidSetHash !==
    AUTHORITATIVE_HASHES.evaluatedBidSetHash
  ) {
    throw new Phase6bAttemptError(
      "evaluatedBidSetHash mismatch vs authoritative expectation",
      "HASH_MISMATCH",
    );
  }
  if (
    proof.manifest.decisionManifestHash !==
    AUTHORITATIVE_HASHES.decisionManifestHash
  ) {
    throw new Phase6bAttemptError(
      "decisionManifestHash mismatch vs authoritative expectation",
      "HASH_MISMATCH",
    );
  }
  // Public-ID-only is never enough: hashes already required above.

  const winnerBid = fullBids.get(PHASE6B_WINNING_BID_ID);
  if (!winnerBid) {
    throw new Phase6bAttemptError("Winning full bid missing", "WINNER_MISMATCH");
  }
  if (winnerBid.bid.carrierAccountId !== PHASE6B_CARRIER_ACCOUNT) {
    throw new Phase6bAttemptError(
      "Winner carrier account mismatch",
      "CARRIER_MISMATCH",
    );
  }
  if (winnerBid.bid.carrierId !== PHASE6B_WINNING_CARRIER_ID) {
    throw new Phase6bAttemptError(
      "Winner carrier ID mismatch",
      "CARRIER_MISMATCH",
    );
  }
  if (bidHash(winnerBid.bid) !== AUTHORITATIVE_HASHES.winningBidHash) {
    throw new Phase6bAttemptError(
      "Winner bid rehash mismatch",
      "HASH_MISMATCH",
    );
  }
  if (source.hcsTopicId !== PHASE6B_HCS_TOPIC) {
    throw new Phase6bAttemptError("Topic mismatch", "WRONG_TOPIC");
  }
  if (source.closeBarrierSequence !== PHASE6B_CLOSE_BARRIER_SEQUENCE) {
    throw new Phase6bAttemptError("Barrier sequence mismatch", "BARRIER_MISMATCH");
  }
  if (proof.closeBarrierSequence !== PHASE6B_CLOSE_BARRIER_SEQUENCE) {
    throw new Phase6bAttemptError("Proof barrier sequence mismatch", "BARRIER_MISMATCH");
  }

  // Cross-check sealed expected block
  if (
    source.expected.evaluatedBidSetHash !==
      AUTHORITATIVE_HASHES.evaluatedBidSetHash ||
    source.expected.decisionManifestHash !==
      AUTHORITATIVE_HASHES.decisionManifestHash
  ) {
    throw new Phase6bAttemptError(
      "Sealed source expected hashes disagree with AUTHORITATIVE_HASHES constants",
      "HASH_MISMATCH",
    );
  }

  return {
    tender,
    tenderHash: tHash,
    registry,
    proof,
    winningBidId: PHASE6B_WINNING_BID_ID,
    winningBidHash: AUTHORITATIVE_HASHES.winningBidHash,
    winningCarrierId: PHASE6B_WINNING_CARRIER_ID,
    winningCarrierAccount: PHASE6B_CARRIER_ACCOUNT,
    evaluationTimestamp: source.evaluationTimestamp,
    auctionEndsAt: source.auctionEndsAt,
    hcsTopicId: PHASE6B_HCS_TOPIC,
    closeBarrierSequence: PHASE6B_CLOSE_BARRIER_SEQUENCE,
    reconciliationReference: source.reconciliationReference,
    sourcePath: resolveAuthoritativeSourcePath(options?.sourcePath),
  };
}

/**
 * Mutate sealed source for adversarial tests (does not write disk).
 */
export function cloneSource(
  source: AuthoritativePhase5Source,
): AuthoritativePhase5Source {
  return JSON.parse(JSON.stringify(source)) as AuthoritativePhase5Source;
}

export function assertReconstructedHashesMatch(
  reconstructed: ReconstructedPhase5Winner,
  expected: {
    evaluatedBidSetHash: string;
    decisionManifestHash: string;
    winningBidHash: string;
  },
): void {
  if (
    reconstructed.proof.manifest.evaluatedBidSetHash !==
    expected.evaluatedBidSetHash
  ) {
    throw new Phase6bAttemptError(
      "evaluatedBidSetHash mismatch vs expected",
      "HASH_MISMATCH",
    );
  }
  if (
    reconstructed.proof.manifest.decisionManifestHash !==
    expected.decisionManifestHash
  ) {
    throw new Phase6bAttemptError(
      "decisionManifestHash mismatch vs expected",
      "HASH_MISMATCH",
    );
  }
  if (reconstructed.winningBidHash !== expected.winningBidHash) {
    throw new Phase6bAttemptError(
      "winningBidHash mismatch vs expected",
      "HASH_MISMATCH",
    );
  }
}
