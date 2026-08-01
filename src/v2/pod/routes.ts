/**
 * POD HTTP routes — privileged shipper review; public routes never decrypt.
 *
 *   POST /api/v2/tenders/:tenderId/v/:tenderVersion/pods/:podId
 *   POST /api/v2/tenders/:tenderId/v/:tenderVersion/pods/:podId/resubmit
 *   POST /api/v2/tenders/:tenderId/v/:tenderVersion/pods/:podId/review/start
 *   GET  /api/v2/tenders/:tenderId/v/:tenderVersion/pods/:podId/review
 *   POST /api/v2/tenders/:tenderId/v/:tenderVersion/pods/:podId/review
 */

import { Hono } from "hono";
import { z } from "zod";

import { PodError, POD_HTTP_STATUS } from "./errors";
import type { PodService } from "./service";
import type { PodDocumentType, PodFileInput, SignedPodPackage } from "./types";
import { POD_CARGO_CONDITION_CODES, POD_DOCUMENT_TYPES, POD_EXCEPTION_CODES } from "./types";

export const V2_POD_SUBMIT_PATH =
  "/api/v2/tenders/:tenderId/v/:tenderVersion/pods/:podId" as const;
export const V2_POD_RESUBMIT_PATH =
  "/api/v2/tenders/:tenderId/v/:tenderVersion/pods/:podId/resubmit" as const;
export const V2_POD_REVIEW_START_PATH =
  "/api/v2/tenders/:tenderId/v/:tenderVersion/pods/:podId/review/start" as const;
export const V2_POD_REVIEW_PATH =
  "/api/v2/tenders/:tenderId/v/:tenderVersion/pods/:podId/review" as const;

const FileSchema = z
  .object({
    fileId: z.string().min(1).max(64),
    documentType: z.enum(POD_DOCUMENT_TYPES as unknown as [string, ...string[]]),
    filename: z.string().min(1).max(128),
    mimeType: z.string().min(1).max(128),
    contentBase64: z.string().min(1),
  })
  .strict();

const SubmitBodySchema = z
  .object({
    podVersion: z.number().int().min(1),
    winningBidId: z.string().min(1).max(128),
    escrowTenderKey: z.string().regex(/^0x[0-9a-f]{64}$/),
    carrierId: z.string().min(1).max(128),
    carrierAccountId: z.string().min(1).max(64),
    deliveryTimestamp: z.string().min(1).max(64),
    recipientConfirmationPresent: z.boolean(),
    cargoConditionCode: z.enum(
      POD_CARGO_CONDITION_CODES as unknown as [string, ...string[]],
    ),
    exceptionCodes: z
      .array(z.enum(POD_EXCEPTION_CODES as unknown as [string, ...string[]]))
      .max(16),
    submittedAt: z.string().min(1).max(64),
    actionId: z.string().min(1).max(128),
    carrierSignature: z.string().regex(/^[0-9a-fA-F]{128}$/),
    files: z.array(FileSchema).min(1).max(10),
    manifestHash: z.string().optional(),
    packageContentHash: z.string().optional(),
  })
  .strict();

const ReviewBodySchema = z
  .object({
    action: z.enum(["ACCEPT", "REQUEST_CORRECTION", "REJECT_DISPUTE"]),
    actionId: z.string().min(1).max(128),
    signedAt: z.string().min(1).max(64),
    signature: z.string().regex(/^[0-9a-fA-F]{128}$/),
    reasons: z
      .array(
        z
          .object({
            code: z.string().min(1).max(64),
            message: z.string().min(1).max(256),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    disputeId: z.string().min(1).max(128).optional(),
  })
  .strict();

export type PodRouteDeps = {
  readonly pods: PodService;
  /**
   * When true, GET review returns decrypted content (shipper-authenticated).
   * Production must replace this with real auth middleware.
   */
  readonly isShipperAuthorized?: (c: {
    tenderId: string;
    tenderVersion: number;
  }) => boolean;
};

function parseFiles(
  files: z.infer<typeof FileSchema>[],
): PodFileInput[] {
  return files.map((f) => ({
    fileId: f.fileId,
    documentType: f.documentType as PodDocumentType,
    filename: f.filename,
    mimeType: f.mimeType,
    bytes: new Uint8Array(Buffer.from(f.contentBase64, "base64")),
  }));
}

function publicError(err: unknown): { status: number; body: { code: string; message: string } } {
  if (err instanceof PodError) {
    return {
      status: POD_HTTP_STATUS[err.code] ?? 400,
      body: { code: err.code, message: err.message },
    };
  }
  return {
    status: 500,
    body: { code: "INTERNAL_ERROR", message: "internal error" },
  };
}

export function registerV2PodRoutes(app: Hono, deps: PodRouteDeps): void {
  const authShipper =
    deps.isShipperAuthorized ??
    (() => true); // demo composition injects real checks

  app.post(V2_POD_SUBMIT_PATH, async (c) => {
    try {
      const tenderId = c.req.param("tenderId");
      const tenderVersion = Number(c.req.param("tenderVersion"));
      const podId = c.req.param("podId");
      const body = SubmitBodySchema.parse(await c.req.json());
      const pkg: SignedPodPackage = {
        podId,
        podVersion: body.podVersion,
        tenderId,
        tenderVersion,
        winningBidId: body.winningBidId,
        escrowTenderKey: body.escrowTenderKey,
        carrierId: body.carrierId,
        carrierAccountId: body.carrierAccountId,
        deliveryTimestamp: body.deliveryTimestamp,
        recipientConfirmationPresent: body.recipientConfirmationPresent,
        cargoConditionCode: body.cargoConditionCode as SignedPodPackage["cargoConditionCode"],
        exceptionCodes: body.exceptionCodes as SignedPodPackage["exceptionCodes"],
        submittedAt: body.submittedAt,
        actionId: body.actionId,
        carrierSignature: body.carrierSignature,
        files: parseFiles(body.files),
        ...(body.manifestHash ? { manifestHash: body.manifestHash } : {}),
        ...(body.packageContentHash
          ? { packageContentHash: body.packageContentHash }
          : {}),
      };
      const result = await deps.pods.submitPod({
        tenderId,
        tenderVersion,
        podId,
        package: pkg,
      });
      return c.json(
        {
          ...result.receipt,
          outcome: result.outcome,
          // Never include outbox secrets; only message types for observability.
          outboxMessageTypes: result.outbox.map((o) => o.kind),
        },
        result.outcome === "REPLAYED" ? 200 : 201,
      );
    } catch (err) {
      const e = publicError(err);
      return c.json(e.body, e.status as never);
    }
  });

  app.post(V2_POD_RESUBMIT_PATH, async (c) => {
    try {
      const tenderId = c.req.param("tenderId");
      const tenderVersion = Number(c.req.param("tenderVersion"));
      const podId = c.req.param("podId");
      const body = SubmitBodySchema.parse(await c.req.json());
      const pkg: SignedPodPackage = {
        podId,
        podVersion: body.podVersion,
        tenderId,
        tenderVersion,
        winningBidId: body.winningBidId,
        escrowTenderKey: body.escrowTenderKey,
        carrierId: body.carrierId,
        carrierAccountId: body.carrierAccountId,
        deliveryTimestamp: body.deliveryTimestamp,
        recipientConfirmationPresent: body.recipientConfirmationPresent,
        cargoConditionCode: body.cargoConditionCode as SignedPodPackage["cargoConditionCode"],
        exceptionCodes: body.exceptionCodes as SignedPodPackage["exceptionCodes"],
        submittedAt: body.submittedAt,
        actionId: body.actionId,
        carrierSignature: body.carrierSignature,
        files: parseFiles(body.files),
      };
      const result = await deps.pods.resubmitPod({
        tenderId,
        tenderVersion,
        podId,
        package: pkg,
      });
      return c.json(
        {
          ...result.receipt,
          outcome: result.outcome,
          outboxMessageTypes: result.outbox.map((o) => o.kind),
        },
        200,
      );
    } catch (err) {
      const e = publicError(err);
      return c.json(e.body, e.status as never);
    }
  });

  app.post(V2_POD_REVIEW_START_PATH, async (c) => {
    try {
      const tenderId = c.req.param("tenderId");
      const tenderVersion = Number(c.req.param("tenderVersion"));
      const body = z
        .object({ actionId: z.string().min(1).max(128) })
        .strict()
        .parse(await c.req.json());
      const result = await deps.pods.startReview({
        tenderId,
        tenderVersion,
        actionId: body.actionId,
      });
      return c.json({
        state: result.record.state,
        reviewDeadlineAt: result.record.reviewDeadlineAt,
        advisory: {
          reportId: result.advisory.reportId,
          binding: result.advisory.binding,
          recommendation: result.advisory.recommendation,
          reportHash: result.advisory.reportHash,
          findings: result.advisory.findings,
          engine: result.advisory.engine,
          createdAt: result.advisory.createdAt,
        },
        outboxMessageTypes: result.outbox.map((o) => o.kind),
      });
    } catch (err) {
      const e = publicError(err);
      return c.json(e.body, e.status as never);
    }
  });

  app.get(V2_POD_REVIEW_PATH, async (c) => {
    try {
      const tenderId = c.req.param("tenderId");
      const tenderVersion = Number(c.req.param("tenderVersion"));
      const podId = c.req.param("podId");
      const authorized = authShipper({ tenderId, tenderVersion });
      if (!authorized) {
        return c.json(
          { code: "POD_REVIEW_NOT_ALLOWED", message: "not authorized" },
          403,
        );
      }
      const bundle = await deps.pods.getReviewBundle({
        tenderId,
        tenderVersion,
        podId,
        authorizedShipper: true,
      });
      // Privileged shipper response may include decrypted structured fields +
      // file content as base64 for download — never on public/Judge routes.
      return c.json({
        publicMeta: bundle.publicMeta,
        reviewDeadlineAt: bundle.reviewDeadlineAt,
        binding: bundle.bindingLabel,
        advisory: bundle.advisory
          ? {
              reportId: bundle.advisory.reportId,
              binding: bundle.advisory.binding,
              recommendation: bundle.advisory.recommendation,
              reportHash: bundle.advisory.reportHash,
              findings: bundle.advisory.findings,
              engine: bundle.advisory.engine,
              createdAt: bundle.advisory.createdAt,
            }
          : null,
        availableActions: bundle.availableActions,
        pod: bundle.decrypted
          ? {
              fields: bundle.decrypted.fields,
              files: bundle.decrypted.files.map((f) => ({
                fileId: f.fileId,
                documentType: f.documentType,
                filename: f.filename,
                mimeType: f.mimeType,
                contentBase64: Buffer.from(f.bytes).toString("base64"),
              })),
            }
          : null,
      });
    } catch (err) {
      const e = publicError(err);
      return c.json(e.body, e.status as never);
    }
  });

  app.post(V2_POD_REVIEW_PATH, async (c) => {
    try {
      const tenderId = c.req.param("tenderId");
      const tenderVersion = Number(c.req.param("tenderVersion"));
      const podId = c.req.param("podId");
      const body = ReviewBodySchema.parse(await c.req.json());
      const result = await deps.pods.shipperReview({
        tenderId,
        tenderVersion,
        podId,
        action: body.action,
        actionId: body.actionId,
        signedAt: body.signedAt,
        signature: body.signature,
        ...(body.reasons ? { reasons: body.reasons } : {}),
        ...(body.disputeId ? { disputeId: body.disputeId } : {}),
      });
      return c.json({
        state: result.record.state,
        action: result.action,
        outcome: result.outcome,
        correctionDeadlineAt: result.record.correctionDeadlineAt,
        escrowPlan: result.escrowPlan
          ? {
              kind: result.escrowPlan.kind,
              contractId: result.escrowPlan.contractId,
              contractEvmAddress: result.escrowPlan.contractEvmAddress,
              tenderKey: result.escrowPlan.tenderKey,
              lockedAmountAtomic: result.escrowPlan.lockedAmountAtomic,
              authorizationHash: result.escrowPlan.authorizationHash,
              networkWrite: false,
              contractFunction: result.escrowPlan.plan.contractFunction,
            }
          : null,
        outboxMessageTypes: result.outbox.map((o) => o.kind),
      });
    } catch (err) {
      const e = publicError(err);
      return c.json(e.body, e.status as never);
    }
  });
}

export function createV2PodApp(deps: PodRouteDeps): Hono {
  const app = new Hono();
  registerV2PodRoutes(app, deps);
  return app;
}
