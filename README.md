# RouteGuard Freight Exchange

**Software-to-software freight-capacity reservation through x402 and Hedera.**

Carrier systems submit signed freight-capacity bids. Hedera Consensus Service establishes the authoritative bidding window. RouteGuard deterministically selects the winning qualified offer. Shipper software accepts it through x402 in USDC or HBAR, and confirmed settlement creates the operational route reservation.

## Current status

Core auction, HCS evidence, dual-asset reservation, and final-demo dry-run are implemented offline.

Live final demonstration is **guarded** (multiple independent env flags + confirmation phrase). Default CLI modes perform **zero** network writes.

### Final demonstration (Phase 6B.2)

```bash
npm run demo:final-auction   # OFFLINE_DRY_RUN by default
npm run check:secrets        # fail closed on private-key fields in public paths
```

Public synthetic template: `demo/fixtures/final-auction-template.json`.

**Historical HCS topic `0.0.9587459`:** earlier exploratory Phase 5 auction run. Its private random commitment materials were not retained, so it is not used as the authority for the final reservation demonstration. The final live run creates a **new** HCS topic and sequences 1–5 on that topic only.

All auction and carrier data in the final demonstration is deliberately synthetic and publicly disclosed for reproducibility. Hedera payment and consensus transactions are real testnet transactions when executed live under full guards.

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
| `npm run check:secrets` | Fail closed on private-key fields in public paths |
