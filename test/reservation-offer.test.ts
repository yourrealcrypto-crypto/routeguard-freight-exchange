import { describe, expect, it } from "vitest";

import {
  createReservationOffer,
  selectPaymentOption,
  verifyOfferIntegrity,
} from "../src/reservation/offer";
import { ReservationError } from "../src/reservation/types";
import { DEMO_WINNER_ACCOUNT } from "./fixtures/reservation-fixtures";

describe("Reservation offer", () => {
  const base = {
    reservationId: "res-offer-1",
    tenderId: "tender-1",
    winningBidId: "bid-a",
    payTo: DEMO_WINNER_ACCOUNT,
    expiresAt: "2026-07-15T20:00:00.000Z",
  };

  it("creates immutable dual-asset demo fee offer", () => {
    const offer = createReservationOffer(base);
    expect(offer.options).toHaveLength(2);
    expect(offer.options[0]?.optionId).toBe("USDC");
    expect(offer.options[0]?.amountAtomic).toBe("10000");
    expect(offer.options[0]?.asset).toBe("0.0.429274");
    expect(offer.options[1]?.optionId).toBe("HBAR");
    expect(offer.options[1]?.amountAtomic).toBe("1000000");
    expect(offer.payTo).toBe(DEMO_WINNER_ACCOUNT);
    expect(offer.feeLabel).toMatch(/Demo reservation fee/);
    expect(Object.isFrozen(offer)).toBe(true);
    expect(Object.isFrozen(offer.options)).toBe(true);
    expect(Object.isFrozen(offer.options[0])).toBe(true);
    verifyOfferIntegrity(offer);
  });

  it("detects offer hash mutation", () => {
    const offer = createReservationOffer(base);
    const mutated = { ...offer, offerHash: "sha256:" + "ab".repeat(32) };
    expect(() => verifyOfferIntegrity(mutated as typeof offer)).toThrow(
      /hash/i,
    );
  });

  it("rejects mutation of frozen options", () => {
    const offer = createReservationOffer(base);
    expect(() => {
      (offer.options as unknown as { optionId: string }[])[0]!.optionId =
        "HACK";
    }).toThrow();
  });

  it("rejects wrong recipient account format", () => {
    expect(() =>
      createReservationOffer({ ...base, payTo: "not-an-account" }),
    ).toThrow(ReservationError);
  });

  it("selects USDC and binds exact fields", () => {
    const offer = createReservationOffer(base);
    const selected = selectPaymentOption({
      offer,
      optionId: "USDC",
      payerAccount: "0.0.9197513",
      offerHash: offer.offerHash,
      offerVersion: offer.offerVersion,
      selectedAt: "2026-07-15T19:00:00.000Z",
      now: "2026-07-15T19:00:00.000Z",
    });
    expect(selected.asset).toBe("0.0.429274");
    expect(selected.amountAtomic).toBe("10000");
    expect(selected.payTo).toBe(DEMO_WINNER_ACCOUNT);
    expect(selected.resourcePath).toContain("/pay/usdc");
  });

  it("rejects unknown option, stale hash/version, expired offer", () => {
    const offer = createReservationOffer(base);
    expect(() =>
      selectPaymentOption({
        offer,
        optionId: "BTC" as "USDC",
        payerAccount: "0.0.9197513",
        offerHash: offer.offerHash,
        offerVersion: offer.offerVersion,
        selectedAt: "2026-07-15T19:00:00.000Z",
        now: "2026-07-15T19:00:00.000Z",
      }),
    ).toThrow(/Unknown option/i);

    expect(() =>
      selectPaymentOption({
        offer,
        optionId: "USDC",
        payerAccount: "0.0.9197513",
        offerHash: "sha256:" + "00".repeat(32),
        offerVersion: offer.offerVersion,
        selectedAt: "2026-07-15T19:00:00.000Z",
        now: "2026-07-15T19:00:00.000Z",
      }),
    ).toThrow(/offerHash/i);

    expect(() =>
      selectPaymentOption({
        offer,
        optionId: "USDC",
        payerAccount: "0.0.9197513",
        offerHash: offer.offerHash,
        offerVersion: 99,
        selectedAt: "2026-07-15T19:00:00.000Z",
        now: "2026-07-15T19:00:00.000Z",
      }),
    ).toThrow(/offerVersion/i);

    expect(() =>
      selectPaymentOption({
        offer,
        optionId: "USDC",
        payerAccount: "0.0.9197513",
        offerHash: offer.offerHash,
        offerVersion: offer.offerVersion,
        selectedAt: "2026-07-15T21:00:00.000Z",
        now: "2026-07-15T21:00:00.000Z",
      }),
    ).toThrow(/expired/i);
  });

  it("offer hash is stable across key order (canonical)", () => {
    const a = createReservationOffer(base);
    const b = createReservationOffer(base);
    expect(a.offerHash).toBe(b.offerHash);
  });
});
