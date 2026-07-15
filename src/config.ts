import "dotenv/config";

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

const liveHbarPaymentsEnabled =
  process.env.ENABLE_LIVE_HBAR_PAYMENTS === "true";

const liveUsdcPaymentsEnabled =
  process.env.ENABLE_LIVE_USDC_PAYMENTS === "true";

const carrierAccountId =
  process.env.CARRIER_ACCOUNT_ID?.trim() || null;

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
  liveHederaEnabled &&
  liveHbarPaymentsEnabled &&
  !carrierAccountId
) {
  throw new Error(
    "CARRIER_ACCOUNT_ID is required for live HBAR payments.",
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
  liveHbarPaymentsEnabled,
  liveUsdcPaymentsEnabled,
});