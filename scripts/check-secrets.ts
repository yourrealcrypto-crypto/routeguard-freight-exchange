/**
 * Repository secret-scan gate.
 * Reports paths only — never prints matching secret values.
 *
 * Usage: npm run check:secrets
 * Exit 1 on findings.
 */

import {
  runSecretScan,
  type SecretScanResult,
} from "../src/final-demo/secret-scan";

export function main(): SecretScanResult {
  const result = runSecretScan({ rootDir: process.cwd() });
  if (result.ok) {
    console.log(
      `Secret scan PASS (${result.scannedFileCount} files scanned; no private-key fields in public paths)`,
    );
  } else {
    console.error("Secret scan FAIL — paths with sensitive patterns:");
    for (const f of result.findings) {
      console.error(`  - ${f.path}: ${f.reason}`);
    }
    process.exitCode = 1;
  }
  return result;
}

const isDirect =
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("check-secrets.ts") ||
    process.argv[1].endsWith("check-secrets.js"));

if (isDirect) {
  main();
}
