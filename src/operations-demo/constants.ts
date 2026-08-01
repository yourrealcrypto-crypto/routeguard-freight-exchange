export const DEMO_TOKEN_ID = "0.0.429274" as const;
export const DEMO_TOKEN_DECIMALS = 6 as const;
export const DEMO_MAX_BUDGET_ATOMIC = "20000" as const;
export const DEMO_WINNING_AMOUNT_ATOMIC = "15000" as const;
export const DEMO_EXCESS_REFUND_ATOMIC = "5000" as const;
export const DEMO_X402_ACCESS_FEE_ATOMIC = "1000" as const;
export const DEMO_OPERATOR_ACCOUNT_ID = "0.0.9197513" as const;
export const DEMO_CARRIER_TREASURY_ACCOUNT_ID = "0.0.9215954" as const;
/** Dedicated reusable Operations Demo infrastructure deployed in Phase F5. */
export const DEMO_CONTRACT_ID = "0.0.9865209" as const;
export const DEMO_CONTRACT_EVM_ADDRESS = "0x00000000000000000000000000000000009687f9" as const;
export const DEMO_HCS_TOPIC_ID = "0.0.9865212" as const;
export const IMMUTABLE_PROOF_CONTRACT_ID = "0.0.9861047" as const;
export const IMMUTABLE_PROOF_CONTRACT_EVM = "0x00000000000000000000000000000000009677b7" as const;
export const IMMUTABLE_PROOF_TOPIC_ID = "0.0.9862010" as const;
export const MAX_STATE_CHANGING_WRITES_PER_SESSION = 12 as const;
export const MAX_STATE_CHANGING_WRITES_PER_DAY = 50 as const;
export const SESSION_IDLE_TTL_MINUTES = 15 as const;
export const SESSION_ABSOLUTE_TTL_MINUTES = 30 as const;
export const LIVE_SUCCESSFUL_PATH_WRITES = Object.freeze({
  OPEN_TENDER: 1,
  SUBMIT_OFFER: 1,
  FUND_ESCROW: 3,
  SELECT_WINNER: 1,
  SUBMIT_POD: 1,
  RUN_ADVISORY: 1,
  ACCEPT_POD: 1,
  RELEASE_FREIGHT: 3,
} as const);
export const LIVE_SUCCESSFUL_PATH = Object.freeze([
  "FUND_ESCROW", "OPEN_TENDER", "SUBMIT_OFFER", "SELECT_WINNER",
  "SUBMIT_POD", "RUN_ADVISORY", "ACCEPT_POD", "RELEASE_FREIGHT",
] as const);
export const LIVE_PROJECTED_WRITES = Object.values(LIVE_SUCCESSFUL_PATH_WRITES).reduce((a, b) => a + b, 0);
