export type WriteKind = "APPLICATION" | "CHILD_RECORD" | "READ_ONLY" | "QUERY_PAYMENT";

export type WriteBudgetSnapshot = {
  readonly projectedWrites: number;
  readonly attemptedWrites: number;
  readonly successfulStateChangingWrites: number;
  readonly currentAction: string | null;
  readonly perSessionCeiling: number;
  readonly dailySuccessfulWrites: number;
  readonly dailyCeiling: number;
  readonly childRecordsObserved: number;
  readonly readOnlyCalls: number;
  readonly queryPaymentsObserved: number;
};

export class WriteBudgetError extends Error {
  constructor(
    readonly code: "DEMO_WRITE_BUDGET_EXCEEDED" | "DEMO_DAILY_LIMIT_REACHED",
    message: string,
  ) {
    super(message);
    this.name = "WriteBudgetError";
  }
}

export class WriteBudget {
  private attemptedWrites = 0;
  private successfulWrites = 0;
  private currentAction: string | null = null;
  private childRecordsObserved = 0;
  private readOnlyCalls = 0;
  private queryPaymentsObserved = 0;

  constructor(
    readonly projectedWrites: number,
    readonly perSessionCeiling: number,
    private dailySuccessfulWrites: number,
    readonly dailyCeiling: number,
  ) {
    for (const [label, value] of Object.entries({
      projectedWrites,
      perSessionCeiling,
      dailySuccessfulWrites,
      dailyCeiling,
    })) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
    }
    if (projectedWrites > perSessionCeiling) {
      throw new WriteBudgetError("DEMO_WRITE_BUDGET_EXCEEDED", "projected writes exceed the session ceiling");
    }
    if (dailySuccessfulWrites + projectedWrites > dailyCeiling) {
      throw new WriteBudgetError("DEMO_DAILY_LIMIT_REACHED", "daily budget cannot support a complete run");
    }
  }

  begin(action: string, count = 1): void {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("write count must be positive");
    if (this.successfulWrites + count > this.perSessionCeiling) {
      throw new WriteBudgetError("DEMO_WRITE_BUDGET_EXCEEDED", "the next write would exceed the session ceiling");
    }
    if (this.dailySuccessfulWrites + count > this.dailyCeiling) {
      throw new WriteBudgetError("DEMO_DAILY_LIMIT_REACHED", "the next write would exceed the daily ceiling");
    }
    this.currentAction = action;
    this.attemptedWrites += count;
  }

  confirm(count = 1): void {
    this.successfulWrites += count;
    this.dailySuccessfulWrites += count;
    this.currentAction = null;
  }

  fail(): void {
    this.currentAction = null;
  }

  observe(kind: Exclude<WriteKind, "APPLICATION">, count = 1): void {
    if (kind === "CHILD_RECORD") this.childRecordsObserved += count;
    if (kind === "READ_ONLY") this.readOnlyCalls += count;
    if (kind === "QUERY_PAYMENT") this.queryPaymentsObserved += count;
  }

  snapshot(): WriteBudgetSnapshot {
    return Object.freeze({
      projectedWrites: this.projectedWrites,
      attemptedWrites: this.attemptedWrites,
      successfulStateChangingWrites: this.successfulWrites,
      currentAction: this.currentAction,
      perSessionCeiling: this.perSessionCeiling,
      dailySuccessfulWrites: this.dailySuccessfulWrites,
      dailyCeiling: this.dailyCeiling,
      childRecordsObserved: this.childRecordsObserved,
      readOnlyCalls: this.readOnlyCalls,
      queryPaymentsObserved: this.queryPaymentsObserved,
    });
  }
}
