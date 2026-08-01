/**
 * Typed lifecycle errors — fail closed.
 */

import type { V2LifecycleState } from "./states";

export class IllegalLifecycleTransitionError extends Error {
  constructor(
    public readonly from: V2LifecycleState,
    public readonly to: V2LifecycleState | string,
    message?: string,
  ) {
    super(message ?? `Illegal lifecycle transition: ${from} → ${to}`);
    this.name = "IllegalLifecycleTransitionError";
  }
}

export class LifecycleGuardError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LifecycleGuardError";
  }
}

export class LifecycleVersionConflictError extends Error {
  /** Stable persistence error category (see store/persistence-errors.ts). */
  readonly code = "VERSION_CONFLICT" as const;

  constructor(
    public readonly tenderId: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(
      `Lifecycle CAS conflict for ${tenderId}: expected version ${expectedVersion}, actual ${actualVersion}`,
    );
    this.name = "LifecycleVersionConflictError";
  }
}

export class LifecycleActionConflictError extends Error {
  readonly code = "ACTION_ID_CONFLICT" as const;

  constructor(
    public readonly actionId: string,
    message?: string,
  ) {
    super(
      message ??
        `actionId "${actionId}" was already used with a different payload`,
    );
    this.name = "LifecycleActionConflictError";
  }
}

export class LifecycleNotFoundError extends Error {
  readonly code = "RECORD_NOT_FOUND" as const;

  constructor(public readonly tenderId: string) {
    super(`Lifecycle record not found: ${tenderId}`);
    this.name = "LifecycleNotFoundError";
  }
}
