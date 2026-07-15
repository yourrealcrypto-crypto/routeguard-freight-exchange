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

export const config = Object.freeze({
  port,
  network: "hedera:testnet" as const,
  facilitatorUrl:
    process.env.FACILITATOR_URL ??
    "https://api.testnet.blocky402.com",
  liveHederaEnabled:
    process.env.ENABLE_LIVE_HEDERA === "true",
  liveHbarPaymentsEnabled:
    process.env.ENABLE_LIVE_HBAR_PAYMENTS === "true",
  liveUsdcPaymentsEnabled:
    process.env.ENABLE_LIVE_USDC_PAYMENTS === "true",
});