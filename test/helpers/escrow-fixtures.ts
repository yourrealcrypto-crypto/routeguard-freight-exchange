/**
 * Shared fixtures for the offline freight-escrow contract tests.
 */

import { keccak256, toUtf8Bytes } from "ethers";

import {
  EscrowEvm,
  CARRIER,
  OPERATOR,
  SHIPPER,
  TOKEN,
} from "./escrow-evm";

export const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
export const ZERO_HASH = `0x${"0".repeat(64)}`;

export const BUDGET = 1_000_000n; // 1.0 USDC atomic
export const WINNING = 700_000n;
export const EXCESS = BUDGET - WINNING;

export const TENDER_ID = "tender-c1";
export const TENDER_VERSION = 1;

export function authHash(label: string): string {
  return keccak256(toUtf8Bytes(`routeguard-auth:${label}`));
}

export function idHash(tenderId: string): string {
  return keccak256(toUtf8Bytes(tenderId));
}

export type EscrowFixture = {
  readonly evm: EscrowEvm;
  readonly tenderKey: string;
  key(tenderId: string, version?: number): Promise<string>;
  register(overrides?: Partial<RegisterArgs>): Promise<Awaited<ReturnType<EscrowEvm["send"]>>>;
  fund(amount?: bigint, from?: string, key?: string): Promise<Awaited<ReturnType<EscrowEvm["send"]>>>;
  allocate(
    overrides?: Partial<AllocateArgs>,
  ): Promise<Awaited<ReturnType<EscrowEvm["send"]>>>;
  state(key?: string): Promise<number>;
  balance(account: string): Promise<bigint>;
  tenderBalance(key?: string): Promise<bigint>;
  totalEscrowed(): Promise<bigint>;
};

export type RegisterArgs = {
  tenderKey: string;
  tenderIdHash: string;
  tenderVersion: number;
  shipper: string;
  maxBudget: bigint;
  token: string;
  creationAuthHash: string;
  manifestHash: string;
  from: string;
};

export type AllocateArgs = {
  tenderKey: string;
  winner: string;
  winningAmount: bigint;
  decisionManifestHash: string;
  allocationAuthHash: string;
  from: string;
};

/** Deploy the mock-ledger escrow and mint the shipper's freight budget. */
export async function deployEscrow(options?: {
  mintShipper?: bigint;
}): Promise<EscrowFixture> {
  const evm = await EscrowEvm.deploy({
    contractName: "MockLedgerFreightEscrow",
    args: [TOKEN, OPERATOR],
    deployer: OPERATOR,
  });
  const mint = options?.mintShipper ?? BUDGET * 10n;
  await evm.send(OPERATOR, "mint", [SHIPPER, mint]);

  const tenderKey = await evm.call<string>("computeTenderKey", [
    idHash(TENDER_ID),
    TENDER_VERSION,
  ]);

  return {
    evm,
    tenderKey,
    async key(tenderId: string, version = TENDER_VERSION) {
      return evm.call<string>("computeTenderKey", [idHash(tenderId), version]);
    },
    async register(overrides = {}) {
      const args: RegisterArgs = {
        tenderKey,
        tenderIdHash: idHash(TENDER_ID),
        tenderVersion: TENDER_VERSION,
        shipper: SHIPPER,
        maxBudget: BUDGET,
        token: TOKEN,
        creationAuthHash: authHash("create-1"),
        manifestHash: idHash("manifest-1"),
        from: OPERATOR,
        ...overrides,
      };
      return evm.send(args.from, "registerTender", [
        args.tenderKey,
        args.tenderIdHash,
        args.tenderVersion,
        args.shipper,
        args.maxBudget,
        args.token,
        args.creationAuthHash,
        args.manifestHash,
      ]);
    },
    async fund(amount = BUDGET, from = SHIPPER, key = tenderKey) {
      return evm.send(from, "fundTender", [key, amount]);
    },
    async allocate(overrides = {}) {
      const args: AllocateArgs = {
        tenderKey,
        winner: CARRIER,
        winningAmount: WINNING,
        decisionManifestHash: idHash("decision-manifest-1"),
        allocationAuthHash: authHash("allocate-1"),
        from: OPERATOR,
        ...overrides,
      };
      return evm.send(args.from, "allocateWinner", [
        args.tenderKey,
        args.winner,
        args.winningAmount,
        args.decisionManifestHash,
        args.allocationAuthHash,
      ]);
    },
    async state(key = tenderKey) {
      return Number(await evm.call<bigint>("getState", [key]));
    },
    async balance(account: string) {
      return evm.call<bigint>("balanceOf", [account]);
    },
    async tenderBalance(key = tenderKey) {
      return evm.call<bigint>("tenderBalance", [key]);
    },
    async totalEscrowed() {
      return evm.call<bigint>("totalEscrowedAmount");
    },
  };
}

/** Escrow state ordinals (mirrors the Solidity enum). */
export const STATE = {
  UNREGISTERED: 0,
  REGISTERED: 1,
  FUNDED: 2,
  ALLOCATED: 3,
  DISPUTED: 4,
  RELEASED: 5,
  REFUNDED: 6,
  PARTIALLY_RELEASED: 7,
} as const;
