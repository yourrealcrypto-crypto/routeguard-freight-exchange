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