import { describe, expect, it } from "vitest";

import {
  assertCanEnterRouteReserved,
  assertLegalTransition,
  IllegalReservationTransitionError,
  isPaymentSubmissionLocked,
} from "../src/reservation/state-machine";
import { ReservationError } from "../src/reservation/types";

describe("Reservation state machine", () => {
  it("allows happy path transitions", () => {
    const path = [
      ["OFFER_CREATED", "OPTION_SELECTED"],
      ["OPTION_SELECTED", "PAYMENT_CHALLENGE_ISSUED"],
      ["PAYMENT_CHALLENGE_ISSUED", "PAYMENT_SUBMISSION_STARTED"],
      ["PAYMENT_SUBMISSION_STARTED", "FACILITATOR_VERIFIED"],
      ["FACILITATOR_VERIFIED", "FACILITATOR_SETTLED"],
      ["FACILITATOR_SETTLED", "MIRROR_CONFIRMATION_PENDING"],
      ["MIRROR_CONFIRMATION_PENDING", "PAYMENT_CONFIRMED"],
      ["PAYMENT_CONFIRMED", "ROUTE_RESERVED"],
      ["ROUTE_RESERVED", "WEBHOOKS_DISPATCHED"],
      ["WEBHOOKS_DISPATCHED", "HCS_EVIDENCE_RECORDED"],
      ["HCS_EVIDENCE_RECORDED", "COMPLETED"],
    ] as const;
    for (const [from, to] of path) {
      expect(() => assertLegalTransition(from, to)).not.toThrow();
    }
  });

  it("rejects illegal transitions", () => {
    expect(() =>
      assertLegalTransition("OFFER_CREATED", "ROUTE_RESERVED"),
    ).toThrow(IllegalReservationTransitionError);
    expect(() =>
      assertLegalTransition("PAYMENT_REJECTED", "OPTION_SELECTED"),
    ).toThrow(IllegalReservationTransitionError);
    expect(() =>
      assertLegalTransition("SETTLEMENT_FAILED", "FACILITATOR_VERIFIED"),
    ).toThrow(/Terminal|Illegal/);
  });

  it("locks selection after payment submission", () => {
    expect(isPaymentSubmissionLocked("PAYMENT_SUBMISSION_STARTED")).toBe(true);
    expect(isPaymentSubmissionLocked("ROUTE_RESERVED")).toBe(true);
    expect(isPaymentSubmissionLocked("OFFER_CREATED")).toBe(false);
    expect(isPaymentSubmissionLocked("OPTION_SELECTED")).toBe(false);
  });

  it("ROUTE_RESERVED requires PAYMENT_CONFIRMED + mirror SUCCESS + tx id", () => {
    expect(() =>
      assertCanEnterRouteReserved({
        state: "MIRROR_CONFIRMATION_PENDING",
        mirrorStatus: "SUCCESS",
        transactionId: "0.0.1@1.1",
      }),
    ).toThrow(ReservationError);

    expect(() =>
      assertCanEnterRouteReserved({
        state: "PAYMENT_CONFIRMED",
        mirrorStatus: "PENDING",
        transactionId: "0.0.1@1.1",
      }),
    ).toThrow(/Mirror/);

    expect(() =>
      assertCanEnterRouteReserved({
        state: "PAYMENT_CONFIRMED",
        mirrorStatus: "SUCCESS",
        transactionId: null,
      }),
    ).toThrow(/transaction ID/i);

    expect(() =>
      assertCanEnterRouteReserved({
        state: "PAYMENT_CONFIRMED",
        mirrorStatus: "SUCCESS",
        transactionId: "0.0.1@1.1",
      }),
    ).not.toThrow();
  });

  it("webhook/HCS failure states remain post-reservation", () => {
    expect(() =>
      assertLegalTransition("ROUTE_RESERVED", "WEBHOOK_DELIVERY_FAILED"),
    ).not.toThrow();
    expect(() =>
      assertLegalTransition("WEBHOOK_DELIVERY_FAILED", "HCS_EVIDENCE_RECORDED"),
    ).not.toThrow();
    expect(() =>
      assertLegalTransition("ROUTE_RESERVED", "PAYMENT_CONFIRMED"),
    ).toThrow();
  });
});
