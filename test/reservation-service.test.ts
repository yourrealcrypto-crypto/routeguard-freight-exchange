import { describe, expect, it } from "vitest";
import { demoClientTransaction } from "./reservation-helpers";

import { isVerifiedAuctionClosureProof } from "../src/auction/closure-proof";
import { ReservationError } from "../src/reservation/types";
import {
  buildService,
  createAndSelect,
  createReservationInputFromBundle,
  defaultMirrorSuccess,
  DEMO_PAYER_ACCOUNT,
} from "./reservation-helpers";

describe("Reservation service", () => {
  it("creates reservation only from authentic verified winner", async () => {
    const { service, bundle } = buildService();
    const input = createReservationInputFromBundle(bundle, "res-svc-1");
    expect(isVerifiedAuctionClosureProof(input.closureProof)).toBe(true);
    const rec = await service.createReservation(input, bundle.tender);
    expect(rec.state).toBe("OFFER_CREATED");
    expect(rec.offer.payTo).toBe(bundle.winningCarrierAccount);
    expect(rec.offer.options).toHaveLength(2);

    // forged proof
    const forged = {
      ...input,
      reservationId: "res-forged",
      closureProof: { ...bundle.proof } as typeof bundle.proof,
    };
    await expect(
      service.createReservation(forged, bundle.tender),
    ).rejects.toThrow(/authentic|FORGED/i);
  });

  it("rejects wrong winner and wrong carrier account", async () => {
    const { service, bundle } = buildService();
    const input = createReservationInputFromBundle(bundle, "res-wrong");
    await expect(
      service.createReservation(
        { ...input, winningBidId: "bid-b-b3e38a" },
        bundle.tender,
      ),
    ).rejects.toThrow(/WRONG_WINNER|winningBidId/i);

    await expect(
      service.createReservation(
        { ...input, reservationId: "res-acct", winningCarrierAccount: "0.0.1" },
        bundle.tender,
      ),
    ).rejects.toThrow(/WRONG_CARRIER_ACCOUNT|carrier/i);
  });

  it("HBAR path reaches ROUTE_RESERVED / COMPLETED", async () => {
    const { service, controls, bundle } = buildService();
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "HBAR",
      "res-hbar-ok",
    );
    const sel = (await service.getReservation(reservationId))!.selected!;
    controls.mirrorResult = defaultMirrorSuccess(
      sel,
      controls.settleResult.transactionId!,
    );

    const final = await service.submitPayment({ clientTransaction: demoClientTransaction(),
      reservationId,
      optionId: "HBAR",
      paymentPayloadHash,
    });
    expect(final.routeReserved).not.toBeNull();
    expect(
      final.state === "COMPLETED" ||
        final.state === "HCS_EVIDENCE_RECORDED" ||
        final.state === "ROUTE_RESERVED" ||
        final.state === "WEBHOOKS_DISPATCHED",
    ).toBe(true);
    expect(final.routeReserved?.selectedOptionId).toBe("HBAR");
    expect(final.routeReserved?.paymentAmountAtomic).toBe("1000000");
    expect(final.routeReserved?.carrierAccount).toBe(
      bundle.winningCarrierAccount,
    );
    expect(controls.settleCallCount).toBe(1);
    expect(service.getSettleCallCount(reservationId)).toBe(1);
  });

  it("USDC path reaches ROUTE_RESERVED", async () => {
    const { service, controls, bundle } = buildService();
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "USDC",
      "res-usdc-ok",
    );
    const sel = (await service.getReservation(reservationId))!.selected!;
    controls.mirrorResult = defaultMirrorSuccess(
      sel,
      controls.settleResult.transactionId!,
    );

    const final = await service.submitPayment({ clientTransaction: demoClientTransaction(),
      reservationId,
      optionId: "USDC",
      paymentPayloadHash,
    });
    expect(final.routeReserved?.selectedOptionId).toBe("USDC");
    expect(final.routeReserved?.paymentAsset).toBe("0.0.429274");
    expect(final.routeReserved?.paymentAmountAtomic).toBe("10000");
  });

  it("verify rejection prevents settle", async () => {
    const { service, controls, bundle } = buildService();
    controls.verifyResult = { isValid: false, invalidReason: "bad sig" };
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "USDC",
      "res-verify-fail",
    );
    const final = await service.submitPayment({ clientTransaction: demoClientTransaction(),
      reservationId,
      optionId: "USDC",
      paymentPayloadHash,
    });
    expect(final.state).toBe("PAYMENT_REJECTED");
    expect(controls.settleCallCount).toBe(0);
  });

  it("settle failure is terminal; settle once", async () => {
    const { service, controls, bundle } = buildService();
    controls.settleResult = {
      success: false,
      transactionId: null,
      network: "hedera:testnet",
      payerAccountId: DEMO_PAYER_ACCOUNT,
      errorReason: "facilitator down",
    };
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "HBAR",
      "res-settle-fail",
    );
    const final = await service.submitPayment({ clientTransaction: demoClientTransaction(),
      reservationId,
      optionId: "HBAR",
      paymentPayloadHash,
    });
    expect(final.state).toBe("SETTLEMENT_FAILED");
    expect(controls.settleCallCount).toBe(1);

    await expect(
      service.submitPayment({ clientTransaction: demoClientTransaction(),
        reservationId,
        optionId: "HBAR",
        paymentPayloadHash,
      }),
    ).rejects.toThrow(/TERMINAL|terminal/i);
  });

  it("settle response without a transaction ID confirms the exact client-frozen transaction", async () => {
    // v1.5 §23: the client-frozen ID persisted pre-settle is authoritative.
    // A success response lacking an ID no longer fails — confirmation runs
    // against the exact client transaction.
    const { service, store, controls, bundle } = buildService();
    controls.settleResult = {
      success: true,
      transactionId: null,
      network: "hedera:testnet",
      payerAccountId: DEMO_PAYER_ACCOUNT,
    };
    controls.mirrorImpl = async (txId) => {
      const rec = await store.get("res-no-txid");
      return defaultMirrorSuccess(rec!.selected!, txId);
    };
    const { reservationId, paymentPayloadHash, clientTransaction } =
      await createAndSelect(service, bundle, "HBAR", "res-no-txid");
    const final = await service.submitPayment({
      clientTransaction,
      reservationId,
      optionId: "HBAR",
      paymentPayloadHash,
    });
    expect(final.transactionId).toBe(clientTransaction.transactionId);
    expect(final.routeReserved?.transactionId).toBe(
      clientTransaction.transactionId,
    );
  });

  it("mirror pending does not reserve; mirror failure does not reserve", async () => {
    const { service, controls, bundle } = buildService();
    controls.mirrorResult = {
      status: "PENDING",
      transactionId: controls.settleResult.transactionId!,
      consensusTimestamp: null,
      result: null,
      hbarTransfers: [],
      tokenTransfers: [],
    };
    const a = await createAndSelect(service, bundle, "HBAR", "res-pending");
    const pending = await service.submitPayment({ clientTransaction: demoClientTransaction(),
      reservationId: a.reservationId,
      optionId: "HBAR",
      paymentPayloadHash: a.paymentPayloadHash,
    });
    expect(pending.routeReserved).toBeNull();
    expect(pending.state).toBe("CONFIRMATION_TIMED_OUT");

    const { service: s2, controls: c2, bundle: b2 } = buildService();
    c2.mirrorResult = {
      status: "FAILED",
      transactionId: c2.settleResult.transactionId!,
      consensusTimestamp: null,
      result: "FAILED",
      hbarTransfers: [],
      tokenTransfers: [],
    };
    const b = await createAndSelect(s2, b2, "USDC", "res-mfail");
    const failed = await s2.submitPayment({ clientTransaction: demoClientTransaction(),
      reservationId: b.reservationId,
      optionId: "USDC",
      paymentPayloadHash: b.paymentPayloadHash,
    });
    expect(failed.routeReserved).toBeNull();
    expect(failed.state).toBe("CONFIRMATION_FAILED");
  });

  it("selecting USDC locks HBAR route", async () => {
    const { service, bundle } = buildService();
    const input = createReservationInputFromBundle(bundle, "res-lock");
    const rec = await service.createReservation(input, bundle.tender);
    await service.selectOption({
      reservationId: "res-lock",
      optionId: "USDC",
      offerHash: rec.offer.offerHash,
      offerVersion: rec.offer.offerVersion,
      payerAccount: DEMO_PAYER_ACCOUNT,
    });
    await expect(service.issueChallenge("res-lock", "HBAR")).rejects.toThrow(
      /WRONG_ASSET|fallback|Selected/i,
    );
  });

  it("second selection rejected after submission", async () => {
    const { service, controls, bundle } = buildService();
    const { reservationId, paymentPayloadHash, offerHash } =
      await createAndSelect(service, bundle, "USDC", "res-second-sel");
    const sel = (await service.getReservation(reservationId))!.selected!;
    controls.mirrorResult = defaultMirrorSuccess(
      sel,
      controls.settleResult.transactionId!,
    );
    // Start submission by setting verify to hang path - use invalid then
    // Actually after challenge, try reselect after submission started via force
    await service.submitPayment({ clientTransaction: demoClientTransaction(),
      reservationId,
      optionId: "USDC",
      paymentPayloadHash,
    });
    await expect(
      service.selectOption({
        reservationId,
        optionId: "HBAR",
        offerHash,
        offerVersion: 1,
        payerAccount: DEMO_PAYER_ACCOUNT,
      }),
    ).rejects.toThrow(/locked|re-select|SELECTION/i);
  });

  it("idempotent create and status read", async () => {
    const { service, bundle } = buildService();
    const input = createReservationInputFromBundle(bundle, "res-idemp");
    const a = await service.createReservation(input, bundle.tender);
    const b = await service.createReservation(input, bundle.tender);
    expect(a.reservationId).toBe(b.reservationId);
    expect(a.offer.offerHash).toBe(b.offer.offerHash);
  });

  it("recovery from in-progress states stays reconcilable via the client transaction", async () => {
    const { service, store, bundle } = buildService();
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "HBAR",
      "res-recover",
    );
    const rec = (await store.get(reservationId))!;
    // Valid PAYMENT_SUBMISSION_STARTED snapshot: selection + challenge +
    // client-frozen transaction binding present (v1.5 §22.4).
    await store.compareAndSet(reservationId, rec.recordVersion, {
      ...rec,
      state: "PAYMENT_SUBMISSION_STARTED",
      attemptNumber: 1,
      paymentPayloadHash,
      clientTransaction: demoClientTransaction(),
    });
    // Restart keeps the state deterministically reconcilable — never a blind
    // retry, never a settle; reconcilePayment applies the exact-tx rule.
    const recovered = await service.recover(reservationId);
    expect(recovered.state).toBe("PAYMENT_SUBMISSION_STARTED");
    expect(recovered.clientTransaction?.transactionId).toBe(
      demoClientTransaction().transactionId,
    );
  });

  it("reservedAt equals the Mirror consensus timestamp; clock changes do not alter the record hash", async () => {
    async function reserve(nowClock: string): Promise<{
      reservedAt: string;
      consensusTimestamp: string;
      recordHash: string;
    }> {
      const { service, controls, bundle } = buildService({ now: nowClock });
      const { reservationId, paymentPayloadHash } = await createAndSelect(
        service,
        bundle,
        "USDC",
        "res-clock-fixed",
      );
      const sel = (await service.getReservation(reservationId))!.selected!;
      controls.mirrorResult = defaultMirrorSuccess(
        sel,
        controls.settleResult.transactionId!,
      );
      const final = await service.submitPayment({ clientTransaction: demoClientTransaction(),
        reservationId,
        optionId: "USDC",
        paymentPayloadHash,
      });
      const rr = final.routeReserved!;
      return {
        reservedAt: rr.reservedAt,
        consensusTimestamp: rr.consensusTimestamp,
        recordHash: rr.reservationRecordHash,
      };
    }

    const consensus = "2026-07-15T19:05:00.123456789Z";
    // Two very different local service clocks, both within the offer window.
    const a = await reserve("2026-07-15T19:01:00.000Z");
    const b = await reserve("2026-07-15T19:58:30.500Z");

    expect(a.reservedAt).toBe(consensus);
    expect(a.reservedAt).toBe(a.consensusTimestamp);
    expect(b.reservedAt).toBe(consensus);
    // Same authoritative payment ⇒ identical record hash regardless of clock.
    expect(a.recordHash).toBe(b.recordHash);
  });

  it("missing consensus timestamp cannot reserve", async () => {
    const { service, controls, bundle } = buildService();
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "HBAR",
      "res-no-consensus",
    );
    const sel = (await service.getReservation(reservationId))!.selected!;
    const ok = defaultMirrorSuccess(sel, controls.settleResult.transactionId!);
    controls.mirrorResult = { ...ok, consensusTimestamp: null };
    const final = await service.submitPayment({ clientTransaction: demoClientTransaction(),
      reservationId,
      optionId: "HBAR",
      paymentPayloadHash,
    });
    expect(final.routeReserved).toBeNull();
    expect(final.state).toBe("CONFIRMATION_FAILED");
  });

  it("malformed consensus timestamp cannot reserve", async () => {
    const { service, controls, bundle } = buildService();
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "HBAR",
      "res-bad-consensus",
    );
    const sel = (await service.getReservation(reservationId))!.selected!;
    const ok = defaultMirrorSuccess(sel, controls.settleResult.transactionId!);
    controls.mirrorResult = { ...ok, consensusTimestamp: "not-a-timestamp" };
    const final = await service.submitPayment({ clientTransaction: demoClientTransaction(),
      reservationId,
      optionId: "HBAR",
      paymentPayloadHash,
    });
    expect(final.routeReserved).toBeNull();
    expect(final.state).toBe("CONFIRMATION_FAILED");
  });

  it("HTTP 200 alone is never treated as settlement proof", async () => {
    const { assertNotHttpOnlyProof } = await import(
      "../src/reservation/payment-verifier"
    );
    expect(() =>
      assertNotHttpOnlyProof({
        httpStatus: 200,
        hasSettlementSuccess: false,
        hasTransactionId: false,
        mirrorSuccess: false,
      }),
    ).toThrow(/HTTP 200|INSUFFICIENT/i);

    // Full path still requires facilitator + mirror even if client saw HTTP 200
    const { service, controls, bundle } = buildService();
    controls.mirrorResult = {
      status: "PENDING",
      transactionId: controls.settleResult.transactionId!,
      consensusTimestamp: null,
      result: null,
      hbarTransfers: [],
      tokenTransfers: [],
    };
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "HBAR",
      "res-http",
    );
    const final = await service.submitPayment({ clientTransaction: demoClientTransaction(),
      reservationId,
      optionId: "HBAR",
      paymentPayloadHash,
      httpStatus: 200,
    });
    expect(final.routeReserved).toBeNull();
  });
});
