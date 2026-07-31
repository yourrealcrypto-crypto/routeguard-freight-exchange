# RouteGuard v2 Phase D2 — live POD acceptance (Hedera testnet)

**Status:** SUCCESS
**Run ID:** `v2pod-20260731-4b203b9c`
**Date:** 2026-07-31
**Network writes:** 4 (1 topic create + 3 HCS messages)

## What this proves

1. A synthetic POD package was validated, canonically hashed, and signed by the
   configured carrier identity (real ECDSA secp256k1 application signature).
2. The package was encrypted with AES-256-GCM under a unique per-POD data key
   and IV; the data key is wrapped under the configured master key.
3. Only the encrypted envelope was persisted (`data/v2-pods/`, gitignored).
   Plaintext existed only in an isolated runtime directory and was removed.
4. Three RouteGuard `routeguard-hcs-2.0` envelopes were submitted to a
   dedicated testnet HCS topic and Mirror-verified byte for byte.
5. A deterministic, **non-binding** POD assurance advisory was produced and
   anchored by report hash.
6. The shipper signed a canonical ACCEPT review action; the signature was
   verified before the lifecycle transitioned `POD_UNDER_REVIEW → POD_ACCEPTED`.
7. A `releaseFull` transaction plan was built and bound to the live escrow —
   and **not submitted**.

## What this does NOT prove

- No physical delivery occurred.
- No human recipient signed anything.
- No live AI model analyzed the POD (the adviser is a deterministic stub).
- No freight principal was released.

## Labels

- `SYNTHETIC_BUSINESS_DATA=YES`
- `LIVE_POD_CRYPTO=YES`
- `LIVE_APPLICATION_SIGNATURES=YES`
- `LIVE_HCS_ANCHORS=YES`
- `LIVE_AI_MODEL=NO`
- `ADVISER_IMPLEMENTATION=DETERMINISTIC_STUB`
- `LIVE_PHYSICAL_DELIVERY=NO`
- `LIVE_FREIGHT_RELEASE=NO`
- `ESCROW_STATE_AFTER_RUN=ALLOCATED`
- `LOCKED_AMOUNT_AFTER_RUN=750000`

## HCS topic

| Field | Value |
|---|---|
| Topic ID | `0.0.9862010` |
| Memo | `RouteGuard v2 POD evidence` |
| Create tx | `0.0.9197513@1785534392.284127053` |
| v1 topic `0.0.9794225` reused | **No** |

## Messages (consensus order)

| # | Type | Sequence | Transaction ID |
|---|---|---|---|
| 1 | `POD_SUBMITTED` | 1 | `0.0.9197513@1785534396.504175067` |
| 2 | `POD_ADVISORY_ANCHORED` | 2 | `0.0.9197513@1785534400.313437789` |
| 3 | `POD_REVIEW_ACTION` (ACCEPT) | 3 | `0.0.9197513@1785534407.535669507` |

Every message body is the canonical JSON of the envelope stored beside it in
this directory; Mirror Node bytes were compared by SHA-256.

## Public hashes

| Field | Value |
|---|---|
| Manifest hash | `sha256:169bf54cb487a7ae7248d5f726885e363aacfd29e9a6f140cadd6074102ef582` |
| Package content hash | `sha256:696f18c52dfd6ee78c966474b8b6bb6cf96016fd620c22517aa727cb66231697` |
| Ciphertext hash | `sha256:8cf571af5e3475f9e3672d552ddd6b9976a51b532df0b6678b5a43614eda7f68` |
| Advisory report hash | `sha256:6edfe3bf04345b162c6a35b547fe0d5d1ed441323bf03fa1b64939233fce5a6b` |
| Shipper auth payload hash | `sha256:2b42460cbde64f591c40c4b5e74fea712a16c5d27be954e883d3a719993dbd38` |
| Release authorization hash | `0xc66ae24790348c848c7a8749c444b6947a47bc9760a18d2978c67bdb016c7aeb` |
| Release plan hash | `sha256:0a722dd3043830e0d5a7beaef668699abe1c1e431e351d86e4df94d844dacf95` |

## Live escrow — unchanged

| Field | Before | After |
|---|---|---|
| State | `ALLOCATED` | `ALLOCATED` |
| Locked tender balance | 750000 | 750000 |
| Carrier USDC | 22000 | 22000 |

Contract `0.0.9861047` (`0x00000000000000000000000000000000009677b7`) still holds
**750,000 atomic USDC** for tender key `0x30741f72dc23ac11d4fee37878d9c3fc7fe000377f87cb55ff2196cc82e79f89`. The release
authorization hash is unconsumed on-chain, re-confirmed through the free Mirror
Node `contracts/call` endpoint.

## Ledger footprint

| Kind | Count |
|---|---|
| Authorized state-changing writes (topic create + 3 messages) | **4** |
| Contract state mutations | 0 |
| x402 payments | 0 |
| USDC moved | 0 |
| Hedera query-payment `CRYPTOTRANSFER`s | 7 |

The query payments are the HBAR node fee that the SDK `ContractCallQuery` read
path bills per call; they change no RouteGuard state and move no USDC. The
runner now performs escrow state verification through the free Mirror Node
`contracts/call` endpoint, so a repeat run adds none.

## Envelope-shape note

The anchored payloads use the **closed Phase A `routeguard-hcs-2.0` payload
shapes** unchanged (`POD_SUBMITTED`, `POD_ADVISORY_ANCHORED`,
`POD_REVIEW_ACTION`). Additional public-safe detail — manifest hash, adviser
engine id, finding codes, review-action / authorization / release-plan hashes —
is bound by the anchored hashes and recorded in this evidence directory rather
than widening an accepted on-chain schema.

## Next step

**Phase E1** — execute the real freight release and anchor `ESCROW_RELEASED`
plus `TENDER_COMPLETED`.
