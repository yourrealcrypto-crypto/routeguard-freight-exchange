import { z } from "zod";

import type { SignedAcceptanceReceipt } from "../domain/acceptance-receipt";
import type { SignedCarrierBid } from "../domain/bid";
import type { CarrierRegistry } from "../domain/carrier";
import { isSafePositiveInteger } from "../domain/money";
import type { FreightTender } from "../domain/tender";
import { isBeforeOrEqualUtc, isUtcIsoTimestamp } from "../domain/time";
import {
  assertManifestIntegrity,
  buildDecisionManifest,
} from "./decision-manifest";
import { evaluateAllCommitments } from "./eligibility";
import {
  isSequenceRangeComplete,
  ReconciliationError,
  validateReconciliationInputs,
} from "./reconciliation";
import type { DecisionManifest, EligibilityResult } from "./types";

/**
 * Module-private registry of factory-created, independently verified proofs.
 * TypeScript structural types alone never authorize transitions.
 */
const verifiedClosureProofs = new WeakSet<object>();

/**
 * Runtime-authenticated closure proof. Instances are only valid when present
 * in the module-private WeakSet (created by createAuctionClosureProof).
 *
 * Spread copies, plain objects, and JSON round-trips are NOT authentic.
 * Persisted proofs must be rehydrated through createAuctionClosureProof.
 */
export type AuctionClosureProof = {
  readonly tenderId: string;
  readonly tenderVersion: number;
  readonly auctionEndsAt: string;
  readonly closeBarrierSequence: number;
  readonly closeBarrierConsensusTimestamp: string;
  readonly reconciledStartSequence: number;
  readonly reconciledEndSequence: number;
  readonly observedSequences: readonly number[];
  /** Derived; recomputed by consumers via isSequenceRangeComplete. */
  readonly completeness: boolean;
  readonly evaluationTimestamp: string;
  readonly reconciliationReference: string;
  readonly manifest: DecisionManifest;
  /** Derived; only true for WeakSet-registered factory results. */
  readonly integrityOk: boolean;
  readonly results: readonly EligibilityResult[];
};

export type VerifiedAuctionClosureProof = AuctionClosureProof;

/**
 * Returns true only for objects produced by createAuctionClosureProof in this
 * process and still registered in the private WeakSet.
 */
export function isVerifiedAuctionClosureProof(
  value: unknown,
): value is VerifiedAuctionClosureProof {
  return (
    typeof value === "object" &&
    value !== null &&
    verifiedClosureProofs.has(value)
  );
}

const ClosureInputSchema = z.object({
  tender: z.custom<FreightTender>(),
  auctionEndsAt: z.string(),
  closeBarrierSequence: z.number(),
  closeBarrierConsensusTimestamp: z.string(),
  reconciledStartSequence: z.number(),
  reconciledEndSequence: z.number(),
  observedSequences: z.array(z.number()),
  evaluationTimestamp: z.string(),
  reconciliationReference: z.string().min(1),
  commitments: z.array(z.unknown()),
  fullBids: z.custom<
    ReadonlyMap<string, SignedCarrierBid> | Iterable<[string, SignedCarrierBid]>
  >(),
  acceptanceReceipts: z.custom<
    | ReadonlyMap<string, SignedAcceptanceReceipt>
    | Iterable<[string, SignedAcceptanceReceipt]>
  >(),
  registry: z.custom<CarrierRegistry>(),
  routeGuardPublicKey: z.string().min(1),
  now: z.string(),
});

/**
 * Pure factory: independently verifies all closure invariants from source
 * evidence, then returns a WeakSet-registered authentic proof.
 */
export function createAuctionClosureProof(
  raw: z.input<typeof ClosureInputSchema>,
): VerifiedAuctionClosureProof {
  const input = ClosureInputSchema.parse(raw);
  const tender = input.tender;

  if (!isUtcIsoTimestamp(input.auctionEndsAt)) {
    throw new ReconciliationError(
      "INVALID_CLOSURE_PROOF",
      "invalid auctionEndsAt",
    );
  }
  if (input.auctionEndsAt !== tender.auctionEndsAt) {
    throw new ReconciliationError(
      "INVALID_CLOSURE_PROOF",
      "auctionEndsAt does not match tender",
    );
  }
  if (!isUtcIsoTimestamp(input.closeBarrierConsensusTimestamp)) {
    throw new ReconciliationError(
      "INVALID_CLOSURE_PROOF",
      "invalid closeBarrierConsensusTimestamp",
    );
  }
  if (!isUtcIsoTimestamp(input.evaluationTimestamp)) {
    throw new ReconciliationError(
      "INVALID_CLOSURE_PROOF",
      "invalid evaluationTimestamp",
    );
  }
  if (!isUtcIsoTimestamp(input.now)) {
    throw new ReconciliationError("INVALID_CLOSURE_PROOF", "invalid now");
  }

  for (const n of [
    input.closeBarrierSequence,
    input.reconciledStartSequence,
    input.reconciledEndSequence,
    ...input.observedSequences,
  ]) {
    if (!isSafePositiveInteger(n)) {
      throw new ReconciliationError(
        "INVALID_CLOSURE_PROOF",
        "sequence numbers must be positive safe integers",
      );
    }
  }

  if (!isBeforeOrEqualUtc(input.auctionEndsAt, input.now)) {
    throw new ReconciliationError(
      "INVALID_CLOSURE_PROOF",
      "auction deadline not reached",
    );
  }

  if (
    !isBeforeOrEqualUtc(
      input.auctionEndsAt,
      input.closeBarrierConsensusTimestamp,
    )
  ) {
    throw new ReconciliationError(
      "INVALID_CLOSURE_PROOF",
      "close barrier timestamp is before auctionEndsAt",
    );
  }

  const completeness = isSequenceRangeComplete(
    input.reconciledStartSequence,
    input.reconciledEndSequence,
    input.observedSequences,
  );

  const reconciled = validateReconciliationInputs({
    commitments: input.commitments,
    fullBids: input.fullBids,
    acceptanceReceipts: input.acceptanceReceipts,
  });

  for (const s of reconciled.commitments.map((c) => c.hcsSequence)) {
    if (!input.observedSequences.includes(s)) {
      throw new ReconciliationError(
        "INCOMPLETE_SEQUENCE_RANGE",
        `commitment sequence ${s} missing from observedSequences`,
      );
    }
  }

  const results = evaluateAllCommitments(
    tender,
    reconciled.commitments,
    reconciled.fullBids,
    reconciled.acceptanceReceipts,
    input.registry,
    input.routeGuardPublicKey,
    input.evaluationTimestamp,
  );

  const manifest = buildDecisionManifest({
    tender,
    commitments: input.commitments,
    fullBids: input.fullBids,
    acceptanceReceipts: input.acceptanceReceipts,
    registry: input.registry,
    routeGuardPublicKey: input.routeGuardPublicKey,
    evaluationTimestamp: input.evaluationTimestamp,
    barrierSequence: input.closeBarrierSequence,
    reconciliationReference: input.reconciliationReference,
  });

  if (
    manifest.tenderId !== tender.tenderId ||
    manifest.tenderVersion !== tender.version
  ) {
    throw new ReconciliationError(
      "INVALID_CLOSURE_PROOF",
      "manifest tender identity mismatch",
    );
  }

  // Manifest must match authoritative evaluation (not merely self-hash).
  assertManifestIntegrity(
    manifest,
    tender,
    results,
    input.evaluationTimestamp,
    input.closeBarrierSequence,
    input.reconciliationReference,
  );

  // All commitments must belong to this tender (fail closed).
  for (const c of reconciled.commitments) {
    if (c.tenderId !== tender.tenderId) {
      throw new ReconciliationError(
        "INVALID_CLOSURE_PROOF",
        `commitment tenderId ${c.tenderId} does not match tender ${tender.tenderId}`,
      );
    }
  }

  const proof = Object.freeze({
    tenderId: tender.tenderId,
    tenderVersion: tender.version,
    auctionEndsAt: input.auctionEndsAt,
    closeBarrierSequence: input.closeBarrierSequence,
    closeBarrierConsensusTimestamp: input.closeBarrierConsensusTimestamp,
    reconciledStartSequence: input.reconciledStartSequence,
    reconciledEndSequence: input.reconciledEndSequence,
    observedSequences: Object.freeze([...input.observedSequences]),
    completeness,
    evaluationTimestamp: input.evaluationTimestamp,
    reconciliationReference: input.reconciliationReference,
    manifest: Object.freeze({
      ...manifest,
      commitments: Object.freeze([...manifest.commitments]),
    }) as DecisionManifest,
    integrityOk: true as const,
    results: Object.freeze([...results]),
  }) as AuctionClosureProof;

  verifiedClosureProofs.add(proof);
  return proof;
}

/**
 * Explicit rehydration path for persisted/untrusted proof-shaped data.
 * Always re-verifies from source evidence; never trusts booleans on the blob.
 */
export function reverifyAuctionClosureProofFromSource(
  raw: z.input<typeof ClosureInputSchema>,
): VerifiedAuctionClosureProof {
  return createAuctionClosureProof(raw);
}
