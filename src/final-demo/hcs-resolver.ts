/**
 * Mirror-backed recovery for the final-demo ROUTE_RESERVED publication.
 * Resolution is exact and fail-closed: the complete five-message topic window
 * must be pristine before sequence 5 can be confirmed without another submit.
 */

import { isUtcIsoTimestamp } from "../domain/time";
import { envelopeHash } from "../hcs/message-envelope";
import type { ObservedHcsMessage } from "../hcs/types";
import type {
  HcsPublicationResolveResult,
  HcsPublicationResolver,
} from "../reservation/transports";
import type { FinalDemoTopicMirrorReader } from "./transports";

export type FinalDemoHcsResolverBinding = {
  readonly topicId: string;
  readonly auctionRunId: string;
  readonly routeReservedRunId: string;
  readonly tenderId: string;
  readonly expectedSequence: 5;
};

/** Pure resolution over one exhaustive, currently visible Mirror snapshot. */
export function resolveRouteReservedFromMirror(
  messages: ObservedHcsMessage[],
  input: {
    topicId: string;
    envelopeHash: string;
    binding: FinalDemoHcsResolverBinding;
  },
): HcsPublicationResolveResult {
  if (input.topicId !== input.binding.topicId) {
    return { status: "AMBIGUOUS" };
  }

  // The snapshot does not prove Mirror indexing finality. A missing sequence 5
  // can never be classified as conclusively absent through this interface.
  if (messages.length !== input.binding.expectedSequence) {
    return { status: "AMBIGUOUS" };
  }

  const expectedTypes = [
    "AUCTION_OPEN",
    "BID_COMMITMENT",
    "BID_COMMITMENT",
    "AUCTION_CLOSE_BARRIER",
    "ROUTE_RESERVED",
  ] as const;
  const bySequence = new Map<number, ObservedHcsMessage>();

  for (const message of messages) {
    if (
      message.topicId !== input.binding.topicId ||
      !Number.isSafeInteger(message.sequence) ||
      message.sequence < 1 ||
      message.sequence > input.binding.expectedSequence ||
      bySequence.has(message.sequence) ||
      envelopeHash(message.envelope) !== message.envelopeHash ||
      !isUtcIsoTimestamp(message.consensusTimestamp)
    ) {
      return { status: "AMBIGUOUS" };
    }
    bySequence.set(message.sequence, message);
  }

  for (let sequence = 1; sequence <= input.binding.expectedSequence; sequence += 1) {
    const message = bySequence.get(sequence);
    if (
      !message ||
      message.envelope.messageType !== expectedTypes[sequence - 1] ||
      message.envelope.tenderId !== input.binding.tenderId ||
      message.envelope.runId !==
        (sequence === input.binding.expectedSequence
          ? input.binding.routeReservedRunId
          : input.binding.auctionRunId)
    ) {
      return { status: "AMBIGUOUS" };
    }
  }

  const matches = messages.filter(
    (message) => message.envelopeHash === input.envelopeHash,
  );
  if (matches.length !== 1) {
    return { status: "AMBIGUOUS" };
  }

  const found = bySequence.get(input.binding.expectedSequence)!;
  if (
    matches[0] !== found ||
    found.envelopeHash !== input.envelopeHash ||
    found.envelope.messageType !== "ROUTE_RESERVED" ||
    found.envelope.runId !== input.binding.routeReservedRunId ||
    found.envelope.tenderId !== input.binding.tenderId
  ) {
    return { status: "AMBIGUOUS" };
  }

  return {
    status: "FOUND",
    topicId: found.topicId,
    sequence: found.sequence,
    transactionId: found.transactionId?.trim() || null,
    consensusTimestamp: found.consensusTimestamp,
    envelopeHash: found.envelopeHash,
  };
}

export function createFinalDemoHcsResolver(
  mirrorReader: FinalDemoTopicMirrorReader,
  binding: FinalDemoHcsResolverBinding,
): HcsPublicationResolver {
  return {
    async resolvePublication(input) {
      if (input.messageType !== "ROUTE_RESERVED") {
        return { status: "AMBIGUOUS" };
      }
      const messages = await mirrorReader.listMessages(binding.topicId);
      return resolveRouteReservedFromMirror(messages, {
        topicId: input.topicId,
        envelopeHash: input.envelopeHash,
        binding,
      });
    },
  };
}
