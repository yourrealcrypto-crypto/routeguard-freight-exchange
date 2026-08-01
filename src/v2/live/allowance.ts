import {
  AccountAllowanceApproveTransaction,
  AccountId,
  Client,
  ContractId,
  Hbar,
  Status,
  TokenId,
} from "@hiero-ledger/sdk";

export const DEMO_ALLOWANCE_ATOMIC = "20000" as const;

export type DemoAllowanceConfig = {
  readonly tokenId: "0.0.429274";
  readonly ownerAccountId: string;
  readonly spenderContractId: string;
  readonly amountAtomic: typeof DEMO_ALLOWANCE_ATOMIC;
};

export type AllowanceTransactionPlan = DemoAllowanceConfig & {
  readonly operation: "APPROVE_EXACT_ALLOWANCE";
  readonly networkWrite: true;
};

export type AllowanceExecutionResult = {
  readonly transactionId: string;
  readonly receiptStatus: "SUCCESS";
  readonly plan: AllowanceTransactionPlan;
};

export function buildDemoAllowancePlan(config: DemoAllowanceConfig): AllowanceTransactionPlan {
  if (config.tokenId !== "0.0.429274" || config.amountAtomic !== DEMO_ALLOWANCE_ATOMIC) {
    throw new Error("demo allowance token and amount are fixed");
  }
  AccountId.fromString(config.ownerAccountId);
  ContractId.fromString(config.spenderContractId);
  return Object.freeze({ ...config, operation: "APPROVE_EXACT_ALLOWANCE", networkWrite: true as const });
}

export async function executeDemoAllowance(
  client: Client,
  plan: AllowanceTransactionPlan,
  journalReceipt: (result: AllowanceExecutionResult) => Promise<void> | void,
): Promise<AllowanceExecutionResult> {
  const response = await new AccountAllowanceApproveTransaction()
    .approveTokenAllowance(
      TokenId.fromString(plan.tokenId),
      AccountId.fromString(plan.ownerAccountId),
      ContractId.fromString(plan.spenderContractId),
      Number(plan.amountAtomic),
    )
    .setMaxTransactionFee(new Hbar(5))
    .execute(client);
  const receipt = await response.getReceipt(client);
  if (receipt.status !== Status.Success) throw new Error("allowance receipt was not SUCCESS");
  const result = { transactionId: response.transactionId.toString(), receiptStatus: "SUCCESS" as const, plan };
  await journalReceipt(result);
  return result;
}
