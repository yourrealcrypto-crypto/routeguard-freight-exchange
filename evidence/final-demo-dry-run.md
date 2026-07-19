# Final Demo Dry-Run Evidence

## Disclosure

All auction and carrier data in this final demonstration is deliberately synthetic and publicly disclosed for reproducibility. The Hedera payment and consensus transactions are real testnet transactions.

## Historical topic

Earlier exploratory Phase 5 auction run. Its private random commitment materials were not retained, so it is not used as the authority for the final reservation demonstration.

**Authority topic: `0.0.9700000` — not 0.0.9587459.**

## Attempt

- Mode: `OFFLINE_DRY_RUN`
- Attempt ID: `final-demo-e6b63243-50a3-4bfc-a252-cdf2737b059f`
- Short ID: `737b059f`
- Final state: `DRY_RUN_COMPLETE`

## Topic

- Topic ID: `0.0.9700000`
- Create tx: `0.0.9197513@1784467215.715932329`
- Memo: `routeguard-final:737b059f`

## HCS sequences 1–5

| Seq | Label | Envelope hash | Consensus |
|-----|-------|---------------|-----------|
| 1 | AUCTION_OPEN | `sha256:92f6051880383bc3ee4d20ee35d032c7768db85598893c136d6da351a2f6a579` | `2026-07-19T13:20:15.454456789Z` |
| 2 | BID_COMMITMENT_ALPHA | `sha256:7ac89d2c18f6de47ce6745bd3adaa1b92ee94a58aeea33b4672e6d21b6e4cb60` | `2026-07-19T13:20:15.574456789Z` |
| 3 | BID_COMMITMENT_BETA | `sha256:5798a6baef9882fa4f78d77ec73dd3ad43f4c75825690a825582e0a6becc46d6` | `2026-07-19T13:20:15.694456789Z` |
| 4 | AUCTION_CLOSE_BARRIER | `sha256:660ece564957fd05ffcb5cca71ffb64595aef65ac2f2461ef80f52ab695a227b` | `2026-07-19T13:25:20.405456789Z` |
| 5 | ROUTE_RESERVED | `sha256:9143c366600c547e8a5d8d52e34d21c0731a3b53650ab32c84ff48a33a814b4c` | `2026-07-19T13:25:20.725456789Z` |

## Proof

- Winner: `carrier-alpha` / `bid-alpha-final-737b059f` / `0.0.9215954`
- winningBidHash: `sha256:2b8e364115f1e0353bf38081610667aa0728066a2d8a87d1e6c292565c603694`
- evaluatedBidSetHash: `sha256:5e74d53e2fd0f12960e927de3a40b38c9824f6b0c867c2d0b9c026962342e48b`
- decisionManifestHash: `sha256:aa74f3eb7bc21b616e07a23ded0babed324cab1b5ba6e5942c18b04e4b2c2577`
- Reconciliation: `mirror:topic:0.0.9700000:1-4`
- Barrier consensus: `2026-07-19T13:25:20.405456789Z`
- Auction ends: `2026-07-19T13:25:15.284Z`

## Payment (ReservationService)

- Selected rail: `USDC`
- Carrier reservation payment: `10000` atomic of token `0.0.429274`
- Carrier-received amount: `10000` (network cost not deducted)
- Challenge-stated fixed Hedera network transfer cost: `$0.001` USD
- Facilitator fee: `NOT_MODELED_AS_SEPARATE_X402_CHARGE`
- RouteGuard platform fee: `NOT_MODELED_AS_SEPARATE_CHARGE`
- Payer `0.0.9197513` → receiver `0.0.9215954`
- Tx: `0.0.9197513@1784467520.555000000`
- Consensus: `2026-07-19T13:25:20.605456789Z`
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
- Byte count: 941 (limit 1024)
- Conservative budget: 949
- Record hash: `sha256:fbc2ac94cdf7c803c545f64c68441225413f6b908c7b02e51729042cbaf1bda6`

## Webhooks

- `evt-route-reserved-reservation-final-737b059f-shipper` hash `sha256:274e19e97b931e054089da6b4edb1085233ac07eeb9dc2f4ef2d3c5de2750fcb`
- `evt-route-reserved-reservation-final-737b059f-carrier` hash `sha256:fb3d9a813327d93e1ddafb83cb338b55ee68cd4fe202957eb422bbf9c6b51fbf`

## Network writes

Real network: **false**
Counts: topicCreates=1, hcs=5, payments=1
