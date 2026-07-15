import type { SignedAcceptanceReceipt } from "../domain/acceptance-receipt";
import type { SignedCarrierBid } from "../domain/bid";
import type { CarrierRegistry } from "../domain/carrier";
import {
  canonicalSha256,
  compareCodePointStrings,
} from "../domain/canonical-hash";
import type { CommitmentEvidence } from "../domain/commitment-evidence";
import { isCommitmentTimely } from "../domain/commitment-evidence";
import { tenderHash, type FreightTender } from "../domain/tender";
import { isUtcIsoTimestamp } from "../domain/time";
import {
  evaluateAllCommitments,
  isRankable,
} from "./eligibility";
import { selectWinner } from "./ranking";
import {
  ReconciliationError,
  validateReconciliationInputs,
} from "./reconciliation";
import { computeRulesHash } from "./rules";
import {
  ENGINE_VERSION,
  SELECTION_POLICY,
  type DecisionManifest,
  type EligibilityResult,
  type ManifestEntry,
} from "./types";

/**
 * Stable input for evaluatedBidSetHash — commits to submitted evidence AND
 * validated interpretation / decision for every commitment.
 */
export function buildEvaluatedBidSetInput(
  tender: FreightTender,
  results: readonly EligibilityResult[],
): unknown {
  const entries = [...results]
    .slice()
    .sort((a, b) => {
      if (a.hcsSequence !== b.hcsSequence) {
        return a.hcsSequence - b.hcsSequence;
      }
      return compareCodePointStrings(a.bidId, b.bidId);
    })
    .map((r) => {
      const c = r.commitment;
      const timely =
        c !== null
          ? isCommitmentTimely(c.consensusTimestamp, tender.auctionEndsAt)
          : r.timely;

      return {
        commitment: c
          ? {
              tenderId: c.tenderId,
              bidId: c.bidId,
              carrierId: c.carrierId,
              bidHash: c.bidHash,
              acceptanceReceiptHash: c.acceptanceReceiptHash,
              bidVersion: c.bidVersion,
              hcsSequence: c.hcsSequence,
              consensusTimestamp: c.consensusTimestamp,
              timely,
            }
          : null,
        // Submitted evidence (binds malformed content)
        submittedSignedBidPresent: r.submittedSignedBidPresent,
        submittedSignedBidEnvelopeHash: r.submittedSignedBidEnvelopeHash,
        submittedReceiptPresent: r.submittedReceiptPresent,
        submittedReceiptEnvelopeHash: r.submittedReceiptEnvelopeHash,
        // Validated interpretation
        fullBidSchemaValid: r.fullBidSchemaValid,
        receiptSchemaValid: r.receiptSchemaValid,
        fullBidPresent: r.fullBidPresent,
        validatedFullBidHash: r.validatedFullBidHash,
        signedBidEnvelopeHash: r.signedBidEnvelopeHash,
        receiptPresent: r.receiptPresent,
        validatedReceiptHash: r.validatedReceiptHash,
        bidVersionMatch: r.bidVersionMatch,
        signatureValid: r.signatureValid,
        decision: r.decision,
        reasonCodes: [...r.reasonCodes],
      };
    });

  return {
    tenderId: tender.tenderId,
    tenderVersion: tender.version,
    entries,
  };
}

export function computeEvaluatedBidSetHash(
  tender: FreightTender,
  results: readonly EligibilityResult[],
): string {
  return canonicalSha256(buildEvaluatedBidSetInput(tender, results));
}

/**
 * Independently reconstruct expected manifest body from tender + evaluation results.
 * Does not trust a caller-supplied manifest for content.
 */
export function reconstructExpectedManifestBody(
  tender: FreightTender,
  results: readonly EligibilityResult[],
  evaluationTimestamp: string,
  barrierSequence: number,
  reconciliationReference: string,
): Omit<DecisionManifest, "decisionManifestHash"> {
  const orderedResults = [...results].sort((a, b) => {
    if (a.hcsSequence !== b.hcsSequence) {
      return a.hcsSequence - b.hcsSequence;
    }
    return compareCodePointStrings(a.bidId, b.bidId);
  });

  const commitments: ManifestEntry[] = orderedResults.map((result) => ({
    bidId: result.bidId,
    carrierId: result.carrierId,
    hcsSequence: result.hcsSequence,
    consensusTimestamp: result.consensusTimestamp,
    decision: result.decision,
    reasonCodes: [...result.reasonCodes],
  }));

  const winner = selectWinner(orderedResults);

  return {
    tenderId: tender.tenderId,
    tenderVersion: tender.version,
    tenderHash: tenderHash(tender),
    engineVersion: ENGINE_VERSION,
    selectionPolicy: SELECTION_POLICY,
    rulesHash: computeRulesHash(),
    evaluationTimestamp,
    barrierSequence,
    reconciliationReference,
    commitments,
    winningBidId: winner?.bidId ?? null,
    winningBidHash: winner?.bidHash ?? null,
    evaluatedBidSetHash: computeEvaluatedBidSetHash(tender, orderedResults),
  };
}

export function buildDecisionManifest(input: {
  tender: FreightTender;
  commitments: unknown[];
  fullBids:
    | ReadonlyMap<string, SignedCarrierBid>
    | Iterable<[string, SignedCarrierBid]>;
  acceptanceReceipts:
    | ReadonlyMap<string, SignedAcceptanceReceipt>
    | Iterable<[string, SignedAcceptanceReceipt]>;
  registry: CarrierRegistry;
  routeGuardPublicKey: string;
  evaluationTimestamp: string;
  barrierSequence: number;
  reconciliationReference: string;
}): DecisionManifest {
  if (!isUtcIsoTimestamp(input.evaluationTimestamp)) {
    throw new Error(
      "evaluationTimestamp must be a valid UTC ISO-8601 timestamp",
    );
  }

  const reconciled = validateReconciliationInputs({
    commitments: input.commitments,
    fullBids: input.fullBids,
    acceptanceReceipts: input.acceptanceReceipts,
  });

  const results = evaluateAllCommitments(
    input.tender,
    reconciled.commitments,
    reconciled.fullBids,
    reconciled.acceptanceReceipts,
    input.registry,
    input.routeGuardPublicKey,
    input.evaluationTimestamp,
  );

  const body = reconstructExpectedManifestBody(
    input.tender,
    results,
    input.evaluationTimestamp,
    input.barrierSequence,
    input.reconciliationReference,
  );

  return {
    ...body,
    decisionManifestHash: canonicalSha256(body),
  };
}

export function evaluateAuction(params: {
  tender: FreightTender;
  commitments: CommitmentEvidence[] | unknown[];
  fullBids: ReadonlyMap<string, SignedCarrierBid>;
  acceptanceReceipts: ReadonlyMap<string, SignedAcceptanceReceipt>;
  registry: CarrierRegistry;
  routeGuardPublicKey: string;
  evaluationTimestamp: string;
  barrierSequence: number;
  reconciliationReference: string;
}): DecisionManifest {
  return buildDecisionManifest(params);
}

/**
 * Authoritative evaluation snapshot used for independent manifest verification.
 */
export type AuthoritativeEvaluationSnapshot = {
  tender: FreightTender;
  results: readonly EligibilityResult[];
  evaluationTimestamp: string;
  barrierSequence: number;
  reconciliationReference: string;
};

export type ManifestIntegrityResult = {
  ok: boolean;
  errors: string[];
};

/**
 * Verify a supplied manifest against an independently reconstructed expected
 * result from the authoritative evaluation snapshot — not against the
 * manifest's own entries alone.
 */
export function verifyDecisionManifestIntegrity(
  args:
    | {
        tender: FreightTender;
        results: readonly EligibilityResult[];
        evaluationTimestamp: string;
        barrierSequence: number;
        reconciliationReference: string;
        manifest: DecisionManifest;
      }
    | {
        // Legacy positional-compatible overload shape via object
        manifest: DecisionManifest;
        tender: FreightTender;
        results: readonly EligibilityResult[];
        evaluationTimestamp?: string;
        barrierSequence?: number;
        reconciliationReference?: string;
      },
): ManifestIntegrityResult {
  const errors: string[] = [];
  const {
    tender,
    results,
    manifest,
  } = args;

  const evaluationTimestamp =
    "evaluationTimestamp" in args && args.evaluationTimestamp
      ? args.evaluationTimestamp
      : manifest.evaluationTimestamp;
  const barrierSequence =
    "barrierSequence" in args && args.barrierSequence !== undefined
      ? args.barrierSequence
      : manifest.barrierSequence;
  const reconciliationReference =
    "reconciliationReference" in args && args.reconciliationReference
      ? args.reconciliationReference
      : manifest.reconciliationReference;

  // Independently reconstruct the entire expected manifest body.
  const expectedBody = reconstructExpectedManifestBody(
    tender,
    results,
    evaluationTimestamp,
    barrierSequence,
    reconciliationReference,
  );
  const expectedHash = canonicalSha256(expectedBody);

  if (manifest.tenderId !== expectedBody.tenderId) {
    errors.push("tenderId mismatch vs authoritative evaluation");
  }
  if (manifest.tenderVersion !== expectedBody.tenderVersion) {
    errors.push("tenderVersion mismatch vs authoritative evaluation");
  }
  if (manifest.tenderHash !== expectedBody.tenderHash) {
    errors.push("tenderHash mismatch vs authoritative evaluation");
  }
  if (manifest.rulesHash !== expectedBody.rulesHash) {
    errors.push("rulesHash mismatch vs authoritative evaluation");
  }
  if (manifest.engineVersion !== expectedBody.engineVersion) {
    errors.push("engineVersion mismatch");
  }
  if (manifest.selectionPolicy !== expectedBody.selectionPolicy) {
    errors.push("selectionPolicy mismatch");
  }
  if (manifest.evaluationTimestamp !== expectedBody.evaluationTimestamp) {
    errors.push("evaluationTimestamp mismatch vs authoritative evaluation");
  }
  if (manifest.barrierSequence !== expectedBody.barrierSequence) {
    errors.push("barrierSequence mismatch vs authoritative evaluation");
  }
  if (
    manifest.reconciliationReference !== expectedBody.reconciliationReference
  ) {
    errors.push(
      "reconciliationReference mismatch vs authoritative evaluation",
    );
  }
  if (manifest.evaluatedBidSetHash !== expectedBody.evaluatedBidSetHash) {
    errors.push("evaluatedBidSetHash mismatch vs authoritative evaluation");
  }
  if (manifest.winningBidId !== expectedBody.winningBidId) {
    errors.push("winningBidId mismatch vs authoritative ranking");
  }
  if (manifest.winningBidHash !== expectedBody.winningBidHash) {
    errors.push("winningBidHash mismatch vs authoritative ranking");
  }

  // Exact entry count and deterministic order vs authoritative results.
  if (manifest.commitments.length !== expectedBody.commitments.length) {
    errors.push(
      `entry count mismatch: manifest ${manifest.commitments.length} vs expected ${expectedBody.commitments.length}`,
    );
  }

  const n = Math.max(
    manifest.commitments.length,
    expectedBody.commitments.length,
  );
  for (let i = 0; i < n; i++) {
    const actual = manifest.commitments[i];
    const expected = expectedBody.commitments[i];
    if (!actual || !expected) {
      errors.push(`missing entry at ordered index ${i}`);
      continue;
    }
    if (actual.bidId !== expected.bidId) {
      errors.push(`entry[${i}].bidId mismatch`);
    }
    if (actual.carrierId !== expected.carrierId) {
      errors.push(`entry[${i}].carrierId mismatch`);
    }
    if (actual.hcsSequence !== expected.hcsSequence) {
      errors.push(`entry[${i}].hcsSequence mismatch`);
    }
    if (actual.consensusTimestamp !== expected.consensusTimestamp) {
      errors.push(`entry[${i}].consensusTimestamp mismatch`);
    }
    if (actual.decision !== expected.decision) {
      errors.push(`entry[${i}].decision mismatch`);
    }
    if (
      actual.reasonCodes.length !== expected.reasonCodes.length ||
      actual.reasonCodes.some((c, j) => c !== expected.reasonCodes[j])
    ) {
      errors.push(`entry[${i}].reasonCodes mismatch`);
    }
  }

  // Uniqueness
  const bidIds = new Set<string>();
  const sequences = new Set<number>();
  for (const entry of manifest.commitments) {
    if (bidIds.has(entry.bidId)) {
      errors.push(`duplicate manifest bidId ${entry.bidId}`);
    }
    bidIds.add(entry.bidId);
    if (sequences.has(entry.hcsSequence)) {
      errors.push(`duplicate manifest hcsSequence ${entry.hcsSequence}`);
    }
    sequences.add(entry.hcsSequence);
  }

  // No-winner consistency from authoritative evaluation
  const qualified = results.filter(isRankable);
  if (expectedBody.winningBidId === null) {
    if (qualified.length !== 0) {
      errors.push("authoritative evaluation has qualified bids but null winner");
    }
  } else if (qualified.length < 1) {
    errors.push("authoritative winner present but zero rankable entries");
  }

  // Final: decisionManifestHash must match independently reconstructed body.
  if (manifest.decisionManifestHash !== expectedHash) {
    errors.push(
      "decisionManifestHash mismatch vs independently reconstructed expected manifest",
    );
  }

  // Also reject rehashed-but-wrong-content: hash of supplied body alone is not enough;
  // expectedHash already encodes authoritative content.
  const { decisionManifestHash: _omit, ...suppliedBody } = manifest;
  const suppliedSelfHash = canonicalSha256(suppliedBody);
  if (
    manifest.decisionManifestHash === suppliedSelfHash &&
    suppliedSelfHash !== expectedHash
  ) {
    errors.push(
      "manifest is self-consistent but does not match authoritative evaluation",
    );
  }

  return { ok: errors.length === 0, errors };
}

export function assertManifestIntegrity(
  manifest: DecisionManifest,
  tender: FreightTender,
  results: readonly EligibilityResult[],
  evaluationTimestamp?: string,
  barrierSequence?: number,
  reconciliationReference?: string,
): void {
  const check = verifyDecisionManifestIntegrity({
    manifest,
    tender,
    results,
    evaluationTimestamp: evaluationTimestamp ?? manifest.evaluationTimestamp,
    barrierSequence: barrierSequence ?? manifest.barrierSequence,
    reconciliationReference:
      reconciliationReference ?? manifest.reconciliationReference,
  });
  if (!check.ok) {
    throw new ReconciliationError(
      "MANIFEST_INTEGRITY_FAILURE",
      check.errors.join("; "),
    );
  }
}
