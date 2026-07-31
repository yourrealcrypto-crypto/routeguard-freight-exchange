/**
 * RouteGuard freight-escrow contract states.
 *
 * Mirrors `RouteGuardFreightEscrowBase.EscrowState` exactly, including ordinal
 * values — the on-chain enum is the authority and this module never reorders it.
 */

export const ESCROW_STATES = [
  "UNREGISTERED",
  "REGISTERED",
  "FUNDED",
  "ALLOCATED",
  "DISPUTED",
  "RELEASED",
  "REFUNDED",
  "PARTIALLY_RELEASED",
] as const;

export type EscrowState = (typeof ESCROW_STATES)[number];

/** States from which no further escrow movement is possible. */
export const ESCROW_TERMINAL_STATES: readonly EscrowState[] = [
  "RELEASED",
  "REFUNDED",
  "PARTIALLY_RELEASED",
] as const;

/** States in which the contract still custodies freight principal. */
export const ESCROW_HOLDING_STATES: readonly EscrowState[] = [
  "FUNDED",
  "ALLOCATED",
  "DISPUTED",
] as const;

export function escrowStateFromOrdinal(ordinal: number | bigint): EscrowState {
  const index = typeof ordinal === "bigint" ? Number(ordinal) : ordinal;
  if (!Number.isInteger(index) || index < 0 || index >= ESCROW_STATES.length) {
    throw new Error(`Unknown escrow state ordinal: ${String(ordinal)}`);
  }
  return ESCROW_STATES[index]!;
}

export function escrowStateOrdinal(state: EscrowState): number {
  const index = ESCROW_STATES.indexOf(state);
  if (index < 0) {
    throw new Error(`Unknown escrow state: ${state}`);
  }
  return index;
}

export function isEscrowTerminalState(state: EscrowState): boolean {
  return ESCROW_TERMINAL_STATES.includes(state);
}

export function escrowStateHoldsFunds(state: EscrowState): boolean {
  return ESCROW_HOLDING_STATES.includes(state);
}
