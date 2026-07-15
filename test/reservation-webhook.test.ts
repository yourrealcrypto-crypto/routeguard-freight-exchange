import { describe, expect, it } from "vitest";

import { canonicalSha256 } from "../src/domain/canonical-hash";
import {
  createRouteReservedWebhookPayload,
  reservationWebhookEventId,
  signWebhook,
  verifyWebhook,
} from "../src/reservation/webhook";
import {
  DEMO_WINNER_ACCOUNT,
  RESERVATION_TEST_WEBHOOK_PRIVATE_KEY,
  RESERVATION_TEST_WEBHOOK_PUBLIC_KEY,
} from "./fixtures/reservation-fixtures";

describe("Reservation webhooks", () => {
  const payload = createRouteReservedWebhookPayload({
    eventId: reservationWebhookEventId("res-1", "shipper"),
    reservation: {
      reservationId: "res-1",
      tenderId: "tender-1",
      winningBidId: "bid-a",
    },
    carrierAccount: DEMO_WINNER_ACCOUNT,
    selectedOptionId: "USDC",
    paymentAsset: "0.0.429274",
    paymentAmountAtomic: "10000",
    transactionId: "0.0.9197513@1.2",
    consensusTimestamp: "2026-07-15T19:05:00.123456789Z",
    reservationRecordHash: "sha256:" + "ab".repeat(32),
    emittedAt: "2026-07-15T19:06:00.000Z",
  });

  it("signs and verifies with test-only ECDSA key", () => {
    const signed = signWebhook(payload, RESERVATION_TEST_WEBHOOK_PRIVATE_KEY);
    expect(signed.headers["X-RouteGuard-Event-Id"]).toBe(payload.eventId);
    expect(signed.headers["X-RouteGuard-Signature-Version"]).toBeTruthy();
    expect(verifyWebhook(signed, RESERVATION_TEST_WEBHOOK_PUBLIC_KEY)).toBe(
      true,
    );
  });

  it("payload tampering fails verification", () => {
    const signed = signWebhook(payload, RESERVATION_TEST_WEBHOOK_PRIVATE_KEY);
    const tampered = {
      ...signed,
      payload: { ...signed.payload, paymentAmountAtomic: "1" },
      payloadHash: canonicalSha256({
        ...signed.payload,
        paymentAmountAtomic: "1",
      }),
    };
    expect(
      verifyWebhook(tampered, RESERVATION_TEST_WEBHOOK_PUBLIC_KEY),
    ).toBe(false);
  });

  it("header/timestamp tampering fails", () => {
    const signed = signWebhook(payload, RESERVATION_TEST_WEBHOOK_PRIVATE_KEY);
    const badTs = {
      ...signed,
      headers: {
        ...signed.headers,
        "X-RouteGuard-Timestamp": "2026-07-15T00:00:00.000Z",
      },
    };
    expect(verifyWebhook(badTs, RESERVATION_TEST_WEBHOOK_PUBLIC_KEY)).toBe(
      false,
    );

    const badEvent = {
      ...signed,
      headers: {
        ...signed.headers,
        "X-RouteGuard-Event-Id": "other-event",
      },
    };
    expect(verifyWebhook(badEvent, RESERVATION_TEST_WEBHOOK_PUBLIC_KEY)).toBe(
      false,
    );
  });

  it("retries reuse same event ID", () => {
    const a = reservationWebhookEventId("res-1", "carrier");
    const b = reservationWebhookEventId("res-1", "carrier");
    expect(a).toBe(b);
    expect(a).toContain("carrier");
  });

  it("webhook failure does not reverse reservation (service-level)", async () => {
    const {
      buildService,
      createAndSelect,
      defaultMirrorSuccess,
    } = await import("./reservation-helpers");
    const { service, controls, bundle } = buildService();
    controls.webhookOk = false;
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "HBAR",
      "res-wh-fail",
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
      final.state === "WEBHOOK_DELIVERY_FAILED" ||
        final.state === "HCS_EVIDENCE_RECORDED" ||
        final.state === "HCS_EVIDENCE_FAILED" ||
        final.state === "COMPLETED",
    ).toBe(true);
    // never reversed to pre-reservation
    expect(final.state).not.toBe("PAYMENT_CONFIRMED");
    expect(final.state).not.toBe("OFFER_CREATED");
  });
});
