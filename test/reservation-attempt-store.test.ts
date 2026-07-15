import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileSystemReservationStore,
  InMemoryReservationStore,
  recoverInProgressState,
  serializeReservationRecord,
  toPersistedShape,
} from "../src/reservation/attempt-store";
import type { ReservationRecord } from "../src/reservation/types";
import { createReservationOffer } from "../src/reservation/offer";
import { DEMO_WINNER_ACCOUNT } from "./fixtures/reservation-fixtures";

function minimalRecord(
  overrides: Partial<ReservationRecord> = {},
): ReservationRecord {
  const offer = createReservationOffer({
    reservationId: "res-store-1",
    tenderId: "t",
    winningBidId: "b",
    payTo: DEMO_WINNER_ACCOUNT,
    expiresAt: "2026-07-15T20:00:00.000Z",
  });
  return {
    reservationId: "res-store-1",
    state: "OFFER_CREATED",
    tenderId: "t",
    tenderVersion: 1,
    tenderHash: "sha256:" + "11".repeat(32),
    winningBidId: "b",
    winningBidHash: "sha256:" + "22".repeat(32),
    winningCarrierId: "c",
    winningCarrierAccount: DEMO_WINNER_ACCOUNT,
    decisionManifestHash: "sha256:" + "33".repeat(32),
    evaluatedBidSetHash: "sha256:" + "44".repeat(32),
    hcsTopicId: "0.0.1",
    closeBarrierSequence: 4,
    closeBarrierConsensusTimestamp: "2026-07-15T18:58:17.944Z",
    proofTenderId: "t",
    proofManifestHash: "sha256:" + "33".repeat(32),
    offer,
    selected: null,
    attemptNumber: 0,
    paymentChallengeHash: null,
    paymentPayloadHash: null,
    facilitatorVerify: null,
    facilitatorSettle: null,
    transactionId: null,
    mirrorConfirmation: null,
    confirmationDeadline: null,
    routeReserved: null,
    webhooks: [],
    hcsEvidence: null,
    history: [],
    createdAt: "2026-07-15T19:00:00.000Z",
    updatedAt: "2026-07-15T19:00:00.000Z",
    expiresAt: "2026-07-15T20:00:00.000Z",
    failureCode: null,
    failureReason: null,
    ...overrides,
  };
}

describe("Reservation attempt store", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("in-memory put/get is durable for session", async () => {
    const store = new InMemoryReservationStore();
    const rec = minimalRecord();
    await store.put(rec);
    const loaded = await store.get("res-store-1");
    expect(loaded?.state).toBe("OFFER_CREATED");
  });

  it("filesystem atomic write-then-rename", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "res-store-"));
    dirs.push(dir);
    const store = new FileSystemReservationStore(dir);
    const rec = minimalRecord({ state: "PAYMENT_SUBMISSION_STARTED" });
    await store.put(rec);
    const loaded = await store.get("res-store-1");
    expect(loaded?.state).toBe("PAYMENT_SUBMISSION_STARTED");
    const raw = readFileSync(path.join(dir, "res-store-1.json"), "utf8");
    expect(raw).toContain("PAYMENT_SUBMISSION_STARTED");
    expect(raw).not.toContain("_closureProof");
  });

  it("toPersistedShape strips proof handle", () => {
    const rec = minimalRecord({
      _closureProof: { integrityOk: true } as never,
    });
    const persisted = toPersistedShape(rec);
    expect("_closureProof" in persisted).toBe(false);
    expect(serializeReservationRecord(rec)).not.toContain("_closureProof");
  });

  it("recovery: PAYMENT_SUBMISSION_STARTED → MANUAL_REVIEW_REQUIRED", () => {
    const rec = minimalRecord({ state: "PAYMENT_SUBMISSION_STARTED" });
    const recovered = recoverInProgressState(rec);
    expect(recovered.state).toBe("MANUAL_REVIEW_REQUIRED");
    expect(recovered.failureCode).toBe("AMBIGUOUS_SUBMISSION");
  });

  it("recovery: FACILITATOR_SETTLED without mirror → MANUAL_REVIEW", () => {
    const rec = minimalRecord({
      state: "FACILITATOR_SETTLED",
      transactionId: "0.0.1@1.2",
    });
    const recovered = recoverInProgressState(rec);
    expect(recovered.state).toBe("MANUAL_REVIEW_REQUIRED");
  });

  it("recovery: FACILITATOR_SETTLED with mirror FAILED → CONFIRMATION_FAILED", () => {
    const rec = minimalRecord({
      state: "FACILITATOR_SETTLED",
      transactionId: "0.0.1@1.2",
    });
    const recovered = recoverInProgressState(rec, {
      mirror: { status: "FAILED" },
    });
    expect(recovered.state).toBe("CONFIRMATION_FAILED");
  });

  it("corrupt filesystem JSON fails closed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "res-corrupt-"));
    dirs.push(dir);
    writeFileSync(path.join(dir, "res-store-1.json"), "{not-json", "utf8");
    const store = new FileSystemReservationStore(dir);
    await expect(store.get("res-store-1")).rejects.toThrow(/Corrupt|manual/i);
  });
});
