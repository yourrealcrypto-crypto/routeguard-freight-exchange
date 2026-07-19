# Final Demo Dry-Run Evidence

## Disclosure

OFFLINE_DRY_RUN rehearsal only. All auction, carrier, topic, and payment identifiers in this evidence are deliberately synthetic and simulated for reproducibility. Zero network writes occurred: no Hedera topic was created, no HCS messages were submitted, and no payment was settled. These are not real testnet transactions and must not be treated as live HashScan evidence.

## Historical topic

Earlier exploratory Phase 5 auction run. Its private random commitment materials were not retained, so it is not used as the authority for the final reservation demonstration.

**Authority topic: `0.0.9700000` *(simulated — not a live network identifier)* — not 0.0.9587459.**

## Attempt

- Mode: `OFFLINE_DRY_RUN`
- Attempt ID: `final-demo-baef2fa5-940c-4e7f-94a6-6620e7212cfa`
- Short ID: `e7212cfa`
- Final state: `DRY_RUN_COMPLETE`

## Topic

- Topic ID: `0.0.9700000` *(simulated — not a live network identifier)*
- Create tx: `0.0.9197513@1784501363.793393635` *(simulated — not a live network identifier)*
- Memo: `routeguard-final:e7212cfa`

## HCS sequences 1–5

| Seq | Label | Envelope hash | Consensus | Identifier class |
|-----|-------|---------------|-----------|------------------|
| 1 | AUCTION_OPEN | `sha256:3aeb97208cf7b71232b461d927f8cc59c5557916c2699b2822e11a6d4643e3fd` | `2026-07-19T22:49:23.340456789Z` | simulated |
| 2 | BID_COMMITMENT_ALPHA | `sha256:9b993775c2b00ae5c60e5a8dd49205b4e0a909f60bd33bdcdb6967063570e34a` | `2026-07-19T22:49:23.460456789Z` | simulated |
| 3 | BID_COMMITMENT_BETA | `sha256:7dd41cbe8e20af44a8f02c001a37e53364d62330aacba916a01de57876c99f27` | `2026-07-19T22:49:23.580456789Z` | simulated |
| 4 | AUCTION_CLOSE_BARRIER | `sha256:8a0d055a16b557aa2f435c050f42867bd4cd516243bc441aaf39a940db242ee0` | `2026-07-19T22:54:28.291456789Z` | simulated |
| 5 | ROUTE_RESERVED | `sha256:5dfd31a70e84c79f428e3a61a0d9c6c47e3128876f50ea907b99c938f95995fd` | `2026-07-19T22:54:28.611456789Z` | simulated |

## Proof

- Winner: `carrier-alpha` / `bid-alpha-final-e7212cfa` / `0.0.9215954`
- winningBidHash: `sha256:f846225f2fd85ae32d36c554935b57c6c356d2dd14c0ec440bc3f7e9f2484e1a`
- evaluatedBidSetHash: `sha256:ad48bc3c6266f98570ea96312b9d01af2d5c9b099fe7de2f193bfa156fcb6bc4`
- decisionManifestHash: `sha256:8f210b9f64afd60a5f90bc05e6e0d09a49cefd8c6181a64ff432e88829b3095b`
- Reconciliation: `mirror:topic:0.0.9700000:1-4` *(simulated — not a live network identifier)*
- Barrier consensus: `2026-07-19T22:54:28.291456789Z`
- Auction ends: `2026-07-19T22:54:23.170Z`

## Payment (ReservationService)

- Selected rail: `USDC`
- Carrier reservation payment: `10000` atomic of token `0.0.429274`
- Carrier-received amount: `10000` (network cost not deducted)
- Challenge-stated fixed Hedera network transfer cost: `$0.001` USD
- Facilitator fee: `NOT_MODELED_AS_SEPARATE_X402_CHARGE`
- RouteGuard platform fee: `NOT_MODELED_AS_SEPARATE_CHARGE`
- Payer `0.0.9197513` → receiver `0.0.9215954`
- Tx: `0.0.9197513@1784501668.100000000` *(simulated — not a live network identifier)*
- Consensus: `2026-07-19T22:54:28.491456789Z`
- Settle count (process): 1

### Payment economics lines

- Carrier reservation payment: 0.01 USDC (10000 atomic; asset 0.0.429274)
- Selected asset / rail: USDC
- Challenge-stated fixed Hedera network transfer cost: $0.001 USD
- Facilitator fee: NOT_MODELED_AS_SEPARATE_X402_CHARGE
- RouteGuard platform fee: NOT_MODELED_AS_SEPARATE_CHARGE
- Carrier-received amount: 10000 atomic of 0.0.429274 (equals reservation payment; network transfer cost not deducted)
- Carrier reservation payment is 0.01 USDC (10000 atomic units). Challenge-stated fixed Hedera network transfer cost is $0.001 USD and is not deducted from the 0.01 USDC carrier payment.

## ROUTE_RESERVED

- Sequence: 5
- Byte count: 941 (strict limit: must be < 1024)
- Conservative budget: 949
- Record hash: `sha256:abcf344117f97babf93078c84fde650f64fdb20ca16ac1ad07830c709d5e9086`

## Webhooks

- `evt-route-reserved-reservation-final-e7212cfa-shipper` hash `sha256:747b4e87ac0ae408b3d62a1211477c5dbe83f2edc39cd1ae93e3e4b626390c95`
- `evt-route-reserved-reservation-final-e7212cfa-carrier` hash `sha256:47676e5256d926fa6c94c44f1b35704c0599adca953019381136733239537425`

## Network writes

Real network: **false** — zero network writes (topicCreates/hcs/payments counts below are local mock counters only).
Counts: topicCreates=1, hcs=5, payments=1
Simulated identifiers only — no HashScan links are published for dry-run evidence.

## Attribution

RouteGuard is an independent open-source project built on the Hedera testnet. It is not affiliated with, sponsored by, or endorsed by Hedera Hashgraph, LLC.
