import { describe, expect, it } from "vitest";

import { createRouteReservedRecord } from "../src/reservation/route-reserved-record";
import {
  buildRouteReservedPayload,
  createRouteReservedHcsEnvelope,
  decodeRouteReservedEnvelope,
  PROHIBITED_ROUTE_RESERVED_FIELDS,
  routeReservedEnvelopeHash,
} from "../src/reservation/hcs-evidence";
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
    const final = await service.submitPayment({
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
