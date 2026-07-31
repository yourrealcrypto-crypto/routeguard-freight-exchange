/**
 * Phase C1 — freight escrow: registration, funding, allocation, no-winner refund.
 * Real compiled bytecode executed in an in-process EVM. No network.
 */

import { describe, expect, it } from "vitest";

import {
  CARRIER,
  OPERATOR,
  OTHER_TOKEN,
  OUTSIDER,
  SHIPPER,
  TOKEN,
} from "./helpers/escrow-evm";
import {
  authHash,
  BUDGET,
  deployEscrow,
  EXCESS,
  idHash,
  STATE,
  WINNING,
  ZERO_ADDRESS,
  ZERO_HASH,
} from "./helpers/escrow-fixtures";

describe("freight escrow — registration", () => {
  it("operator registers a valid tender", async () => {
    const f = await deployEscrow();
    const outcome = await f.register();

    expect(outcome.ok).toBe(true);
    expect(await f.state()).toBe(STATE.REGISTERED);

    const events = f.evm.decodeEvents(outcome);
    expect(events.map((e) => e.name)).toEqual(["TenderEscrowRegistered"]);
    expect(events[0]!.args.maxBudget).toBe(BUDGET);
    expect(String(events[0]!.args.shipper).toLowerCase()).toBe(SHIPPER);
    expect(events[0]!.args.tenderVersion).toBe(1n);
  });

  it("non-operator registration fails", async () => {
    const f = await deployEscrow();
    const outcome = await f.register({ from: OUTSIDER });
    expect(outcome.ok).toBe(false);
    expect(outcome.errorName).toBe("OwnableUnauthorizedAccount");
    expect(await f.state()).toBe(STATE.UNREGISTERED);
  });

  it("duplicate tender registration fails", async () => {
    const f = await deployEscrow();
    expect((await f.register()).ok).toBe(true);
    const duplicate = await f.register({
      creationAuthHash: authHash("create-2"),
    });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.errorName).toBe("TenderAlreadyRegistered");
  });

  it("zero shipper fails", async () => {
    const f = await deployEscrow();
    const outcome = await f.register({ shipper: ZERO_ADDRESS });
    expect(outcome.ok).toBe(false);
    expect(outcome.errorName).toBe("ZeroAddressNotAllowed");
  });

  it("zero maximum budget fails", async () => {
    const f = await deployEscrow();
    const outcome = await f.register({ maxBudget: 0n });
    expect(outcome.ok).toBe(false);
    expect(outcome.errorName).toBe("ZeroAmountNotAllowed");
  });

  it("a token other than the configured escrow token fails", async () => {
    const f = await deployEscrow();
    const outcome = await f.register({ token: OTHER_TOKEN });
    expect(outcome.ok).toBe(false);
    expect(outcome.errorName).toBe("UnsupportedToken");
  });

  it("a tender key that does not match its identity fails", async () => {
    const f = await deployEscrow();
    const outcome = await f.register({
      tenderKey: await f.key("some-other-tender"),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.errorName).toBe("TenderNotRegistered");
  });

  it("zero identity or authorization hashes fail", async () => {
    const f = await deployEscrow();
    // The zero-hash guard runs before the key-derivation check.
    expect((await f.register({ tenderIdHash: ZERO_HASH })).errorName).toBe(
      "ZeroHashNotAllowed",
    );
    expect((await f.register({ creationAuthHash: ZERO_HASH })).errorName).toBe(
      "ZeroHashNotAllowed",
    );
  });

  it("tender identity and maximum budget remain immutable", async () => {
    const f = await deployEscrow();
    await f.register();

    // Any re-registration attempt is rejected, whatever the new values.
    const attempt = await f.register({
      shipper: OUTSIDER,
      maxBudget: BUDGET * 2n,
      creationAuthHash: authHash("create-3"),
    });
    expect(attempt.ok).toBe(false);

    const tender = await f.evm.call<Record<string, unknown>>("getTender", [
      f.tenderKey,
    ]);
    expect(String(tender[2]).toLowerCase()).toBe(SHIPPER); // shipper
    expect(tender[4]).toBe(BUDGET); // maxBudget
    expect(tender[1]).toBe(1n); // tenderVersion
  });
});

describe("freight escrow — funding", () => {
  it("the registered shipper funds the exact budget", async () => {
    const f = await deployEscrow();
    await f.register();
    const outcome = await f.fund();

    expect(outcome.ok).toBe(true);
    expect(await f.state()).toBe(STATE.FUNDED);
    expect(await f.tenderBalance()).toBe(BUDGET);
    expect(await f.totalEscrowed()).toBe(BUDGET);
    expect(await f.balance(f.evm.address)).toBe(BUDGET);

    const events = f.evm.decodeEvents(outcome);
    expect(events.map((e) => e.name)).toEqual(["TenderEscrowFunded"]);
    expect(events[0]!.args.fundedAmount).toBe(BUDGET);
  });

  it("only the registered shipper may fund", async () => {
    const f = await deployEscrow();
    await f.register();
    await f.evm.send(OPERATOR, "mint", [OUTSIDER, BUDGET]);

    const outcome = await f.fund(BUDGET, OUTSIDER);
    expect(outcome.ok).toBe(false);
    expect(outcome.errorName).toBe("NotAuthorizedShipper");
    expect(await f.state()).toBe(STATE.REGISTERED);

    const operatorAttempt = await f.fund(BUDGET, OPERATOR);
    expect(operatorAttempt.ok).toBe(false);
  });

  it("funding before registration fails", async () => {
    const f = await deployEscrow();
    const outcome = await f.fund();
    expect(outcome.ok).toBe(false);
    expect(outcome.errorName).toBe("InvalidState");
  });

  it("duplicate funding fails", async () => {
    const f = await deployEscrow();
    await f.register();
    expect((await f.fund()).ok).toBe(true);
    const second = await f.fund();
    expect(second.ok).toBe(false);
    expect(second.errorName).toBe("InvalidState");
    expect(await f.tenderBalance()).toBe(BUDGET);
  });

  it("underfunding fails", async () => {
    const f = await deployEscrow();
    await f.register();
    const outcome = await f.fund(BUDGET - 1n);
    expect(outcome.ok).toBe(false);
    expect(outcome.errorName).toBe("FundingAmountMismatch");
    expect(await f.state()).toBe(STATE.REGISTERED);
  });

  it("overfunding fails — Phase A locks exact funding", async () => {
    const f = await deployEscrow();
    await f.register();
    const outcome = await f.fund(BUDGET + 1n);
    expect(outcome.ok).toBe(false);
    expect(outcome.errorName).toBe("FundingAmountMismatch");
    expect(await f.state()).toBe(STATE.REGISTERED);
    expect(await f.totalEscrowed()).toBe(0n);
  });

  it("a failed token transfer leaves state unchanged", async () => {
    const f = await deployEscrow();
    await f.register();
    await f.evm.send(OPERATOR, "setFailingAccount", [SHIPPER]);

    const outcome = await f.fund();
    expect(outcome.ok).toBe(false);
    expect(outcome.errorName).toBe("TokenTransferFailed");
    expect(await f.state()).toBe(STATE.REGISTERED);
    expect(await f.totalEscrowed()).toBe(0n);
    expect(await f.balance(f.evm.address)).toBe(0n);
  });

  it("a second tender's balance is unaffected", async () => {
    const f = await deployEscrow();
    await f.register();
    await f.fund();

    const otherKey = await f.key("tender-c1-other");
    await f.register({
      tenderKey: otherKey,
      tenderIdHash: idHash("tender-c1-other"),
      creationAuthHash: authHash("create-other"),
    });
    await f.fund(BUDGET, SHIPPER, otherKey);

    expect(await f.tenderBalance()).toBe(BUDGET);
    expect(await f.tenderBalance(otherKey)).toBe(BUDGET);
    expect(await f.totalEscrowed()).toBe(BUDGET * 2n);
    expect(await f.balance(f.evm.address)).toBe(BUDGET * 2n);
  });
});

describe("freight escrow — winner allocation", () => {
  async function funded() {
    const f = await deployEscrow();
    await f.register();
    await f.fund();
    return f;
  }

  it("operator allocates a valid winner and refunds the exact excess", async () => {
    const f = await funded();
    const shipperBefore = await f.balance(SHIPPER);

    const outcome = await f.allocate();
    expect(outcome.ok).toBe(true);
    expect(await f.state()).toBe(STATE.ALLOCATED);

    const events = f.evm.decodeEvents(outcome);
    expect(events.map((e) => e.name)).toEqual([
      "WinnerAllocated",
      "ExcessRefunded",
    ]);
    expect(events[0]!.args.winningAmount).toBe(WINNING);
    expect(events[0]!.args.excessAmount).toBe(EXCESS);

    // Conservation: winning + excess == funded.
    expect(WINNING + EXCESS).toBe(BUDGET);
    // The carrier receives nothing during allocation.
    expect(await f.balance(CARRIER)).toBe(0n);
    // Exactly the winning amount stays escrowed for this tender.
    expect(await f.tenderBalance()).toBe(WINNING);
    expect(await f.totalEscrowed()).toBe(WINNING);
    expect(await f.balance(f.evm.address)).toBe(WINNING);
    expect(await f.balance(SHIPPER)).toBe(shipperBefore + EXCESS);
  });

  it("allocating the full budget refunds no excess", async () => {
    const f = await funded();
    const outcome = await f.allocate({ winningAmount: BUDGET });
    expect(outcome.ok).toBe(true);
    expect(f.evm.decodeEvents(outcome).map((e) => e.name)).toEqual([
      "WinnerAllocated",
    ]);
    expect(await f.tenderBalance()).toBe(BUDGET);
    expect(await f.balance(CARRIER)).toBe(0n);
  });

  it("non-operator allocation fails", async () => {
    const f = await funded();
    const outcome = await f.allocate({ from: OUTSIDER });
    expect(outcome.ok).toBe(false);
    expect(outcome.errorName).toBe("OwnableUnauthorizedAccount");
    expect(await f.state()).toBe(STATE.FUNDED);
  });

  it("allocation before funding fails", async () => {
    const f = await deployEscrow();
    await f.register();
    const outcome = await f.allocate();
    expect(outcome.ok).toBe(false);
    expect(outcome.errorName).toBe("InvalidState");
  });

  it("zero winner, zero amount, and zero manifest hash fail", async () => {
    const f = await funded();
    expect((await f.allocate({ winner: ZERO_ADDRESS })).errorName).toBe(
      "ZeroAddressNotAllowed",
    );
    expect((await f.allocate({ winningAmount: 0n })).errorName).toBe(
      "ZeroAmountNotAllowed",
    );
    expect(
      (await f.allocate({ decisionManifestHash: ZERO_HASH })).errorName,
    ).toBe("ZeroHashNotAllowed");
    expect(await f.state()).toBe(STATE.FUNDED);
  });

  it("a winning amount above the funded budget fails", async () => {
    const f = await funded();
    const outcome = await f.allocate({ winningAmount: BUDGET + 1n });
    expect(outcome.ok).toBe(false);
    expect(outcome.errorName).toBe("WinningAmountExceedsBudget");
    expect(await f.tenderBalance()).toBe(BUDGET);
  });

  it("duplicate allocation fails", async () => {
    const f = await funded();
    expect((await f.allocate()).ok).toBe(true);
    const second = await f.allocate({
      allocationAuthHash: authHash("allocate-2"),
    });
    expect(second.ok).toBe(false);
    expect(second.errorName).toBe("InvalidState");
    expect(await f.tenderBalance()).toBe(WINNING);
  });
});

describe("freight escrow — no-qualified-bid refund", () => {
  async function funded() {
    const f = await deployEscrow();
    await f.register();
    await f.fund();
    return f;
  }

  it("returns the entire funded budget to the shipper", async () => {
    const f = await funded();
    const before = await f.balance(SHIPPER);

    const outcome = await f.evm.send(OPERATOR, "refundNoQualifiedBid", [
      f.tenderKey,
      authHash("no-bid-1"),
    ]);
    expect(outcome.ok).toBe(true);
    expect(await f.state()).toBe(STATE.REFUNDED);
    expect(await f.balance(SHIPPER)).toBe(before + BUDGET);
    expect(await f.tenderBalance()).toBe(0n);
    expect(await f.totalEscrowed()).toBe(0n);

    const events = f.evm.decodeEvents(outcome);
    expect(events.map((e) => e.name)).toEqual(["NoWinnerRefunded"]);
    expect(events[0]!.args.amount).toBe(BUDGET);
  });

  it("a non-operator cannot trigger the refund", async () => {
    const f = await funded();
    const outcome = await f.evm.send(SHIPPER, "refundNoQualifiedBid", [
      f.tenderKey,
      authHash("no-bid-2"),
    ]);
    expect(outcome.ok).toBe(false);
    expect(outcome.errorName).toBe("OwnableUnauthorizedAccount");
  });

  it("duplicate refund fails and allocation after refund is impossible", async () => {
    const f = await funded();
    await f.evm.send(OPERATOR, "refundNoQualifiedBid", [
      f.tenderKey,
      authHash("no-bid-1"),
    ]);

    const duplicate = await f.evm.send(OPERATOR, "refundNoQualifiedBid", [
      f.tenderKey,
      authHash("no-bid-3"),
    ]);
    expect(duplicate.ok).toBe(false);
    expect(duplicate.errorName).toBe("InvalidState");

    const allocation = await f.allocate();
    expect(allocation.ok).toBe(false);
    expect(allocation.errorName).toBe("InvalidState");
    expect(await f.state()).toBe(STATE.REFUNDED);
  });

  it("the terminal refunded state cannot be escaped", async () => {
    const f = await funded();
    await f.evm.send(OPERATOR, "refundNoQualifiedBid", [
      f.tenderKey,
      authHash("no-bid-1"),
    ]);

    for (const [fn, args] of [
      ["fundTender", [f.tenderKey, BUDGET]],
      ["releaseFull", [f.tenderKey, authHash("x1")]],
      ["openDispute", [f.tenderKey, authHash("x2")]],
      ["refundFull", [f.tenderKey, authHash("x3")]],
      ["resolveDisputeRelease", [f.tenderKey, authHash("x4")]],
      ["partialRelease", [f.tenderKey, 1n, 0n, authHash("x5")]],
    ] as const) {
      const outcome = await f.evm.send(OPERATOR, fn, args as readonly unknown[]);
      expect(outcome.ok, `${fn} must fail`).toBe(false);
    }
    expect(await f.state()).toBe(STATE.REFUNDED);
    expect(await f.balance(f.evm.address)).toBe(0n);
  });
});
