/** Immutable, publicly submittable topic configuration for the final demo. */

import { Hbar, TopicCreateTransaction } from "@hiero-ledger/sdk";

/**
 * No admin key and no submit key are set. The resulting topic cannot be
 * administratively updated and accepts submissions signed by independent
 * carrier accounts.
 */
export function buildFinalDemoTopicCreateTransaction(
  memo: string,
): TopicCreateTransaction {
  return new TopicCreateTransaction()
    .setTopicMemo(memo)
    .setMaxTransactionFee(new Hbar(5));
}
