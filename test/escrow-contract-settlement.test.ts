/**
 * Phase C1 — freight escrow: POD settlement, dispute, and referee resolution.
 * Offline EVM execution of the real compiled contract. No network.
 */

import { describe, expect, it } from "vitest";

import { CARRIER, OPERATOR, OUTSIDER, SHIPPER } from "./helpers/escrow-evm";
import {
  authHash,
  BUDGET,
  deployEscrow,
  EXCESS,
  STATE,
  WINNING,
  ZERO_HASH,
  type EscrowFixture,
} from "./helpers/escrow-fixtures";

async function allocated(): Promise<EscrowFixture> {
  const f = await deployEscrow();
  await f.register();
  await f.fund();
  await f.allocate();
  return f;
}

async function disputed(): Promise<EscrowFixture> {
  const f = await allocated();
  const outcome = await f.evm.send(OPERATOR, "openDispute", [
    f.tenderKey,
    authHash("dispute-1"),
  ]);
  expect(outcome.ok).toBe(true);
  return f;
}

describe("freight escrow — ordinary release", () => {
  it("pays exactly the locked amount to the winner", async () => {
    const f = await allocated();
    const outcome = await f.evm.send(OPERATOR, "releaseFull", [
      f.tenderKey,
      authHash("pod-accepted-1"),
    ]);

    expect(outcome.ok).toBe(true);
    expect(await f.state()).toBe(STATE.RELEASED);
    expect(await f.balance(CARRIER)).toBe(WINNING);
    expect(await f.tenderBalance()).toBe(0n);
    expect(await f.totalEscrowed()).toBe(0n);
    expect(await f.balance(f.evm.address)).toBe(0n);

    const events = f.evm.decodeEvents(outcome);
    expect(events.map((e) => e.name)).toEqual(["FreightReleased"]);
    expect(events[0]!.args.amount).toBe(WINNING);
    expect(events[0]!.args.fromDispute).toBe(false);
  });

  it("requires a nonzero authorization hash", async () => {
    const f = await allocated();
    const outcome = await f.evm.send(OPERATOR, "releaseFull", [
      f.tenderKey,
      ZERO_HASH,
    ]);
    expect(outcome.ok).toBe(false);
    expect(outcome.errorName).toBe("ZeroHashNotAllowed");
    expect(await f.state()).toBe(STATE.ALLOCATED);
  });

  it("a non-operator cannot release", async () => {
    const f = await allocated();
    for (const caller of [OUTSIDER, SHIPPER, CARRIER]) {
      const outcome = await f.evm.send(caller, "releaseFull", [
        f.tenderKey,
        authHash(`unauthorized-${caller}`),
      ]);
      expect(outcome.ok).toBe(false);
      expect(outcome.errorName).toBe("OwnableUnauthorizedAccount");
    }
    expect(await f.balance(CARRIER)).toBe(0n);
  });

  it("duplicate release fails", async () => {
    const f = await allocated();
    await f.evm.send(OPERATOR, "releaseFull", [
      f.tenderKey,
      authHash("pod-accepted-1"),
    ]);
    const second = await f.evm.send(OPERATOR, "releaseFull", [
      f.tenderKey,
      authHash("pod-accepted-2"),
    ]);
    expect(second.ok).toBe(false);
    expect(second.errorName).toBe("InvalidState");
    expect(await f.balance(CARRIER)).toBe(WINNING);
  });

  it("release after a no-winner refund fails", async () => {
    const f = await deployEscrow();
    await f.register();
    await f.fund();
    await f.evm.send(OPERATOR, "refundNoQualifiedBid", [
      f.tenderKey,
      authHash("no-bid-1"),
    ]);
    const outcome = await f.evm.send(OPERATOR, "releaseFull", [
      f.tenderKey,
      authHash("late-release"),
    ]);
    expect(outcome.ok).toBe(false);
    expect(await f.balance(CARRIER)).toBe(0n);
  });

  it("the terminal released state cannot be escaped", async () => {
    const f = await allocated();
    await f.evm.send(OPERATOR, "releaseFull", [
      f.tenderKey,
      authHash("pod-accepted-1"),
    ]);
    for (const [fn, args] of [
      ["openDispute", [f.tenderKey, authHash("t1")]],
      ["refundFull", [f.tenderKey, authHash("t2")]],
      ["resolveDisputeRelease", [f.tenderKey, authHash("t3")]],
      ["partialRelease", [f.tenderKey, 1n, WINNING - 1n, authHash("t4")]],
      ["allocateWinner", [f.tenderKey, CARRIER, 1n, authHash("m"), authHash("t5")]],
    ] as const) {
      const outcome = await f.evm.send(OPERATOR, fn, args as readonly unknown[]);
      expect(outcome.ok, `${fn} must fail`).toBe(false);
    }
    expect(await f.balance(CARRIER)).toBe(WINNING);
    expect(await f.state()).toBe(STATE.RELEASED);
  });
});

describe("freight escrow — dispute", () => {
  it("opening a dispute moves the tender to DISPUTED", async () => {
    const f = await allocated();
    const outcome = await f.evm.send(OPERATOR, "openDispute", [
      f.tenderKey,
      authHash("dispute-1"),
    ]);
    expect(outcome.ok).toBe(true);
    expect(await f.state()).toBe(STATE.DISPUTED);
    expect(f.evm.decodeEvents(outcome).map((e) => e.name)).toEqual([
      "DisputeOpened",
    ]);
    // Funds stay locked while the dispute is open.
    expect(await f.tenderBalance()).toBe(WINNING);
  });

  it("duplicate dispute opening fails", async () => {
    const f = await disputed();
    const second = await f.evm.send(OPERATOR, "openDispute", [
      f.tenderKey,
      authHash("dispute-2"),
    ]);
    expect(second.ok).toBe(false);
    expect(second.errorName).toBe("InvalidState");
  });

  it("a dispute requires a nonzero authorization hash and the operator role", async () => {
    const f = await allocated();
    expect(
      (await f.evm.send(OPERATOR, "openDispute", [f.tenderKey, ZERO_HASH]))
        .errorName,
    ).toBe("ZeroHashNotAllowed");
    expect(
      (await f.evm.send(SHIPPER, "openDispute", [f.tenderKey, authHash("d")]))
        .errorName,
    ).toBe("OwnableUnauthorizedAccount");
  });

  it("the ordinary release path is blocked once a dispute is open", async () => {
    const f = await disputed();
    const outcome = await f.evm.send(OPERATOR, "releaseFull", [
      f.tenderKey,
      authHash("pod-accepted-after-dispute"),
    ]);
    expect(outcome.ok).toBe(false);
    expect(outcome.errorName).toBe("InvalidState");
    expect(await f.balance(CARRIER)).toBe(0n);
    expect(await f.tenderBalance()).toBe(WINNING);
  });

  it("dispute resolutions are unavailable before a dispute exists", async () => {
    const f = await allocated();
    for (const fn of ["refundFull", "resolveDisputeRelease"] as const) {
      const outcome = await f.evm.send(OPERATOR, fn, [
        f.tenderKey,
        authHash(`early-${fn}`),
      ]);
      expect(outcome.ok, `${fn} must require DISPUTED`).toBe(false);
      expect(outcome.errorName).toBe("InvalidState");
    }
    const partial = await f.evm.send(OPERATOR, "partialRelease", [
      f.tenderKey,
      1n,
      WINNING - 1n,
      authHash("early-partial"),
    ]);
    expect(partial.ok).toBe(false);
  });
});

describe("freight escrow — referee resolutions", () => {
  it("referee-authorized full release pays the winner", async () => {
    const f = await disputed();
    const outcome = await f.evm.send(OPERATOR, "resolveDisputeRelease", [
      f.tenderKey,
      authHash("referee-release"),
    ]);
    expect(outcome.ok).toBe(true);
    expect(await f.state()).toBe(STATE.RELEASED);
    expect(await f.balance(CARRIER)).toBe(WINNING);
    const events = f.evm.decodeEvents(outcome);
    expect(events[0]!.name).toBe("FreightReleased");
    expect(events[0]!.args.fromDispute).toBe(true);
  });

  it("referee-authorized full refund returns the locked amount to the shipper", async () => {
    const f = await disputed();
    const before = await f.balance(SHIPPER);
    const outcome = await f.evm.send(OPERATOR, "refundFull", [
      f.tenderKey,
      authHash("referee-refund"),
    ]);
    expect(outcome.ok).toBe(true);
    expect(await f.state()).toBe(STATE.REFUNDED);
    expect(await f.balance(SHIPPER)).toBe(before + WINNING);
    expect(await f.balance(CARRIER)).toBe(0n);
    expect(await f.totalEscrowed()).toBe(0n);
    const events = f.evm.decodeEvents(outcome);
    expect(events[0]!.name).toBe("FreightRefunded");
    expect(events[0]!.args.amount).toBe(WINNING);
  });

  it("partial release conserves the complete locked amount", async () => {
    const f = await disputed();
    const shipperBefore = await f.balance(SHIPPER);
    const toWinner = 400_000n;
    const toShipper = WINNING - toWinner;

    const outcome = await f.evm.send(OPERATOR, "partialRelease", [
      f.tenderKey,
      toWinner,
      toShipper,
      authHash("referee-partial"),
    ]);
    expect(outcome.ok).toBe(true);
    expect(await f.state()).toBe(STATE.PARTIALLY_RELEASED);
    expect(await f.balance(CARRIER)).toBe(toWinner);
    expect(await f.balance(SHIPPER)).toBe(shipperBefore + toShipper);
    expect(await f.tenderBalance()).toBe(0n);
    expect(await f.totalEscrowed()).toBe(0n);
    expect(await f.balance(f.evm.address)).toBe(0n);

    const events = f.evm.decodeEvents(outcome);
    expect(events[0]!.name).toBe("FreightPartiallyReleased");
    expect(events[0]!.args.winnerAmount).toBe(toWinner);
    expect(events[0]!.args.shipperAmount).toBe(toShipper);
  });

  it("a one-sided partial release is allowed when it conserves the lock", async () => {
    const f = await disputed();
    const outcome = await f.evm.send(OPERATOR, "partialRelease", [
      f.tenderKey,
      WINNING,
      0n,
      authHash("referee-partial-all"),
    ]);
    expect(outcome.ok).toBe(true);
    expect(await f.balance(CARRIER)).toBe(WINNING);
  });

  it("partial amounts that do not conserve the locked amount fail", async () => {
    const f = await disputed();
    for (const [toWinner, toShipper] of [
      [WINNING, 1n],
      [WINNING - 1n, 0n],
      [1n, 1n],
      [0n, 0n],
    ] as const) {
      const outcome = await f.evm.send(OPERATOR, "partialRelease", [
        f.tenderKey,
        toWinner,
        toShipper,
        authHash(`bad-partial-${toWinner}-${toShipper}`),
      ]);
      expect(outcome.ok, `${toWinner}/${toShipper} must fail`).toBe(false);
    }
    expect(await f.state()).toBe(STATE.DISPUTED);
    expect(await f.tenderBalance()).toBe(WINNING);
    expect(await f.balance(CARRIER)).toBe(0n);
  });

  it("an authorization hash cannot be reused", async () => {
    const f = await disputed();
    const reused = authHash("dispute-1"); // already consumed by openDispute

    const release = await f.evm.send(OPERATOR, "resolveDisputeRelease", [
      f.tenderKey,
      reused,
    ]);
    expect(release.ok).toBe(false);
    expect(release.errorName).toBe("AuthorizationHashAlreadyUsed");

    // A fresh hash settles; the consumed hash then fails on another tender too.
    expect(
      (
        await f.evm.send(OPERATOR, "resolveDisputeRelease", [
          f.tenderKey,
          authHash("referee-release"),
        ])
      ).ok,
    ).toBe(true);

    const otherKey = await f.key("tender-c1-second");
    const crossTender = await f.register({
      tenderKey: otherKey,
      tenderIdHash: (await import("ethers")).keccak256(
        (await import("ethers")).toUtf8Bytes("tender-c1-second"),
      ),
      creationAuthHash: authHash("referee-release"),
    });
    expect(crossTender.ok).toBe(false);
    expect(crossTender.errorName).toBe("AuthorizationHashAlreadyUsed");
  });

  it("AI-shaped data alone cannot authorize any transfer", async () => {
    const f = await disputed();
    // The contract accepts only the operator plus a canonical authorization
    // hash. An "AI advisory" payload is just an unauthorized caller.
    const aiCaller = await f.evm.send(OUTSIDER, "resolveDisputeRelease", [
      f.tenderKey,
      authHash("ai-advisory-recommends-release"),
    ]);
    expect(aiCaller.ok).toBe(false);
    expect(aiCaller.errorName).toBe("OwnableUnauthorizedAccount");
    expect(await f.balance(CARRIER)).toBe(0n);
    expect(await f.tenderBalance()).toBe(WINNING);
  });

  it("the terminal partially-released state cannot be escaped", async () => {
    const f = await disputed();
    await f.evm.send(OPERATOR, "partialRelease", [
      f.tenderKey,
      400_000n,
      WINNING - 400_000n,
      authHash("referee-partial"),
    ]);
    for (const fn of [
      "releaseFull",
      "refundFull",
      "resolveDisputeRelease",
      "openDispute",
    ] as const) {
      const outcome = await f.evm.send(OPERATOR, fn, [
        f.tenderKey,
        authHash(`escape-${fn}`),
      ]);
      expect(outcome.ok, `${fn} must fail`).toBe(false);
    }
    expect(await f.state()).toBe(STATE.PARTIALLY_RELEASED);
    expect(await f.balance(f.evm.address)).toBe(0n);
  });

  it("full settlement conserves the entire funded budget across parties", async () => {
    const f = await allocated();
    const shipperAfterAllocation = await f.balance(SHIPPER);
    await f.evm.send(OPERATOR, "releaseFull", [
      f.tenderKey,
      authHash("pod-accepted-1"),
    ]);

    // Shipper got the excess back; carrier got exactly the winning amount.
    expect(await f.balance(CARRIER)).toBe(WINNING);
    expect(await f.balance(SHIPPER)).toBe(shipperAfterAllocation);
    expect(WINNING + EXCESS).toBe(BUDGET);
    expect(await f.balance(f.evm.address)).toBe(0n);
  });
});
