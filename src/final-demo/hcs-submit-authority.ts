/**
 * Explicit HCS submit authority for the five-message final-demo chain.
 * RouteGuard owns sequences 1, 4 and 5; each carrier owns its commitment.
 */

import type { FinalDemoMessageLabel } from "./constants";
import { FinalDemoError } from "./errors";

export const FINAL_DEMO_HCS_SUBMITTERS = [
  "ROUTEGUARD_OPERATOR",
  "CARRIER_ALPHA",
  "CARRIER_BETA",
] as const;

export type FinalDemoHcsSubmitter =
  (typeof FINAL_DEMO_HCS_SUBMITTERS)[number];

export function requiredSubmitterForLabel(
  label: FinalDemoMessageLabel,
): FinalDemoHcsSubmitter {
  if (label === "BID_COMMITMENT_ALPHA") return "CARRIER_ALPHA";
  if (label === "BID_COMMITMENT_BETA") return "CARRIER_BETA";
  return "ROUTEGUARD_OPERATOR";
}

export type FinalDemoHcsSubmitterContext<TClient> = {
  readonly accountId: string;
  readonly client: TClient;
};

/**
 * Select the configured client only after proving that the caller supplied the
 * one submitter role authorized for this logical message.
 */
export function selectAuthorizedHcsSubmitter<TClient>(
  contexts: Readonly<
    Record<FinalDemoHcsSubmitter, FinalDemoHcsSubmitterContext<TClient>>
  >,
  input: {
    readonly label: FinalDemoMessageLabel;
    readonly submitter: FinalDemoHcsSubmitter;
  },
): FinalDemoHcsSubmitterContext<TClient> {
  const required = requiredSubmitterForLabel(input.label);
  if (input.submitter !== required) {
    throw new FinalDemoError(
      `${input.label} must be submitted by ${required}, not ${input.submitter}`,
      "HCS_SUBMITTER_UNAUTHORIZED",
    );
  }
  return contexts[required];
}
