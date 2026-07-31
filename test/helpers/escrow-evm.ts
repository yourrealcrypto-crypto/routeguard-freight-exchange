/**
 * Offline EVM harness for the RouteGuard freight escrow contracts.
 *
 * Compiles the real Solidity sources with the pinned `solc` and executes the
 * real bytecode in an in-process EVM. No network, no node, no external binary.
 * Hedera's HTS token boundary is exercised through the mock-ledger subclass,
 * which reuses the production state machine unchanged.
 */

import { EVM } from "@ethereumjs/evm";
import { Account, Address, bytesToHex, hexToBytes } from "@ethereumjs/util";
import { Interface, type InterfaceAbi } from "ethers";

import {
  compileContracts,
  type CompileResult,
} from "../../scripts/compile-contracts";

let cached: CompileResult | null = null;

/** Compile once per test process. */
export function contracts(): CompileResult {
  if (!cached) {
    cached = compileContracts();
  }
  return cached;
}

export const GAS_LIMIT = 30_000_000n;

export type CallOutcome = {
  readonly ok: boolean;
  readonly returnData: string;
  readonly logs: readonly { address: string; topics: string[]; data: string }[];
  /** Decoded custom error name when the call reverted, else null. */
  readonly errorName: string | null;
  readonly errorArgs: readonly unknown[];
};

export class EscrowEvm {
  private constructor(
    private readonly evm: EVM,
    readonly iface: Interface,
    readonly address: string,
  ) {}

  static async deploy(input: {
    contractName: string;
    args: readonly unknown[];
    deployer: string;
  }): Promise<EscrowEvm> {
    const compiled = contracts().contracts[input.contractName];
    if (!compiled) {
      throw new Error(`unknown contract: ${input.contractName}`);
    }
    const evm = await EVM.create();
    const iface = new Interface(compiled.abi as InterfaceAbi);

    await fundAccount(evm, input.deployer);
    const deployData =
      compiled.bytecode +
      iface.encodeDeploy(input.args as unknown[]).slice(2);

    const result = await evm.runCall({
      caller: Address.fromString(input.deployer),
      gasLimit: GAS_LIMIT,
      data: hexToBytes(deployData as `0x${string}`),
      skipBalance: true,
    });
    if (result.execResult.exceptionError) {
      throw new Error(
        `deployment reverted: ${result.execResult.exceptionError.error}`,
      );
    }
    const created = result.createdAddress;
    if (!created) {
      throw new Error("deployment produced no address");
    }
    return new EscrowEvm(evm, iface, created.toString());
  }

  /** Deploy an additional contract into the same EVM state. */
  async deployAuxiliary(input: {
    contractName: string;
    args: readonly unknown[];
    deployer: string;
  }): Promise<{ address: string; iface: Interface }> {
    const compiled = contracts().contracts[input.contractName];
    if (!compiled) {
      throw new Error(`unknown contract: ${input.contractName}`);
    }
    const iface = new Interface(compiled.abi as InterfaceAbi);
    await fundAccount(this.evm, input.deployer);
    const result = await this.evm.runCall({
      caller: Address.fromString(input.deployer),
      gasLimit: GAS_LIMIT,
      data: hexToBytes(
        (compiled.bytecode +
          iface.encodeDeploy(input.args as unknown[]).slice(2)) as `0x${string}`,
      ),
      skipBalance: true,
    });
    if (result.execResult.exceptionError || !result.createdAddress) {
      throw new Error("auxiliary deployment reverted");
    }
    return { address: result.createdAddress.toString(), iface };
  }

  /** Send a transaction to the escrow. Never throws on revert. */
  async send(
    from: string,
    fn: string,
    args: readonly unknown[] = [],
    target?: { address: string; iface: Interface },
  ): Promise<CallOutcome> {
    const iface = target?.iface ?? this.iface;
    const to = target?.address ?? this.address;
    await fundAccount(this.evm, from);

    const result = await this.evm.runCall({
      caller: Address.fromString(from),
      to: Address.fromString(to),
      gasLimit: GAS_LIMIT,
      data: hexToBytes(iface.encodeFunctionData(fn, args as unknown[]) as `0x${string}`),
      skipBalance: true,
    });

    const returnData = bytesToHex(result.execResult.returnValue);
    const failed = Boolean(result.execResult.exceptionError);
    let errorName: string | null = null;
    let errorArgs: unknown[] = [];
    if (failed && returnData.length > 2) {
      try {
        const parsed = iface.parseError(returnData);
        if (parsed) {
          errorName = parsed.name;
          errorArgs = [...parsed.args];
        }
      } catch {
        errorName = "UnknownRevert";
      }
    } else if (failed) {
      errorName = result.execResult.exceptionError?.error ?? "Revert";
    }

    return {
      ok: !failed,
      returnData,
      logs: (result.execResult.logs ?? []).map((log) => ({
        address: bytesToHex(log[0]),
        topics: log[1].map((topic) => bytesToHex(topic)),
        data: bytesToHex(log[2]),
      })),
      errorName,
      errorArgs,
    };
  }

  /** Read-only call; throws when the call reverts. */
  async call<T = unknown>(
    fn: string,
    args: readonly unknown[] = [],
    from = ZERO_CALLER,
  ): Promise<T> {
    const outcome = await this.send(from, fn, args);
    if (!outcome.ok) {
      throw new Error(`view call ${fn} reverted: ${outcome.errorName}`);
    }
    const decoded = this.iface.decodeFunctionResult(fn, outcome.returnData);
    return (decoded.length === 1 ? decoded[0] : decoded) as T;
  }

  /** Decode the escrow events emitted by a call. */
  decodeEvents(outcome: CallOutcome): { name: string; args: Record<string, unknown> }[] {
    const events: { name: string; args: Record<string, unknown> }[] = [];
    for (const log of outcome.logs) {
      const parsed = this.iface.parseLog({ topics: log.topics, data: log.data });
      if (!parsed) continue;
      const args: Record<string, unknown> = {};
      parsed.fragment.inputs.forEach((input, index) => {
        args[input.name] = parsed.args[index];
      });
      events.push({ name: parsed.name, args });
    }
    return events;
  }
}

const ZERO_CALLER = "0x00000000000000000000000000000000000000ff";

async function fundAccount(evm: EVM, address: string): Promise<void> {
  const account = new Account(0n, 10n ** 20n);
  await evm.stateManager.putAccount(Address.fromString(address), account);
}

/** Deterministic pseudo-addresses for test participants. */
export function testAddress(label: string): string {
  const hex = Buffer.from(label, "utf8").toString("hex").slice(0, 40);
  return `0x${hex.padEnd(40, "0")}`;
}

export const OPERATOR = testAddress("operator");
export const SHIPPER = testAddress("shipper");
export const CARRIER = testAddress("carrier");
export const OUTSIDER = testAddress("outsider");
export const TOKEN = testAddress("usdc-token");
export const OTHER_TOKEN = testAddress("other-token");
