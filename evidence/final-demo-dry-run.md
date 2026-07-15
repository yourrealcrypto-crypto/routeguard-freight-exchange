# Final Demo Dry-Run Evidence

## Disclosure

All auction and carrier data in this final demonstration is deliberately synthetic and publicly disclosed for reproducibility. The Hedera payment and consensus transactions are real testnet transactions.

## Historical topic

Earlier exploratory Phase 5 auction run. Its private random commitment materials were not retained, so it is not used as the authority for the final reservation demonstration.

**This dry-run used synthetic topic `0.0.9700000` — not 0.0.9587459.**

## Attempt

- Mode: `OFFLINE_DRY_RUN`
- Attempt ID: `final-demo-dab230d0-fcfb-4cd3-8840-a055964b0d66`
- Short ID: `964b0d66`
- Final state: `COMPLETED`

## Auction materials

- Tender: `tender-final-964b0d66`
- Bid alpha: `bid-alpha-final-964b0d66`
- Bid beta: `bid-beta-final-964b0d66`
- Reservation: `reservation-final-964b0d66`
- Tender hash: `sha256:b794ff492cd963c097fe22f4aa6ef65a4a70e725d37e7c779494897e6510c20b`
- Auction ends: `2026-07-15T23:07:33.967Z`

## Topic

- Topic ID: `0.0.9700000`
- Create tx: `0.0.9197513@1784156764.365125942`
- Memo: `routeguard-final:964b0d66`

## HCS sequences 1–5

| Seq | Label | Envelope hash | Consensus |
|-----|-------|---------------|-----------|
| 1 | AUCTION_OPEN | `sha256:e568fc634d2f42fb42e79d6922a7f841109a945a5c98dea14d613e0cf97fcb47` | `2026-07-15T23:06:05.137456789Z` |
| 2 | BID_COMMITMENT_ALPHA | `sha256:a284b7cb9fd5f97812b7b9b85d1497ec77104dfdd116494b6ae876ed4adc73f0` | `2026-07-15T23:06:05.257456789Z` |
| 3 | BID_COMMITMENT_BETA | `sha256:14cc36ab3f1ebff1fe6de0086ec0990d731ad0b49efefe9ae8a0e3f2edb07efd` | `2026-07-15T23:06:05.377456789Z` |
| 4 | AUCTION_CLOSE_BARRIER | `sha256:a877f4625059748650bb440448d9209f330850c61f6767a149c048dd8edb4c54` | `2026-07-15T23:07:39.088456789Z` |
| 5 | ROUTE_RESERVED | `sha256:2e43e8e8376ccf691d4a216f95010f89182ff91a84ef3d1fc6c0091185a9778c` | `2026-07-15T23:07:39.408456789Z` |

## Proof

- Winner: `carrier-alpha` / `bid-alpha-final-964b0d66` / `0.0.9215954`
- winningBidHash: `sha256:9c7a31dea8d166fb35686ebaa19fd4f318d34681a355ddc725e465e6faedeaf5`
- evaluatedBidSetHash: `sha256:f4851ed212f653e444f83afbfdeb9fe79d3eff8633faef1c200b2fde232c842e`
- decisionManifestHash: `sha256:cbff923b5bd19eaf7fda2053a11e83c95531b0331d44e4ebb6e05dcac3a777e7`
- Reconciliation: `mirror:topic:0.0.9700000:1-4`
- Barrier consensus: `2026-07-15T23:07:39.088456789Z`

## Payment (simulated)

- USDC only: token `0.0.429274` amount `10000`
- Payer `0.0.9197513` → receiver `0.0.9215954`
- Tx: `0.0.9197513@1784156859.555000000`

## ROUTE_RESERVED

- Sequence: 5
- Byte count: 941 (limit 1024)
- Conservative budget: 949
- Record hash: `sha256:50998595c77a5e7b40a6308051ec8ef240f2e3268b504984346e68903bd4e622`

## Network writes

Real network writes: **none** (mocked transports only).
Simulated: 1 topic create, 5 HCS submits, 1 payment.
