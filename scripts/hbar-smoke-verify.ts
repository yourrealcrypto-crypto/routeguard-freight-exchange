import { pathToFileURL } from "node:url";

import { verifyHbarSmokePayment } from "../src/x402/hbar-smoke-client";

export { verifyHbarSmokePayment };

export async function main(): Promise<void> {
  await import("dotenv/config");
  await verifyHbarSmokePayment();
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
      error instanceof Error ? error.message : "Unknown verify failure.";

    console.error(`HBAR_SMOKE_VERIFY_FAILED: ${message}`);
    process.exitCode = 1;
  });
}
