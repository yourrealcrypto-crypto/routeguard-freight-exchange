import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { LifecycleEvent } from "../src/v2/lifecycle/events";
import {
  createLifecycleRecord,
  type LifecycleRecord,
} from "../src/v2/lifecycle/record";
import { reduceLifecycle } from "../src/v2/lifecycle/reducer";
import {
  FileLifecycleStore,
  InMemoryLifecycleStore,
  type LifecycleStore,
} from "../src/v2/store/lifecycle-store";
import { createTrustPolicy } from "../src/v2/trust/policy";
import {
  activate,
  AUCTION_ENDS,
  baseRecord,
  BUDGET,
  defaultTrustPolicy,
  fund,
  HASH,
  HASH_B,
  happyToUnderReview,
  REFEREE_PUBLIC,
  SHIPPER_PUBLIC,
  signShipperAction,
  shipperAuth,
  T0,
} from "./v2-lifecycle-fixtures";

const HASH_C =
  "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const BEFORE_T0 = "2026-07-31T11:59:59.999Z";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type StoreKind = "memory" | "file";

function newStore(kind: StoreKind): LifecycleStore {
  if (kind === "memory") return new InMemoryLifecycleStore();
  const dir = mkdtempSync(path.join(tmpdir(), "rg-v2-a-closeout-"));
  dirs.push(dir);
  return new FileLifecycleStore(dir);
}

async function createStoredRecord(store: LifecycleStore): Promise<LifecycleRecord> {
  return store.create({
    tenderId: "tender-v2-a2",
    tenderVersion: 1,
    tenderHash: HASH,
    maximumFreightBudgetAtomic: BUDGET,
    auctionEndsAt: AUCTION_ENDS,
    createdAt: T0,
    trust: defaultTrustPolicy(),
  });
}

function fundingEvent(amount = BUDGET): LifecycleEvent {
  return {
    type: "ESCROW_FUNDING_CONFIRMED",
    actionId: "act-fund",
    eventTime: T0,
    fundingTxId: "0.0.1@1.1",
    tokenId: "0.0.429274",
    fundedAmountAtomic: amount,
    tenderId: "tender-v2-a2",
    tenderVersion: 1,
  };
}

async function expectImmutableViolation(
  store: LifecycleStore,
  current: LifecycleRecord,
  proposed: LifecycleRecord,
): Promise<void> {
  try {
    await store.compareAndSet(
      current.tenderId,
      current.recordVersion,
      proposed,
    );
  } catch (error) {
    expect((error as { code?: string }).code).toBe(
      "IMMUTABLE_FIELD_VIOLATION",
    );
    return;
  }
  throw new Error("expected immutable-field CAS rejection");
}

const creationMutations: readonly {
  readonly field: string;
  readonly mutate: (record: LifecycleRecord) => LifecycleRecord;
}[] = [
  {
    field: "tenderId",
    mutate: (r) => ({ ...r, tenderId: "different-tender" }),
  },
  {
    field: "tenderVersion",
    mutate: (r) => ({ ...r, tenderVersion: 2 }),
  },
  {
    field: "tenderHash",
    mutate: (r) => ({ ...r, tenderHash: HASH_B }),
  },
  {
    field: "maximumFreightBudgetAtomic",
    mutate: (r) => ({ ...r, maximumFreightBudgetAtomic: "2000000" }),
  },
  {
    field: "shipper identity fingerprint",
    mutate: (r) => ({
      ...r,
      trust: { ...r.trust, shipperKeyFingerprint: "b".repeat(64) },
    }),
  },
  {
    field: "trusted shipper public key",
    mutate: (r) => ({
      ...r,
      trust: { ...r.trust, shipperPublicKey: REFEREE_PUBLIC },
    }),
  },
  {
    field: "trusted referee registry",
    mutate: (r) => ({
      ...r,
      trust: {
        ...r.trust,
        referees: [{ refereeId: "ref-human-2", publicKey: SHIPPER_PUBLIC }],
      },
    }),
  },
  {
    field: "access treasury account",
    mutate: (r) => ({
      ...r,
      trust: { ...r.trust, accessTreasuryAccountId: "0.0.9215954" },
    }),
  },
  {
    field: "trust schema snapshot",
    mutate: (r) => ({
      ...r,
      trust: {
        ...r.trust,
        schemaVersion: "routeguard-v2-trust-2.0" as never,
      },
    }),
  },
  {
    field: "trust signature algorithm snapshot",
    mutate: (r) => ({
      ...r,
      trust: { ...r.trust, signatureAlgorithm: "OTHER" as never },
    }),
  },
];

describe.each<StoreKind>(["memory", "file"])(
  "%s store immutable CAS boundary",
  (kind) => {
    it.each(creationMutations)("rejects mutation of $field", async ({ mutate }) => {
      const store = newStore(kind);
      const current = await createStoredRecord(store);
      const next = reduceLifecycle(current, fundingEvent());
      await expectImmutableViolation(store, current, mutate(next));
      expect((await store.get(current.tenderId))?.recordVersion).toBe(1);
    });

    it.each([
      {
        field: "configured USDC token",
        mutateReceipt: (receipt: NonNullable<LifecycleRecord["accessReceipt"]>) => ({
          ...receipt,
          asset: "0.0.999999",
        }),
      },
      {
        field: "configured access amount",
        mutateReceipt: (receipt: NonNullable<LifecycleRecord["accessReceipt"]>) => ({
          ...receipt,
          amountAtomic: "2000",
        }),
      },
    ])("rejects mutation of $field", async ({ mutateReceipt }) => {
      const store = newStore(kind);
      let current = await createStoredRecord(store);
      current = await store.compareAndSet(
        current.tenderId,
        current.recordVersion,
        reduceLifecycle(current, fundingEvent()),
      );
      current = await store.compareAndSet(
        current.tenderId,
        current.recordVersion,
        activate(current),
      );
      const next = reduceLifecycle(current, {
        type: "BIDDING_STARTED",
        actionId: "act-bidding",
        eventTime: T0,
      });
      const proposed = {
        ...next,
        accessReceipt: mutateReceipt(current.accessReceipt!),
      };
      await expectImmutableViolation(store, current, proposed);
    });

    it("accepts an identical immutable snapshot", async () => {
      const store = newStore(kind);
      const current = await createStoredRecord(store);
      const persisted = await store.compareAndSet(
        current.tenderId,
        current.recordVersion,
        reduceLifecycle(current, fundingEvent()),
      );
      expect(persisted.recordVersion).toBe(2);
      expect(persisted.trust).toEqual(current.trust);
    });
  },
);

describe("Phase A lifecycle closeout guards", () => {
  it("rejects overfunding instead of leaving an unmodeled residual", () => {
    expect(() =>
      reduceLifecycle(baseRecord(), fundingEvent("1000001")),
    ).toThrow(/exactly equal|overfund|FUNDING_AMOUNT_MISMATCH/i);
  });

  it.each(["-1", "0", "1.5", "1e6", "+1", "01"])(
    "validates lifecycle creation budget through the money schema: %s",
    (maximumFreightBudgetAtomic) => {
      expect(() =>
        createLifecycleRecord({
          tenderId: "tender-v2-a2",
          tenderVersion: 1,
          tenderHash: HASH,
          maximumFreightBudgetAtomic,
          auctionEndsAt: AUCTION_ENDS,
          createdAt: T0,
          trust: defaultTrustPolicy(),
        }),
      ).toThrow();
    },
  );

  it("rejects unsafe non-string money input at lifecycle creation", () => {
    expect(() =>
      createLifecycleRecord({
        tenderId: "tender-v2-a2",
        tenderVersion: 1,
        tenderHash: HASH,
        maximumFreightBudgetAtomic: (Number.MAX_SAFE_INTEGER + 1) as never,
        auctionEndsAt: AUCTION_ENDS,
        createdAt: T0,
        trust: defaultTrustPolicy(),
      }),
    ).toThrow();
  });

  it("rejects event time earlier than authoritative updatedAt", () => {
    const current = activate(fund(baseRecord()));
    expect(() =>
      reduceLifecycle(current, {
        type: "BIDDING_STARTED",
        actionId: "backdated",
        eventTime: BEFORE_T0,
      }),
    ).toThrow(/NON_MONOTONIC_TIME|earlier than .*updatedAt/i);
  });

  it("allows a same-timestamp event when action ordering is explicit", () => {
    const current = activate(fund(baseRecord()));
    const next = reduceLifecycle(current, {
      type: "BIDDING_STARTED",
      actionId: "same-time",
      eventTime: current.updatedAt,
    });
    expect(next.state).toBe("BIDDING");
  });

  it("binds POD resubmission to the existing POD, both hashes, and next version", () => {
    let current = happyToUnderReview();
    expect((current as LifecycleRecord & { podVersion: number }).podVersion).toBe(1);
    const actionId = "request-correction";
    const signature = signShipperAction({
      tenderId: current.tenderId,
      tenderVersion: current.tenderVersion,
      podId: current.podId!,
      reviewAction: "REQUEST_CORRECTION",
      reasonCodes: ["STAMP"],
      signedAt: current.updatedAt,
      reviewDeadlineAt: current.reviewDeadlineAt!,
      actionId,
    });
    const auth = shipperAuth(current, {
      reviewAction: "REQUEST_CORRECTION",
      actionId,
      signedAt: current.updatedAt,
      reviewDeadlineAt: current.reviewDeadlineAt!,
      reasonCodes: ["STAMP"],
      signature,
    });
    current = reduceLifecycle(
      current,
      {
        type: "POD_CORRECTION_REQUESTED",
        actionId,
        eventTime: current.updatedAt,
        reasons: [{ code: "STAMP", message: "missing stamp" }],
        shipperSignature: signature,
        signedAt: current.updatedAt,
        reviewDeadlineAt: current.reviewDeadlineAt!,
      },
      { verifiedAuth: auth },
    );

    const baseResubmit = {
      type: "POD_PACKAGE_RESUBMITTED",
      actionId: "resubmit",
      eventTime: current.updatedAt,
      podId: current.podId!,
      podVersion: 2,
      contentHash: HASH_B,
      ciphertextHash: HASH_C,
    } as const;

    expect(() =>
      reduceLifecycle(current, {
        ...baseResubmit,
        ciphertextHash: undefined,
      } as unknown as LifecycleEvent),
    ).toThrow(/ciphertextHash|POD_FIELDS/i);
    expect(() =>
      reduceLifecycle(current, {
        ...baseResubmit,
        podId: "unrelated-pod",
      } as LifecycleEvent),
    ).toThrow(/POD_MISMATCH|podId/i);
    expect(() =>
      reduceLifecycle(current, {
        ...baseResubmit,
        podVersion: 3,
      } as LifecycleEvent),
    ).toThrow(/POD_VERSION|podVersion/i);

    const next = reduceLifecycle(current, baseResubmit as LifecycleEvent);
    expect(next.podId).toBe(current.podId);
    expect(next.podContentHash).toBe(HASH_B);
    expect((next as LifecycleRecord & { podCiphertextHash: string }).podCiphertextHash).toBe(HASH_C);
    expect((next as LifecycleRecord & { podVersion: number }).podVersion).toBe(2);
  });
});

describe("TrustPolicy referee identity validation", () => {
  it.each([
    "ai",
    "MODEL",
    "llm",
    "Bot",
    "automated_referee",
    "routeguard ai",
    "ai-model-1",
  ])("rejects reserved AI/model identity at creation: %s", (refereeId) => {
    expect(() =>
      createTrustPolicy({
        shipperPublicKey: SHIPPER_PUBLIC,
        referees: [{ refereeId, publicKey: REFEREE_PUBLIC }],
        accessTreasuryAccountId: "0.0.9197513",
      }),
    ).toThrow(/AI|model|automation/i);
  });

  it.each(["Aida Modelson", "Robert Botticelli", "Lloyd Human"])(
    "accepts a legitimate human identity: %s",
    (refereeId) => {
      expect(() =>
        createTrustPolicy({
          shipperPublicKey: SHIPPER_PUBLIC,
          referees: [{ refereeId, publicKey: REFEREE_PUBLIC }],
          accessTreasuryAccountId: "0.0.9197513",
        }),
      ).not.toThrow();
    },
  );
});
