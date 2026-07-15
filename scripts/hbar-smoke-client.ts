import { pathToFileURL } from "node:url";

import {
  canSignPayment,
  fetchAndValidateHbarSmokeChallenge,
  runHbarSmokeClient,
  validateHbarSmokePaymentRequirements,
} from "../src/x402/hbar-smoke-client";

export {
  canSignPayment,
  fetchAndValidateHbarSmokeChallenge,
  runHbarSmokeClient,
  validateHbarSmokePaymentRequirements,
};

export async function main(): Promise<void> {
  await runHbarSmokeClient();
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

    console.error(`HBAR_SMOKE_CLIENT_FAILED: ${message}`);
    process.exitCode = 1;
  });
}
