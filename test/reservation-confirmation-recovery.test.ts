/**
 * F-001 — guarded recovery of a settled payment after a timed-out Mirror
 * confirmation window (v1.5 recoverability; audit finding F-001).
 *
 * Proves: timeout → later ledger SUCCESS → guarded resume of the EXACT
 * transaction; settle called exactly once; exactly one reservation; exactly
 * one ROUTE_RESERVED publication; conflicting/incomplete state routes to
 * MANUAL_REVIEW_REQUIRED instead of silently failing or re-paying.
 */

import { demoClientTransaction } from "./reservation-helpers";
import { describe, expect, it } from "vitest";

import { InMemoryReservationStore } from "../src/reservation/attempt-store";
import { assessTimedOutConfirmationRecovery } from "../src/reservation/reservation-service";
import type { MirrorConfirmation } from "../src/reservation/types";
import {
  buildService,
  createAndSelect,
  createMockControls,
  defaultMirrorSuccess,
} from "./reservation-helpers";

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

describe("F-001 guarded confirmation recovery", () => {
  it("timeout then later SUCCESS resumes the exact transaction with exactly one settle", async () => {
    const store = new InMemoryReservationStore();
    const controls = createMockControls();
    let mirrorMode: "NOT_FOUND" | "SUCCESS" = "NOT_FOUND";
    const { service, bundle } = buildService({
      controls,
      store,
      confirmationTimeoutMs: 1000,
      mirrorPollIntervalMs: 100,
    });
    controls.mirrorImpl = async (txId) => {
      if (mirrorMode === "NOT_FOUND") return notFound(txId);
      const record = await store.get("res-timeout-001");
      return defaultMirrorSuccess(record!.selected!, txId);
    };

    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "USDC",
      "res-timeout-001",
    );

    const timedOut = await service.submitPayment({ clientTransaction: demoClientTransaction(),
      reservationId,
      optionId: "USDC",
      paymentPayloadHash,
    });
    expect(timedOut.state).toBe("CONFIRMATION_TIMED_OUT");
    expect(timedOut.failureCode).toBe("CONFIRMATION_TIMED_OUT");
    expect(controls.settleCallCount).toBe(1);
    const settledTxId = timedOut.transactionId;
    expect(settledTxId).toBeTruthy();
    // The original settlement transaction ID is preserved on the record.
    expect(timedOut.settleClaim).not.toBeNull();
    expect(timedOut.facilitatorSettle?.success).toBe(true);

    // Replacement payment remains refused while timed out.
    await expect(
      service.submitPayment({ clientTransaction: demoClientTransaction(),
        reservationId,
        optionId: "USDC",
        paymentPayloadHash,
      }),
    ).rejects.toThrow(/terminal/i);

    // The same transaction later appears as SUCCESS on the ledger.
    mirrorMode = "SUCCESS";
    const recovered = await service.resumePaymentConfirmation(reservationId);

    expect(recovered.transactionId).toBe(settledTxId);
    expect(recovered.routeReserved).not.toBeNull();
    expect(recovered.routeReserved!.transactionId).toBe(settledTxId!);
    expect(recovered.state).toBe("COMPLETED");
    // Settle count remains exactly one — recovery never re-settles.
    expect(controls.settleCallCount).toBe(1);
    // Exactly one ROUTE_RESERVED HCS publication.
    expect(controls.hcsPublishCallCount).toBe(1);
    expect(recovered.hcsPublicationClaim?.status).toBe("PUBLISHED");
    // Exactly one reservation record exists for this id.
    const persisted = await store.get(reservationId);
    expect(persisted?.routeReserved?.reservationId).toBe(reservationId);
    // Recovery history shows the guarded transition, not a new payment.
    const recoveryStep = recovered.history.find(
      (h) =>
        h.from === "CONFIRMATION_TIMED_OUT" &&
        h.to === "MIRROR_CONFIRMATION_PENDING",
    );
    expect(recoveryStep).toBeTruthy();
  });

  it("recovery survives a process restart (fresh service over the same durable store)", async () => {
    const store = new InMemoryReservationStore();
    const controls = createMockControls();
    let mirrorMode: "NOT_FOUND" | "SUCCESS" = "NOT_FOUND";
    const first = buildService({
      controls,
      store,
      confirmationTimeoutMs: 500,
      mirrorPollIntervalMs: 50,
    });
    controls.mirrorImpl = async (txId) => {
      if (mirrorMode === "NOT_FOUND") return notFound(txId);
      const record = await store.get("res-restart-001");
      return defaultMirrorSuccess(record!.selected!, txId);
    };
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      first.service,
      first.bundle,
      "USDC",
      "res-restart-001",
    );
    const timedOut = await first.service.submitPayment({ clientTransaction: demoClientTransaction(),
      reservationId,
      optionId: "USDC",
      paymentPayloadHash,
    });
    expect(timedOut.state).toBe("CONFIRMATION_TIMED_OUT");

    // "Restart": a brand-new service instance over the same store.
    mirrorMode = "SUCCESS";
    const second = buildService({
      controls,
      store,
      bundle: first.bundle,
      confirmationTimeoutMs: 500,
      mirrorPollIntervalMs: 50,
    });
    const recovered = await second.service.resumePaymentConfirmation(
      reservationId,
    );
    expect(recovered.state).toBe("COMPLETED");
    expect(recovered.transactionId).toBe(timedOut.transactionId);
    expect(controls.settleCallCount).toBe(1);
    expect(controls.hcsPublishCallCount).toBe(1);
  });

  it("pure recovery guard blocks every changed binding fact", async () => {
    const store = new InMemoryReservationStore();
    const controls = createMockControls();
    controls.mirrorImpl = async (txId) => notFound(txId);
    const { service, bundle } = buildService({
      controls,
      store,
      confirmationTimeoutMs: 300,
      mirrorPollIntervalMs: 50,
    });
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "USDC",
      "res-guard-001",
    );
    const timedOut = await service.submitPayment({ clientTransaction: demoClientTransaction(),
      reservationId,
      optionId: "USDC",
      paymentPayloadHash,
    });
    expect(timedOut.state).toBe("CONFIRMATION_TIMED_OUT");
    expect(assessTimedOutConfirmationRecovery(timedOut)).toEqual({ ok: true });

    const cases: Array<{
      mutate: (r: typeof timedOut) => typeof timedOut;
      reason: RegExp;
    }> = [
      {
        mutate: (r) => ({ ...r, transactionId: null }),
        reason: /no settled transaction/i,
      },
      {
        mutate: (r) => ({ ...r, selected: null }),
        reason: /no selected option/i,
      },
      {
        mutate: (r) => ({ ...r, settleClaim: null }),
        reason: /no durable settle claim/i,
      },
      {
        mutate: (r) => ({
          ...r,
          facilitatorSettle: { ...r.facilitatorSettle!, success: false },
        }),
        reason: /no successful facilitator settlement/i,
      },
      {
        mutate: (r) => ({
          ...r,
          facilitatorSettle: {
            ...r.facilitatorSettle!,
            transactionId: "0.0.9197513@1784142999.999999999",
          },
        }),
        reason: /settlement transaction ID mismatch/i,
      },
      {
        mutate: (r) => ({
          ...r,
          paymentPayloadHash: `sha256:${"ab".repeat(32)}`,
        }),
        reason: /fingerprint changed/i,
      },
      {
        mutate: (r) => ({
          ...r,
          settleClaim: { ...r.settleClaim!, payTo: "0.0.9999999" },
        }),
        reason: /no longer matches selected option/i,
      },
      {
        mutate: (r) => ({
          ...r,
          settleClaim: { ...r.settleClaim!, selectedOptionId: "HBAR" as const },
        }),
        reason: /no longer matches selected option/i,
      },
      {
        mutate: (r) => ({
          ...r,
          mirrorPoll: {
            ...r.mirrorPoll!,
            transactionId: "0.0.9197513@1784142999.999999999",
          },
        }),
        reason: /mirror poll transaction ID mismatch/i,
      },
    ];
    for (const c of cases) {
      const verdict = assessTimedOutConfirmationRecovery(c.mutate(timedOut));
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.reason).toMatch(c.reason);
      }
    }
    // No settle or reservation occurred while probing the pure guard.
    expect(controls.settleCallCount).toBe(1);
  });

  it("accepts SDK-form and Mirror-form IDs for the same exact transaction", async () => {
    const store = new InMemoryReservationStore();
    const controls = createMockControls();
    controls.mirrorImpl = async (txId) => notFound(txId);
    const { service, bundle } = buildService({
      controls,
      store,
      confirmationTimeoutMs: 300,
      mirrorPollIntervalMs: 50,
    });
    const { reservationId, paymentPayloadHash, clientTransaction } =
      await createAndSelect(service, bundle, "USDC", "res-txid-form-001");
    const timedOut = await service.submitPayment({
      clientTransaction,
      reservationId,
      optionId: "USDC",
      paymentPayloadHash,
    });
    expect(timedOut.state).toBe("CONFIRMATION_TIMED_OUT");
    const sdkId = timedOut.transactionId!;
    // Mirror form of the same exact transaction (0.0.x@s.n → 0.0.x-s-n).
    const mirrorForm = sdkId.replace("@", "-").replace(/\.(?=\d+$)/, "-");
    expect(mirrorForm).not.toBe(sdkId);

    const sameTxFacilitator = {
      ...timedOut,
      facilitatorSettle: {
        ...timedOut.facilitatorSettle!,
        transactionId: mirrorForm,
      },
    };
    expect(assessTimedOutConfirmationRecovery(sameTxFacilitator)).toEqual({
      ok: true,
    });

    const sameTxMirrorPoll = {
      ...timedOut,
      mirrorPoll: {
        ...timedOut.mirrorPoll!,
        transactionId: mirrorForm,
      },
    };
    expect(assessTimedOutConfirmationRecovery(sameTxMirrorPoll)).toEqual({
      ok: true,
    });

    // A different transaction in either form still fails closed.
    const different = {
      ...timedOut,
      facilitatorSettle: {
        ...timedOut.facilitatorSettle!,
        transactionId: "0.0.9197513@1784142999.999999999",
      },
    };
    expect(assessTimedOutConfirmationRecovery(different).ok).toBe(false);
    expect(controls.settleCallCount).toBe(1);
  });

  it("service routes a blocked recovery to MANUAL_REVIEW_REQUIRED without settling again", async () => {
    const store = new InMemoryReservationStore();
    const controls = createMockControls();
    controls.mirrorImpl = async (txId) => notFound(txId);
    const { service, bundle } = buildService({
      controls,
      store,
      confirmationTimeoutMs: 300,
      mirrorPollIntervalMs: 50,
    });
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "USDC",
      "res-blocked-001",
    );
    const timedOut = await service.submitPayment({ clientTransaction: demoClientTransaction(),
      reservationId,
      optionId: "USDC",
      paymentPayloadHash,
    });
    expect(timedOut.state).toBe("CONFIRMATION_TIMED_OUT");

    // Schema-valid tamper: settle result marked unsuccessful — recovery must
    // refuse and route to manual review rather than silently proceeding.
    const current = (await store.get(reservationId))!;
    await store.compareAndSet(reservationId, current.recordVersion, {
      ...current,
      facilitatorSettle: { ...current.facilitatorSettle!, success: false },
    });

    const reviewed = await service.resumePaymentConfirmation(reservationId);
    expect(reviewed.state).toBe("MANUAL_REVIEW_REQUIRED");
    expect(reviewed.failureCode).toBe("CONFIRMATION_RECOVERY_BLOCKED");
    expect(controls.settleCallCount).toBe(1);
    expect(reviewed.routeReserved).toBeNull();
  });
});
