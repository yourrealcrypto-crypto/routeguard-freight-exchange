import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertSafeToStartWrites,
  AttemptStoreError,
  createPlannedAttempt,
  emptyMessageRecord,
  hasNetworkWrites,
  loadAttempt,
  persistAttempt,
  transitionAttempt,
} from "../src/hcs/attempt-store";
import { canonicalSha256 } from "../src/domain/canonical-hash";

const tenderHash = canonicalSha256({ t: 1 });

describe("HCS attempt store", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  function tmpFile(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "hcs-attempt-"));
    dirs.push(dir);
    return path.join(dir, "attempt.json");
  }

  it("atomically persists and reloads planned attempt", () => {
    const file = tmpFile();
    const planned = createPlannedAttempt({
      runId: "run-1",
      plannedTenderId: "tender-1",
      plannedTenderHash: tenderHash,
    });
    expect(planned.status).toBe("PLANNED");
    persistAttempt(planned, file);
    const loaded = loadAttempt(file);
    expect(loaded?.runId).toBe("run-1");
    expect(loaded?.status).toBe("PLANNED");
  });

  it("supports state transitions with patches", () => {
    let record = createPlannedAttempt({
      runId: "run-2",
      plannedTenderId: "tender-1",
      plannedTenderHash: tenderHash,
    });
    record = transitionAttempt(record, "TOPIC_CREATED", {
      topicId: "0.0.123",
      topicCreateTransactionId: "0.0.9197513@1.2",
    });
    expect(record.status).toBe("TOPIC_CREATED");
    expect(record.topicId).toBe("0.0.123");
    expect(hasNetworkWrites(record)).toBe(true);
  });

  it("existing SUCCESS attempt prevents new writes", () => {
    const success = transitionAttempt(
      createPlannedAttempt({
        runId: "run-ok",
        plannedTenderId: "t",
        plannedTenderHash: tenderHash,
      }),
      "SUCCESS",
      { finalResult: "ok" },
    );
    expect(() => assertSafeToStartWrites(success)).toThrow(AttemptStoreError);
    expect(() => assertSafeToStartWrites(success)).toThrow(/SUCCESS/);
  });

  it("nonterminal attempt with topic ID prevents new topic creation", () => {
    const mid = transitionAttempt(
      createPlannedAttempt({
        runId: "run-mid",
        plannedTenderId: "t",
        plannedTenderHash: tenderHash,
      }),
      "TOPIC_CREATED",
      { topicId: "0.0.999", topicCreateTransactionId: "0.0.9197513@9.9" },
    );
    expect(() => assertSafeToStartWrites(mid)).toThrow(/topicId/);
  });

  it("nonterminal attempt with message tx ids fails closed", () => {
    let record = createPlannedAttempt({
      runId: "run-msg",
      plannedTenderId: "t",
      plannedTenderHash: tenderHash,
    });
    const open = emptyMessageRecord("AUCTION_OPEN", "open");
    open.transactionId = "0.0.9197513@1.1";
    record = {
      ...record,
      messages: { ...record.messages, open },
    };
    expect(() => assertSafeToStartWrites(record)).toThrow(/transaction IDs/);
  });

  it("fresh or null attempt is safe to start", () => {
    expect(() => assertSafeToStartWrites(null)).not.toThrow();
    const planned = createPlannedAttempt({
      runId: "run-new",
      plannedTenderId: "t",
      plannedTenderHash: tenderHash,
    });
    expect(() => assertSafeToStartWrites(planned)).not.toThrow();
  });

  it("cannot transition out of terminal SUCCESS", () => {
    const success = transitionAttempt(
      createPlannedAttempt({
        runId: "run-t",
        plannedTenderId: "t",
        plannedTenderHash: tenderHash,
      }),
      "SUCCESS",
    );
    expect(() => transitionAttempt(success, "PLANNED")).toThrow(/terminal/);
  });
});
