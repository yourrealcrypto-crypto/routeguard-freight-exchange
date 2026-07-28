/**
 * v1.5 HIGH patches 1+2 — exact client-frozen transaction persistence and the
 * deterministic conclusive-failure rule.
 *
 * Proves: txId + validity persisted BEFORE the facilitator settle call
 * (§22.4/§23.1); exact-transaction reconciliation only; pre-expiry refusal;
 * expiry + 60 s safety-buffer conclusive failure; found-after-restart
 * recovery; no second settle; no asset fallback before conclusion; guarded
 * replacement attempt only after conclusive failure.
 */

import { describe, expect, it } from "vitest";

import { InMemoryReservationStore } from "../src/reservation/attempt-store";
import {
  conclusiveFailureBoundaryMs,
  parseClientTransactionRef,
  SETTLEMENT_SAFETY_BUFFER_SECONDS,
} from "../src/reservation/client-transaction";
import type { MirrorConfirmation } from "../src/reservation/types";
import {
  buildService,
  createAndSelect,
  createMockControls,
  defaultMirrorSuccess,
  demoClientTransaction,
  DEMO_CLIENT_TX_ID,
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

describe("v1.5 §22.4 — pre-settle client transaction persistence", () => {
  it("persists txId + validity on the record and settle claim BEFORE settle", async () => {
    const store = new InMemoryReservationStore();
    const controls = createMockControls();
    // Capture the durable record AT settle time — the claim must already
    // carry the exact client transaction before the external call.
    let claimAtSettle: unknown = null;
    controls.settleImpl = async () => {
      const rec = await store.get("res-presettle-001");
      claimAtSettle = rec?.settleClaim ?? null;
      return {
        success: true,
        transactionId: DEMO_CLIENT_TX_ID,
        network: "hedera:testnet",
        payerAccountId: rec!.selected!.payerAccount,
      };
    };
    const { service, bundle } = buildService({ controls, store });
    controls.mirrorImpl = async (txId) => {
      const rec = await store.get("res-presettle-001");
      return defaultMirrorSuccess(rec!.selected!, txId);
    };
    const { reservationId, paymentPayloadHash, clientTransaction } =
      await createAndSelect(service, bundle, "USDC", "res-presettle-001");
    const done = await service.submitPayment({
      reservationId,
      optionId: "USDC",
      paymentPayloadHash,
      clientTransaction,
    });
    const claim = claimAtSettle as {
      transactionId: string;
      validStartTimestamp: string;
      transactionValidDurationSeconds: number;
    } | null;
    expect(claim).not.toBeNull();
    expect(claim!.transactionId).toBe(clientTransaction.transactionId);
    expect(claim!.validStartTimestamp).toBe(
      clientTransaction.validStartTimestamp,
    );
    expect(claim!.transactionValidDurationSeconds).toBe(180);
    // Record-level binding persisted from PAYMENT_SUBMISSION_STARTED onward.
    expect(done.clientTransaction?.transactionId).toBe(
      clientTransaction.transactionId,
    );
    // The reserved transaction is the client-frozen one.
    expect(done.routeReserved?.transactionId).toBe(
      clientTransaction.transactionId,
    );
  });

  it("rejects missing/invalid client transaction before any transmission", async () => {
    const controls = createMockControls();
    const { service, bundle } = buildService({ controls });
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "USDC",
      "res-missing-ctx",
    );
    await expect(
      service.submitPayment({
        reservationId,
        optionId: "USDC",
        paymentPayloadHash,
        clientTransaction: undefined as never,
      }),
    ).rejects.toThrow(/clientTransaction is required/i);
    // Inconsistent validStart vs ID-embedded timestamp is refused.
    await expect(
      service.submitPayment({
        reservationId,
        optionId: "USDC",
        paymentPayloadHash,
        clientTransaction: {
          ...demoClientTransaction(),
          validStartTimestamp: "2026-07-15T00:00:00.000000000Z",
        },
      }),
    ).rejects.toThrow(/must equal the ID-embedded valid start/i);
    expect(controls.verifyCallCount).toBe(0);
    expect(controls.settleCallCount).toBe(0);
  });

  it("settle response reporting a DIFFERENT transaction routes to manual review", async () => {
    const controls = createMockControls({
      settleResult: {
        success: true,
        transactionId: "0.0.9197513@1784149999.999999999",
        network: "hedera:testnet",
        payerAccountId: "0.0.9197513",
      },
    });
    const { service, bundle } = buildService({ controls });
    const { reservationId, paymentPayloadHash, clientTransaction } =
      await createAndSelect(service, bundle, "USDC", "res-txmismatch");
    const record = await service.submitPayment({
      reservationId,
      optionId: "USDC",
      paymentPayloadHash,
      clientTransaction,
    });
    expect(record.state).toBe("MANUAL_REVIEW_REQUIRED");
    expect(record.failureCode).toBe("SETTLE_RESPONSE_TX_MISMATCH");
    expect(record.routeReserved).toBeNull();
    expect(controls.settleCallCount).toBe(1);
  });
});

describe("v1.5 §23.2 — deterministic conclusive-failure rule", () => {
  async function crashMidSettle(reservationId: string, nowIso: string) {
    const store = new InMemoryReservationStore();
    const controls = createMockControls();
    // Settle crashes AFTER the durable claim exists (transport interruption).
    controls.settleImpl = async () => {
      throw new Error("simulated transport crash during settle");
    };
    const built = buildService({ controls, store, now: nowIso });
    const sel = await createAndSelect(
      built.service,
      built.bundle,
      "USDC",
      reservationId,
    );
    await expect(
      built.service.submitPayment({
        reservationId,
        optionId: "USDC",
        paymentPayloadHash: sel.paymentPayloadHash,
        clientTransaction: sel.clientTransaction,
      }),
    ).rejects.toThrow(/crash during settle/);
    const rec = (await store.get(reservationId))!;
    expect(rec.state).toBe("FACILITATOR_SETTLE_CLAIMED");
    expect(rec.settleClaim?.transactionId).toBe(sel.clientTransaction.transactionId);
    return { store, controls, built, sel };
  }

  it("pre-expiry NOT_FOUND refuses to conclude and blocks replacement", async () => {
    // Clock just after valid start — window not elapsed.
    const { store, controls, built, sel } = await crashMidSettle(
      "res-preexpiry",
      "2026-07-15T19:01:00.000Z",
    );
    controls.mirrorImpl = async (txId) => notFound(txId);
    const { outcome, record } = await built.service.reconcilePayment(
      "res-preexpiry",
    );
    expect(outcome.outcome).toBe("RECONCILIATION_PENDING");
    expect(record.state).toBe("FACILITATOR_SETTLE_CLAIMED");
    // Replacement/asset fallback refused while unresolved.
    await expect(
      built.service.authorizeReplacementAttempt("res-preexpiry"),
    ).rejects.toThrow(/CONCLUSIVELY_FAILED/);
    await expect(
      built.service.submitPayment({
        reservationId: "res-preexpiry",
        optionId: "HBAR",
        paymentPayloadHash: sel.paymentPayloadHash,
        clientTransaction: sel.clientTransaction,
      }),
    ).rejects.toThrow(/route does not match|no fallback/i);
    expect(controls.settleCallCount).toBe(1);
    void store;
  });

  it("post-boundary NOT_FOUND is conclusively failed; replacement then authorized", async () => {
    const { controls, built, sel } = await crashMidSettle(
      "res-conclusive",
      "2026-07-15T19:01:00.000Z",
    );
    controls.mirrorImpl = async (txId) => notFound(txId);
    // Advance beyond validStart + 180 s + 60 s buffer.
    const boundary = conclusiveFailureBoundaryMs(sel.clientTransaction);
    built.setNow(new Date(boundary + 1000).toISOString());
    const { outcome, record } = await built.service.reconcilePayment(
      "res-conclusive",
    );
    expect(outcome.outcome).toBe("CONCLUSIVELY_FAILED");
    expect(record.state).toBe("SETTLEMENT_FAILED");
    expect(record.failureCode).toBe("CONCLUSIVELY_FAILED");
    expect(controls.settleCallCount).toBe(1);

    // Guarded replacement: allowed ONLY now, resets to OFFER_CREATED.
    const replaced = await built.service.authorizeReplacementAttempt(
      "res-conclusive",
    );
    expect(replaced.state).toBe("OFFER_CREATED");
    expect(replaced.settleClaim).toBeNull();
    expect(replaced.transactionId).toBeNull();
    expect(replaced.clientTransaction).toBeNull();
    // A different seller-supported asset may now be selected (new attempt).
    const again = await built.service.selectOption({
      reservationId: "res-conclusive",
      optionId: "HBAR",
      offerHash: replaced.offer.offerHash,
      offerVersion: replaced.offer.offerVersion,
      payerAccount: "0.0.9197513",
    });
    expect(again.selected?.optionId).toBe("HBAR");
  });

  it("exact transaction found SUCCESS after restart recovers without a second settle", async () => {
    const { store, controls, built, sel } = await crashMidSettle(
      "res-foundlater",
      "2026-07-15T19:01:00.000Z",
    );
    // "Restart": fresh service instance over the same durable store.
    const second = buildService({
      controls,
      store,
      bundle: built.bundle,
      now: "2026-07-15T19:02:00.000Z",
    });
    controls.mirrorImpl = async (txId) => {
      const rec = await store.get("res-foundlater");
      return defaultMirrorSuccess(rec!.selected!, txId);
    };
    const { outcome, record } = await second.service.reconcilePayment(
      "res-foundlater",
    );
    expect(outcome.outcome).toBe("FOUND_SUCCESS");
    expect(record.routeReserved?.transactionId).toBe(
      sel.clientTransaction.transactionId,
    );
    expect(record.state).toBe("COMPLETED");
    // Exactly one settle (the crashed original); recovery never re-settles.
    expect(controls.settleCallCount).toBe(1);
    expect(controls.hcsPublishCallCount).toBe(1);
  });

  it("exact transaction found FAILED marks SETTLEMENT_FAILED without replacementauthorization", async () => {
    const { controls, built } = await crashMidSettle(
      "res-foundfailed",
      "2026-07-15T19:01:00.000Z",
    );
    controls.mirrorImpl = async (txId) => ({
      status: "FAILED",
      transactionId: txId,
      consensusTimestamp: "2026-07-15T19:02:00.000000001Z",
      result: "INSUFFICIENT_PAYER_BALANCE",
      hbarTransfers: [],
      tokenTransfers: [],
    });
    const { outcome, record } = await built.service.reconcilePayment(
      "res-foundfailed",
    );
    expect(outcome.outcome).toBe("FOUND_FAILED");
    expect(record.state).toBe("SETTLEMENT_FAILED");
    expect(record.failureCode).toBe("SETTLE_RESULT_FAILED_ON_LEDGER");
    // FOUND_FAILED is not the conclusive-failure rule → replacement refused.
    await expect(
      built.service.authorizeReplacementAttempt("res-foundfailed"),
    ).rejects.toThrow(/CONCLUSIVELY_FAILED/);
  });
});

describe("client-transaction reference validation", () => {
  it("boundary math is validStart + duration + 60 s", () => {
    const ref = demoClientTransaction();
    const start = Date.parse(ref.validStartTimestamp);
    expect(conclusiveFailureBoundaryMs(ref)).toBe(
      start + 180_000 + SETTLEMENT_SAFETY_BUFFER_SECONDS * 1000,
    );
  });

  it("parse rejects malformed IDs, inconsistent validStart, bad duration", () => {
    expect(() => parseClientTransactionRef(null)).toThrow(/required/);
    expect(() =>
      parseClientTransactionRef({
        transactionId: "not-a-tx",
        validStartTimestamp: "2026-07-15T19:00:00.100000000Z",
        transactionValidDurationSeconds: 180,
      }),
    ).toThrow(/SDK form/);
    expect(() =>
      parseClientTransactionRef({
        transactionId: DEMO_CLIENT_TX_ID,
        validStartTimestamp: "2026-07-15T00:00:00.000000000Z",
        transactionValidDurationSeconds: 180,
      }),
    ).toThrow(/ID-embedded/);
    expect(() =>
      parseClientTransactionRef({
        ...demoClientTransaction(),
        transactionValidDurationSeconds: 181,
      }),
    ).toThrow(/1\.\.180/);
    expect(parseClientTransactionRef(demoClientTransaction())).toEqual(
      demoClientTransaction(),
    );
  });
});
