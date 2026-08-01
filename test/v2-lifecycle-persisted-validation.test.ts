/**
 * Phase A3b — persisted lifecycle state is fully validated on load
 * (RG-V2-A-005). Every corruption class fails closed with a typed error and
 * nothing is partially recovered.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalSha256 } from "../src/domain/canonical-hash";
import { reduceLifecycle } from "../src/v2/lifecycle/reducer";
import type { LifecycleRecord } from "../src/v2/lifecycle/record";
import { LifecycleService } from "../src/v2/store/lifecycle-service";
import { FileLifecycleStore } from "../src/v2/store/lifecycle-store";
import {
  LifecyclePersistenceError,
  type LifecyclePersistenceErrorCode,
} from "../src/v2/store/persistence-errors";
import {
  assertValidLifecycleRecord,
  assertValidPersistedLifecycleEnvelope,
  buildPersistedLifecycleEnvelope,
  parsePersistedLifecycleEnvelope,
} from "../src/v2/store/persisted-record";
import {
  activate,
  AUCTION_ENDS,
  BUDGET,
  defaultTrustPolicy,
  fund,
  happyToPodSubmitted,
  happyToUnderReview,
  HASH,
  recordRefereeDecision,
  rejectToDispute,
  T0,
  WIN_AMOUNT,
  baseRecord,
} from "./v2-lifecycle-fixtures";

type Mutable = Record<string, any>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectCode(fn: () => unknown, code: LifecyclePersistenceErrorCode): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(LifecyclePersistenceError);
    expect((err as LifecyclePersistenceError).code).toBe(code);
    return;
  }
  throw new Error(`expected a ${code} failure`);
}

/** A funded + activated record (carries a durable access receipt). */
function activatedRecord(): LifecycleRecord {
  return activate(fund(baseRecord(), T0), T0);
}

function envelopeOf(record: LifecycleRecord): Mutable {
  return clone(buildPersistedLifecycleEnvelope(record)) as unknown as Mutable;
}

/** Re-seal integrity after a deliberate record mutation. */
function reseal(env: Mutable): Mutable {
  env.integrity.recordHash = canonicalSha256(env.record);
  return env;
}

describe("v2 persisted lifecycle envelope validation", () => {
  const dirs: string[] = [];

  function newDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "rg-v2-persist-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a freshly built envelope", () => {
    const record = activatedRecord();
    const env = buildPersistedLifecycleEnvelope(record);
    const validated = assertValidPersistedLifecycleEnvelope(env, record.tenderId);
    expect(validated.record.state).toBe("TENDER_OPENED");
    expect(validated.actions).toHaveLength(2);
  });

  // -- parse-level corruption ------------------------------------------------

  it("truncated JSON on disk fails closed as RECORD_CORRUPT", async () => {
    const dir = newDir();
    const store = new FileLifecycleStore(dir);
    await store.create({
      tenderId: "t-trunc",
      tenderVersion: 1,
      tenderHash: HASH,
      maximumFreightBudgetAtomic: BUDGET,
      auctionEndsAt: AUCTION_ENDS,
      createdAt: T0,
      trust: defaultTrustPolicy(),
    });
    const fp = path.join(dir, "lifecycle-t-trunc.json");
    const raw = readFileSync(fp, "utf8");
    writeFileSync(fp, raw.slice(0, Math.floor(raw.length / 2)), "utf8");

    await expect(store.get("t-trunc")).rejects.toMatchObject({
      code: "RECORD_CORRUPT",
    });
    // The corrupt authoritative record is never deleted or reset to DRAFT.
    expect(readFileSync(fp, "utf8").length).toBeGreaterThan(0);
  });

  it("invalid JSON fails closed", () => {
    expectCode(
      () => parsePersistedLifecycleEnvelope("not json at all", "t-x"),
      "RECORD_CORRUPT",
    );
  });

  it("syntactically valid but structurally invalid JSON fails closed", () => {
    expectCode(() => parsePersistedLifecycleEnvelope("[]", "t-x"), "RECORD_CORRUPT");
    expectCode(
      () => parsePersistedLifecycleEnvelope("{}", "t-x"),
      "UNSUPPORTED_STORAGE_VERSION",
    );
  });

  it("arrays where objects are expected fail closed", () => {
    const record = activatedRecord();
    const env = envelopeOf(record);
    env.record.processedActions = [];
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(reseal(env), record.tenderId),
      "RECORD_CORRUPT",
    );

    const env2 = envelopeOf(record);
    env2.record = [];
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(env2, record.tenderId),
      "RECORD_CORRUPT",
    );
  });

  // -- storage schema --------------------------------------------------------

  it("unknown storage schema identifier fails closed", () => {
    const record = activatedRecord();
    const env = envelopeOf(record);
    env.storageSchema = "routeguard-v2-lifecycle-store-9.9";
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(env, record.tenderId),
      "UNSUPPORTED_STORAGE_VERSION",
    );
  });

  it("unsupported storage schema version fails closed", () => {
    const record = activatedRecord();
    const env = envelopeOf(record);
    env.storageSchemaVersion = 2;
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(env, record.tenderId),
      "UNSUPPORTED_STORAGE_VERSION",
    );
  });

  it("unknown record schema version fails closed", () => {
    const record = activatedRecord();
    const env = envelopeOf(record);
    env.record.schemaVersion = "routeguard-lifecycle-9.9";
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(reseal(env), record.tenderId),
      "UNSUPPORTED_STORAGE_VERSION",
    );
  });

  it("unknown persisted fields are rejected", () => {
    const record = activatedRecord();
    const env = envelopeOf(record);
    env.record.attackerControlledField = true;
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(reseal(env), record.tenderId),
      "RECORD_CORRUPT",
    );
  });

  it("missing required fields fail closed", () => {
    const record = activatedRecord();
    const env = envelopeOf(record);
    delete env.record.lockedAmountAtomic;
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(reseal(env), record.tenderId),
      "RECORD_CORRUPT",
    );
  });

  // -- field-level corruption ------------------------------------------------

  it("unknown lifecycle state fails closed", () => {
    const record = activatedRecord();
    const env = envelopeOf(record);
    env.record.state = "PAYMENT_RELEASED_LOL";
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(reseal(env), record.tenderId),
      "RECORD_CORRUPT",
    );
  });

  it("a forged terminal state without its metadata fails closed", () => {
    const record = activatedRecord();
    const env = envelopeOf(record);
    env.record.state = "PAYMENT_RELEASED";
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(reseal(env), record.tenderId),
      "RECORD_CORRUPT",
    );
  });

  it("malformed atomic amounts fail closed", () => {
    const record = activatedRecord();
    for (const bad of ["1.5", "1e6", " 100", "0100", "abc", ""]) {
      const env = envelopeOf(record);
      env.record.maximumFreightBudgetAtomic = bad;
      expectCode(
        () => assertValidPersistedLifecycleEnvelope(reseal(env), record.tenderId),
        "RECORD_CORRUPT",
      );
    }
  });

  it("negative amounts fail closed", () => {
    const record = activatedRecord();
    const env = envelopeOf(record);
    env.record.fundedAmountAtomic = "-1";
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(reseal(env), record.tenderId),
      "RECORD_CORRUPT",
    );
  });

  it("record version below one fails closed", () => {
    const record = activatedRecord();
    for (const bad of [0, -1, 1.5]) {
      const env = envelopeOf(record);
      env.record.recordVersion = bad;
      env.recordVersion = bad;
      expectCode(
        () => assertValidPersistedLifecycleEnvelope(reseal(env), record.tenderId),
        "RECORD_CORRUPT",
      );
    }
  });

  it("malformed timestamps fail closed", () => {
    const record = activatedRecord();
    const env = envelopeOf(record);
    env.record.createdAt = "31/07/2026";
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(reseal(env), record.tenderId),
      "RECORD_CORRUPT",
    );
  });

  it("createdAt after updatedAt fails closed", () => {
    const record = activatedRecord();
    const env = envelopeOf(record);
    env.record.createdAt = "2099-01-01T00:00:00.000Z";
    env.createdAt = "2099-01-01T00:00:00.000Z";
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(reseal(env), record.tenderId),
      "RECORD_CORRUPT",
    );
  });

  it("invalid account ids fail closed", () => {
    const record = activatedRecord();
    const env = envelopeOf(record);
    env.record.trust.accessTreasuryAccountId = "not-an-account";
    env.trustPolicy.accessTreasuryAccountId = "not-an-account";
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(reseal(env), record.tenderId),
      "RECORD_CORRUPT",
    );
  });

  it("malformed hashes fail closed", () => {
    const record = activatedRecord();
    const env = envelopeOf(record);
    env.record.tenderHash = "sha256:XYZ";
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(reseal(env), record.tenderId),
      "RECORD_CORRUPT",
    );
  });

  // -- trust policy ----------------------------------------------------------

  it("a corrupt trust-policy snapshot fails closed", () => {
    const record = activatedRecord();

    const swappedKey = envelopeOf(record);
    swappedKey.record.trust.shipperPublicKey = `${"a".repeat(66)}`;
    swappedKey.trustPolicy.shipperPublicKey = swappedKey.record.trust.shipperPublicKey;
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(reseal(swappedKey), record.tenderId),
      "RECORD_CORRUPT",
    );

    const noReferees = envelopeOf(record);
    noReferees.record.trust.referees = [];
    noReferees.trustPolicy.referees = [];
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(reseal(noReferees), record.tenderId),
      "RECORD_CORRUPT",
    );

    const badAlgorithm = envelopeOf(record);
    badAlgorithm.record.trust.signatureAlgorithm = "NONE";
    badAlgorithm.trustPolicy.signatureAlgorithm = "NONE";
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(reseal(badAlgorithm), record.tenderId),
      "RECORD_CORRUPT",
    );
  });

  it("an envelope trust policy that diverges from the record fails closed", () => {
    const record = activatedRecord();
    const env = envelopeOf(record);
    env.trustPolicy.accessTreasuryAccountId = "0.0.999999";
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(env, record.tenderId),
      "RECORD_CORRUPT",
    );
  });

  // -- access receipt --------------------------------------------------------

  it("a corrupt access receipt fails closed", () => {
    const record = activatedRecord();

    for (const mutate of [
      (e: Mutable) => (e.record.accessReceipt.amountAtomic = "999"),
      (e: Mutable) => (e.record.accessReceipt.asset = "0.0.1"),
      (e: Mutable) => (e.record.accessReceipt.payTo = "0.0.4242"),
      (e: Mutable) => (e.record.accessReceipt.resource = "/api/v2/tenders/x/activate"),
      (e: Mutable) => (e.record.accessReceipt.payerAccount = "nope"),
      (e: Mutable) => (e.record.accessReceipt = null),
    ]) {
      const env = envelopeOf(record);
      mutate(env);
      expectCode(
        () => assertValidPersistedLifecycleEnvelope(reseal(env), record.tenderId),
        "RECORD_CORRUPT",
      );
    }
  });

  it("the recorded access receipt pins token, amount, treasury, and resource", () => {
    const record = activatedRecord();
    expect(record.accessReceipt).toMatchObject({
      asset: "0.0.429274",
      amountAtomic: "1000",
      payTo: record.trust.accessTreasuryAccountId,
      resource: `/api/v2/tenders/${record.tenderId}/v/${record.tenderVersion}/activate`,
    });
  });

  // -- tender binding --------------------------------------------------------

  it("mismatched tenderId fails closed", () => {
    const record = activatedRecord();
    const env = envelopeOf(record);
    env.tenderId = "other-tender";
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(env, record.tenderId),
      "RECORD_CORRUPT",
    );

    const env2 = envelopeOf(record);
    env2.record.tenderId = "other-tender";
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(reseal(env2), record.tenderId),
      "RECORD_CORRUPT",
    );
  });

  it("mismatched tenderVersion fails closed", () => {
    const record = activatedRecord();
    const env = envelopeOf(record);
    env.tenderVersion = 7;
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(env, record.tenderId),
      "RECORD_CORRUPT",
    );
  });

  it("mismatched envelope record version fails closed", () => {
    const record = activatedRecord();
    const env = envelopeOf(record);
    env.recordVersion = record.recordVersion + 5;
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(env, record.tenderId),
      "RECORD_CORRUPT",
    );
  });

  // -- action index ----------------------------------------------------------

  it("duplicate processed action ids fail closed", () => {
    const record = activatedRecord();
    const env = envelopeOf(record);
    env.actions.push(clone(env.actions[0]));
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(env, record.tenderId),
      "RECORD_CORRUPT",
    );
  });

  it("cross-tender action records fail closed", () => {
    const record = activatedRecord();

    const otherTender = envelopeOf(record);
    otherTender.actions[0].tenderId = "another-tender";
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(otherTender, record.tenderId),
      "RECORD_CORRUPT",
    );

    const otherVersion = envelopeOf(record);
    otherVersion.actions[0].tenderVersion = 9;
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(otherVersion, record.tenderId),
      "RECORD_CORRUPT",
    );
  });

  it("an action index that drifts from the record fails closed", () => {
    const record = activatedRecord();

    const dropped = envelopeOf(record);
    dropped.actions.pop();
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(dropped, record.tenderId),
      "RECORD_CORRUPT",
    );

    const rewritten = envelopeOf(record);
    rewritten.actions[0].eventPayloadHash = `sha256:${"0".repeat(64)}`;
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(rewritten, record.tenderId),
      "RECORD_CORRUPT",
    );
  });

  it("a lifecycle transition without its action record fails closed", () => {
    const record = activatedRecord();
    const env = envelopeOf(record);
    delete env.record.processedActions[record.lastActionId!];
    env.actions = env.actions.filter(
      (a: Mutable) => a.actionId !== record.lastActionId,
    );
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(reseal(env), record.tenderId),
      "RECORD_CORRUPT",
    );
  });

  it("integrity metadata that does not recompute fails closed", () => {
    const record = activatedRecord();
    const env = envelopeOf(record);
    env.record.fundingTxId = "0.0.1@6.6";
    // Deliberately not resealed: the record hash no longer matches.
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(env, record.tenderId),
      "RECORD_CORRUPT",
    );
  });

  // -- settlement invariants -------------------------------------------------

  it("an inconsistent referee decision fails closed", () => {
    const decided = recordRefereeDecision(rejectToDispute(happyToUnderReview()), {
      resolution: "PARTIAL",
      releaseAmountAtomic: "400000",
      refundAmountAtomic: "300000",
    });
    expect(decided.state).toBe("REFEREE_DECISION");
    assertValidLifecycleRecord(decided, decided.tenderId);

    const env = envelopeOf(decided);
    env.record.releaseAmountAtomic = "100000"; // no longer conserves the lock
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(reseal(env), decided.tenderId),
      "RECORD_CORRUPT",
    );

    const wrongKind = envelopeOf(decided);
    wrongKind.record.refereeResolution = "RELEASE_FULL"; // refund is non-zero
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(reseal(wrongKind), decided.tenderId),
      "RECORD_CORRUPT",
    );

    const untrustedReferee = envelopeOf(decided);
    untrustedReferee.record.refereeId = "ref-unknown";
    expectCode(
      () =>
        assertValidPersistedLifecycleEnvelope(
          reseal(untrustedReferee),
          decided.tenderId,
        ),
      "RECORD_CORRUPT",
    );
  });

  it("locked amount above the maximum budget fails closed", () => {
    const record = reduceLifecycle(
      { ...happyToPodSubmitted() },
      {
        type: "POD_REVIEW_STARTED",
        actionId: "act-review",
        eventTime: "2026-08-02T12:00:00.000Z",
      },
    );
    const env = envelopeOf(record);
    env.record.lockedAmountAtomic = "9999999999";
    env.record.winningAmountAtomic = "9999999999";
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(reseal(env), record.tenderId),
      "RECORD_CORRUPT",
    );
  });

  it("settlement metadata in an impossible state fails closed", () => {
    const record = activatedRecord();
    const env = envelopeOf(record);
    env.record.releaseTxId = "0.0.1@7.7";
    expectCode(
      () => assertValidPersistedLifecycleEnvelope(reseal(env), record.tenderId),
      "RECORD_CORRUPT",
    );

    const withDecision = envelopeOf(record);
    withDecision.record.refereeResolution = "RELEASE_FULL";
    expectCode(
      () =>
        assertValidPersistedLifecycleEnvelope(reseal(withDecision), record.tenderId),
      "RECORD_CORRUPT",
    );
  });

  it("a valid full lifecycle to PARTIAL_RELEASE validates", () => {
    const decided = recordRefereeDecision(rejectToDispute(happyToUnderReview()), {
      resolution: "PARTIAL",
      releaseAmountAtomic: "400000",
      refundAmountAtomic: "300000",
    });
    const settled = reduceLifecycle(decided, {
      type: "ESCROW_PARTIAL_RELEASE_CONFIRMED",
      actionId: "act-partial",
      eventTime: decided.updatedAt,
      releaseTxId: "0.0.1@8.1",
      refundTxId: "0.0.1@8.2",
      releaseAmountAtomic: "400000",
      refundAmountAtomic: "300000",
    });
    expect(settled.state).toBe("PARTIAL_RELEASE");
    expect(settled.lockedAmountAtomic).toBe(WIN_AMOUNT);
    const env = buildPersistedLifecycleEnvelope(settled);
    expect(
      assertValidPersistedLifecycleEnvelope(env, settled.tenderId).record.state,
    ).toBe("PARTIAL_RELEASE");
  });

  it("service writes survive a full reload through the file store", async () => {
    const dir = newDir();
    const svc = new LifecycleService(new FileLifecycleStore(dir));
    await svc.create({
      tenderId: "t-reload",
      tenderVersion: 2,
      tenderHash: HASH,
      maximumFreightBudgetAtomic: BUDGET,
      auctionEndsAt: AUCTION_ENDS,
      createdAt: T0,
      trust: defaultTrustPolicy(),
    });
    await svc.apply("t-reload", {
      type: "ESCROW_FUNDING_CONFIRMED",
      actionId: "fund-1",
      eventTime: T0,
      fundingTxId: "0.0.1@1.1",
      tokenId: "0.0.429274",
      fundedAmountAtomic: BUDGET,
      tenderId: "t-reload",
      tenderVersion: 2,
    });

    const reloaded = await new FileLifecycleStore(dir).get("t-reload");
    expect(reloaded?.state).toBe("ESCROW_FUNDED");
    expect(reloaded?.recordVersion).toBe(2);
  });
});
