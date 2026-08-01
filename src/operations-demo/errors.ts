export const DEMO_ERROR_CODES = [
  "DEMO_LIVE_DISABLED", "DEMO_INFRASTRUCTURE_PENDING", "DEMO_ADMIN_REQUIRED", "DEMO_SESSION_ACTIVE",
  "DEMO_SESSION_NOT_FOUND", "DEMO_SESSION_EXPIRED", "DEMO_ACTION_NOT_ALLOWED", "DEMO_ACTION_IN_PROGRESS",
  "DEMO_ACTION_CONFLICT", "DEMO_WRITE_BUDGET_EXCEEDED", "DEMO_DAILY_LIMIT_REACHED", "DEMO_BALANCE_INSUFFICIENT",
  "DEMO_VOLUME_UNAVAILABLE", "DEMO_PERSISTENCE_CONFLICT", "DEMO_TRANSACTION_SUBMITTED_VERIFICATION_PENDING",
  "DEMO_MIRROR_UNAVAILABLE", "DEMO_CONFIG_INVALID", "DEMO_OPERATOR_RECOVERY_REQUIRED", "DEMO_RATE_LIMITED",
] as const;
export type DemoErrorCode = (typeof DEMO_ERROR_CODES)[number];

export class DemoError extends Error {
  constructor(readonly code: DemoErrorCode, message: string, readonly status = 400) {
    super(message);
    this.name = "DemoError";
  }
}

export function publicDemoError(error: unknown): { code: DemoErrorCode; message: string; status: number } {
  if (error instanceof DemoError) return { code: error.code, message: error.message, status: error.status };
  return { code: "DEMO_CONFIG_INVALID", message: "Operations Demo request failed", status: 500 };
}
