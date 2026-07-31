/**
 * Public-safe HCS 2.0 outbox builders for POD workflow.
 * Offline only — never submits to a topic.
 */

import { buildHcsV2Envelope } from "../../hcs/v2/envelope";
import type { HcsV2DisputeReasonCode, HcsV2Envelope } from "../../hcs/v2/types";
import type { LifecycleRecord } from "../lifecycle/record";

export type PodOutboxItem = {
  readonly kind:
    | "POD_SUBMITTED"
    | "POD_ADVISORY_ANCHORED"
    | "POD_REVIEW_ACTION"
    | "DISPUTE_OPENED";
  readonly envelope: HcsV2Envelope;
};

export function buildPodSubmittedEnvelope(
  record: LifecycleRecord,
  input: { sizeBytes: number },
): HcsV2Envelope {
  if (!record.podId || record.podVersion == null) {
    throw new Error("pod identity missing on lifecycle record");
  }
  if (!record.podContentHash || !record.podCiphertextHash) {
    throw new Error("pod hashes missing on lifecycle record");
  }
  return buildHcsV2Envelope({
    messageType: "POD_SUBMITTED",
    tenderId: record.tenderId,
    tenderVersion: record.tenderVersion,
    tenderHash: record.tenderHash,
    createdAt: record.updatedAt,
    payload: {
      podId: record.podId,
      podVersion: record.podVersion,
      contentHash: record.podContentHash,
      ciphertextHash: record.podCiphertextHash,
      sizeBytes: input.sizeBytes,
    },
  });
}

export function buildPodAdvisoryAnchoredEnvelope(
  record: LifecycleRecord,
  reportHash: string,
): HcsV2Envelope {
  if (!record.podId) {
    throw new Error("pod identity missing on lifecycle record");
  }
  return buildHcsV2Envelope({
    messageType: "POD_ADVISORY_ANCHORED",
    tenderId: record.tenderId,
    tenderVersion: record.tenderVersion,
    tenderHash: record.tenderHash,
    createdAt: record.updatedAt,
    payload: {
      podId: record.podId,
      reportHash,
      binding: "NON_BINDING_ADVISORY",
    },
  });
}

export function buildPodReviewActionEnvelope(
  record: LifecycleRecord,
  input: {
    action: "ACCEPT" | "REQUEST_CORRECTION" | "REJECT_DISPUTE";
    reviewDeadlineAt: string;
  },
): HcsV2Envelope {
  if (!record.podId) {
    throw new Error("pod identity missing on lifecycle record");
  }
  return buildHcsV2Envelope({
    messageType: "POD_REVIEW_ACTION",
    tenderId: record.tenderId,
    tenderVersion: record.tenderVersion,
    tenderHash: record.tenderHash,
    createdAt: record.updatedAt,
    payload: {
      podId: record.podId,
      action: input.action,
      reviewDeadlineAt: input.reviewDeadlineAt,
    },
  });
}

export function buildDisputeOpenedEnvelope(
  record: LifecycleRecord,
  input: {
    disputeId: string;
    reasonCode: HcsV2DisputeReasonCode;
  },
): HcsV2Envelope {
  if (!record.podId) {
    throw new Error("pod identity missing on lifecycle record");
  }
  return buildHcsV2Envelope({
    messageType: "DISPUTE_OPENED",
    tenderId: record.tenderId,
    tenderVersion: record.tenderVersion,
    tenderHash: record.tenderHash,
    createdAt: record.updatedAt,
    payload: {
      disputeId: input.disputeId,
      podId: record.podId,
      reasonCode: input.reasonCode,
    },
  });
}
