/**
 * Phase C1 — TypeScript freight-escrow boundary.
 * Pure builders and parsers: no signing, no submission, no network.
 */

import { keccak256, toUtf8Bytes } from "ethers";
import { describe, expect, it } from "vitest";

import { deriveAccessFeeAtomic } from "../src/v2/access/fee";
import {
  assertNonNegativeEscrowAmount,
  assertPartialConservation,
  assertPositiveEscrowAmount,
  buildAllocateWinnerPlan,
  buildFundTenderPlan,
  buildNoQualifiedBidRefundPlan,
  buildOpenDisputePlan,
  buildPartialReleasePlan,
  buildRefundFullPlan,
  buildRegisterTenderPlan,
  buildReleaseFullPlan,
  buildResolveDisputeReleasePlan,
  deriveExcessRefundAtomic,
  ESCROW_STATES,
  ESCROW_TENDER_KEY_DOMAIN,
  EscrowAmountError,
  escrowOperationForLifecycleState,
  escrowOperationForRefereeResolution,
  escrowStateFromOrdinal,
  escrowTenderKey,
  EscrowIdentityError,
  hederaAccountToEvmAddress,
  isEscrowTerminalState,
  MAX_HTS_ATOMIC_AMOUNT,
  parseEscrowEvent,
  parseEscrowEvents,
  parseEscrowExecutionResult,
  parseEscrowStateResult,
  requiredEscrowStateFor,
  sha256HashToBytes32,
  tenderIdHash,
} from "../src/v2/escrow";
import { EscrowEvm, OPERATOR, TOKEN } from "./helpers/escrow-evm";

const SHIPPER_ADDRESS = "0x00000000000000000000000000000000008c5cd9";
const WINNER_ADDRESS = "0x00000000000000000000000000000000008ca2d2";
const BUDGET = "1000000";
const WINNING = "700000";
const AUTH = keccak256(toUtf8Bytes("auth-1"));
const MANIFEST = keccak256(toUtf8Bytes("decision-manifest"));

describe("escrow tender-key derivation", () => {
  it("is deterministic", () => {
    const a = escrowTenderKey("tender-c1", 1);
    const b = escrowTenderKey("tender-c1", 1);
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("different tender versions produce different keys", () => {
    const v1 = escrowTenderKey("tender-c1", 1);
    const v2 = escrowTenderKey("tender-c1", 2);
    const v3 = escrowTenderKey("tender-c1", 3);
    expect(new Set([v1, v2, v3]).size).toBe(3);
  });

  it("different tender ids produce different keys", () => {
    expect(escrowTenderKey("tender-a", 1)).not.toBe(
      escrowTenderKey("tender-b", 1),
    );
  });

  it("domain separation prevents unrelated hash reuse", () => {
    const bare = tenderIdHash("tender-c1");
    const key = escrowTenderKey("tender-c1", 1);
    expect(key).not.toBe(bare);
    expect(key).not.toBe(ESCROW_TENDER_KEY_DOMAIN);
    // A hash of the same logical content without the domain separator differs.
    const naive = keccak256(toUtf8Bytes("tender-c1:1"));
    expect(key).not.toBe(naive);
  });

  it("matches the on-chain derivation exactly", async () => {
    const evm = await EscrowEvm.deploy({
      contractName: "MockLedgerFreightEscrow",
      args: [TOKEN, OPERATOR],
      deployer: OPERATOR,
    });
    expect(await evm.call<string>("TENDER_KEY_DOMAIN")).toBe(
      ESCROW_TENDER_KEY_DOMAIN,
    );
    for (const [tenderId, version] of [
      ["tender-c1", 1],
      ["tender-c1", 7],
      ["another-tender", 3],
    ] as const) {
      const onChain = await evm.call<string>("computeTenderKey", [
        tenderIdHash(tenderId),
        version,
      ]);
      expect(onChain).toBe(escrowTenderKey(tenderId, version));
    }
  });

  it("rejects invalid identities", () => {
    expect(() => escrowTenderKey("", 1)).toThrowError(EscrowIdentityError);
    expect(() => escrowTenderKey("t", 0)).toThrowError(EscrowIdentityError);
    expect(() => escrowTenderKey("t", 1.5)).toThrowError(EscrowIdentityError);
    expect(() => escrowTenderKey("t", -1)).toThrowError(EscrowIdentityError);
  });

  it("converts Hedera account ids to long-zero EVM addresses", () => {
    expect(hederaAccountToEvmAddress("0.0.9197513")).toBe(
      `0x${(9197513).toString(16).padStart(40, "0")}`,
    );
    expect(() => hederaAccountToEvmAddress("0.0.0")).toThrowError(
      EscrowIdentityError,
    );
    expect(() => hederaAccountToEvmAddress("not-an-account")).toThrowError(
      EscrowIdentityError,
    );
  });

  it("converts canonical sha256 evidence hashes to bytes32", () => {
    const hash = `sha256:${"a".repeat(64)}`;
    expect(sha256HashToBytes32(hash)).toBe(`0x${"a".repeat(64)}`);
    expect(() => sha256HashToBytes32("sha256:zz")).toThrowError(
      EscrowIdentityError,
    );
  });
});

describe("escrow money validation", () => {
  it("rejects invalid atomic strings", () => {
    for (const bad of ["", "1.5", "-1", "1e6", " 100", "0100", "abc", "0x10"]) {
      expect(() => assertPositiveEscrowAmount(bad), bad).toThrowError(
        EscrowAmountError,
      );
    }
    expect(() => assertPositiveEscrowAmount("0")).toThrowError(EscrowAmountError);
    expect(assertNonNegativeEscrowAmount("0")).toBe(0n);
  });

  it("rejects amounts beyond the HTS int64 range", () => {
    expect(assertPositiveEscrowAmount(MAX_HTS_ATOMIC_AMOUNT.toString())).toBe(
      MAX_HTS_ATOMIC_AMOUNT,
    );
    expect(() =>
      assertPositiveEscrowAmount((MAX_HTS_ATOMIC_AMOUNT + 1n).toString()),
    ).toThrowError(EscrowAmountError);
  });

  it("derives and enforces allocation conservation", () => {
    expect(deriveExcessRefundAtomic(BUDGET, WINNING)).toBe("300000");
    expect(deriveExcessRefundAtomic(BUDGET, BUDGET)).toBe("0");
    expect(() => deriveExcessRefundAtomic(WINNING, BUDGET)).toThrowError(
      EscrowAmountError,
    );
  });

  it("enforces partial-settlement conservation", () => {
    expect(() =>
      assertPartialConservation({
        lockedAmountAtomic: WINNING,
        winnerAmountAtomic: "400000",
        shipperAmountAtomic: "300000",
      }),
    ).not.toThrow();
    for (const [w, s] of [
      ["400000", "299999"],
      ["700001", "0"],
      ["0", "0"],
    ] as const) {
      expect(() =>
        assertPartialConservation({
          lockedAmountAtomic: WINNING,
          winnerAmountAtomic: w,
          shipperAmountAtomic: s,
        }),
      ).toThrowError(EscrowAmountError);
    }
  });
});

describe("escrow transaction-plan builders", () => {
  const registerInput = {
    tenderId: "tender-c1",
    tenderVersion: 1,
    shipperAddress: SHIPPER_ADDRESS,
    maximumFreightBudgetAtomic: BUDGET,
    escrowTokenAddress: TOKEN,
    creationAuthorizationHash: AUTH,
  };

  it("builds a registration plan bound to the canonical tender key", () => {
    const plan = buildRegisterTenderPlan(registerInput);
    expect(plan.operation).toBe("REGISTER_TENDER");
    expect(plan.signerRole).toBe("OPERATOR");
    expect(plan.tenderKey).toBe(escrowTenderKey("tender-c1", 1));
    expect(plan.functionSignature).toBe(
      "registerTender(bytes32,bytes32,uint32,address,uint256,address,bytes32,bytes32)",
    );
    expect(plan.args[4]).toEqual({ type: "uint256", value: BUDGET });
    expect(plan.networkWrite).toBe(true);
  });

  it("funding uses the exact budget and is shipper-signed", () => {
    const plan = buildFundTenderPlan({
      tenderId: "tender-c1",
      tenderVersion: 1,
      maximumFreightBudgetAtomic: BUDGET,
    });
    expect(plan.signerRole).toBe("SHIPPER");
    expect(plan.args[1]).toEqual({ type: "uint256", value: BUDGET });
  });

  it("allocation derives the exact excess refund", () => {
    const { plan, excessRefundAtomic } = buildAllocateWinnerPlan({
      tenderId: "tender-c1",
      tenderVersion: 1,
      winnerAddress: WINNER_ADDRESS,
      fundedAmountAtomic: BUDGET,
      winningAmountAtomic: WINNING,
      decisionManifestHash: MANIFEST,
      allocationAuthorizationHash: AUTH,
    });
    expect(excessRefundAtomic).toBe("300000");
    expect(BigInt(WINNING) + BigInt(excessRefundAtomic)).toBe(BigInt(BUDGET));
    expect(plan.operation).toBe("ALLOCATE_WINNER");
    expect(plan.signerRole).toBe("OPERATOR");
  });

  it("rejects a winning amount above the funded budget", () => {
    expect(() =>
      buildAllocateWinnerPlan({
        tenderId: "tender-c1",
        tenderVersion: 1,
        winnerAddress: WINNER_ADDRESS,
        fundedAmountAtomic: BUDGET,
        winningAmountAtomic: "1000001",
        decisionManifestHash: MANIFEST,
        allocationAuthorizationHash: AUTH,
      }),
    ).toThrowError(EscrowAmountError);
  });

  it("rejects zero addresses and zero authorization hashes", () => {
    expect(() =>
      buildRegisterTenderPlan({
        ...registerInput,
        shipperAddress: `0x${"0".repeat(40)}`,
      }),
    ).toThrowError(EscrowIdentityError);
    expect(() =>
      buildRegisterTenderPlan({
        ...registerInput,
        creationAuthorizationHash: `0x${"0".repeat(64)}`,
      }),
    ).toThrowError(EscrowIdentityError);
    expect(() =>
      buildReleaseFullPlan({
        tenderId: "tender-c1",
        tenderVersion: 1,
        authorizationHash: `0x${"0".repeat(64)}`,
      }),
    ).toThrowError(EscrowIdentityError);
  });

  it("never emits a floating-point or JS-number money value", () => {
    const plans = [
      buildRegisterTenderPlan(registerInput),
      buildFundTenderPlan({
        tenderId: "tender-c1",
        tenderVersion: 1,
        maximumFreightBudgetAtomic: BUDGET,
      }),
      buildAllocateWinnerPlan({
        tenderId: "tender-c1",
        tenderVersion: 1,
        winnerAddress: WINNER_ADDRESS,
        fundedAmountAtomic: BUDGET,
        winningAmountAtomic: WINNING,
        decisionManifestHash: MANIFEST,
        allocationAuthorizationHash: AUTH,
      }).plan,
      buildNoQualifiedBidRefundPlan({
        tenderId: "tender-c1",
        tenderVersion: 1,
        authorizationHash: AUTH,
      }),
      buildReleaseFullPlan({
        tenderId: "tender-c1",
        tenderVersion: 1,
        authorizationHash: AUTH,
      }),
      buildOpenDisputePlan({
        tenderId: "tender-c1",
        tenderVersion: 1,
        authorizationHash: AUTH,
      }),
      buildResolveDisputeReleasePlan({
        tenderId: "tender-c1",
        tenderVersion: 1,
        authorizationHash: AUTH,
      }),
      buildRefundFullPlan({
        tenderId: "tender-c1",
        tenderVersion: 1,
        authorizationHash: AUTH,
      }),
      buildPartialReleasePlan({
        tenderId: "tender-c1",
        tenderVersion: 1,
        lockedAmountAtomic: WINNING,
        winnerAmountAtomic: "400000",
        shipperAmountAtomic: "300000",
        refereeAuthorizationHash: AUTH,
      }),
    ];

    for (const plan of plans) {
      for (const arg of plan.args) {
        if (arg.type === "uint256") {
          expect(typeof arg.value).toBe("string");
          expect(arg.value).toMatch(/^(0|[1-9]\d*)$/);
        }
        if (arg.type === "uint32") {
          expect(Number.isInteger(arg.value)).toBe(true);
        }
      }
      expect(JSON.stringify(plan)).not.toMatch(/\d+\.\d+/);
    }
  });

  it("covers every escrow operation", () => {
    const operations = new Set([
      buildRegisterTenderPlan(registerInput).operation,
      buildFundTenderPlan({
        tenderId: "t",
        tenderVersion: 1,
        maximumFreightBudgetAtomic: BUDGET,
      }).operation,
      buildAllocateWinnerPlan({
        tenderId: "t",
        tenderVersion: 1,
        winnerAddress: WINNER_ADDRESS,
        fundedAmountAtomic: BUDGET,
        winningAmountAtomic: WINNING,
        decisionManifestHash: MANIFEST,
        allocationAuthorizationHash: AUTH,
      }).plan.operation,
      buildNoQualifiedBidRefundPlan({
        tenderId: "t",
        tenderVersion: 1,
        authorizationHash: AUTH,
      }).operation,
      buildReleaseFullPlan({
        tenderId: "t",
        tenderVersion: 1,
        authorizationHash: AUTH,
      }).operation,
      buildOpenDisputePlan({
        tenderId: "t",
        tenderVersion: 1,
        authorizationHash: AUTH,
      }).operation,
      buildResolveDisputeReleasePlan({
        tenderId: "t",
        tenderVersion: 1,
        authorizationHash: AUTH,
      }).operation,
      buildRefundFullPlan({
        tenderId: "t",
        tenderVersion: 1,
        authorizationHash: AUTH,
      }).operation,
      buildPartialReleasePlan({
        tenderId: "t",
        tenderVersion: 1,
        lockedAmountAtomic: WINNING,
        winnerAmountAtomic: "400000",
        shipperAmountAtomic: "300000",
        refereeAuthorizationHash: AUTH,
      }).operation,
    ]);
    expect(operations.size).toBe(9);
  });
});

describe("escrow lifecycle mapping", () => {
  it("maps lifecycle states to escrow operations", () => {
    expect(escrowOperationForLifecycleState("DRAFT")).toBe("REGISTER_TENDER");
    expect(escrowOperationForLifecycleState("WINNER_SELECTED")).toBe(
      "ALLOCATE_WINNER",
    );
    expect(escrowOperationForLifecycleState("NO_QUALIFIED_BID")).toBe(
      "REFUND_NO_QUALIFIED_BID",
    );
    expect(escrowOperationForLifecycleState("POD_ACCEPTED")).toBe("RELEASE_FULL");
    expect(escrowOperationForLifecycleState("POD_DEEMED_ACCEPTED")).toBe(
      "RELEASE_FULL",
    );
    expect(escrowOperationForLifecycleState("POD_DISPUTED")).toBe("OPEN_DISPUTE");
    expect(escrowOperationForLifecycleState("BIDDING")).toBeNull();
  });

  it("requires confirmed escrow state before dependent lifecycle states", () => {
    expect(requiredEscrowStateFor("ESCROW_FUNDED")).toBe("FUNDED");
    expect(requiredEscrowStateFor("WINNING_AMOUNT_LOCKED")).toBe("ALLOCATED");
    expect(requiredEscrowStateFor("ROUTE_RESERVED")).toBe("ALLOCATED");
    expect(requiredEscrowStateFor("DRAFT")).toBeNull();
  });

  it("maps referee resolutions to settlement operations", () => {
    expect(escrowOperationForRefereeResolution("RELEASE_FULL")).toBe(
      "RESOLVE_DISPUTE_RELEASE",
    );
    expect(escrowOperationForRefereeResolution("REFUND_FULL")).toBe(
      "REFUND_FULL",
    );
    expect(escrowOperationForRefereeResolution("PARTIAL")).toBe(
      "PARTIAL_RELEASE",
    );
  });

  it("mirrors the on-chain state enum ordinals", () => {
    expect(ESCROW_STATES).toEqual([
      "UNREGISTERED",
      "REGISTERED",
      "FUNDED",
      "ALLOCATED",
      "DISPUTED",
      "RELEASED",
      "REFUNDED",
      "PARTIALLY_RELEASED",
    ]);
    expect(escrowStateFromOrdinal(3n)).toBe("ALLOCATED");
    expect(parseEscrowStateResult(6)).toBe("REFUNDED");
    expect(parseEscrowStateResult("0x07")).toBe("PARTIALLY_RELEASED");
    expect(isEscrowTerminalState("RELEASED")).toBe(true);
    expect(isEscrowTerminalState("ALLOCATED")).toBe(false);
    expect(() => escrowStateFromOrdinal(99)).toThrow();
  });
});

describe("escrow event and result parsing", () => {
  /** Build a real log by running the contract, then parse it publicly. */
  async function realLogs() {
    const { deployEscrow, authHash } = await import("./helpers/escrow-fixtures");
    const f = await deployEscrow();
    await f.register();
    await f.fund();
    const allocation = await f.allocate();
    const release = await f.evm.send(OPERATOR, "releaseFull", [
      f.tenderKey,
      authHash("pod-accept"),
    ]);
    return { allocation, release, f };
  }

  it("exposes only public-safe fields", async () => {
    const { allocation } = await realLogs();
    const events = parseEscrowEvents(allocation.logs);
    expect(events.map((e) => e.name)).toEqual([
      "WinnerAllocated",
      "ExcessRefunded",
    ]);

    const allowed = new Set([
      "tenderKey",
      "tenderIdHash",
      "tenderVersion",
      "shipper",
      "winner",
      "token",
      "maxBudget",
      "fundedAmount",
      "winningAmount",
      "excessAmount",
      "amount",
      "winnerAmount",
      "shipperAmount",
      "decisionManifestHash",
      "allocationAuthHash",
      "authorizationHash",
      "creationAuthHash",
      "manifestHash",
      "disputeAuthHash",
      "fromDispute",
    ]);
    for (const event of events) {
      for (const field of Object.keys(event.fields)) {
        expect(allowed.has(field), `${event.name}.${field}`).toBe(true);
      }
      // The allowlist above already bounds the field set; this asserts no
      // private-data field ever reaches the parsed payload.
      const serializedFields = JSON.stringify(event.fields).toLowerCase();
      for (const forbidden of [
        "podid",
        "salt",
        "signature",
        "narrative",
        "fullname",
        "postaladdress",
        "phone",
        "privatekey",
        "plaintext",
      ]) {
        expect(serializedFields, `${event.name}:${forbidden}`).not.toContain(
          forbidden,
        );
      }
    }

    const allocated = events[0]!;
    expect(allocated.fields.winningAmount).toBe("700000");
    expect(typeof allocated.fields.winningAmount).toBe("string");
    expect(allocated.fields.excessAmount).toBe("300000");
  });

  it("ignores unrelated logs", () => {
    expect(
      parseEscrowEvent({ topics: [keccak256(toUtf8Bytes("Unrelated()"))], data: "0x" }),
    ).toBeNull();
    expect(parseEscrowEvent({ topics: [], data: "0x" })).toBeNull();
  });

  it("parses execution results without leaking raw revert payloads", () => {
    const success = parseEscrowExecutionResult({
      status: "SUCCESS",
      transactionId: "0.0.9197513@1785519911.424021609",
      contractId: "0.0.1234567",
      logs: [],
    });
    expect(success.status).toBe("SUCCESS");
    expect(success.errorName).toBeNull();

    const failure = parseEscrowExecutionResult({
      status: "CONTRACT_REVERT_EXECUTED",
      transactionId: null,
      errorMessage: "x".repeat(500),
    });
    expect(failure.status).toBe("FAILED");
    expect(failure.errorName!.length).toBeLessThanOrEqual(64);
    expect(failure.events).toEqual([]);
  });

  it("the freight principal is never the x402 access fee", () => {
    // The access fee is a fixed 1000 atomic product price to the treasury; the
    // freight budget is an independent escrow amount.
    expect(deriveAccessFeeAtomic()).toBe("1000");
    expect(BUDGET).not.toBe(deriveAccessFeeAtomic());
    const plan = buildFundTenderPlan({
      tenderId: "tender-c1",
      tenderVersion: 1,
      maximumFreightBudgetAtomic: BUDGET,
    });
    expect(plan.args[1]!.value).toBe(BUDGET);
  });
});

describe("escrow boundary performs no network access", () => {
  it("builds and parses with fetch disabled", async () => {
    const originalFetch = globalThis.fetch;
    const attempts: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      attempts.push(String(input));
      throw new Error("network access is forbidden in Phase C1");
    }) as typeof globalThis.fetch;

    try {
      const plan = buildRegisterTenderPlan({
        tenderId: "tender-c1",
        tenderVersion: 1,
        shipperAddress: SHIPPER_ADDRESS,
        maximumFreightBudgetAtomic: BUDGET,
        escrowTokenAddress: TOKEN,
        creationAuthorizationHash: AUTH,
      });
      expect(plan.tenderKey).toBe(escrowTenderKey("tender-c1", 1));
      expect(parseEscrowStateResult(2)).toBe("FUNDED");
      expect(attempts).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
