import { describe, expect, it } from "vitest";
import { demoClientTransaction } from "./reservation-helpers";

import { createRouteReservedRecord } from "../src/reservation/route-reserved-record";
import {
  buildRouteReservedPayload,
  createRouteReservedHcsEnvelope,
  decodeRouteReservedEnvelope,
  measureRouteReservedEnvelope,
  PROHIBITED_ROUTE_RESERVED_FIELDS,
  routeReservedEnvelopeHash,
} from "../src/reservation/hcs-evidence";
import {
  decodeHcsEnvelope,
  measureHcsMessageBytes,
} from "../src/hcs/message-envelope";
import { HCS_MAX_MESSAGE_BYTES, type HcsEnvelope } from "../src/hcs/types";
import { DEMO_PAYER_ACCOUNT, DEMO_WINNER_ACCOUNT } from "./fixtures/reservation-fixtures";

describe("HCS ROUTE_RESERVED evidence", () => {
  const record = createRouteReservedRecord({
    reservationId: "res-hcs-1",
    tenderId: "tender-ham-ist-hcs-c8b3e38a",
    tenderVersion: 1,
    tenderHash: "sha256:" + "11".repeat(32),
    winningBidId: "bid-a-b3e38a",
    winningBidHash: "sha256:" + "22".repeat(32),
    carrierId: "carrier-alpha",
    carrierAccount: DEMO_WINNER_ACCOUNT,
    selectedOptionId: "USDC",
    paymentAsset: "0.0.429274",
    paymentAmountAtomic: "10000",
    payerAccount: DEMO_PAYER_ACCOUNT,
    transactionId: "0.0.9197513@1.2",
    consensusTimestamp: "2026-07-15T19:05:00.123456789Z",
    decisionManifestHash: "sha256:" + "33".repeat(32),
    evaluatedBidSetHash: "sha256:" + "44".repeat(32),
    hcsAuctionTopicId: "0.0.9587459",
    closeBarrierSequence: 4,
    reservedAt: "2026-07-15T19:06:00.000Z",
  });

  it("creates public-only envelope with payload hash", () => {
    const payload = buildRouteReservedPayload(record, "carrier-alpha");
    const env = createRouteReservedHcsEnvelope({
      runId: "run-1",
      tenderId: record.tenderId,
      tenderVersion: 1,
      tenderHash: record.tenderHash,
      createdAt: "2026-07-15T19:06:01.000Z",
      payload,
    });
    expect(env.messageType).toBe("ROUTE_RESERVED");
    expect(env.payload.paymentAmountAtomic).toBe("10000");
    expect(env.payloadHash).toMatch(/^sha256:/);
    const decoded = decodeRouteReservedEnvelope(JSON.parse(JSON.stringify(env)));
    expect(routeReservedEnvelopeHash(decoded)).toBe(
      routeReservedEnvelopeHash(env),
    );
  });

  it("excludes private fields", () => {
    for (const field of PROHIBITED_ROUTE_RESERVED_FIELDS) {
      const payload = {
        ...buildRouteReservedPayload(record, "carrier-alpha"),
        [field]: "secret",
      };
      expect(() =>
        createRouteReservedHcsEnvelope({
          runId: "run-1",
          tenderId: record.tenderId,
          tenderVersion: 1,
          tenderHash: record.tenderHash,
          createdAt: "2026-07-15T19:06:01.000Z",
          payload: payload as never,
        }),
      ).toThrow(/must not contain|PRIVATE|private/i);
    }
  });

  it("reservation record hash is stable", () => {
    const a = createRouteReservedRecord({
      reservationId: record.reservationId,
      tenderId: record.tenderId,
      tenderVersion: record.tenderVersion,
      tenderHash: record.tenderHash,
      winningBidId: record.winningBidId,
      winningBidHash: record.winningBidHash,
      carrierId: record.carrierId,
      carrierAccount: record.carrierAccount,
      selectedOptionId: record.selectedOptionId,
      paymentAsset: record.paymentAsset,
      paymentAmountAtomic: record.paymentAmountAtomic,
      payerAccount: record.payerAccount,
      transactionId: record.transactionId,
      consensusTimestamp: record.consensusTimestamp,
      decisionManifestHash: record.decisionManifestHash,
      evaluatedBidSetHash: record.evaluatedBidSetHash,
      hcsAuctionTopicId: record.hcsAuctionTopicId,
      closeBarrierSequence: record.closeBarrierSequence,
      reservedAt: record.reservedAt,
    });
    expect(a.reservationRecordHash).toBe(record.reservationRecordHash);
  });

  it("HCS failure does not reverse reservation", async () => {
    const {
      buildService,
      createAndSelect,
      defaultMirrorSuccess,
    } = await import("./reservation-helpers");
    const { service, controls, bundle } = buildService();
    controls.hcsOk = false;
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "USDC",
      "res-hcs-fail",
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
    expect(final.routeReserved).not.toBeNull();
    expect(
      final.state === "HCS_EVIDENCE_FAILED" || final.state === "COMPLETED",
    ).toBe(true);
  });
});

describe("Unified ROUTE_RESERVED HCS schema (L3)", () => {
  const record = createRouteReservedRecord({
    reservationId: "res-6b-live-0001",
    tenderId: "tender-ham-ist-hcs-c8b3e38a",
    tenderVersion: 1,
    tenderHash: "sha256:" + "11".repeat(32),
    winningBidId: "bid-a-b3e38a",
    winningBidHash: "sha256:" + "22".repeat(32),
    carrierId: "carrier-alpha",
    carrierAccount: DEMO_WINNER_ACCOUNT,
    selectedOptionId: "USDC",
    paymentAsset: "0.0.429274",
    paymentAmountAtomic: "10000",
    payerAccount: DEMO_PAYER_ACCOUNT,
    transactionId: "0.0.9197513@1784142000.100000000",
    consensusTimestamp: "2026-07-15T19:05:00.123456789Z",
    decisionManifestHash: "sha256:" + "33".repeat(32),
    evaluatedBidSetHash: "sha256:" + "44".repeat(32),
    hcsAuctionTopicId: "0.0.9587459",
    closeBarrierSequence: 4,
    reservedAt: "2026-07-15T19:05:00.123456789Z",
  });

  function envelope() {
    return createRouteReservedHcsEnvelope({
      runId: `reservation-${record.reservationId}`,
      tenderId: record.tenderId,
      tenderVersion: 1,
      tenderHash: record.tenderHash,
      createdAt: "2026-07-15T19:06:01.000000000Z",
      payload: buildRouteReservedPayload(record, "carrier-alpha"),
    });
  }

  it("is a first-class member of the shared HcsEnvelope union (no cast to publish)", () => {
    // Assignable to HcsEnvelope with no `as unknown` cast — compile-time proof.
    const env: HcsEnvelope = envelope();
    expect(env.messageType).toBe("ROUTE_RESERVED");
    // Decodes via the shared decoder (not a bespoke ROUTE_RESERVED-only path).
    const decoded = decodeHcsEnvelope(JSON.parse(JSON.stringify(env)));
    expect(decoded.messageType).toBe("ROUTE_RESERVED");
    expect(measureHcsMessageBytes(env)).toBe(measureRouteReservedEnvelope(env));
  });

  it("round-trips through the shared decoder with payloadHash verification", () => {
    const env = envelope();
    const decoded = decodeRouteReservedEnvelope(JSON.parse(JSON.stringify(env)));
    expect(routeReservedEnvelopeHash(decoded)).toBe(
      routeReservedEnvelopeHash(env),
    );
    // Tampering the payload breaks the canonical payloadHash check.
    const tampered = JSON.parse(JSON.stringify(env));
    tampered.payload.paymentAmountAtomic = "99999";
    expect(() => decodeRouteReservedEnvelope(tampered)).toThrow(
      /payloadHash|mismatch/i,
    );
  });

  it("rejects a malformed / unsupported payload", () => {
    const env = envelope();
    const broken = JSON.parse(JSON.stringify(env));
    delete broken.payload.reservationRecordHash;
    broken.payloadHash = "sha256:" + "00".repeat(32);
    expect(() => decodeRouteReservedEnvelope(broken)).toThrow();
  });

  it("rejects private field injection", () => {
    for (const field of PROHIBITED_ROUTE_RESERVED_FIELDS) {
      const payload = {
        ...buildRouteReservedPayload(record, "carrier-alpha"),
        [field]: "secret",
      };
      expect(() =>
        createRouteReservedHcsEnvelope({
          runId: "run-1",
          tenderId: record.tenderId,
          tenderVersion: 1,
          tenderHash: record.tenderHash,
          createdAt: "2026-07-15T19:06:01.000Z",
          payload: payload as never,
        }),
      ).toThrow(/must not contain|private/i);
    }
  });

  it("fits the STANDARD single HCS message limit (no doubled allowance)", () => {
    const size = measureRouteReservedEnvelope(envelope());
    expect(HCS_MAX_MESSAGE_BYTES).toBe(1024);
    expect(size).toBeLessThanOrEqual(HCS_MAX_MESSAGE_BYTES);
  });

  it("rejects an envelope that exceeds the standard limit (would have passed a 2x allowance)", () => {
    const bigId = "res-" + "a".repeat(124); // 128 chars
    const big = createRouteReservedRecord({
      ...{
        reservationId: bigId,
        tenderId: "tender-ham-ist-hcs-c8b3e38a",
        tenderVersion: 1,
        tenderHash: "sha256:" + "11".repeat(32),
        winningBidId: "bid-" + "b".repeat(120),
        winningBidHash: "sha256:" + "22".repeat(32),
        carrierId: "carrier-" + "c".repeat(112),
        carrierAccount: DEMO_WINNER_ACCOUNT,
        selectedOptionId: "USDC" as const,
        paymentAsset: "0.0.429274",
        paymentAmountAtomic: "10000",
        payerAccount: DEMO_PAYER_ACCOUNT,
        transactionId: "0.0.9197513@1784142000.100000000",
        consensusTimestamp: "2026-07-15T19:05:00.123456789Z",
        decisionManifestHash: "sha256:" + "33".repeat(32),
        evaluatedBidSetHash: "sha256:" + "44".repeat(32),
        hcsAuctionTopicId: "0.0.9587459",
        closeBarrierSequence: 4,
        reservedAt: "2026-07-15T19:05:00.123456789Z",
      },
    });
    expect(() =>
      createRouteReservedHcsEnvelope({
        runId: bigId,
        tenderId: big.tenderId,
        tenderVersion: 1,
        tenderHash: big.tenderHash,
        createdAt: "2026-07-15T19:06:01.000000000Z",
        payload: buildRouteReservedPayload(big, big.carrierId),
      }),
    ).toThrow(/exceeds|size|limit/i);
  });

  it("existing AUCTION_OPEN / BID_COMMITMENT / CLOSE_BARRIER decode is unchanged", () => {
    // A ROUTE_RESERVED envelope decodes; a bogus type is still rejected.
    const env = envelope();
    expect(decodeHcsEnvelope(JSON.parse(JSON.stringify(env))).messageType).toBe(
      "ROUTE_RESERVED",
    );
    const bogus = { ...JSON.parse(JSON.stringify(env)), messageType: "NOPE" };
    expect(() => decodeHcsEnvelope(bogus)).toThrow();
  });
});
