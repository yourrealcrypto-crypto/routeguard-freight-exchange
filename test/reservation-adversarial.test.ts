import { describe, expect, it } from "vitest";

import { createReservationApp } from "../src/reservation/routes";
import { createRouteReservedRecord } from "../src/reservation/route-reserved-record";
import { verifyRouteReservedRecordHash } from "../src/reservation/route-reserved-record";
import {
  buildService,
  createAndSelect,
  createReservationInputFromBundle,
  defaultMirrorSuccess,
  DEMO_PAYER_ACCOUNT,
} from "./reservation-helpers";
import {
  buildVerifiedWinnerBundle,
  DEMO_WINNER_ACCOUNT,
} from "./fixtures/reservation-fixtures";

describe("Reservation adversarial", () => {
  it("JSON-round-tripped proof is rejected", async () => {
    const { service, bundle } = buildService();
    const input = createReservationInputFromBundle(bundle, "res-json");
    const jsonProof = JSON.parse(JSON.stringify(bundle.proof));
    await expect(
      service.createReservation(
        { ...input, closureProof: jsonProof },
        bundle.tender,
      ),
    ).rejects.toThrow(/authentic|FORGED/i);
  });

  it("spread-copied proof is rejected", async () => {
    const { service, bundle } = buildService();
    const input = createReservationInputFromBundle(bundle, "res-spread");
    await expect(
      service.createReservation(
        { ...input, closureProof: { ...bundle.proof } as typeof bundle.proof },
        bundle.tender,
      ),
    ).rejects.toThrow(/authentic|FORGED/i);
  });

  it("wrong amount/asset on mirror cannot reserve", async () => {
    const { service, controls, bundle } = buildService();
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "HBAR",
      "res-bad-amt",
    );
    controls.mirrorResult = {
      status: "SUCCESS",
      transactionId: controls.settleResult.transactionId!,
      consensusTimestamp: "2026-07-15T19:05:00.123456789Z",
      result: "SUCCESS",
      hbarTransfers: [
        { account: DEMO_PAYER_ACCOUNT, amount: "-999" },
        { account: DEMO_WINNER_ACCOUNT, amount: "999" },
      ],
      tokenTransfers: [],
    };
    const final = await service.submitPayment({
      reservationId,
      optionId: "HBAR",
      paymentPayloadHash,
    });
    expect(final.routeReserved).toBeNull();
    expect(final.state).toBe("CONFIRMATION_FAILED");
  });

  it("API: wrong asset after selection returns conflict", async () => {
    const { service, bundle } = buildService();
    const input = createReservationInputFromBundle(bundle, "res-api");
    const rec = await service.createReservation(input, bundle.tender);
    await service.selectOption({
      reservationId: "res-api",
      optionId: "USDC",
      offerHash: rec.offer.offerHash,
      offerVersion: rec.offer.offerVersion,
      payerAccount: DEMO_PAYER_ACCOUNT,
    });
    const app = createReservationApp({ service });
    const res = await app.request("/api/reservations/res-api/pay/hbar");
    expect(res.status).toBe(409);
  });

  it("API: options and status are read-safe", async () => {
    const { service, bundle } = buildService();
    const input = createReservationInputFromBundle(bundle, "res-api2");
    await service.createReservation(input, bundle.tender);
    const app = createReservationApp({ service });
    const opt = await app.request("/api/reservations/res-api2/options");
    expect(opt.status).toBe(200);
    const body = (await opt.json()) as { offer: { feeLabel: string } };
    expect(body.offer.feeLabel).toMatch(/Demo reservation fee/);

    const st1 = await app.request("/api/reservations/res-api2/status");
    const st2 = await app.request("/api/reservations/res-api2/status");
    expect(st1.status).toBe(200);
    expect(st2.status).toBe(200);
    expect(await st1.json()).toEqual(await st2.json());
  });

  it("API select + pay usdc happy path", async () => {
    const { service, controls, bundle } = buildService();
    const input = createReservationInputFromBundle(bundle, "res-api3");
    const rec = await service.createReservation(input, bundle.tender);
    const app = createReservationApp({ service });

    const sel = await app.request("/api/reservations/res-api3/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        optionId: "USDC",
        offerHash: rec.offer.offerHash,
        offerVersion: rec.offer.offerVersion,
        payerAccount: DEMO_PAYER_ACCOUNT,
      }),
    });
    expect(sel.status).toBe(200);

    const ch = await app.request("/api/reservations/res-api3/pay/usdc");
    expect(ch.status).toBe(200);
    const challengeBody = (await ch.json()) as {
      challenge: { amount: string; asset: string };
    };
    expect(challengeBody.challenge.amount).toBe("10000");
    expect(challengeBody.challenge.asset).toBe("0.0.429274");

    const selected = (await service.getReservation("res-api3"))!.selected!;
    controls.mirrorResult = defaultMirrorSuccess(
      selected,
      controls.settleResult.transactionId!,
    );

    const pay = await app.request("/api/reservations/res-api3/pay/usdc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        paymentPayloadHash: "sha256:" + "cd".repeat(32),
      }),
    });
    expect(pay.status).toBe(200);
    const paid = (await pay.json()) as { routeReserved: unknown; state: string };
    expect(paid.routeReserved).toBeTruthy();
  });

  it("duplicate payment request with same payload is idempotent after reserve", async () => {
    const { service, controls, bundle } = buildService();
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "HBAR",
      "res-dup",
    );
    const sel = (await service.getReservation(reservationId))!.selected!;
    controls.mirrorResult = defaultMirrorSuccess(
      sel,
      controls.settleResult.transactionId!,
    );
    const a = await service.submitPayment({
      reservationId,
      optionId: "HBAR",
      paymentPayloadHash,
    });
    const b = await service.submitPayment({
      reservationId,
      optionId: "HBAR",
      paymentPayloadHash,
    });
    expect(a.routeReserved?.reservationRecordHash).toBe(
      b.routeReserved?.reservationRecordHash,
    );
    expect(controls.settleCallCount).toBe(1);
  });

  it("conflicting payload after reserve is rejected", async () => {
    const { service, controls, bundle } = buildService();
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "USDC",
      "res-conflict",
    );
    const sel = (await service.getReservation(reservationId))!.selected!;
    controls.mirrorResult = defaultMirrorSuccess(
      sel,
      controls.settleResult.transactionId!,
    );
    await service.submitPayment({
      reservationId,
      optionId: "USDC",
      paymentPayloadHash,
    });
    await expect(
      service.submitPayment({
        reservationId,
        optionId: "USDC",
        paymentPayloadHash: "sha256:" + "ff".repeat(32),
      }),
    ).rejects.toThrow(/CONFLICT|different/i);
  });

  it("reservation record hash stable under input rebuild", () => {
    const bundle = buildVerifiedWinnerBundle();
    const args = {
      reservationId: "res-hash",
      tenderId: bundle.tender.tenderId,
      tenderVersion: 1,
      tenderHash: bundle.tHash,
      winningBidId: bundle.winningBidId,
      winningBidHash: bundle.winningBidHash,
      carrierId: bundle.winningCarrierId,
      carrierAccount: bundle.winningCarrierAccount,
      selectedOptionId: "HBAR" as const,
      paymentAsset: "0.0.0",
      paymentAmountAtomic: "1000000",
      payerAccount: DEMO_PAYER_ACCOUNT,
      transactionId: "0.0.9197513@9.9",
      consensusTimestamp: "2026-07-15T19:05:00.123456789Z",
      decisionManifestHash: bundle.proof.manifest.decisionManifestHash,
      evaluatedBidSetHash: bundle.proof.manifest.evaluatedBidSetHash,
      hcsAuctionTopicId: "0.0.9587459",
      closeBarrierSequence: 4,
      reservedAt: "2026-07-15T19:06:00.000Z",
    };
    const a = createRouteReservedRecord(args);
    const b = createRouteReservedRecord(args);
    expect(a.reservationRecordHash).toBe(b.reservationRecordHash);
    expect(verifyRouteReservedRecordHash(a)).toBe(true);
  });
});
