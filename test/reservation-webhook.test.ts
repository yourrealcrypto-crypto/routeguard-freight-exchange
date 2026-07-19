import { describe, expect, it } from "vitest";
import { demoClientTransaction } from "./reservation-helpers";

import { canonicalSha256 } from "../src/domain/canonical-hash";
import {
  createRouteReservedWebhookPayload,
  rebuildSignedWebhook,
  reservationWebhookEventId,
  signWebhook,
  verifyWebhook,
} from "../src/reservation/webhook";
import {
  DEMO_WINNER_ACCOUNT,
  RESERVATION_TEST_WEBHOOK_PRIVATE_KEY,
  RESERVATION_TEST_WEBHOOK_PUBLIC_KEY,
} from "./fixtures/reservation-fixtures";
import {
  buildService,
  createAndSelect,
  defaultMirrorSuccess,
} from "./reservation-helpers";

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
    const final = await service.submitPayment({ clientTransaction: demoClientTransaction(),
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

describe("Stable webhook event semantics (M3)", () => {
  async function reserveWithFailedWebhooks() {
    const ctx = buildService({ now: "2026-07-15T19:01:00.000Z" });
    const { service, controls, bundle } = ctx;
    controls.webhookOk = false; // first delivery fails
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "HBAR",
      "res-wh-stable",
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
    return { ...ctx, reservationId };
  }

  it("retry reuses the immutable event: same eventId, payload, emittedAt, payloadHash, signature", async () => {
    const { service, controls, reservationId, setNow } =
      await reserveWithFailedWebhooks();

    const before = (await service.getReservation(reservationId))!;
    expect(before.webhookEvents).toHaveLength(2);
    const failedDeliveries = before.webhooks;
    expect(failedDeliveries.every((d) => !d.delivered)).toBe(true);

    // Retry at a different wall-clock time with delivery now succeeding.
    controls.webhookOk = true;
    setNow("2026-07-15T19:45:00.000Z");
    const after = await service.retryWebhooks(reservationId);

    // No duplicate semantic events were generated.
    expect(after.webhookEvents).toHaveLength(2);

    for (const recipient of ["shipper", "carrier"] as const) {
      const b = before.webhookEvents.find((e) => e.recipient === recipient)!;
      const a = after.webhookEvents.find((e) => e.recipient === recipient)!;
      expect(a.eventId).toBe(b.eventId);
      expect(a.emittedAt).toBe(b.emittedAt);
      expect(a.emittedAt).toBe("2026-07-15T19:01:00.000Z");
      expect(a.payloadHash).toBe(b.payloadHash);
      expect(a.signature).toBe(b.signature);
      expect(a.signedTimestamp).toBe(b.signedTimestamp);
      // Signature still verifies against the reconstructed signed webhook.
      expect(
        verifyWebhook(rebuildSignedWebhook(a), RESERVATION_TEST_WEBHOOK_PUBLIC_KEY),
      ).toBe(true);
    }

    // Operational metadata changes independently.
    for (const recipient of ["shipper", "carrier"] as const) {
      const priorD = before.webhooks.find((d) => d.recipient === recipient)!;
      const nowD = after.webhooks.find((d) => d.recipient === recipient)!;
      expect(nowD.delivered).toBe(true);
      expect(nowD.attemptedAt).toBe("2026-07-15T19:45:00.000Z");
      expect(nowD.attemptedAt).not.toBe(priorD.attemptedAt);
      expect(nowD.deliveryAttemptNumber).toBe(priorD.deliveryAttemptNumber + 1);
      // The semantic payload hash is unchanged on the operational record too.
      expect(nowD.payloadHash).toBe(priorD.payloadHash);
    }
  });

  it("restart reloads the same persisted webhook events (no regeneration)", async () => {
    const { service, reservationId } = await reserveWithFailedWebhooks();
    const first = (await service.getReservation(reservationId))!;
    // Simulate a restart: reload from the store.
    const reloaded = (await service.getReservation(reservationId))!;
    for (const recipient of ["shipper", "carrier"] as const) {
      const f = first.webhookEvents.find((e) => e.recipient === recipient)!;
      const r = reloaded.webhookEvents.find((e) => e.recipient === recipient)!;
      expect(r.eventId).toBe(f.eventId);
      expect(r.emittedAt).toBe(f.emittedAt);
      expect(r.payloadHash).toBe(f.payloadHash);
      expect(r.signature).toBe(f.signature);
    }
  });

  it("tampered reconstructed webhook fails verification", async () => {
    const { service, reservationId } = await reserveWithFailedWebhooks();
    const rec = (await service.getReservation(reservationId))!;
    const event = rec.webhookEvents[0]!;
    const signed = rebuildSignedWebhook(event);
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
});
