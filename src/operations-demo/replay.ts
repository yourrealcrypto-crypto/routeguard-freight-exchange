import { readFileSync } from "node:fs";
import path from "node:path";

import { canonicalSha256 } from "../domain/canonical-hash";
import { DemoError } from "./errors";
import { IMMUTABLE_PROOF_CONTRACT_ID, IMMUTABLE_PROOF_TOPIC_ID } from "./constants";

type Json = Record<string, any>;

export type CompletedProofReplay = {
  readonly mode: "REPLAY";
  readonly immutable: true;
  readonly networkWrites: 0;
  readonly syntheticBusinessData: true;
  readonly contractId: typeof IMMUTABLE_PROOF_CONTRACT_ID;
  readonly topicId: typeof IMMUTABLE_PROOF_TOPIC_ID;
  readonly accessTransactions: readonly string[];
  readonly escrowTransactions: readonly string[];
  readonly hcsSequence: readonly { sequenceNumber: number; messageType: string; transactionId: string | null; payloadHash: string }[];
  readonly releaseTransactionId: string;
  readonly finalState: "RELEASED";
  readonly lockedAmountAtomic: "0";
  readonly evidenceHash: string;
};

export class CompletedReplayAdapter {
  constructor(private readonly evidenceRoot = path.resolve("evidence", "v2")) {}

  private read(relative: string): Json {
    try { return JSON.parse(readFileSync(path.join(this.evidenceRoot, relative), "utf8")) as Json; }
    catch { throw new DemoError("DEMO_CONFIG_INVALID", "immutable replay evidence is missing or invalid", 503); }
  }

  load(): CompletedProofReplay {
    const access = this.read("access/run-summary.json");
    const escrow = this.read("escrow/run-summary.json");
    const pod = this.read("pod/run-summary.json");
    const release = this.read("release/run-summary.json");
    const finalState = this.read("release/contract-final-state.json");
    const sequence = this.read("release/hcs-complete-sequence.json");
    if (
      access.status !== "SUCCESS" || access.SUCCESSFUL_X402_SETTLEMENTS !== 2 ||
      escrow.status !== "SUCCESS" || escrow.contractId !== IMMUTABLE_PROOF_CONTRACT_ID ||
      pod.status !== "SUCCESS" || pod.hcs?.topicId !== IMMUTABLE_PROOF_TOPIC_ID ||
      release.status !== "SUCCESS" || finalState.finalState !== "RELEASED" || finalState.tenderLockedBalanceAtomic !== "0" ||
      sequence.orderingCorrect !== true || sequence.allSameTopic !== true || sequence.messages?.length !== 5
    ) throw new DemoError("DEMO_CONFIG_INVALID", "immutable replay evidence failed validation", 503);
    const expected = ["POD_SUBMITTED", "POD_ADVISORY_ANCHORED", "POD_REVIEW_ACTION", "ESCROW_RELEASED", "TENDER_COMPLETED"];
    if (!expected.every((type, index) => sequence.messages[index]?.messageType === type && sequence.messages[index]?.sequenceNumber === index + 1)) {
      throw new DemoError("DEMO_CONFIG_INVALID", "immutable HCS sequence failed validation", 503);
    }
    const txBySequence = new Map<number, string>();
    for (const item of [...pod.hcs.messages, ...release.hcs.messages]) txBySequence.set(item.sequenceNumber, item.transactionId);
    const replayCore = {
      mode: "REPLAY" as const,
      immutable: true as const,
      networkWrites: 0 as const,
      syntheticBusinessData: true as const,
      contractId: IMMUTABLE_PROOF_CONTRACT_ID,
      topicId: IMMUTABLE_PROOF_TOPIC_ID,
      accessTransactions: [access.activationTransactionId, access.bidTransactionId] as readonly string[],
      escrowTransactions: [escrow.transactions.registration, escrow.transactions.allowance, escrow.transactions.funding, escrow.transactions.allocation] as readonly string[],
      hcsSequence: sequence.messages.map((message: Json) => ({
        sequenceNumber: message.sequenceNumber as number,
        messageType: message.messageType as string,
        transactionId: txBySequence.get(message.sequenceNumber) ?? null,
        payloadHash: message.payloadHash as string,
      })),
      releaseTransactionId: release.release.transactionId as string,
      finalState: "RELEASED" as const,
      lockedAmountAtomic: "0" as const,
    };
    return Object.freeze({ ...replayCore, evidenceHash: canonicalSha256(replayCore) });
  }
}
