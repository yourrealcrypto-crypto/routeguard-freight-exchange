import { Client, Status, TopicId, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";

import type { HcsV2Envelope } from "../../hcs/v2/types";
import { assertHcsV2EnvelopeWithinLimit, parseHcsV2Envelope, serializeHcsV2Envelope } from "../../hcs/v2/envelope";

export type HcsReceiptRecord = {
  readonly transactionId: string;
  readonly receiptStatus: "SUCCESS";
  readonly sequenceNumber: number;
  readonly message: string;
};

export class HcsV2Submitter {
  constructor(private readonly topicId: string, private readonly immutableProofTopicId = "0.0.9862010") {
    TopicId.fromString(topicId);
    if (topicId === immutableProofTopicId) throw new Error("immutable proof topic cannot be used by Operations Demo");
  }

  binding(): { readonly topicId: string } { return { topicId: this.topicId }; }

  async submit(
    client: Client,
    envelope: HcsV2Envelope,
    journalReceipt: (receipt: HcsReceiptRecord) => Promise<void> | void,
  ): Promise<HcsReceiptRecord> {
    const validated = parseHcsV2Envelope(envelope);
    assertHcsV2EnvelopeWithinLimit(validated);
    const message = serializeHcsV2Envelope(validated);
    const response = await new TopicMessageSubmitTransaction()
      .setTopicId(this.topicId)
      .setMessage(message)
      .execute(client);
    const receipt = await response.getReceipt(client);
    if (receipt.status !== Status.Success || receipt.topicSequenceNumber === null) {
      throw new Error("HCS receipt was not SUCCESS");
    }
    const record: HcsReceiptRecord = {
      transactionId: response.transactionId.toString(),
      receiptStatus: "SUCCESS",
      sequenceNumber: Number(receipt.topicSequenceNumber.toString()),
      message,
    };
    await journalReceipt(record);
    return record;
  }
}
