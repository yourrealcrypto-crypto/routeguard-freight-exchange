/**
 * Lifecycle service: pure reduce + CAS store + action-id idempotency.
 */

import {
  LifecycleActionConflictError,
  LifecycleNotFoundError,
} from "../lifecycle/errors";
import type { LifecycleEvent } from "../lifecycle/events";
import {
  eventPayloadHash,
  reduceLifecycle,
} from "../lifecycle/reducer";
import type {
  CreateLifecycleInput,
  LifecycleRecord,
} from "../lifecycle/record";
import type { LifecycleStore } from "./lifecycle-store";

export type ApplyLifecycleResult = {
  readonly record: LifecycleRecord;
  readonly outcome: "APPLIED" | "REPLAYED";
};

export class LifecycleService {
  constructor(private readonly store: LifecycleStore) {}

  async create(input: CreateLifecycleInput): Promise<LifecycleRecord> {
    return this.store.create(input);
  }

  async get(tenderId: string): Promise<LifecycleRecord | null> {
    return this.store.get(tenderId);
  }

  /**
   * Apply an event with action-id idempotency.
   * Identical replay returns prior result without version bump.
   * Conflicting actionId payload fails closed.
   */
  async apply(
    tenderId: string,
    event: LifecycleEvent,
  ): Promise<ApplyLifecycleResult> {
    const current = await this.store.get(tenderId);
    if (!current) {
      throw new LifecycleNotFoundError(tenderId);
    }

    const prior = current.processedActions[event.actionId];
    if (prior) {
      const hash = eventPayloadHash(event);
      if (prior.eventPayloadHash !== hash) {
        throw new LifecycleActionConflictError(event.actionId);
      }
      // Identical replay — do not CAS / do not increment version.
      return { record: current, outcome: "REPLAYED" };
    }

    const next = reduceLifecycle(current, event);
    // reduceLifecycle already set recordVersion = current + 1
    const persisted = await this.store.compareAndSet(
      tenderId,
      current.recordVersion,
      next,
    );
    return { record: persisted, outcome: "APPLIED" };
  }
}
