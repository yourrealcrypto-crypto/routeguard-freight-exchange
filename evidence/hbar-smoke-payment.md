# HBAR x402 Testnet Payment Evidence

Status: **SUCCESS**

The normal production-intended client flow completed a real 0.01 HBAR settlement on Hedera Testnet using `wrapFetchWithPayment`.

GET returned HTTP 402 → validated exact challenge → ECDSA public key match PASS → one-attempt guard claimed → signed retry → Blocky402 verified and settled → final HTTP 200.

## Validated payment fields

| Field | Value |
| --- | --- |
| x402 version | 2 |
| Scheme | exact |
| Network | hedera:testnet |
| Asset | 0.0.0 |
| Amount | 1000000 tinybars / 0.01 HBAR |
| Payer | 0.0.9197513 |
| Receiver | 0.0.9215954 |
| Facilitator | https://api.testnet.blocky402.com |
| Fee payer | 0.0.7162784 |
| Initial HTTP status | 402 |
| Final HTTP status | 200 |

## Public key and signing

| Check | Result |
| --- | --- |
| Public key match (before signer) | PASS |
| Expected key type | ECDSA_SECP256K1 (compressed) |
| Expected public key | 02c07aaa7bc004c9c44186395f496639cf46741b6bc8092c024156e5ac68d5fde5 |
| Parser used | PrivateKey.fromStringECDSA (explicit) |
| Ambiguous PrivateKey.fromString in active HBAR path | 0 (none reachable) |

## Transaction IDs and timing

| Item | Value |
| --- | --- |
| Client frozen transaction ID | 0.0.7162784@1784123744.752811412 |
| Facilitator / settlement transaction ID | 0.0.7162784@1784123744.752811412 |
| Transaction ID match (structural) | true |
| Challenge fetch time | 2026-07-15T13:55:47.192Z |
| Payload creation time | 2026-07-15T13:55:48.784Z |
| Signed retry time | 2026-07-15T13:55:49.245Z |
| Facilitator response time | 2026-07-15T13:55:51.410Z |

## Mirror Node verification (authoritative)

| Field | Result |
| --- | --- |
| Transaction exists | yes |
| Result | SUCCESS |
| Consensus timestamp | 1784123752.301455419 |
| Transaction ID (mirror) | 0.0.7162784-1784123744-752811412 |
| Charged tx fee (tinybars) | 296505 (paid by fee payer 0.0.7162784) |
| HashScan Testnet link | https://hashscan.io/testnet/transaction/0.0.7162784@1784123744.752811412 |

## Payment transfers (from consensus transaction)

- Payer 0.0.9197513 → -1000000 tinybars
- Receiver 0.0.9215954 → +1000000 tinybars
- Fee payer 0.0.7162784 → -296505 (node fee)
- Net payment to receiver: exactly +1000000 tinybars
- Fees accounted separately from the 0.01 HBAR payment

## Balances

| Account | Pre-payment HBAR | Post-payment HBAR | Delta HBAR | Delta tinybars |
| --- | ---: | ---: | ---: | ---: |
| Payer 0.0.9197513 | 999.70614797 | 999.69614797 | -0.01000000 | -1000000 |
| Receiver 0.0.9215954 | 1000.10000000 | 1000.11000000 | +0.01000000 | +1000000 |

- Pre-payment check timestamp (approx): 2026-07-15 before 13:55:47Z
- Post-payment balance timestamp: 1784123752.301455419 (consensus)
- Successful payments: 1
- Exactly one settlement attempt occurred in this process: yes
- Evidence generated: 2026-07-15T13:56:30Z (approx)

## Execution constraints met

- Used only normal `wrapFetchWithPayment` + `runHbarSmokeClient` path.
- One settlement attempt only.
- All challenge fields validated exactly (version 2, scheme exact, network hedera:testnet, asset 0.0.0, amount 1000000, payTo 0.0.9215954, feePayer 0.0.7162784, maxTimeout 180).
- No secrets, private keys, full payloads, or signatures logged or committed.
- Server used fresh process with scoped env only (PORT=4000 due to system excluded range on 3100/3000).
- All baselines (typecheck, test, preflight, check:accounts, git diff --check) passed before and after.

No private key, signed payment payload, authorization header, transaction bytes, PAYMENT-SIGNATURE, or secret-bearing environment value is included in this evidence.
