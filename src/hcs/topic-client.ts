/**
 * Hedera Testnet HCS topic client.
 * Live writes require process-scoped authorization flags.
 */

import {
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  Status,
  TopicCreateTransaction,
  TopicId,
  TopicMessageSubmitTransaction,
  type TransactionReceipt,
} from "@hiero-ledger/sdk";

import {
  assertMessageSize,
  envelopeHash,
  serializeEnvelopeForSubmit,
} from "./message-envelope";
import {
  CONFIRM_HCS_DEMO_WRITE_VALUE,
  HCS_DEMO_OPERATOR_ACCOUNT,
  HCS_DEMO_OPERATOR_PUBLIC_KEY,
  type HcsEnvelope,
} from "./types";

export class HcsTopicClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HcsTopicClientError";
  }
}

export type LiveWriteAuthorization = {
  enableLiveHedera: boolean;
  enableLiveHcsWrites: boolean;
  confirmValue: string | undefined;
};

export function assertLiveWriteAuthorized(
  auth: LiveWriteAuthorization = {
    enableLiveHedera: process.env.ENABLE_LIVE_HEDERA === "true",
    enableLiveHcsWrites: process.env.ENABLE_LIVE_HCS_WRITES === "true",
    confirmValue: process.env.CONFIRM_HCS_DEMO_WRITE,
  },
): void {
  if (!auth.enableLiveHedera) {
    throw new HcsTopicClientError(
      "Live HCS writes disabled: set ENABLE_LIVE_HEDERA=true (process-scoped).",
    );
  }
  if (!auth.enableLiveHcsWrites) {
    throw new HcsTopicClientError(
      "Live HCS writes disabled: set ENABLE_LIVE_HCS_WRITES=true (process-scoped).",
    );
  }
  if (auth.confirmValue !== CONFIRM_HCS_DEMO_WRITE_VALUE) {
    throw new HcsTopicClientError(
      `Live HCS writes disabled: CONFIRM_HCS_DEMO_WRITE must be exactly ${CONFIRM_HCS_DEMO_WRITE_VALUE}`,
    );
  }
}

export type OperatorIdentity = {
  accountId: AccountId;
  privateKey: PrivateKey;
  publicKeyHex: string;
};

/**
 * Parse operator key as ECDSA and require exact public-key match.
 * Logs only OPERATOR_PUBLIC_KEY_MATCH: PASS on success.
 */
export function loadAndVerifyOperator(
  accountIdText: string,
  privateKeyText: string,
  expectedAccountId: string = HCS_DEMO_OPERATOR_ACCOUNT,
  expectedPublicKeyHex: string = HCS_DEMO_OPERATOR_PUBLIC_KEY,
): OperatorIdentity {
  if (accountIdText !== expectedAccountId) {
    throw new HcsTopicClientError(
      `Operator account mismatch: expected ${expectedAccountId}, got ${accountIdText}`,
    );
  }

  let privateKey: PrivateKey;
  try {
    privateKey = PrivateKey.fromStringECDSA(privateKeyText);
  } catch (error: unknown) {
    throw new HcsTopicClientError(
      `Failed to parse operator key with PrivateKey.fromStringECDSA: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const publicKeyHex = privateKey.publicKey.toStringRaw().toLowerCase();
  if (publicKeyHex !== expectedPublicKeyHex.toLowerCase()) {
    throw new HcsTopicClientError(
      "OPERATOR_PUBLIC_KEY_MATCH: FAIL — derived public key does not match known operator key",
    );
  }

  console.log("OPERATOR_PUBLIC_KEY_MATCH: PASS");

  return {
    accountId: AccountId.fromString(accountIdText),
    privateKey,
    publicKeyHex,
  };
}

export type TopicCreateResult = {
  topicId: string;
  transactionId: string;
  receiptStatus: string;
};

export type MessageSubmitResult = {
  transactionId: string;
  receiptStatus: string;
  envelopeHash: string;
};

const MAX_TX_FEE_HBAR = 5;

export class HcsTopicClient {
  private client: Client | null = null;
  private operator: OperatorIdentity | null = null;
  private topicCreates = 0;
  private messageSubmits = 0;
  private readonly maxTopicCreates: number;
  private readonly maxMessageSubmits: number;

  constructor(
    options: {
      maxTopicCreates?: number;
      maxMessageSubmits?: number;
    } = {},
  ) {
    this.maxTopicCreates = options.maxTopicCreates ?? 1;
    this.maxMessageSubmits = options.maxMessageSubmits ?? 4;
  }

  connect(operator: OperatorIdentity): void {
    if (this.client) {
      throw new HcsTopicClientError("Client already connected");
    }
    this.operator = operator;
    const client = Client.forTestnet();
    client.setOperator(operator.accountId, operator.privateKey);
    this.client = client;
  }

  close(): void {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
  }

  getSubmitCount(): number {
    return this.messageSubmits;
  }

  getTopicCreateCount(): number {
    return this.topicCreates;
  }

  async createTopic(memo: string): Promise<TopicCreateResult> {
    assertLiveWriteAuthorized();
    if (!this.client || !this.operator) {
      throw new HcsTopicClientError("Client not connected");
    }
    if (this.topicCreates >= this.maxTopicCreates) {
      throw new HcsTopicClientError(
        `Topic create budget exhausted (${this.maxTopicCreates})`,
      );
    }
    this.topicCreates += 1;

    const tx = new TopicCreateTransaction()
      .setTopicMemo(memo)
      .setAdminKey(this.operator.privateKey.publicKey)
      .setSubmitKey(this.operator.privateKey.publicKey)
      .setAutoRenewAccountId(this.operator.accountId)
      .setMaxTransactionFee(new Hbar(MAX_TX_FEE_HBAR));

    const response = await tx.execute(this.client);
    const receipt: TransactionReceipt = await response.getReceipt(this.client);
    if (receipt.status !== Status.Success) {
      throw new HcsTopicClientError(
        `TopicCreateTransaction failed: ${receipt.status.toString()}`,
      );
    }
    const topicId = receipt.topicId;
    if (!topicId) {
      throw new HcsTopicClientError(
        "TopicCreateTransaction SUCCESS but topicId missing from receipt",
      );
    }
    const transactionId = response.transactionId.toString();
    return {
      topicId: topicId.toString(),
      transactionId,
      receiptStatus: receipt.status.toString(),
    };
  }

  async submitMessage(
    topicId: string,
    envelope: HcsEnvelope,
  ): Promise<MessageSubmitResult> {
    assertLiveWriteAuthorized();
    if (!this.client || !this.operator) {
      throw new HcsTopicClientError("Client not connected");
    }
    if (this.messageSubmits >= this.maxMessageSubmits) {
      throw new HcsTopicClientError(
        `Message submit budget exhausted (${this.maxMessageSubmits})`,
      );
    }

    assertMessageSize(envelope);
    const body = serializeEnvelopeForSubmit(envelope);
    const hash = envelopeHash(envelope);

    this.messageSubmits += 1;

    const tx = new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(topicId))
      .setMessage(body)
      .setMaxTransactionFee(new Hbar(MAX_TX_FEE_HBAR));

    const response = await tx.execute(this.client);
    const receipt = await response.getReceipt(this.client);
    if (receipt.status !== Status.Success) {
      throw new HcsTopicClientError(
        `TopicMessageSubmitTransaction failed: ${receipt.status.toString()}`,
      );
    }

    return {
      transactionId: response.transactionId.toString(),
      receiptStatus: receipt.status.toString(),
      envelopeHash: hash,
    };
  }
}

export { envelopeHash };
