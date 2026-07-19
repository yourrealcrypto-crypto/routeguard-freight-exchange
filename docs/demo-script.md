# Under-five-minute demo script (judge narration)

## Opening (≈30s)

RouteGuard is a software-to-software freight-capacity reservation system.
Carriers commit bids on Hedera Consensus Service. RouteGuard selects the
winning qualified offer deterministically. The shipper system pays a capacity
reservation fee through x402 on Hedera testnet.

## Why Hedera costs matter (≈20s)

> Hedera makes machine-scale payment viable because the challenge specifies a
> fixed $0.0001 cost for an HBAR transfer and $0.001 for a stablecoin transfer.

Show the asset selector:

- **USDC** — Challenge-stated Hedera transfer cost: **$0.001**
- **HBAR** — Challenge-stated Hedera transfer cost: **$0.0001**

Emphasize: the reservation payment paid to the carrier is a **separate**
economic amount from the challenge-stated network transfer cost.

## Auction + winner (≈60–90s)

1. Run offline dry-run: `npm run demo:final-auction`
2. Point to tender, two carrier commitments, close barrier, Decision Manifest.
3. Show winner selection is reproducible from HCS sequences 1–4.

## Payment + settlement (≈90s)

1. Selected rail (demo default: USDC).
2. Reservation payment amount (exact atomic amount to the carrier).
3. Challenge-stated fixed Hedera network transfer cost for that rail.
4. Settlement transaction ID after facilitator settle + Mirror SUCCESS.
5. Open HashScan for the payment transaction (live run only).

Narrate the payment summary lines separately:

- Carrier reservation payment
- Selected asset
- Hedera network transfer cost (challenge-stated)
- Facilitator fee status
- RouteGuard fee status
- Carrier-received amount (equals reservation payment; network cost not deducted)

## Reservation evidence (≈45s)

1. `ROUTE_RESERVED` HCS sequence 5
2. Signed shipper and carrier webhooks
3. Public evidence JSON/Markdown under `evidence/`

## Closing (≈20s)

Settlement precedes reservation. Wrong-recipient and amount mismatches fail
closed. Asset cannot switch after payment submission. Live execution requires
explicit owner flags — default mode is offline dry-run with zero network writes.
