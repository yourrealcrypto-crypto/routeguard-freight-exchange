# Final Demo Live Evidence

## Disclosure

All auction and carrier data in this final demonstration is deliberately synthetic and publicly disclosed for reproducibility. The Hedera payment and consensus transactions are real testnet transactions.

## Historical topic

Earlier exploratory Phase 5 auction run. Its private random commitment materials were not retained, so it is not used as the authority for the final reservation demonstration.

**Authority topic: `0.0.9794225` — not 0.0.9587459.**

## Attempt

- Mode: `LIVE_FINAL_DEMO`
- Attempt ID: `final-demo-bf7ea243-fdc0-4771-9553-befe8b73c264`
- Short ID: `8b73c264`
- Final state: `COMPLETED`

## Topic

- Topic ID: `0.0.9794225`
- Create tx: `0.0.9197513@1785171882.373802899`
- Memo: `routeguard-final:8b73c264`

## HCS sequences 1–5

| Seq | Label | Envelope hash | Consensus | Identifier class |
|-----|-------|---------------|-----------|------------------|
| 1 | AUCTION_OPEN | `sha256:fbc7d5df65a775b59d95b00afbfe12206ef0b87ae297506557e3d0e1f65f05e0` | `2026-07-27T17:04:52.344786737Z` | live testnet |
| 2 | BID_COMMITMENT_ALPHA | `sha256:d31c6d1587e9f3b65cb7fd258a0b2e08cca8a20d148f0eea89198a4ece0b095a` | `2026-07-27T17:04:56.180326104Z` | live testnet |
| 3 | BID_COMMITMENT_BETA | `sha256:f827ec1721a140f2bc515108e20e14510a5e318bd41aeb11f4f5158c100a7eda` | `2026-07-27T17:05:01.726960104Z` | live testnet |
| 4 | AUCTION_CLOSE_BARRIER | `sha256:e24bb60e501513b58ffc3e36a32edaa1f6a517587ccb236988a49060eb5b30b6` | `2026-07-27T17:11:54.604991539Z` | live testnet |
| 5 | ROUTE_RESERVED | `sha256:b4c0a18896ac542929196df251b283702169104d90dbbca5d413adafac680035` | `2026-07-27T17:38:23.453477104Z` | live testnet |

## Proof

- Winner: `carrier-alpha` / `bid-alpha-final-8b73c264` / `0.0.9215954`
- winningBidHash: `sha256:17896569d821d0cafae5b1cbb304322166935713f04d6bbe6a2fe4785fe79827`
- evaluatedBidSetHash: `sha256:5138d1c09bb513a7304c649482da7b9b68494994a2aa1bda21ee70f526c4d6b3`
- decisionManifestHash: `sha256:1f0e40ccb0a14673f70565ed339473baacb5a8dd635546e6e5e7baaab1710425`
- Reconciliation: `mirror:topic:0.0.9794225:1-4`
- Barrier consensus: `2026-07-27T17:11:54.604991539Z`
- Auction ends: `2026-07-27T17:11:48.786Z`

## Payment (ReservationService)

- Selected rail: `USDC`
- Carrier reservation payment: `10000` atomic of token `0.0.429274`
- Carrier-received amount: `10000` (network cost not deducted)
- Challenge-stated fixed Hedera network transfer cost: `$0.001` USD
- Facilitator fee: `NOT_MODELED_AS_SEPARATE_X402_CHARGE`
- RouteGuard platform fee: `NOT_MODELED_AS_SEPARATE_CHARGE`
- Payer `0.0.9197513` → receiver `0.0.9215954`
- Tx: `0.0.7162784@1785173890.867086556`
- Consensus: `2026-07-27T17:38:16.977444275Z`
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
- Record hash: `sha256:b8908c9ab19127461ab7830ee6b57105b0d9e052247d101726c5dccf98586d06`

## Webhooks

- `evt-route-reserved-reservation-final-8b73c264-shipper` hash `sha256:2932ccae6b1c1714af799ab6e4137cc4221725fd80348efebabbcb11e0c9fc20`
- `evt-route-reserved-reservation-final-8b73c264-carrier` hash `sha256:28241a84557b6920e6d49d1b30fcab13e6817affd9d2dbadb96d06c326477d52`

## Network writes

Real network: **true**
Counts: topicCreates=0, hcs=1, payments=1

## Attribution

RouteGuard is an independent open-source project built on the Hedera testnet. It is not affiliated with, sponsored by, or endorsed by Hedera Hashgraph, LLC.
