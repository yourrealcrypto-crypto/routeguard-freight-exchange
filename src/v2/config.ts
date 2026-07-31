/**
 * RouteGuard v2 x402 access-gate configuration.
 *
 * Resolved from an explicit environment record so route initialization can be
 * validated and tested without mutating process-wide state. The access treasury
 * is trusted server configuration: it is never taken from a request, a payment
 * payload, or a lifecycle event.
 */

import { isValidHederaAccountId } from "../domain/payment-option";
import { VERIFIED_USDC_TOKEN_ID } from "../x402/usdc-constants";
import { deriveAccessFeeAtomic, ACCESS_TREASURY_ENV_KEY } from "./access/fee";

export const V2_ACCESS_ROUTES_ENV_KEY = "ENABLE_V2_ACCESS_ROUTES" as const;
export const V2_ACCESS_MAX_TIMEOUT_SECONDS = 180 as const;

export type V2AccessConfig = {
  /** Whether the v2 x402 access routes are registered. */
  readonly enabled: boolean;
  readonly network: "hedera:testnet";
  readonly scheme: "exact";
  /** Access-fee treasury (x402 payTo). Never the carrier or escrow account. */
  readonly accessTreasuryAccountId: string;
  readonly asset: string;
  readonly amountAtomic: string;
  readonly maxTimeoutSeconds: number;
};

export class V2AccessConfigError extends Error {
  constructor(
    readonly code: "TREASURY_MISSING" | "TREASURY_INVALID" | "ASSET_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "V2AccessConfigError";
  }
}

export type V2AccessEnv = Readonly<Record<string, string | undefined>>;

/**
 * Resolve and validate v2 access configuration.
 *
 * Fails closed when the routes are enabled but the treasury is absent or
 * malformed. No default treasury account is ever invented.
 */
export function resolveV2AccessConfig(env: V2AccessEnv): V2AccessConfig {
  const enabled = env[V2_ACCESS_ROUTES_ENV_KEY] === "true";
  const rawTreasury = env[ACCESS_TREASURY_ENV_KEY]?.trim() ?? "";
  const asset = env.USDC_TOKEN_ID?.trim() || VERIFIED_USDC_TOKEN_ID;

  if (enabled) {
    if (rawTreasury.length === 0) {
      throw new V2AccessConfigError(
        "TREASURY_MISSING",
        `${ACCESS_TREASURY_ENV_KEY} is required when ${V2_ACCESS_ROUTES_ENV_KEY}=true`,
      );
    }
    if (!isValidHederaAccountId(rawTreasury)) {
      throw new V2AccessConfigError(
        "TREASURY_INVALID",
        `${ACCESS_TREASURY_ENV_KEY} must be a valid Hedera account id`,
      );
    }
    if (asset !== VERIFIED_USDC_TOKEN_ID) {
      throw new V2AccessConfigError(
        "ASSET_INVALID",
        `v2 access gates require the verified USDC token ${VERIFIED_USDC_TOKEN_ID}`,
      );
    }
  }

  return Object.freeze({
    enabled,
    network: "hedera:testnet" as const,
    scheme: "exact" as const,
    accessTreasuryAccountId: rawTreasury,
    asset,
    amountAtomic: deriveAccessFeeAtomic(),
    maxTimeoutSeconds: V2_ACCESS_MAX_TIMEOUT_SECONDS,
  });
}

/**
 * Validate an already-resolved configuration at route-initialization time.
 * Used by route registration so a misconfigured deployment fails closed even if
 * the configuration object was assembled elsewhere.
 */
export function assertUsableV2AccessConfig(config: V2AccessConfig): void {
  if (!isValidHederaAccountId(config.accessTreasuryAccountId)) {
    throw new V2AccessConfigError(
      config.accessTreasuryAccountId.length === 0
        ? "TREASURY_MISSING"
        : "TREASURY_INVALID",
      `${ACCESS_TREASURY_ENV_KEY} must be a valid Hedera account id`,
    );
  }
  if (config.asset !== VERIFIED_USDC_TOKEN_ID) {
    throw new V2AccessConfigError(
      "ASSET_INVALID",
      `v2 access gates require the verified USDC token ${VERIFIED_USDC_TOKEN_ID}`,
    );
  }
  if (config.amountAtomic !== deriveAccessFeeAtomic()) {
    throw new V2AccessConfigError(
      "ASSET_INVALID",
      "access amount must equal the derived product access fee",
    );
  }
}
