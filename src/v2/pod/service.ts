/**
 * POD submission, review, correction, and escrow-plan orchestration.
 * NETWORK_WRITES=0 — no HCS submit, no contract calls, no live AI.
 */

import type { CarrierRegistry } from "../../domain/carrier";
import { isBeforeOrEqualUtc } from "../../domain/time";
import {
  AuthorizationError,
  verifyCarrierPodSubmission,
  verifyShipperPodReview,
} from "../auth/verify";
import { escrowTenderKey } from "../escrow/tender-key";
import type { LifecycleEvent } from "../lifecycle/events";
import {
  trustPolicyFromRecord,
  type LifecycleRecord,
} from "../lifecycle/record";
import type { LifecycleService } from "../store/lifecycle-service";
import {
  DeterministicPodAssuranceAdviser,
  deterministicReportId,
  type PodAssuranceAdviser,
} from "./adviser";
import {
  buildBoundOpenDisputePlan,
  buildBoundReleaseFullPlan,
  disputeAuthorizationHash,
  shipperAcceptanceAuthorizationHash,
  type BoundEscrowPlan,
} from "./escrow-plans";
import { PodError } from "./errors";
import {
  assertPackageFields,
  buildCanonicalManifest,
  manifestHash,
  packageContentHash,
} from "./manifest";
import {
  buildPodAdvisoryAnchoredEnvelope,
  buildPodReviewActionEnvelope,
  buildPodSubmittedEnvelope,
  buildDisputeOpenedEnvelope,
  type PodOutboxItem,
} from "./outbox";
import { encodePlaintextPackage, decodePlaintextPackage } from "./package";
import {
  DEFAULT_POD_FILE_POLICY,
  DeterministicSafePodScanner,
  type PodContentScanner,
  type PodFilePolicy,
} from "./policy";
import {
  decryptStoredRecord,
  encryptAndBuildRecord,
  type PodEncryptedStore,
  type PublicPodMetadata,
} from "./storage";
import type { PodKeyProtector } from "./key-protector";
import type {
  PodAdvisoryReport,
  PublicPodReceipt,
  SignedPodPackage,
} from "./types";

export type PodServiceDeps = {
  readonly lifecycle: LifecycleService;
  readonly podStore: PodEncryptedStore;
  readonly keyProtector: PodKeyProtector;
  readonly carriers: CarrierRegistry;
  readonly now: () => string;
  readonly adviser?: PodAssuranceAdviser;
  readonly scanner?: PodContentScanner;
  readonly filePolicy?: PodFilePolicy;
  /** Optional escrow contract binding for release/dispute plans. */
  readonly escrowContractId?: string;
  readonly escrowContractEvm?: string;
  readonly requirePhaseC2LiveBindings?: boolean;
};

export type PodSubmitResult = {
  readonly receipt: PublicPodReceipt;
  readonly outcome: "APPLIED" | "REPLAYED";
  readonly outbox: readonly PodOutboxItem[];
};

export type PodReviewStartResult = {
  readonly record: LifecycleRecord;
  readonly advisory: PodAdvisoryReport;
  readonly outbox: readonly PodOutboxItem[];
};

export type ShipperReviewResult = {
  readonly record: LifecycleRecord;
  readonly action: "ACCEPT" | "REQUEST_CORRECTION" | "REJECT_DISPUTE";
  readonly escrowPlan: BoundEscrowPlan | null;
  readonly outbox: readonly PodOutboxItem[];
  readonly outcome: "APPLIED" | "REPLAYED";
};

/** Private advisory journal — never public. */
export interface AdvisoryReportStore {
  put(report: PodAdvisoryReport): Promise<void>;
  get(reportId: string): Promise<PodAdvisoryReport | null>;
  getByPod(
    tenderId: string,
    podId: string,
    podVersion: number,
  ): Promise<PodAdvisoryReport | null>;
}

export class MemoryAdvisoryReportStore implements AdvisoryReportStore {
  private readonly byId = new Map<string, PodAdvisoryReport>();
  private readonly byPod = new Map<string, string>();

  async put(report: PodAdvisoryReport): Promise<void> {
    if (this.byId.has(report.reportId)) {
      const existing = this.byId.get(report.reportId)!;
      if (existing.reportHash !== report.reportHash) {
        throw new PodError("ACTION_ID_CONFLICT", "advisory report conflict");
      }
      return;
    }
    this.byId.set(report.reportId, report);
    this.byPod.set(
      `${report.tenderId}|${report.podId}|${report.podVersion}`,
      report.reportId,
    );
  }

  async get(reportId: string): Promise<PodAdvisoryReport | null> {
    return this.byId.get(reportId) ?? null;
  }

  async getByPod(
    tenderId: string,
    podId: string,
    podVersion: number,
  ): Promise<PodAdvisoryReport | null> {
    const id = this.byPod.get(`${tenderId}|${podId}|${podVersion}`);
    return id ? (this.byId.get(id) ?? null) : null;
  }
}

export class PodService {
  private readonly adviser: PodAssuranceAdviser;
  private readonly scanner: PodContentScanner;
  private readonly policy: PodFilePolicy;
  private readonly advisoryStore: AdvisoryReportStore;
  private readonly releasePlans = new Map<string, BoundEscrowPlan>();
  private readonly disputePlans = new Map<string, BoundEscrowPlan>();

  constructor(
    private readonly deps: PodServiceDeps,
    advisoryStore?: AdvisoryReportStore,
  ) {
    this.adviser = deps.adviser ?? new DeterministicPodAssuranceAdviser();
    this.scanner = deps.scanner ?? new DeterministicSafePodScanner();
    this.policy = deps.filePolicy ?? DEFAULT_POD_FILE_POLICY;
    this.advisoryStore = advisoryStore ?? new MemoryAdvisoryReportStore();
  }

  getReleasePlan(tenderId: string, actionId: string): BoundEscrowPlan | null {
    return this.releasePlans.get(`${tenderId}|${actionId}`) ?? null;
  }

  getDisputePlan(tenderId: string, actionId: string): BoundEscrowPlan | null {
    return this.disputePlans.get(`${tenderId}|${actionId}`) ?? null;
  }

  async submitPod(input: {
    tenderId: string;
    tenderVersion: number;
    podId: string;
    package: SignedPodPackage;
  }): Promise<PodSubmitResult> {
    const record = await this.requireRecord(input.tenderId, input.tenderVersion);
    const pkg = input.package;

    if (pkg.podId !== input.podId) {
      throw new PodError("POD_INVALID", "podId path/body mismatch");
    }
    if (pkg.tenderId !== input.tenderId || pkg.tenderVersion !== input.tenderVersion) {
      throw new PodError("POD_INVALID", "tender path/body mismatch");
    }

    assertPackageFields(pkg);

    // Initial submit only from DELIVERY_REPORTED. Replay may already be POD_SUBMITTED.
    if (record.state === "POD_CORRECTION_REQUESTED") {
      throw new PodError(
        "POD_STATE_INVALID",
        "use resubmission for correction-requested state",
      );
    }
    if (record.state !== "DELIVERY_REPORTED" && record.state !== "POD_SUBMITTED") {
      throw new PodError(
        "POD_STATE_INVALID",
        "POD submission not allowed in this state",
      );
    }

    this.assertWinningCarrier(record, pkg.carrierId, pkg.carrierAccountId);
    const expectedKey = escrowTenderKey(record.tenderId, record.tenderVersion);
    if (pkg.escrowTenderKey !== expectedKey) {
      throw new PodError("POD_INVALID", "escrow tender key mismatch");
    }
    if (pkg.winningBidId !== record.winningBidId) {
      throw new PodError("POD_INVALID", "winning bid mismatch");
    }
    if (pkg.podVersion !== 1 && record.state === "DELIVERY_REPORTED") {
      throw new PodError("POD_VERSION_CONFLICT", "initial POD version must be 1");
    }

    const manifest = await buildCanonicalManifest(
      pkg.files,
      this.policy,
      this.scanner,
    );
    const mHash = manifestHash(manifest);
    const pHash = packageContentHash(pkg, manifest);
    if (pkg.manifestHash && pkg.manifestHash !== mHash) {
      throw new PodError("POD_MANIFEST_MISMATCH", "declared manifest hash mismatch");
    }
    if (pkg.packageContentHash && pkg.packageContentHash !== pHash) {
      throw new PodError("POD_HASH_MISMATCH", "declared package hash mismatch");
    }

    const carrier = this.deps.carriers.getById(pkg.carrierId);
    if (!carrier?.active || !carrier.signingPublicKey) {
      throw new PodError("POD_SIGNATURE_INVALID", "carrier not trusted");
    }

    try {
      verifyCarrierPodSubmission({
        registeredPublicKey: carrier.signingPublicKey,
        podId: pkg.podId,
        podVersion: pkg.podVersion,
        tenderId: pkg.tenderId,
        tenderVersion: pkg.tenderVersion,
        winningBidId: pkg.winningBidId,
        escrowTenderKey: pkg.escrowTenderKey,
        carrierId: pkg.carrierId,
        carrierAccountId: pkg.carrierAccountId,
        deliveryTimestamp: pkg.deliveryTimestamp,
        manifestHash: mHash,
        packageContentHash: pHash,
        submittedAt: pkg.submittedAt,
        actionId: pkg.actionId,
        signature: pkg.carrierSignature,
      });
    } catch (err) {
      if (err instanceof AuthorizationError) {
        throw new PodError("POD_SIGNATURE_INVALID", "carrier signature invalid");
      }
      throw err;
    }

    // Idempotent replay: same actionId already committed → return prior receipt.
    const current = await this.deps.lifecycle.get(input.tenderId);
    const priorAction = current?.processedActions[pkg.actionId];
    if (priorAction) {
      const prior = await this.deps.podStore.get(
        pkg.tenderId,
        pkg.tenderVersion,
        pkg.podId,
        pkg.podVersion,
      );
      if (!prior) {
        throw new PodError(
          "PERSISTENCE_CONFLICT",
          "lifecycle claims POD without storage",
        );
      }
      if (prior.envelope.plaintextPackageHash !== pHash) {
        throw new PodError("ACTION_ID_CONFLICT", "actionId conflict");
      }
      const next = current!;
      return {
        receipt: {
          podId: pkg.podId,
          podVersion: pkg.podVersion,
          tenderId: pkg.tenderId,
          tenderVersion: pkg.tenderVersion,
          state: next.state,
          manifestHash: prior.envelope.manifestHash,
          packageContentHash: prior.envelope.plaintextPackageHash,
          ciphertextHash: prior.envelope.ciphertextHash,
          submittedAt: prior.envelope.createdAt,
          reviewEligible:
            next.state === "POD_SUBMITTED" || next.state === "POD_RESUBMITTED",
        },
        outcome: "REPLAYED",
        outbox: [
          {
            kind: "POD_SUBMITTED",
            envelope: buildPodSubmittedEnvelope(next, {
              sizeBytes: prior.envelope.publicManifest.totalBytes,
            }),
          },
        ],
      };
    }

    const plaintext = encodePlaintextPackage({
      fields: pkg,
      files: pkg.files,
      carrierSignature: pkg.carrierSignature,
      manifestHash: mHash,
      packageContentHash: pHash,
    });

    const stored = encryptAndBuildRecord({
      plaintext,
      fields: pkg,
      manifest,
      manifestHash: mHash,
      packageContentHash: pHash,
      keyProtector: this.deps.keyProtector,
      createdAt: pkg.submittedAt,
    });

    const commitEvent: LifecycleEvent = {
      type: "POD_PACKAGE_SUBMITTED",
      actionId: pkg.actionId,
      eventTime: pkg.submittedAt,
      podId: pkg.podId,
      podVersion: pkg.podVersion,
      contentHash: pHash,
      ciphertextHash: stored.envelope.ciphertextHash,
    };

    const existingMeta = await this.deps.podStore.getPublicMeta(
      pkg.tenderId,
      pkg.tenderVersion,
      pkg.podId,
      pkg.podVersion,
    );
    if (existingMeta) {
      throw new PodError("POD_ALREADY_EXISTS", "POD storage already exists");
    }

    let outcome: "APPLIED" | "REPLAYED";
    try {
      // Persist encrypted package first, then lifecycle — on lifecycle failure
      // the unique storage key prevents silent double-write on retry.
      await this.deps.podStore.put(stored);
      const applied = await this.deps.lifecycle.apply(input.tenderId, commitEvent);
      outcome = applied.outcome;
    } catch (err) {
      if (err instanceof PodError) throw err;
      const msg = err instanceof Error ? err.message : "lifecycle apply failed";
      if (/conflict|CONFLICT|Action/i.test(msg)) {
        throw new PodError("ACTION_ID_CONFLICT", "actionId conflict");
      }
      if (/Illegal|state|transition/i.test(msg)) {
        throw new PodError("POD_STATE_INVALID", "invalid lifecycle state for POD");
      }
      throw err;
    }

    const next = (await this.deps.lifecycle.get(input.tenderId))!;
    const receipt: PublicPodReceipt = {
      podId: pkg.podId,
      podVersion: pkg.podVersion,
      tenderId: pkg.tenderId,
      tenderVersion: pkg.tenderVersion,
      state: next.state,
      manifestHash: mHash,
      packageContentHash: pHash,
      ciphertextHash: stored.envelope.ciphertextHash,
      submittedAt: pkg.submittedAt,
      reviewEligible: next.state === "POD_SUBMITTED" || next.state === "POD_RESUBMITTED",
    };

    const outbox: PodOutboxItem[] = [
      {
        kind: "POD_SUBMITTED",
        envelope: buildPodSubmittedEnvelope(next, {
          sizeBytes: manifest.totalBytes,
        }),
      },
    ];

    return { receipt, outcome, outbox };
  }

  async resubmitPod(input: {
    tenderId: string;
    tenderVersion: number;
    podId: string;
    package: SignedPodPackage;
  }): Promise<PodSubmitResult> {
    const record = await this.requireRecord(input.tenderId, input.tenderVersion);
    if (record.state !== "POD_CORRECTION_REQUESTED") {
      throw new PodError("POD_STATE_INVALID", "resubmission not allowed");
    }
    if (!record.correctionDeadlineAt) {
      throw new PodError("POD_STATE_INVALID", "correction deadline missing");
    }
    const pkg = input.package;
    if (!isBeforeOrEqualUtc(pkg.submittedAt, record.correctionDeadlineAt)) {
      throw new PodError(
        "POD_CORRECTION_DEADLINE_EXPIRED",
        "correction deadline expired",
      );
    }
    if (pkg.podId !== record.podId) {
      throw new PodError("POD_INVALID", "podId must match prior POD");
    }
    const expectedVersion = (record.podVersion ?? 0) + 1;
    if (pkg.podVersion !== expectedVersion) {
      throw new PodError(
        "POD_VERSION_CONFLICT",
        `podVersion must be ${expectedVersion}`,
      );
    }

    assertPackageFields(pkg);
    this.assertWinningCarrier(record, pkg.carrierId, pkg.carrierAccountId);

    const manifest = await buildCanonicalManifest(
      pkg.files,
      this.policy,
      this.scanner,
    );
    const mHash = manifestHash(manifest);
    const pHash = packageContentHash(pkg, manifest);
    if (pHash === record.podContentHash) {
      throw new PodError("POD_HASH_MISMATCH", "resubmission must change package hash");
    }

    const carrier = this.deps.carriers.getById(pkg.carrierId);
    if (!carrier?.signingPublicKey) {
      throw new PodError("POD_SIGNATURE_INVALID", "carrier not trusted");
    }
    try {
      verifyCarrierPodSubmission({
        registeredPublicKey: carrier.signingPublicKey,
        podId: pkg.podId,
        podVersion: pkg.podVersion,
        tenderId: pkg.tenderId,
        tenderVersion: pkg.tenderVersion,
        winningBidId: pkg.winningBidId,
        escrowTenderKey: pkg.escrowTenderKey,
        carrierId: pkg.carrierId,
        carrierAccountId: pkg.carrierAccountId,
        deliveryTimestamp: pkg.deliveryTimestamp,
        manifestHash: mHash,
        packageContentHash: pHash,
        submittedAt: pkg.submittedAt,
        actionId: pkg.actionId,
        signature: pkg.carrierSignature,
      });
    } catch {
      throw new PodError("POD_SIGNATURE_INVALID", "carrier signature invalid");
    }

    const plaintext = encodePlaintextPackage({
      fields: pkg,
      files: pkg.files,
      carrierSignature: pkg.carrierSignature,
      manifestHash: mHash,
      packageContentHash: pHash,
    });
    const stored = encryptAndBuildRecord({
      plaintext,
      fields: pkg,
      manifest,
      manifestHash: mHash,
      packageContentHash: pHash,
      keyProtector: this.deps.keyProtector,
      createdAt: pkg.submittedAt,
    });

    const event: LifecycleEvent = {
      type: "POD_PACKAGE_RESUBMITTED",
      actionId: pkg.actionId,
      eventTime: pkg.submittedAt,
      podId: pkg.podId,
      podVersion: pkg.podVersion,
      contentHash: pHash,
      ciphertextHash: stored.envelope.ciphertextHash,
    };

    let outcome: "APPLIED" | "REPLAYED";
    try {
      const applied = await this.deps.lifecycle.apply(input.tenderId, event);
      outcome = applied.outcome;
      if (outcome === "APPLIED") {
        await this.deps.podStore.put(stored);
      }
    } catch (err) {
      if (err instanceof PodError) throw err;
      const msg = err instanceof Error ? err.message : "";
      if (/AFTER_CORRECTION/.test(msg)) {
        throw new PodError(
          "POD_CORRECTION_DEADLINE_EXPIRED",
          "correction deadline expired",
        );
      }
      if (/conflict|CONFLICT/i.test(msg)) {
        throw new PodError("ACTION_ID_CONFLICT", "actionId conflict");
      }
      throw err;
    }

    const next = (await this.deps.lifecycle.get(input.tenderId))!;
    return {
      receipt: {
        podId: pkg.podId,
        podVersion: pkg.podVersion,
        tenderId: pkg.tenderId,
        tenderVersion: pkg.tenderVersion,
        state: next.state,
        manifestHash: mHash,
        packageContentHash: pHash,
        ciphertextHash: stored.envelope.ciphertextHash,
        submittedAt: pkg.submittedAt,
        reviewEligible: true,
      },
      outcome,
      outbox: [
        {
          kind: "POD_SUBMITTED",
          envelope: buildPodSubmittedEnvelope(next, {
            sizeBytes: manifest.totalBytes,
          }),
        },
      ],
    };
  }

  async startReview(input: {
    tenderId: string;
    tenderVersion: number;
    actionId: string;
    eventTime?: string;
  }): Promise<PodReviewStartResult> {
    const record = await this.requireRecord(input.tenderId, input.tenderVersion);
    if (record.state !== "POD_SUBMITTED" && record.state !== "POD_RESUBMITTED") {
      throw new PodError("POD_REVIEW_NOT_ALLOWED", "review start not allowed");
    }
    if (!record.podId || record.podVersion == null) {
      throw new PodError("POD_NOT_FOUND", "POD not bound on lifecycle");
    }

    const stored = await this.deps.podStore.get(
      record.tenderId,
      record.tenderVersion,
      record.podId,
      record.podVersion,
    );
    if (!stored) {
      throw new PodError("POD_NOT_FOUND", "encrypted POD missing");
    }

    const plaintext = decryptStoredRecord({
      record: stored,
      keyProtector: this.deps.keyProtector,
    });
    const decoded = decodePlaintextPackage(plaintext);
    const eventTime = input.eventTime ?? this.deps.now();

    const reportId = deterministicReportId(
      `${record.tenderId}|${record.podId}|v${record.podVersion}|${stored.envelope.plaintextPackageHash}`,
    );
    let advisory =
      (await this.advisoryStore.getByPod(
        record.tenderId,
        record.podId,
        record.podVersion,
      )) ?? null;
    if (!advisory) {
      advisory = await this.adviser.advise({
        fields: decoded.fields,
        manifest: stored.envelope.publicManifest,
        expectedTenderId: record.tenderId,
        expectedTenderVersion: record.tenderVersion,
        expectedWinningBidId: record.winningBidId ?? "",
        expectedEscrowTenderKey: escrowTenderKey(
          record.tenderId,
          record.tenderVersion,
        ),
        createdAt: eventTime,
        reportId,
      });
      await this.advisoryStore.put(advisory);
    }

    const reviewEvent: LifecycleEvent = {
      type: "POD_REVIEW_STARTED",
      actionId: input.actionId,
      eventTime,
    };
    await this.deps.lifecycle.apply(input.tenderId, reviewEvent);

    const advisoryEvent: LifecycleEvent = {
      type: "POD_ADVISORY_ANCHORED",
      actionId: `${input.actionId}:advisory`,
      eventTime,
      reportHash: advisory.reportHash,
      binding: "NON_BINDING_ADVISORY",
    };
    await this.deps.lifecycle.apply(input.tenderId, advisoryEvent);

    const next = (await this.deps.lifecycle.get(input.tenderId))!;
    return {
      record: next,
      advisory,
      outbox: [
        {
          kind: "POD_ADVISORY_ANCHORED",
          envelope: buildPodAdvisoryAnchoredEnvelope(next, advisory.reportHash),
        },
      ],
    };
  }

  async getReviewBundle(input: {
    tenderId: string;
    tenderVersion: number;
    podId: string;
    /** Shipper-authorized privileged access — never for public/Judge routes. */
    authorizedShipper: boolean;
  }): Promise<{
    publicMeta: PublicPodMetadata;
    reviewDeadlineAt: string | null;
    advisory: PodAdvisoryReport | null;
    bindingLabel: "NON_BINDING_ADVISORY";
    decrypted: ReturnType<typeof decodePlaintextPackage> | null;
    availableActions: readonly string[];
  }> {
    if (!input.authorizedShipper) {
      throw new PodError("POD_REVIEW_NOT_ALLOWED", "shipper authorization required");
    }
    const record = await this.requireRecord(input.tenderId, input.tenderVersion);
    if (record.podId !== input.podId) {
      throw new PodError("POD_NOT_FOUND", "podId not bound");
    }
    const version = record.podVersion ?? 1;
    const stored = await this.deps.podStore.get(
      record.tenderId,
      record.tenderVersion,
      input.podId,
      version,
    );
    if (!stored) throw new PodError("POD_NOT_FOUND", "encrypted POD missing");

    const decrypted = decodePlaintextPackage(
      decryptStoredRecord({
        record: stored,
        keyProtector: this.deps.keyProtector,
      }),
    );
    const advisory = await this.advisoryStore.getByPod(
      record.tenderId,
      input.podId,
      version,
    );

    return {
      publicMeta: {
        tenderId: stored.envelope.tenderId,
        tenderVersion: stored.envelope.tenderVersion,
        podId: stored.envelope.podId,
        podVersion: stored.envelope.podVersion,
        manifestHash: stored.envelope.manifestHash,
        packageContentHash: stored.envelope.plaintextPackageHash,
        ciphertextHash: stored.envelope.ciphertextHash,
        documentCount: stored.envelope.publicManifest.documentCount,
        totalBytes: stored.envelope.publicManifest.totalBytes,
        createdAt: stored.envelope.createdAt,
        encryptionAlg: stored.envelope.encryptionAlg,
      },
      reviewDeadlineAt: record.reviewDeadlineAt,
      advisory,
      bindingLabel: "NON_BINDING_ADVISORY",
      decrypted,
      availableActions:
        record.state === "POD_UNDER_REVIEW"
          ? ["ACCEPT", "REQUEST_CORRECTION", "REJECT_DISPUTE"]
          : [],
    };
  }

  async shipperReview(input: {
    tenderId: string;
    tenderVersion: number;
    podId: string;
    action: "ACCEPT" | "REQUEST_CORRECTION" | "REJECT_DISPUTE";
    actionId: string;
    signedAt: string;
    reasons?: readonly { code: string; message: string }[];
    signature: string;
    disputeId?: string;
  }): Promise<ShipperReviewResult> {
    const record = await this.requireRecord(input.tenderId, input.tenderVersion);
    const prior = record.processedActions[input.actionId];
    if (prior) {
      const escrowPlan =
        this.releasePlans.get(`${input.tenderId}|${input.actionId}`) ??
        this.disputePlans.get(`${input.tenderId}|${input.actionId}`) ??
        null;
      return {
        record,
        action: input.action,
        escrowPlan,
        outbox: [],
        outcome: "REPLAYED",
      };
    }
    if (record.state !== "POD_UNDER_REVIEW") {
      throw new PodError("POD_REVIEW_NOT_ALLOWED", "not under review");
    }
    if (!record.reviewDeadlineAt || !record.podId) {
      throw new PodError("POD_REVIEW_NOT_ALLOWED", "review binding incomplete");
    }
    if (record.podId !== input.podId) {
      throw new PodError("POD_INVALID", "podId mismatch");
    }
    if (!isBeforeOrEqualUtc(input.signedAt, record.reviewDeadlineAt)) {
      throw new PodError(
        "POD_REVIEW_DEADLINE_EXPIRED",
        "review deadline expired",
      );
    }
    if (
      (input.action === "REQUEST_CORRECTION" ||
        input.action === "REJECT_DISPUTE") &&
      (!input.reasons || input.reasons.length < 1)
    ) {
      throw new PodError("POD_INVALID", "structured reasons required");
    }

    const policy = trustPolicyFromRecord(record);

    let auth;
    try {
      auth = verifyShipperPodReview({
        policy,
        tenderId: record.tenderId,
        tenderVersion: record.tenderVersion,
        podId: input.podId,
        reviewAction: input.action,
        ...(input.reasons
          ? { reasonCodes: input.reasons.map((r) => r.code) }
          : {}),
        signedAt: input.signedAt,
        reviewDeadlineAt: record.reviewDeadlineAt,
        actionId: input.actionId,
        signature: input.signature,
      });
    } catch {
      throw new PodError(
        "SHIPPER_AUTHORIZATION_INVALID",
        "shipper signature invalid",
      );
    }
    void auth;

    let event: LifecycleEvent;
    let escrowPlan: BoundEscrowPlan | null = null;
    const outbox: PodOutboxItem[] = [];

    if (input.action === "ACCEPT") {
      event = {
        type: "POD_ACCEPTED_BY_SHIPPER",
        actionId: input.actionId,
        eventTime: input.signedAt,
        shipperSignature: input.signature,
        signedAt: input.signedAt,
        reviewDeadlineAt: record.reviewDeadlineAt,
      };
    } else if (input.action === "REQUEST_CORRECTION") {
      event = {
        type: "POD_CORRECTION_REQUESTED",
        actionId: input.actionId,
        eventTime: input.signedAt,
        reasons: input.reasons!,
        shipperSignature: input.signature,
        signedAt: input.signedAt,
        reviewDeadlineAt: record.reviewDeadlineAt,
      };
    } else {
      const disputeId = input.disputeId ?? `dispute-${input.actionId}`;
      event = {
        type: "POD_REJECTED_TO_DISPUTE",
        actionId: input.actionId,
        eventTime: input.signedAt,
        reasons: input.reasons!,
        shipperSignature: input.signature,
        signedAt: input.signedAt,
        reviewDeadlineAt: record.reviewDeadlineAt,
        disputeId,
      };
    }

    let outcome: "APPLIED" | "REPLAYED";
    try {
      const applied = await this.deps.lifecycle.apply(input.tenderId, event);
      outcome = applied.outcome;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (/AFTER_REVIEW/.test(msg)) {
        throw new PodError(
          "POD_REVIEW_DEADLINE_EXPIRED",
          "review deadline expired",
        );
      }
      if (/conflict|CONFLICT/i.test(msg)) {
        throw new PodError("ACTION_ID_CONFLICT", "actionId conflict");
      }
      throw err;
    }

    const next = (await this.deps.lifecycle.get(input.tenderId))!;
    const tenderKey = escrowTenderKey(record.tenderId, record.tenderVersion);
    const contractId =
      this.deps.escrowContractId ?? "0.0.0";
    const contractEvm =
      this.deps.escrowContractEvm ??
      "0x0000000000000000000000000000000000000001";
    const locked = record.lockedAmountAtomic ?? "0";

    if (input.action === "ACCEPT") {
      const existing = this.releasePlans.get(`${input.tenderId}|${input.actionId}`);
      if (existing && outcome === "REPLAYED") {
        escrowPlan = existing;
      } else if (!existing) {
        const authorizationHash = shipperAcceptanceAuthorizationHash({
          runOrTenderId: record.tenderId,
          podId: input.podId,
          podVersion: record.podVersion ?? 1,
          actionId: input.actionId,
          contentHash: record.podContentHash ?? "",
        });
        escrowPlan = buildBoundReleaseFullPlan({
          tenderId: record.tenderId,
          tenderVersion: record.tenderVersion,
          tenderKey,
          podId: input.podId,
          podVersion: record.podVersion ?? 1,
          lockedAmountAtomic: locked,
          authorizationHash,
          contractId,
          contractEvmAddress: contractEvm,
          ...(this.deps.requirePhaseC2LiveBindings
            ? { requirePhaseC2LiveBindings: true }
            : {}),
        });
        this.releasePlans.set(`${input.tenderId}|${input.actionId}`, escrowPlan);
      } else {
        escrowPlan = existing;
      }
    }

    if (input.action === "REJECT_DISPUTE") {
      const disputeId =
        next.disputeId ?? input.disputeId ?? `dispute-${input.actionId}`;
      const existing = this.disputePlans.get(`${input.tenderId}|${input.actionId}`);
      if (existing && outcome === "REPLAYED") {
        escrowPlan = existing;
      } else if (!existing) {
        const authorizationHash = disputeAuthorizationHash({
          runOrTenderId: record.tenderId,
          podId: input.podId,
          podVersion: record.podVersion ?? 1,
          actionId: input.actionId,
          disputeId,
        });
        escrowPlan = buildBoundOpenDisputePlan({
          tenderId: record.tenderId,
          tenderVersion: record.tenderVersion,
          tenderKey,
          podId: input.podId,
          podVersion: record.podVersion ?? 1,
          lockedAmountAtomic: locked,
          authorizationHash,
          contractId,
          contractEvmAddress: contractEvm,
          ...(this.deps.requirePhaseC2LiveBindings
            ? { requirePhaseC2LiveBindings: true }
            : {}),
        });
        this.disputePlans.set(`${input.tenderId}|${input.actionId}`, escrowPlan);
      } else {
        escrowPlan = existing;
      }
      const rawCode = input.reasons?.[0]?.code ?? "OTHER_STRUCTURED";
      const allowed = new Set([
        "DAMAGED",
        "MISSING_DOCUMENT",
        "SEAL_MISMATCH",
        "DELIVERY_EXCEPTION",
        "OTHER_STRUCTURED",
      ]);
      const reasonCode = (
        allowed.has(rawCode) ? rawCode : "OTHER_STRUCTURED"
      ) as
        | "DAMAGED"
        | "MISSING_DOCUMENT"
        | "SEAL_MISMATCH"
        | "DELIVERY_EXCEPTION"
        | "OTHER_STRUCTURED";
      outbox.push({
        kind: "DISPUTE_OPENED",
        envelope: buildDisputeOpenedEnvelope(next, {
          disputeId,
          reasonCode,
        }),
      });
    }

    outbox.push({
      kind: "POD_REVIEW_ACTION",
      envelope: buildPodReviewActionEnvelope(next, {
        action: input.action,
        reviewDeadlineAt: record.reviewDeadlineAt,
      }),
    });

    return {
      record: next,
      action: input.action,
      escrowPlan,
      outbox,
      outcome,
    };
  }

  private async requireRecord(
    tenderId: string,
    tenderVersion: number,
  ): Promise<LifecycleRecord> {
    const record = await this.deps.lifecycle.get(tenderId);
    if (!record) {
      throw new PodError("POD_NOT_FOUND", "tender not found");
    }
    if (record.tenderVersion !== tenderVersion) {
      throw new PodError("POD_INVALID", "tender version mismatch");
    }
    return record;
  }

  private assertWinningCarrier(
    record: LifecycleRecord,
    carrierId: string,
    carrierAccountId: string,
  ): void {
    if (
      !record.winningCarrierId ||
      record.winningCarrierId !== carrierId ||
      record.winningCarrierAccount !== carrierAccountId
    ) {
      throw new PodError("CARRIER_NOT_WINNER", "caller is not the winning carrier");
    }
    if (!record.lockedAmountAtomic || !record.winningAmountAtomic) {
      throw new PodError("POD_STATE_INVALID", "escrow allocation not confirmed");
    }
  }
}
