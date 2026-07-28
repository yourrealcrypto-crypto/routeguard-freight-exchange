/**
 * F-012 — local verification entrypoint (no new dependencies).
 *
 * Runs typecheck, full tests, secret scan, dry final-demo validation, and
 * practical Git/evidence cleanliness checks. Never performs live network writes.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
let failed = false;

function run(label: string, command: string, args: string[]): void {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: true,
    env: process.env,
  });
  if (result.status !== 0) {
    console.error(`FAIL: ${label} (exit ${result.status ?? "unknown"})`);
    failed = true;
  } else {
    console.log(`PASS: ${label}`);
  }
}

function checkEvidenceCleanliness(): void {
  console.log("\n==> evidence / git cleanliness (practical)");
  const dryJson = path.join(root, "evidence", "final-demo-dry-run.json");
  const dryMd = path.join(root, "evidence", "final-demo-dry-run.md");
  const dryReport = path.join(root, "evidence", "final-demo-dry-run-report.html");

  for (const p of [dryJson, dryMd]) {
    if (!existsSync(p)) {
      console.error(`FAIL: missing expected dry evidence: ${p}`);
      failed = true;
      continue;
    }
    const text = readFileSync(p, "utf8");
    if (/https:\/\/hashscan\.io\//i.test(text)) {
      console.error(`FAIL: dry evidence contains active HashScan URL: ${p}`);
      failed = true;
    }
    if (/real testnet transactions/i.test(text) && !/not real testnet/i.test(text)) {
      // Dry disclosure must not claim real txs without the "not real" negation.
      if (!/Zero network writes/i.test(text) && !/not real testnet transactions/i.test(text)) {
        console.error(`FAIL: dry evidence claims real testnet transactions: ${p}`);
        failed = true;
      }
    }
    if (!/OFFLINE_DRY_RUN|zero network writes/i.test(text)) {
      console.error(`FAIL: dry evidence missing dry-mode / zero-write disclosure: ${p}`);
      failed = true;
    }
  }

  if (existsSync(dryReport)) {
    const html = readFileSync(dryReport, "utf8");
    if (/href=["']https:\/\/hashscan\.io\//i.test(html)) {
      console.error("FAIL: dry report contains active HashScan href");
      failed = true;
    }
    if (!/OFFLINE_DRY_RUN/i.test(html)) {
      console.error("FAIL: dry report missing OFFLINE_DRY_RUN banner");
      failed = true;
    }
  } else {
    console.log("NOTE: dry HTML report not present yet (run npm run report:final-demo)");
  }

  // Practical: evidence/ should not contain private-key-looking fields in JSON.
  const evidenceDir = path.join(root, "evidence");
  if (existsSync(evidenceDir)) {
    for (const name of readdirSync(evidenceDir)) {
      if (!name.endsWith(".json")) continue;
      const full = path.join(evidenceDir, name);
      if (!statSync(full).isFile()) continue;
      const body = readFileSync(full, "utf8");
      if (/"privateKey"|"signingPrivateKey"|"SHIPPER_PRIVATE_KEY"/i.test(body)) {
        console.error(`FAIL: private-key field shape in ${name}`);
        failed = true;
      }
    }
  }

  // Practical git check: tracked secrets path should not be present.
  if (existsSync(path.join(root, ".env"))) {
    console.log("NOTE: local .env exists (expected untracked); do not commit it");
  }

  if (!failed) {
    console.log("PASS: evidence / git cleanliness (practical)");
  }
}

run("typecheck", "npm", ["run", "typecheck"]);
run("full tests", "npx", ["vitest", "run"]);
run("secret scan", "npm", ["run", "check:secrets"]);
run("dry final-demo", "npm", ["run", "demo:final-auction"]);
checkEvidenceCleanliness();

if (failed) {
  console.error("\nverify: FAILED");
  process.exit(1);
}
console.log("\nverify: PASS");
process.exit(0);
