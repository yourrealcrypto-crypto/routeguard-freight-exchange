/**
 * Lifecycle ↔ escrow mapping.
 *
 * Declares which escrow operation a lifecycle state drives, and which escrow
 * confirmation a lifecycle transition requires. This is a description only: it
 * performs no I/O, executes nothing, and never fabricates a confirmation. The
 * lifecycle reducer remains the sole authority for legal transitions.
 */

import type { V2LifecycleState } from "../lifecycle/states";
import type { EscrowOperation } from "./requests";
import type { EscrowState } from "./states";

/** A lifecycle state that triggers an escrow write. */
export type EscrowTrigger = {
  readonly lifecycleState: V2LifecycleState;
  readonly operation: EscrowOperation;
  readonly expectedEscrowStateAfter: EscrowState;
};

/** A lifecycle transition that may only follow a confirmed escrow outcome. */
export type EscrowConfirmationRequirement = {
  readonly lifecycleState: V2LifecycleState;
  readonly requiredEscrowState: EscrowState;
  /** Mirror Node confirmation is mandatory before the lifecycle may advance. */
  readonly requiresMirrorConfirmation: true;
};

export const ESCROW_TRIGGERS: readonly EscrowTrigger[] = Object.freeze([
  {
    lifecycleState: "DRAFT",
    operation: "REGISTER_TENDER",
    expectedEscrowStateAfter: "REGISTERED",
  },
  {
    lifecycleState: "WINNER_SELECTED",
    operation: "ALLOCATE_WINNER",
    expectedEscrowStateAfter: "ALLOCATED",
  },
  {
    lifecycleState: "NO_QUALIFIED_BID",
    operation: "REFUND_NO_QUALIFIED_BID",
    expectedEscrowStateAfter: "REFUNDED",
  },
  {
    lifecycleState: "POD_ACCEPTED",
    operation: "RELEASE_FULL",
    expectedEscrowStateAfter: "RELEASED",
  },
  {
    lifecycleState: "POD_DEEMED_ACCEPTED",
    operation: "RELEASE_FULL",
    expectedEscrowStateAfter: "RELEASED",
  },
  {
    lifecycleState: "POD_DISPUTED",
    operation: "OPEN_DISPUTE",
    expectedEscrowStateAfter: "DISPUTED",
  },
]);

export const ESCROW_CONFIRMATION_REQUIREMENTS: readonly EscrowConfirmationRequirement[] =
  Object.freeze([
    {
      lifecycleState: "ESCROW_FUNDED",
      requiredEscrowState: "FUNDED",
      requiresMirrorConfirmation: true,
    },
    {
      lifecycleState: "WINNING_AMOUNT_LOCKED",
      requiredEscrowState: "ALLOCATED",
      requiresMirrorConfirmation: true,
    },
    {
      lifecycleState: "ROUTE_RESERVED",
      requiredEscrowState: "ALLOCATED",
      requiresMirrorConfirmation: true,
    },
  ]);

/**
 * Referee resolutions map to the three dispute-settlement operations.
 * The contract records the referee authorization hash; it never evaluates the
 * resolution itself, and AI output is never an authorization.
 */
export const REFEREE_RESOLUTION_OPERATIONS = Object.freeze({
  RELEASE_FULL: "RESOLVE_DISPUTE_RELEASE",
  REFUND_FULL: "REFUND_FULL",
  PARTIAL: "PARTIAL_RELEASE",
}) satisfies Readonly<Record<string, EscrowOperation>>;

export type RefereeResolution = keyof typeof REFEREE_RESOLUTION_OPERATIONS;

export function escrowOperationForLifecycleState(
  state: V2LifecycleState,
): EscrowOperation | null {
  return (
    ESCROW_TRIGGERS.find((t) => t.lifecycleState === state)?.operation ?? null
  );
}

export function escrowOperationForRefereeResolution(
  resolution: RefereeResolution,
): EscrowOperation {
  const operation = REFEREE_RESOLUTION_OPERATIONS[resolution];
  if (!operation) {
    throw new Error(`Unknown referee resolution: ${String(resolution)}`);
  }
  return operation;
}

export function requiredEscrowStateFor(
  state: V2LifecycleState,
): EscrowState | null {
  return (
    ESCROW_CONFIRMATION_REQUIREMENTS.find((r) => r.lifecycleState === state)
      ?.requiredEscrowState ?? null
  );
}
