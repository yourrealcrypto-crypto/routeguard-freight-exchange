import { mkdir, writeFile } from "node:fs/promises";
import { config } from "../src/config";

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

async function main(): Promise<void> {
  const baseUrl = config.facilitatorUrl.endsWith("/")
    ? config.facilitatorUrl
    : `${config.facilitatorUrl}/`;

  const supportedUrl = new URL("supported", baseUrl);

  console.log(`Checking facilitator: ${supportedUrl}`);

  const response = await fetch(supportedUrl, {
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Facilitator returned HTTP ${response.status}`,
    );
  }

  const payload: unknown = await response.json();

  if (!isRecord(payload) || !Array.isArray(payload.kinds)) {
    throw new Error("Invalid /supported response structure");
  }

  const hederaKind = payload.kinds.find((kind) => {
    return (
      isRecord(kind) &&
      kind.x402Version === 2 &&
      kind.scheme === "exact" &&
      kind.network === "hedera:testnet"
    );
  });

  if (!isRecord(hederaKind)) {
    throw new Error(
      "Blocky402 does not advertise x402 v2 exact on hedera:testnet",
    );
  }

  if (
    !isRecord(hederaKind.extra) ||
    typeof hederaKind.extra.feePayer !== "string"
  ) {
    throw new Error(
      "Blocky402 Hedera support is missing a fee payer",
    );
  }

  await mkdir("evidence", { recursive: true });

  await writeFile(
    "evidence/blocky402-supported.json",
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );

  console.log("Facilitator preflight passed.");
  console.log(`x402 version: ${hederaKind.x402Version}`);
  console.log(`scheme: ${hederaKind.scheme}`);
  console.log(`network: ${hederaKind.network}`);
  console.log(`fee payer: ${hederaKind.extra.feePayer}`);
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : String(error);

  console.error(`PREFLIGHT_FAILED: ${message}`);
  process.exitCode = 1;
});