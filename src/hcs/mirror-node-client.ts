/**
 * Hedera Testnet Mirror Node client for HCS topic messages.
 * Read-only. Authoritative sequence + consensus timestamps.
 */

import { isSafePositiveInteger } from "../domain/money";
import { isUtcIsoTimestamp } from "../domain/time";
import {
  decodeHcsEnvelope,
  decodeHcsEnvelopeFromBase64,
  envelopeHash,
} from "./message-envelope";
import {
  HEDERA_TESTNET_MIRROR_NODE,
  type HcsEnvelope,
  type ObservedHcsMessage,
} from "./types";

export class MirrorNodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MirrorNodeError";
  }
}

export type MirrorTopicMessage = {
  consensus_timestamp?: string;
  topic_id?: string;
  message?: string;
  sequence_number?: number | string;
  running_hash?: string;
  running_hash_version?: number;
  chunk_info?: unknown;
  payer_account_id?: string;
};

export type MirrorTopicMessagesResponse = {
  messages?: MirrorTopicMessage[];
  links?: { next?: string | null };
};

export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/**
 * Convert Mirror Node consensus_timestamp (seconds.nanos) to UTC ISO-8601
 * with up to 9 fractional digits (preserves nanosecond precision).
 */
export function mirrorTimestampToUtcIso(mirrorTs: string): string {
  const match = /^(\d+)\.(\d{1,9})$/.exec(mirrorTs.trim());
  if (!match) {
    // Already ISO?
    if (isUtcIsoTimestamp(mirrorTs)) {
      return mirrorTs;
    }
    throw new MirrorNodeError(
      `Invalid Mirror consensus timestamp: ${mirrorTs}`,
    );
  }
  const seconds = Number(match[1]);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new MirrorNodeError(
      `Invalid Mirror consensus seconds: ${mirrorTs}`,
    );
  }
  const nanos = match[2]!.padEnd(9, "0").slice(0, 9);
  const d = new Date(seconds * 1000);
  if (Number.isNaN(d.getTime())) {
    throw new MirrorNodeError(
      `Unrepresentable Mirror consensus timestamp: ${mirrorTs}`,
    );
  }
  const yyyy = String(d.getUTCFullYear()).padStart(4, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  // Trim trailing zeros in fractional part but keep at least one digit if non-zero.
  let frac = nanos;
  while (frac.length > 1 && frac.endsWith("0")) {
    frac = frac.slice(0, -1);
  }
  if (frac === "000000000" || frac === "0") {
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}Z`;
  }
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}.${frac}Z`;
}

export function parseSequenceNumber(value: number | string | undefined): number {
  if (typeof value === "number") {
    if (!isSafePositiveInteger(value) && value !== 0) {
      throw new MirrorNodeError(`Invalid sequence number: ${value}`);
    }
    return value;
  }
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) {
      throw new MirrorNodeError(`Sequence out of safe integer range: ${value}`);
    }
    return n;
  }
  throw new MirrorNodeError(`Missing or invalid sequence_number: ${String(value)}`);
}

export type MirrorNodeClientOptions = {
  baseUrl?: string;
  fetchImpl?: FetchLike;
};

export class MirrorNodeClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: MirrorNodeClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? HEDERA_TESTNET_MIRROR_NODE).replace(
      /\/$/,
      "",
    );
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  }

  async getJson<T>(apiPath: string): Promise<T> {
    const url = apiPath.startsWith("http")
      ? apiPath
      : `${this.baseUrl}${apiPath.startsWith("/") ? "" : "/"}${apiPath}`;
    const response = await this.fetchImpl(url, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new MirrorNodeError(
        `Mirror Node ${apiPath} returned HTTP ${response.status}`,
      );
    }
    return (await response.json()) as T;
  }

  /**
   * Retrieve all topic messages in ascending sequence order with pagination.
   */
  async fetchAllTopicMessages(
    topicId: string,
    options: {
      limit?: number;
      maxPages?: number;
    } = {},
  ): Promise<MirrorTopicMessage[]> {
    const limit = options.limit ?? 100;
    const maxPages = options.maxPages ?? 50;
    const collected: MirrorTopicMessage[] = [];
    let nextPath: string | null =
      `/api/v1/topics/${encodeURIComponent(topicId)}/messages?order=asc&limit=${limit}`;

    for (let page = 0; page < maxPages && nextPath; page++) {
      const payload: MirrorTopicMessagesResponse =
        await this.getJson<MirrorTopicMessagesResponse>(nextPath);
      const batch: MirrorTopicMessage[] = payload.messages ?? [];
      collected.push(...batch);
      const next: string | null | undefined = payload.links?.next;
      if (next && typeof next === "string" && next.length > 0) {
        // Mirror may return absolute or relative next links.
        if (next.startsWith("http")) {
          nextPath = next;
        } else {
          nextPath = next.startsWith("/") ? next : `/${next}`;
        }
      } else {
        nextPath = null;
      }
      if (batch.length === 0) {
        break;
      }
    }

    if (nextPath) {
      throw new MirrorNodeError(
        `Pagination exceeded maxPages=${maxPages} for topic ${topicId}`,
      );
    }
    return collected;
  }

  /**
   * Poll until at least minCount messages are present or timeout.
   */
  async waitForTopicMessages(
    topicId: string,
    minCount: number,
    options: {
      timeoutMs?: number;
      pollIntervalMs?: number;
    } = {},
  ): Promise<MirrorTopicMessage[]> {
    const timeoutMs = options.timeoutMs ?? 90_000;
    const pollIntervalMs = options.pollIntervalMs ?? 1500;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const messages = await this.fetchAllTopicMessages(topicId);
      if (messages.length >= minCount) {
        return messages;
      }
      await sleep(pollIntervalMs);
    }
    throw new MirrorNodeError(
      `Timed out waiting for ${minCount} messages on topic ${topicId}`,
    );
  }

  /**
   * Poll for a specific sequence number to appear.
   */
  async waitForSequence(
    topicId: string,
    sequence: number,
    options: {
      timeoutMs?: number;
      pollIntervalMs?: number;
    } = {},
  ): Promise<ObservedHcsMessage> {
    const timeoutMs = options.timeoutMs ?? 90_000;
    const pollIntervalMs = options.pollIntervalMs ?? 1500;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const messages = await this.fetchAllTopicMessages(topicId);
      for (const raw of messages) {
        const seq = parseSequenceNumber(raw.sequence_number);
        if (seq === sequence) {
          return this.toObserved(topicId, raw);
        }
      }
      await sleep(pollIntervalMs);
    }
    throw new MirrorNodeError(
      `Timed out waiting for sequence ${sequence} on topic ${topicId}`,
    );
  }

  /**
   * After a submit, poll until a new message with matching envelope hash appears.
   */
  async waitForEnvelopeHash(
    topicId: string,
    expectedEnvelopeHash: string,
    options: {
      minSequence?: number;
      timeoutMs?: number;
      pollIntervalMs?: number;
    } = {},
  ): Promise<ObservedHcsMessage> {
    const timeoutMs = options.timeoutMs ?? 90_000;
    const pollIntervalMs = options.pollIntervalMs ?? 1500;
    const minSequence = options.minSequence ?? 1;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const messages = await this.fetchAllTopicMessages(topicId);
      for (const raw of messages) {
        const seq = parseSequenceNumber(raw.sequence_number);
        if (seq < minSequence) continue;
        try {
          const observed = this.toObserved(topicId, raw);
          if (observed.envelopeHash === expectedEnvelopeHash) {
            return observed;
          }
        } catch {
          // skip undecodable during lag
        }
      }
      await sleep(pollIntervalMs);
    }
    throw new MirrorNodeError(
      `Timed out waiting for envelope ${expectedEnvelopeHash} on topic ${topicId}`,
    );
  }

  toObserved(topicId: string, raw: MirrorTopicMessage): ObservedHcsMessage {
    if (!raw.message || typeof raw.message !== "string") {
      throw new MirrorNodeError("Mirror message missing base64 body");
    }
    if (!raw.consensus_timestamp || typeof raw.consensus_timestamp !== "string") {
      throw new MirrorNodeError("Mirror message missing consensus_timestamp");
    }
    const sequence = parseSequenceNumber(raw.sequence_number);
    if (sequence < 1) {
      throw new MirrorNodeError(
        `Sequence number must be >= 1 (got ${sequence})`,
      );
    }
    const envelope = decodeHcsEnvelopeFromBase64(raw.message);
    const hash = envelopeHash(envelope);
    const consensusTimestamp = mirrorTimestampToUtcIso(raw.consensus_timestamp);
    const observedTopic = raw.topic_id ?? topicId;
    return {
      topicId: observedTopic,
      sequence,
      consensusTimestamp,
      mirrorConsensusTimestamp: raw.consensus_timestamp,
      envelope,
      envelopeHash: hash,
    };
  }

  decodeAll(topicId: string, rawMessages: MirrorTopicMessage[]): ObservedHcsMessage[] {
    return rawMessages.map((m) => this.toObserved(topicId, m));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Decode base64 message body to envelope (exported for tests). */
export function decodeBase64Message(base64: string): HcsEnvelope {
  return decodeHcsEnvelopeFromBase64(base64);
}

export function decodeUtf8Message(utf8: string): HcsEnvelope {
  return decodeHcsEnvelope(utf8);
}
