/**
 * Verified Hedera Testnet USDC (Circle-issued HTS fungible token).
 *
 * Evidence (2026-07-15):
 * - Circle official: https://developers.circle.com/stablecoins/usdc-contract-addresses
 *   Hedera Testnet → 0.0.429274
 * - Circle multi-chain page: https://www.circle.com/multi-chain-usdc/hedera
 *   Testnet Address → 0.0.429274
 * - Hedera Testnet Mirror Node: GET /api/v1/tokens/0.0.429274
 *   symbol=USDC, name=USD Coin, decimals=6, type=FUNGIBLE_COMMON,
 *   deleted=false, pause_status=NOT_APPLICABLE, treasury=0.0.5176
 * - Also published as HEDERA_TESTNET_USDC in @x402/hedera@2.16.0
 */
export const VERIFIED_USDC_TOKEN_ID = "0.0.429274" as const;
export const VERIFIED_USDC_SYMBOL = "USDC" as const;
export const VERIFIED_USDC_NAME = "USD Coin" as const;
export const VERIFIED_USDC_DECIMALS = 6 as const;
export const VERIFIED_USDC_TREASURY = "0.0.5176" as const;
export const VERIFIED_USDC_TYPE = "FUNGIBLE_COMMON" as const;

export const USDC_SMOKE_NETWORK = "hedera:testnet" as const;
export const USDC_SMOKE_SCHEME = "exact" as const;
export const USDC_SMOKE_X402_VERSION = 2 as const;
export const USDC_SMOKE_MAX_TIMEOUT_SECONDS = 180 as const;

export const USDC_SMOKE_APPROVED_PAYER = "0.0.9197513" as const;
export const USDC_SMOKE_APPROVED_RECEIVER = "0.0.9215954" as const;
export const USDC_SMOKE_APPROVED_FACILITATOR =
  "https://api.testnet.blocky402.com" as const;

/** Fallback when facilitator /supported is unreachable during offline unit tests. */
export const USDC_SMOKE_KNOWN_FEE_PAYER = "0.0.7162784" as const;

export const DEFAULT_USDC_SMOKE_AMOUNT_DISPLAY = "0.01" as const;
export const DEFAULT_USDC_SMOKE_URL =
  "http://localhost:3000/api/x402/usdc-smoke" as const;

export const HEDERA_TESTNET_MIRROR_NODE =
  "https://testnet.mirrornode.hedera.com" as const;
