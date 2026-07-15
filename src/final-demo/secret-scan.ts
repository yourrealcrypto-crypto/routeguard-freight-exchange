/**
 * Secret / private-key scan gate for public paths.
 * Reports paths only — never prints matching secret values.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";

import { FinalDemoError } from "./errors";

/** Field names / patterns that must never appear with real values in public data. */
const SENSITIVE_FIELD_PATTERNS: RegExp[] = [
  /["']routeGuardPrivateKeyHex["']\s*:/i,
  /["']signingPrivateKeyHex["']\s*:/i,
  /["']carrierPrivateKey["']\s*:/i,
  /["']operatorPrivateKey["']\s*:/i,
  /["']payerPrivateKey["']\s*:/i,
  /["']privateKeyHex["']\s*:/i,
  /["']signingPrivateKey["']\s*:/i,
  /["']secretKey["']\s*:/i,
  /["']privateKey["']\s*:\s*["'][0-9a-fA-F]{64,}["']/,
  /BEGIN (EC |RSA |OPENSSH )?PRIVATE KEY/,
  /HEDERA_[A-Z0-9_]*_KEY\s*=\s*(?!your_|<.*>|REPLACE|xxx|placeholder)[^\s"']{16,}/i,
  /PAYMENT-SIGNATURE\s*:\s*(?!mock|placeholder|test)[A-Za-z0-9+/=_-]{20,}/i,
];

/** Object key names treated as private-key fields when present on plain objects. */
const SENSITIVE_OBJECT_KEYS = new Set([
  "routeGuardPrivateKeyHex",
  "signingPrivateKeyHex",
  "carrierPrivateKey",
  "operatorPrivateKey",
  "payerPrivateKey",
  "privateKeyHex",
  "signingPrivateKey",
  "secretKey",
  "privateKey",
  "HEDERA_OPERATOR_KEY",
  "HEDERA_PAYER_KEY",
  "SHIPPER_PRIVATE_KEY",
]);

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".grok",
]);

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".txt",
  ".yml",
  ".yaml",
  ".env",
  ".toml",
  ".html",
  ".css",
]);

export type SecretScanFinding = {
  path: string;
  reason: string;
};

export type SecretScanResult = {
  ok: boolean;
  scannedFileCount: number;
  findings: SecretScanFinding[];
};

function isProbablySha256HashLiteral(value: string): boolean {
  // sha256:<64 hex> or bare 64-hex used as hash fields — not private keys
  if (/^sha256:[0-9a-f]{64}$/i.test(value)) return true;
  return false;
}

/**
 * Walk a JSON-like value and fail if any sensitive object keys are present.
 * Does not print values.
 */
export function assertNoPrivateKeyFields(
  value: unknown,
  label: string,
): void {
  const paths: string[] = [];
  function walk(v: unknown, p: string): void {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${p}[${i}]`));
      return;
    }
    if (typeof v === "object") {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        if (SENSITIVE_OBJECT_KEYS.has(k)) {
          paths.push(`${p}.${k}`);
        } else {
          walk(child, p ? `${p}.${k}` : k);
        }
      }
    }
  }
  walk(value, "");
  if (paths.length > 0) {
    throw new FinalDemoError(
      `Private-key fields present in ${label}: ${paths.join(", ")}`,
      "PRIVATE_KEY_FIELD_PRESENT",
    );
  }
}

function shouldScanFile(filePath: string): boolean {
  const base = path.basename(filePath);
  if (base === ".env" || base.startsWith(".env.")) return true;
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

function scanFileContent(
  filePath: string,
  content: string,
): SecretScanFinding[] {
  const findings: SecretScanFinding[] = [];
  // Skip pure hash-looking content lines falsely matching 64-hex privateKey patterns
  // by checking patterns that require field names first.
  for (const re of SENSITIVE_FIELD_PATTERNS) {
    if (re.test(content)) {
      // Extra guard: bare privateKey:"64hex" — allow if value is a known hash field context
      if (
        re.source.includes("privateKey") &&
        !/["']privateKey["']\s*:/.test(content) &&
        !/PrivateKey/.test(content) &&
        !/privateKeyHex|signingPrivateKey|routeGuardPrivateKey/.test(content)
      ) {
        continue;
      }
      findings.push({
        path: filePath,
        reason: `matched sensitive pattern: ${re.source.slice(0, 60)}`,
      });
      break;
    }
  }

  // JSON object key scan
  if (filePath.endsWith(".json")) {
    try {
      const parsed = JSON.parse(content) as unknown;
      const keys: string[] = [];
      function walk(v: unknown): void {
        if (!v || typeof v !== "object") return;
        if (Array.isArray(v)) {
          v.forEach(walk);
          return;
        }
        for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
          if (SENSITIVE_OBJECT_KEYS.has(k)) {
            // Ignore if the value looks like a documentation placeholder
            const val = child;
            if (
              typeof val === "string" &&
              (val.includes("REPLACE") ||
                val.includes("placeholder") ||
                val.includes("<") ||
                isProbablySha256HashLiteral(val))
            ) {
              walk(child);
              continue;
            }
            keys.push(k);
          } else {
            walk(child);
          }
        }
      }
      walk(parsed);
      if (keys.length > 0) {
        findings.push({
          path: filePath,
          reason: `JSON contains private-key field name(s): ${[...new Set(keys)].join(", ")}`,
        });
      }
    } catch {
      // non-JSON with .json extension — pattern scan already applied
    }
  }
  return findings;
}

function walkDir(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIR_NAMES.has(name)) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkDir(full, out);
    } else if (st.isFile() && shouldScanFile(full)) {
      out.push(full);
    }
  }
}

export type SecretScanOptions = {
  rootDir?: string;
  extraPaths?: string[];
  /** Relative roots to scan under rootDir */
  includeRoots?: string[];
};

/**
 * Scan tracked/public source, demo, evidence, scripts, and test fixtures.
 * Never returns secret values — paths and reasons only.
 */
export function runSecretScan(
  options: SecretScanOptions = {},
): SecretScanResult {
  const root = path.resolve(options.rootDir ?? process.cwd());
  const includeRoots = options.includeRoots ?? [
    "src",
    "scripts",
    "demo",
    "evidence",
    "test",
    "docs",
    "README.md",
    "package.json",
  ];

  const files: string[] = [];
  for (const rel of includeRoots) {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) continue;
    const st = statSync(abs);
    if (st.isDirectory()) {
      walkDir(abs, files);
    } else if (st.isFile()) {
      files.push(abs);
    }
  }
  for (const extra of options.extraPaths ?? []) {
    const abs = path.resolve(root, extra);
    if (existsSync(abs) && statSync(abs).isFile()) {
      files.push(abs);
    }
  }

  const unique = [...new Set(files)];
  const findings: SecretScanFinding[] = [];
  for (const file of unique) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // Allow source code that *mentions* private key field names in scanners/tests
    // when they are pattern definitions or deny-lists — but fail on assignment-like
    // values with 64+ hex in non-test fixture production data.
    const rel = path.relative(root, file).replace(/\\/g, "/");
    const isSecretScanImpl =
      rel.includes("secret-scan") ||
      rel.includes("check-secrets") ||
      rel.includes("final-demo.test") ||
      rel.includes("phase6b-live-reservation.test") ||
      rel.includes("auction-fixtures") ||
      rel.includes("reservation-fixtures");

    if (isSecretScanImpl) {
      // Still fail if test fixtures accidentally include routeGuardPrivateKeyHex JSON keys with real hex
      if (
        rel.endsWith(".json") &&
        /routeGuardPrivateKeyHex|signingPrivateKeyHex/.test(content)
      ) {
        findings.push({
          path: rel,
          reason: "fixture JSON contains private-key field name",
        });
      }
      continue;
    }

    // Source TypeScript may reference parameter names like privateKeyHex in function
    // signatures — allow those. Fail on JSON-like assignments of long hex secrets
    // outside scanners.
    if (rel.endsWith(".ts") || rel.endsWith(".js") || rel.endsWith(".mjs")) {
      // Flag only explicit secret-bearing literals in non-fixture source
      if (
        /routeGuardPrivateKeyHex\s*[:=]\s*["'][0-9a-fA-F]{64,}["']/.test(
          content,
        ) ||
        /signingPrivateKeyHex\s*[:=]\s*["'][0-9a-fA-F]{64,}["']/.test(content) ||
        /BEGIN (EC |RSA )?PRIVATE KEY/.test(content)
      ) {
        findings.push({
          path: rel,
          reason: "source appears to embed a private-key literal",
        });
      }
      // Allow domain API param names
      continue;
    }

    const fileFindings = scanFileContent(rel, content);
    findings.push(...fileFindings);
  }

  return {
    ok: findings.length === 0,
    scannedFileCount: unique.length,
    findings,
  };
}

export function assertSecretScanPass(
  options?: SecretScanOptions,
): SecretScanResult {
  const result = runSecretScan(options);
  if (!result.ok) {
    const paths = result.findings.map((f) => f.path).join(", ");
    throw new FinalDemoError(
      `Secret scan failed for path(s): ${paths}`,
      "SECRET_SCAN_FAILED",
    );
  }
  return result;
}
