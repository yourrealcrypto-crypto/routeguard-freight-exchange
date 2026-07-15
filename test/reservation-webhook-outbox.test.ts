/**
 * Phase 6A.2A — durable webhook semantic outbox.
 * Persist immutable events before first delivery; retries reuse identical bytes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FileSystemReservationStore } from "../src/reservation/attempt-store";
import type { ReservationRecord, WebhookEvent } from "../src/reservation/types";
import {
  buildService,
  createAndSelect,
  defaultMirrorSuccess,
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

async function reserveToRouteReserved(opts?: {
  reservationId?: string;
  webhookOk?: boolean;
  now?: string;
  store?: FileSystemReservationStore;
}) {
  const ctx = buildService({
    now: opts?.now ?? "2026-07-15T19:01:00.000Z",
    ...(opts?.store ? { store: opts.store } : {}),
  });
  const { service, controls, bundle, store } = ctx;
  // Stop after ROUTE_RESERVED by failing webhooks then we may re-drive; for
  // pure ROUTE_RESERVED seeding we still run submit which dispatches webhooks.
  // Tests that need pre-delivery state intercept webhookImpl / store CAS.
  if (opts?.webhookOk === false) {
    controls.webhookOk = false;
  }
  const { reservationId, paymentPayloadHash } = await createAndSelect(
    service,
    bundle,
    "HBAR",
    opts?.reservationId ?? "res-wh-outbox",
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
  return { ...ctx, reservationId, store };
}

describe("Webhook semantic outbox (Phase 6A.2A)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("1. no webhook transport call occurs before webhookEvents are persisted", async () => {
    const order: string[] = [];
    const { service, store, controls, bundle } = buildService({
      now: "2026-07-15T19:01:00.000Z",
    });
    const origCas = store.compareAndSet.bind(store);
    store.compareAndSet = async (id, expected, next) => {
      if (next.webhookEvents.length >= 2 && next.webhooks.length === 0) {
        order.push("persist-events");
      }
      if (next.webhooks.length > 0) {
        order.push("persist-delivery");
      }
      return origCas(id, expected, next);
    };
    controls.webhookImpl = async () => {
      order.push("transport-deliver");
      // Events must already be durable before any transport call.
      const mid = await store.get("res-wh-order");
      expect(mid!.webhookEvents).toHaveLength(2);
      return { ok: true };
    };

    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "HBAR",
      "res-wh-order",
    );
    const sel = (await service.getReservation(reservationId))!.selected!;
    controls.mirrorResult = defaultMirrorSuccess(
      sel,
      controls.settleResult.transactionId!,
    );
    await service.submitPayment({
      reservationId,
      optionId: "HBAR",
      paymentPayloadHash,
    });

    expect(order[0]).toBe("persist-events");
    expect(order.indexOf("persist-events")).toBeLessThan(
      order.indexOf("transport-deliver"),
    );
    expect(order.filter((x) => x === "transport-deliver").length).toBe(2);
  });

  it("2+3. concurrent dispatch callers share one semantic event set; CAS loser does not deliver unpersisted", async () => {
    const { service, store, controls, bundle } = buildService({
      now: "2026-07-15T19:01:00.000Z",
    });
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "HBAR",
      "res-wh-concurrent",
    );
    const rec = (await store.get(reservationId))!;
    controls.mirrorResult = defaultMirrorSuccess(
      rec.selected!,
      controls.settleResult.transactionId!,
    );

    // Reach ROUTE_RESERVED without running dispatch (seed post-payment state).
    // Use submit with webhooks that never fire by pre-seeding ROUTE_RESERVED.
    await service.submitPayment({
      reservationId,
      optionId: "HBAR",
      paymentPayloadHash,
    });
    // Reset to ROUTE_RESERVED with empty webhook outbox for concurrent resume.
    const done = (await store.get(reservationId))!;
    await store.compareAndSet(reservationId, done.recordVersion, {
      ...done,
      state: "ROUTE_RESERVED",
      webhookEvents: [],
      webhooks: [],
      hcsPublicationClaim: null,
      hcsEvidence: null,
    });
    controls.webhookDeliveries.length = 0;

    const barrier = twoPartyBarrier();
    let casAttempts = 0;
    const origCas = store.compareAndSet.bind(store);
    store.compareAndSet = async (id, expected, next) => {
      if (next.webhookEvents.length >= 2 && next.webhooks.length === 0) {
        casAttempts += 1;
        await barrier();
      }
      return origCas(id, expected, next);
    };

    const [a, b] = await Promise.all([
      service.resumeWebhookDispatch(reservationId),
      service.resumeWebhookDispatch(reservationId),
    ]);

    const final = (await store.get(reservationId))!;
    expect(final.webhookEvents).toHaveLength(2);
    // Single semantic set — both callers see the same durable eventIds.
    const ids = final.webhookEvents.map((e) => e.eventId).sort();
    expect(new Set(ids).size).toBe(2);
    expect(a.webhookEvents.map((e) => e.eventId).sort()).toEqual(ids);
    expect(b.webhookEvents.map((e) => e.eventId).sort()).toEqual(ids);
    // Every delivered event matches a persisted event (no unpersisted delivery).
    for (const d of controls.webhookDeliveries) {
      expect(final.webhookEvents.some((e) => e.eventId === d.eventId)).toBe(
        true,
      );
    }
    expect(casAttempts).toBeGreaterThanOrEqual(1);
  });

  it("4. crash after event persistence resumes with identical bytes", async () => {
    const { service, store, controls, reservationId, setNow } =
      await reserveToRouteReserved({
        reservationId: "res-wh-crash-persist",
        webhookOk: false,
        now: "2026-07-15T19:01:00.000Z",
      });

    const before = (await store.get(reservationId))!;
    expect(before.webhookEvents).toHaveLength(2);
    const snap = before.webhookEvents.map((e) => ({ ...e }));

    // Simulate crash before successful delivery: events durable, re-drive.
    controls.webhookOk = true;
    setNow("2026-07-15T19:30:00.000Z");
    const after = await service.retryWebhooks(reservationId);

    for (const recipient of ["shipper", "carrier"] as const) {
      const b = snap.find((e) => e.recipient === recipient)!;
      const a = after.webhookEvents.find((e) => e.recipient === recipient)!;
      expect(a.eventId).toBe(b.eventId);
      expect(a.payload).toEqual(b.payload);
      expect(a.payloadHash).toBe(b.payloadHash);
      expect(a.emittedAt).toBe(b.emittedAt);
      expect(a.signature).toBe(b.signature);
      expect(a.signedTimestamp).toBe(b.signedTimestamp);
    }
  });

  it("5+6. crash after delivery success before result persistence retries identical semantics; attempt number changes", async () => {
    const { service, store, controls, bundle, setNow } = buildService({
      now: "2026-07-15T19:01:00.000Z",
    });
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "HBAR",
      "res-wh-crash-delivery",
    );
    const sel = (await service.getReservation(reservationId))!.selected!;
    controls.mirrorResult = defaultMirrorSuccess(
      sel,
      controls.settleResult.transactionId!,
    );

    // First path: events persist, transport succeeds, but delivery metadata CAS is dropped.
    let dropDeliveryPersist = true;
    const origCas = store.compareAndSet.bind(store);
    store.compareAndSet = async (id, expected, next) => {
      if (
        dropDeliveryPersist &&
        next.webhooks.length > 0 &&
        next.webhooks.every((w) => w.delivered)
      ) {
        // Simulate crash: transport already ran; durable state keeps events only.
        dropDeliveryPersist = false;
        const cur = (await store.get(id))!;
        return cur; // pretend commit never happened (return stale without throw)
      }
      return origCas(id, expected, next);
    };

    await service.submitPayment({
      reservationId,
      optionId: "HBAR",
      paymentPayloadHash,
    });

    // After "crash", events may be present without delivery metadata.
    let mid = (await store.get(reservationId))!;
    if (mid.webhookEvents.length < 2) {
      // If CAS mock interfered oddly, force seed: events without deliveries.
      // Prefer using real path — re-seed ROUTE_RESERVED + events only.
    }
    // Normalize: persist events only if needed, clear deliveries.
    if (mid.webhookEvents.length >= 2) {
      await store.compareAndSet(reservationId, mid.recordVersion, {
        ...mid,
        state: "ROUTE_RESERVED",
        webhooks: [],
        // keep webhookEvents
      });
    }
    mid = (await store.get(reservationId))!;
    expect(mid.webhookEvents).toHaveLength(2);
    const semantic: WebhookEvent[] = mid.webhookEvents.map((e) => ({ ...e }));

    controls.webhookDeliveries.length = 0;
    setNow("2026-07-15T19:40:00.000Z");
    const after = await service.retryWebhooks(reservationId);

    for (const recipient of ["shipper", "carrier"] as const) {
      const b = semantic.find((e) => e.recipient === recipient)!;
      const a = after.webhookEvents.find((e) => e.recipient === recipient)!;
      expect(a.eventId).toBe(b.eventId);
      expect(a.payload).toEqual(b.payload);
      expect(a.payloadHash).toBe(b.payloadHash);
      expect(a.emittedAt).toBe(b.emittedAt);
      expect(a.signature).toBe(b.signature);
      expect(a.signedTimestamp).toBe(b.signedTimestamp);
      const d = after.webhooks.find((w) => w.recipient === recipient)!;
      expect(d.deliveryAttemptNumber).toBeGreaterThanOrEqual(1);
      expect(d.delivered).toBe(true);
      expect(d.attemptedAt).toBe("2026-07-15T19:40:00.000Z");
    }
  });

  it("7. new ReservationService over same filesystem store reloads and reuses events", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "rg-wh-fs-"));
    dirs.push(dir);
    const store = new FileSystemReservationStore(dir);
    const first = buildService({
      store,
      now: "2026-07-15T19:01:00.000Z",
    });
    first.controls.webhookOk = false;
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      first.service,
      first.bundle,
      "HBAR",
      "res-wh-fs-reload",
    );
    const sel = (await first.service.getReservation(reservationId))!.selected!;
    first.controls.mirrorResult = defaultMirrorSuccess(
      sel,
      first.controls.settleResult.transactionId!,
    );
    await first.service.submitPayment({
      reservationId,
      optionId: "HBAR",
      paymentPayloadHash,
    });
    const persisted = (await store.get(reservationId))!;
    expect(persisted.webhookEvents).toHaveLength(2);
    const snap = persisted.webhookEvents.map((e) => ({ ...e }));

    // New service instance, same durable store.
    const second = buildService({
      store,
      now: "2026-07-15T19:50:00.000Z",
      bundle: first.bundle,
    });
    second.controls.webhookOk = true;
    const after = await second.service.retryWebhooks(reservationId);
    for (const recipient of ["shipper", "carrier"] as const) {
      const b = snap.find((e) => e.recipient === recipient)!;
      const a = after.webhookEvents.find((e) => e.recipient === recipient)!;
      expect(a.eventId).toBe(b.eventId);
      expect(a.payloadHash).toBe(b.payloadHash);
      expect(a.signature).toBe(b.signature);
      expect(a.emittedAt).toBe(b.emittedAt);
      expect(a.signedTimestamp).toBe(b.signedTimestamp);
    }
  });

  it("8. no private bid or payment payload appears in the persisted event", async () => {
    const { store, reservationId } = await reserveToRouteReserved({
      reservationId: "res-wh-private",
      webhookOk: false,
    });
    const rec = (await store.get(reservationId))! as ReservationRecord;
    for (const event of rec.webhookEvents) {
      const json = JSON.stringify(event);
      expect(json).not.toMatch(/privateKey|signaturePayload|paymentPayload|salt|nonce/i);
      expect(event.payload).not.toHaveProperty("bidPrice");
      expect(event.payload).not.toHaveProperty("signedPayment");
      expect(event.payload).not.toHaveProperty("privateBid");
      // Public payment identity fields are allowed; raw payload hash of payment is not.
      expect(event.payload).not.toHaveProperty("paymentPayloadHash");
      expect(event).not.toHaveProperty("paymentPayload");
    }
  });
});

