/**
 * Freight-escrow transaction-plan builders.
 *
 * Builders are pure: they validate inputs and return typed argument plans. They
 * never sign, never submit, never read the environment, and never load a key.
 * Phase C2 supplies the signer and executes the plan; Phase C1 only produces it.
 */

import {
  assertNonNegativeEscrowAmount,
  assertPartialConservation,
  assertPositiveEscrowAmount,
  deriveExcessRefundAtomic,
} from "./amounts";
import {
  assertAuthorizationHash,
  assertBytes32,
  assertEvmAddress,
  assertTenderVersion,
  escrowTenderKey,
  tenderIdHash,
} from "./tender-key";

export const ESCROW_OPERATIONS = [
  "REGISTER_TENDER",
  "FUND_TENDER",
  "ALLOCATE_WINNER",
  "REFUND_NO_QUALIFIED_BID",
  "RELEASE_FULL",
  "OPEN_DISPUTE",
  "RESOLVE_DISPUTE_RELEASE",
  "REFUND_FULL",
  "PARTIAL_RELEASE",
] as const;

export type EscrowOperation = (typeof ESCROW_OPERATIONS)[number];

/** Who must sign the resulting Hedera transaction. */
export type EscrowSignerRole = "OPERATOR" | "SHIPPER";

export type EscrowArgument =
  | { readonly type: "bytes32"; readonly value: string }
  | { readonly type: "address"; readonly value: string }
  | { readonly type: "uint32"; readonly value: number }
  /** Always an atomic integer string — never a JS number or float. */
  | { readonly type: "uint256"; readonly value: string };

export type EscrowTransactionPlan = {
  readonly operation: EscrowOperation;
  readonly contractFunction: string;
  readonly functionSignature: string;
  readonly args: readonly EscrowArgument[];
  readonly tenderKey: string;
  readonly signerRole: EscrowSignerRole;
  readonly gasLimit: number;
  /**
   * Marker: executing this plan is a network write. Phase C1 never submits.
   */
  readonly networkWrite: true;
};

const GAS = {
  REGISTER_TENDER: 400_000,
  FUND_TENDER: 900_000,
  ALLOCATE_WINNER: 1_200_000,
  REFUND_NO_QUALIFIED_BID: 900_000,
  RELEASE_FULL: 900_000,
  OPEN_DISPUTE: 300_000,
  RESOLVE_DISPUTE_RELEASE: 900_000,
  REFUND_FULL: 900_000,
  PARTIAL_RELEASE: 1_400_000,
} as const satisfies Record<EscrowOperation, number>;

function plan(input: {
  operation: EscrowOperation;
  contractFunction: string;
  functionSignature: string;
  args: readonly EscrowArgument[];
  tenderKey: string;
  signerRole: EscrowSignerRole;
}): EscrowTransactionPlan {
  return Object.freeze({
    ...input,
    args: Object.freeze([...input.args]),
    gasLimit: GAS[input.operation],
    networkWrite: true as const,
  });
}

export function buildRegisterTenderPlan(input: {
  tenderId: string;
  tenderVersion: number;
  shipperAddress: string;
  maximumFreightBudgetAtomic: string;
  escrowTokenAddress: string;
  creationAuthorizationHash: string;
  manifestHash?: string;
}): EscrowTransactionPlan {
  const version = assertTenderVersion(input.tenderVersion);
  const identityHash = tenderIdHash(input.tenderId);
  const tenderKey = escrowTenderKey(input.tenderId, version);
  const budget = assertPositiveEscrowAmount(
    input.maximumFreightBudgetAtomic,
    "maximumFreightBudgetAtomic",
  );
  const manifest =
    input.manifestHash === undefined
      ? `0x${"0".repeat(64)}`
      : assertBytes32(input.manifestHash, "manifestHash");

  return plan({
    operation: "REGISTER_TENDER",
    contractFunction: "registerTender",
    functionSignature:
      "registerTender(bytes32,bytes32,uint32,address,uint256,address,bytes32,bytes32)",
    tenderKey,
    signerRole: "OPERATOR",
    args: [
      { type: "bytes32", value: tenderKey },
      { type: "bytes32", value: identityHash },
      { type: "uint32", value: version },
      {
        type: "address",
        value: assertEvmAddress(input.shipperAddress, "shipperAddress"),
      },
      { type: "uint256", value: budget.toString() },
      {
        type: "address",
        value: assertEvmAddress(input.escrowTokenAddress, "escrowTokenAddress"),
      },
      {
        type: "bytes32",
        value: assertAuthorizationHash(
          input.creationAuthorizationHash,
          "creationAuthorizationHash",
        ),
      },
      { type: "bytes32", value: manifest },
    ],
  });
}

/**
 * Fund the tender with the exact maximum freight budget.
 * Phase A locks exact funding, so the amount always equals the budget.
 */
export function buildFundTenderPlan(input: {
  tenderId: string;
  tenderVersion: number;
  maximumFreightBudgetAtomic: string;
}): EscrowTransactionPlan {
  const version = assertTenderVersion(input.tenderVersion);
  const tenderKey = escrowTenderKey(input.tenderId, version);
  const budget = assertPositiveEscrowAmount(
    input.maximumFreightBudgetAtomic,
    "maximumFreightBudgetAtomic",
  );
  return plan({
    operation: "FUND_TENDER",
    contractFunction: "fundTender",
    functionSignature: "fundTender(bytes32,uint256)",
    tenderKey,
    signerRole: "SHIPPER",
    args: [
      { type: "bytes32", value: tenderKey },
      { type: "uint256", value: budget.toString() },
    ],
  });
}

export type AllocationPlan = {
  readonly plan: EscrowTransactionPlan;
  /** Exact excess the contract returns to the shipper during allocation. */
  readonly excessRefundAtomic: string;
};

export function buildAllocateWinnerPlan(input: {
  tenderId: string;
  tenderVersion: number;
  winnerAddress: string;
  fundedAmountAtomic: string;
  winningAmountAtomic: string;
  decisionManifestHash: string;
  allocationAuthorizationHash: string;
}): AllocationPlan {
  const version = assertTenderVersion(input.tenderVersion);
  const tenderKey = escrowTenderKey(input.tenderId, version);
  const winning = assertPositiveEscrowAmount(
    input.winningAmountAtomic,
    "winningAmountAtomic",
  );
  const excessRefundAtomic = deriveExcessRefundAtomic(
    input.fundedAmountAtomic,
    input.winningAmountAtomic,
  );
  assertNonNegativeEscrowAmount(excessRefundAtomic, "excessRefundAtomic");

  return {
    excessRefundAtomic,
    plan: plan({
      operation: "ALLOCATE_WINNER",
      contractFunction: "allocateWinner",
      functionSignature:
        "allocateWinner(bytes32,address,uint256,bytes32,bytes32)",
      tenderKey,
      signerRole: "OPERATOR",
      args: [
        { type: "bytes32", value: tenderKey },
        {
          type: "address",
          value: assertEvmAddress(input.winnerAddress, "winnerAddress"),
        },
        { type: "uint256", value: winning.toString() },
        {
          type: "bytes32",
          value: assertAuthorizationHash(
            input.decisionManifestHash,
            "decisionManifestHash",
          ),
        },
        {
          type: "bytes32",
          value: assertAuthorizationHash(
            input.allocationAuthorizationHash,
            "allocationAuthorizationHash",
          ),
        },
      ],
    }),
  };
}

export function buildNoQualifiedBidRefundPlan(input: {
  tenderId: string;
  tenderVersion: number;
  authorizationHash: string;
}): EscrowTransactionPlan {
  return simpleAuthorizedPlan({
    operation: "REFUND_NO_QUALIFIED_BID",
    contractFunction: "refundNoQualifiedBid",
    functionSignature: "refundNoQualifiedBid(bytes32,bytes32)",
    ...input,
  });
}

export function buildReleaseFullPlan(input: {
  tenderId: string;
  tenderVersion: number;
  authorizationHash: string;
}): EscrowTransactionPlan {
  return simpleAuthorizedPlan({
    operation: "RELEASE_FULL",
    contractFunction: "releaseFull",
    functionSignature: "releaseFull(bytes32,bytes32)",
    ...input,
  });
}

export function buildOpenDisputePlan(input: {
  tenderId: string;
  tenderVersion: number;
  authorizationHash: string;
}): EscrowTransactionPlan {
  return simpleAuthorizedPlan({
    operation: "OPEN_DISPUTE",
    contractFunction: "openDispute",
    functionSignature: "openDispute(bytes32,bytes32)",
    ...input,
  });
}

export function buildResolveDisputeReleasePlan(input: {
  tenderId: string;
  tenderVersion: number;
  authorizationHash: string;
}): EscrowTransactionPlan {
  return simpleAuthorizedPlan({
    operation: "RESOLVE_DISPUTE_RELEASE",
    contractFunction: "resolveDisputeRelease",
    functionSignature: "resolveDisputeRelease(bytes32,bytes32)",
    ...input,
  });
}

export function buildRefundFullPlan(input: {
  tenderId: string;
  tenderVersion: number;
  authorizationHash: string;
}): EscrowTransactionPlan {
  return simpleAuthorizedPlan({
    operation: "REFUND_FULL",
    contractFunction: "refundFull",
    functionSignature: "refundFull(bytes32,bytes32)",
    ...input,
  });
}

export function buildPartialReleasePlan(input: {
  tenderId: string;
  tenderVersion: number;
  lockedAmountAtomic: string;
  winnerAmountAtomic: string;
  shipperAmountAtomic: string;
  refereeAuthorizationHash: string;
}): EscrowTransactionPlan {
  const version = assertTenderVersion(input.tenderVersion);
  const tenderKey = escrowTenderKey(input.tenderId, version);
  assertPartialConservation({
    lockedAmountAtomic: input.lockedAmountAtomic,
    winnerAmountAtomic: input.winnerAmountAtomic,
    shipperAmountAtomic: input.shipperAmountAtomic,
  });
  return plan({
    operation: "PARTIAL_RELEASE",
    contractFunction: "partialRelease",
    functionSignature: "partialRelease(bytes32,uint256,uint256,bytes32)",
    tenderKey,
    signerRole: "OPERATOR",
    args: [
      { type: "bytes32", value: tenderKey },
      { type: "uint256", value: BigInt(input.winnerAmountAtomic).toString() },
      { type: "uint256", value: BigInt(input.shipperAmountAtomic).toString() },
      {
        type: "bytes32",
        value: assertAuthorizationHash(
          input.refereeAuthorizationHash,
          "refereeAuthorizationHash",
        ),
      },
    ],
  });
}

function simpleAuthorizedPlan(input: {
  operation: EscrowOperation;
  contractFunction: string;
  functionSignature: string;
  tenderId: string;
  tenderVersion: number;
  authorizationHash: string;
}): EscrowTransactionPlan {
  const version = assertTenderVersion(input.tenderVersion);
  const tenderKey = escrowTenderKey(input.tenderId, version);
  return plan({
    operation: input.operation,
    contractFunction: input.contractFunction,
    functionSignature: input.functionSignature,
    tenderKey,
    signerRole: "OPERATOR",
    args: [
      { type: "bytes32", value: tenderKey },
      {
        type: "bytes32",
        value: assertAuthorizationHash(
          input.authorizationHash,
          "authorizationHash",
        ),
      },
    ],
  });
}
