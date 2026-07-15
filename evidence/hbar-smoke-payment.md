# HBAR x402 Testnet Payment Evidence

Status: **FAIL — no settlement**

The single authorized live client invocation validated the approved challenge, signed one retry, and received HTTP 402 instead of the required HTTP 200. The facilitator returned no settlement transaction ID. No second payment was attempted.

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
| Initial HTTP status | 402 |
| Final HTTP status | 402 |

## Settlement and Mirror Node verification

| Field | Result |
| --- | --- |
| Transaction ID | Unavailable — facilitator returned no settlement ID |
| Consensus timestamp | Unavailable |
| Mirror Node verification | FAIL — no authoritative transaction ID |
| Payer transactions since pre-payment timestamp | 0 |
| Receiver transactions since pre-payment timestamp | 0 |
| HashScan transaction link | Unavailable without a transaction ID |

The Testnet Mirror Node account transaction queries used lower-bound timestamp `1784081866.000000000` and returned no transactions for either approved account.

## Balances

| Account | Pre-payment HBAR | Post-payment HBAR | Delta HBAR | Delta tinybars |
| --- | ---: | ---: | ---: | ---: |
| Payer 0.0.9197513 | 999.70763675 | 999.70763675 | 0.00000000 | 0 |
| Receiver 0.0.9215954 | 1000.10000000 | 1000.10000000 | 0.00000000 | 0 |

- Pre-payment timestamp: `2026-07-15T02:17:46.3833308Z`
- Post-payment timestamp: `2026-07-15T02:28:35.6878117Z`
- Live client payment attempts: `1`
- Successful payments: `0`
- Evidence generated: `2026-07-15T02:28:35.6878117Z`

No private key, signed payment payload, authorization header, or secret-bearing environment value is included in this evidence.
