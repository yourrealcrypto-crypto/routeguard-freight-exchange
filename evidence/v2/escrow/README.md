# RouteGuard v2 Phase C2 — live freight escrow (Hedera testnet)

**Status:** SUCCESS  
**Run ID:** `v2escrow-20260731-88bbd727`  
**Date:** 2026-07-31

## What this proves

RouteGuard freight-principal escrow is live on Hedera testnet:

1. `RouteGuardFreightEscrow` deployed (`0.0.9861047`).
2. Contract associated with HTS USDC `0.0.429274`.
3. Synthetic tender registered with max budget **1.00 USDC** (1,000,000 atomic).
4. Shipper approved exact allowance (not unlimited).
5. Shipper funded exact budget into escrow.
6. Operator allocated winning carrier amount **0.75 USDC** (750,000 atomic).
7. Exact excess **0.25 USDC** (250,000 atomic) refunded to shipper.
8. Winning amount remains locked in escrow.
9. Carrier received **0** freight principal during allocation.
10. Every transaction Mirror-verified SUCCESS.

## Economic separation

| Rail | Amount | Destination |
|---|---|---|
| x402 access (Phase B2b, immutable) | 0.001 USDC | Access treasury — **not repeated here** |
| Freight principal (this run) | 1.00 → 0.75 locked + 0.25 refund | Escrow contract / shipper |

Freight principal is **not** an x402 payment.

## Contract

| Field | Value |
|---|---|
| Contract ID | `0.0.9861047` |
| EVM address | `0x00000000000000000000000000000000009677b7` |
| Token | `0.0.429274` (decimals 6) |
| State after run | `ALLOCATED` |
| Locked tender balance | 750,000 atomic |

## Transactions

| Step | Transaction ID |
|---|---|
| Contract create | `0.0.9197513@1785528457.557374203` |
| Associate | `0.0.9197513@1785528465.153884715` |
| Register | `0.0.9197513@1785528470.540863049` |
| Allowance | `0.0.9197513@1785528474.333213938` |
| Fund | `0.0.9197513@1785528475.735005438` |
| Allocate | `0.0.9197513@1785528486.479519241` |

## Truthful claim boundary

- Live on Hedera **testnet** only.
- Synthetic demonstration freight amounts (not a commercial quotation).
- No POD submitted or accepted.
- No dispute or settlement release.
- No freight principal paid to the carrier yet.
- Phase D: encrypted POD upload + advisory AI review.
- Phase E: final release / refund / dispute settlement.
- Phase B x402 access evidence under `evidence/v2/access/` is unchanged.
- v1 `evidence/final-demo-*` is unchanged.

## Write budget

Successful network writes: **10** (cap 10).  
HCS writes: **0**. x402 writes: **0**.

## Privacy

This package contains only public-safe fields (account IDs, EVM addresses,
transaction IDs, atomic amounts, hashes). No private keys, mnemonics, raw
signed transactions, bid salts, or POD content.
