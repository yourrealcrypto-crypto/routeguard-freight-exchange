import { describe, expect, it } from "vitest";

import type { FreightTender } from "../src/domain/tender";
import { validateWinnerReservationInput } from "../src/reservation/winner-input";
import {
  buildNoQualifiedBidBundle,
  buildVerifiedWinnerBundle,
  createReservationInputFromBundle,
} from "./fixtures/reservation-fixtures";
import { buildService } from "./reservation-helpers";

describe("Mandatory winner + manifest reverification (L2)", () => {
  it("genuine winner input passes full reverification", () => {
    const bundle = buildVerifiedWinnerBundle();
    const input = createReservationInputFromBundle(bundle, "res-good");
    const validated = validateWinnerReservationInput(
      input,
      bundle.registry,
      bundle.tender,
    );
    expect(validated.winningBidId).toBe(bundle.winningBidId);
  });

  it("omitted tender fails closed at the runtime boundary", () => {
    const bundle = buildVerifiedWinnerBundle();
    const input = createReservationInputFromBundle(bundle, "res-no-tender");
    expect(() =>
      validateWinnerReservationInput(
        input,
        bundle.registry,
        undefined as unknown as FreightTender,
      ),
    ).toThrow(/TENDER_REQUIRED|mandatory/i);
  });

  it("service.createReservation requires the tender at runtime", async () => {
    const { service, bundle } = buildService();
    const input = createReservationInputFromBundle(bundle, "res-svc-no-tender");
    await expect(
      service.createReservation(input, undefined as unknown as FreightTender),
    ).rejects.toThrow(/TENDER_REQUIRED|mandatory/i);
  });

  it("wrong tender identity with authentic proof fails", () => {
    const bundle = buildVerifiedWinnerBundle();
    const input = createReservationInputFromBundle(bundle, "res-wrong-tender");
    const wrongTender = {
      ...bundle.tender,
      tenderId: "tender-someone-else",
    } as FreightTender;
    expect(() =>
      validateWinnerReservationInput(input, bundle.registry, wrongTender),
    ).toThrow(/does not match reservation|TENDER_MISMATCH/i);
  });

  it("wrong rules/evaluation snapshot (tampered tender content) fails manifest integrity", () => {
    const bundle = buildVerifiedWinnerBundle();
    const input = createReservationInputFromBundle(bundle, "res-wrong-rules");
    // Same identity, different content → reconstructed manifest cannot match.
    const tamperedTender = {
      ...bundle.tender,
      maximumFreightPriceCents: 999_999,
    } as FreightTender;
    expect(() =>
      validateWinnerReservationInput(input, bundle.registry, tamperedTender),
    ).toThrow(/MANIFEST_INTEGRITY|integrity|mismatch/i);
  });

  it("self-consistent but inconsistent manifest is rejected by full reconstruction", () => {
    const bundle = buildVerifiedWinnerBundle();
    const input = createReservationInputFromBundle(bundle, "res-rehash");
    // A tender whose independent evaluation yields a different evaluatedBidSetHash.
    const tampered = {
      ...bundle.tender,
      deliveryDeadline: "2026-07-25T16:00:00.000Z",
    } as FreightTender;
    expect(() =>
      validateWinnerReservationInput(input, bundle.registry, tampered),
    ).toThrow(/MANIFEST_INTEGRITY|integrity|mismatch/i);
  });

  it("authentic NO_QUALIFIED_BID closure proof fails reservation with NO_WINNER", async () => {
    const bundle = buildNoQualifiedBidBundle();
    // The authentic proof has no ranked winner.
    expect(bundle.proof.manifest.winningBidId).toBeNull();

    const input = createReservationInputFromBundle(bundle, "res-no-winner");
    const { service } = buildService({ bundle });
    await expect(
      service.createReservation(input, bundle.tender),
    ).rejects.toThrow(/no ranked winner|NO_WINNER/i);

    // And directly at the validation boundary.
    expect(() =>
      validateWinnerReservationInput(input, bundle.registry, bundle.tender),
    ).toThrow(/no ranked winner|NO_WINNER/i);
  });
});
