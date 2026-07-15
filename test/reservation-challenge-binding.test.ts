/**
 * Phase 6A.2B — complete durable payment challenge binding and idempotent GET.
 */

import { describe, expect, it } from "vitest";

import {
  computeChallengeHash,
  createPaymentChallengeRecord,
  expectedChallengeFields,
} from "../src/reservation/challenge";
import {
  CHALLENGE_MAX_TIMEOUT_SECONDS,
  CHALLENGE_X402_VERSION,
  DEMO_RESERVATION_FEE_NOTE,
  type PaymentChallenge,
} from "../src/reservation/types";
import {
  buildService,
  createAndSelect,
  DEMO_PAYER_ACCOUNT,
} from "./reservation-helpers";
import { DEMO_WINNER_ACCOUNT } from "./fixtures/reservation-fixtures";

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

async function selectOnly(
  optionId: "USDC" | "HBAR",
  reservationId: string,
) {
  const ctx = buildService({ now: "2026-07-15T19:01:00.000Z" });
  const input = (
    await import("./fixtures/reservation-fixtures")
  ).createReservationInputFromBundle(ctx.bundle, reservationId);
  const record = await ctx.service.createReservation(input, ctx.bundle.tender);
  await ctx.service.selectOption({
    reservationId,
    optionId,
    offerHash: record.offer.offerHash,
    offerVersion: record.offer.offerVersion,
    payerAccount: DEMO_PAYER_ACCOUNT,
  });
  return ctx;
}

describe("Durable payment challenge binding (Phase 6A.2B)", () => {
  it("1. exact valid USDC challenge accepted", async () => {
    const { service, store } = await selectOnly("USDC", "res-ch-usdc");
    const { challenge, record } = await service.issueChallenge(
      "res-ch-usdc",
      "USDC",
    );
    expect(challenge.x402Version).toBe(CHALLENGE_X402_VERSION);
    expect(challenge.scheme).toBe("exact");
    expect(challenge.network).toBe("hedera:testnet");
    expect(challenge.asset).toBe("0.0.429274");
    expect(challenge.amount).toBe("10000");
    expect(challenge.payTo).toBe(DEMO_WINNER_ACCOUNT);
    expect(challenge.resource).toBe("/api/reservations/res-ch-usdc/pay/usdc");
    expect(challenge.maxTimeoutSeconds).toBe(CHALLENGE_MAX_TIMEOUT_SECONDS);
    expect(challenge.description).toBe(DEMO_RESERVATION_FEE_NOTE);
    expect(record.paymentChallenge).not.toBeNull();
    expect(record.paymentChallengeHash).toBe(challenge.challengeHash);
    expect((await store.get("res-ch-usdc"))!.paymentChallenge!.challengeHash).toBe(
      challenge.challengeHash,
    );
  });

  it("2. exact valid HBAR challenge accepted", async () => {
    const { service } = await selectOnly("HBAR", "res-ch-hbar");
    const { challenge } = await service.issueChallenge("res-ch-hbar", "HBAR");
    expect(challenge.asset).toBe("0.0.0");
    expect(challenge.amount).toBe("1000000");
    expect(challenge.resource).toBe("/api/reservations/res-ch-hbar/pay/hbar");
    expect(challenge.payTo).toBe(DEMO_WINNER_ACCOUNT);
    expect(challenge.maxTimeoutSeconds).toBe(180);
    expect(challenge.x402Version).toBe(2);
  });

  async function rejectMutated(
    reservationId: string,
    optionId: "USDC" | "HBAR",
    mutate: (c: PaymentChallenge) => PaymentChallenge,
  ) {
    const { service, controls } = await selectOnly(optionId, reservationId);
    controls.challengeImpl = async (selected) => {
      const base: PaymentChallenge = {
        x402Version: 2,
        scheme: selected.scheme,
        network: selected.network,
        asset: selected.asset,
        amount: selected.amountAtomic,
        payTo: selected.payTo,
        resource: selected.resourcePath,
        maxTimeoutSeconds: 180,
        description: DEMO_RESERVATION_FEE_NOTE,
      };
      return mutate(base);
    };
    await expect(
      service.issueChallenge(reservationId, optionId),
    ).rejects.toThrow(/CHALLENGE_MISMATCH|mismatch|must be|rejected/i);
  }

  it("3. wrong x402Version rejected", async () => {
    await rejectMutated("res-ch-ver", "USDC", (c) => ({
      ...c,
      x402Version: 1,
    }));
  });

  it("4. wrong scheme rejected", async () => {
    await rejectMutated("res-ch-scheme", "USDC", (c) => ({
      ...c,
      scheme: "other" as never,
    }));
  });

  it("5. wrong network rejected", async () => {
    await rejectMutated("res-ch-net", "HBAR", (c) => ({
      ...c,
      network: "hedera:mainnet" as never,
    }));
  });

  it("6. wrong asset rejected", async () => {
    await rejectMutated("res-ch-asset", "USDC", (c) => ({
      ...c,
      asset: "0.0.1",
    }));
  });

  it("7. wrong amount rejected", async () => {
    await rejectMutated("res-ch-amt", "HBAR", (c) => ({
      ...c,
      amount: "1",
    }));
  });

  it("8. wrong recipient rejected", async () => {
    await rejectMutated("res-ch-payto", "USDC", (c) => ({
      ...c,
      payTo: "0.0.1",
    }));
  });

  it("9. wrong resource rejected", async () => {
    await rejectMutated("res-ch-res", "USDC", (c) => ({
      ...c,
      resource: "/api/reservations/res-ch-res/pay/hbar",
    }));
  });

  it("10. wrong maxTimeoutSeconds rejected", async () => {
    await rejectMutated("res-ch-timeout", "HBAR", (c) => ({
      ...c,
      maxTimeoutSeconds: 60,
    }));
  });

  it("11. challenge hash changes if any bound field changes", async () => {
    const { service } = await selectOnly("USDC", "res-ch-hash");
    const { challenge } = await service.issueChallenge("res-ch-hash", "USDC");
    const base = {
      x402Version: challenge.x402Version as 2,
      scheme: challenge.scheme,
      network: challenge.network,
      asset: challenge.asset,
      amount: challenge.amount,
      payTo: challenge.payTo,
      resource: challenge.resource,
      maxTimeoutSeconds: challenge.maxTimeoutSeconds as 180,
      description: challenge.description,
      issuedAt: challenge.issuedAt,
    };
    expect(computeChallengeHash(base)).toBe(challenge.challengeHash);
    expect(
      computeChallengeHash({ ...base, amount: "99999" }),
    ).not.toBe(challenge.challengeHash);
    expect(
      computeChallengeHash({ ...base, resource: base.resource + "/x" }),
    ).not.toBe(challenge.challengeHash);
    expect(
      computeChallengeHash({ ...base, issuedAt: "2026-07-15T20:00:00.000Z" }),
    ).not.toBe(challenge.challengeHash);
    expect(
      computeChallengeHash({ ...base, description: "other" }),
    ).not.toBe(challenge.challengeHash);
  });

  it("12+13. repeated GET returns identical object/hash and does not call transport again", async () => {
    const { service, controls, setNow } = await selectOnly(
      "HBAR",
      "res-ch-idem",
    );
    const first = await service.issueChallenge("res-ch-idem", "HBAR");
    expect(controls.challengeCallCount).toBe(1);
    setNow("2026-07-15T19:45:00.000Z");
    const second = await service.issueChallenge("res-ch-idem", "HBAR");
    expect(controls.challengeCallCount).toBe(1);
    expect(second.challenge).toEqual(first.challenge);
    expect(second.challenge.challengeHash).toBe(first.challenge.challengeHash);
    expect(second.challenge.issuedAt).toBe(first.challenge.issuedAt);
    expect(second.challenge.issuedAt).toBe("2026-07-15T19:01:00.000Z");
  });

  it("14. concurrent challenge requests cannot overwrite one another", async () => {
    const { service, store, controls } = await selectOnly(
      "USDC",
      "res-ch-conc",
    );
    const barrier = twoPartyBarrier();
    const origCas = store.compareAndSet.bind(store);
    store.compareAndSet = async (id, expected, next) => {
      if (next.paymentChallenge && !next.paymentPayloadHash) {
        await barrier();
      }
      return origCas(id, expected, next);
    };

    const [a, b] = await Promise.all([
      service.issueChallenge("res-ch-conc", "USDC"),
      service.issueChallenge("res-ch-conc", "USDC"),
    ]);

    expect(a.challenge.challengeHash).toBe(b.challenge.challengeHash);
    expect(a.challenge.issuedAt).toBe(b.challenge.issuedAt);
    const durable = (await store.get("res-ch-conc"))!;
    expect(durable.paymentChallenge!.challengeHash).toBe(
      a.challenge.challengeHash,
    );
    // Transport at most once, or if twice both lost CAS still one durable record.
    expect(controls.challengeCallCount).toBeLessThanOrEqual(2);
    expect(durable.paymentChallenge).not.toBeNull();
  });

  it("15. alternate asset challenge remains locked", async () => {
    const ctx = buildService();
    const { reservationId } = await createAndSelect(
      ctx.service,
      ctx.bundle,
      "USDC",
      "res-ch-alt",
    );
    await expect(
      ctx.service.issueChallenge(reservationId, "HBAR"),
    ).rejects.toThrow(/WRONG_ASSET_ROUTE|cannot use/i);
    const again = await ctx.service.issueChallenge(reservationId, "USDC");
    expect(again.challenge.asset).toBe("0.0.429274");
    expect(again.challenge.resource).toContain("/pay/usdc");
  });

  it("16. persisted challenge contains no signed payload or secret material", async () => {
    const { service, store } = await selectOnly("USDC", "res-ch-nosec");
    await service.issueChallenge("res-ch-nosec", "USDC");
    const rec = (await store.get("res-ch-nosec"))!;
    const ch = rec.paymentChallenge!;
    expect(ch).not.toHaveProperty("signature");
    expect(ch).not.toHaveProperty("paymentPayload");
    expect(ch).not.toHaveProperty("headers");
    expect(ch).not.toHaveProperty("privateKey");
    expect(ch).not.toHaveProperty("PAYMENT-SIGNATURE");
    expect(Object.keys(ch).sort()).toEqual(
      [
        "amount",
        "asset",
        "challengeHash",
        "description",
        "issuedAt",
        "maxTimeoutSeconds",
        "network",
        "payTo",
        "resource",
        "scheme",
        "x402Version",
      ].sort(),
    );
  });

  it("expectedChallengeFields matches resource paths", () => {
    const usdc = expectedChallengeFields({
      reservationId: "r1",
      offerHash: "h",
      offerVersion: 1,
      optionId: "USDC",
      payerAccount: DEMO_PAYER_ACCOUNT,
      payTo: DEMO_WINNER_ACCOUNT,
      asset: "0.0.429274",
      amountAtomic: "10000",
      scheme: "exact",
      network: "hedera:testnet",
      selectedAt: "2026-07-15T19:00:00.000Z",
      resourcePath: "/api/reservations/r1/pay/usdc",
    });
    expect(usdc.resource).toBe("/api/reservations/r1/pay/usdc");
    expect(usdc.amount).toBe("10000");
  });
});

// keep createPaymentChallengeRecord reachable for type completeness
void createPaymentChallengeRecord;
