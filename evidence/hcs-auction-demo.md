# RouteGuard HCS Auction Demo Evidence

**Status:** SUCCESS
**Generated:** 2026-07-15T18:58:18.974Z

## Summary

The full bids remained private. HCS contains only hashes and public evidence references. Mirror Node consensus order and timestamps determine timeliness.

No HBAR or USDC payment was executed. No token association was executed.

## Network & Topic

| Field | Value |
| --- | --- |
| Network | hedera:testnet |
| Run ID | hcs-demo-1784141815865-c8b3e38a |
| Topic ID | 0.0.9587459 |
| Topic create tx | 0.0.9197513@1784141808.133452179 |
| Topic memo | RouteGuard Freight Exchange Phase 5 HCS auction demo |
| HashScan topic | https://hashscan.io/testnet/topic/0.0.9587459 |
| HashScan topic-create | https://hashscan.io/testnet/transaction/0.0.9197513@1784141808.133452179 |
| Operator public-key match | PASS |
| Messages submitted | 4 |

## Tender

| Field | Value |
| --- | --- |
| Tender ID | tender-ham-ist-hcs-c8b3e38a |
| Version | 1 |
| Tender hash | sha256:4f15fd82ad0237eef84f1ab1f2b70f7b6f94bd17b8608bc94ca805a4d382c55f |
| Auction ends at | 2026-07-15T18:58:10.865Z |
| Engine | routeguard-auction-1.0 |
| Policy | LOWEST_QUALIFIED_PRICE_V1 |
| Rules hash | sha256:51274182eb41071ddee80950a4fd3416b1453faa48486eb6e71f7780eba7c571 |

## HCS Messages

### AUCTION_OPEN (open)

| Field | Value |
| --- | --- |
| Envelope hash | sha256:b442130145fa6f33647b362de296081f11d64ce05ff33e310c918c34b4f344a0 |
| Transaction ID | 0.0.9197513@1784141813.573718714 |
| Sequence | 1 |
| Consensus timestamp | 2026-07-15T18:57:01.181811722Z |
| HashScan | https://hashscan.io/testnet/transaction/0.0.9197513@1784141813.573718714 |

### BID_COMMITMENT (commitmentA)

| Field | Value |
| --- | --- |
| Envelope hash | sha256:9a2ff0618e93060ffb29ce09c9e9552a8338e624fc1f5b47960ef27a44d2f128 |
| Transaction ID | 0.0.9197513@1784141818.206393084 |
| Sequence | 2 |
| Consensus timestamp | 2026-07-15T18:57:05.556924104Z |
| HashScan | https://hashscan.io/testnet/transaction/0.0.9197513@1784141818.206393084 |

### BID_COMMITMENT (commitmentB)

| Field | Value |
| --- | --- |
| Envelope hash | sha256:c9746b7aa932382f7d3b7a6ee7d6af6efd7d8e68643ca62088bb13fe5e504db8 |
| Transaction ID | 0.0.9197513@1784141822.496758686 |
| Sequence | 3 |
| Consensus timestamp | 2026-07-15T18:57:10.421468801Z |
| HashScan | https://hashscan.io/testnet/transaction/0.0.9197513@1784141822.496758686 |

### AUCTION_CLOSE_BARRIER (barrier)

| Field | Value |
| --- | --- |
| Envelope hash | sha256:35deff931437088383f868d8ad91a5d8e840a7bdb88df695dd5adabac11e1655 |
| Transaction ID | 0.0.9197513@1784141892.323715892 |
| Sequence | 4 |
| Consensus timestamp | 2026-07-15T18:58:17.944297247Z |
| HashScan | https://hashscan.io/testnet/transaction/0.0.9197513@1784141892.323715892 |

## Barrier & Completeness

| Field | Value |
| --- | --- |
| Barrier ID | barrier-c8b3e38a |
| Barrier sequence | 4 |
| Barrier consensus | 2026-07-15T18:58:17.944297247Z |
| Sequence range | 1..4 |
| Observed sequences | 1, 2, 3, 4 |
| Completeness | true |
| Commitment count | 2 |
| Commitment envelope hashes | sha256:9a2ff0618e93060ffb29ce09c9e9552a8338e624fc1f5b47960ef27a44d2f128, sha256:c9746b7aa932382f7d3b7a6ee7d6af6efd7d8e68643ca62088bb13fe5e504db8 |

## Auction Outcome

| Field | Value |
| --- | --- |
| Reconciled bid IDs | bid-a-b3e38a, bid-b-b3e38a |
| Winner bid ID | bid-a-b3e38a |
| Winner bid hash | sha256:5864999e92f3cfa91605805209449d94e717f854981a1f3219b584c6c4b2635a |
| Winner carrier ID | carrier-alpha |
| Winner carrier account | 0.0.9215954 |
| evaluatedBidSetHash | sha256:6ea347e8fccd4f703b0b36cd524c506748030cc7d41393a81886074115785e23 |
| decisionManifestHash | sha256:2d4eb6abac3ea3924289996e31cae0804a9c021984bbbf829b0342d64dcba523 |
| Manifest verification | PASS |
| Closure proof | PASS |
| Final auction state | WINNER_SELECTED |
| Payments executed | 0 |
| Token associations | 0 |

## Timely Status

- `bid-a-b3e38a`: TIMELY @ 2026-07-15T18:57:05.556924104Z
- `bid-b-b3e38a`: TIMELY @ 2026-07-15T18:57:10.421468801Z
