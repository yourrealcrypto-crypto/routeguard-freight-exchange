# RouteGuard v2 Phase E1 — live freight settlement (Hedera testnet)

**Status:** SUCCESS
**Run ID:** `v2rel-20260731-b4c817df`
**Date:** 2026-07-31
**State-changing network writes:** 3 (1 contract call + 2 HCS messages)

## What happened

The signed Phase D2 shipper acceptance was re-verified, its prepared
`releaseFull` plan was executed once against the live escrow, and the locked
freight principal moved to the winning carrier. The release and completion were
then anchored to the same HCS topic that already carried the POD evidence.

| Step | Value |
|---|---|
| `releaseFull` tx | `0.0.9197513@1785536472.599444485` |
| Released | **750,000 atomic USDC (0.75 USDC)** of token `0.0.429274` |
| From | escrow contract `0.0.9861047` |
| To | carrier `0.0.9215954` |
| Authorization hash | `0xc66ae24790348c848c7a8749c444b6947a47bc9760a18d2978c67bdb016c7aeb` |
| Contract final state | `RELEASED` |
| Remaining locked balance | **0** |

## Balance reconciliation (token `0.0.429274`)

| Account | Before | After | Delta |
|---|---|---|---|
| Carrier `0.0.9215954` | 22000 | 772000 | **+750000** |
| Escrow `0.0.9861047` | 750000 | 0 | **-750000** |
| Shipper `0.0.9197513` | 19228000 | 19228000 | 0 |

## Complete HCS evidence chain — topic `0.0.9862010`

| Seq | Message | Phase |
|---|---|---|
| 1 | `POD_SUBMITTED` | D2 |
| 2 | `POD_ADVISORY_ANCHORED` | D2 |
| 3 | `POD_REVIEW_ACTION` | D2 |
| 4 | `ESCROW_RELEASED` | E1 |
| 5 | `TENDER_COMPLETED` | E1 |

| Message | Transaction ID |
|---|---|
| `ESCROW_RELEASED` | `0.0.9197513@1785536865.385875442` |
| `TENDER_COMPLETED` | `0.0.9197513@1785536867.228168869` |

Evidence-chain hash: `sha256:975b152ec9352c493091e22962bdc9ae1e4319a1713178cc5ec86420790f7042`

## Truthful final claim

- The x402 access payments were **real Hedera testnet transactions**.
- The HTS USDC freight escrow was **real**.
- The maximum **synthetic** freight budget was funded (1.00 USDC).
- The winning amount was locked (0.75) and the excess refunded (0.25).
- The POD was **synthetic**, encrypted, and cryptographically signed.
- POD integrity and shipper acceptance were **anchored through HCS**.
- The shipper acceptance **caused the real escrowed freight amount to be
  released**.
- The winning carrier received **exactly 750,000 atomic testnet USDC**.
- The complete evidence sequence is **ordered on Hedera** (sequences 1–5).
- The deterministic adviser was **non-binding** and is not a live AI model.
- **No physical delivery and no real-world commercial freight is claimed.**

## Ledger footprint

| Kind | Count |
|---|---|
| Contract state-changing calls | 1 |
| HCS message submissions | 2 |
| x402 payments | 0 |
| Other state-changing writes | 0 |
| Hedera query-payment `CRYPTOTRANSFER`s | 0 |

All escrow state verification used the free Mirror Node `contracts/call`
endpoint.

## Envelope-shape note

`ESCROW_RELEASED` and `TENDER_COMPLETED` use the **unchanged closed Phase A
`routeguard-hcs-2.0` payload shapes**. Additional public-safe context (tender
key, POD identity, authorization and release-plan hashes, contract id, evidence
chain) is recorded in this directory and bound into the anchored
`completionRef` evidence-chain hash rather than widening an accepted schema.

## Next step

**Phase F** — production website integration, Judge Mode, deployment, and the
submission package.
