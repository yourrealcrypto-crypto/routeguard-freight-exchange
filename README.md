# RouteGuard Freight Exchange

**Software-to-software freight-capacity reservation through x402 and Hedera.**

Carrier systems submit signed freight-capacity bids. Hedera Consensus Service establishes the authoritative bidding window. RouteGuard deterministically selects the winning qualified offer. Shipper software accepts it through x402 in USDC or HBAR, and confirmed settlement creates the operational route reservation.

## Current status

Core auction, HCS evidence, dual-asset reservation, shared final-demo orchestration, offline dry-run, the **completed live final demonstration**, and the production web experience are implemented.

### Production experience (v0.13.0)

The Hono service now serves the React/Vite product and API from one origin:

- `/` product narrative and completed outcome;
- `/proof` authoritative public proof registry and HashScan links;
- `/control` immutable replay, zero-write simulation, and guarded testnet control;
- `/operations-demo` permanent redirect to `/control`;
- `/judge` manual judge walkthrough;
- `/pod-review` encrypted POD, signature, advisory, and HCS chronology review;
- `/health` fast service health JSON.

The default control mode fetches the immutable completed proof without creating a
session. The local simulation uses the production state machine, emits only
`sim:` transaction references, and reports zero network writes. Controlled
testnet mode is visibly disabled unless the server capability and a session-only
operator authorization are both present; signers and Hedera submission stay on
the server, credentials are never persisted in the browser, and failures never
fall back to simulation.

```bash
npm install
npm run build
npm run start
# open http://localhost:3000
```

Railway uses the root Dockerfile, one service and one replica, health check
`/health`, `PORT`, and one persistent volume mounted at `/data`. Keep
`ROUTEGUARD_OPERATIONS_LIVE_ENABLED=false` for the public product unless a
separately supervised testnet session is explicitly authorized.

The Operations Demo backend now provides immutable completed-proof replay,
restart-safe local UI simulation, and a guarded server-only Hedera testnet boundary.
Dedicated reusable infrastructure is live on testnet (escrow `0.0.9865209`, topic
`0.0.9865212`) but public LIVE remains disabled by default. See
[`docs/operations-demo-backend.md`](docs/operations-demo-backend.md) for the API,
SSE, persistence, fixed economics, 12-write plan, and Railway one-replica contract.
Its successful operator lifecycle is funded-first: fund escrow, activate the
tender, accept the offer, allocate the winner, process POD and advisory review,
accept POD, then release freight.

Live final demonstration is **guarded** (multiple independent env flags + confirmation phrase + production transports). Default CLI modes perform **zero** network writes. **No further live Hedera execution should be performed** for this submission; the successful live proof is already recorded.

### Live proof (Hedera testnet — completed 2026-07-27)

| Fact | Value |
| --- | --- |
| Mode | `LIVE_FINAL_DEMO` |
| HCS topic | `0.0.9794225` |
| Payment transaction | `0.0.7162784@1785173890.867086556` |
| Payer | `0.0.9197513` |
| Receiver (carrier-alpha) | `0.0.9215954` |
| Token / amount | `0.0.429274` · **10000** atomic USDC (0.01 USDC) |
| HCS | Sequences **1–5** complete; sequence 5 = `ROUTE_RESERVED` |
| Ordering | **Settlement precedes reservation** (payment consensus `2026-07-27T17:38:16.977444275Z` → ROUTE_RESERVED `2026-07-27T17:38:23.453477104Z`) |
| Facilitator settle (this live execution) | **exactly 1** |

**HashScan (testnet):**

- Topic: https://hashscan.io/testnet/topic/0.0.9794225
- Payment: https://hashscan.io/testnet/transaction/0.0.7162784@1785173890.867086556
- Mirror topic messages: https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.9794225/messages

Sequence 5 `ROUTE_RESERVED` embeds the payment transaction ID and payment consensus timestamp in its HCS payload. Therefore, settlement-before-reservation can be verified directly from topic `0.0.9794225` without trusting the generated report.

The live execution resumed once from durable pre-submission state after a fail-closed canonical-hashing rejection. It reused the same topic and confirmed sequences 1–4, then produced exactly one payment and one `ROUTE_RESERVED`. Technical details: `PROJECT_STATUS.md` v0.4.2.

**Disclosures:** Demo carrier identities and auction business data are **synthetic** for reproducibility. Hedera testnet consensus messages and the USDC settlement transaction are **real**. This is a private, **commitment-based** auction (not a sealed-bid auction on-chain).

**Open the generated Winning Demo report:**

```bash
npm run report:final-demo
# then open: evidence/final-demo-report.html
```

Authoritative live evidence: `evidence/final-demo-result.json`, `evidence/final-demo-result.md`, `evidence/final-demo-live-attempt.json`, `evidence/final-demo-live-reservation-record.json` (verbatim copy of the completed reservation record).

### Two payment surfaces (do not conflate)

| Surface | What it proves | Evidence |
| --- | --- | --- |
| **A. Canonical protocol-level HTTP 402 handshake** | Official `@x402/hono` middleware; initial HTTP **402** → client retries with signed x402 payment payload → final HTTP **200**; live payment `0.0.7162784@1784141033.517654222`; transaction identity matched; Mirror **SUCCESS**; exactly **one** settlement | `evidence/usdc-smoke-payment.json`, `evidence/usdc-smoke-payment.md` |
| **B. Final freight-reservation orchestration** | Reuses x402 v2 `exact` payment objects and facilitator verify/settle, then publishes `ROUTE_RESERVED` only after Mirror-confirmed settlement | `evidence/final-demo-result.json`, topic `0.0.9794225` seq 5 |

Do **not** imply that the freight reservation endpoint itself returned HTTP 402 if the challenge was returned in a JSON response. Wire-level HTTP 402 is surface A.

### Fail-closed guarantees — verified by automated tests

| Guarantee | Tests | Live final demo |
| --- | --- | --- |
| Wrong recipient blocked before signature | `test/reservation-payment-verifier.test.ts`, `test/reservation-challenge-binding.test.ts`, `test/usdc-smoke-client.test.ts` | Not re-run as a live attack |
| Duplicate retry settles at most once | `test/reservation-settle-claim.test.ts`, `test/reservation-adversarial.test.ts`, `test/final-demo.test.ts` | This live execution recorded **exactly one** facilitator settle call |
| Failed settlement → no `ROUTE_RESERVED` | `test/reservation-service.test.ts`, `test/reservation-conclusive-failure.test.ts`, `test/phase6b-live-reservation.test.ts` | Live path published seq 5 only after Mirror SUCCESS |

### Final demonstration (Phase 6B.3 / 6B.4)

```bash
npm run demo:final-auction   # OFFLINE_DRY_RUN by default — do not re-run live
npm run report:final-demo    # regenerate static HTML from existing evidence (no network writes)
npm run check:secrets        # fail closed on private-key fields in public paths
```

Public synthetic template: `demo/fixtures/final-auction-template.json`.

**Historical HCS topic `0.0.9587459`:** earlier exploratory Phase 5 auction run. Its private random commitment materials were not retained, so it is not used as the authority for the final reservation demonstration. The authoritative live topic is **`0.0.9794225`** with sequences 1–5.

All auction and carrier data in the final demonstration is deliberately synthetic and publicly disclosed for reproducibility. Hedera payment and consensus transactions on the live proof are real testnet transactions. Offline dry-run evidence is rehearsal-only (zero network writes) and must not be read as live HashScan proof.

<details>
<summary>Technical scope</summary>

- RouteGuard currently evaluates private off-chain bid contents and anchors salted commitments on HCS.
- Hedera consensus and local durable state use guarded recovery for eventual consistency.

</details>

**RouteGuard is an independent open-source project built on the Hedera testnet. It is not affiliated with, sponsored by, or endorsed by Hedera Hashgraph, LLC.**

## License

ISC — see root `LICENSE` (Copyright 2026 RouteGuard).

## Target network

Hedera Testnet only.

## Master specification

The authoritative implementation specification is:

`RouteGuard_Freight_Exchange_Final_Project_Plan_v1.5.md`

Frozen architecture decisions are also recorded in `docs/ADR-001-frozen-architecture.md`.

Challenge requirement-to-proof mapping: `docs/challenge-compliance-matrix.md`.

Under-five-minute demo script: `docs/demo-script.md`.

## Why Hedera: Fixed and Predictable Machine-Payment Costs

The official Hedera x402 challenge states fixed and predictable transfer costs:

| Rail | Challenge-stated transfer cost |
| --- | --- |
| HBAR | $0.0001 |
| Stablecoin / HTS | $0.001 |

These exact amounts are binding RouteGuard submission requirements. They are **not** vague claims such as “low cost,” “cheap,” “near zero,” or “sub-cent.”

Predictable per-transfer cost matters for software-to-software and per-use commerce: autonomous shipper and carrier systems can budget each reservation payment without human negotiation of gas, without unpredictable fee spikes, and without rewriting payment logic between runs.

### Separate economic amounts

The **reservation payment** is a separate economic amount paid to the carrier for removing capacity from inventory and holding the transport window. It is not the freight invoice and it is not the Hedera network transfer cost.

RouteGuard keeps these concepts distinct:

1. Reservation payment amount (carrier-bound x402 exact amount)
2. Reservation payment asset (`USDC` / `HBAR`)
3. Challenge-stated fixed Hedera network transfer cost (`$0.0001` / `$0.001`)
4. Facilitator fee status (not modeled as a separate x402 charge line)
5. RouteGuard platform fee status (not modeled as a separate charge)
6. Amount received by the carrier (equals the reservation payment; network cost is **not** deducted)

HBAR payment amounts remain denominated in HBAR/tinybars. A USD network-fee value is never added to an HBAR amount as a same-unit total. For USDC, the reservation amount remains separate from the `$0.001` transfer cost even when a USD-equivalent summary is shown.

Source of truth in code: `src/domain/hedera-transfer-costs.ts` and `src/domain/payment-economics.ts`.

## Architecture (frozen)

- x402 v2
- `exact` scheme
- `hedera:testnet`
- Hosted Blocky402 testnet facilitator
- USDC primary demo rail; HBAR secondary supported rail
- HCS commitments and reservation evidence
- Settlement before reservation
- Deterministic TypeScript; no LLM in the trust-critical path
- No Hedera Agent Kit in the core; no Solidity auction; no EVM payment path
- No Scheduled Transaction escrow; no full freight-invoice settlement through x402
- No automatic asset fallback after payment submission

## Scripts

| Script | Purpose |
| --- | --- |
| `npm test` | Offline automated tests |
| `npm run typecheck` | TypeScript `--noEmit` |
| `npm run preflight` | Facilitator / config preflight |
| `npm run smoke:hbar` | Guarded HBAR smoke client |
| `npm run smoke:usdc` | Guarded USDC smoke client |
| `npm run demo:final-auction` | Final demo (dry-run by default) |
| `npm run report:final-demo` | Render static Winning Demo HTML from evidence JSON |
| `npm run verify` | Typecheck + tests + secrets + dry demo + evidence checks |
| `npm run check:secrets` | Fail closed on private-key fields in public paths |
