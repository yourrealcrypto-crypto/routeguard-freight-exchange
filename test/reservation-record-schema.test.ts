/**
 * Phase 6A.2C — strict persisted record schema, creation fingerprint, API boundaries.
 */

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileSystemReservationStore } from "../src/reservation/attempt-store";
import {
  assertValidPersistedReservationRecord,
  computeCreationFingerprint,
  creationFingerprintFromRecord,
  CorruptReservationRecordError,
  PayReservationBodySchema,
  SelectReservationBodySchema,
} from "../src/reservation/record-schema";
import { createReservationApp } from "../src/reservation/routes";
import { publicReservationView } from "../src/reservation/reservation-service";
import {
  buildService,
  createAndSelect,
  createReservationInputFromBundle,
  defaultMirrorSuccess,
  DEMO_PAYER_ACCOUNT,
} from "./reservation-helpers";
import { DEMO_WINNER_ACCOUNT } from "./fixtures/reservation-fixtures";
import { createReservationOffer } from "../src/reservation/offer";

function baseOffer(reservationId = "res-schema-1") {
  return createReservationOffer({
    reservationId,
    tenderId: "tender-1",
    winningBidId: "bid-1",
    payTo: DEMO_WINNER_ACCOUNT,
    expiresAt: "2026-07-15T20:00:00.000Z",
  });
}

function validOfferCreated(reservationId = "res-schema-1") {
  const offer = baseOffer(reservationId);
  const rec = {
    recordVersion: 1,
    reservationId,
    state: "OFFER_CREATED" as const,
    tenderId: "tender-1",
    tenderVersion: 1,
    tenderHash: "sha256:" + "11".repeat(32),
    winningBidId: "bid-1",
    winningBidHash: "sha256:" + "22".repeat(32),
    winningCarrierId: "carrier-1",
    winningCarrierAccount: DEMO_WINNER_ACCOUNT,
    decisionManifestHash: "sha256:" + "33".repeat(32),
    evaluatedBidSetHash: "sha256:" + "44".repeat(32),
    hcsTopicId: "0.0.9587459",
    closeBarrierSequence: 4,
    closeBarrierConsensusTimestamp: "2026-07-15T18:58:17.944Z",
    creationFingerprint: "",
    proofTenderId: "tender-1",
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
    createdAt: "2026-07-15T19:00:00.000Z",
    updatedAt: "2026-07-15T19:00:00.000Z",
    expiresAt: "2026-07-15T20:00:00.000Z",
    failureCode: null,
    failureReason: null,
  };
  rec.creationFingerprint = creationFingerprintFromRecord(rec);
  return rec;
}

describe("Persisted record schema (Phase 6A.2C)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("accepts a valid OFFER_CREATED record", () => {
    const rec = validOfferCreated();
    expect(() =>
      assertValidPersistedReservationRecord(rec, rec.reservationId),
    ).not.toThrow();
  });

  it("unknown state rejected", () => {
    const rec = { ...validOfferCreated(), state: "NOT_A_STATE" };
    expect(() =>
      assertValidPersistedReservationRecord(rec, rec.reservationId),
    ).toThrow(/state|CORRUPT/i);
  });

  it("invalid recordVersion rejected", () => {
    const rec = { ...validOfferCreated(), recordVersion: 0 };
    expect(() =>
      assertValidPersistedReservationRecord(rec, rec.reservationId),
    ).toThrow(/recordVersion/i);
  });

  it("path traversal reservationId rejected", () => {
    expect(() =>
      assertValidPersistedReservationRecord(
        { ...validOfferCreated(), reservationId: "../etc/passwd" },
        "../etc/passwd",
      ),
    ).toThrow(/path|filesystem|INVALID/i);
  });

  it("invalid hash rejected", () => {
    const rec = { ...validOfferCreated(), tenderHash: "not-a-hash" };
    expect(() =>
      assertValidPersistedReservationRecord(rec, rec.reservationId),
    ).toThrow(/hash/i);
  });

  it("invalid timestamp rejected", () => {
    const rec = { ...validOfferCreated(), createdAt: "yesterday" };
    expect(() =>
      assertValidPersistedReservationRecord(rec, rec.reservationId),
    ).toThrow(/timestamp|UTC/i);
  });

  it("challenge without selection rejected", () => {
    const rec = {
      ...validOfferCreated(),
      paymentChallenge: {
        x402Version: 2 as const,
        scheme: "exact" as const,
        network: "hedera:testnet" as const,
        asset: "0.0.0",
        amount: "1000000",
        payTo: DEMO_WINNER_ACCOUNT,
        resource: "/api/reservations/res-schema-1/pay/hbar",
        maxTimeoutSeconds: 180 as const,
        description:
          "Demo reservation fee only — not payment of the freight price.",
        challengeHash: "sha256:" + "aa".repeat(32),
        issuedAt: "2026-07-15T19:00:00.000Z",
      },
      paymentChallengeHash: "sha256:" + "aa".repeat(32),
    };
    expect(() =>
      assertValidPersistedReservationRecord(rec, rec.reservationId),
    ).toThrow(/challenge|selected/i);
  });

  it("claimed state without settleClaim rejected", () => {
    const rec = {
      ...validOfferCreated(),
      state: "FACILITATOR_SETTLE_CLAIMED" as const,
      selected: {
        reservationId: "res-schema-1",
        offerHash: validOfferCreated().offer.offerHash,
        offerVersion: 1,
        optionId: "HBAR" as const,
        payerAccount: DEMO_PAYER_ACCOUNT,
        payTo: DEMO_WINNER_ACCOUNT,
        asset: "0.0.0",
        amountAtomic: "1000000",
        scheme: "exact" as const,
        network: "hedera:testnet" as const,
        selectedAt: "2026-07-15T19:00:00.000Z",
        resourcePath: "/api/reservations/res-schema-1/pay/hbar",
      },
      attemptNumber: 1,
      paymentPayloadHash: "sha256:" + "ab".repeat(32),
      paymentChallengeHash: "sha256:" + "cd".repeat(32),
      settleClaim: null,
    };
    expect(() =>
      assertValidPersistedReservationRecord(rec, rec.reservationId),
    ).toThrow(/settleClaim|challenge/i);
  });

  it("pre-reservation state containing routeReserved rejected", async () => {
    const { service, store, controls, bundle } = buildService();
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "HBAR",
      "res-schema-rr-pre",
    );
    const sel = (await service.getReservation(reservationId))!.selected!;
    controls.mirrorResult = defaultMirrorSuccess(
      sel,
      controls.settleResult.transactionId!,
    );
    const final = await service.submitPayment({
      reservationId,
      optionId: "HBAR",
      paymentPayloadHash,
    });
    expect(final.routeReserved).not.toBeNull();
    const rec = (await store.get(reservationId))!;
    await expect(
      store.compareAndSet(reservationId, rec.recordVersion, {
        ...rec,
        state: "PAYMENT_CONFIRMED",
        // keep routeReserved illegally
      }),
    ).rejects.toThrow(/routeReserved|CORRUPT/i);
  });

  it("filesystem: malformed JSON fails closed without network", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "res-schema-corrupt-"));
    dirs.push(dir);
    writeFileSync(path.join(dir, "res-bad.json"), "{broken", "utf8");
    // File name may not match id; write under safe id
    writeFileSync(path.join(dir, "res-schema-1.json"), "{broken", "utf8");
    const store = new FileSystemReservationStore(dir);
    await expect(store.get("res-schema-1")).rejects.toBeInstanceOf(
      CorruptReservationRecordError,
    );
  });

  it("filesystem: mutated challenge hash fails on read", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "res-schema-ch-"));
    dirs.push(dir);
    const store = new FileSystemReservationStore(dir);
    const { service, bundle } = buildService({ store });
    await createAndSelect(service, bundle, "USDC", "res-schema-ch");
    const fp = path.join(dir, "res-schema-ch.json");
    const raw = JSON.parse(readFileSync(fp, "utf8"));
    raw.paymentChallenge.challengeHash = "sha256:" + "ff".repeat(32);
    raw.paymentChallengeHash = "sha256:" + "ff".repeat(32);
    writeFileSync(fp, JSON.stringify(raw), "utf8");
    await expect(store.get("res-schema-ch")).rejects.toThrow(
      /challengeHash|CORRUPT/i,
    );
  });

  it("creation fingerprint mutation fails on read", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "res-schema-fp-"));
    dirs.push(dir);
    const store = new FileSystemReservationStore(dir);
    const { service, bundle } = buildService({ store });
    const input = createReservationInputFromBundle(bundle, "res-schema-fp");
    await service.createReservation(input, bundle.tender);
    const fp = path.join(dir, "res-schema-fp.json");
    const raw = JSON.parse(readFileSync(fp, "utf8"));
    raw.creationFingerprint = "sha256:" + "00".repeat(32);
    writeFileSync(fp, JSON.stringify(raw), "utf8");
    await expect(store.get("res-schema-fp")).rejects.toThrow(
      /creationFingerprint|CORRUPT/i,
    );
  });
});

describe("Creation fingerprint idempotency (Phase 6A.2C)", () => {
  it("exact duplicate create returns same record", async () => {
    const { service, bundle } = buildService();
    const input = createReservationInputFromBundle(bundle, "res-fp-dup");
    const a = await service.createReservation(input, bundle.tender);
    const b = await service.createReservation(input, bundle.tender);
    expect(a.creationFingerprint).toBe(b.creationFingerprint);
    expect(a.recordVersion).toBe(b.recordVersion);
  });

  it("each altered fingerprint field produces CONFLICT", async () => {
    const { service, bundle } = buildService();
    const base = createReservationInputFromBundle(bundle, "res-fp-conflict");
    await service.createReservation(base, bundle.tender);

    // Service-path mutations that still pass winner validation but change fingerprint.
    const serviceMutations = [
      { ...base, expiresAt: "2026-07-15T21:00:00.000Z" },
      { ...base, createdAt: "2026-07-15T19:00:00.001Z" },
      { ...base, hcsTopicId: "0.0.1111111" },
      { ...base, reservationOfferVersion: 2 },
    ];
    for (const mutated of serviceMutations) {
      await expect(
        service.createReservation(mutated, bundle.tender),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    }

    // Pure fingerprint sensitivity for every trust-critical field.
    const fp1 = computeCreationFingerprint({
      reservationId: base.reservationId,
      tenderId: base.tenderId,
      tenderVersion: base.tenderVersion,
      tenderHash: base.tenderHash,
      winningBidId: base.winningBidId,
      winningBidHash: base.winningBidHash,
      winningCarrierId: base.winningCarrierId,
      winningCarrierAccount: base.winningCarrierAccount,
      decisionManifestHash: base.decisionManifestHash,
      evaluatedBidSetHash: base.evaluatedBidSetHash,
      hcsTopicId: base.hcsTopicId,
      closeBarrierSequence: base.closeBarrierSequence,
      closeBarrierConsensusTimestamp: base.closeBarrierConsensusTimestamp,
      reservationOfferVersion: base.reservationOfferVersion,
      createdAt: base.createdAt,
      expiresAt: base.expiresAt,
    });
    const keys = [
      "reservationId",
      "tenderId",
      "tenderVersion",
      "tenderHash",
      "winningBidId",
      "winningBidHash",
      "winningCarrierId",
      "winningCarrierAccount",
      "decisionManifestHash",
      "evaluatedBidSetHash",
      "hcsTopicId",
      "closeBarrierSequence",
      "closeBarrierConsensusTimestamp",
      "reservationOfferVersion",
      "createdAt",
      "expiresAt",
    ] as const;
    for (const key of keys) {
      const alt: Record<string, string | number> = {
        reservationId: base.reservationId,
        tenderId: base.tenderId,
        tenderVersion: base.tenderVersion,
        tenderHash: base.tenderHash,
        winningBidId: base.winningBidId,
        winningBidHash: base.winningBidHash,
        winningCarrierId: base.winningCarrierId,
        winningCarrierAccount: base.winningCarrierAccount,
        decisionManifestHash: base.decisionManifestHash,
        evaluatedBidSetHash: base.evaluatedBidSetHash,
        hcsTopicId: base.hcsTopicId,
        closeBarrierSequence: base.closeBarrierSequence,
        closeBarrierConsensusTimestamp: base.closeBarrierConsensusTimestamp,
        reservationOfferVersion: base.reservationOfferVersion,
        createdAt: base.createdAt,
        expiresAt: base.expiresAt,
      };
      if (typeof alt[key] === "number") {
        alt[key] = (alt[key] as number) + 1;
      } else {
        alt[key] = String(alt[key]) + "x";
      }
      expect(
        computeCreationFingerprint(
          alt as Parameters<typeof computeCreationFingerprint>[0],
        ),
      ).not.toBe(fp1);
    }
  });
});

describe("API request/response sanitization (Phase 6A.2C)", () => {
  it("select schema rejects non-object and extra fields", () => {
    expect(() => SelectReservationBodySchema.parse(null)).toThrow();
    expect(() => SelectReservationBodySchema.parse("x")).toThrow();
    expect(() => SelectReservationBodySchema.parse([])).toThrow();
    expect(() =>
      SelectReservationBodySchema.parse({
        optionId: "USDC",
        offerHash: "sha256:" + "11".repeat(32),
        offerVersion: 1,
        payerAccount: DEMO_PAYER_ACCOUNT,
        extra: true,
      }),
    ).toThrow();
  });

  it("pay schema rejects invalid hash and extra fields", () => {
    expect(() =>
      PayReservationBodySchema.parse({ paymentPayloadHash: "bad" }),
    ).toThrow();
    expect(() =>
      PayReservationBodySchema.parse({
        paymentPayloadHash: "sha256:" + "11".repeat(32),
        evil: 1,
      }),
    ).toThrow();
  });

  it("malformed JSON and non-object body return 400 INVALID_BODY", async () => {
    const { service, bundle } = buildService();
    const input = createReservationInputFromBundle(bundle, "res-api-body");
    await service.createReservation(input, bundle.tender);
    const app = createReservationApp({ service });

    const badJson = await app.request(
      "/api/reservations/res-api-body/select",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      },
    );
    expect(badJson.status).toBe(400);
    const bj = (await badJson.json()) as { error: string };
    expect(bj.error).toBe("INVALID_BODY");

    const arr = await app.request("/api/reservations/res-api-body/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(["USDC"]),
    });
    expect(arr.status).toBe(400);

    const extra = await app.request("/api/reservations/res-api-body/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        optionId: "USDC",
        offerHash: "sha256:" + "11".repeat(32),
        offerVersion: 1,
        payerAccount: DEMO_PAYER_ACCOUNT,
        sneaky: true,
      }),
    });
    expect(extra.status).toBe(400);
  });

  it("invalid option/hash/account/version return 400", async () => {
    const { service, bundle } = buildService();
    const input = createReservationInputFromBundle(bundle, "res-api-val");
    const rec = await service.createReservation(input, bundle.tender);
    const app = createReservationApp({ service });

    const badOpt = await app.request("/api/reservations/res-api-val/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        optionId: "EUR",
        offerHash: rec.offer.offerHash,
        offerVersion: 1,
        payerAccount: DEMO_PAYER_ACCOUNT,
      }),
    });
    expect(badOpt.status).toBe(400);

    const badHash = await app.request("/api/reservations/res-api-val/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        optionId: "USDC",
        offerHash: "nope",
        offerVersion: 1,
        payerAccount: DEMO_PAYER_ACCOUNT,
      }),
    });
    expect(badHash.status).toBe(400);

    const badAcct = await app.request("/api/reservations/res-api-val/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        optionId: "USDC",
        offerHash: rec.offer.offerHash,
        offerVersion: 1,
        payerAccount: "not-an-account",
      }),
    });
    expect(badAcct.status).toBe(400);

    const badVer = await app.request("/api/reservations/res-api-val/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        optionId: "USDC",
        offerHash: rec.offer.offerHash,
        offerVersion: 0,
        payerAccount: DEMO_PAYER_ACCOUNT,
      }),
    });
    expect(badVer.status).toBe(400);
  });

  it("internal exception is sanitized (no stack / INTERNAL_ERROR)", async () => {
    const { service } = buildService();
    let logged: { code: string; message: string } | null = null;
    const broken = Object.create(service) as typeof service;
    broken.getReservation = async () => {
      throw new Error("secret stack boom " + "x".repeat(200));
    };
    const app = createReservationApp({
      service: broken,
      onInternalError: (info) => {
        logged = info;
      },
    });
    const res = await app.request("/api/reservations/res-api-int");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message?: string };
    expect(body.error).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toMatch(/secret stack|boom/i);
    expect(logged).not.toBeNull();
  });

  it("public view excludes every prohibited internal field", async () => {
    const { service, controls, bundle } = buildService();
    const { reservationId, paymentPayloadHash } = await createAndSelect(
      service,
      bundle,
      "HBAR",
      "res-api-pub",
    );
    const sel = (await service.getReservation(reservationId))!.selected!;
    controls.mirrorResult = defaultMirrorSuccess(
      sel,
      controls.settleResult.transactionId!,
    );
    const final = await service.submitPayment({
      reservationId,
      optionId: "HBAR",
      paymentPayloadHash,
    });
    const view = publicReservationView(final) as Record<string, unknown>;
    const json = JSON.stringify(view);
    expect(view).not.toHaveProperty("settleClaim");
    expect(view).not.toHaveProperty("paymentPayloadHash");
    expect(view).not.toHaveProperty("paymentChallenge");
    expect(view).not.toHaveProperty("webhookEvents");
    expect(view).not.toHaveProperty("hcsPublicationClaim");
    expect(view).not.toHaveProperty("_closureProof");
    expect(view).not.toHaveProperty("_manifest");
    expect(json).not.toMatch(
      /settleAttemptId|publishAttemptId|paymentPayloadHash|privateKey|signature/i,
    );
    expect(view.failureReason).toBeNull();
  });
});
