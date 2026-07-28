# Final Demo Dry-Run Evidence

## Disclosure

OFFLINE_DRY_RUN rehearsal only. All auction, carrier, topic, and payment identifiers in this evidence are deliberately synthetic and simulated for reproducibility. Zero network writes occurred: no Hedera topic was created, no HCS messages were submitted, and no payment was settled. These are not real testnet transactions and must not be treated as live HashScan evidence.

## Historical topic

Earlier exploratory Phase 5 auction run. Its private random commitment materials were not retained, so it is not used as the authority for the final reservation demonstration.

**Authority topic: `0.0.9700000` *(simulated — not a live network identifier)* — not 0.0.9587459.**

## Attempt

- Mode: `OFFLINE_DRY_RUN`
- Attempt ID: `final-demo-cf113f94-6ca7-46fc-946a-962038b225cd`
- Short ID: `38b225cd`
- Final state: `DRY_RUN_COMPLETE`

## Topic

- Topic ID: `0.0.9700000` *(simulated — not a live network identifier)*
- Create tx: `0.0.9197513@1785171820.170035154` *(simulated — not a live network identifier)*
- Memo: `routeguard-final:38b225cd`

## HCS sequences 1–5

| Seq | Label | Envelope hash | Consensus | Identifier class |
|-----|-------|---------------|-----------|------------------|
| 1 | AUCTION_OPEN | `sha256:ec52bc1c408db9b152c1f5e8353bf21f88c86f51720e3c45e200c7a9ace0fc5a` | `2026-07-27T17:03:40.737456789Z` | simulated |
| 2 | BID_COMMITMENT_ALPHA | `sha256:da28336258f2e88eb60c79b2b5c4ac0f85ebd3d63bfeba63f89b6aa4ebcd2340` | `2026-07-27T17:03:40.857456789Z` | simulated |
| 3 | BID_COMMITMENT_BETA | `sha256:b2a0f12689cff5b560c35d9403a377920e49ad6ce7f85300d0d9f4368f82bc5d` | `2026-07-27T17:03:40.977456789Z` | simulated |
| 4 | AUCTION_CLOSE_BARRIER | `sha256:606936e458832f2b05e7117961a62505fb7c803fb345237e74369ea34eb8b5fa` | `2026-07-27T17:08:45.688456789Z` | simulated |
| 5 | ROUTE_RESERVED | `sha256:46191ad127f71a96cfb49597da700ab61d45c0cb6d40848b77fa90456d251271` | `2026-07-27T17:08:46.008456789Z` | simulated |

## Proof

- Winner: `carrier-alpha` / `bid-alpha-final-38b225cd` / `0.0.9215954`
- winningBidHash: `sha256:d38b05e8f315e868cbc2fa9e0be6d8ff14f577550c0d7734e10b77f7d1db89b2`
- evaluatedBidSetHash: `sha256:75fbebda224253bef1397d21052dbdf182caa5dece50b0fbad44b9280ba37055`
- decisionManifestHash: `sha256:f22195b7157639f25278cf9fbc105e9b10087c9dcc9c232be2f084df500cf2ea`
- Reconciliation: `mirror:topic:0.0.9700000:1-4` *(simulated — not a live network identifier)*
- Barrier consensus: `2026-07-27T17:08:45.688456789Z`
- Auction ends: `2026-07-27T17:08:40.567Z`

## Payment (ReservationService)

- Selected rail: `USDC`
- Carrier reservation payment: `10000` atomic of token `0.0.429274`
- Carrier-received amount: `10000` (network cost not deducted)
- Challenge-stated fixed Hedera network transfer cost: `$0.001` USD
- Facilitator fee: `NOT_MODELED_AS_SEPARATE_X402_CHARGE`
- RouteGuard platform fee: `NOT_MODELED_AS_SEPARATE_CHARGE`
- Payer `0.0.9197513` → receiver `0.0.9215954`
- Tx: `0.0.9197513@1785172125.100000000` *(simulated — not a live network identifier)*
- Consensus: `2026-07-27T17:08:45.888456789Z`
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
- Record hash: `sha256:816783e60c24cf81d8c6d63cf12a88c9a924908f5fcf230c00255cecd72b6fd6`

## Webhooks

- `evt-route-reserved-reservation-final-38b225cd-shipper` hash `sha256:cbf339b983e8cfde8c6285e242bdc274e8fdb5c562ffa190d3e5def3e9d51f67`
- `evt-route-reserved-reservation-final-38b225cd-carrier` hash `sha256:6da778ecfd11572f475e2a8130ec66ab49e60cedd6f71d837b345f92ed426fe9`

## Network writes

Real network: **false** — zero network writes (topicCreates/hcs/payments counts below are local mock counters only).
Counts: topicCreates=1, hcs=5, payments=1
Simulated identifiers only — no HashScan links are published for dry-run evidence.

## Attribution

RouteGuard is an independent open-source project built on the Hedera testnet. It is not affiliated with, sponsored by, or endorsed by Hedera Hashgraph, LLC.
