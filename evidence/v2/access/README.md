# RouteGuard v2 Phase B2b — live x402 access payments

**Run ID:** `v2access-20260731-918f5748`

## What this proves

- Two **real** Hedera testnet x402 `exact` USDC access payments completed.
- Tender activation access fee: **0.001 USDC (1000 atomic)** to access treasury.
- Carrier bid submission access fee: **0.001 USDC (1000 atomic)** to access treasury.
- Token: `0.0.429274` · Network: `hedera:testnet` · Scheme: `exact`.

## Public transaction references

| Action | Transaction | HashScan |
|---|---|---|
| Tender activation | `0.0.7162784@1785519911.424021609` | https://hashscan.io/testnet/transaction/0.0.7162784@1785519911.424021609 |
| Bid submission | `0.0.7162784@1785520014.520040785` | https://hashscan.io/testnet/transaction/0.0.7162784@1785520014.520040785 |

## Claim boundary (truthful)

| Claim | Value |
|---|---|
| LIVE_X402_PAYMENT | YES |
| LIVE_FREIGHT_ESCROW | **NO** |
| ESCROW_PHASE | C_PENDING |
| HCS submitted | **NO** (outbox only offline) |
| POD / freight release | **NO** |
| Business tender/bid data | Synthetic demonstration data |
| v1 final-demo evidence | Unchanged / separate |

## Write budget

- Successful x402 settlements: **2**
- HCS network writes: **0**
- Other Hedera writes: **0**

## Privacy

Artifacts exclude private keys, raw payment headers, full payment payloads,
private bid bodies, and bid salts.
