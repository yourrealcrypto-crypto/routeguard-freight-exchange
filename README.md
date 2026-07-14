# RouteGuard Freight Exchange

**Software-to-software freight-capacity reservation through x402 and Hedera.**

Carrier systems submit signed freight-capacity bids. Hedera Consensus Service establishes the authoritative bidding window. RouteGuard deterministically selects the winning qualified offer. Shipper software accepts it through x402 in USDC or HBAR, and confirmed settlement creates the operational route reservation.

## Current status

Initial implementation shell.

No live payment is enabled yet.

## Target network

Hedera Testnet only.

## Master specification

The authoritative implementation specification is:

`RouteGuard_Freight_Exchange_Final_Project_Plan_v1.5.md`