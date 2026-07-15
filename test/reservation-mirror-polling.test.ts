/**
 * Phase 6A.2B — bounded Mirror payment polling and restart recovery.
 * Fake clocks only — no wall-clock sleeps.
 */

import { describe, expect, it } from "vitest";

import type { MirrorConfirmation } from "../src/reservation/types";
import {
  buildService,
  createAndSelect,
  defaultMirrorSuccess,
  DEMO_PAYER_ACCOUNT,
} from "./reservation-helpers";
import type { SettleClaim } from "../src/reservation/types";
import { RESERVATION_NETWORK } from "../src/reservation/types";

function makeClaim(
  reservationId: string,
  optionId: "USDC" | "HBAR",
  paymentPayloadHash: string,
  challengeHash: string,
  selected: {
    asset: string;
    amountAtomic: string;
    payerAccount: string;
    payTo: string;
  },
  recordVersion = 1,
): SettleClaim {
  return {
    settleAttemptId: "settle-attempt-fixture",
    reservationId,
    attemptNumber: 1,
    selectedOptionId: optionId,
    asset: selected.asset,
    amountAtomic: selected.amountAtomic,
    payerAccount: selected.payerAccount,
    payTo: selected.payTo,
    network: RESERVATION_NETWORK,
    challengeHash,
    paymentPayloadHash,
    claimedAt: "2026-07-15T19:02:00.000Z",
    recordVersion,
  };
}

function pending(txId: string): MirrorConfirmation {
  return {
    status: "PENDING",
    transactionId: txId,
    consensusTimestamp: null,
    result: null,
    hbarTransfers: [],
    tokenTransfers: [],
  };
}

function notFound(txId: string): MirrorConfirmation {
  return {
    status: "NOT_FOUND",
    transactionId: txId,
    consensusTimestamp: null,
    result: null,
    hbarTransfers: [],
    tokenTransfers: [],
  };
}

function failed(txId: string): MirrorConfirmation {
  return {
    status: "FAILED",
    transactionId: txId,
    consensusTimestamp: null,
    result: "FAILED",
    hbarTransfers: [],
    tokenTransfers: [],
  };
}

async function prepToSettled(
  optionId: "USDC" | "HBAR",
  reservationId: string,
  opts?: { confirmationTimeoutMs?: number; mirrorPollIntervalMs?: number },
) {
  const ctx = buildService({
    now: "2026-07-15T19:01:00.000Z",
    confirmationTimeoutMs: opts?.confirmationTimeoutMs ?? 500,
    mirrorPollIntervalMs: opts?.mirrorPollIntervalMs ?? 100,
  });
  const { service, store, controls, bundle } = ctx;
  const { paymentPayloadHash } = await createAndSelect(
    service,
    bundle,
    optionId,
    reservationId,
  );
  const rec = (await store.get(reservationId))!;
  const sel = rec.selected!;
  const txId = controls.settleResult.transactionId!;

  // Seed FACILITATOR_SETTLED with durable claim + tx id (no settle on resume).
  await store.compareAndSet(reservationId, rec.recordVersion, {
    ...rec,
    state: "FACILITATOR_SETTLED",
    paymentPayloadHash,
    attemptNumber: 1,
    facilitatorVerify: { isValid: true },
    settleClaim: makeClaim(
      reservationId,
      optionId,
      paymentPayloadHash,
      rec.paymentChallengeHash!,
      sel,
      rec.recordVersion,
    ),
    facilitatorSettle: {
      success: true,
      transactionId: txId,
      network: "hedera:testnet",
      payerAccountId: DEMO_PAYER_ACCOUNT,
    },
    transactionId: txId,
  });

  controls.settleCallCount = 0;
  controls.verifyCallCount = 0;
  controls.mirrorCallCount = 0;

  return { ...ctx, reservationId, paymentPayloadHash, txId, selected: sel };
}

describe("Bounded Mirror payment polling (Phase 6A.2B)", () => {
  it("1. NOT_FOUND → NOT_FOUND → SUCCESS reaches ROUTE_RESERVED", async () => {
    const { service, controls, reservationId, txId, selected } =
      await prepToSettled("HBAR", "res-poll-nf-ok");
    let n = 0;
    controls.mirrorImpl = async () => {
      n += 1;
      if (n <= 2) return notFound(txId);
      return defaultMirrorSuccess(selected, txId);
    };
    const final = await service.resumePaymentConfirmation(reservationId);
    expect(final.routeReserved).not.toBeNull();
    expect(final.routeReserved!.reservedAt).toBe(
      "2026-07-15T19:05:00.123456789Z",
    );
    expect(controls.mirrorCallCount).toBeGreaterThanOrEqual(3);
    expect(controls.settleCallCount).toBe(0);
  });

  it("2. PENDING → SUCCESS reaches ROUTE_RESERVED", async () => {
    const { service, controls, reservationId, txId, selected } =
      await prepToSettled("USDC", "res-poll-pend-ok");
    let n = 0;
    controls.mirrorImpl = async () => {
      n += 1;
      if (n === 1) return pending(txId);
      return defaultMirrorSuccess(selected, txId);
    };
    const final = await service.resumePaymentConfirmation(reservationId);
    expect(final.routeReserved).not.toBeNull();
    expect(final.routeReserved!.selectedOptionId).toBe("USDC");
    expect(controls.settleCallCount).toBe(0);
  });

  it("3. thrown Mirror error → PENDING → SUCCESS reaches ROUTE_RESERVED", async () => {
    const { service, controls, reservationId, txId, selected } =
      await prepToSettled("HBAR", "res-poll-throw-ok");
    let n = 0;
    controls.mirrorImpl = async () => {
      n += 1;
      if (n === 1) throw new Error("mirror network blip");
      if (n === 2) return pending(txId);
      return defaultMirrorSuccess(selected, txId);
    };
    const final = await service.resumePaymentConfirmation(reservationId);
    expect(final.routeReserved).not.toBeNull();
    expect(controls.settleCallCount).toBe(0);
  });

  it("4. repeated PENDING until deadline times out", async () => {
    const { service, controls, reservationId, txId, store } =
      await prepToSettled("HBAR", "res-poll-pend-to", {
        confirmationTimeoutMs: 250,
        mirrorPollIntervalMs: 100,
      });
    controls.mirrorImpl = async () => pending(txId);
    const final = await service.resumePaymentConfirmation(reservationId);
    expect(final.state).toBe("CONFIRMATION_TIMED_OUT");
    expect(final.routeReserved).toBeNull();
    expect(controls.settleCallCount).toBe(0);
    expect(controls.mirrorCallCount).toBeGreaterThan(1);
    const durable = (await store.get(reservationId))!;
    expect(durable.confirmationDeadline).not.toBeNull();
    expect(durable.mirrorPoll!.pollAttemptCount).toBeGreaterThan(1);
    expect(durable.settleClaim).not.toBeNull();
    expect(durable.transactionId).toBe(txId);
  });

  it("5. repeated NOT_FOUND until deadline times out", async () => {
    const { service, controls, reservationId, txId } = await prepToSettled(
      "USDC",
      "res-poll-nf-to",
      { confirmationTimeoutMs: 250, mirrorPollIntervalMs: 100 },
    );
    controls.mirrorImpl = async () => notFound(txId);
    const final = await service.resumePaymentConfirmation(reservationId);
    expect(final.state).toBe("CONFIRMATION_TIMED_OUT");
    expect(controls.settleCallCount).toBe(0);
    expect(final.selected!.optionId).toBe("USDC");
  });

  it("6. FAILED stops immediately", async () => {
    const { service, controls, reservationId, txId } = await prepToSettled(
      "HBAR",
      "res-poll-failed",
    );
    controls.mirrorImpl = async () => failed(txId);
    const final = await service.resumePaymentConfirmation(reservationId);
    expect(final.state).toBe("CONFIRMATION_FAILED");
    expect(controls.mirrorCallCount).toBe(1);
    expect(controls.settleCallCount).toBe(0);
  });

  it("7. wrong transfer on eventual SUCCESS becomes CONFIRMATION_FAILED", async () => {
    const { service, controls, reservationId, txId } = await prepToSettled(
      "HBAR",
      "res-poll-bad-xfer",
    );
    controls.mirrorImpl = async () => ({
      status: "SUCCESS",
      transactionId: txId,
      consensusTimestamp: "2026-07-15T19:05:00.123456789Z",
      result: "SUCCESS",
      hbarTransfers: [
        { account: DEMO_PAYER_ACCOUNT, amount: "-1" },
        { account: "0.0.1", amount: "1" },
      ],
      tokenTransfers: [],
    });
    const final = await service.resumePaymentConfirmation(reservationId);
    expect(final.state).toBe("CONFIRMATION_FAILED");
    expect(final.routeReserved).toBeNull();
    expect(controls.settleCallCount).toBe(0);
  });

  it("8. wrong transaction ID becomes CONFIRMATION_FAILED", async () => {
    const { service, controls, reservationId, selected } = await prepToSettled(
      "USDC",
      "res-poll-bad-txid",
    );
    controls.mirrorImpl = async () =>
      defaultMirrorSuccess(selected, "0.0.1@9.9");
    const final = await service.resumePaymentConfirmation(reservationId);
    expect(final.state).toBe("CONFIRMATION_FAILED");
    expect(controls.settleCallCount).toBe(0);
  });

  it("9. missing consensus timestamp becomes CONFIRMATION_FAILED", async () => {
    const { service, controls, reservationId, txId, selected } =
      await prepToSettled("HBAR", "res-poll-no-ts");
    const ok = defaultMirrorSuccess(selected, txId);
    controls.mirrorImpl = async () => ({
      ...ok,
      consensusTimestamp: null,
    });
    const final = await service.resumePaymentConfirmation(reservationId);
    expect(final.state).toBe("CONFIRMATION_FAILED");
    expect(final.failureCode).toMatch(/MISSING_CONSENSUS|PAYMENT_VERIFY/i);
  });

  it("10. settle call count remains exactly one during multiple polls (submit path)", async () => {
    const { service, controls, bundle } = buildService({
      now: "2026-07-15T19:01:00.000Z",
      confirmationTimeoutMs: 500,
      mirrorPollIntervalMs: 100,
    });
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "HBAR",
      "res-poll-settle-once",
    );
    const sel = (await service.getReservation(reservationId))!.selected!;
    const txId = controls.settleResult.transactionId!;
    let n = 0;
    controls.mirrorImpl = async () => {
      n += 1;
      if (n <= 2) return pending(txId);
      return defaultMirrorSuccess(sel, txId);
    };
    const final = await service.submitPayment({
      reservationId,
      optionId: "HBAR",
      paymentPayloadHash,
    });
    expect(final.routeReserved).not.toBeNull();
    expect(controls.settleCallCount).toBe(1);
    expect(controls.mirrorCallCount).toBeGreaterThanOrEqual(3);
  });

  it("11. restart from FACILITATOR_SETTLED resumes polling without settle", async () => {
    const { service, controls, reservationId, txId, selected } =
      await prepToSettled("USDC", "res-poll-restart-settled");
    controls.mirrorImpl = async () => defaultMirrorSuccess(selected, txId);
    const final = await service.resumePaymentConfirmation(reservationId);
    expect(final.routeReserved).not.toBeNull();
    expect(controls.settleCallCount).toBe(0);
    expect(controls.verifyCallCount).toBe(0);
  });

  it("12+13. restart from MIRROR_CONFIRMATION_PENDING reuses deadline without settle", async () => {
    const { service, store, controls, reservationId, txId, selected } =
      await prepToSettled("HBAR", "res-poll-restart-pending", {
        confirmationTimeoutMs: 10_000,
        mirrorPollIntervalMs: 100,
      });

    // Establish pending state with durable deadline.
    let n = 0;
    controls.mirrorImpl = async () => {
      n += 1;
      if (n === 1) return pending(txId);
      // First resume will be interrupted by us after first poll via store check.
      return pending(txId);
    };
    // Force timeout quickly after seeding pending manually.
    const rec = (await store.get(reservationId))!;
    const deadline = "2026-07-15T19:01:05.000Z";
    await store.compareAndSet(reservationId, rec.recordVersion, {
      ...rec,
      state: "MIRROR_CONFIRMATION_PENDING",
      confirmationDeadline: deadline,
      mirrorPoll: {
        transactionId: txId,
        confirmationStartedAt: "2026-07-15T19:01:00.000Z",
        confirmationDeadline: deadline,
        pollAttemptCount: 2,
        lastPollAt: "2026-07-15T19:01:00.200Z",
        lastMirrorStatus: "PENDING",
        lastMirrorErrorCode: null,
        lastMirrorError: null,
        consensusTimestamp: null,
        verifiedTransfer: null,
      },
    });

    controls.settleCallCount = 0;
    controls.mirrorCallCount = 0;
    n = 0;
    controls.mirrorImpl = async () => {
      n += 1;
      if (n === 1) return pending(txId);
      return defaultMirrorSuccess(selected, txId);
    };

    const before = (await store.get(reservationId))!;
    expect(before.confirmationDeadline).toBe(deadline);

    const final = await service.resumePaymentConfirmation(reservationId);
    expect(final.routeReserved).not.toBeNull();
    expect(controls.settleCallCount).toBe(0);
    // Deadline reused — not extended to a brand-new full window.
    expect(final.confirmationDeadline).toBe(deadline);
    expect(final.mirrorPoll!.confirmationDeadline).toBe(deadline);
  });

  it("14. already ROUTE_RESERVED recovery is idempotent", async () => {
    const { service, controls, bundle } = buildService({
      now: "2026-07-15T19:01:00.000Z",
    });
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "HBAR",
      "res-poll-idem-rr",
    );
    const sel = (await service.getReservation(reservationId))!.selected!;
    controls.mirrorResult = defaultMirrorSuccess(
      sel,
      controls.settleResult.transactionId!,
    );
    const reserved = await service.submitPayment({
      reservationId,
      optionId: "HBAR",
      paymentPayloadHash,
    });
    expect(reserved.routeReserved).not.toBeNull();
    const settleBefore = controls.settleCallCount;
    const mirrorBefore = controls.mirrorCallCount;
    const again = await service.resumePaymentConfirmation(reservationId);
    expect(again.routeReserved!.reservationRecordHash).toBe(
      reserved.routeReserved!.reservationRecordHash,
    );
    expect(controls.settleCallCount).toBe(settleBefore);
    expect(controls.mirrorCallCount).toBe(mirrorBefore);
  });

  it("15. settle claim without transaction ID never resumes settle", async () => {
    const { service, store, controls, bundle } = buildService();
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "HBAR",
      "res-poll-no-tx",
    );
    const rec = (await store.get(reservationId))!;
    await store.compareAndSet(reservationId, rec.recordVersion, {
      ...rec,
      state: "FACILITATOR_SETTLE_CLAIMED",
      paymentPayloadHash,
      attemptNumber: 1,
      facilitatorVerify: { isValid: true },
      settleClaim: makeClaim(
        reservationId,
        "HBAR",
        paymentPayloadHash,
        rec.paymentChallengeHash!,
        rec.selected!,
        rec.recordVersion,
      ),
      transactionId: null,
    });
    controls.settleCallCount = 0;
    const final = await service.resumePaymentConfirmation(reservationId);
    expect(final.state).toBe("MANUAL_REVIEW_REQUIRED");
    expect(controls.settleCallCount).toBe(0);
    expect(controls.mirrorCallCount).toBe(0);
  });

  it("16. selected USDC never falls back to HBAR", async () => {
    const { service, controls, reservationId, txId, selected } =
      await prepToSettled("USDC", "res-poll-no-fb-usdc");
    expect(selected.optionId).toBe("USDC");
    controls.mirrorImpl = async () => defaultMirrorSuccess(selected, txId);
    const final = await service.resumePaymentConfirmation(reservationId);
    expect(final.selected!.optionId).toBe("USDC");
    expect(final.routeReserved!.selectedOptionId).toBe("USDC");
    expect(final.routeReserved!.paymentAsset).toBe("0.0.429274");
  });

  it("17. selected HBAR never falls back to USDC", async () => {
    const { service, controls, reservationId, txId, selected } =
      await prepToSettled("HBAR", "res-poll-no-fb-hbar");
    controls.mirrorImpl = async () => defaultMirrorSuccess(selected, txId);
    const final = await service.resumePaymentConfirmation(reservationId);
    expect(final.selected!.optionId).toBe("HBAR");
    expect(final.routeReserved!.selectedOptionId).toBe("HBAR");
    expect(final.routeReserved!.paymentAsset).toBe("0.0.0");
  });

  it("submitPayment still polls PENDING then SUCCESS end-to-end", async () => {
    const { service, controls, bundle } = buildService({
      now: "2026-07-15T19:01:00.000Z",
      confirmationTimeoutMs: 800,
      mirrorPollIntervalMs: 100,
    });
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "USDC",
      "res-poll-e2e",
    );
    const sel = (await service.getReservation(reservationId))!.selected!;
    const txId = controls.settleResult.transactionId!;
    let n = 0;
    controls.mirrorImpl = async () => {
      n += 1;
      if (n === 1) return notFound(txId);
      if (n === 2) return pending(txId);
      return defaultMirrorSuccess(sel, txId);
    };
    const final = await service.submitPayment({
      reservationId,
      optionId: "USDC",
      paymentPayloadHash,
    });
    expect(final.routeReserved).not.toBeNull();
    expect(controls.settleCallCount).toBe(1);
    expect(final.mirrorPoll!.pollAttemptCount).toBeGreaterThanOrEqual(3);
  });
});
