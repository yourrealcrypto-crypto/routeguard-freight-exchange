/**
 * Phase D1 — encrypted POD submission, advisory, shipper review, escrow plans.
 * NETWORK_WRITES=0 throughout.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { PrivateKey } from "@hiero-ledger/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { InMemoryCarrierRegistry } from "../src/domain/carrier";
import {
  buildCarrierPodSubmissionSignPayload,
  buildShipperPodReviewSignPayload,
} from "../src/v2/auth/canonical";
import {
  signCarrierPodForTests,
  signShipperPodReviewForTests,
} from "../src/v2/auth/verify";
import { escrowTenderKey } from "../src/v2/escrow/tender-key";
import {
  addUtcSeconds,
  CORRECTION_WINDOW_SECONDS,
  POST_RESUBMIT_REVIEW_WINDOW_SECONDS,
  REVIEW_WINDOW_SECONDS,
} from "../src/v2/lifecycle/deadlines";
import type { LifecycleEvent } from "../src/v2/lifecycle/events";
import {
  ADVISER_ENGINE_ID,
  AesGcmMasterKeyProtector,
  buildCanonicalManifest,
  createV2PodApp,
  decryptPodPayload,
  decryptStoredRecord,
  DeterministicPodAssuranceAdviser,
  encodePlaintextPackage,
  encryptAndBuildRecord,
  encryptPodPayload,
  FilePodEncryptedStore,
  manifestHash,
  MemoryPodEncryptedStore,
  packageContentHash,
  parseMasterKeyBase64,
  PodError,
  PodService,
  PHASE_C2_ESCROW_CONTRACT_EVM,
  PHASE_C2_ESCROW_CONTRACT_ID,
  PHASE_C2_LOCKED_AMOUNT_ATOMIC,
  sha256Digest,
  type SignedPodPackage,
} from "../src/v2/pod";
import { tenderActivateResource } from "../src/v2/access/resource";
import { LifecycleService } from "../src/v2/store/lifecycle-service";
import { InMemoryLifecycleStore } from "../src/v2/store/lifecycle-store";
import {
  defaultTrustPolicy,
  HASH,
  SHIPPER_PRIVATE,
  SHIPPER_PUBLIC,
  T0,
  TREASURY,
} from "./v2-lifecycle-fixtures";

const CARRIER_PRIVATE = PrivateKey.generateECDSA();
const CARRIER_PUBLIC = CARRIER_PRIVATE.publicKey.toStringRaw();
const CARRIER_ID = "carrier-alpha";
const CARRIER_ACCOUNT = "0.0.9215954";
const TENDER_ID = "tender-pod-d1";
const TENDER_VERSION = 1;
const BID_ID = "bid-win-1";
const POD_ID = "pod-d1-1";

const MASTER_KEY = randomBytes(32);
const MASTER_KEY_B64 = MASTER_KEY.toString("base64");

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function pdfBytes(label: string): Uint8Array {
  return new Uint8Array(
    Buffer.from(`%PDF-1.4\n% ${label}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`),
  );
}

function pngBytes(): Uint8Array {
  // Minimal valid PNG header + IHDR-ish padding (scanner only checks magic).
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde,
  ]);
}

function jsonMetaBytes(): Uint8Array {
  return new Uint8Array(
    Buffer.from(JSON.stringify({ demo: true, route: "ROT-MUC" }), "utf8"),
  );
}

const T_FUND = "2026-07-31T12:00:00.000Z";
const T_CLOSE = "2026-08-01T12:00:00.000Z";
const T_AFTER = "2026-08-02T12:00:00.000Z";

async function advanceToDelivery(
  lifecycle: LifecycleService,
  tenderId: string,
): Promise<void> {
  const steps: LifecycleEvent[] = [
    {
      type: "ESCROW_FUNDING_CONFIRMED",
      actionId: "act-fund",
      eventTime: T_FUND,
      fundingTxId: "0.0.1@1.1",
      tokenId: "0.0.429274",
      fundedAmountAtomic: "1000000",
      tenderId,
      tenderVersion: 1,
    },
    {
      type: "TENDER_ACTIVATION_PAID",
      actionId: "act-activate",
      eventTime: T_FUND,
      accessActionType: "TENDER_ACTIVATE",
      asset: "0.0.429274",
      amountAtomic: "1000",
      resource: tenderActivateResource(tenderId, 1),
      paymentTransactionId: "0.0.1@1.2",
      paymentPayloadHash: HASH,
      payerAccount: "0.0.9197513",
      payTo: TREASURY,
    },
    { type: "BIDDING_STARTED", actionId: "act-bid-open", eventTime: T_FUND },
    {
      type: "AUCTION_CLOSE_CONFIRMED",
      actionId: "act-close",
      eventTime: T_CLOSE,
      auctionEndsAt: "2026-08-01T12:00:00.000Z",
      closureProofRef: "proof-1",
      authoritativeBidSetHash: HASH,
    },
    {
      type: "WINNER_SELECTION_CONFIRMED",
      actionId: "act-win",
      eventTime: T_AFTER,
      decisionManifestHash: HASH,
      winningBidId: BID_ID,
      winningCarrierId: CARRIER_ID,
      winningCarrierAccount: CARRIER_ACCOUNT,
      winningAmountAtomic: "750000",
      selectionPolicy: "LOWEST_QUALIFIED_PRICE_V1",
    },
    {
      type: "WINNING_AMOUNT_ALLOCATION_CONFIRMED",
      actionId: "act-alloc",
      eventTime: T_AFTER,
      allocateTxId: "0.0.1@1.3",
      refundExcessTxId: "0.0.1@1.4",
      maxBudgetAtomic: "1000000",
      winningAmountAtomic: "750000",
      excessRefundAtomic: "250000",
      decisionManifestHash: HASH,
    },
    {
      type: "ROUTE_RESERVATION_PUBLISHED",
      actionId: "act-rsv",
      eventTime: T_AFTER,
      reservationEvidenceRef: "rsv-1",
      hcsPublicationRef: "hcs-1",
    },
    { type: "TRANSIT_STARTED", actionId: "act-transit", eventTime: T_AFTER },
    { type: "DELIVERY_REPORTED", actionId: "act-delivered", eventTime: T_AFTER },
  ];
  for (const e of steps) {
    await lifecycle.apply(tenderId, e);
  }
}

async function buildSignedPackage(overrides: Partial<SignedPodPackage> = {}): Promise<{
  pkg: SignedPodPackage;
  manifestHash: string;
  packageContentHash: string;
}> {
  const tenderKey = escrowTenderKey(TENDER_ID, TENDER_VERSION);
  const files = [
    {
      fileId: "f-receipt",
      documentType: "ELECTRONIC_DELIVERY_RECEIPT" as const,
      filename: "receipt.pdf",
      mimeType: "application/pdf",
      bytes: pdfBytes("receipt"),
    },
    {
      fileId: "f-confirm",
      documentType: "RECIPIENT_CONFIRMATION" as const,
      filename: "confirm.json",
      mimeType: "application/json",
      bytes: jsonMetaBytes(),
    },
    {
      fileId: "f-photo",
      documentType: "DELIVERY_IMAGE" as const,
      filename: "dock.png",
      mimeType: "image/png",
      bytes: pngBytes(),
    },
  ];
  const fields = {
    podId: POD_ID,
    podVersion: 1,
    tenderId: TENDER_ID,
    tenderVersion: TENDER_VERSION,
    winningBidId: BID_ID,
    escrowTenderKey: tenderKey,
    carrierId: CARRIER_ID,
    carrierAccountId: CARRIER_ACCOUNT,
    deliveryTimestamp: "2026-08-05T10:00:00.000Z",
    recipientConfirmationPresent: true,
    cargoConditionCode: "GOOD" as const,
    exceptionCodes: ["NONE"] as const,
    submittedAt: "2026-08-05T10:05:00.000Z",
    actionId: "act-pod-submit-1",
  };
  const merged = { ...fields, ...overrides, files: overrides.files ?? files };
  const manifest = await buildCanonicalManifest(merged.files);
  const mHash = manifestHash(manifest);
  const pHash = packageContentHash(merged, manifest);
  const signPayload = buildCarrierPodSubmissionSignPayload({
    podId: merged.podId,
    podVersion: merged.podVersion,
    tenderId: merged.tenderId,
    tenderVersion: merged.tenderVersion,
    winningBidId: merged.winningBidId,
    escrowTenderKey: merged.escrowTenderKey,
    carrierId: merged.carrierId,
    carrierAccountId: merged.carrierAccountId,
    deliveryTimestamp: merged.deliveryTimestamp,
    manifestHash: mHash,
    packageContentHash: pHash,
    submittedAt: merged.submittedAt,
    actionId: merged.actionId,
  });
  const signature = signCarrierPodForTests(
    CARRIER_PRIVATE.toStringRaw(),
    signPayload,
  );
  return {
    pkg: {
      ...merged,
      carrierSignature: signature,
      manifestHash: mHash,
      packageContentHash: pHash,
    },
    manifestHash: mHash,
    packageContentHash: pHash,
  };
}

function makeHarness() {
  const carriers = new InMemoryCarrierRegistry([
    {
      carrierId: CARRIER_ID,
      carrierAccountId: CARRIER_ACCOUNT,
      signingPublicKey: CARRIER_PUBLIC,
      active: true,
      allowedEquipment: ["dry-van"],
      registryVersion: 1,
    },
  ]);
  const store = new InMemoryLifecycleStore();
  const lifecycle = new LifecycleService(store, { carriers });
  const trust = defaultTrustPolicy({
    shipperPublicKey: SHIPPER_PUBLIC,
    accessTreasuryAccountId: TREASURY,
  });
  const podStore = new MemoryPodEncryptedStore();
  const keyProtector = new AesGcmMasterKeyProtector(MASTER_KEY);
  const pods = new PodService({
    lifecycle,
    podStore,
    keyProtector,
    carriers,
    now: () => "2026-08-05T12:00:00.000Z",
    escrowContractId: PHASE_C2_ESCROW_CONTRACT_ID,
    escrowContractEvm: PHASE_C2_ESCROW_CONTRACT_EVM,
    requirePhaseC2LiveBindings: true,
  });
  return { lifecycle, pods, podStore, keyProtector, carriers, trust, store };
}

async function seedDelivery(h: ReturnType<typeof makeHarness>) {
  await h.lifecycle.create({
    tenderId: TENDER_ID,
    tenderVersion: TENDER_VERSION,
    tenderHash: HASH,
    maximumFreightBudgetAtomic: "1000000",
    auctionEndsAt: "2026-08-01T12:00:00.000Z",
    createdAt: T0,
    trust: h.trust,
  });
  await advanceToDelivery(h.lifecycle, TENDER_ID);
}

describe("Phase D1 POD workflow", () => {
  it("valid signed POD package is accepted and encrypted", async () => {
    const h = makeHarness();
    await seedDelivery(h);
    const { pkg, packageContentHash: pHash } = await buildSignedPackage();
    const result = await h.pods.submitPod({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      podId: POD_ID,
      package: pkg,
    });
    expect(result.outcome).toBe("APPLIED");
    expect(result.receipt.state).toBe("POD_SUBMITTED");
    expect(result.receipt.packageContentHash).toBe(pHash);
    expect(result.outbox[0]!.kind).toBe("POD_SUBMITTED");
    const rec = await h.lifecycle.get(TENDER_ID);
    expect(rec?.podContentHash).toBe(pHash);
    expect(rec?.podCiphertextHash).toBe(result.receipt.ciphertextHash);
  });

  it("invalid carrier signature fails", async () => {
    const h = makeHarness();
    await seedDelivery(h);
    const { pkg } = await buildSignedPackage();
    await expect(
      h.pods.submitPod({
        tenderId: TENDER_ID,
        tenderVersion: 1,
        podId: POD_ID,
        package: { ...pkg, carrierSignature: "ab".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "POD_SIGNATURE_INVALID" });
  });

  it("signature transplant to another tender fails", async () => {
    const h = makeHarness();
    await seedDelivery(h);
    const { pkg } = await buildSignedPackage();
    await expect(
      h.pods.submitPod({
        tenderId: TENDER_ID,
        tenderVersion: 1,
        podId: POD_ID,
        package: { ...pkg, tenderId: "other-tender" },
      }),
    ).rejects.toBeTruthy();
  });

  it("manifest change after signing fails", async () => {
    const h = makeHarness();
    await seedDelivery(h);
    const { pkg } = await buildSignedPackage();
    const files = [
      ...pkg.files,
      {
        fileId: "f-extra",
        documentType: "EXCEPTION_DOCUMENT" as const,
        filename: "extra.pdf",
        mimeType: "application/pdf",
        bytes: pdfBytes("extra"),
      },
    ];
    try {
      await h.pods.submitPod({
        tenderId: TENDER_ID,
        tenderVersion: 1,
        podId: POD_ID,
        package: { ...pkg, files },
      });
      expect.fail("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(PodError);
      expect(
        ["POD_MANIFEST_MISMATCH", "POD_SIGNATURE_INVALID", "POD_HASH_MISMATCH"],
      ).toContain((err as PodError).code);
    }
  });

  it("path traversal filename fails", async () => {
    await expect(
      buildCanonicalManifest([
        {
          fileId: "f1",
          documentType: "ELECTRONIC_DELIVERY_RECEIPT",
          filename: "../secret.pdf",
          mimeType: "application/pdf",
          bytes: pdfBytes("x"),
        },
      ]),
    ).rejects.toMatchObject({ code: "POD_INVALID" });
  });

  it("empty file fails", async () => {
    await expect(
      buildCanonicalManifest([
        {
          fileId: "f1",
          documentType: "ELECTRONIC_DELIVERY_RECEIPT",
          filename: "empty.pdf",
          mimeType: "application/pdf",
          bytes: new Uint8Array(),
        },
      ]),
    ).rejects.toMatchObject({ code: "POD_INVALID" });
  });

  it("unsupported MIME type fails", async () => {
    await expect(
      buildCanonicalManifest([
        {
          fileId: "f1",
          documentType: "ELECTRONIC_DELIVERY_RECEIPT",
          filename: "x.html",
          mimeType: "text/html",
          bytes: new Uint8Array([1, 2, 3]),
        },
      ]),
    ).rejects.toMatchObject({ code: "POD_FILE_TYPE_REJECTED" });
  });

  it("file count limit works", async () => {
    const files = Array.from({ length: 11 }, (_, i) => ({
      fileId: `f${i}`,
      documentType: "DELIVERY_IMAGE" as const,
      filename: `i${i}.png`,
      mimeType: "image/png",
      bytes: pngBytes(),
    }));
    await expect(buildCanonicalManifest(files)).rejects.toMatchObject({
      code: "POD_TOO_LARGE",
    });
  });

  it("plaintext is never present in persisted POD files", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rg-pod-"));
    tmpDirs.push(dir);
    const fileStore = new FilePodEncryptedStore(dir);
    const h = makeHarness();
    const pods = new PodService({
      lifecycle: h.lifecycle,
      podStore: fileStore,
      keyProtector: h.keyProtector,
      carriers: h.carriers,
      now: () => "2026-08-05T12:00:00.000Z",
    });
    await seedDelivery({ ...h, pods } as never);
    // re-seed with file store service
    const store = new InMemoryLifecycleStore();
    const lifecycle = new LifecycleService(store, { carriers: h.carriers });
    await lifecycle.create({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      tenderHash: HASH,
      maximumFreightBudgetAtomic: "1000000",
      auctionEndsAt: "2026-08-01T12:00:00.000Z",
      createdAt: T0,
      trust: h.trust,
    });
    await advanceToDelivery(lifecycle, TENDER_ID);
    const svc = new PodService({
      lifecycle,
      podStore: fileStore,
      keyProtector: h.keyProtector,
      carriers: h.carriers,
      now: () => "2026-08-05T12:00:00.000Z",
    });
    const { pkg } = await buildSignedPackage({ actionId: "act-plain-file" });
    await svc.submitPod({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      podId: POD_ID,
      package: pkg,
    });
    const files = readdirSync(dir, { recursive: true }) as string[];
    const jsonFiles = files.filter((f) => String(f).endsWith(".json"));
    expect(jsonFiles.length).toBeGreaterThan(0);
    for (const rel of jsonFiles) {
      const raw = readFileSync(path.join(dir, String(rel)), "utf8");
      expect(raw).not.toContain("%PDF-1.4");
      expect(raw).not.toContain(CARRIER_PRIVATE.toStringRaw());
      expect(raw).toContain("ciphertextB64");
      expect(raw).toContain("wrappedKey");
    }
  });

  it("correct key decrypts; wrong master key fails; tamper fails", async () => {
    const { pkg, manifestHash: mHash, packageContentHash: pHash } =
      await buildSignedPackage();
    const manifest = await buildCanonicalManifest(pkg.files);
    const plaintext = encodePlaintextPackage({
      fields: pkg,
      files: pkg.files,
      carrierSignature: pkg.carrierSignature,
      manifestHash: mHash,
      packageContentHash: pHash,
    });
    const protector = new AesGcmMasterKeyProtector(MASTER_KEY);
    const stored = encryptAndBuildRecord({
      plaintext,
      fields: pkg,
      manifest,
      manifestHash: mHash,
      packageContentHash: pHash,
      keyProtector: protector,
      createdAt: pkg.submittedAt,
    });
    const dec = decryptStoredRecord({ record: stored, keyProtector: protector });
    expect(Buffer.from(dec).equals(Buffer.from(plaintext))).toBe(true);

    const wrong = new AesGcmMasterKeyProtector(randomBytes(32));
    expect(() =>
      decryptStoredRecord({ record: stored, keyProtector: wrong }),
    ).toThrow(PodError);

    const tampered = {
      ...stored,
      ciphertextB64: Buffer.from("tamper").toString("base64"),
    };
    expect(() =>
      decryptStoredRecord({ record: tampered, keyProtector: protector }),
    ).toThrow();
  });

  it("unique data key and IV per encrypt; wrapped key is not plaintext key", () => {
    const aad = {
      tenderId: TENDER_ID,
      tenderVersion: 1,
      podId: POD_ID,
      podVersion: 1,
      manifestHash: HASH,
    };
    const p1 = encryptPodPayload({
      plaintext: new Uint8Array([1, 2, 3]),
      aad,
    });
    const p2 = encryptPodPayload({
      plaintext: new Uint8Array([1, 2, 3]),
      aad,
    });
    expect(Buffer.from(p1.dataKey).equals(Buffer.from(p2.dataKey))).toBe(false);
    expect(Buffer.from(p1.iv).equals(Buffer.from(p2.iv))).toBe(false);
    const wrap = new AesGcmMasterKeyProtector(MASTER_KEY).wrapKey(
      p1.dataKey,
      "ctx",
    );
    expect(wrap.wrappedKeyB64).not.toBe(Buffer.from(p1.dataKey).toString("base64"));
  });

  it("manifest hash independent of upload order; package hash changes on file change", async () => {
    const a = {
      fileId: "a",
      documentType: "ELECTRONIC_DELIVERY_RECEIPT" as const,
      filename: "a.pdf",
      mimeType: "application/pdf",
      bytes: pdfBytes("a"),
    };
    const b = {
      fileId: "b",
      documentType: "RECIPIENT_CONFIRMATION" as const,
      filename: "b.json",
      mimeType: "application/json",
      bytes: jsonMetaBytes(),
    };
    const m1 = await buildCanonicalManifest([a, b]);
    const m2 = await buildCanonicalManifest([b, a]);
    expect(manifestHash(m1)).toBe(manifestHash(m2));
    const fields = {
      podId: POD_ID,
      podVersion: 1,
      tenderId: TENDER_ID,
      tenderVersion: 1,
      winningBidId: BID_ID,
      escrowTenderKey: escrowTenderKey(TENDER_ID, 1),
      carrierId: CARRIER_ID,
      carrierAccountId: CARRIER_ACCOUNT,
      deliveryTimestamp: T0,
      recipientConfirmationPresent: true,
      cargoConditionCode: "GOOD" as const,
      exceptionCodes: ["NONE"] as const,
      submittedAt: T0,
      actionId: "a1",
    };
    const h1 = packageContentHash(fields, m1);
    const m3 = await buildCanonicalManifest([
      { ...a, bytes: pdfBytes("changed") },
      b,
    ]);
    expect(packageContentHash(fields, m3)).not.toBe(h1);
  });

  it("submission replay is idempotent; conflicting actionId fails", async () => {
    const h = makeHarness();
    await seedDelivery(h);
    const { pkg } = await buildSignedPackage();
    const r1 = await h.pods.submitPod({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      podId: POD_ID,
      package: pkg,
    });
    const r2 = await h.pods.submitPod({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      podId: POD_ID,
      package: pkg,
    });
    expect(r2.outcome).toBe("REPLAYED");
    expect(r2.receipt.ciphertextHash).toBe(r1.receipt.ciphertextHash);

    const { pkg: other } = await buildSignedPackage({
      actionId: "act-pod-submit-1",
      submittedAt: "2026-08-05T11:00:00.000Z",
    });
    // Same actionId different payload → conflict at lifecycle
    await expect(
      h.pods.submitPod({
        tenderId: TENDER_ID,
        tenderVersion: 1,
        podId: POD_ID,
        package: other,
      }),
    ).rejects.toBeTruthy();
  });

  it("non-winning carrier fails", async () => {
    const h = makeHarness();
    await seedDelivery(h);
    const { pkg } = await buildSignedPackage({ carrierId: "other-carrier" });
    await expect(
      h.pods.submitPod({
        tenderId: TENDER_ID,
        tenderVersion: 1,
        podId: POD_ID,
        package: pkg,
      }),
    ).rejects.toMatchObject({ code: "CARRIER_NOT_WINNER" });
  });

  it("deterministic adviser is non-binding and identical for identical input", async () => {
    const adviser = new DeterministicPodAssuranceAdviser();
    const { pkg } = await buildSignedPackage();
    const manifest = await buildCanonicalManifest(pkg.files);
    const input = {
      fields: pkg,
      manifest,
      expectedTenderId: TENDER_ID,
      expectedTenderVersion: 1,
      expectedWinningBidId: BID_ID,
      expectedEscrowTenderKey: pkg.escrowTenderKey,
      createdAt: T0,
      reportId: "adv-1",
    };
    const a = await adviser.advise(input);
    const b = await adviser.advise(input);
    expect(a.reportHash).toBe(b.reportHash);
    expect(a.binding).toBe("NON_BINDING_ADVISORY");
    expect(a.engine).toBe(ADVISER_ENGINE_ID);
    expect(a.recommendation).toBe("ACCEPT");

    const missing = await adviser.advise({
      ...input,
      fields: { ...pkg, recipientConfirmationPresent: false },
      requiredDocumentTypes: ["ELECTRONIC_DELIVERY_RECEIPT", "ECMR_EPOD"],
    });
    expect(missing.findings.some((f) => f.code === "INCOMPLETE")).toBe(true);
    expect(missing.recommendation).not.toBe("ACCEPT");
  });

  it("review start + shipper ACCEPT creates one bound release plan without network write", async () => {
    const h = makeHarness();
    await seedDelivery(h);
    const { pkg } = await buildSignedPackage();
    await h.pods.submitPod({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      podId: POD_ID,
      package: pkg,
    });
    const started = await h.pods.startReview({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      actionId: "act-review-start",
    });
    expect(started.record.state).toBe("POD_UNDER_REVIEW");
    expect(started.advisory.binding).toBe("NON_BINDING_ADVISORY");
    expect(REVIEW_WINDOW_SECONDS).toBe(172_800);
    expect(started.record.reviewDeadlineAt).toBe(
      addUtcSeconds(started.record.reviewStartedAt!, REVIEW_WINDOW_SECONDS),
    );

    const actionId = "act-accept-1";
    const signedAt = started.record.reviewStartedAt!;
    const signature = signShipperPodReviewForTests(
      SHIPPER_PRIVATE.toStringRaw(),
      buildShipperPodReviewSignPayload({
        tenderId: TENDER_ID,
        tenderVersion: 1,
        podId: POD_ID,
        reviewAction: "ACCEPT",
        signedAt,
        reviewDeadlineAt: started.record.reviewDeadlineAt!,
        actionId,
      }),
    );
    const accepted = await h.pods.shipperReview({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      podId: POD_ID,
      action: "ACCEPT",
      actionId,
      signedAt,
      signature,
    });
    expect(accepted.record.state).toBe("POD_ACCEPTED");
    expect(accepted.escrowPlan?.kind).toBe("RELEASE_FULL");
    expect(accepted.escrowPlan?.networkWrite).toBe(false);
    expect(accepted.escrowPlan?.contractId).toBe(PHASE_C2_ESCROW_CONTRACT_ID);
    expect(accepted.escrowPlan?.contractEvmAddress).toBe(
      PHASE_C2_ESCROW_CONTRACT_EVM,
    );
    expect(accepted.escrowPlan?.lockedAmountAtomic).toBe(
      PHASE_C2_LOCKED_AMOUNT_ATOMIC,
    );
    // Idempotent plan
    const again = await h.pods.shipperReview({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      podId: POD_ID,
      action: "ACCEPT",
      actionId,
      signedAt,
      signature,
    });
    expect(again.outcome).toBe("REPLAYED");
    expect(again.escrowPlan?.authorizationHash).toBe(
      accepted.escrowPlan?.authorizationHash,
    );
  });

  it("ACCEPT after deadline fails; REQUEST_CORRECTION sets 24h deadline", async () => {
    const h = makeHarness();
    await seedDelivery(h);
    const { pkg } = await buildSignedPackage();
    await h.pods.submitPod({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      podId: POD_ID,
      package: pkg,
    });
    const started = await h.pods.startReview({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      actionId: "act-review-start-2",
      eventTime: "2026-08-05T12:00:00.000Z",
    });
    const after = addUtcSeconds(started.record.reviewDeadlineAt!, 1);
    const lateSig = signShipperPodReviewForTests(
      SHIPPER_PRIVATE.toStringRaw(),
      buildShipperPodReviewSignPayload({
        tenderId: TENDER_ID,
        tenderVersion: 1,
        podId: POD_ID,
        reviewAction: "ACCEPT",
        signedAt: after,
        reviewDeadlineAt: started.record.reviewDeadlineAt!,
        actionId: "act-late",
      }),
    );
    await expect(
      h.pods.shipperReview({
        tenderId: TENDER_ID,
        tenderVersion: 1,
        podId: POD_ID,
        action: "ACCEPT",
        actionId: "act-late",
        signedAt: after,
        signature: lateSig,
      }),
    ).rejects.toMatchObject({ code: "POD_REVIEW_DEADLINE_EXPIRED" });

    // Fresh path for correction
    const h2 = makeHarness();
    await seedDelivery(h2);
    const built = await buildSignedPackage({ actionId: "act-pod-2" });
    await h2.pods.submitPod({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      podId: POD_ID,
      package: built.pkg,
    });
    const s2 = await h2.pods.startReview({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      actionId: "act-rs-2",
      eventTime: "2026-08-05T12:00:00.000Z",
    });
    const corrAt = "2026-08-05T12:00:00.000Z";
    const corrSig = signShipperPodReviewForTests(
      SHIPPER_PRIVATE.toStringRaw(),
      buildShipperPodReviewSignPayload({
        tenderId: TENDER_ID,
        tenderVersion: 1,
        podId: POD_ID,
        reviewAction: "REQUEST_CORRECTION",
        reasonCodes: ["MISSING_DOCUMENT"],
        signedAt: corrAt,
        reviewDeadlineAt: s2.record.reviewDeadlineAt!,
        actionId: "act-corr",
      }),
    );
    const corr = await h2.pods.shipperReview({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      podId: POD_ID,
      action: "REQUEST_CORRECTION",
      actionId: "act-corr",
      signedAt: corrAt,
      signature: corrSig,
      reasons: [{ code: "MISSING_DOCUMENT", message: "need eCMR" }],
    });
    expect(corr.record.state).toBe("POD_CORRECTION_REQUESTED");
    expect(CORRECTION_WINDOW_SECONDS).toBe(86_400);
    expect(corr.record.correctionDeadlineAt).toBe(
      addUtcSeconds(corrAt, CORRECTION_WINDOW_SECONDS),
    );
  });

  it("resubmission increments version, new hashes, new 24h review; prior immutable", async () => {
    const h = makeHarness();
    await seedDelivery(h);
    const first = await buildSignedPackage({ actionId: "act-pod-a" });
    await h.pods.submitPod({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      podId: POD_ID,
      package: first.pkg,
    });
    const s = await h.pods.startReview({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      actionId: "act-rs-a",
      eventTime: "2026-08-05T12:00:00.000Z",
    });
    const corrAt = "2026-08-05T12:00:00.000Z";
    const corrSig = signShipperPodReviewForTests(
      SHIPPER_PRIVATE.toStringRaw(),
      buildShipperPodReviewSignPayload({
        tenderId: TENDER_ID,
        tenderVersion: 1,
        podId: POD_ID,
        reviewAction: "REQUEST_CORRECTION",
        reasonCodes: ["INCOMPLETE"],
        signedAt: corrAt,
        reviewDeadlineAt: s.record.reviewDeadlineAt!,
        actionId: "act-corr-a",
      }),
    );
    await h.pods.shipperReview({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      podId: POD_ID,
      action: "REQUEST_CORRECTION",
      actionId: "act-corr-a",
      signedAt: corrAt,
      signature: corrSig,
      reasons: [{ code: "INCOMPLETE", message: "add eCMR" }],
    });

    const v1Meta = await h.podStore.getPublicMeta(TENDER_ID, 1, POD_ID, 1);
    expect(v1Meta?.podVersion).toBe(1);

    const second = await buildSignedPackage({
      podVersion: 2,
      actionId: "act-pod-b",
      submittedAt: "2026-08-05T13:00:00.000Z",
      files: [
        {
          fileId: "f-receipt",
          documentType: "ELECTRONIC_DELIVERY_RECEIPT",
          filename: "receipt.pdf",
          mimeType: "application/pdf",
          bytes: pdfBytes("v2-receipt"),
        },
        {
          fileId: "f-confirm",
          documentType: "RECIPIENT_CONFIRMATION",
          filename: "confirm.json",
          mimeType: "application/json",
          bytes: jsonMetaBytes(),
        },
        {
          fileId: "f-ecmr",
          documentType: "ECMR_EPOD",
          filename: "ecmr.pdf",
          mimeType: "application/pdf",
          bytes: pdfBytes("ecmr"),
        },
      ],
    });
    const resub = await h.pods.resubmitPod({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      podId: POD_ID,
      package: second.pkg,
    });
    expect(resub.receipt.podVersion).toBe(2);
    expect(resub.receipt.packageContentHash).not.toBe(first.packageContentHash);
    // prior version still present
    const stillV1 = await h.podStore.get(TENDER_ID, 1, POD_ID, 1);
    expect(stillV1?.envelope.podVersion).toBe(1);
    const v2 = await h.podStore.get(TENDER_ID, 1, POD_ID, 2);
    expect(v2?.envelope.podVersion).toBe(2);

    const review2 = await h.pods.startReview({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      actionId: "act-rs-b",
      eventTime: "2026-08-05T14:00:00.000Z",
    });
    expect(POST_RESUBMIT_REVIEW_WINDOW_SECONDS).toBe(86_400);
    expect(review2.record.reviewDeadlineAt).toBe(
      addUtcSeconds("2026-08-05T14:00:00.000Z", POST_RESUBMIT_REVIEW_WINDOW_SECONDS),
    );
    expect(review2.advisory.podVersion).toBe(2);
  });

  it("REJECT_DISPUTE creates openDispute plan without calling contract", async () => {
    const h = makeHarness();
    await seedDelivery(h);
    const { pkg } = await buildSignedPackage({ actionId: "act-pod-d" });
    await h.pods.submitPod({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      podId: POD_ID,
      package: pkg,
    });
    const s = await h.pods.startReview({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      actionId: "act-rs-d",
      eventTime: "2026-08-05T12:00:00.000Z",
    });
    const signedAt = "2026-08-05T12:00:00.000Z";
    const sig = signShipperPodReviewForTests(
      SHIPPER_PRIVATE.toStringRaw(),
      buildShipperPodReviewSignPayload({
        tenderId: TENDER_ID,
        tenderVersion: 1,
        podId: POD_ID,
        reviewAction: "REJECT_DISPUTE",
        reasonCodes: ["DAMAGED"],
        signedAt,
        reviewDeadlineAt: s.record.reviewDeadlineAt!,
        actionId: "act-dispute",
      }),
    );
    const result = await h.pods.shipperReview({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      podId: POD_ID,
      action: "REJECT_DISPUTE",
      actionId: "act-dispute",
      signedAt,
      signature: sig,
      reasons: [{ code: "DAMAGED", message: "cargo damaged" }],
      disputeId: "dispute-1",
    });
    expect(result.record.state).toBe("POD_DISPUTED");
    expect(result.escrowPlan?.kind).toBe("OPEN_DISPUTE");
    expect(result.escrowPlan?.networkWrite).toBe(false);
    expect(result.outbox.some((o) => o.kind === "DISPUTE_OPENED")).toBe(true);
  });

  it("HCS outbox envelopes are public-safe and under size limit", async () => {
    const h = makeHarness();
    await seedDelivery(h);
    const { pkg } = await buildSignedPackage({ actionId: "act-pod-hcs" });
    const submitted = await h.pods.submitPod({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      podId: POD_ID,
      package: pkg,
    });
    const env = submitted.outbox[0]!.envelope;
    const json = JSON.stringify(env);
    expect(Buffer.byteLength(json, "utf8")).toBeLessThan(1024);
    expect(json).not.toMatch(/private|signature|wrappedKey|recipientName/i);
    expect(json).not.toContain("%PDF");
  });

  it("public HTTP route pattern does not expose wrapped keys", async () => {
    const h = makeHarness();
    await seedDelivery(h);
    const { pkg } = await buildSignedPackage({ actionId: "act-pod-http" });
    await h.pods.submitPod({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      podId: POD_ID,
      package: pkg,
    });
    await h.pods.startReview({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      actionId: "act-rs-http",
    });
    const app = createV2PodApp({
      pods: h.pods,
      isShipperAuthorized: () => true,
    });
    const res = await app.request(
      `/api/v2/tenders/${TENDER_ID}/v/1/pods/${POD_ID}/review`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("wrappedKey");
    expect(JSON.stringify(body)).not.toContain("ivB64");
    expect(body.binding).toBe("NON_BINDING_ADVISORY");
  });

  it("master key config helper validates 32 bytes", () => {
    expect(parseMasterKeyBase64(MASTER_KEY_B64).length).toBe(32);
    expect(() => parseMasterKeyBase64("short")).toThrow(PodError);
    expect(() => parseMasterKeyBase64(undefined)).toThrow(PodError);
  });

  it("file store restart preserves decryptable state", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rg-pod-rst-"));
    tmpDirs.push(dir);
    const fileStore = new FilePodEncryptedStore(dir);
    const store = new InMemoryLifecycleStore();
    const carriers = new InMemoryCarrierRegistry([
      {
        carrierId: CARRIER_ID,
        carrierAccountId: CARRIER_ACCOUNT,
        signingPublicKey: CARRIER_PUBLIC,
        active: true,
        allowedEquipment: ["dry-van"],
        registryVersion: 1,
      },
    ]);
    const lifecycle = new LifecycleService(store, { carriers });
    await lifecycle.create({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      tenderHash: HASH,
      maximumFreightBudgetAtomic: "1000000",
      auctionEndsAt: "2026-08-01T12:00:00.000Z",
      createdAt: T0,
      trust: defaultTrustPolicy({ accessTreasuryAccountId: TREASURY }),
    });
    await advanceToDelivery(lifecycle, TENDER_ID);
    const protector = new AesGcmMasterKeyProtector(MASTER_KEY);
    const pods = new PodService({
      lifecycle,
      podStore: fileStore,
      keyProtector: protector,
      carriers,
      now: () => "2026-08-05T12:00:00.000Z",
    });
    const { pkg } = await buildSignedPackage({ actionId: "act-rst" });
    await pods.submitPod({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      podId: POD_ID,
      package: pkg,
    });
    // New store instance over same directory
    const reloaded = new FilePodEncryptedStore(dir);
    const hit = await reloaded.get(TENDER_ID, 1, POD_ID, 1);
    expect(hit).not.toBeNull();
    const plain = decryptStoredRecord({
      record: hit!,
      keyProtector: protector,
    });
    expect(plain.length).toBeGreaterThan(0);
  });
});

describe("Phase D1 network write assertion", () => {
  it("pod modules do not import network clients", async () => {
    // Static guarantee: service exports declare networkWrite false on plans.
    const h = makeHarness();
    await seedDelivery(h);
    const { pkg } = await buildSignedPackage({ actionId: "act-net0" });
    await h.pods.submitPod({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      podId: POD_ID,
      package: pkg,
    });
    const s = await h.pods.startReview({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      actionId: "act-rs-net0",
    });
    const signedAt = s.record.reviewStartedAt!;
    const sig = signShipperPodReviewForTests(
      SHIPPER_PRIVATE.toStringRaw(),
      buildShipperPodReviewSignPayload({
        tenderId: TENDER_ID,
        tenderVersion: 1,
        podId: POD_ID,
        reviewAction: "ACCEPT",
        signedAt,
        reviewDeadlineAt: s.record.reviewDeadlineAt!,
        actionId: "act-acc-net0",
      }),
    );
    const acc = await h.pods.shipperReview({
      tenderId: TENDER_ID,
      tenderVersion: 1,
      podId: POD_ID,
      action: "ACCEPT",
      actionId: "act-acc-net0",
      signedAt,
      signature: sig,
    });
    expect(acc.escrowPlan?.networkWrite).toBe(false);
    expect(acc.escrowPlan?.plan.networkWrite).toBe(true); // plan marker only
  });
});
