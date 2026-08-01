/**
 * Escrow release / dispute plan binding for POD outcomes.
 * Plans are never submitted in Phase D1 (NETWORK_WRITES=0).
 */

import { createHash } from "node:crypto";

import {
  buildOpenDisputePlan,
  buildReleaseFullPlan,
  type EscrowTransactionPlan,
} from "../escrow/requests";
import { assertAuthorizationHash } from "../escrow/tender-key";
import { PodError } from "./errors";

/** Live Phase C2 contract — plans must bind these when targeting the live tender. */
export const PHASE_C2_ESCROW_CONTRACT_ID = "0.0.9861047" as const;
export const PHASE_C2_ESCROW_CONTRACT_EVM =
  "0x00000000000000000000000000000000009677b7" as const;
export const PHASE_C2_LOCKED_AMOUNT_ATOMIC = "750000" as const;
export const PHASE_C2_RUN_ID = "v2escrow-20260731-88bbd727" as const;

export type BoundEscrowPlan = {
  readonly plan: EscrowTransactionPlan;
  readonly contractId: string;
  readonly contractEvmAddress: string;
  readonly tenderId: string;
  readonly tenderVersion: number;
  readonly tenderKey: string;
  readonly lockedAmountAtomic: string;
  readonly authorizationHash: string;
  readonly podId: string;
  readonly podVersion: number;
  readonly kind: "RELEASE_FULL" | "OPEN_DISPUTE";
  readonly networkWrite: false;
};

function authHash(label: string): string {
  return `0x${createHash("sha256").update(label, "utf8").digest("hex")}`;
}

export function shipperAcceptanceAuthorizationHash(input: {
  runOrTenderId: string;
  podId: string;
  podVersion: number;
  actionId: string;
  contentHash: string;
}): string {
  return authHash(
    `routeguard-v2-pod-accept:${input.runOrTenderId}:${input.podId}:v${input.podVersion}:${input.actionId}:${input.contentHash}`,
  );
}

export function disputeAuthorizationHash(input: {
  runOrTenderId: string;
  podId: string;
  podVersion: number;
  actionId: string;
  disputeId: string;
}): string {
  return authHash(
    `routeguard-v2-pod-dispute:${input.runOrTenderId}:${input.podId}:v${input.podVersion}:${input.disputeId}:${input.actionId}`,
  );
}

export function buildBoundReleaseFullPlan(input: {
  tenderId: string;
  tenderVersion: number;
  tenderKey: string;
  podId: string;
  podVersion: number;
  lockedAmountAtomic: string;
  authorizationHash: string;
  contractId: string;
  contractEvmAddress: string;
  /** When targeting live Phase C2 demo, enforce exact bindings. */
  requirePhaseC2LiveBindings?: boolean;
}): BoundEscrowPlan {
  if (input.requirePhaseC2LiveBindings) {
    if (input.contractId !== PHASE_C2_ESCROW_CONTRACT_ID) {
      throw new PodError("ESCROW_PLAN_BINDING_FAILED", "contract id mismatch");
    }
    if (
      input.contractEvmAddress.toLowerCase() !==
      PHASE_C2_ESCROW_CONTRACT_EVM.toLowerCase()
    ) {
      throw new PodError("ESCROW_PLAN_BINDING_FAILED", "contract EVM mismatch");
    }
    if (input.lockedAmountAtomic !== PHASE_C2_LOCKED_AMOUNT_ATOMIC) {
      throw new PodError("ESCROW_PLAN_BINDING_FAILED", "locked amount mismatch");
    }
  }
  let authorizationHash: string;
  try {
    authorizationHash = assertAuthorizationHash(
      input.authorizationHash,
      "authorizationHash",
    );
  } catch {
    throw new PodError(
      "ESCROW_PLAN_BINDING_FAILED",
      "authorization hash invalid",
    );
  }

  const plan = buildReleaseFullPlan({
    tenderId: input.tenderId,
    tenderVersion: input.tenderVersion,
    authorizationHash,
  });
  if (plan.tenderKey !== input.tenderKey) {
    throw new PodError("ESCROW_PLAN_BINDING_FAILED", "tender key mismatch");
  }
  if (plan.networkWrite !== true) {
    throw new PodError("ESCROW_PLAN_BINDING_FAILED", "plan marker missing");
  }

  return Object.freeze({
    plan,
    contractId: input.contractId,
    contractEvmAddress: input.contractEvmAddress.toLowerCase(),
    tenderId: input.tenderId,
    tenderVersion: input.tenderVersion,
    tenderKey: input.tenderKey,
    lockedAmountAtomic: input.lockedAmountAtomic,
    authorizationHash,
    podId: input.podId,
    podVersion: input.podVersion,
    kind: "RELEASE_FULL",
    networkWrite: false as const,
  });
}

export function buildBoundOpenDisputePlan(input: {
  tenderId: string;
  tenderVersion: number;
  tenderKey: string;
  podId: string;
  podVersion: number;
  lockedAmountAtomic: string;
  authorizationHash: string;
  contractId: string;
  contractEvmAddress: string;
  requirePhaseC2LiveBindings?: boolean;
}): BoundEscrowPlan {
  if (input.requirePhaseC2LiveBindings) {
    if (input.contractId !== PHASE_C2_ESCROW_CONTRACT_ID) {
      throw new PodError("ESCROW_PLAN_BINDING_FAILED", "contract id mismatch");
    }
    if (
      input.contractEvmAddress.toLowerCase() !==
      PHASE_C2_ESCROW_CONTRACT_EVM.toLowerCase()
    ) {
      throw new PodError("ESCROW_PLAN_BINDING_FAILED", "contract EVM mismatch");
    }
  }
  let authorizationHash: string;
  try {
    authorizationHash = assertAuthorizationHash(
      input.authorizationHash,
      "authorizationHash",
    );
  } catch {
    throw new PodError(
      "ESCROW_PLAN_BINDING_FAILED",
      "authorization hash invalid",
    );
  }
  const plan = buildOpenDisputePlan({
    tenderId: input.tenderId,
    tenderVersion: input.tenderVersion,
    authorizationHash,
  });
  if (plan.tenderKey !== input.tenderKey) {
    throw new PodError("ESCROW_PLAN_BINDING_FAILED", "tender key mismatch");
  }
  return Object.freeze({
    plan,
    contractId: input.contractId,
    contractEvmAddress: input.contractEvmAddress.toLowerCase(),
    tenderId: input.tenderId,
    tenderVersion: input.tenderVersion,
    tenderKey: input.tenderKey,
    lockedAmountAtomic: input.lockedAmountAtomic,
    authorizationHash,
    podId: input.podId,
    podVersion: input.podVersion,
    kind: "OPEN_DISPUTE",
    networkWrite: false as const,
  });
}
