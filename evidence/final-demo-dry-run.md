# Final Demo Dry-Run Evidence

## Disclosure

OFFLINE_DRY_RUN rehearsal only. All auction, carrier, topic, and payment identifiers in this evidence are deliberately synthetic and simulated for reproducibility. Zero network writes occurred: no Hedera topic was created, no HCS messages were submitted, and no payment was settled. These are not real testnet transactions and must not be treated as live HashScan evidence.

## Historical topic

Earlier exploratory Phase 5 auction run. Its private random commitment materials were not retained, so it is not used as the authority for the final reservation demonstration.

**Authority topic: `0.0.9700000` *(simulated — not a live network identifier)* — not 0.0.9587459.**

## Attempt

- Mode: `OFFLINE_DRY_RUN`
- Attempt ID: `final-demo-975bd106-a74c-4e7a-ac58-3f522c07cce1`
- Short ID: `2c07cce1`
- Final state: `DRY_RUN_COMPLETE`

## Topic

- Topic ID: `0.0.9700000` *(simulated — not a live network identifier)*
- Create tx: `0.0.9197513@1785170581.329987774` *(simulated — not a live network identifier)*
- Memo: `routeguard-final:2c07cce1`

## HCS sequences 1–5

| Seq | Label | Envelope hash | Consensus | Identifier class |
|-----|-------|---------------|-----------|------------------|
| 1 | AUCTION_OPEN | `sha256:39f48f047b2fdeb1b0b77a7031a939ff5672e43cd8221546ba23ef2c17ffc974` | `2026-07-27T16:43:01.290456789Z` | simulated |
| 2 | BID_COMMITMENT_ALPHA | `sha256:7883d620696fd6d1a519484d4f69802d0d16c3158e42034dbbcd2d3914be31a8` | `2026-07-27T16:43:01.410456789Z` | simulated |
| 3 | BID_COMMITMENT_BETA | `sha256:4ea2df6bb8e6948f8459c46dbdedf41966148e600bd80e8ce25c2eeee9125b47` | `2026-07-27T16:43:01.530456789Z` | simulated |
| 4 | AUCTION_CLOSE_BARRIER | `sha256:ce5bf44d1cb18ddee5eb801532a98a38bf50f2f95da69f7790e092fa1d9277eb` | `2026-07-27T16:48:06.241456789Z` | simulated |
| 5 | ROUTE_RESERVED | `sha256:f02643a5b641bb12424c32e369f913d76812c28be4a747f002498bbb17ed4493` | `2026-07-27T16:48:06.561456789Z` | simulated |

## Proof

- Winner: `carrier-alpha` / `bid-alpha-final-2c07cce1` / `0.0.9215954`
- winningBidHash: `sha256:c06d6ab0c8483866b6a3d4e0fc88ed54c5a168d7ed8d890fd61bed26bac67922`
- evaluatedBidSetHash: `sha256:f5d863a43a5612af7c4c4adad1103acfd1b6d11e919e9df26d6a727ae64fb497`
- decisionManifestHash: `sha256:f9bf350a73d64e3197f64b98735363547299bc7c21c3c565c3edead347e8becc`
- Reconciliation: `mirror:topic:0.0.9700000:1-4` *(simulated — not a live network identifier)*
- Barrier consensus: `2026-07-27T16:48:06.241456789Z`
- Auction ends: `2026-07-27T16:48:01.120Z`

## Payment (ReservationService)

- Selected rail: `USDC`
- Carrier reservation payment: `10000` atomic of token `0.0.429274`
- Carrier-received amount: `10000` (network cost not deducted)
- Challenge-stated fixed Hedera network transfer cost: `$0.001` USD
- Facilitator fee: `NOT_MODELED_AS_SEPARATE_X402_CHARGE`
- RouteGuard platform fee: `NOT_MODELED_AS_SEPARATE_CHARGE`
- Payer `0.0.9197513` → receiver `0.0.9215954`
- Tx: `0.0.9197513@1785170886.100000000` *(simulated — not a live network identifier)*
- Consensus: `2026-07-27T16:48:06.441456789Z`
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
- Record hash: `sha256:9155fb129ee0bd83ca6ed72a4a787518f560fae90fcae1de3070db50c7684a54`

## Webhooks

- `evt-route-reserved-reservation-final-2c07cce1-shipper` hash `sha256:8f37c4fccfc63161126d8829a775814121e8824b766308cf8f91e3aaff6a9127`
- `evt-route-reserved-reservation-final-2c07cce1-carrier` hash `sha256:b2fcb6ad3ccc4f93bec865d8e86d9266bd739cd7876b1ec99a869e2eca825bc4`

## Network writes

Real network: **false** — zero network writes (topicCreates/hcs/payments counts below are local mock counters only).
Counts: topicCreates=1, hcs=5, payments=1
Simulated identifiers only — no HashScan links are published for dry-run evidence.

## Attribution

RouteGuard is an independent open-source project built on the Hedera testnet. It is not affiliated with, sponsored by, or endorsed by Hedera Hashgraph, LLC.
