import { AccountId, Client, Hbar, PrivateKey } from "@hiero-ledger/sdk";

export type HederaSignerConfig = {
  readonly network: "hedera:testnet";
  readonly accountId: string;
  readonly privateKey: string;
};

export class HederaClientConfigError extends Error {
  constructor(readonly code: "DEMO_CONFIG_INVALID", message: string) {
    super(message);
    this.name = "HederaClientConfigError";
  }
}

export function parseDemoPrivateKey(raw: string): PrivateKey {
  try {
    const value = raw.trim();
    return value.startsWith("0x") || /^[0-9a-fA-F]{64}$/.test(value)
      ? PrivateKey.fromStringECDSA(value)
      : PrivateKey.fromString(value);
  } catch {
    throw new HederaClientConfigError("DEMO_CONFIG_INVALID", "signing key is invalid");
  }
}

export function createTestnetClient(config: HederaSignerConfig): Client {
  if (config.network !== "hedera:testnet") {
    throw new HederaClientConfigError("DEMO_CONFIG_INVALID", "Operations Demo supports testnet only");
  }
  try {
    const client = Client.forTestnet();
    client.setOperator(AccountId.fromString(config.accountId), parseDemoPrivateKey(config.privateKey));
    client.setDefaultMaxTransactionFee(new Hbar(50));
    return client;
  } catch {
    throw new HederaClientConfigError("DEMO_CONFIG_INVALID", "signer identity is invalid");
  }
}
