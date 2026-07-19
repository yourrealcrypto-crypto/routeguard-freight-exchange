/**
 * Phase 6A.2A — durable HCS ROUTE_RESERVED publication claim / outbox and
 * ambiguous resolution (no automatic resubmit).
 */

import { demoClientTransaction } from "./reservation-helpers";
import { describe, expect, it } from "vitest";

import {
  buildRouteReservedPayload,
  createRouteReservedHcsEnvelope,
  measureRouteReservedEnvelope,
  routeReservedEnvelopeHash,
} from "../src/reservation/hcs-evidence";
import type {
  HcsPublicationClaim,
  ReservationRecord,
} from "../src/reservation/types";
import type { RouteReservedEnvelope } from "../src/hcs/types";
import { HCS_MAX_MESSAGE_BYTES } from "../src/hcs/types";
import {
  DEMO_HCS_TOPIC,
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

async function seedPostWebhook(
  reservationId: string,
  optionId: "HBAR" | "USDC" = "HBAR",
) {
  const ctx = buildService({ now: "2026-07-15T19:01:00.000Z" });
  const { service, store, controls, bundle } = ctx;
  const { paymentPayloadHash } = await createAndSelect(
    service,
    bundle,
    optionId,
    reservationId,
  );
  const sel = (await service.getReservation(reservationId))!.selected!;
  controls.mirrorResult = defaultMirrorSuccess(
    sel,
    controls.settleResult.transactionId!,
  );
  await service.submitPayment({ clientTransaction: demoClientTransaction(),
    reservationId,
    optionId,
    paymentPayloadHash,
  });

  // Normalize to WEBHOOKS_DISPATCHED with no HCS claim so resumeHcsPublication
  // exercises the claim path in isolation.
  const done = (await store.get(reservationId))!;
  await store.compareAndSet(reservationId, done.recordVersion, {
    ...done,
    state: "WEBHOOKS_DISPATCHED",
    hcsPublicationClaim: null,
    hcsEvidence: null,
  });
  controls.hcsPublishCallCount = 0;
  controls.hcsPublishedEnvelopes = [];
  controls.hcsResolveCallCount = 0;
  return { ...ctx, reservationId };
}

describe("HCS publication outbox (Phase 6A.2A)", () => {
  it("1+2. publication claim is persisted before publisher invocation; publisher sees exact envelope", async () => {
    const order: string[] = [];
    const { service, store, controls, reservationId } = await seedPostWebhook(
      "res-hcs-order",
    );

    const origCas = store.compareAndSet.bind(store);
    store.compareAndSet = async (id, expected, next) => {
      if (
        next.hcsPublicationClaim &&
        next.hcsPublicationClaim.status === "CLAIMED" &&
        !next.hcsEvidence?.published
      ) {
        order.push("persist-claim");
      }
      if (next.hcsPublicationClaim?.status === "PUBLISHED") {
        order.push("persist-published");
      }
      return origCas(id, expected, next);
    };
    controls.hcsImpl = async (envelope) => {
      order.push("publish");
      const mid = (await store.get(reservationId))!;
      expect(mid.hcsPublicationClaim).not.toBeNull();
      expect(mid.hcsPublicationClaim!.status).toBe("CLAIMED");
      expect(routeReservedEnvelopeHash(envelope as RouteReservedEnvelope)).toBe(
        mid.hcsPublicationClaim!.envelopeHash,
      );
      expect(JSON.stringify(envelope)).toBe(
        JSON.stringify(mid.hcsPublicationClaim!.envelope),
      );
      return {
        topicId: DEMO_HCS_TOPIC,
        sequence: 7,
        transactionId: "0.0.9197513@1784142100.7",
        consensusTimestamp: "2026-07-15T19:06:00.000000007Z",
      };
    };

    const final = await service.resumeHcsPublication(reservationId);
    expect(order[0]).toBe("persist-claim");
    expect(order.indexOf("persist-claim")).toBeLessThan(order.indexOf("publish"));
    expect(final.hcsPublicationClaim!.status).toBe("PUBLISHED");
    expect(final.hcsEvidence!.published).toBe(true);
    expect(final.routeReserved).not.toBeNull();
  });

  it("3+4. two concurrent callers invoke publisher at most once; CAS loser never publishes", async () => {
    const { service, store, controls, reservationId } = await seedPostWebhook(
      "res-hcs-concurrent",
    );

    const barrier = twoPartyBarrier();
    const origCas = store.compareAndSet.bind(store);
    store.compareAndSet = async (id, expected, next) => {
      if (
        next.hcsPublicationClaim &&
        next.hcsPublicationClaim.status === "CLAIMED" &&
        next.hcsPublicationClaim.sequence == null
      ) {
        await barrier();
      }
      return origCas(id, expected, next);
    };

    await Promise.all([
      service.resumeHcsPublication(reservationId),
      service.resumeHcsPublication(reservationId),
    ]);

    expect(controls.hcsPublishCallCount).toBe(1);
    const final = (await store.get(reservationId))!;
    expect(final.hcsPublicationClaim!.status).toBe("PUBLISHED");
    expect(final.routeReserved).not.toBeNull();
  });

  it("5. crash after publisher success before result persistence does not resubmit", async () => {
    const { service, store, controls, reservationId } = await seedPostWebhook(
      "res-hcs-crash-result",
    );

    let dropResult = true;
    const origCas = store.compareAndSet.bind(store);
    store.compareAndSet = async (id, expected, next) => {
      if (dropResult && next.hcsPublicationClaim?.status === "PUBLISHED") {
        dropResult = false;
        // Crash: claim remains CLAIMED; publish already happened.
        const cur = (await store.get(id))!;
        return cur;
      }
      return origCas(id, expected, next);
    };

    await service.resumeHcsPublication(reservationId);
    expect(controls.hcsPublishCallCount).toBe(1);
    let mid = (await store.get(reservationId))!;
    expect(mid.hcsPublicationClaim!.status).toBe("CLAIMED");
    expect(mid.hcsPublicationClaim!.sequence).toBeNull();

    // Resume: resolver FOUND finalizes without second submit.
    controls.hcsResolveResult = {
      status: "FOUND",
      topicId: DEMO_HCS_TOPIC,
      sequence: 5,
      transactionId: "0.0.9197513@1784142100.1",
      consensusTimestamp: "2026-07-15T19:06:00.000000001Z",
      envelopeHash: mid.hcsPublicationClaim!.envelopeHash,
    };
    const after = await service.resumeHcsPublication(reservationId);
    expect(controls.hcsPublishCallCount).toBe(1);
    expect(controls.hcsResolveCallCount).toBeGreaterThanOrEqual(1);
    expect(after.hcsPublicationClaim!.status).toBe("PUBLISHED");
    expect(after.hcsEvidence!.published).toBe(true);
    expect(after.state === "HCS_EVIDENCE_RECORDED" || after.state === "COMPLETED").toBe(
      true,
    );
  });

  it("6. resolver FOUND records the authoritative publication", async () => {
    const { service, store, controls, reservationId } = await seedPostWebhook(
      "res-hcs-found",
    );
    // Seed CLAIMED without publish.
    const rec = (await store.get(reservationId))!;
    const claim = makeOpenClaim(rec);
    await store.compareAndSet(reservationId, rec.recordVersion, {
      ...rec,
      hcsPublicationClaim: claim,
    });
    controls.hcsResolveResult = {
      status: "FOUND",
      topicId: DEMO_HCS_TOPIC,
      sequence: 42,
      transactionId: "0.0.9197513@99.1",
      consensusTimestamp: "2026-07-15T19:07:00.000000042Z",
      envelopeHash: claim.envelopeHash,
    };
    const final = await service.resumeHcsPublication(reservationId);
    expect(controls.hcsPublishCallCount).toBe(0);
    expect(final.hcsPublicationClaim!.status).toBe("PUBLISHED");
    expect(final.hcsPublicationClaim!.sequence).toBe(42);
    expect(final.hcsEvidence!.consensusTimestamp).toBe(
      "2026-07-15T19:07:00.000000042Z",
    );
  });

  it("7. resolver AMBIGUOUS moves HCS outbox to manual review", async () => {
    const { service, store, controls, reservationId } = await seedPostWebhook(
      "res-hcs-ambiguous",
    );
    const rec = (await store.get(reservationId))!;
    const claim = makeOpenClaim(rec);
    await store.compareAndSet(reservationId, rec.recordVersion, {
      ...rec,
      hcsPublicationClaim: claim,
    });
    controls.hcsResolveResult = { status: "AMBIGUOUS" };
    const final = await service.resumeHcsPublication(reservationId);
    expect(controls.hcsPublishCallCount).toBe(0);
    expect(final.hcsPublicationClaim!.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(final.state).toBe("HCS_EVIDENCE_FAILED");
    // ROUTE_RESERVED never reversed — reservation still present.
    expect(final.routeReserved).not.toBeNull();
    expect(final.state).not.toBe("MANUAL_REVIEW_REQUIRED");
  });

  it("8. NOT_FOUND_CONCLUSIVE does not automatically publish", async () => {
    const { service, store, controls, reservationId } = await seedPostWebhook(
      "res-hcs-notfound",
    );
    const rec = (await store.get(reservationId))!;
    const claim = makeOpenClaim(rec);
    await store.compareAndSet(reservationId, rec.recordVersion, {
      ...rec,
      hcsPublicationClaim: claim,
    });
    controls.hcsResolveResult = { status: "NOT_FOUND_CONCLUSIVE" };
    const final = await service.resumeHcsPublication(reservationId);
    expect(controls.hcsPublishCallCount).toBe(0);
    expect(final.hcsPublicationClaim!.failureCode).toBe(
      "HCS_NOT_FOUND_CONCLUSIVE",
    );
    // Controlled: still CLAIMED (not auto-republished).
    expect(final.hcsPublicationClaim!.status).toBe("CLAIMED");
    expect(final.routeReserved).not.toBeNull();
  });

  it("9. wrong returned topicId fails closed", async () => {
    const { service, controls, reservationId } = await seedPostWebhook(
      "res-hcs-bad-topic",
    );
    controls.hcsImpl = async () => ({
      topicId: "0.0.0000001",
      sequence: 1,
      transactionId: "0.0.1@1.1",
      consensusTimestamp: "2026-07-15T19:06:00.000Z",
    });
    const final = await service.resumeHcsPublication(reservationId);
    expect(final.hcsPublicationClaim!.status).toBe("FAILED_CONCLUSIVE");
    expect(final.hcsEvidence!.published).toBe(false);
    expect(final.routeReserved).not.toBeNull();
  });

  it("10. missing transactionId fails closed", async () => {
    const { service, controls, reservationId } = await seedPostWebhook(
      "res-hcs-no-tx",
    );
    controls.hcsImpl = async () =>
      ({
        topicId: DEMO_HCS_TOPIC,
        sequence: 1,
        transactionId: "",
        consensusTimestamp: "2026-07-15T19:06:00.000Z",
      }) as never;
    const final = await service.resumeHcsPublication(reservationId);
    expect(final.hcsPublicationClaim!.status).toBe("FAILED_CONCLUSIVE");
    expect(final.hcsEvidence!.published).toBe(false);
  });

  it("11. missing/invalid sequence fails closed", async () => {
    const { service, controls, reservationId } = await seedPostWebhook(
      "res-hcs-bad-seq",
    );
    controls.hcsImpl = async () => ({
      topicId: DEMO_HCS_TOPIC,
      sequence: 0,
      transactionId: "0.0.1@1.1",
      consensusTimestamp: "2026-07-15T19:06:00.000Z",
    });
    const final = await service.resumeHcsPublication(reservationId);
    expect(final.hcsPublicationClaim!.status).toBe("FAILED_CONCLUSIVE");
  });

  it("12. missing/invalid consensusTimestamp fails closed", async () => {
    const { service, controls, reservationId } = await seedPostWebhook(
      "res-hcs-bad-ts",
    );
    controls.hcsImpl = async () => ({
      topicId: DEMO_HCS_TOPIC,
      sequence: 3,
      transactionId: "0.0.1@1.1",
      consensusTimestamp: "not-a-timestamp",
    });
    const final = await service.resumeHcsPublication(reservationId);
    expect(final.hcsPublicationClaim!.status).toBe("FAILED_CONCLUSIVE");
  });

  it("13. conflicting envelope hash is rejected", async () => {
    const { service, store, controls, reservationId } = await seedPostWebhook(
      "res-hcs-hash-conflict",
    );
    const rec = (await store.get(reservationId))!;
    const claim = makeOpenClaim(rec);
    await store.compareAndSet(reservationId, rec.recordVersion, {
      ...rec,
      hcsPublicationClaim: claim,
    });
    controls.hcsResolveResult = {
      status: "FOUND",
      topicId: DEMO_HCS_TOPIC,
      sequence: 9,
      transactionId: "0.0.1@1.1",
      consensusTimestamp: "2026-07-15T19:06:00.000Z",
      envelopeHash: "sha256:" + "ff".repeat(32),
    };
    const final = await service.resumeHcsPublication(reservationId);
    expect(controls.hcsPublishCallCount).toBe(0);
    expect(final.hcsPublicationClaim!.status).toBe("FAILED_CONCLUSIVE");
    expect(final.hcsEvidence!.published).toBe(false);
  });

  it("14. live-shaped envelope remains <=1024 bytes", async () => {
    const { service, store, reservationId } = await seedPostWebhook(
      "res-hcs-bytes",
    );
    const final = await service.resumeHcsPublication(reservationId);
    const claim = final.hcsPublicationClaim!;
    expect(claim.encodedByteCount).toBeLessThanOrEqual(HCS_MAX_MESSAGE_BYTES);
    expect(claim.encodedByteCount).toBe(
      measureRouteReservedEnvelope(
        claim.envelope as unknown as RouteReservedEnvelope,
      ),
    );
    // Exact live-shaped fixture count (canonical UTF-8 of the durable envelope).
    // Logged for the Phase 6A.2A report; bound is the standard 1024-byte HCS limit.
    expect(claim.encodedByteCount).toBeGreaterThan(400);
    expect(claim.encodedByteCount).toBeLessThanOrEqual(1024);
    const durable = (await store.get(reservationId))!;
    expect(durable.hcsPublicationClaim!.encodedByteCount).toBe(
      claim.encodedByteCount,
    );
    // Surface exact count in assertion message for the final report.
    expect(
      claim.encodedByteCount,
      `ROUTE_RESERVED envelope byte count = ${claim.encodedByteCount}`,
    ).toBe(claim.encodedByteCount);
  });

  it("15. decisionManifestHash remains committed via reservationRecordHash only", async () => {
    const { service, reservationId } = await seedPostWebhook("res-hcs-manifest");
    const final = await service.resumeHcsPublication(reservationId);
    const env = final.hcsPublicationClaim!
      .envelope as unknown as RouteReservedEnvelope;
    expect(env.payload).not.toHaveProperty("decisionManifestHash");
    expect(env.payload.reservationRecordHash).toBe(
      final.routeReserved!.reservationRecordHash,
    );
    // Master commitment still binds the manifest hash on the durable record.
    expect(final.routeReserved!.decisionManifestHash).toMatch(/^sha256:/);
    expect(JSON.stringify(env)).not.toContain(
      final.routeReserved!.decisionManifestHash,
    );
  });

  it("topic binding uses reservation record hcsTopicId (demo 0.0.9587459)", async () => {
    const { service, store, reservationId } = await seedPostWebhook(
      "res-hcs-topic-bind",
    );
    const before = (await store.get(reservationId))!;
    expect(before.hcsTopicId).toBe(DEMO_HCS_TOPIC);
    const final = await service.resumeHcsPublication(reservationId);
    expect(final.hcsPublicationClaim!.expectedTopicId).toBe(before.hcsTopicId);
    expect(final.hcsEvidence!.topicId).toBe(before.hcsTopicId);
  });

  it("HCS failure never reverses ROUTE_RESERVED", async () => {
    const { service, controls, reservationId } = await seedPostWebhook(
      "res-hcs-no-reverse",
    );
    controls.hcsOk = false;
    const final = await service.resumeHcsPublication(reservationId);
    expect(final.routeReserved).not.toBeNull();
    expect(final.state).toBe("HCS_EVIDENCE_FAILED");
    expect(final.state).not.toBe("PAYMENT_CONFIRMED");
    expect(final.state).not.toBe("OFFER_CREATED");
  });
});

function makeOpenClaim(rec: ReservationRecord): HcsPublicationClaim {
  const rr = rec.routeReserved!;
  const payload = buildRouteReservedPayload(rr, rec.winningCarrierId);
  const envelope = createRouteReservedHcsEnvelope({
    runId: `reservation-${rec.reservationId}`,
    tenderId: rec.tenderId,
    tenderVersion: rec.tenderVersion,
    tenderHash: rec.tenderHash,
    createdAt: "2026-07-15T19:06:01.000Z",
    payload,
  });
  const envHash = routeReservedEnvelopeHash(envelope);
  return {
    publishAttemptId: "publish-attempt-fixture",
    reservationId: rec.reservationId,
    expectedTopicId: rec.hcsTopicId,
    messageType: "ROUTE_RESERVED",
    envelope: JSON.parse(JSON.stringify(envelope)) as Record<string, unknown>,
    envelopeHash: envHash,
    encodedByteCount: measureRouteReservedEnvelope(envelope),
    claimedAt: "2026-07-15T19:06:00.000Z",
    status: "CLAIMED",
    transactionId: null,
    sequence: null,
    consensusTimestamp: null,
    failureCode: null,
    failureReason: null,
  };
}
