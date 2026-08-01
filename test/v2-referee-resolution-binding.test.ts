import { describe, expect, it } from "vitest";

import { reduceLifecycle } from "../src/v2/lifecycle/reducer";
import {
  happyToUnderReview,
  REFEREE_ID,
  REFEREE_PUBLIC,
  refereeAuth,
  signRefereeAction,
  signShipperAction,
  shipperAuth,
  WIN_AMOUNT,
} from "./v2-lifecycle-fixtures";

describe("v2 referee resolution settlement binding", () => {
  function openDispute() {
    let r = happyToUnderReview();
    const deadline = r.reviewDeadlineAt!;
    const actionId = "rej-1";
    const sig = signShipperAction({
      tenderId: r.tenderId,
      tenderVersion: r.tenderVersion,
      podId: "pod-1",
      reviewAction: "REJECT_DISPUTE",
      reasonCodes: ["DAMAGED"],
      signedAt: deadline,
      reviewDeadlineAt: deadline,
      actionId,
    });
    const auth = shipperAuth(r, {
      reviewAction: "REJECT_DISPUTE",
      actionId,
      signedAt: deadline,
      reviewDeadlineAt: deadline,
      reasonCodes: ["DAMAGED"],
      signature: sig,
    });
    r = reduceLifecycle(
      r,
      {
        type: "POD_REJECTED_TO_DISPUTE",
        actionId,
        eventTime: deadline,
        reasons: [{ code: "DAMAGED", message: "broken" }],
        shipperSignature: sig,
        signedAt: deadline,
        reviewDeadlineAt: deadline,
        disputeId: "disp-1",
      },
      { verifiedAuth: auth },
    );
    return r;
  }

  function recordPartial(r: ReturnType<typeof openDispute>) {
    const deadline = r.reviewDeadlineAt ?? r.updatedAt;
    const actionId = "ref-partial";
    const sig = signRefereeAction({
      tenderId: r.tenderId,
      tenderVersion: r.tenderVersion,
      podId: "pod-1",
      disputeId: "disp-1",
      resolution: "PARTIAL",
      releaseAmountAtomic: "400000",
      refundAmountAtomic: "300000",
      rationaleCode: "SPLIT",
      refereeId: REFEREE_ID,
      signedAt: deadline,
      actionId,
    });
    const auth = refereeAuth(r, {
      actionId,
      disputeId: "disp-1",
      podId: "pod-1",
      resolution: "PARTIAL",
      releaseAmountAtomic: "400000",
      refundAmountAtomic: "300000",
      rationaleCode: "SPLIT",
      refereeId: REFEREE_ID,
      signedAt: deadline,
      signature: sig,
      eventPublicKey: REFEREE_PUBLIC,
    });
    return reduceLifecycle(
      r,
      {
        type: "REFEREE_RESOLUTION_RECORDED",
        actionId,
        eventTime: deadline,
        disputeId: "disp-1",
        podId: "pod-1",
        resolution: "PARTIAL",
        releaseAmountAtomic: "400000",
        refundAmountAtomic: "300000",
        rationaleCode: "SPLIT",
        refereeId: REFEREE_ID,
        refereePublicKey: REFEREE_PUBLIC,
        signature: sig,
        signedAt: deadline,
        signerKind: "HUMAN_REFEREE",
      },
      { verifiedAuth: auth },
    );
  }

  it("PARTIAL settlement confirmation must exactly match signed decision", () => {
    let r = recordPartial(openDispute());
    expect(r.state).toBe("REFEREE_DECISION");
    expect(r.releaseAmountAtomic).toBe("400000");
    expect(r.refundAmountAtomic).toBe("300000");

    expect(() =>
      reduceLifecycle(r, {
        type: "ESCROW_PARTIAL_RELEASE_CONFIRMED",
        actionId: "bad-split",
        eventTime: r.updatedAt,
        releaseTxId: "0.0.1@1",
        refundTxId: "0.0.1@2",
        releaseAmountAtomic: "100000",
        refundAmountAtomic: "600000",
      }),
    ).toThrow(/DECISION_AMOUNT_MISMATCH|exactly match/i);

    r = reduceLifecycle(r, {
      type: "ESCROW_PARTIAL_RELEASE_CONFIRMED",
      actionId: "ok-split",
      eventTime: r.updatedAt,
      releaseTxId: "0.0.1@1",
      refundTxId: "0.0.1@2",
      releaseAmountAtomic: "400000",
      refundAmountAtomic: "300000",
    });
    expect(r.state).toBe("PARTIAL_RELEASE");
  });

  it("full release confirmation must match signed full-release decision", () => {
    let r = openDispute();
    const deadline = r.updatedAt;
    const actionId = "ref-full";
    const sig = signRefereeAction({
      tenderId: r.tenderId,
      tenderVersion: r.tenderVersion,
      podId: "pod-1",
      disputeId: "disp-1",
      resolution: "RELEASE_FULL",
      releaseAmountAtomic: WIN_AMOUNT,
      refundAmountAtomic: "0",
      rationaleCode: "CARRIER_OK",
      refereeId: REFEREE_ID,
      signedAt: deadline,
      actionId,
    });
    const auth = refereeAuth(r, {
      actionId,
      disputeId: "disp-1",
      podId: "pod-1",
      resolution: "RELEASE_FULL",
      releaseAmountAtomic: WIN_AMOUNT,
      refundAmountAtomic: "0",
      rationaleCode: "CARRIER_OK",
      refereeId: REFEREE_ID,
      signedAt: deadline,
      signature: sig,
    });
    r = reduceLifecycle(
      r,
      {
        type: "REFEREE_RESOLUTION_RECORDED",
        actionId,
        eventTime: deadline,
        disputeId: "disp-1",
        podId: "pod-1",
        resolution: "RELEASE_FULL",
        releaseAmountAtomic: WIN_AMOUNT,
        refundAmountAtomic: "0",
        rationaleCode: "CARRIER_OK",
        refereeId: REFEREE_ID,
        signature: sig,
        signedAt: deadline,
        signerKind: "HUMAN_REFEREE",
      },
      { verifiedAuth: auth },
    );

    expect(() =>
      reduceLifecycle(r, {
        type: "ESCROW_RELEASE_CONFIRMED",
        actionId: "rel-wrong",
        eventTime: deadline,
        releaseTxId: "0.0.1@9",
        releaseAmountAtomic: "699999",
      }),
    ).toThrow();

    r = reduceLifecycle(r, {
      type: "ESCROW_RELEASE_CONFIRMED",
      actionId: "rel-ok",
      eventTime: deadline,
      releaseTxId: "0.0.1@9",
      releaseAmountAtomic: WIN_AMOUNT,
    });
    expect(r.state).toBe("PAYMENT_RELEASED");
  });

  it("full refund confirmation must match signed full-refund decision", () => {
    let r = openDispute();
    const deadline = r.updatedAt;
    const actionId = "ref-refund";
    const sig = signRefereeAction({
      tenderId: r.tenderId,
      tenderVersion: r.tenderVersion,
      podId: "pod-1",
      disputeId: "disp-1",
      resolution: "REFUND_FULL",
      releaseAmountAtomic: "0",
      refundAmountAtomic: WIN_AMOUNT,
      rationaleCode: "SHIPPER",
      refereeId: REFEREE_ID,
      signedAt: deadline,
      actionId,
    });
    const auth = refereeAuth(r, {
      actionId,
      disputeId: "disp-1",
      podId: "pod-1",
      resolution: "REFUND_FULL",
      releaseAmountAtomic: "0",
      refundAmountAtomic: WIN_AMOUNT,
      rationaleCode: "SHIPPER",
      refereeId: REFEREE_ID,
      signedAt: deadline,
      signature: sig,
    });
    r = reduceLifecycle(
      r,
      {
        type: "REFEREE_RESOLUTION_RECORDED",
        actionId,
        eventTime: deadline,
        disputeId: "disp-1",
        podId: "pod-1",
        resolution: "REFUND_FULL",
        releaseAmountAtomic: "0",
        refundAmountAtomic: WIN_AMOUNT,
        rationaleCode: "SHIPPER",
        refereeId: REFEREE_ID,
        signature: sig,
        signedAt: deadline,
        signerKind: "HUMAN_REFEREE",
      },
      { verifiedAuth: auth },
    );

    expect(() =>
      reduceLifecycle(r, {
        type: "ESCROW_REFUND_CONFIRMED",
        actionId: "rf-bad",
        eventTime: deadline,
        refundTxId: "0.0.1@3",
        refundAmountAtomic: "1",
      }),
    ).toThrow(/DECISION_AMOUNT_MISMATCH|exactly match/i);

    r = reduceLifecycle(r, {
      type: "ESCROW_REFUND_CONFIRMED",
      actionId: "rf-ok",
      eventTime: deadline,
      refundTxId: "0.0.1@3",
      refundAmountAtomic: WIN_AMOUNT,
    });
    expect(r.state).toBe("REFUNDED");
  });
});
