import "dotenv/config";

import { displayAmountToSmallestUnits } from "./x402/usdc-amount";
import {
  DEFAULT_USDC_SMOKE_AMOUNT_DISPLAY,
  VERIFIED_USDC_DECIMALS,
  VERIFIED_USDC_TOKEN_ID,
} from "./x402/usdc-constants";

const network = process.env.HEDERA_NETWORK ?? "hedera:testnet";

if (network !== "hedera:testnet") {
  throw new Error(
    `Unsupported network "${network}". RouteGuard is testnet-only.`,
  );
}

const port = Number.parseInt(process.env.PORT ?? "3000", 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT value: ${process.env.PORT}`);
}

const liveHederaEnabled =
  process.env.ENABLE_LIVE_HEDERA === "true";

const hbarSmokeChallengeEnabled =
  process.env.ENABLE_HBAR_SMOKE_CHALLENGE === "true";

const liveHbarPaymentsEnabled =
  process.env.ENABLE_LIVE_HBAR_PAYMENTS === "true";

const usdcSmokeChallengeEnabled =
  process.env.ENABLE_USDC_SMOKE_CHALLENGE === "true";

const liveUsdcPaymentsEnabled =
  process.env.ENABLE_LIVE_USDC_PAYMENTS === "true";

const carrierAccountId =
  process.env.CARRIER_ACCOUNT_ID?.trim() || null;

/**
 * Configured USDC HTS token ID. Defaults to the Mirror Node + Circle-verified
 * Hedera Testnet USDC token. Override only when intentionally targeting a
 * different documented test asset.
 */
const usdcTokenId =
  process.env.USDC_TOKEN_ID?.trim() || VERIFIED_USDC_TOKEN_ID;

if (!/^\d+\.\d+\.\d+$/.test(usdcTokenId)) {
  throw new Error(`Invalid USDC_TOKEN_ID: ${usdcTokenId}`);
}

/**
 * Token decimals for the verified Testnet USDC asset.
 * Validated via Mirror Node metadata (decimals=6); not assumed blindly.
 */
const usdcDecimals = VERIFIED_USDC_DECIMALS;

const usdcSmokeAmountDisplay =
  process.env.USDC_SMOKE_AMOUNT_DISPLAY?.trim() ||
  DEFAULT_USDC_SMOKE_AMOUNT_DISPLAY;

const usdcSmokeAmountSmallestUnits = displayAmountToSmallestUnits(
  usdcSmokeAmountDisplay,
  usdcDecimals,
);

if (liveHbarPaymentsEnabled && !liveHederaEnabled) {
  throw new Error(
    "ENABLE_LIVE_HBAR_PAYMENTS requires ENABLE_LIVE_HEDERA=true.",
  );
}

if (liveUsdcPaymentsEnabled && !liveHederaEnabled) {
  throw new Error(
    "ENABLE_LIVE_USDC_PAYMENTS requires ENABLE_LIVE_HEDERA=true.",
  );
}

if (
  (
    hbarSmokeChallengeEnabled ||
    usdcSmokeChallengeEnabled ||
    (liveHederaEnabled && liveHbarPaymentsEnabled) ||
    (liveHederaEnabled && liveUsdcPaymentsEnabled)
  ) &&
  !carrierAccountId
) {
  throw new Error(
    "CARRIER_ACCOUNT_ID is required for smoke challenges or live Hedera payments.",
  );
}

export const config = Object.freeze({
  port,
  network: "hedera:testnet" as const,

  facilitatorUrl:
    process.env.FACILITATOR_URL ??
    "https://api.testnet.blocky402.com",

  carrierAccountId,

  liveHederaEnabled,
  hbarSmokeChallengeEnabled,
  liveHbarPaymentsEnabled,

  usdcSmokeChallengeEnabled,
  liveUsdcPaymentsEnabled,
  usdcTokenId,
  usdcDecimals,
  usdcSmokeAmountDisplay,
  usdcSmokeAmountSmallestUnits,
});
