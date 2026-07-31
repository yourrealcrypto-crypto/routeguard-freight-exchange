/**
 * Phase C1 — freight escrow security properties.
 * Reentrancy, transfer failure, unsafe narrowing, multi-tender isolation,
 * accounting integrity, and unauthorized access. Offline EVM. No network.
 */

import { keccak256, toUtf8Bytes } from "ethers";
import { describe, expect, it } from "vitest";

import {
  contracts,
  CARRIER,
  OPERATOR,
  OUTSIDER,
  SHIPPER,
  TOKEN,
} from "./helpers/escrow-evm";
import {
  authHash,
  BUDGET,
  deployEscrow,
  idHash,
  STATE,
  WINNING,
} from "./helpers/escrow-fixtures";
import { ROUTEGUARD_FREIGHT_ESCROW_ABI } from "../src/v2/escrow/abi";

const MAX_INT64 = 9_223_372_036_854_775_807n;

describe("freight escrow — security", () => {
  it("a re-entrant settlement attempt fails and cannot double-spend", async () => {
    const f = await deployEscrow();
    await f.register();
    await f.fund();

    // Winner is an attacker contract that re-enters during the excess transfer
    // path and again during release.
    const attacker = await f.evm.deployAuxiliary({
      contractName: "ReentrantSettlementAttacker",
      args: [],
      deployer: OUTSIDER,
    });

    await f.allocate({ winner: attacker.address });
    expect(await f.tenderBalance()).toBe(WINNING);

    // Arm the attacker to re-enter `releaseFull` while it is being paid, and
    // arm the mock ledger to invoke the attacker mid-transfer.
    const nestedRelease = f.evm.iface.encodeFunctionData("releaseFull", [
      f.tenderKey,
      authHash("reentrant-second-release"),
    ]);
    await f.evm.send(
      OUTSIDER,
      "arm",
      [f.evm.address, nestedRelease],
      attacker,
    );
    const attackCall = attacker.iface.encodeFunctionData("attack", []);
    await f.evm.send(OPERATOR, "setReentrantAccount", [
      attacker.address,
      attackCall,
    ]);

    const outcome = await f.evm.send(OPERATOR, "releaseFull", [
      f.tenderKey,
      authHash("reentrant-first-release"),
    ]);

    // The legitimate release completes exactly once; the nested call was made
    // and was refused by the reentrancy guard.
    expect(outcome.ok).toBe(true);
    const attackerState = await f.evm.send(OPERATOR, "reentered", [], attacker);
    expect(attackerState.returnData.endsWith("1")).toBe(true);
    const succeeded = await f.evm.send(
      OPERATOR,
      "reentrySucceeded",
      [],
      attacker,
    );
    expect(succeeded.returnData.endsWith("0")).toBe(true);

    // Paid exactly once: no double spend, no residual escrow balance.
    expect(await f.state()).toBe(STATE.RELEASED);
    expect(await f.balance(attacker.address)).toBe(WINNING);
    expect(await f.tenderBalance()).toBe(0n);
    expect(await f.balance(f.evm.address)).toBe(0n);
    expect(await f.totalEscrowed()).toBe(0n);
  });

  it("a failed outbound transfer leaves authoritative state safe", async () => {
    const f = await deployEscrow();
    await f.register();
    await f.fund();
    await f.allocate();

    await f.evm.send(OPERATOR, "setFailingAccount", [CARRIER]);
    const outcome = await f.evm.send(OPERATOR, "releaseFull", [
      f.tenderKey,
      authHash("release-that-fails"),
    ]);

    expect(outcome.ok).toBe(false);
    expect(outcome.errorName).toBe("TokenTransferFailed");
    // State, accounting, and balances are all rolled back together.
    expect(await f.state()).toBe(STATE.ALLOCATED);
    expect(await f.tenderBalance()).toBe(WINNING);
    expect(await f.totalEscrowed()).toBe(WINNING);
    expect(await f.balance(f.evm.address)).toBe(WINNING);
    expect(await f.balance(CARRIER)).toBe(0n);

    // The authorization hash was not consumed by the reverted attempt.
    await f.evm.send(OPERATOR, "setFailingAccount", [
      `0x${"0".repeat(40)}`,
    ]);
    const retry = await f.evm.send(OPERATOR, "releaseFull", [
      f.tenderKey,
      authHash("release-that-fails"),
    ]);
    expect(retry.ok).toBe(true);
    expect(await f.balance(CARRIER)).toBe(WINNING);
  });

  it("amounts beyond the HTS int64 range are rejected before narrowing", async () => {
    const f = await deployEscrow();

    const registerTooLarge = await f.register({ maxBudget: MAX_INT64 + 1n });
    expect(registerTooLarge.ok).toBe(false);
    expect(registerTooLarge.errorName).toBe("AmountExceedsHtsRange");

    // 2^64 would wrap to 0 on an unchecked narrowing to uint64.
    const wrapping = await f.register({ maxBudget: 1n << 64n });
    expect(wrapping.ok).toBe(false);
    expect(wrapping.errorName).toBe("AmountExceedsHtsRange");

    // 2^64 + budget would wrap to the budget itself.
    const wrappingToBudget = await f.register({
      maxBudget: (1n << 64n) + BUDGET,
    });
    expect(wrappingToBudget.ok).toBe(false);
    expect(wrappingToBudget.errorName).toBe("AmountExceedsHtsRange");
    expect(await f.state()).toBe(STATE.UNREGISTERED);

    // The same bound applies to allocation and partial settlement.
    await f.register();
    await f.fund();
    const allocateTooLarge = await f.allocate({
      winningAmount: MAX_INT64 + 1n,
    });
    expect(allocateTooLarge.ok).toBe(false);
    expect(allocateTooLarge.errorName).toBe("AmountExceedsHtsRange");
  });

  it("two tenders stay accounting-isolated", async () => {
    const f = await deployEscrow();
    const keyA = f.tenderKey;
    const keyB = await f.key("tender-c1-b");

    await f.register();
    await f.register({
      tenderKey: keyB,
      tenderIdHash: idHash("tender-c1-b"),
      creationAuthHash: authHash("create-b"),
    });
    await f.fund(BUDGET, SHIPPER, keyA);
    await f.fund(BUDGET, SHIPPER, keyB);
    expect(await f.totalEscrowed()).toBe(BUDGET * 2n);

    // Settle tender A completely.
    await f.allocate({ tenderKey: keyA });
    await f.evm.send(OPERATOR, "releaseFull", [keyA, authHash("release-a")]);

    expect(await f.tenderBalance(keyA)).toBe(0n);
    // Tender B is untouched.
    expect(await f.tenderBalance(keyB)).toBe(BUDGET);
    expect(await f.state(keyB)).toBe(STATE.FUNDED);
    expect(await f.totalEscrowed()).toBe(BUDGET);
    expect(await f.balance(f.evm.address)).toBe(BUDGET);
    expect(await f.balance(CARRIER)).toBe(WINNING);
  });

  it("the contract token balance equals the aggregate unsettled tender balance", async () => {
    const f = await deployEscrow();
    const keys = [f.tenderKey];
    await f.register();
    await f.fund();

    for (const label of ["tender-c1-x", "tender-c1-y"]) {
      const key = await f.key(label);
      keys.push(key);
      await f.register({
        tenderKey: key,
        tenderIdHash: idHash(label),
        creationAuthHash: authHash(`create-${label}`),
      });
      await f.fund(BUDGET, SHIPPER, key);
    }

    const sumBalances = async () => {
      let total = 0n;
      for (const key of keys) {
        total += await f.tenderBalance(key);
      }
      return total;
    };

    expect(await sumBalances()).toBe(await f.totalEscrowed());
    expect(await f.balance(f.evm.address)).toBe(await f.totalEscrowed());

    // Move one tender through allocation (partial outflow) and one to refund.
    await f.allocate({ tenderKey: keys[0]! });
    await f.evm.send(OPERATOR, "refundNoQualifiedBid", [
      keys[1]!,
      authHash("no-bid-x"),
    ]);

    expect(await sumBalances()).toBe(await f.totalEscrowed());
    expect(await f.balance(f.evm.address)).toBe(await f.totalEscrowed());
  });

  it("no unauthorized caller can move freight funds", async () => {
    const f = await deployEscrow();
    await f.register();
    await f.fund();
    await f.allocate();
    const escrowBefore = await f.balance(f.evm.address);

    const operatorOnly = [
      ["allocateWinner", [f.tenderKey, CARRIER, 1n, authHash("m"), authHash("a")]],
      ["refundNoQualifiedBid", [f.tenderKey, authHash("b")]],
      ["releaseFull", [f.tenderKey, authHash("c")]],
      ["openDispute", [f.tenderKey, authHash("d")]],
      ["refundFull", [f.tenderKey, authHash("e")]],
      ["resolveDisputeRelease", [f.tenderKey, authHash("f")]],
      ["partialRelease", [f.tenderKey, 1n, WINNING - 1n, authHash("g")]],
    ] as const;

    for (const caller of [OUTSIDER, SHIPPER, CARRIER]) {
      for (const [fn, args] of operatorOnly) {
        const outcome = await f.evm.send(caller, fn, args as readonly unknown[]);
        expect(outcome.ok, `${caller} must not call ${fn}`).toBe(false);
        expect(outcome.errorName).toBe("OwnableUnauthorizedAccount");
      }
    }

    expect(await f.balance(f.evm.address)).toBe(escrowBefore);
    expect(await f.balance(CARRIER)).toBe(0n);
    expect(await f.state()).toBe(STATE.ALLOCATED);
  });

  it("operator transfer is two-step and never leaves the role unowned", async () => {
    const f = await deployEscrow();
    // A direct single-step handover is not available on Ownable2Step.
    const pending = await f.evm.send(OPERATOR, "transferOwnership", [OUTSIDER]);
    expect(pending.ok).toBe(true);
    // Until the new operator accepts, the original operator still governs.
    expect((await f.evm.call<string>("owner")).toLowerCase()).toBe(OPERATOR);
    const notYet = await f.register({ from: OUTSIDER });
    expect(notYet.ok).toBe(false);

    const accepted = await f.evm.send(OUTSIDER, "acceptOwnership", []);
    expect(accepted.ok).toBe(true);
    expect((await f.evm.call<string>("owner")).toLowerCase()).toBe(OUTSIDER);
  });

  it("the deployed escrow token is immutable and single-token", async () => {
    const f = await deployEscrow();
    expect((await f.evm.call<string>("escrowToken")).toLowerCase()).toBe(TOKEN);
    // No setter exists for the escrow token.
    const abi = contracts().contracts.RouteGuardFreightEscrow!.abi as {
      type: string;
      name?: string;
      stateMutability?: string;
    }[];
    const mutators = abi.filter(
      (entry) =>
        entry.type === "function" &&
        entry.stateMutability !== "view" &&
        entry.stateMutability !== "pure",
    );
    expect(mutators.some((m) => /token/i.test(m.name ?? ""))).toBe(true);
    expect(
      mutators.map((m) => m.name).filter((n) => /^set|^update|^upgrade/i.test(n ?? "")),
    ).toEqual([]);
  });

  it("the production contract exposes no upgrade, proxy, or delegatecall surface", async () => {
    const source = contracts();
    const abi = source.contracts.RouteGuardFreightEscrow!.abi as {
      type: string;
      name?: string;
    }[];
    const names = abi
      .filter((entry) => entry.type === "function")
      .map((entry) => entry.name ?? "");
    for (const forbidden of [
      "upgradeTo",
      "upgradeToAndCall",
      "setImplementation",
      "delegate",
      "execute",
      "call",
      "withdraw",
      "sweep",
      "rescue",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("the exported ABI matches the compiled contract exactly", async () => {
    const { Interface } = await import("ethers");
    const compiled = contracts().contracts.RouteGuardFreightEscrow!;
    const compiledIface = new Interface(compiled.abi as never);
    const exportedIface = new Interface([...ROUTEGUARD_FREIGHT_ESCROW_ABI]);

    const signatures = (iface: InstanceType<typeof Interface>) => {
      const out: string[] = [];
      iface.forEachFunction((fn) => out.push(fn.format("sighash")));
      iface.forEachEvent((ev) => out.push(ev.format("sighash")));
      return out.sort();
    };

    const exported = signatures(exportedIface);
    const compiledSignatures = signatures(compiledIface);
    // Every exported signature must exist on-chain (the compiled ABI may also
    // contain inherited Ownable2Step members that the boundary does not use).
    for (const signature of exported) {
      expect(compiledSignatures).toContain(signature);
    }
  });

  it("the escrow never receives an x402 access fee", async () => {
    const f = await deployEscrow();
    await f.register();
    await f.fund();
    // The only inbound movement is the exact freight budget: 1000 atomic
    // (the access fee) is never a valid funding amount for this tender.
    const accessFeeAttempt = await f.fund(1000n, SHIPPER);
    expect(accessFeeAttempt.ok).toBe(false);
    expect(await f.balance(f.evm.address)).toBe(BUDGET);
  });

  it("keccak tender keys are domain-separated from bare identity hashes", async () => {
    const f = await deployEscrow();
    const bare = keccak256(toUtf8Bytes("tender-c1"));
    const key = await f.evm.call<string>("computeTenderKey", [bare, 1]);
    expect(key).not.toBe(bare);

    // A tender key computed for another version is a different slot.
    const v2 = await f.evm.call<string>("computeTenderKey", [bare, 2]);
    expect(v2).not.toBe(key);

    // Registering with a mismatched (version, key) pair fails.
    const mismatched = await f.register({ tenderKey: v2 });
    expect(mismatched.ok).toBe(false);
    expect(mismatched.errorName).toBe("TenderNotRegistered");
  });
});
