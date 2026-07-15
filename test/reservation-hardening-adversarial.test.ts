import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileSystemReservationStore,
  InMemoryReservationStore,
} from "../src/reservation/attempt-store";
import { ReservationVersionConflictError } from "../src/reservation/types";
import {
  buildService,
  createAndSelect,
  defaultMirrorSuccess,
  DEMO_PAYER_ACCOUNT,
} from "./reservation-helpers";
import {
  buildVerifiedWinnerBundle,
  createReservationInputFromBundle,
} from "./fixtures/reservation-fixtures";

describe("Phase 6A.1 adversarial — cross-cutting", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("two store instances (processes) cannot both advance the same expected version", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "res-2proc-"));
    dirs.push(dir);
    const storeA = new FileSystemReservationStore(dir);
    const storeB = new FileSystemReservationStore(dir);

    const bundle = buildVerifiedWinnerBundle();
    const svcA = buildService({ bundle, store: storeA }).service;
    // Create via one instance.
    await svcA.createReservation(
      createReservationInputFromBundle(bundle, "res-2proc"),
      bundle.tender,
    );
    const rec = await storeA.get("res-2proc");
    expect(rec!.recordVersion).toBe(1);

    // Concurrent CAS mutations must be schema-valid (OFFER_CREATED stays valid).
    const results = await Promise.allSettled([
      storeA.compareAndSet("res-2proc", 1, {
        ...rec!,
        updatedAt: "2026-07-15T19:00:01.000Z",
        failureCode: "writer-a",
      }),
      storeB.compareAndSet("res-2proc", 1, {
        ...rec!,
        updatedAt: "2026-07-15T19:00:02.000Z",
        failureCode: "writer-b",
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    // The final persisted version advanced by exactly one.
    const final = await storeA.get("res-2proc");
    expect(final!.recordVersion).toBe(2);
  });

  it("a stale writer cannot overwrite ROUTE_RESERVED", async () => {
    const { service, store, controls, bundle } = buildService();
    const stale = await service.createReservation(
      createReservationInputFromBundle(bundle, "res-stale-rr"),
      bundle.tender,
    );
    // Drive to ROUTE_RESERVED.
    await service.selectOption({
      reservationId: "res-stale-rr",
      optionId: "USDC",
      offerHash: stale.offer.offerHash,
      offerVersion: stale.offer.offerVersion,
      payerAccount: DEMO_PAYER_ACCOUNT,
    });
    await service.issueChallenge("res-stale-rr", "USDC");
    const sel = (await service.getReservation("res-stale-rr"))!.selected!;
    controls.mirrorResult = defaultMirrorSuccess(
      sel,
      controls.settleResult.transactionId!,
    );
    const reserved = await service.submitPayment({
      reservationId: "res-stale-rr",
      optionId: "USDC",
      paymentPayloadHash: (await import("../src/domain/canonical-hash")).canonicalSha256(
        { payload: "signed-demo", optionId: "USDC" },
      ),
    });
    expect(reserved.routeReserved).not.toBeNull();

    // A stale writer holding the version-1 snapshot tries to overwrite.
    await expect(
      store.compareAndSet("res-stale-rr", stale.recordVersion, {
        ...stale,
        state: "EXPIRED",
      }),
    ).rejects.toBeInstanceOf(ReservationVersionConflictError);

    const current = await store.get("res-stale-rr");
    expect(current!.routeReserved).not.toBeNull();
    expect(current!.routeReserved!.reservationRecordHash).toBe(
      reserved.routeReserved!.reservationRecordHash,
    );
  });

  it("USDC split legs cannot reserve by net sum (service level)", async () => {
    const { service, controls, bundle } = buildService();
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "USDC",
      "res-adv-usdc-split",
    );
    const sel = (await service.getReservation(reservationId))!.selected!;
    controls.mirrorResult = {
      status: "SUCCESS",
      transactionId: controls.settleResult.transactionId!,
      consensusTimestamp: "2026-07-15T19:05:00.123456789Z",
      result: "SUCCESS",
      hbarTransfers: [],
      tokenTransfers: [
        { account: sel.payerAccount, amount: "-5000", tokenId: "0.0.429274" },
        { account: sel.payerAccount, amount: "-5000", tokenId: "0.0.429274" },
        { account: sel.payTo, amount: "10000", tokenId: "0.0.429274" },
      ],
    };
    const final = await service.submitPayment({
      reservationId,
      optionId: "USDC",
      paymentPayloadHash,
    });
    expect(final.routeReserved).toBeNull();
    expect(final.state).toBe("CONFIRMATION_FAILED");
  });

  it("HBAR split payer legs cannot reserve by net sum; normal fees do reserve", async () => {
    // Split payer legs → rejected.
    {
      const { service, controls, bundle } = buildService();
      const { reservationId, paymentPayloadHash } = await createAndSelect(
        service,
        bundle,
        "HBAR",
        "res-adv-hbar-split",
      );
      const sel = (await service.getReservation(reservationId))!.selected!;
      controls.mirrorResult = {
        status: "SUCCESS",
        transactionId: controls.settleResult.transactionId!,
        consensusTimestamp: "2026-07-15T19:05:00.123456789Z",
        result: "SUCCESS",
        hbarTransfers: [
          { account: sel.payerAccount, amount: "-500000" },
          { account: sel.payerAccount, amount: "-500000" },
          { account: sel.payTo, amount: "1000000" },
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
    }
    // Exact payment + normal facilitator/network fees → reserves.
    {
      const { service, controls, bundle } = buildService();
      const { reservationId, paymentPayloadHash } = await createAndSelect(
        service,
        bundle,
        "HBAR",
        "res-adv-hbar-fees",
      );
      const sel = (await service.getReservation(reservationId))!.selected!;
      controls.mirrorResult = {
        status: "SUCCESS",
        transactionId: controls.settleResult.transactionId!,
        consensusTimestamp: "2026-07-15T19:05:00.123456789Z",
        result: "SUCCESS",
        hbarTransfers: [
          { account: sel.payerAccount, amount: "-1000000" },
          { account: sel.payTo, amount: "1000000" },
          { account: "0.0.7162784", amount: "-98765" },
          { account: "0.0.98", amount: "98765" },
        ],
        tokenTransfers: [],
      };
      const final = await service.submitPayment({
        reservationId,
        optionId: "HBAR",
        paymentPayloadHash,
      });
      expect(final.routeReserved).not.toBeNull();
    }
  });

  it("no-fallback protections remain intact after a terminal failure", async () => {
    const { service, controls, bundle } = buildService();
    controls.verifyResult = { isValid: false, invalidReason: "bad sig" };
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "USDC",
      "res-adv-nofallback",
    );
    const rejected = await service.submitPayment({
      reservationId,
      optionId: "USDC",
      paymentPayloadHash,
    });
    expect(rejected.state).toBe("PAYMENT_REJECTED");
    // Cannot retry the same asset (terminal) and cannot switch assets.
    await expect(
      service.submitPayment({ reservationId, optionId: "USDC", paymentPayloadHash }),
    ).rejects.toThrow(/TERMINAL|terminal/i);
    await expect(
      service.submitPayment({ reservationId, optionId: "HBAR", paymentPayloadHash }),
    ).rejects.toThrow(/WRONG_ASSET|fallback|TERMINAL/i);
    expect(controls.settleCallCount).toBe(0);
  });

  it("in-memory and filesystem services both reach ROUTE_RESERVED identically", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "res-parity-"));
    dirs.push(dir);

    async function run(store: InMemoryReservationStore | FileSystemReservationStore) {
      const bundle = buildVerifiedWinnerBundle();
      const { service, controls } = buildService({ bundle, store });
      const { reservationId, paymentPayloadHash } = await createAndSelect(
        service,
        bundle,
        "USDC",
        "res-parity",
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
      return final.routeReserved!.reservationRecordHash;
    }

    const memHash = await run(new InMemoryReservationStore());
    const fsHash = await run(new FileSystemReservationStore(dir));
    expect(memHash).toBe(fsHash);
  });
});
