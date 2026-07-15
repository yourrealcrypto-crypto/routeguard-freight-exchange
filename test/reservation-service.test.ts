import { describe, expect, it } from "vitest";

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

    const final = await service.submitPayment({
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

    const final = await service.submitPayment({
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
    const final = await service.submitPayment({
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
    const final = await service.submitPayment({
      reservationId,
      optionId: "HBAR",
      paymentPayloadHash,
    });
    expect(final.state).toBe("SETTLEMENT_FAILED");
    expect(controls.settleCallCount).toBe(1);

    await expect(
      service.submitPayment({
        reservationId,
        optionId: "HBAR",
        paymentPayloadHash,
      }),
    ).rejects.toThrow(/TERMINAL|terminal/i);
  });

  it("missing transaction ID fails closed", async () => {
    const { service, controls, bundle } = buildService();
    controls.settleResult = {
      success: true,
      transactionId: null,
      network: "hedera:testnet",
      payerAccountId: DEMO_PAYER_ACCOUNT,
    };
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "HBAR",
      "res-no-txid",
    );
    const final = await service.submitPayment({
      reservationId,
      optionId: "HBAR",
      paymentPayloadHash,
    });
    expect(final.state).toBe("SETTLEMENT_FAILED");
    expect(final.failureCode).toBe("MISSING_TRANSACTION_ID");
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
    const pending = await service.submitPayment({
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
    const failed = await s2.submitPayment({
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
    await service.submitPayment({
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

  it("recovery from in-progress states is fail-closed", async () => {
    const { service, store, bundle } = buildService();
    const input = createReservationInputFromBundle(bundle, "res-recover");
    await service.createReservation(input, bundle.tender);
    const rec = await store.get("res-recover");
    await store.put({
      ...rec!,
      state: "PAYMENT_SUBMISSION_STARTED",
      attemptNumber: 1,
      paymentPayloadHash: "sha256:" + "ab".repeat(32),
    });
    const recovered = await service.recover("res-recover");
    expect(recovered.state).toBe("MANUAL_REVIEW_REQUIRED");
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
    const final = await service.submitPayment({
      reservationId,
      optionId: "HBAR",
      paymentPayloadHash,
      httpStatus: 200,
    });
    expect(final.routeReserved).toBeNull();
  });
});
