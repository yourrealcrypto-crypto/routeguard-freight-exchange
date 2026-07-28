# Challenge compliance matrix

Requirement-to-proof mapping for the Hedera x402 bounty submission.

Authority order: official bounty wording → frozen plan v1.5 (README pointer) /
available plan v1.4 → current repository architecture → tests and live evidence.

**Classification legend (not scoring weights):**

| Classification | Meaning |
| --- | --- |
| Official requirement | Stated in the official challenge / bounty wording |
| Official judging criterion | Explicit judging/evaluation criterion from the official challenge materials |
| Product alignment | RouteGuard product choice that supports the challenge without being a separate official score line |
| RouteGuard differentiator | Distinctive RouteGuard design (not an official weight); shown for product clarity only |

Do **not** treat any column as an inferred numerical scoring weight. Official
criteria are not reweighted here.

| Requirement | Classification | Implementation location | Automated test | Live / demo evidence |
| --- | --- | --- | --- | --- |
| x402 through HTTP 402 | Official requirement | `src/x402/*`, `src/reservation/challenge.ts`, smoke routes | `test/hbar-smoke-client.test.ts`, `test/usdc-smoke-route.test.ts`, reservation challenge tests | `evidence/hbar-smoke-payment.*`, `evidence/usdc-smoke-payment.*` |
| x402 v2 | Official requirement | `CHALLENGE_X402_VERSION = 2`, smoke clients | Challenge binding + smoke client tests | Live smoke evidence JSON (`x402Version: 2`) |
| exact scheme | Official requirement | `RESERVATION_SCHEME = "exact"`, `@x402/hedera/exact` | Offer/challenge/schema tests | Facilitator `/supported` + smoke evidence |
| hedera:testnet | Official requirement | `RESERVATION_NETWORK`, config | Domain/schema tests | HashScan testnet links in live evidence only |
| Native HBAR support | Official requirement | `HBAR_RESERVATION_OPTION`, HBAR smoke path | `test/hbar-smoke-client.test.ts`, dual-asset reservation tests | `evidence/hbar-smoke-payment.md` |
| USDC / HTS support | Official requirement | `USDC_RESERVATION_OPTION`, USDC smoke path | `test/usdc-smoke-*.test.ts` | `evidence/usdc-smoke-payment.md` |
| HBAR transfer cost $0.0001 | Official requirement | `src/domain/hedera-transfer-costs.ts` (`HBAR.networkFeeUsd`) | `test/hedera-transfer-costs.test.ts`, compliance tests | README table; demo CLI; dry-run evidence; report |
| Stablecoin transfer cost $0.001 | Official requirement | `src/domain/hedera-transfer-costs.ts` (`HTS_STABLECOIN.networkFeeUsd`) | `test/hedera-transfer-costs.test.ts`, compliance tests | README table; demo CLI; dry-run evidence; report |
| Software-to-software payment | Official requirement | Shipper client + resource server; no wallet checkout | Reservation + smoke client tests | Demo script + final-demo dry-run / live report |
| Real testnet settlement | Official judging criterion | Guarded live smoke / final-demo paths | Offline settlement-first tests; live evidence files | HashScan links in smoke / live final-demo evidence (owner-guarded) |
| HashScan evidence | Official judging criterion | Smoke / live evidence exporters; report generator | Evidence + report tests | `evidence/*-smoke-payment.md`, live report (not dry) |
| HCS evidence | Official judging criterion | `src/hcs/*`, auction + reservation ROUTE_RESERVED | HCS reconciliation + final-demo tests | `evidence/hcs-auction-demo.*`, final-demo dry-run / live |
| Settlement before reservation | Official requirement | `ReservationService` + state machine | Reservation hardening / service tests | Live reservation evidence; report timeline |
| Idempotency | Product alignment | Settle claim CAS, attempt store, webhook/HCS outbox | Reservation adversarial + settle-claim tests | Attempt records under `data/` / `evidence/` |
| Wrong-recipient prevention | Product alignment | Payment verifier `payTo` binding | `test/reservation-payment-verifier.test.ts`, hardening tests | Negative-path offline tests; report fail-closed panel |
| Private off-chain bids with salted, consensus-timestamped HCS commitments and reproducible deterministic evaluation. | RouteGuard differentiator | Auction commitments + HCS envelopes + deterministic ranking | Auction + final-demo + HCS tests | Plan, README, dry-run, Winning Demo report |

## Fee separation notes

- Challenge-stated network transfer costs are **application economics metadata**.
- They are **not** x402 protocol challenge fields.
- They are **not** deducted from the carrier reservation payment.
- HBAR tinybars and USD network fees are **never** summed into one unit.

## Differentiator (exact wording)

Private off-chain bids with salted, consensus-timestamped HCS commitments and
reproducible deterministic evaluation.
