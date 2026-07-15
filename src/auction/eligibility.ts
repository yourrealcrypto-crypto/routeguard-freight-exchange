import {
  acceptanceReceiptHash,
  parseAcceptanceReceiptBody,
  receiptMatchesBid,
  signedReceiptEnvelopeHash,
  verifyAcceptanceReceiptSignature,
  type SignedAcceptanceReceipt,
} from "../domain/acceptance-receipt";
import {
  bidHash,
  parseCarrierBid,
  signedBidEnvelopeHash,
  verifyCarrierBidSignature,
  type SignedCarrierBid,
} from "../domain/bid";
import type { CarrierRegistry } from "../domain/carrier";
import {
  isCommitmentTimely,
  parseCommitmentEvidence,
  type CommitmentEvidence,
} from "../domain/commitment-evidence";
import { compareCodePointStrings } from "../domain/canonical-hash";
import { assertPaymentRecipientsMatch } from "../domain/payment-option";
import type { FreightTender } from "../domain/tender";
import { isBeforeUtc } from "../domain/time";
import { hashSubmittedEvidenceOrNull } from "./evidence-hash";
import type {
  EligibilityReasonCode,
  EligibilityResult,
} from "./types";
import { REASON_CODE_ORDER } from "./types";

export type EvaluateBidInput = {
  tender: FreightTender;
  commitment: unknown;
  signedBid: SignedCarrierBid | unknown | undefined;
  signedReceipt: SignedAcceptanceReceipt | unknown | undefined;
  registry: CarrierRegistry;
  routeGuardPublicKey: string;
  evaluationTimestamp: string;
};

function orderReasonCodes(
  codes: Iterable<EligibilityReasonCode>,
): EligibilityReasonCode[] {
  const set = new Set(codes);
  return REASON_CODE_ORDER.filter((c) => set.has(c));
}

/**
 * Per-commitment fail-closed eligibility. Data-validation failures become
 * reason codes; they do not throw to abort sibling commitments.
 *
 * Submitted evidence is hashed before schema interpretation so malformed
 * content is still bound into evaluatedBidSetHash.
 */
export function evaluateCommitmentEligibility(
  input: EvaluateBidInput,
): EligibilityResult {
  const { tender, registry, evaluationTimestamp } = input;
  const reasonCodes = new Set<EligibilityReasonCode>();

  // Bind raw submitted evidence before schema interpretation.
  // Throws ReconciliationError for non-JSON-compatible runtime values.
  const submittedSignedBidPresent = input.signedBid !== undefined && input.signedBid !== null;
  const submittedReceiptPresent =
    input.signedReceipt !== undefined && input.signedReceipt !== null;
  const submittedSignedBidEnvelopeHash = hashSubmittedEvidenceOrNull(
    submittedSignedBidPresent ? input.signedBid : null,
  );
  const submittedReceiptEnvelopeHash = hashSubmittedEvidenceOrNull(
    submittedReceiptPresent ? input.signedReceipt : null,
  );

  const empty = (
    partial: Partial<EligibilityResult> & {
      bidId: string;
      carrierId: string;
      hcsSequence: number;
      consensusTimestamp: string;
    },
  ): EligibilityResult => {
    const ordered = orderReasonCodes(reasonCodes);
    return {
      bidId: partial.bidId,
      carrierId: partial.carrierId,
      decision: ordered.length === 0 ? "QUALIFIED" : "REJECTED",
      reasonCodes: ordered,
      freightPriceCents: partial.freightPriceCents ?? null,
      estimatedDelivery: partial.estimatedDelivery ?? null,
      consensusTimestamp: partial.consensusTimestamp,
      hcsSequence: partial.hcsSequence,
      bidHash: partial.bidHash ?? null,
      timely: partial.timely ?? false,
      submittedSignedBidPresent,
      submittedSignedBidEnvelopeHash,
      submittedReceiptPresent,
      submittedReceiptEnvelopeHash,
      fullBidSchemaValid: partial.fullBidSchemaValid ?? null,
      receiptSchemaValid: partial.receiptSchemaValid ?? null,
      fullBidPresent: partial.fullBidPresent ?? submittedSignedBidPresent,
      validatedFullBidHash: partial.validatedFullBidHash ?? null,
      signedBidEnvelopeHash: partial.signedBidEnvelopeHash ?? null,
      receiptPresent: partial.receiptPresent ?? submittedReceiptPresent,
      validatedReceiptHash: partial.validatedReceiptHash ?? null,
      bidVersionMatch: partial.bidVersionMatch ?? null,
      signatureValid: partial.signatureValid ?? null,
      commitment: partial.commitment ?? null,
    };
  };

  let commitment: CommitmentEvidence;
  try {
    commitment = parseCommitmentEvidence(input.commitment);
  } catch {
    reasonCodes.add("INVALID_COMMITMENT_SCHEMA");
    return empty({
      bidId: "unknown",
      carrierId: "unknown",
      hcsSequence: 0,
      consensusTimestamp: "1970-01-01T00:00:00.000000000Z",
    });
  }

  const timely = isCommitmentTimely(
    commitment.consensusTimestamp,
    tender.auctionEndsAt,
  );
  if (!timely) {
    reasonCodes.add("LATE_COMMITMENT");
  }

  if (commitment.tenderId !== tender.tenderId) {
    reasonCodes.add("TENDER_MISMATCH");
  }

  if (!submittedSignedBidPresent) {
    reasonCodes.add("FULL_BID_MISSING");
    return empty({
      bidId: commitment.bidId,
      carrierId: commitment.carrierId,
      hcsSequence: commitment.hcsSequence,
      consensusTimestamp: commitment.consensusTimestamp,
      timely,
      fullBidPresent: false,
      fullBidSchemaValid: null,
      commitment,
    });
  }

  let bid;
  let validatedFullBidHash: string | null = null;
  let envelopeHash: string | null = null;
  let fullBidSchemaValid = false;
  try {
    bid = parseCarrierBid(
      (input.signedBid as SignedCarrierBid).bid ?? input.signedBid,
    );
    // Prefer full envelope if present
    const envelopeCandidate =
      typeof input.signedBid === "object" &&
      input.signedBid !== null &&
      "bid" in (input.signedBid as object) &&
      "signature" in (input.signedBid as object)
        ? (input.signedBid as SignedCarrierBid)
        : { bid, signature: (input.signedBid as SignedCarrierBid).signature };

    validatedFullBidHash = bidHash(bid);
    if (
      typeof envelopeCandidate.signature === "string"
    ) {
      envelopeHash = signedBidEnvelopeHash({
        bid,
        signature: envelopeCandidate.signature,
      });
    }
    fullBidSchemaValid = true;
  } catch {
    reasonCodes.add("INVALID_BID_SCHEMA");
    return empty({
      bidId: commitment.bidId,
      carrierId: commitment.carrierId,
      hcsSequence: commitment.hcsSequence,
      consensusTimestamp: commitment.consensusTimestamp,
      timely,
      fullBidPresent: true,
      fullBidSchemaValid: false,
      commitment,
    });
  }

  const bidVersionMatch = bid.version === commitment.bidVersion;
  if (!bidVersionMatch) {
    reasonCodes.add("BID_VERSION_MISMATCH");
  }

  if (validatedFullBidHash !== commitment.bidHash) {
    reasonCodes.add("BID_HASH_MISMATCH");
  }

  if (bid.tenderId !== tender.tenderId || bid.bidId !== commitment.bidId) {
    reasonCodes.add("TENDER_MISMATCH");
  }

  if (bid.carrierId !== commitment.carrierId) {
    reasonCodes.add("CARRIER_ACCOUNT_MISMATCH");
  }

  let receiptSchemaValid: boolean | null = null;
  let validatedReceiptHash: string | null = null;
  if (!submittedReceiptPresent) {
    reasonCodes.add("ACCEPTANCE_RECEIPT_MISMATCH");
  } else {
    try {
      const rawReceipt = input.signedReceipt as SignedAcceptanceReceipt;
      const receiptBody =
        rawReceipt.receipt !== undefined
          ? rawReceipt.receipt
          : rawReceipt;
      const receipt = parseAcceptanceReceiptBody(receiptBody);
      validatedReceiptHash = acceptanceReceiptHash(receipt);
      receiptSchemaValid = true;

      if (
        typeof rawReceipt === "object" &&
        rawReceipt !== null &&
        "signature" in rawReceipt &&
        typeof rawReceipt.signature === "string"
      ) {
        // Validated envelope hash (schema-ok path)
        signedReceiptEnvelopeHash({
          receipt,
          signature: rawReceipt.signature,
        });
      }

      const matchOk = receiptMatchesBid(
        receipt,
        bid.bidId,
        tender.tenderId,
        validatedFullBidHash,
      );
      const hashOk =
        validatedReceiptHash === commitment.acceptanceReceiptHash;
      const sigOk =
        typeof rawReceipt === "object" &&
        rawReceipt !== null &&
        "signature" in rawReceipt
          ? verifyAcceptanceReceiptSignature(
              {
                receipt,
                signature: String(
                  (rawReceipt as SignedAcceptanceReceipt).signature,
                ),
              },
              input.routeGuardPublicKey,
            )
          : false;

      if (!matchOk || !hashOk || !sigOk) {
        reasonCodes.add("ACCEPTANCE_RECEIPT_MISMATCH");
      }
    } catch {
      receiptSchemaValid = false;
      reasonCodes.add("INVALID_ACCEPTANCE_RECEIPT");
    }
  }

  const carrier = registry.getById(bid.carrierId);
  let signatureValid: boolean | null = null;

  if (!carrier) {
    reasonCodes.add("CARRIER_NOT_REGISTERED");
  } else {
    if (!carrier.active) {
      reasonCodes.add("CARRIER_INACTIVE");
    }
    if (
      carrier.carrierId !== bid.carrierId ||
      carrier.carrierAccountId !== bid.carrierAccountId
    ) {
      reasonCodes.add("CARRIER_ACCOUNT_MISMATCH");
    }

    const sig =
      typeof input.signedBid === "object" &&
      input.signedBid !== null &&
      "signature" in (input.signedBid as object)
        ? String((input.signedBid as SignedCarrierBid).signature)
        : "";

    signatureValid = verifyCarrierBidSignature(
      { bid, signature: sig },
      carrier.signingPublicKey,
    );
    if (!signatureValid) {
      reasonCodes.add("INVALID_BID_SIGNATURE");
    }

    if (!carrier.allowedEquipment.includes(bid.equipment)) {
      reasonCodes.add("EQUIPMENT_NOT_AUTHORIZED");
    }
  }

  if (isBeforeUtc(bid.bidValidUntil, evaluationTimestamp)) {
    reasonCodes.add("BID_EXPIRED");
  }

  if (bid.equipment !== tender.requiredEquipment) {
    reasonCodes.add("EQUIPMENT_MISMATCH");
  }

  if (!bid.capacityConfirmed) {
    reasonCodes.add("CAPACITY_NOT_CONFIRMED");
  }

  if (
    isBeforeUtc(bid.proposedPickupAt, tender.pickupWindow.earliest) ||
    isBeforeUtc(tender.pickupWindow.latest, bid.proposedPickupAt)
  ) {
    reasonCodes.add("PICKUP_WINDOW_INFEASIBLE");
  }

  if (isBeforeUtc(tender.deliveryDeadline, bid.estimatedDelivery)) {
    reasonCodes.add("DELIVERY_DEADLINE_MISSED");
  }

  if (bid.freightPriceCents > tender.maximumFreightPriceCents) {
    reasonCodes.add("PRICE_ABOVE_MAXIMUM");
  }

  try {
    if (
      !assertPaymentRecipientsMatch(
        bid.reservationPaymentOptions,
        bid.carrierAccountId,
      )
    ) {
      reasonCodes.add("PAYMENT_RECIPIENT_MISMATCH");
    }
  } catch {
    reasonCodes.add("INVALID_PAYMENT_OPTIONS");
  }

  return empty({
    bidId: commitment.bidId,
    carrierId: commitment.carrierId,
    hcsSequence: commitment.hcsSequence,
    consensusTimestamp: commitment.consensusTimestamp,
    freightPriceCents: bid.freightPriceCents,
    estimatedDelivery: bid.estimatedDelivery,
    bidHash: validatedFullBidHash,
    timely,
    fullBidPresent: true,
    fullBidSchemaValid,
    receiptSchemaValid,
    validatedFullBidHash,
    signedBidEnvelopeHash: envelopeHash,
    receiptPresent: submittedReceiptPresent,
    validatedReceiptHash,
    bidVersionMatch,
    signatureValid,
    commitment,
  });
}

export function evaluateAllCommitments(
  tender: FreightTender,
  commitments: readonly unknown[],
  fullBids: ReadonlyMap<string, SignedCarrierBid | unknown>,
  acceptanceReceipts: ReadonlyMap<string, SignedAcceptanceReceipt | unknown>,
  registry: CarrierRegistry,
  routeGuardPublicKey: string,
  evaluationTimestamp: string,
): EligibilityResult[] {
  const results = commitments.map((commitment) => {
    const bidId =
      typeof commitment === "object" &&
      commitment !== null &&
      "bidId" in commitment &&
      typeof (commitment as { bidId: unknown }).bidId === "string"
        ? (commitment as { bidId: string }).bidId
        : undefined;

    return evaluateCommitmentEligibility({
      tender,
      commitment,
      signedBid: bidId ? fullBids.get(bidId) : undefined,
      signedReceipt: bidId ? acceptanceReceipts.get(bidId) : undefined,
      registry,
      routeGuardPublicKey,
      evaluationTimestamp,
    });
  });

  results.sort((a, b) => {
    if (a.hcsSequence !== b.hcsSequence) {
      return a.hcsSequence - b.hcsSequence;
    }
    return compareCodePointStrings(a.bidId, b.bidId);
  });

  return results;
}

/** Only timely QUALIFIED bids enter ranking. */
export function isRankable(result: EligibilityResult): boolean {
  return result.decision === "QUALIFIED" && result.timely;
}
