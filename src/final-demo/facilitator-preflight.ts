/**
 * F-002 — facilitator capability preflight (v1.5 §17).
 *
 * Runs BEFORE any irreversible live write (topic create / HCS submit /
 * payment). Asserts the hosted facilitator advertises the exact rail this
 * demo requires: x402 v2, `exact` scheme, `hedera:testnet`, and a fee-payer of
 * the expected shape. Any drift aborts the run before the first side effect.
 *
 * Output is sanitized to the four capability facts — never raw response bodies.
 */

import { FINAL_DEMO_FACILITATOR_FEE_PAYER, FINAL_DEMO_NETWORK } from "./constants";
import { FinalDemoError } from "./errors";

export type FacilitatorCapability = {
  readonly x402Version: 2;
  readonly scheme: "exact";
  readonly network: typeof FINAL_DEMO_NETWORK;
  readonly feePayer: string;
};

const HEDERA_ENTITY_RE = /^\d+\.\d+\.\d+$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate a parsed `/supported` payload. Pure — no network. Returns the
 * sanitized Hedera capability or throws a FinalDemoError on any drift.
 */
export function assertFacilitatorCapability(
  payload: unknown,
  options?: { expectedFeePayer?: string },
): FacilitatorCapability {
  if (!isRecord(payload) || !Array.isArray(payload.kinds)) {
    throw new FinalDemoError(
      "Facilitator /supported response is not a capability document",
      "FACILITATOR_PREFLIGHT_INVALID",
    );
  }
  const hedera = payload.kinds.find(
    (k) =>
      isRecord(k) &&
      k.x402Version === 2 &&
      k.scheme === "exact" &&
      k.network === FINAL_DEMO_NETWORK,
  );
  if (!isRecord(hedera)) {
    throw new FinalDemoError(
      `Facilitator does not advertise x402 v2 exact on ${FINAL_DEMO_NETWORK}`,
      "FACILITATOR_CAPABILITY_DRIFT",
    );
  }
  if (!isRecord(hedera.extra) || typeof hedera.extra.feePayer !== "string") {
    throw new FinalDemoError(
      "Facilitator Hedera capability is missing a fee payer",
      "FACILITATOR_FEE_PAYER_MISSING",
    );
  }
  const feePayer = hedera.extra.feePayer.trim();
  if (!HEDERA_ENTITY_RE.test(feePayer)) {
    throw new FinalDemoError(
      "Facilitator fee payer is not a valid Hedera entity id",
      "FACILITATOR_FEE_PAYER_SHAPE",
    );
  }
  const expected = options?.expectedFeePayer ?? FINAL_DEMO_FACILITATOR_FEE_PAYER;
  if (expected && feePayer !== expected) {
    throw new FinalDemoError(
      "Facilitator fee payer changed from the expected value — capability drift",
      "FACILITATOR_FEE_PAYER_MISMATCH",
    );
  }
  return {
    x402Version: 2,
    scheme: "exact",
    network: FINAL_DEMO_NETWORK,
    feePayer,
  };
}

export type FacilitatorPreflightOptions = {
  facilitatorUrl?: string;
  fetchImpl?: typeof fetch;
  expectedFeePayer?: string;
};

/**
 * Live facilitator capability check. Fetches `/supported` and validates it.
 * Never returns raw bodies. Throws on unreachable / non-OK / drift.
 */
export async function checkFacilitatorPreflight(
  options: FacilitatorPreflightOptions = {},
): Promise<FacilitatorCapability> {
  const base =
    options.facilitatorUrl?.trim() ||
    process.env.FACILITATOR_URL?.trim() ||
    "https://api.testnet.blocky402.com";
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const url = `${base.replace(/\/+$/, "")}/supported`;

  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: "application/json" } });
  } catch {
    throw new FinalDemoError(
      "Facilitator /supported is unreachable — aborting before any live write",
      "FACILITATOR_UNREACHABLE",
    );
  }
  if (!response.ok) {
    throw new FinalDemoError(
      `Facilitator /supported returned HTTP ${response.status}`,
      "FACILITATOR_PREFLIGHT_HTTP",
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new FinalDemoError(
      "Facilitator /supported is not valid JSON",
      "FACILITATOR_PREFLIGHT_INVALID",
    );
  }
  const expected = options.expectedFeePayer
    ? { expectedFeePayer: options.expectedFeePayer }
    : {};
  return assertFacilitatorCapability(payload, expected);
}
