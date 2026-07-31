import { describe, expect, it } from "vitest";

import {
  addUtcSeconds,
  computeCorrectionDeadline,
  computePostResubmitReviewDeadline,
  computeReviewDeadline,
  CORRECTION_WINDOW_SECONDS,
  POST_RESUBMIT_REVIEW_WINDOW_SECONDS,
  REVIEW_WINDOW_SECONDS,
} from "../src/v2/lifecycle/deadlines";
import { LifecycleGuardError } from "../src/v2/lifecycle/errors";
import { reduceLifecycle } from "../src/v2/lifecycle/reducer";
import {
  acceptPod,
  HASH,
  HASH_B,
  happyToPodSubmitted,
  happyToUnderReview,
  signShipperAction,
  shipperAuth,
} from "./v2-lifecycle-fixtures";

const REVIEW_START = "2026-08-02T12:00:00.000Z";

describe("v2 lifecycle deadlines", () => {
  it("computes exact 48-hour review deadline", () => {
    expect(REVIEW_WINDOW_SECONDS).toBe(172_800);
    expect(computeReviewDeadline(REVIEW_START)).toBe(
      "2026-08-04T12:00:00.000Z",
    );
  });

  it("computes exact 24-hour correction deadline", () => {
    expect(CORRECTION_WINDOW_SECONDS).toBe(86_400);
    expect(computeCorrectionDeadline(REVIEW_START)).toBe(
      "2026-08-03T12:00:00.000Z",
    );
  });

  it("computes exact 24-hour post-resubmit review deadline", () => {
    expect(POST_RESUBMIT_REVIEW_WINDOW_SECONDS).toBe(86_400);
    expect(computePostResubmitReviewDeadline(REVIEW_START)).toBe(
      "2026-08-03T12:00:00.000Z",
    );
  });

  it("accepts shipper acceptance exactly at review deadline", () => {
    let r = happyToUnderReview(REVIEW_START);
    const deadline = r.reviewDeadlineAt!;
    expect(deadline).toBe("2026-08-04T12:00:00.000Z");
    r = acceptPod(r, deadline);
    expect(r.state).toBe("POD_ACCEPTED");
  });

  it("deems acceptance exactly at review deadline", () => {
    let r = happyToUnderReview(REVIEW_START);
    const deadline = r.reviewDeadlineAt!;
    r = reduceLifecycle(r, {
      type: "POD_REVIEW_DEADLINE_EXPIRED",
      actionId: "tick-1",
      eventTime: deadline,
    });
    expect(r.state).toBe("POD_DEEMED_ACCEPTED");
  });

  it("rejects acceptance after review deadline", () => {
    const r = happyToUnderReview(REVIEW_START);
    const after = addUtcSeconds(r.reviewDeadlineAt!, 1);
    const actionId = "late-accept";
    const sig = signShipperAction({
      tenderId: r.tenderId,
      tenderVersion: r.tenderVersion,
      podId: "pod-1",
      reviewAction: "ACCEPT",
      signedAt: after,
      reviewDeadlineAt: r.reviewDeadlineAt!,
      actionId,
    });
    // verification may pass crypto but reducer rejects time
    const auth = shipperAuth(r, {
      reviewAction: "ACCEPT",
      actionId,
      signedAt: after,
      reviewDeadlineAt: r.reviewDeadlineAt!,
      signature: sig,
    });
    expect(() =>
      reduceLifecycle(
        r,
        {
          type: "POD_ACCEPTED_BY_SHIPPER",
          actionId,
          eventTime: after,
          shipperSignature: sig,
          signedAt: after,
          reviewDeadlineAt: r.reviewDeadlineAt!,
        },
        { verifiedAuth: auth },
      ),
    ).toThrow(LifecycleGuardError);
  });

  it("rejects rejection after review deadline", () => {
    const r = happyToUnderReview(REVIEW_START);
    const after = addUtcSeconds(r.reviewDeadlineAt!, 1);
    const actionId = "late-reject";
    const sig = signShipperAction({
      tenderId: r.tenderId,
      tenderVersion: r.tenderVersion,
      podId: "pod-1",
      reviewAction: "REJECT_DISPUTE",
      reasonCodes: ["X"],
      signedAt: after,
      reviewDeadlineAt: r.reviewDeadlineAt!,
      actionId,
    });
    const auth = shipperAuth(r, {
      reviewAction: "REJECT_DISPUTE",
      actionId,
      signedAt: after,
      reviewDeadlineAt: r.reviewDeadlineAt!,
      reasonCodes: ["X"],
      signature: sig,
    });
    expect(() =>
      reduceLifecycle(
        r,
        {
          type: "POD_REJECTED_TO_DISPUTE",
          actionId,
          eventTime: after,
          reasons: [{ code: "X", message: "late" }],
          shipperSignature: sig,
          signedAt: after,
          reviewDeadlineAt: r.reviewDeadlineAt!,
          disputeId: "d1",
        },
        { verifiedAuth: auth },
      ),
    ).toThrow(LifecycleGuardError);
  });

  it("rejects correction resubmission after correction deadline", () => {
    let r = happyToUnderReview(REVIEW_START);
    const actionId = "corr-1";
    const sig = signShipperAction({
      tenderId: r.tenderId,
      tenderVersion: r.tenderVersion,
      podId: "pod-1",
      reviewAction: "REQUEST_CORRECTION",
      reasonCodes: ["STAMP"],
      signedAt: REVIEW_START,
      reviewDeadlineAt: r.reviewDeadlineAt!,
      actionId,
    });
    const auth = shipperAuth(r, {
      reviewAction: "REQUEST_CORRECTION",
      actionId,
      signedAt: REVIEW_START,
      reviewDeadlineAt: r.reviewDeadlineAt!,
      reasonCodes: ["STAMP"],
      signature: sig,
    });
    r = reduceLifecycle(
      r,
      {
        type: "POD_CORRECTION_REQUESTED",
        actionId,
        eventTime: REVIEW_START,
        reasons: [{ code: "STAMP", message: "missing stamp" }],
        shipperSignature: sig,
        signedAt: REVIEW_START,
        reviewDeadlineAt: r.reviewDeadlineAt!,
      },
      { verifiedAuth: auth },
    );
    expect(r.correctionDeadlineAt).toBe("2026-08-03T12:00:00.000Z");
    const after = addUtcSeconds(r.correctionDeadlineAt!, 1);
    expect(() =>
      reduceLifecycle(r, {
        type: "POD_PACKAGE_RESUBMITTED",
        actionId: "late-resub",
        eventTime: after,
        podId: "pod-1",
        contentHash: HASH,
        ciphertextHash: HASH_B,
      }),
    ).toThrow(LifecycleGuardError);
  });

  it("opens dispute when correction deadline expires without resubmit", () => {
    let r = happyToUnderReview(REVIEW_START);
    const actionId = "corr-1";
    const sig = signShipperAction({
      tenderId: r.tenderId,
      tenderVersion: r.tenderVersion,
      podId: "pod-1",
      reviewAction: "REQUEST_CORRECTION",
      reasonCodes: ["STAMP"],
      signedAt: REVIEW_START,
      reviewDeadlineAt: r.reviewDeadlineAt!,
      actionId,
    });
    const auth = shipperAuth(r, {
      reviewAction: "REQUEST_CORRECTION",
      actionId,
      signedAt: REVIEW_START,
      reviewDeadlineAt: r.reviewDeadlineAt!,
      reasonCodes: ["STAMP"],
      signature: sig,
    });
    r = reduceLifecycle(
      r,
      {
        type: "POD_CORRECTION_REQUESTED",
        actionId,
        eventTime: REVIEW_START,
        reasons: [{ code: "STAMP", message: "missing stamp" }],
        shipperSignature: sig,
        signedAt: REVIEW_START,
        reviewDeadlineAt: r.reviewDeadlineAt!,
      },
      { verifiedAuth: auth },
    );
    r = reduceLifecycle(r, {
      type: "POD_CORRECTION_DEADLINE_EXPIRED",
      actionId: "corr-tick",
      eventTime: r.correctionDeadlineAt!,
    });
    expect(r.state).toBe("POD_DISPUTED");
  });

  it("applies 24h review window after resubmit path", () => {
    let r = happyToUnderReview(REVIEW_START);
    const actionId = "corr-1";
    const sig = signShipperAction({
      tenderId: r.tenderId,
      tenderVersion: r.tenderVersion,
      podId: "pod-1",
      reviewAction: "REQUEST_CORRECTION",
      reasonCodes: ["STAMP"],
      signedAt: REVIEW_START,
      reviewDeadlineAt: r.reviewDeadlineAt!,
      actionId,
    });
    const auth = shipperAuth(r, {
      reviewAction: "REQUEST_CORRECTION",
      actionId,
      signedAt: REVIEW_START,
      reviewDeadlineAt: r.reviewDeadlineAt!,
      reasonCodes: ["STAMP"],
      signature: sig,
    });
    r = reduceLifecycle(
      r,
      {
        type: "POD_CORRECTION_REQUESTED",
        actionId,
        eventTime: REVIEW_START,
        reasons: [{ code: "STAMP", message: "missing stamp" }],
        shipperSignature: sig,
        signedAt: REVIEW_START,
        reviewDeadlineAt: r.reviewDeadlineAt!,
      },
      { verifiedAuth: auth },
    );
    r = reduceLifecycle(r, {
      type: "POD_PACKAGE_RESUBMITTED",
      actionId: "resub",
      eventTime: REVIEW_START,
      podId: "pod-1",
      contentHash: HASH,
      ciphertextHash: HASH_B,
    });
    expect(r.state).toBe("POD_RESUBMITTED");
    const resubReviewStart = "2026-08-02T18:00:00.000Z";
    r = reduceLifecycle(r, {
      type: "POD_REVIEW_STARTED",
      actionId: "review-2",
      eventTime: resubReviewStart,
    });
    expect(r.state).toBe("POD_UNDER_REVIEW");
    expect(r.reviewDeadlineAt).toBe("2026-08-03T18:00:00.000Z");
  });

  it("sets 48h window on first POD_REVIEW_STARTED from POD_SUBMITTED", () => {
    let r = happyToPodSubmitted();
    r = reduceLifecycle(r, {
      type: "POD_REVIEW_STARTED",
      actionId: "review-1",
      eventTime: REVIEW_START,
    });
    expect(r.reviewDeadlineAt).toBe("2026-08-04T12:00:00.000Z");
  });
});
