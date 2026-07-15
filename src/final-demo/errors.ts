/**
 * Typed errors for final-demo orchestration (fail-closed).
 */

export class FinalDemoError extends Error {
  constructor(
    message: string,
    public readonly code: string = "FINAL_DEMO_ERROR",
  ) {
    super(message);
    this.name = "FinalDemoError";
  }
}
