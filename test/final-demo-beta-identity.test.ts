/**
 * Regression guard for the 2026-07-27 carrier-beta identity migration.
 *
 * The previous beta account was not owner-accessible (no controlled key, could
 * not be funded), so the final demo moved to an owner-controlled testnet
 * account. These tests pin the new identity, prove the retired one is rejected,
 * and keep the three-identity / five-message authority topology intact.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  FINAL_DEMO_CARRIER_BETA_ACCOUNT,
  FINAL_DEMO_MESSAGE_LABELS,
  FINAL_DEMO_PAYER_ACCOUNT,
  FINAL_DEMO_WINNER_ACCOUNT,
} from "../src/final-demo/constants";
import {
  checkFinalDemoHcsIdentityReadiness,
  type FinalDemoHcsIdentity,
} from "../src/final-demo/hcs-identity-readiness";
import { requiredSubmitterForLabel } from "../src/final-demo/hcs-submit-authority";
import { loadFinalAuctionTemplate } from "../src/final-demo/template";

const BETA_ACCOUNT = "0.0.9793912";

/** Split so this file is not itself a hit for the repository scan below. */
const RETIRED_BETA_ACCOUNT = ["0.0", "9100002"].join(".");

const OPERATOR_KEY = "02" + "11".repeat(32);
const ALPHA_KEY = "02" + "22".repeat(32);
const BETA_KEY = "03" + "33".repeat(32);

function identities(betaAccountId: string): FinalDemoHcsIdentity[] {
  return [
    {
      role: "ROUTEGUARD_OPERATOR",
      accountId: FINAL_DEMO_PAYER_ACCOUNT,
      publicKeyHex: OPERATOR_KEY,
    },
    {
      role: "CARRIER_ALPHA",
      accountId: FINAL_DEMO_WINNER_ACCOUNT,
      publicKeyHex: ALPHA_KEY,
    },
    {
      role: "CARRIER_BETA",
      accountId: betaAccountId,
      publicKeyHex: BETA_KEY,
    },
  ];
}

function noNetworkFetch(): typeof fetch {
  return (async () => {
    throw new Error("readiness must fail before any Mirror lookup");
  }) as typeof fetch;
}

describe("carrier-beta identity migration", () => {
  it("pins the owner-controlled beta account as the required identity", () => {
    expect(FINAL_DEMO_CARRIER_BETA_ACCOUNT).toBe(BETA_ACCOUNT);
    expect(loadFinalAuctionTemplate().accounts.carrierBetaDemoAccountId).toBe(
      BETA_ACCOUNT,
    );
    expect(loadFinalAuctionTemplate().carriers.beta.carrierAccountId).toBe(
      BETA_ACCOUNT,
    );
  });

  it("keeps operator, alpha and beta distinct", () => {
    const accounts = [
      FINAL_DEMO_PAYER_ACCOUNT,
      FINAL_DEMO_WINNER_ACCOUNT,
      FINAL_DEMO_CARRIER_BETA_ACCOUNT,
    ];
    expect(new Set(accounts).size).toBe(3);
    expect(FINAL_DEMO_CARRIER_BETA_ACCOUNT).not.toBe(FINAL_DEMO_PAYER_ACCOUNT);
    expect(FINAL_DEMO_CARRIER_BETA_ACCOUNT).not.toBe(FINAL_DEMO_WINNER_ACCOUNT);
  });

  it("rejects the retired beta account before any Mirror lookup", async () => {
    const result = await checkFinalDemoHcsIdentityReadiness({
      identities: identities(RETIRED_BETA_ACCOUNT),
      fetchImpl: noNetworkFetch(),
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toBe(
      `CARRIER_BETA account must be exactly ${BETA_ACCOUNT}`,
    );
  });

  it("rejects a beta identity collapsed onto operator or alpha", async () => {
    for (const collision of [FINAL_DEMO_PAYER_ACCOUNT, FINAL_DEMO_WINNER_ACCOUNT]) {
      const result = await checkFinalDemoHcsIdentityReadiness({
        identities: identities(collision),
        fetchImpl: noNetworkFetch(),
      });
      expect(result.ok).toBe(false);
      expect(result.reasons.join(" ")).toMatch(/distinct/);
    }
  });

  it("still requires beta to own its own ECDSA key and at least one HBAR", async () => {
    const sharedKey = identities(BETA_ACCOUNT).map((identity, index) =>
      index === 2 ? { ...identity, publicKeyHex: ALPHA_KEY } : identity,
    );
    const duplicateKey = await checkFinalDemoHcsIdentityReadiness({
      identities: sharedKey,
      fetchImpl: noNetworkFetch(),
    });
    expect(duplicateKey.ok).toBe(false);
    expect(duplicateKey.reasons.join(" ")).toMatch(/public-key identities must be distinct/);

    const underfunded = await checkFinalDemoHcsIdentityReadiness({
      identities: identities(BETA_ACCOUNT),
      fetchImpl: (async (input: string | URL | Request) => {
        const accountId = decodeURIComponent(String(input).split("/").pop()!);
        const identity = identities(BETA_ACCOUNT).find(
          (candidate) => candidate.accountId === accountId,
        )!;
        return new Response(
          JSON.stringify({
            account: accountId,
            deleted: false,
            key: { _type: "ECDSA_SECP256K1", key: identity.publicKeyHex },
            balance: {
              balance: accountId === BETA_ACCOUNT ? 99_999_999 : 500_000_000,
            },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    expect(underfunded.ok).toBe(false);
    expect(underfunded.minimumBalanceTinybars).toBe("100000000");
    expect(underfunded.reasons.join(" ")).toMatch(/CARRIER_BETA.*below required/i);
  });

  it("keeps HCS sequence 3 owned by carrier beta", () => {
    expect(FINAL_DEMO_MESSAGE_LABELS[2]).toBe("BID_COMMITMENT_BETA");
    expect(requiredSubmitterForLabel("BID_COMMITMENT_BETA")).toBe("CARRIER_BETA");
  });

  it("keeps the sequence 1–5 authority order operator, alpha, beta, operator, operator", () => {
    expect(FINAL_DEMO_MESSAGE_LABELS.map(requiredSubmitterForLabel)).toEqual([
      "ROUTEGUARD_OPERATOR",
      "CARRIER_ALPHA",
      "CARRIER_BETA",
      "ROUTEGUARD_OPERATOR",
      "ROUTEGUARD_OPERATOR",
    ]);
  });
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCANNED_ROOTS = [
  "src",
  "scripts",
  "test",
  "demo",
  "evidence",
  "docs",
  "public",
  ".env.example",
  "README.md",
];

/**
 * Sealed Phase 5 exploratory materials: signed bids whose signatures cover the
 * historical carrier account. It is explicitly not final-demo authority and is
 * never rewritten, so the retired id legitimately survives there as history.
 */
const HISTORICAL_ALLOWLIST = new Set([
  path.join("src", "reservation", "live", "phase5-public-materials.json"),
]);

const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);
const SCANNED_EXTENSIONS = new Set([
  ".ts",
  ".js",
  ".json",
  ".md",
  ".html",
  ".example",
  "",
]);

function collectFiles(relative: string, into: string[]): void {
  const absolute = path.join(REPO_ROOT, relative);
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    return;
  }
  if (stats.isFile()) {
    if (SCANNED_EXTENSIONS.has(path.extname(relative))) into.push(relative);
    return;
  }
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) continue;
    collectFiles(path.join(relative, entry.name), into);
  }
}

describe("retired beta account is gone from active project surfaces", () => {
  it("has no active source, fixture, evidence, doc or example referencing it", () => {
    const files: string[] = [];
    for (const root of SCANNED_ROOTS) collectFiles(root, files);
    expect(files.length).toBeGreaterThan(50);

    const offenders = files.filter((relative) => {
      if (HISTORICAL_ALLOWLIST.has(relative)) return false;
      return readFileSync(path.join(REPO_ROOT, relative), "utf8").includes(
        RETIRED_BETA_ACCOUNT,
      );
    });
    expect(offenders).toEqual([]);
  });

  it("scans the surfaces that actually carry the beta account", () => {
    const files: string[] = [];
    for (const root of SCANNED_ROOTS) collectFiles(root, files);
    const carrying = files.filter((relative) =>
      readFileSync(path.join(REPO_ROOT, relative), "utf8").includes(BETA_ACCOUNT),
    );
    expect(carrying).toEqual(
      expect.arrayContaining([
        path.join("src", "final-demo", "constants.ts"),
        path.join("demo", "fixtures", "final-auction-template.json"),
      ]),
    );
  });
});
