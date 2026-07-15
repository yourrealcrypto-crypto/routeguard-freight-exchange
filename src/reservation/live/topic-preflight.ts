/**
 * Live Mirror topic preflight for Phase 6B (read-only).
 * Never uses synthetic data on the live path.
 */

import { decodeHcsEnvelopeFromBase64 } from "../../hcs/message-envelope";
import {
  MirrorNodeClient,
  parseSequenceNumber,
} from "../../hcs/mirror-node-client";
import type { AuctionCloseBarrierPayload } from "../../hcs/types";
import {
  PHASE5_LIVE_PUBLIC,
  PHASE6B_CLOSE_BARRIER_SEQUENCE,
  PHASE6B_HCS_TOPIC,
  PHASE6B_TENDER_ID,
} from "./constants";
import type { TopicPreflightResult } from "./dry-run";
import { Phase6bAttemptError } from "./attempt-store";

export async function readTopicPreflight(options?: {
  topicId?: string;
  reservationId?: string;
  mirror?: MirrorNodeClient;
}): Promise<TopicPreflightResult> {
  const topicId = options?.topicId ?? PHASE6B_HCS_TOPIC;
  const mirror = options?.mirror ?? new MirrorNodeClient();
  let messages;
  try {
    messages = await mirror.fetchAllTopicMessages(topicId);
  } catch (e) {
    throw new Phase6bAttemptError(
      `Mirror topic read failed: ${e instanceof Error ? e.message : String(e)}`,
      "TOPIC_PREFLIGHT_FAILED",
    );
  }

  const bySeq = new Map<
    number,
    { type: string; payload: unknown; tenderId?: string; tenderHash?: string }
  >();
  let maxSequence = 0;
  let hasRouteReservedForReservation = false;

  for (const raw of messages) {
    const seq = parseSequenceNumber(raw.sequence_number);
    if (seq > maxSequence) maxSequence = seq;
    try {
      if (typeof raw.message !== "string") continue;
      const env = decodeHcsEnvelopeFromBase64(raw.message);
      bySeq.set(seq, {
        type: env.messageType,
        payload: env.payload,
        tenderId: env.tenderId,
        tenderHash: env.tenderHash,
      });
      if (env.messageType === "ROUTE_RESERVED") {
        const rid = (env.payload as { reservationId?: string }).reservationId;
        if (options?.reservationId && rid === options.reservationId) {
          hasRouteReservedForReservation = true;
        }
      }
    } catch {
      // skip undecodable
    }
  }

  const open = bySeq.get(1);
  const c2 = bySeq.get(2);
  const c3 = bySeq.get(3);
  const barrier = bySeq.get(4);

  const hasOpen = open?.type === "AUCTION_OPEN";
  const hasCommitment2 = c2?.type === "BID_COMMITMENT";
  const hasCommitment3 = c3?.type === "BID_COMMITMENT";
  const hasBarrierAt4 = barrier?.type === "AUCTION_CLOSE_BARRIER";

  let sequences1to4Valid =
    hasOpen &&
    hasCommitment2 &&
    hasCommitment3 &&
    hasBarrierAt4 &&
    bySeq.has(1) &&
    bySeq.has(2) &&
    bySeq.has(3) &&
    bySeq.has(4);

  // Barrier must bind expected tender + live public commitment envelope hashes.
  if (hasBarrierAt4 && barrier) {
    const payload = barrier.payload as AuctionCloseBarrierPayload;
    if (
      payload.tenderId !== PHASE6B_TENDER_ID ||
      barrier.tenderId !== PHASE6B_TENDER_ID
    ) {
      sequences1to4Valid = false;
    }
    if (
      payload.tenderHash !== PHASE5_LIVE_PUBLIC.tenderHash ||
      barrier.tenderHash !== PHASE5_LIVE_PUBLIC.tenderHash
    ) {
      sequences1to4Valid = false;
    }
    const expected = PHASE5_LIVE_PUBLIC.commitmentEnvelopeHashes;
    const observed = payload.commitmentEnvelopeHashes ?? [];
    if (
      observed.length !== expected.length ||
      !expected.every((h, i) => observed[i] === h)
    ) {
      sequences1to4Valid = false;
    }
  }

  return {
    topicId,
    messageCount: messages.length,
    maxSequence,
    hasOpen: !!hasOpen,
    hasBarrierAt4: !!hasBarrierAt4 && PHASE6B_CLOSE_BARRIER_SEQUENCE === 4,
    sequences1to4Valid,
    hasRouteReservedForReservation,
    nextSequence: maxSequence + 1,
    source: "MIRROR_LIVE",
  };
}
