import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const evidence = (name: string) => JSON.parse(readFileSync(`evidence/v2/demo-session-recovery/${name}`, "utf8")) as Record<string, unknown>;

describe("Operations Demo failed-session recovery closeout", () => {
  it("records four partial writes and exactly one separate recovery write", () => {
    const writes = evidence("partial-session-writes.json");
    const accounting = evidence("write-accounting.json");
    expect(writes.writeCount).toBe(4);
    expect(writes.finalApiStateBeforeRecovery).toBe("ACCESS_ACTIVATED");
    expect(accounting).toMatchObject({ partialSessionWrites: 4, recoveryWrites: 1, totalFailedAttemptWrites: 5, successfulDemoSession: false });
  });

  it("truthfully records no offer, allocation, POD, HCS, release, or second session", () => {
    expect(evidence("run-summary.json")).toMatchObject({
      completedLiveDemo: false,
      carrierOfferPaymentOccurred: false,
      winnerAllocationOccurred: false,
      podOccurred: false,
      hcsMessagesOccurred: 0,
      freightReleaseOccurred: false,
      secondSessionCreated: false,
      readyForFrontendIntegrationFromThisAttempt: false,
    });
  });

  it("records the exact refund and terminal zero-balance state", () => {
    expect(evidence("refund-result.json")).toMatchObject({
      transactionId: "0.0.9197513@1785555797.105426636",
      refundedAmountAtomic: "20000",
      recipientAccountId: "0.0.9197513",
      finalContractState: "REFUNDED",
      finalTenderBalanceAtomic: "0",
      finalContractBalanceAtomic: "0",
      authorizationHashConsumed: true,
      additionalApplicationWrites: 1,
    });
  });

  it("keeps the demo topic empty and immutable proof evidence outside recovery evidence", () => {
    expect(evidence("final-contract-state.json")).toMatchObject({ demoTopicId: "0.0.9865212", demoTopicSequence: 0 });
    const source = readFileSync("scripts/recover-v2-operations-demo-refund.ts", "utf8");
    expect(source).not.toContain("TopicMessageSubmitTransaction");
    expect(source).not.toContain("TopicCreateTransaction");
  });

  it("keeps duplicate refund submission guarded by durable receipt identity", () => {
    const source = readFileSync("scripts/recover-v2-operations-demo-refund.ts", "utf8");
    expect(source).toContain("if (!journal.transactionId)");
    expect(source).toContain("authorizationHashUsed");
    expect(source).toContain("REFUND_NO_QUALIFIED_BID");
  });
});
