/**
 * Offline Solidity compilation for the RouteGuard freight escrow.
 *
 * Uses the pinned `solc` compiler with local imports only (repository sources
 * and the installed OpenZeppelin package). No network access, no remote import
 * resolution, and no external toolchain binary.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const solc = require("solc") as {
  version(): string;
  compile(input: string, options?: { import?: (p: string) => unknown }): string;
};

export const CONTRACTS_DIR = path.resolve(process.cwd(), "contracts");
export const ARTIFACTS_DIR = path.resolve(process.cwd(), "artifacts", "contracts");

export const CONTRACT_SOURCES = [
  "interfaces/IHederaTokenService.sol",
  "RouteGuardFreightEscrowBase.sol",
  "RouteGuardFreightEscrow.sol",
  "test/MockLedgerFreightEscrow.sol",
  "test/ReentrantSettlementAttacker.sol",
] as const;

export type CompiledContract = {
  readonly abi: readonly unknown[];
  readonly bytecode: string;
};

export type CompileResult = {
  readonly solcVersion: string;
  readonly contracts: Readonly<Record<string, CompiledContract>>;
};

type SolcOutput = {
  errors?: { severity: string; formattedMessage: string }[];
  contracts?: Record<
    string,
    Record<string, { abi: unknown[]; evm: { bytecode: { object: string } } }>
  >;
};

/** Resolve an import from the repository or from installed packages only. */
function resolveImport(importPath: string): { contents: string } | { error: string } {
  try {
    if (importPath.startsWith("@")) {
      return {
        contents: readFileSync(require.resolve(importPath), "utf8"),
      };
    }
    return {
      contents: readFileSync(path.join(CONTRACTS_DIR, importPath), "utf8"),
    };
  } catch (error) {
    return { error: `import not found: ${importPath} (${String(error)})` };
  }
}

export function compileContracts(): CompileResult {
  const sources: Record<string, { content: string }> = {};
  for (const source of CONTRACT_SOURCES) {
    sources[source] = {
      content: readFileSync(path.join(CONTRACTS_DIR, source), "utf8"),
    };
  }

  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris",
      outputSelection: {
        "*": { "*": ["abi", "evm.bytecode.object"] },
      },
    },
  };

  const output = JSON.parse(
    solc.compile(JSON.stringify(input), { import: resolveImport }),
  ) as SolcOutput;

  const fatal = (output.errors ?? []).filter((e) => e.severity === "error");
  if (fatal.length > 0) {
    throw new Error(
      `Solidity compilation failed:\n${fatal
        .map((e) => e.formattedMessage)
        .join("\n")}`,
    );
  }

  const contracts: Record<string, CompiledContract> = {};
  for (const [file, entries] of Object.entries(output.contracts ?? {})) {
    for (const [name, compiled] of Object.entries(entries)) {
      contracts[name] = {
        abi: compiled.abi,
        bytecode: `0x${compiled.evm.bytecode.object}`,
      };
      void file;
    }
  }

  return { solcVersion: solc.version(), contracts };
}

export function writeArtifacts(result: CompileResult): string[] {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const written: string[] = [];
  for (const [name, compiled] of Object.entries(result.contracts)) {
    const file = path.join(ARTIFACTS_DIR, `${name}.json`);
    writeFileSync(
      file,
      `${JSON.stringify(
        {
          contractName: name,
          solcVersion: result.solcVersion,
          abi: compiled.abi,
          bytecode: compiled.bytecode,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    written.push(file);
  }
  return written;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).endsWith(path.join("scripts", "compile-contracts.ts"));

if (invokedDirectly) {
  const result = compileContracts();
  const files = writeArtifacts(result);
  const warnings = 0;
  console.log(
    `Compiled ${Object.keys(result.contracts).length} contracts with solc ${result.solcVersion} (${warnings} blocking issues)`,
  );
  for (const file of files) {
    console.log(`  ${path.relative(process.cwd(), file)}`);
  }
}
