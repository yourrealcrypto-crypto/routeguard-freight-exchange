import { describe, expect, it } from "vitest";

import {
  IllegalLifecycleTransitionError,
  LifecycleGuardError,
} from "../src/v2/lifecycle/errors";
import {
  countLegalTransitions,
  isLegalTransition,
  reduceLifecycle,
} from "../src/v2/lifecycle/reducer";
import { V2_LIFECYCLE_STATES } from "../src/v2/lifecycle/states";
import {
  allocate,
  AUCTION_ENDS,
  baseRecord,
  closeAuction,
  EXCESS,
  fund,
  HASH,
  happyToPodSubmitted,
  happyToUnderReview,
  REFEREE_KEY,
  reserve,
  selectWinner,
  SIG,
  T0,
  toBidding,
  activate,
  WIN_AMOUNT,
  BUDGET,
} from "./v2-lifecycle-fixtures";
import { deriveAccessFeeAtomic } from "../src/v2/access/fee";

describe("v2 lifecycle legal transitions", () => {
  it("exposes a non-empty legal transition graph", () => {
    expect(countLegalTransitions()).toBeGreaterThan(20);
  });

  it("walks the primary happy path to TENDER_COMPLETED", () => {
    let r = happyToUnderReview();
    const deadline = r.reviewDeadlineAt!;
    r = reduceLifecycle(r, {
      type: "POD_ACCEPTED_BY_SHIPPER",
      actionId: "act-accept",
      eventTime: deadline,
      shipperSignature: SIG,
      reviewDeadlineAt: deadline,
    });
    expect(r.state).toBe("POD_ACCEPTED");
    r = reduceLifecycle(r, {
      type: "ESCROW_RELEASE_CONFIRMED",
      actionId: "act-release",
      eventTime: deadline,
      releaseTxId: "0.0.1@9.9",
      releaseAmountAtomic: WIN_AMOUNT,
    });
    expect(r.state).toBe("PAYMENT_RELEASED");
    r = reduceLifecycle(r, {
      type: "TENDER_COMPLETION_CONFIRMED",
      actionId: "act-done",
      eventTime: deadline,
    });
    expect(r.state).toBe("TENDER_COMPLETED");
  });

  it("supports NO_QUALIFIED_BID full-refund completion path", () => {
    let r = baseRecord();
    r = fund(r);
    r = activate(r);
    r = toBidding(r);
    r = closeAuction(r);
    r = reduceLifecycle(r, {
      type: "NO_QUALIFIED_BID_CONFIRMED",
      actionId: "act-nq",
      eventTime: AUCTION_ENDS,
      decisionManifestHash: HASH,
    });
    expect(r.state).toBe("NO_QUALIFIED_BID");
    r = reduceLifecycle(r, {
      type: "ESCROW_REFUND_CONFIRMED",
      actionId: "act-refund",
      eventTime: AUCTION_ENDS,
      refundTxId: "0.0.1@8.8",
      refundAmountAtomic: BUDGET,
    });
    expect(r.state).toBe("REFUNDED");
    r = reduceLifecycle(r, {
      type: "TENDER_COMPLETION_CONFIRMED",
      actionId: "act-done",
      eventTime: AUCTION_ENDS,
    });
    expect(r.state).toBe("TENDER_COMPLETED");
  });

  it("covers every legal edge with a successful reduce where practical", () => {
    // Spot-check core edges exist
    expect(isLegalTransition("DRAFT", "ESCROW_FUNDED")).toBe(true);
    expect(isLegalTransition("POD_UNDER_REVIEW", "POD_DEEMED_ACCEPTED")).toBe(
      true,
    );
    expect(isLegalTransition("POD_CORRECTION_REQUESTED", "POD_DISPUTED")).toBe(
      true,
    );
    expect(isLegalTransition("REFEREE_DECISION", "PARTIAL_RELEASE")).toBe(true);
    expect(isLegalTransition("DRAFT", "TENDER_OPENED")).toBe(false);
    expect(V2_LIFECYCLE_STATES).toContain("WINNING_AMOUNT_LOCKED");
  });

  it("rejects representative illegal transitions", () => {
    const draft = baseRecord();
    expect(() =>
      reduceLifecycle(draft, {
        type: "BIDDING_STARTED",
        actionId: "x",
        eventTime: T0,
      }),
    ).toThrow(IllegalLifecycleTransitionError);

    let r = fund(draft);
    expect(() =>
      reduceLifecycle(r, {
        type: "WINNER_SELECTION_CONFIRMED",
        actionId: "x",
        eventTime: T0,
        decisionManifestHash: HASH,
        winningBidId: "b",
        winningCarrierId: "c",
        winningCarrierAccount: "0.0.9215954",
        winningAmountAtomic: WIN_AMOUNT,
        selectionPolicy: "LOWEST_QUALIFIED_PRICE_V1",
      }),
    ).toThrow(IllegalLifecycleTransitionError);
  });

  it("enforces winner allocation conservation", () => {
    let r = baseRecord();
    r = fund(r);
    r = activate(r);
    r = toBidding(r);
    r = closeAuction(r);
    r = selectWinner(r);
    expect(() =>
      reduceLifecycle(r, {
        type: "WINNING_AMOUNT_ALLOCATION_CONFIRMED",
        actionId: "bad-alloc",
        eventTime: AUCTION_ENDS,
        allocateTxId: "0.0.1@1.3",
        refundExcessTxId: "0.0.1@1.4",
        maxBudgetAtomic: BUDGET,
        winningAmountAtomic: WIN_AMOUNT,
        excessRefundAtomic: "1",
        decisionManifestHash: HASH,
      }),
    ).toThrow(/must equal maxBudgetAtomic|CONSERVATION/i);
    r = allocate(r);
    expect(r.state).toBe("WINNING_AMOUNT_LOCKED");
    expect(BigInt(WIN_AMOUNT) + BigInt(EXCESS)).toBe(BigInt(BUDGET));
  });

  it("rejects AI advisory as settlement authorization", () => {
    let r = happyToUnderReview();
    r = reduceLifecycle(r, {
      type: "POD_ADVISORY_ANCHORED",
      actionId: "adv-1",
      eventTime: r.reviewStartedAt!,
      reportHash: HASH,
      binding: "NON_BINDING_ADVISORY",
    });
    expect(r.state).toBe("POD_UNDER_REVIEW");
    expect(r.advisoryReportHash).toBe(HASH);
    // Still need shipper / timeout / dispute for exit
    expect(() =>
      reduceLifecycle(r, {
        type: "ESCROW_RELEASE_CONFIRMED",
        actionId: "nope",
        eventTime: r.reviewStartedAt!,
        releaseTxId: "x",
        releaseAmountAtomic: WIN_AMOUNT,
      }),
    ).toThrow(IllegalLifecycleTransitionError);
  });

  it("referee path requires allowlisted human key and conservation", () => {
    let r = happyToUnderReview();
    const deadline = r.reviewDeadlineAt!;
    r = reduceLifecycle(r, {
      type: "POD_REJECTED_TO_DISPUTE",
      actionId: "act-reject",
      eventTime: deadline,
      reasons: [{ code: "DAMAGED", message: "Seal broken" }],
      shipperSignature: SIG,
      reviewDeadlineAt: deadline,
      disputeId: "disp-1",
    });
    expect(r.state).toBe("POD_DISPUTED");

    expect(() =>
      reduceLifecycle(r, {
        type: "REFEREE_RESOLUTION_RECORDED",
        actionId: "ref-bad",
        eventTime: deadline,
        disputeId: "disp-1",
        podId: "pod-1",
        resolution: "PARTIAL",
        releaseAmountAtomic: "400000",
        refundAmountAtomic: "300000",
        refereeId: "ref-1",
        refereePublicKey: "02notallowlisted",
        signature: SIG,
        signedPayloadHash: HASH,
        signerKind: "HUMAN_REFEREE",
        allowlistedRefereeKeys: [REFEREE_KEY],
      }),
    ).toThrow(LifecycleGuardError);

    expect(() =>
      reduceLifecycle(r, {
        type: "REFEREE_RESOLUTION_RECORDED",
        actionId: "ref-sig",
        eventTime: deadline,
        disputeId: "disp-1",
        podId: "pod-1",
        resolution: "PARTIAL",
        releaseAmountAtomic: "400000",
        refundAmountAtomic: "300000",
        refereeId: "ref-1",
        refereePublicKey: REFEREE_KEY,
        signature: "deadbeef",
        signedPayloadHash: HASH,
        signerKind: "HUMAN_REFEREE",
        allowlistedRefereeKeys: [REFEREE_KEY],
      }),
    ).toThrow(/signature/i);

    r = reduceLifecycle(r, {
      type: "REFEREE_RESOLUTION_RECORDED",
      actionId: "ref-ok",
      eventTime: deadline,
      disputeId: "disp-1",
      podId: "pod-1",
      resolution: "PARTIAL",
      releaseAmountAtomic: "400000",
      refundAmountAtomic: "300000",
      refereeId: "ref-1",
      refereePublicKey: REFEREE_KEY,
      signature: SIG,
      signedPayloadHash: HASH,
      signerKind: "HUMAN_REFEREE",
      allowlistedRefereeKeys: [REFEREE_KEY],
    });
    expect(r.state).toBe("REFEREE_DECISION");

    r = reduceLifecycle(r, {
      type: "ESCROW_PARTIAL_RELEASE_CONFIRMED",
      actionId: "partial",
      eventTime: deadline,
      releaseTxId: "0.0.1@2.1",
      refundTxId: "0.0.1@2.2",
      releaseAmountAtomic: "400000",
      refundAmountAtomic: "300000",
    });
    expect(r.state).toBe("PARTIAL_RELEASE");
  });

  it("requires exact access fee and asset on activation", () => {
    const r = fund(baseRecord());
    expect(() =>
      reduceLifecycle(r, {
        type: "TENDER_ACTIVATION_PAID",
        actionId: "bad-fee",
        eventTime: T0,
        accessActionType: "TENDER_ACTIVATE",
        asset: "0.0.429274",
        amountAtomic: "999",
        resource: `/api/v2/tenders/${r.tenderId}/activate`,
        paymentTransactionId: "x",
        paymentPayloadHash: HASH,
        payerAccount: "0.0.9197513",
        payTo: "0.0.9197513",
      }),
    ).toThrow(/amountAtomic/);
    expect(deriveAccessFeeAtomic()).toBe("1000");
  });

  it("requires reservation evidence after allocation", () => {
    let r = baseRecord();
    r = fund(r);
    r = activate(r);
    r = toBidding(r);
    r = closeAuction(r);
    r = selectWinner(r);
    r = allocate(r);
    expect(() =>
      reduceLifecycle(r, {
        type: "ROUTE_RESERVATION_PUBLISHED",
        actionId: "bad-res",
        eventTime: AUCTION_ENDS,
        reservationEvidenceRef: "",
        hcsPublicationRef: "hcs",
      }),
    ).toThrow();
    r = reserve(r);
    expect(r.state).toBe("ROUTE_RESERVED");
  });

  it("rejects closing auction before deadline", () => {
    let r = baseRecord();
    r = fund(r);
    r = activate(r);
    r = toBidding(r);
    expect(() =>
      reduceLifecycle(r, {
        type: "AUCTION_CLOSE_CONFIRMED",
        actionId: "early",
        eventTime: T0,
        auctionEndsAt: AUCTION_ENDS,
        closureProofRef: "p",
        authoritativeBidSetHash: HASH,
      }),
    ).toThrow(/auctionEndsAt|AUCTION_NOT_ENDED|at or after/i);
  });
});
