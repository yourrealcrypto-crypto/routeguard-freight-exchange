# USDC x402 Testnet Payment Evidence

Status: **SUCCESS**

The normal production-intended client flow completed a real **0.01 USDC** settlement on Hedera Testnet using `wrapFetchWithPayment`.

GET returned HTTP 402 → validated exact challenge → ECDSA public key match PASS → one-attempt guard claimed → signed retry → Blocky402 verified and settled → final HTTP 200 → Mirror Node SUCCESS.

## Validated payment fields

| Field | Value |
| --- | --- |
| Status | SUCCESS |
| x402 version | 2 |
| Scheme | exact |
| Network | hedera:testnet |
| Token ID | 0.0.429274 |
| Token symbol | USDC |
| Decimals | 6 |
| Display amount | 0.01 USDC |
| Atomic amount | 10000 |
| Payer | 0.0.9197513 |
| Receiver | 0.0.9215954 |
| Facilitator | https://api.testnet.blocky402.com |
| Facilitator fee payer | 0.0.7162784 |
| Initial HTTP status | 402 |
| Final HTTP status | 200 |
| maxTimeoutSeconds | 180 |

## Public key and signing

| Check | Result |
| --- | --- |
| Public key match (before signer) | PASS |
| Expected key type | ECDSA_SECP256K1 (compressed) |
| Expected public key | 02c07aaa7bc004c9c44186395f496639cf46741b6bc8092c024156e5ac68d5fde5 |
| Parser used | PrivateKey.fromStringECDSA (explicit) |
| Ambiguous PrivateKey.fromString in active USDC path | 0 (none reachable) |

## Transaction IDs and timing

| Item | Value |
| --- | --- |
| Client frozen transaction ID | 0.0.7162784@1784141033.517654222 |
| Facilitator / settlement transaction ID | 0.0.7162784@1784141033.517654222 |
| Mirror Node transaction ID | 0.0.7162784-1784141033-517654222 |
| Transaction ID match (structural) | true |
| Challenge fetch time | 2026-07-15T18:43:57.502Z |
| Payload creation time | 2026-07-15T18:43:59.856Z |
| Signed retry time | 2026-07-15T18:44:00.658Z |
| Facilitator response time | 2026-07-15T18:44:03.679Z |

## Mirror Node verification (authoritative)

| Field | Result |
| --- | --- |
| Transaction exists | yes |
| Result | SUCCESS |
| Transaction name | CRYPTOTRANSFER |
| Consensus timestamp | 1784141044.443662817 |
| Token ID on transfers | 0.0.429274 |
| Payer token transfer | 0.0.9197513 → **-10000** atomic USDC |
| Receiver token transfer | 0.0.9215954 → **+10000** atomic USDC |
| Second USDC transfer | no (exactly two token transfer legs for this token) |
| Charged HBAR tx fee | 75699963 tinybars |
| Fee payer | 0.0.7162784 (facilitator fee payer; not the x402 payer) |
| HashScan Testnet link | https://hashscan.io/testnet/transaction/0.0.7162784@1784141033.517654222 |

## Receiver association

| State | Associated with 0.0.429274 |
| --- | --- |
| Before settlement | false |
| After settlement | true |

Receiver had `max_automatic_token_associations: -1` and auto-associated during the incoming USDC transfer. `associate:usdc` was not run.

## USDC balances

| Account | Pre (atomic) | Post (atomic) | Delta (atomic) | Pre display | Post display |
| --- | ---: | ---: | ---: | ---: | ---: |
| Payer 0.0.9197513 | 20000000 | 19990000 | -10000 | 20 USDC | 19.99 USDC |
| Receiver 0.0.9215954 | 0 | 10000 | +10000 | 0 USDC | 0.01 USDC |

- Pre-payment check timestamp: 2026-07-15T18:43:23.3162317Z
- Post-payment consensus timestamp: 1784141044.443662817
- Payer post-balance equals pre-balance minus 10000: yes
- Receiver post-balance equals pre-balance plus 10000: yes

## HBAR note (fees only)

| Account | Pre HBAR tinybars | Post HBAR tinybars | Delta |
| --- | ---: | ---: | ---: |
| Payer 0.0.9197513 | 99896302448 | 99896302448 | 0 |
| Receiver 0.0.9215954 | 100011000000 | 100011000000 | 0 |
| Fee payer 0.0.7162784 | (not pre-sampled) | paid fee | -75699963 tinybars |

USDC token transfers are separate from HBAR fee transfers. The x402 payment amount is exactly 10000 atomic USDC (0.01 USDC). No HBAR payment was executed as the settlement asset.

## Exactly one attempt

| Check | Result |
| --- | --- |
| Successful payments | 1 |
| Settlement attempts in this process | 1 |
| One-attempt guard claimed | yes |
| Second payment attempted | no |

## Execution constraints met

- Used only normal `wrapFetchWithPayment` + `runUsdcSmokeClient` path.
- One settlement attempt only; stopped after that attempt.
- All challenge fields validated exactly before private-key access (version 2, scheme exact, network hedera:testnet, asset 0.0.429274, amount 10000, payTo 0.0.9215954, feePayer 0.0.7162784, maxTimeout 180).
- Challenge was not rewritten; no alternate payment option selected.
- Did not call `/settle` directly; did not run `associate:usdc`; did not execute an HBAR payment.
- Server used a fresh process with process-scoped env only (`PORT=4000`, live USDC flags true, live HBAR payments false). Values were not written into `.env`.
- No private key, PAYMENT-SIGNATURE, complete signed payload, transaction bytes, authorization header, or secret-bearing environment value is included in this evidence.
- Phase 4 auction/domain implementation was not modified.
- Evidence generated: 2026-07-15T18:45:30.000Z
