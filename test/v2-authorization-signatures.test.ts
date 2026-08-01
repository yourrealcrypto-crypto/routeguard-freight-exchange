import { PrivateKey } from "@hiero-ledger/sdk";
import { describe, expect, it } from "vitest";

import {
  buildRefereeResolutionSignPayload,
  buildShipperPodReviewSignPayload,
  REFEREE_RESOLUTION_PURPOSE,
  SHIPPER_POD_REVIEW_PURPOSE,
} from "../src/v2/auth/canonical";
import {
  AuthorizationError,
  signRefereeResolutionForTests,
  signShipperPodReviewForTests,
  verifyRefereeResolution,
  verifyShipperPodReview,
} from "../src/v2/auth/verify";
import { reduceLifecycle } from "../src/v2/lifecycle/reducer";
import {
  defaultTrustPolicy,
  happyToUnderReview,
  REFEREE_ID,
  REFEREE_PRIVATE,
  REFEREE_PUBLIC,
  refereeAuth,
  SHIPPER_PRIVATE,
  SHIPPER_PUBLIC,
  signRefereeAction,
  signShipperAction,
  shipperAuth,
} from "./v2-lifecycle-fixtures";

describe("v2 authorization signatures", () => {
  const reviewStart = "2026-08-02T12:00:00.000Z";

  it("uses domain-separated purposes", () => {
    expect(SHIPPER_POD_REVIEW_PURPOSE).toContain("SHIPPER");
    expect(REFEREE_RESOLUTION_PURPOSE).toContain("REFEREE");
    expect(SHIPPER_POD_REVIEW_PURPOSE).not.toBe(REFEREE_RESOLUTION_PURPOSE);
  });

  it("valid trusted shipper signature passes; forged fails", () => {
    const policy = defaultTrustPolicy();
    const payload = buildShipperPodReviewSignPayload({
      tenderId: "t1",
      tenderVersion: 1,
      podId: "pod-1",
      reviewAction: "ACCEPT",
      signedAt: reviewStart,
      reviewDeadlineAt: "2026-08-04T12:00:00.000Z",
      actionId: "a1",
    });
    const sig = signShipperPodReviewForTests(
      SHIPPER_PRIVATE.toStringRaw(),
      payload,
    );
    expect(
      verifyShipperPodReview({
        policy,
        ...payload,
        signature: sig,
      }).payloadHash,
    ).toMatch(/^sha256:/);

    expect(() =>
      verifyShipperPodReview({
        policy,
        ...payload,
        signature: "ab".repeat(64),
      }),
    ).toThrow(AuthorizationError);

    const other = PrivateKey.generateECDSA();
    const forged = signShipperPodReviewForTests(other.toStringRaw(), payload);
    expect(() =>
      verifyShipperPodReview({
        policy,
        ...payload,
        signature: forged,
      }),
    ).toThrow(AuthorizationError);
  });

  it("shipper signature transplant to another tender fails", () => {
    const policy = defaultTrustPolicy();
    const payload = buildShipperPodReviewSignPayload({
      tenderId: "tender-A",
      tenderVersion: 1,
      podId: "pod-1",
      reviewAction: "ACCEPT",
      signedAt: reviewStart,
      reviewDeadlineAt: "2026-08-04T12:00:00.000Z",
      actionId: "a1",
    });
    const sig = signShipperPodReviewForTests(
      SHIPPER_PRIVATE.toStringRaw(),
      payload,
    );
    expect(() =>
      verifyShipperPodReview({
        policy,
        tenderId: "tender-B",
        tenderVersion: 1,
        podId: "pod-1",
        reviewAction: "ACCEPT",
        signedAt: reviewStart,
        reviewDeadlineAt: "2026-08-04T12:00:00.000Z",
        actionId: "a1",
        signature: sig,
      }),
    ).toThrow(AuthorizationError);
  });

  it("shipper signature transplant to another POD fails", () => {
    const policy = defaultTrustPolicy();
    const payload = buildShipperPodReviewSignPayload({
      tenderId: "t1",
      tenderVersion: 1,
      podId: "pod-1",
      reviewAction: "ACCEPT",
      signedAt: reviewStart,
      reviewDeadlineAt: "2026-08-04T12:00:00.000Z",
      actionId: "a1",
    });
    const sig = signShipperPodReviewForTests(
      SHIPPER_PRIVATE.toStringRaw(),
      payload,
    );
    expect(() =>
      verifyShipperPodReview({
        policy,
        tenderId: "t1",
        tenderVersion: 1,
        podId: "pod-OTHER",
        reviewAction: "ACCEPT",
        signedAt: reviewStart,
        reviewDeadlineAt: "2026-08-04T12:00:00.000Z",
        actionId: "a1",
        signature: sig,
      }),
    ).toThrow(AuthorizationError);
  });

  it("shipper signature for ACCEPT cannot be reused for REJECT", () => {
    const policy = defaultTrustPolicy();
    const payload = buildShipperPodReviewSignPayload({
      tenderId: "t1",
      tenderVersion: 1,
      podId: "pod-1",
      reviewAction: "ACCEPT",
      signedAt: reviewStart,
      reviewDeadlineAt: "2026-08-04T12:00:00.000Z",
      actionId: "a1",
    });
    const sig = signShipperPodReviewForTests(
      SHIPPER_PRIVATE.toStringRaw(),
      payload,
    );
    expect(() =>
      verifyShipperPodReview({
        policy,
        tenderId: "t1",
        tenderVersion: 1,
        podId: "pod-1",
        reviewAction: "REJECT_DISPUTE",
        reasonCodes: ["X"],
        signedAt: reviewStart,
        reviewDeadlineAt: "2026-08-04T12:00:00.000Z",
        actionId: "a1",
        signature: sig,
      }),
    ).toThrow(AuthorizationError);
  });

  it("changed reason codes invalidate shipper signature", () => {
    const policy = defaultTrustPolicy();
    const payload = buildShipperPodReviewSignPayload({
      tenderId: "t1",
      tenderVersion: 1,
      podId: "pod-1",
      reviewAction: "REQUEST_CORRECTION",
      reasonCodes: ["STAMP"],
      signedAt: reviewStart,
      reviewDeadlineAt: "2026-08-04T12:00:00.000Z",
      actionId: "a1",
    });
    const sig = signShipperPodReviewForTests(
      SHIPPER_PRIVATE.toStringRaw(),
      payload,
    );
    expect(() =>
      verifyShipperPodReview({
        policy,
        tenderId: "t1",
        tenderVersion: 1,
        podId: "pod-1",
        reviewAction: "REQUEST_CORRECTION",
        reasonCodes: ["OTHER"],
        signedAt: reviewStart,
        reviewDeadlineAt: "2026-08-04T12:00:00.000Z",
        actionId: "a1",
        signature: sig,
      }),
    ).toThrow(AuthorizationError);
  });

  it("valid trusted referee passes; unknown and AI fail", () => {
    const policy = defaultTrustPolicy();
    const payload = buildRefereeResolutionSignPayload({
      tenderId: "t1",
      tenderVersion: 1,
      podId: "pod-1",
      disputeId: "d1",
      resolution: "RELEASE_FULL",
      releaseAmountAtomic: "700000",
      refundAmountAtomic: "0",
      rationaleCode: "OK",
      refereeId: REFEREE_ID,
      signedAt: reviewStart,
      actionId: "r1",
    });
    const sig = signRefereeResolutionForTests(
      REFEREE_PRIVATE.toStringRaw(),
      payload,
    );
    expect(
      verifyRefereeResolution({
        policy,
        ...payload,
        signature: sig,
      }).refereeId,
    ).toBe(REFEREE_ID);

    expect(() =>
      verifyRefereeResolution({
        policy,
        ...payload,
        refereeId: "unknown-ref",
        signature: sig,
      }),
    ).toThrow(/not in trusted|REFEREE_NOT_TRUSTED/i);

    expect(() =>
      verifyRefereeResolution({
        policy,
        ...payload,
        refereeId: "ai-model-1",
        signature: sig,
      }),
    ).toThrow(/AI|REFEREE/i);
  });

  it("referee cannot self-allowlist via event public key", () => {
    const attacker = PrivateKey.generateECDSA();
    const policy = defaultTrustPolicy();
    // Only REFEREE_ID is trusted — attacker key not in registry
    const payload = buildRefereeResolutionSignPayload({
      tenderId: "t1",
      tenderVersion: 1,
      podId: "pod-1",
      disputeId: "d1",
      resolution: "RELEASE_FULL",
      releaseAmountAtomic: "700000",
      refundAmountAtomic: "0",
      rationaleCode: "OK",
      refereeId: REFEREE_ID,
      signedAt: reviewStart,
      actionId: "r1",
    });
    const attackerSig = signRefereeResolutionForTests(
      attacker.toStringRaw(),
      payload,
    );
    // Wrong key signature fails even if eventPublicKey claims attacker
    expect(() =>
      verifyRefereeResolution({
        policy,
        ...payload,
        signature: attackerSig,
        eventPublicKey: attacker.publicKey.toStringRaw(),
      }),
    ).toThrow();

    // Mismatched event public key vs registry fails
    const goodSig = signRefereeResolutionForTests(
      REFEREE_PRIVATE.toStringRaw(),
      payload,
    );
    expect(() =>
      verifyRefereeResolution({
        policy,
        ...payload,
        signature: goodSig,
        eventPublicKey: attacker.publicKey.toStringRaw(),
      }),
    ).toThrow(/KEY_MISMATCH|does not match/i);
  });

  it("malformed referee key / forged signature fail", () => {
    const policy = defaultTrustPolicy();
    const payload = buildRefereeResolutionSignPayload({
      tenderId: "t1",
      tenderVersion: 1,
      podId: "pod-1",
      disputeId: "d1",
      resolution: "PARTIAL",
      releaseAmountAtomic: "400000",
      refundAmountAtomic: "300000",
      rationaleCode: "S",
      refereeId: REFEREE_ID,
      signedAt: reviewStart,
      actionId: "r1",
    });
    expect(() =>
      verifyRefereeResolution({
        policy,
        ...payload,
        signature: "not-hex",
      }),
    ).toThrow(AuthorizationError);

    const good = signRefereeResolutionForTests(
      REFEREE_PRIVATE.toStringRaw(),
      payload,
    );
    expect(() =>
      verifyRefereeResolution({
        policy,
        ...payload,
        signature: good.slice(0, 100) + "ff",
      }),
    ).toThrow(AuthorizationError);
  });

  it("referee signature transplants across tender/version/pod/dispute fail", () => {
    const policy = defaultTrustPolicy();
    const base = {
      tenderId: "t1",
      tenderVersion: 1,
      podId: "pod-1",
      disputeId: "d1",
      resolution: "PARTIAL" as const,
      releaseAmountAtomic: "400000",
      refundAmountAtomic: "300000",
      rationaleCode: "S",
      refereeId: REFEREE_ID,
      signedAt: reviewStart,
      actionId: "r1",
    };
    const payload = buildRefereeResolutionSignPayload(base);
    const sig = signRefereeResolutionForTests(
      REFEREE_PRIVATE.toStringRaw(),
      payload,
    );

    expect(() =>
      verifyRefereeResolution({
        policy,
        ...base,
        tenderId: "t2",
        signature: sig,
      }),
    ).toThrow(AuthorizationError);

    expect(() =>
      verifyRefereeResolution({
        policy,
        ...base,
        tenderVersion: 2,
        signature: sig,
      }),
    ).toThrow(AuthorizationError);

    expect(() =>
      verifyRefereeResolution({
        policy,
        ...base,
        podId: "pod-2",
        signature: sig,
      }),
    ).toThrow(AuthorizationError);

    expect(() =>
      verifyRefereeResolution({
        policy,
        ...base,
        disputeId: "d2",
        signature: sig,
      }),
    ).toThrow(AuthorizationError);
  });

  it("changing outcome or amounts after signing fails", () => {
    const policy = defaultTrustPolicy();
    const base = {
      tenderId: "t1",
      tenderVersion: 1,
      podId: "pod-1",
      disputeId: "d1",
      resolution: "PARTIAL" as const,
      releaseAmountAtomic: "400000",
      refundAmountAtomic: "300000",
      rationaleCode: "S",
      refereeId: REFEREE_ID,
      signedAt: reviewStart,
      actionId: "r1",
    };
    const sig = signRefereeResolutionForTests(
      REFEREE_PRIVATE.toStringRaw(),
      buildRefereeResolutionSignPayload(base),
    );

    expect(() =>
      verifyRefereeResolution({
        policy,
        ...base,
        resolution: "RELEASE_FULL",
        releaseAmountAtomic: "700000",
        refundAmountAtomic: "0",
        signature: sig,
      }),
    ).toThrow(AuthorizationError);

    expect(() =>
      verifyRefereeResolution({
        policy,
        ...base,
        releaseAmountAtomic: "100000",
        refundAmountAtomic: "600000",
        signature: sig,
      }),
    ).toThrow(AuthorizationError);
  });

  it("plain object cannot forge sealed auth for reducer", () => {
    const r = happyToUnderReview(reviewStart);
    expect(() =>
      reduceLifecycle(
        r,
        {
          type: "POD_ACCEPTED_BY_SHIPPER",
          actionId: "forge",
          eventTime: r.reviewDeadlineAt!,
          shipperSignature: "ab".repeat(64),
          signedAt: r.reviewDeadlineAt!,
          reviewDeadlineAt: r.reviewDeadlineAt!,
        },
        {
          verifiedAuth: {
            kind: "SHIPPER_POD_REVIEW",
            purpose: SHIPPER_POD_REVIEW_PURPOSE,
            actionId: "forge",
            reviewAction: "ACCEPT",
            payloadHash: "sha256:" + "aa".repeat(32),
            trustedKeyFingerprint: "x",
            signatureAlgorithm: "ECDSA_SECP256K1_HIERO",
            signPayload: buildShipperPodReviewSignPayload({
              tenderId: r.tenderId,
              tenderVersion: r.tenderVersion,
              podId: "pod-1",
              reviewAction: "ACCEPT",
              signedAt: r.reviewDeadlineAt!,
              reviewDeadlineAt: r.reviewDeadlineAt!,
              actionId: "forge",
            }),
          } as never,
        },
      ),
    ).toThrow(/sealed shipper|SHIPPER_AUTH/i);
  });

  it("shipper public key is trusted identity (not event-supplied)", () => {
    expect(SHIPPER_PUBLIC.length).toBeGreaterThan(32);
    expect(REFEREE_PUBLIC.length).toBeGreaterThan(32);
  });
});
