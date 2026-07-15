import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileSystemReservationStore,
  InMemoryReservationStore,
  type ReservationStore,
  recoverInProgressState,
  serializeReservationRecord,
  toPersistedShape,
} from "../src/reservation/attempt-store";
import {
  computeCreationFingerprint,
  creationFingerprintFromRecord,
} from "../src/reservation/record-schema";
import {
  ReservationVersionConflictError,
  type ReservationRecord,
} from "../src/reservation/types";
import { createReservationOffer } from "../src/reservation/offer";
import { DEMO_WINNER_ACCOUNT } from "./fixtures/reservation-fixtures";

function minimalRecord(
  overrides: Partial<ReservationRecord> = {},
): ReservationRecord {
  const reservationId = overrides.reservationId ?? "res-store-1";
  const tenderId = overrides.tenderId ?? "t";
  const winningBidId = overrides.winningBidId ?? "b";
  const expiresAt = overrides.expiresAt ?? "2026-07-15T20:00:00.000Z";
  const createdAt = overrides.createdAt ?? "2026-07-15T19:00:00.000Z";
  const offer =
    overrides.offer ??
    createReservationOffer({
      reservationId,
      tenderId,
      winningBidId,
      payTo: overrides.winningCarrierAccount ?? DEMO_WINNER_ACCOUNT,
      expiresAt,
    });
  const base: ReservationRecord = {
    recordVersion: 1,
    reservationId,
    state: "OFFER_CREATED",
    tenderId,
    tenderVersion: 1,
    tenderHash: "sha256:" + "11".repeat(32),
    winningBidId,
    winningBidHash: "sha256:" + "22".repeat(32),
    winningCarrierId: "c",
    winningCarrierAccount: DEMO_WINNER_ACCOUNT,
    decisionManifestHash: "sha256:" + "33".repeat(32),
    evaluatedBidSetHash: "sha256:" + "44".repeat(32),
    hcsTopicId: "0.0.1",
    closeBarrierSequence: 4,
    closeBarrierConsensusTimestamp: "2026-07-15T18:58:17.944Z",
    creationFingerprint: "",
    proofTenderId: "t",
    proofManifestHash: "sha256:" + "33".repeat(32),
    offer,
    selected: null,
    attemptNumber: 0,
    paymentChallenge: null,
    paymentChallengeHash: null,
    paymentPayloadHash: null,
    facilitatorVerify: null,
    settleClaim: null,
    facilitatorSettle: null,
    transactionId: null,
    mirrorConfirmation: null,
    mirrorPoll: null,
    confirmationDeadline: null,
    routeReserved: null,
    webhookEvents: [],
    webhooks: [],
    hcsPublicationClaim: null,
    hcsEvidence: null,
    history: [],
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
    expiresAt,
    failureCode: null,
    failureReason: null,
  };
  const merged = { ...base, ...overrides, offer };
  if (!overrides.creationFingerprint) {
    merged.creationFingerprint = creationFingerprintFromRecord(merged);
  }
  return merged;
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
    await store.create(rec);
    const loaded = await store.get("res-store-1");
    expect(loaded?.state).toBe("OFFER_CREATED");
  });

  it("filesystem atomic write-then-rename", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "res-store-"));
    dirs.push(dir);
    const store = new FileSystemReservationStore(dir);
    const rec = minimalRecord({ state: "OFFER_CREATED" });
    await store.create(rec);
    const loaded = await store.get("res-store-1");
    expect(loaded?.state).toBe("OFFER_CREATED");
    const raw = readFileSync(path.join(dir, "res-store-1.json"), "utf8");
    expect(raw).toContain("OFFER_CREATED");
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

  it("recovery: FACILITATOR_SETTLED with tx id stays confirmable for resume polling", () => {
    // Phase 6A.2B: authoritative transaction ID means resumePaymentConfirmation
    // can poll Mirror — do not force MANUAL_REVIEW and never re-settle.
    const rec = minimalRecord({
      state: "FACILITATOR_SETTLED",
      transactionId: "0.0.1@1.2",
    });
    const recovered = recoverInProgressState(rec);
    expect(recovered.state).toBe("FACILITATOR_SETTLED");
    expect(recovered.transactionId).toBe("0.0.1@1.2");
  });

  it("recovery: FACILITATOR_SETTLED without tx id → MANUAL_REVIEW", () => {
    const rec = minimalRecord({
      state: "FACILITATOR_SETTLED",
      transactionId: null,
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

  it("missing/malformed recordVersion fails closed on read", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "res-ver-"));
    dirs.push(dir);
    const { recordVersion: _omit, ...noVersion } = minimalRecord();
    writeFileSync(
      path.join(dir, "res-store-1.json"),
      JSON.stringify(noVersion),
      "utf8",
    );
    const store = new FileSystemReservationStore(dir);
    await expect(store.get("res-store-1")).rejects.toThrow(
      /recordVersion/i,
    );
  });
});

// -------------------------------------------------------------------------
// Phase 2 — versioned store (CAS) + cross-process filesystem exclusion.
// -------------------------------------------------------------------------

describe("Reservation store — record version / CAS", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function fsStore(): FileSystemReservationStore {
    const dir = mkdtempSync(path.join(tmpdir(), "res-cas-"));
    dirs.push(dir);
    return new FileSystemReservationStore(dir);
  }

  const stores: Array<[string, () => ReservationStore]> = [
    ["memory", () => new InMemoryReservationStore()],
    ["filesystem", () => fsStore()],
  ];

  for (const [label, make] of stores) {
    it(`${label}: initial persisted version is explicit (1)`, async () => {
      const store = make();
      const created = await store.create(minimalRecord({ recordVersion: 99 }));
      // Store owns the version — caller cannot control it.
      expect(created.recordVersion).toBe(1);
    });

    it(`${label}: revision increments exactly once per mutation`, async () => {
      const store = make();
      let rec = await store.create(minimalRecord());
      expect(rec.recordVersion).toBe(1);
      rec = await store.compareAndSet("res-store-1", 1, {
        ...rec,
        updatedAt: "2026-07-15T19:00:01.000Z",
        failureCode: "probe-1",
      });
      expect(rec.recordVersion).toBe(2);
      rec = await store.compareAndSet("res-store-1", 2, {
        ...rec,
        updatedAt: "2026-07-15T19:00:02.000Z",
        failureCode: "probe-2",
      });
      expect(rec.recordVersion).toBe(3);
    });

    it(`${label}: stale expectedVersion is rejected with a typed conflict`, async () => {
      const store = make();
      const rec = await store.create(minimalRecord());
      await store.compareAndSet("res-store-1", 1, {
        ...rec,
        updatedAt: "2026-07-15T19:00:01.000Z",
        failureCode: "first",
      });
      // rec still has version 1 (stale).
      await expect(
        store.compareAndSet("res-store-1", 1, {
          ...rec,
          updatedAt: "2026-07-15T19:00:02.000Z",
          failureCode: "stale",
        }),
      ).rejects.toBeInstanceOf(ReservationVersionConflictError);
    });

    it(`${label}: newer state cannot be overwritten by a stale writer`, async () => {
      const store = make();
      const rec = await store.create(minimalRecord());
      await store.compareAndSet("res-store-1", 1, {
        ...rec,
        updatedAt: "2026-07-15T19:00:01.000Z",
        failureCode: "newer",
      });
      await expect(
        store.compareAndSet("res-store-1", 1, {
          ...rec,
          updatedAt: "2026-07-15T19:00:02.000Z",
          failureCode: "stale",
        }),
      ).rejects.toBeInstanceOf(ReservationVersionConflictError);
      const current = await store.get("res-store-1");
      expect(current?.failureCode).toBe("newer");
      expect(current?.recordVersion).toBe(2);
    });

    it(`${label}: two writers, same expected version — exactly one succeeds`, async () => {
      const store = make();
      const rec = await store.create(minimalRecord());
      const results = await Promise.allSettled([
        store.compareAndSet("res-store-1", 1, {
          ...rec,
          updatedAt: "2026-07-15T19:00:01.000Z",
          failureCode: "writer-a",
        }),
        store.compareAndSet("res-store-1", 1, {
          ...rec,
          updatedAt: "2026-07-15T19:00:02.000Z",
          failureCode: "writer-b",
        }),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(
        (rejected[0] as PromiseRejectedResult).reason,
      ).toBeInstanceOf(ReservationVersionConflictError);
      const current = await store.get("res-store-1");
      expect(current?.recordVersion).toBe(2);
    });

    it(`${label}: recordVersion is not caller-controlled via compareAndSet`, async () => {
      const store = make();
      const rec = await store.create(minimalRecord());
      const updated = await store.compareAndSet("res-store-1", 1, {
        ...rec,
        recordVersion: 500,
        updatedAt: "2026-07-15T19:00:01.000Z",
        failureCode: "owned",
      });
      expect(updated.recordVersion).toBe(2);
    });
  }
});

describe("FileSystem store — cross-process lock", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function makeDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "res-lock-"));
    dirs.push(dir);
    return dir;
  }

  it("lock released after a successful mutation", async () => {
    const dir = makeDir();
    const store = new FileSystemReservationStore(dir);
    await store.create(minimalRecord());
    expect(existsSync(path.join(dir, "res-store-1.lock"))).toBe(false);
    const rec = await store.get("res-store-1");
    await store.compareAndSet("res-store-1", rec!.recordVersion, {
      ...rec!,
      updatedAt: "2026-07-15T19:00:01.000Z",
      failureCode: "lock-probe",
    });
    expect(existsSync(path.join(dir, "res-store-1.lock"))).toBe(false);
  });

  it("lock released after a thrown (conflict) error", async () => {
    const dir = makeDir();
    const store = new FileSystemReservationStore(dir);
    const rec = await store.create(minimalRecord());
    await expect(
      store.compareAndSet("res-store-1", 999, {
        ...rec,
        updatedAt: "2026-07-15T19:00:01.000Z",
        failureCode: "conflict-probe",
      }),
    ).rejects.toBeInstanceOf(ReservationVersionConflictError);
    // Lock must not be left behind after the thrown error.
    expect(existsSync(path.join(dir, "res-store-1.lock"))).toBe(false);
  });

  it("a live lock held by another writer fails closed (never stolen)", async () => {
    const dir = makeDir();
    const store = new FileSystemReservationStore(dir);
    const rec = await store.create(minimalRecord());
    // Simulate another process holding the lock.
    const lockPath = path.join(dir, "res-store-1.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({
        v: 1,
        pid: 999999,
        host: "other-host",
        token: "other-token",
        acquiredAt: new Date().toISOString(),
      }),
      "utf8",
    );
    await expect(
      store.compareAndSet("res-store-1", rec.recordVersion, {
        ...rec,
        state: "OPTION_SELECTED",
      }),
    ).rejects.toThrow(/LOCK_HELD|locked/i);
    // The other process's lock must remain untouched.
    expect(readFileSync(lockPath, "utf8")).toContain("other-token");
  });

  it("malformed/partial lock metadata fails closed", async () => {
    const dir = makeDir();
    const store = new FileSystemReservationStore(dir);
    const rec = await store.create(minimalRecord());
    const lockPath = path.join(dir, "res-store-1.lock");
    writeFileSync(lockPath, "", "utf8"); // empty/partial
    await expect(
      store.compareAndSet("res-store-1", rec.recordVersion, {
        ...rec,
        state: "OPTION_SELECTED",
      }),
    ).rejects.toThrow(/LOCK_AMBIGUOUS|manual review/i);
  });

  it("a leftover partial temp file never replaces the current record", async () => {
    const dir = makeDir();
    const store = new FileSystemReservationStore(dir);
    await store.create(minimalRecord({ state: "OFFER_CREATED" }));
    // Drop a partial temp file into the directory.
    writeFileSync(
      path.join(dir, `.res-store-1.${process.pid}.partial.tmp`),
      "{ partial-not-json",
      "utf8",
    );
    const current = await store.get("res-store-1");
    expect(current?.state).toBe("OFFER_CREATED");
    expect(current?.recordVersion).toBe(1);
  });
});
