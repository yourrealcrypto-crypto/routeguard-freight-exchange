/**
 * Mocked network transports for offline dry-run / unit tests.
 * Zero real network writes.
 */

import { randomBytes } from "node:crypto";

import {
  envelopeHash,
  serializeEnvelopeForSubmit,
} from "../hcs/message-envelope";
import type { HcsEnvelope, ObservedHcsMessage } from "../hcs/types";
import { FinalDemoError } from "./errors";
import { observedFromEnvelope } from "./reconciliation";
import { HISTORICAL_PHASE5_TOPIC_ID } from "./constants";

export type MockTopicCreateResult = {
  topicId: string;
  transactionId: string;
  receiptStatus: "SUCCESS";
  topicMemo: string;
  createdAt: string;
};

export type MockSubmitResult = {
  topicId: string;
  sequence: number;
  transactionId: string;
  consensusTimestamp: string;
  envelopeHash: string;
  receiptStatus: "SUCCESS";
};

export type MockTopicState = {
  topicId: string;
  topicMemo: string;
  topicCreateTransactionId: string;
  messages: ObservedHcsMessage[];
  createCount: number;
  submitCount: number;
};

/**
 * In-memory HCS topic simulator for dry-run.
 */
export class MockFinalDemoNetwork {
  createCount = 0;
  submitCount = 0;
  paymentSubmitCount = 0;
  private topics = new Map<string, MockTopicState>();
  private nextTopicNum = 9_700_000;
  clockMs: number;
  private forceTopicCreateAmbiguous = false;
  private forceSubmitAmbiguousLabel: string | null = null;

  constructor(options?: { clockMs?: number }) {
    this.clockMs = options?.clockMs ?? Date.now();
  }

  getClockMs(): number {
    return this.clockMs;
  }

  setClock(ms: number): void {
    this.clockMs = ms;
  }

  advanceMs(ms: number): void {
    this.clockMs += ms;
  }

  nowIso(): string {
    return new Date(this.clockMs).toISOString();
  }

  nowIsoNanos(): string {
    // Synthetic nanosecond-looking timestamp for consensus
    const base = new Date(this.clockMs).toISOString().replace("Z", "");
    const frac = String(this.clockMs % 1000).padStart(3, "0");
    return `${base.slice(0, -4)}${frac}123456Z`.replace(
      /\.\d+123456Z$/,
      `.${frac}123456Z`,
    );
  }

  consensusIso(): string {
    const d = new Date(this.clockMs);
    const iso = d.toISOString();
    // Ensure Z with ms
    if (iso.endsWith("Z")) {
      return iso.replace("Z", "123456Z").replace(/\.(\d{3})123456Z$/, ".$1123456Z");
    }
    return iso;
  }

  /** Stable synthetic consensus timestamp from clock. */
  consensusTimestamp(): string {
    const d = new Date(this.clockMs);
    const pad = (n: number, w: number) => String(n).padStart(w, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}T${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}.${pad(d.getUTCMilliseconds(), 3)}456789Z`;
  }

  setForceTopicCreateAmbiguous(v: boolean): void {
    this.forceTopicCreateAmbiguous = v;
  }

  setForceSubmitAmbiguous(label: string | null): void {
    this.forceSubmitAmbiguousLabel = label;
  }

  async createTopic(memo: string): Promise<MockTopicCreateResult> {
    if (this.forceTopicCreateAmbiguous) {
      throw new FinalDemoError(
        "Topic create outcome ambiguous (mock)",
        "TOPIC_CREATE_AMBIGUOUS",
      );
    }
    this.createCount += 1;
    if (this.createCount > 1) {
      throw new FinalDemoError(
        "Mock network refuses second topic create",
        "TOPIC_CREATE_BUDGET",
      );
    }
    const topicId = `0.0.${this.nextTopicNum++}`;
    if (topicId === HISTORICAL_PHASE5_TOPIC_ID) {
      throw new FinalDemoError("Mock refused historical topic id", "HISTORICAL_TOPIC_FORBIDDEN");
    }
    const createdAt = this.nowIso();
    const transactionId = `0.0.9197513@${Math.floor(this.clockMs / 1000)}.${randomBytes(4).readUInt32BE(0) % 1_000_000_000}`;
    this.topics.set(topicId, {
      topicId,
      topicMemo: memo,
      topicCreateTransactionId: transactionId,
      messages: [],
      createCount: 1,
      submitCount: 0,
    });
    this.advanceMs(50);
    return {
      topicId,
      transactionId,
      receiptStatus: "SUCCESS",
      topicMemo: memo,
      createdAt,
    };
  }

  async submitMessage(input: {
    topicId: string;
    envelope: HcsEnvelope;
    label?: string;
  }): Promise<MockSubmitResult> {
    if (
      input.label &&
      this.forceSubmitAmbiguousLabel === input.label
    ) {
      throw new FinalDemoError(
        `Submit ambiguous for ${input.label}`,
        "HCS_SUBMIT_AMBIGUOUS",
      );
    }
    if (input.topicId === HISTORICAL_PHASE5_TOPIC_ID) {
      throw new FinalDemoError(
        "Historical topic forbidden",
        "HISTORICAL_TOPIC_FORBIDDEN",
      );
    }
    const topic = this.topics.get(input.topicId);
    if (!topic) {
      throw new FinalDemoError("Unknown mock topic", "WRONG_TOPIC");
    }
    this.submitCount += 1;
    topic.submitCount += 1;
    const sequence = topic.messages.length + 1;
    const hash = envelopeHash(input.envelope);
    const serialized = serializeEnvelopeForSubmit(input.envelope);
    void serialized;
    this.advanceMs(120);
    const consensusTimestamp = this.consensusTimestamp();
    const transactionId = `0.0.9197513@${Math.floor(this.clockMs / 1000)}.${100_000_000 + sequence}`;
    const observed = observedFromEnvelope({
      topicId: input.topicId,
      sequence,
      envelope: input.envelope,
      envelopeHash: hash,
      consensusTimestamp,
      transactionId,
    });
    topic.messages.push(observed);
    return {
      topicId: input.topicId,
      sequence,
      transactionId,
      consensusTimestamp,
      envelopeHash: hash,
      receiptStatus: "SUCCESS",
    };
  }

  listMessages(topicId: string): ObservedHcsMessage[] {
    const topic = this.topics.get(topicId);
    if (!topic) return [];
    return [...topic.messages];
  }

  getTopic(topicId: string): MockTopicState | undefined {
    return this.topics.get(topicId);
  }

}
