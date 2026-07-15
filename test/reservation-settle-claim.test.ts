import { describe, expect, it } from "vitest";

import {
  RESERVATION_NETWORK,
  type ReservationRecord,
  type SettleClaim,
} from "../src/reservation/types";
import {
  buildService,
  createAndSelect,
  defaultMirrorSuccess,
  DEMO_PAYER_ACCOUNT,
} from "./reservation-helpers";

/** Two-party Promise barrier — both callers block until both arrive. */
function twoPartyBarrier(): () => Promise<void> {
  let count = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return async () => {
    count += 1;
    if (count >= 2) release();
    await gate;
  };
}

function makeClaim(
  record: ReservationRecord,
  paymentPayloadHash: string,
): SettleClaim {
  const sel = record.selected!;
  return {
    settleAttemptId: "settle-attempt-fixture",
    reservationId: record.reservationId,
    attemptNumber: 1,
    selectedOptionId: sel.optionId,
    asset: sel.asset,
    amountAtomic: sel.amountAtomic,
    payerAccount: sel.payerAccount,
    payTo: sel.payTo,
    network: RESERVATION_NETWORK,
    challengeHash: record.paymentChallengeHash!,
    paymentPayloadHash,
    claimedAt: "2026-07-15T19:02:00.000Z",
    recordVersion: record.recordVersion + 1,
  };
}

describe("Durable settle claim (M2)", () => {
  it("two concurrent submits settle exactly once (verify Promise barrier)", async () => {
    const { service, store, controls, bundle } = buildService();
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "HBAR",
      "res-concurrent-1",
    );
    const rec = await store.get(reservationId);
    controls.mirrorResult = defaultMirrorSuccess(
      rec!.selected!,
      controls.settleResult.transactionId!,
    );
    // Pre-seed PAYMENT_SUBMISSION_STARTED so both callers reach verify together.
    await store.compareAndSet(reservationId, rec!.recordVersion, {
      ...rec!,
      state: "PAYMENT_SUBMISSION_STARTED",
      paymentPayloadHash,
      attemptNumber: 1,
    });

    const barrier = twoPartyBarrier();
    controls.verifyImpl = async () => {
      await barrier();
      return { isValid: true };
    };

    const [a, b] = await Promise.all([
      service.submitPayment({ reservationId, optionId: "HBAR", paymentPayloadHash }),
      service.submitPayment({ reservationId, optionId: "HBAR", paymentPayloadHash }),
    ]);

    expect(controls.settleCallCount).toBe(1);
    expect(service.getSettleCallCount(reservationId)).toBe(1);
    const reserved = [a, b].filter((r) => r.routeReserved !== null);
    expect(reserved).toHaveLength(1);
  });

  it("settle-claim CAS: only the claim holder settles; loser does not", async () => {
    const { service, store, controls, bundle } = buildService();
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "USDC",
      "res-claim-cas",
    );
    const rec = await store.get(reservationId);
    controls.mirrorResult = defaultMirrorSuccess(
      rec!.selected!,
      controls.settleResult.transactionId!,
    );
    // Pre-seed FACILITATOR_VERIFIED so both go straight to the settle-claim CAS.
    await store.compareAndSet(reservationId, rec!.recordVersion, {
      ...rec!,
      state: "FACILITATOR_VERIFIED",
      paymentPayloadHash,
      attemptNumber: 1,
      facilitatorVerify: { isValid: true },
    });

    const [a, b] = await Promise.all([
      service.submitPayment({ reservationId, optionId: "USDC", paymentPayloadHash }),
      service.submitPayment({ reservationId, optionId: "USDC", paymentPayloadHash }),
    ]);

    expect(controls.settleCallCount).toBe(1);
    const reserved = [a, b].filter((r) => r.routeReserved !== null);
    expect(reserved).toHaveLength(1);
    const final = await store.get(reservationId);
    expect(final!.settleClaim).not.toBeNull();
    expect(final!.settleClaim!.paymentPayloadHash).toBe(paymentPayloadHash);
  });

  it("restart from SETTLE_CLAIMED without tx id → manual review, no settle", async () => {
    const { service, store, controls, bundle } = buildService();
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "HBAR",
      "res-restart-claim",
    );
    const rec = (await store.get(reservationId))!;
    await store.compareAndSet(reservationId, rec.recordVersion, {
      ...rec,
      state: "FACILITATOR_SETTLE_CLAIMED",
      paymentPayloadHash,
      attemptNumber: 1,
      facilitatorVerify: { isValid: true },
      settleClaim: makeClaim(rec, paymentPayloadHash),
    });

    const recovered = await service.recover(reservationId);
    expect(recovered.state).toBe("MANUAL_REVIEW_REQUIRED");
    expect(recovered.failureCode).toBe("AMBIGUOUS_SETTLE_CLAIM");
    expect(controls.settleCallCount).toBe(0);
  });

  it("restart from SETTLE_CLAIMED with authoritative tx id continues confirmation (never re-settles)", async () => {
    const { service, store, controls, bundle } = buildService();
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "HBAR",
      "res-restart-txid",
    );
    const rec = (await store.get(reservationId))!;
    await store.compareAndSet(reservationId, rec.recordVersion, {
      ...rec,
      state: "FACILITATOR_SETTLE_CLAIMED",
      paymentPayloadHash,
      attemptNumber: 1,
      facilitatorVerify: { isValid: true },
      settleClaim: makeClaim(rec, paymentPayloadHash),
    });

    const recovered = await service.recover(reservationId, {
      transactionId: "0.0.9197513@1784142000.100000000",
    });
    expect(recovered.state).toBe("MIRROR_CONFIRMATION_PENDING");
    expect(recovered.transactionId).toBe("0.0.9197513@1784142000.100000000");
    expect(controls.settleCallCount).toBe(0);
    // The durable claim is preserved.
    expect(recovered.settleClaim).not.toBeNull();
  });

  it("conflicting payload against an existing settle claim fails closed", async () => {
    const { service, store, bundle } = buildService();
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "HBAR",
      "res-claim-conflict",
    );
    const rec = (await store.get(reservationId))!;
    await store.compareAndSet(reservationId, rec.recordVersion, {
      ...rec,
      state: "FACILITATOR_SETTLE_CLAIMED",
      paymentPayloadHash,
      attemptNumber: 1,
      facilitatorVerify: { isValid: true },
      settleClaim: makeClaim(rec, paymentPayloadHash),
    });

    await expect(
      service.submitPayment({
        reservationId,
        optionId: "HBAR",
        paymentPayloadHash: "sha256:" + "ff".repeat(32),
      }),
    ).rejects.toThrow(/CONFLICT|Conflicting/i);
  });

  it("selected asset stays locked after settle claim", async () => {
    const { service, store, bundle } = buildService();
    const { reservationId, paymentPayloadHash, offerHash } = await createAndSelect(
      service,
      bundle,
      "USDC",
      "res-claim-locked",
    );
    const rec = (await store.get(reservationId))!;
    await store.compareAndSet(reservationId, rec.recordVersion, {
      ...rec,
      state: "FACILITATOR_SETTLE_CLAIMED",
      paymentPayloadHash,
      attemptNumber: 1,
      facilitatorVerify: { isValid: true },
      settleClaim: makeClaim(rec, paymentPayloadHash),
    });

    await expect(
      service.selectOption({
        reservationId,
        optionId: "HBAR",
        offerHash,
        offerVersion: 1,
        payerAccount: DEMO_PAYER_ACCOUNT,
      }),
    ).rejects.toThrow(/re-select|Cannot change|locked/i);
  });

  it("HBAR cannot be attempted after a claimed USDC settle (no fallback)", async () => {
    const { service, store, bundle } = buildService();
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "USDC",
      "res-usdc-claimed",
    );
    const rec = (await store.get(reservationId))!;
    await store.compareAndSet(reservationId, rec.recordVersion, {
      ...rec,
      state: "FACILITATOR_SETTLE_CLAIMED",
      paymentPayloadHash,
      attemptNumber: 1,
      facilitatorVerify: { isValid: true },
      settleClaim: makeClaim(rec, paymentPayloadHash),
    });

    await expect(
      service.submitPayment({ reservationId, optionId: "HBAR", paymentPayloadHash }),
    ).rejects.toThrow(/WRONG_ASSET|fallback/i);
  });

  it("USDC cannot be attempted after a claimed HBAR settle (no fallback)", async () => {
    const { service, store, bundle } = buildService();
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "HBAR",
      "res-hbar-claimed",
    );
    const rec = (await store.get(reservationId))!;
    await store.compareAndSet(reservationId, rec.recordVersion, {
      ...rec,
      state: "FACILITATOR_SETTLE_CLAIMED",
      paymentPayloadHash,
      attemptNumber: 1,
      facilitatorVerify: { isValid: true },
      settleClaim: makeClaim(rec, paymentPayloadHash),
    });

    await expect(
      service.submitPayment({ reservationId, optionId: "USDC", paymentPayloadHash }),
    ).rejects.toThrow(/WRONG_ASSET|fallback/i);
  });

  it("settle claim binds required public fields and never secrets", async () => {
    const { service, controls, bundle } = buildService();
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "HBAR",
      "res-claim-fields",
    );
    const sel = (await service.getReservation(reservationId))!.selected!;
    controls.mirrorResult = defaultMirrorSuccess(
      sel,
      controls.settleResult.transactionId!,
    );
    await service.submitPayment({ reservationId, optionId: "HBAR", paymentPayloadHash });

    const record = (await service.getReservation(reservationId))!;
    const claim = record.settleClaim!;
    expect(claim).not.toBeNull();
    expect(claim.reservationId).toBe(reservationId);
    expect(claim.selectedOptionId).toBe("HBAR");
    expect(claim.asset).toBe("0.0.0");
    expect(claim.amountAtomic).toBe("1000000");
    expect(claim.payerAccount).toBe(DEMO_PAYER_ACCOUNT);
    expect(claim.network).toBe(RESERVATION_NETWORK);
    expect(claim.challengeHash).toBe(record.paymentChallengeHash);
    expect(claim.paymentPayloadHash).toBe(paymentPayloadHash);
    expect(typeof claim.settleAttemptId).toBe("string");
    expect(claim.settleAttemptId.length).toBeGreaterThan(0);
    expect(claim.recordVersion).toBeGreaterThan(0);

    const serialized = JSON.stringify(claim);
    expect(serialized).not.toMatch(/signature|privateKey|secret|PAYMENT-SIGNATURE/i);
  });
});
