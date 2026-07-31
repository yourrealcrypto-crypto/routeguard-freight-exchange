/**
 * Public-safe escrow event and result parsing.
 *
 * Escrow evidence is public: only tender keys, versions, addresses, atomic
 * amounts, and hashes are ever surfaced. Nothing here can expose POD content,
 * bid bodies, salts, signatures, narratives, or personal data — the contract
 * never receives those values in the first place.
 */

import { Interface, type Log } from "ethers";

import { ROUTEGUARD_FREIGHT_ESCROW_ABI, type EscrowEventName } from "./abi";
import { escrowStateFromOrdinal, type EscrowState } from "./states";

const escrowInterface = new Interface([...ROUTEGUARD_FREIGHT_ESCROW_ABI]);

/** Fields allowed to leave the escrow boundary, per event. */
const PUBLIC_EVENT_FIELDS: Readonly<Record<EscrowEventName, readonly string[]>> = {
  TenderEscrowRegistered: [
    "tenderKey",
    "tenderIdHash",
    "tenderVersion",
    "shipper",
    "maxBudget",
    "token",
    "creationAuthHash",
    "manifestHash",
  ],
  TenderEscrowFunded: ["tenderKey", "shipper", "fundedAmount"],
  WinnerAllocated: [
    "tenderKey",
    "winner",
    "winningAmount",
    "excessAmount",
    "decisionManifestHash",
    "allocationAuthHash",
  ],
  ExcessRefunded: ["tenderKey", "shipper", "excessAmount"],
  NoWinnerRefunded: ["tenderKey", "shipper", "amount", "authorizationHash"],
  DisputeOpened: ["tenderKey", "disputeAuthHash"],
  FreightReleased: [
    "tenderKey",
    "winner",
    "amount",
    "authorizationHash",
    "fromDispute",
  ],
  FreightRefunded: [
    "tenderKey",
    "shipper",
    "amount",
    "authorizationHash",
    "fromDispute",
  ],
  FreightPartiallyReleased: [
    "tenderKey",
    "winner",
    "shipper",
    "winnerAmount",
    "shipperAmount",
    "authorizationHash",
  ],
};

export type ParsedEscrowEvent = {
  readonly name: EscrowEventName;
  /** Amounts are atomic integer strings; addresses are lowercase hex. */
  readonly fields: Readonly<Record<string, string | number | boolean>>;
};

export class EscrowEventParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EscrowEventParseError";
  }
}

/** Parse one contract log into a public-safe event, or null when unrelated. */
export function parseEscrowEvent(log: {
  topics: readonly string[];
  data: string;
}): ParsedEscrowEvent | null {
  let parsed;
  try {
    parsed = escrowInterface.parseLog({
      topics: [...log.topics],
      data: log.data,
    } as unknown as Log);
  } catch {
    return null;
  }
  if (!parsed) return null;

  const allowed = PUBLIC_EVENT_FIELDS[parsed.name as EscrowEventName];
  if (!allowed) {
    return null;
  }

  const fields: Record<string, string | number | boolean> = {};
  parsed.fragment.inputs.forEach((input, index) => {
    if (!allowed.includes(input.name)) {
      return;
    }
    const value = parsed.args[index];
    fields[input.name] = normalizeEventValue(input.type, value);
  });

  return { name: parsed.name as EscrowEventName, fields };
}

export function parseEscrowEvents(
  logs: readonly { topics: readonly string[]; data: string }[],
): ParsedEscrowEvent[] {
  const events: ParsedEscrowEvent[] = [];
  for (const log of logs) {
    const parsed = parseEscrowEvent(log);
    if (parsed) events.push(parsed);
  }
  return events;
}

function normalizeEventValue(
  type: string,
  value: unknown,
): string | number | boolean {
  if (type === "bool") {
    return Boolean(value);
  }
  if (type === "uint32") {
    return Number(value);
  }
  if (type.startsWith("uint") || type.startsWith("int")) {
    // Money stays an atomic integer string — never a JS number.
    return BigInt(value as bigint).toString();
  }
  if (type === "address") {
    return String(value).toLowerCase();
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Transaction result parsing
// ---------------------------------------------------------------------------

/** Hedera response codes RouteGuard treats explicitly. */
export const HTS_SUCCESS_RESPONSE_CODE = 22;

export type EscrowExecutionOutcome = {
  readonly status: "SUCCESS" | "FAILED";
  readonly transactionId: string | null;
  readonly contractId: string | null;
  readonly errorName: string | null;
  readonly events: readonly ParsedEscrowEvent[];
};

/**
 * Parse a Hedera contract-call result into a typed outcome.
 * Accepts the minimal shape that both the SDK receipt/record and a Mirror Node
 * contract result expose; unknown extra fields are ignored.
 */
export function parseEscrowExecutionResult(input: {
  status?: string | null;
  transactionId?: string | null;
  contractId?: string | null;
  errorMessage?: string | null;
  logs?: readonly { topics: readonly string[]; data: string }[];
}): EscrowExecutionOutcome {
  const success =
    typeof input.status === "string" && input.status.toUpperCase() === "SUCCESS";
  return {
    status: success ? "SUCCESS" : "FAILED",
    transactionId: input.transactionId ?? null,
    contractId: input.contractId ?? null,
    errorName: success ? null : decodeErrorName(input.errorMessage ?? null),
    events: success ? parseEscrowEvents(input.logs ?? []) : [],
  };
}

function decodeErrorName(errorMessage: string | null): string | null {
  if (!errorMessage) return null;
  if (/^0x[0-9a-fA-F]{8,}$/.test(errorMessage)) {
    try {
      const parsed = escrowInterface.parseError(errorMessage);
      if (parsed) return parsed.name;
    } catch {
      // fall through to the raw label
    }
  }
  // Never surface raw revert payloads; a bounded label only.
  return errorMessage.slice(0, 64);
}

/** Read-only escrow state parser for a `getState` call result. */
export function parseEscrowStateResult(value: unknown): EscrowState {
  if (typeof value === "bigint" || typeof value === "number") {
    return escrowStateFromOrdinal(value);
  }
  if (typeof value === "string" && /^(0x)?[0-9a-fA-F]+$/.test(value)) {
    return escrowStateFromOrdinal(Number(BigInt(value)));
  }
  throw new EscrowEventParseError("unsupported escrow state encoding");
}
