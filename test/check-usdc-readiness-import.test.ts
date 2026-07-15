import { describe, expect, it, vi } from "vitest";

/**
 * Regression: importing scripts/check-usdc-readiness.ts must be side-effect free.
 * main() runs only under direct CLI execution (npm run check:usdc).
 */
describe("check-usdc-readiness import side effects", () => {
  it("does not fetch, log, or change exitCode when imported", async () => {
    const priorExitCode = process.exitCode;

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch must not run during import"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const mod = await import("../scripts/check-usdc-readiness");

      expect(typeof mod.main).toBe("function");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(priorExitCode);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
