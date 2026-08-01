import {
  Client,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractId,
  Hbar,
  Status,
} from "@hiero-ledger/sdk";

import type { EscrowArgument, EscrowTransactionPlan } from "../escrow/requests";

export type PinnedContract = {
  readonly contractId: string;
  readonly contractEvmAddress: string;
  readonly tokenId: "0.0.429274";
};

export type ContractReceipt = {
  readonly transactionId: string;
  readonly receiptStatus: "SUCCESS";
  readonly operation: EscrowTransactionPlan["operation"];
};

function bytes32(value: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("bytes32 argument invalid");
  return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
}

function addArgument(params: ContractFunctionParameters, arg: EscrowArgument): void {
  if (arg.type === "bytes32") params.addBytes32(bytes32(arg.value));
  else if (arg.type === "address") params.addAddress(arg.value);
  else if (arg.type === "uint32") params.addUint32(arg.value);
  else {
    const value = Number(arg.value);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("uint256 argument exceeds the safe demo range");
    params.addUint256(value);
  }
}

export class ContractExecutor {
  constructor(private readonly pinned: PinnedContract) {
    if (pinned.tokenId !== "0.0.429274") throw new Error("demo token must be 0.0.429274");
    ContractId.fromString(pinned.contractId);
    if (!/^0x[0-9a-fA-F]{40}$/.test(pinned.contractEvmAddress)) throw new Error("contract EVM address invalid");
  }

  binding(): PinnedContract { return this.pinned; }

  async execute(
    client: Client,
    plan: EscrowTransactionPlan,
    journalReceipt: (receipt: ContractReceipt) => Promise<void> | void,
  ): Promise<ContractReceipt> {
    const params = new ContractFunctionParameters();
    for (const arg of plan.args) addArgument(params, arg);
    const response = await new ContractExecuteTransaction()
      .setContractId(ContractId.fromString(this.pinned.contractId))
      .setGas(plan.gasLimit)
      .setFunction(plan.contractFunction, params)
      .setMaxTransactionFee(new Hbar(15))
      .execute(client);
    const receipt = await response.getReceipt(client);
    if (receipt.status !== Status.Success) throw new Error("contract receipt was not SUCCESS");
    const result = { transactionId: response.transactionId.toString(), receiptStatus: "SUCCESS" as const, operation: plan.operation };
    await journalReceipt(result);
    return result;
  }
}
