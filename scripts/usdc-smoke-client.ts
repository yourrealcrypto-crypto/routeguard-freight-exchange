import { pathToFileURL } from "node:url";

import {
  canSignUsdcPayment,
  fetchAndValidateUsdcSmokeChallenge,
  runUsdcSmokeClient,
  validateUsdcSmokePaymentRequirements,
} from "../src/x402/usdc-smoke-client";

export {
  canSignUsdcPayment,
  fetchAndValidateUsdcSmokeChallenge,
  runUsdcSmokeClient,
  validateUsdcSmokePaymentRequirements,
};

export async function main(): Promise<void> {
  await import("dotenv/config");
  await runUsdcSmokeClient();
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];

  return Boolean(
    entrypoint && import.meta.url === pathToFileURL(entrypoint).href,
  );
}

if (isDirectExecution()) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "Unknown client failure.";

    console.error(`USDC_SMOKE_CLIENT_FAILED: ${message}`);
    process.exitCode = 1;
  });
}
