import { Interface } from "ethers";

import { HEDERA_TESTNET_MIRROR_NODE } from "../../x402/usdc-constants";
import { hashScanTransactionUrl, toMirrorTransactionId } from "../access/mirror-reconcile";
import { ROUTEGUARD_FREIGHT_ESCROW_ABI } from "../escrow/abi";

export type MirrorTokenTransfer = { readonly tokenId: string; readonly accountId: string; readonly amount: number };
export type MirrorTransactionResult = {
  readonly transactionId: string;
  readonly mirrorTransactionId: string;
  readonly status: "SUCCESS" | "FAILED" | "NOT_FOUND";
  readonly consensusTimestamp: string | null;
  readonly tokenTransfers: readonly MirrorTokenTransfer[];
  readonly childTransactionCount: number;
  readonly logs: readonly { topics: readonly string[]; data: string }[];
  readonly hashScanUrl: string;
};

export type MirrorReaderOptions = {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
};

export class MirrorReader {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly contractInterface = new Interface(ROUTEGUARD_FREIGHT_ESCROW_ABI);

  constructor(options: MirrorReaderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? HEDERA_TESTNET_MIRROR_NODE).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  private async json<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Mirror HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  async transaction(transactionId: string, includeLogs = false): Promise<MirrorTransactionResult> {
    const mirrorId = toMirrorTransactionId(transactionId);
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/transactions/${encodeURIComponent(mirrorId)}`, {
      headers: { accept: "application/json" },
    });
    if (response.status === 404) return {
      transactionId, mirrorTransactionId: mirrorId, status: "NOT_FOUND", consensusTimestamp: null,
      tokenTransfers: [], childTransactionCount: 0, logs: [], hashScanUrl: hashScanTransactionUrl(transactionId),
    };
    if (!response.ok) throw new Error(`Mirror HTTP ${response.status}`);
    const payload = (await response.json()) as { transactions?: Array<{
      result?: string; nonce?: number; consensus_timestamp?: string; parent_consensus_timestamp?: string | null;
      token_transfers?: Array<{ token_id?: string; account?: string; amount?: number }>;
    }> };
    const entries = (payload.transactions ?? []).filter((entry) => typeof entry.result === "string");
    const parent = entries.find((entry) => !entry.parent_consensus_timestamp && (entry.nonce ?? 0) === 0) ?? entries[0];
    if (!parent) return {
      transactionId, mirrorTransactionId: mirrorId, status: "NOT_FOUND", consensusTimestamp: null,
      tokenTransfers: [], childTransactionCount: 0, logs: [], hashScanUrl: hashScanTransactionUrl(transactionId),
    };
    const failure = entries.find((entry) => entry.result !== "SUCCESS");
    const tokenTransfers = entries.flatMap((entry) => entry.token_transfers ?? []).flatMap((leg) =>
      leg.token_id && leg.account && typeof leg.amount === "number"
        ? [{ tokenId: leg.token_id, accountId: leg.account, amount: leg.amount }]
        : [],
    );
    let logs: Array<{ topics: readonly string[]; data: string }> = [];
    if (includeLogs) {
      const body = await this.json<{ logs?: Array<{ topics?: string[]; data?: string }> }>(
        `/api/v1/contracts/results/${encodeURIComponent(mirrorId)}`,
      );
      logs = (body.logs ?? []).map((log) => ({ topics: log.topics ?? [], data: log.data ?? "" }));
    }
    return {
      transactionId,
      mirrorTransactionId: mirrorId,
      status: parent.result === "SUCCESS" && !failure ? "SUCCESS" : "FAILED",
      consensusTimestamp: parent.consensus_timestamp ?? null,
      tokenTransfers,
      childTransactionCount: entries.filter((entry) => Boolean(entry.parent_consensus_timestamp) || (entry.nonce ?? 0) > 0).length,
      logs,
      hashScanUrl: hashScanTransactionUrl(transactionId),
    };
  }

  async contractCall(contractEvmAddress: string, fn: string, args: readonly unknown[]): Promise<readonly unknown[]> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(contractEvmAddress)) throw new Error("contract address invalid");
    const data = this.contractInterface.encodeFunctionData(fn, args as unknown[]);
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/contracts/call`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ to: contractEvmAddress, data, estimate: false }),
    });
    if (!response.ok) throw new Error(`Mirror contracts/call HTTP ${response.status}`);
    const body = (await response.json()) as { result?: string };
    if (!body.result) throw new Error("Mirror contracts/call returned no result");
    return this.contractInterface.decodeFunctionResult(fn, body.result);
  }

  async topicMessage(topicId: string, sequenceNumber: number): Promise<{ sequenceNumber: number; messageBase64: string } | null> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/topics/${topicId}/messages/${sequenceNumber}`, {
      headers: { accept: "application/json" },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Mirror HTTP ${response.status}`);
    const body = (await response.json()) as { sequence_number?: number; message?: string };
    return body.sequence_number && body.message ? { sequenceNumber: body.sequence_number, messageBase64: body.message } : null;
  }

  async accountBalance(accountId: string, tokenId: string): Promise<bigint> {
    const body = await this.json<{ tokens?: Array<{ token_id?: string; balance?: number }> }>(
      `/api/v1/accounts/${accountId}/tokens?limit=100`,
    );
    return BigInt(body.tokens?.find((token) => token.token_id === tokenId)?.balance ?? 0);
  }

  async hbarBalance(accountId: string): Promise<bigint> {
    const body = await this.json<{ balance?: { balance?: number } }>(`/api/v1/accounts/${accountId}`);
    return BigInt(body.balance?.balance ?? 0);
  }

  async contractIdentity(contractId: string): Promise<{ contractId: string; evmAddress: string | null }> {
    const body = await this.json<{ contract_id?: string; evm_address?: string }>(`/api/v1/contracts/${contractId}`);
    return { contractId: body.contract_id ?? contractId, evmAddress: body.evm_address ?? null };
  }

  async topicExists(topicId: string): Promise<boolean> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/topics/${topicId}`, { headers: { accept: "application/json" } });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`Mirror HTTP ${response.status}`);
    return true;
  }
}
