# Challenge compliance matrix

Requirement-to-proof mapping for the Hedera x402 bounty submission.

Authority order: official bounty wording → frozen plan v1.5 (README pointer) /
available plan v1.4 → current repository architecture → tests and live evidence.

| Requirement | Implementation location | Automated test | Live / demo evidence |
| --- | --- | --- | --- |
| x402 through HTTP 402 | `src/x402/*`, `src/reservation/challenge.ts`, smoke routes | `test/hbar-smoke-client.test.ts`, `test/usdc-smoke-route.test.ts`, reservation challenge tests | `evidence/hbar-smoke-payment.*`, `evidence/usdc-smoke-payment.*` |
| x402 v2 | `CHALLENGE_X402_VERSION = 2`, smoke clients | Challenge binding + smoke client tests | Live smoke evidence JSON (`x402Version: 2`) |
| exact scheme | `RESERVATION_SCHEME = "exact"`, `@x402/hedera/exact` | Offer/challenge/schema tests | Facilitator `/supported` + smoke evidence |
| hedera:testnet | `RESERVATION_NETWORK`, config | Domain/schema tests | HashScan testnet links in smoke evidence |
| Native HBAR support | `HBAR_RESERVATION_OPTION`, HBAR smoke path | `test/hbar-smoke-client.test.ts`, dual-asset reservation tests | `evidence/hbar-smoke-payment.md` |
| USDC / HTS support | `USDC_RESERVATION_OPTION`, USDC smoke path | `test/usdc-smoke-*.test.ts` | `evidence/usdc-smoke-payment.md` |
| HBAR transfer cost $0.0001 | `src/domain/hedera-transfer-costs.ts` (`HBAR.networkFeeUsd`) | `test/hedera-transfer-costs.test.ts`, compliance tests | README table; demo CLI; UI selector; dry-run evidence |
| Stablecoin transfer cost $0.001 | `src/domain/hedera-transfer-costs.ts` (`HTS_STABLECOIN.networkFeeUsd`) | `test/hedera-transfer-costs.test.ts`, compliance tests | README table; demo CLI; UI selector; dry-run evidence |
| Software-to-software payment | Shipper client + resource server; no wallet checkout | Reservation + smoke client tests | Demo script + final-demo dry-run |
| Real testnet settlement | Guarded live smoke / final-demo paths | Offline settlement-first tests; live evidence files | HashScan links in smoke evidence (owner-guarded live runs) |
| HashScan evidence | Smoke / demo evidence exporters | Evidence content tests where present | `evidence/*-smoke-payment.md` |
| HCS evidence | `src/hcs/*`, auction + reservation ROUTE_RESERVED | HCS reconciliation + final-demo tests | `evidence/hcs-auction-demo.*`, final-demo dry-run |
| Settlement before reservation | `ReservationService` + state machine | Reservation hardening / service tests | Live reservation evidence when executed |
| Idempotency | Settle claim CAS, attempt store, webhook/HCS outbox | Reservation adversarial + settle-claim tests | Attempt records under `data/` / `evidence/` |
| Wrong-recipient prevention | Payment verifier `payTo` binding | `test/reservation-payment-verifier.test.ts`, hardening tests | Negative-path offline tests |

## Fee separation notes

- Challenge-stated network transfer costs are **application economics metadata**.
- They are **not** x402 protocol challenge fields.
- They are **not** deducted from the carrier reservation payment.
- HBAR tinybars and USD network fees are **never** summed into one unit.
