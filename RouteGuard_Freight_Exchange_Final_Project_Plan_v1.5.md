# RouteGuard Freight Exchange
## Final Comprehensive Project Plan v1.5 — Implementation Ready

**Status:** Cleared for implementation; all final-review patches integrated  
**Prepared:** 15 July 2026  
**Submission target:** Hedera x402 Bounty  
**Primary objective:** Deliver a working, verifiable, software-to-software freight-capacity reservation flow using x402 and Hedera testnet  
**Primary demo rail:** Hedera testnet USDC  
**Secondary supported rail:** Native HBAR  
**Project root:** `F:\Projects\RouteGuard\routeguard-freight-exchange`

---


# 0. Final review status

The constrained final review found no protocol blockers. All twelve required patches have been integrated into this version.

## Integrated HIGH patches

1. `transactionId` is mandatory before `PAYMENT_SUBMITTED`.
2. “Conclusively failed” is defined deterministically using the exact transaction ID and expiry window.
3. The trust-critical reservation route uses explicit x402 core server/facilitator APIs as the primary implementation.
4. A negative live-settlement test proves that failed settlement cannot create a reservation.

## Integrated MEDIUM patches

5. The close barrier must have a consensus timestamp at or after the auction deadline.
6. The Decision Manifest accounts for orphan commitments with `FULL_BID_MISSING`.
7. The one-route dual-asset experiment is timeboxed to 60 minutes.
8. Every HCS application message must be smaller than 1,024 bytes.
9. The demo topic has no submit key, and carrier HBAR funding is a preflight requirement.

## Integrated LOW patches

10. Carriers are instructed to commit at least 60 seconds before the deadline.
11. The alignment matrix distinguishes official criteria from project differentiators.
12. The inclusive deadline boundary receives an explicit unit test.

No additional architectural review is required unless a live integration test disproves a protocol or package assumption.

# 1. Executive decision

RouteGuard Freight Exchange is a **deterministic software-to-software freight-capacity marketplace**.

A shipper system publishes a structured freight tender. Carrier systems discover compatible tenders, submit signed private bids, and commit salted bid hashes to Hedera Consensus Service. HCS consensus timestamps establish which commitments arrived within the bidding window. RouteGuard evaluates the complete committed bid set using a fixed deterministic policy.

The shipper system accepts the winning carrier offer by paying a small capacity-reservation fee through x402 in either:

- Hedera testnet USDC; or
- Native HBAR.

The resource server defines both acceptable payment options. The shipper selects one exact seller-supported option. After confirmed Hedera settlement, RouteGuard creates the reservation, anchors the result to HCS, and notifies both operational systems through signed webhooks.

## Core statement

> **HCS establishes the authoritative bid window. RouteGuard deterministically selects the winning qualified offer. x402 payment expresses the shipper’s acceptance. Confirmed Hedera settlement reserves the capacity.**

---

# 2. Frozen architecture decisions

These decisions are binding unless a live integration test disproves an assumption.

1. Use **x402 protocol version 2**.
2. Use the Hedera **`exact`** scheme.
3. Use CAIP-2 network identifier **`hedera:testnet`**.
4. Use the hosted Blocky402 testnet facilitator initially.
5. Discover and validate facilitator capabilities at runtime through `/supported`.
6. Support **USDC and HBAR** as seller-defined payment options.
7. Use USDC as the main commercial demo rail.
8. Use HBAR as a native Hedera alternative, not as an automatic fallback after an uncertain USDC submission.
9. Use HCS for tender commitment, bid commitment timing, close-barrier evidence, winner evidence, and reservation evidence.
10. Keep full tenders and bids off-chain.
11. Use salted hashes for public bid commitments.
12. Use deterministic TypeScript policies and state machines.
13. Do not use an LLM in the trust-critical path.
14. Do not use Hedera Agent Kit in the core.
15. Do not use a Solidity auction contract.
16. Do not use Hedera Scheduled Transactions as escrow.
17. Do not settle the full freight invoice through x402.
18. Settle before creating or returning the protected reservation.
19. Persist the payment attempt before settlement.
20. Lock the selected payment asset after `PAYMENT_SUBMITTED`.
21. Implement application-level idempotency even if the optional official Payment Identifier extension is unavailable.
22. Do not claim auctioneer blindness, confidentiality from RouteGuard, atomic cross-system execution, or complete trustlessness.
23. Stop redesigning once implementation starts unless a live blocker appears.

---

# 3. Verified external facts and source-of-truth assumptions

## 3.1 Bounty requirements

The official bounty requires:

- A public open-source GitHub repository
- Real on-chain Hedera testnet transactions
- HashScan links
- A demo video under five minutes
- A completed submission form
- Submission before 11:59 PM ET on 19 July 2026

The judging criteria are:

1. Working end-to-end flow
2. Real on-chain payments through x402
3. Quality and depth of Hedera rail usage

The bounty explicitly allows HBAR or USDC.

**Source:**  
`https://hedera.com/x402-bounty/`

## 3.2 Live Blocky402 capabilities

As verified on 15 July 2026, the live testnet endpoint advertises:

```json
{
  "x402Version": 2,
  "scheme": "exact",
  "network": "hedera:testnet",
  "extra": {
    "feePayer": "0.0.7162784"
  }
}
```

The response currently advertises no facilitator extensions.

**Source:**  
`https://api.testnet.blocky402.com/supported`

The application must still verify this at startup. The saved result is evidence, not a permanent configuration guarantee.

## 3.3 Hedera x402 exact scheme

The official Hedera scheme specifies:

- `x402Version: 2`
- `hedera:testnet` and `hedera:mainnet`
- Native HBAR asset ID `0.0.0`
- HTS fungible-token support by token ID
- HBAR amounts in tinybars
- HTS amounts in token atomic units
- Facilitator as fee payer
- Direct partially signed `TransferTransaction`
- No `ScheduleCreate` wrapper
- Resource returned after confirmed settlement

**Source:**  
`https://docs.hedera.com/solutions/ai/x402`

## 3.4 Testnet USDC

Circle currently lists Hedera Testnet USDC as:

```text
0.0.429274
```

Testnet USDC has no real financial value.

**Source:**  
`https://developers.circle.com/stablecoins/usdc-contract-addresses`

The configured token ID must still pass live metadata and account-association checks.

## 3.5 Multiple accepted payment options

x402 seller route configuration supports an `accepts` array. The seller may advertise multiple acceptable terms; the buyer selects one of those terms without changing it.

**Source:**  
`https://docs.x402.org/getting-started/quickstart-for-sellers`

The installed Hedera package must be tested for two same-network assets. If that route configuration is awkward or unsupported, use two explicit seller-defined endpoints without changing the business model.

## 3.6 Payment Identifier

The official Payment Identifier extension allows a client to retry the same logical request without duplicate payment processing. The resource server remains responsible for caching, deduplication, and request binding.

**Source:**  
`https://docs.x402.org/extensions/payment-identifier`

The core safety design must not depend on facilitator extension support.

## 3.7 Reference implementation versions

The `matevszm/x402-hedera-example` repository currently pins:

- `@x402/core`: `2.16.0`
- `@x402/fetch`: `2.16.0`
- `@x402/hedera`: `2.16.0`
- `@x402/hono`: `2.16.0`

**Source:**  
`https://github.com/matevszm/x402-hedera-example`

The repository title’s “v1” describes its project iteration, not x402 protocol v1.

---

# 4. Product and commercial use case

A manufacturer needs to transport:

```text
Origin:              Hamburg
Destination:         Istanbul
Cargo:               12 pallets of electronics
Weight:              8,200 kg
Required equipment:  Curtainsider
Pickup window:       17 July, 08:00–16:00 UTC
Delivery deadline:   22 July, 16:00 UTC
Maximum freight:     €4,000
Auction deadline:    15 July, 18:00 UTC
```

The shipper’s transport-management software publishes a tender.

Carrier systems automatically evaluate:

- Lane compatibility
- Equipment availability
- Weight and cargo constraints
- Pickup feasibility
- Delivery feasibility
- Minimum commercial price
- Reservation-fee policy
- Auction validity

They submit signed bids.

After the bidding window closes, RouteGuard evaluates all timely committed bids, identifies the winning qualified bid, and exposes the capacity reservation as an x402-protected resource.

The shipper software pays the reservation fee programmatically. Successful settlement changes the operational state:

```text
CAPACITY_AVAILABLE
→ BID_SELECTED
→ PAYMENT_SETTLED
→ ROUTE_RESERVED
```

---

# 5. What the x402 payment purchases

The x402 payment purchases:

# **A confirmed freight-capacity reservation**

It does not settle the complete freight invoice.

Example:

| Commercial element | Example | Settlement method |
|---|---:|---|
| Freight service | €3,610 | Existing B2B contract/invoice process |
| Capacity reservation | 0.50 testnet USDC or fixed HBAR option | x402 on Hedera |
| Protected result | `ROUTE_RESERVED` record | Returned after settlement |

The reservation is a complete economic product. It compensates the carrier for:

- Removing capacity from available inventory
- Holding the pickup window
- Confirming the delivery commitment
- Creating a reservation in the carrier TMS
- Returning a machine-readable reservation
- Synchronizing shipper and carrier systems

## Required explanation for judges

> **The reservation fee is a complete economic transaction. The carrier is paid to remove capacity from inventory and hold the agreed transport window. It is not a symbolic blockchain deposit on the later freight invoice.**

---

# 6. System actors and trust boundaries

## 6.1 Shipper client

Deterministic software acting for the transport buyer.

Responsibilities:

- Create the tender
- Define hard requirements and deadline
- Receive the auction result
- Select a preferred seller-supported payment option
- Validate the `402` response
- Invoke the isolated signer only after validation
- Persist payment state
- Retrieve and import the reservation

The shipper client never invents or edits seller terms.

## 6.2 Carrier clients

Two independent deterministic demo carrier systems.

Responsibilities:

- Discover compatible tenders
- Build private signed bids
- Submit the full private bid to RouteGuard
- Receive RouteGuard’s bid-acceptance receipt
- Submit the salted bid commitment directly to HCS
- Receive a reservation event
- Mark capacity unavailable

Each carrier has:

- A unique `carrierId`
- A Hedera account
- A small testnet HBAR balance for its own HCS message fee
- A bid-signing key
- A registered public key
- Equipment/lane metadata
- A webhook receiver

## 6.3 RouteGuard Exchange

RouteGuard is:

- The marketplace API
- The deterministic auction operator
- The x402 resource server
- The payment-policy layer
- The local reservation state authority
- The HCS evidence publisher
- The webhook dispatcher

RouteGuard sees private bid contents. It is not blind to bids.

## 6.4 Blocky402 facilitator

The facilitator:

- Advertises capabilities
- Verifies the payment payload
- Validates transaction structure
- Adds its fee-payer signature
- Submits the transaction
- Returns the settlement result

The facilitator does not know the buyer’s full commercial intent. RouteGuard verifies that the challenge matches the winning bid and authorized reservation.

## 6.5 Hedera

Hedera provides:

- HTS USDC settlement
- Native HBAR settlement
- HCS consensus timestamps and message ordering
- Public transaction and topic evidence
- Mirror Node historical retrieval

## 6.6 External operational systems

For the demo:

- Shipper TMS receiver
- Carrier TMS receiver

They receive signed `route.reserved` events.

---

# 7. Security and trust claims

## 7.1 Claims we make

RouteGuard provides:

- Consensus-timestamped bid commitments
- Tamper-evident bid integrity after commitment
- Reproducible deterministic winner selection
- Exact pre-signature payment validation
- Settlement-before-reservation
- Application idempotency
- Recoverable payment/reservation state
- Public Hedera evidence
- Signed operational notifications

## 7.2 Claims we do not make

RouteGuard v1 does not provide:

- Auctioneer blindness
- Bid confidentiality from RouteGuard
- Prevention of all operator collusion
- Fully trustless freight contracting
- Atomic commit across Hedera and the local database
- Full legal freight-contract settlement
- Delivery or cargo-quality guarantees
- Privacy of Hedera payment accounts and amounts

## 7.3 Required auction wording

Use:

> **Private off-chain bids with salted, consensus-timestamped HCS commitments and reproducible deterministic evaluation.**

Do not use:

- “Sealed-bid auction” without qualification
- “Trustless auction”
- “Nobody can see bids”
- “HCS runs the auction”
- “Atomic payment and reservation”

---

# 8. Domain model

## 8.1 Tender

```ts
interface FreightTender {
  tenderId: string;
  shipperId: string;
  origin: string;
  destination: string;
  cargo: {
    type: string;
    weightKg: number;
    pallets: number;
    dangerousGoods: boolean;
  };
  requiredEquipment: string;
  pickupWindow: {
    earliest: string;
    latest: string;
  };
  deliveryDeadline: string;
  auctionEndsAt: string;
  maximumFreightPriceCents: number;
  selectionPolicy: "LOWEST_QUALIFIED_PRICE_V1";
  version: number;
}
```

Rules:

- UTC timestamps
- Integer money values
- Zod validation
- Canonical serialization before hashing
- A material edit creates a new tender version
- The tender cannot be silently changed after `TENDER_OPENED`

## 8.2 Carrier bid

```ts
interface CarrierBid {
  bidId: string;
  tenderId: string;
  carrierId: string;
  carrierAccountId: string;
  freightPriceCents: number;
  equipment: string;
  estimatedDelivery: string;
  capacityConfirmed: boolean;
  bidValidUntil: string;
  reservationPaymentOptions: PaymentOption[];
  commitmentSalt: string;
  nonce: string;
}
```

## 8.3 Payment option

```ts
interface PaymentOption {
  optionId: "USDC" | "HBAR";
  scheme: "exact";
  network: "hedera:testnet";
  asset: string;
  amountAtomic: string;
  payTo: string;
}
```

Example options:

```json
[
  {
    "optionId": "USDC",
    "scheme": "exact",
    "network": "hedera:testnet",
    "asset": "0.0.429274",
    "amountAtomic": "500000",
    "payTo": "0.0.CARRIER_D"
  },
  {
    "optionId": "HBAR",
    "scheme": "exact",
    "network": "hedera:testnet",
    "asset": "0.0.0",
    "amountAtomic": "100000000",
    "payTo": "0.0.CARRIER_D"
  }
]
```

These are independent fixed offers. RouteGuard does not perform live currency conversion.

## 8.4 Reservation

```ts
interface FreightReservation {
  reservationId: string;
  tenderId: string;
  winningBidId: string;
  shipperId: string;
  carrierId: string;
  status: "ROUTE_RESERVED";
  pickupWindow: {
    earliest: string;
    latest: string;
  };
  deliveryDeadline: string;
  freightPriceCents: number;
  payment: {
    network: "hedera:testnet";
    asset: string;
    amountAtomic: string;
    transactionId: string;
  };
  reservedAt: string;
}
```

---

# 9. Canonical hashing and signatures

Use deterministic canonical JSON.

Recommended approach:

- Sort object keys recursively
- Preserve array order
- Encode UTF-8
- Hash with SHA-256
- Represent hash as lowercase hex prefixed by `sha256:`

## Bid commitment

```text
bidHash = SHA-256(canonical(fullBid))
```

The full bid contains a 32-byte random `commitmentSalt`.

Purpose:

- Prevent trivial dictionary/brute-force guessing of public bid hashes
- Detect any post-commitment alteration

The salt does not hide the bid from RouteGuard.

## Carrier signature

The carrier signs:

```text
canonical(fullBidWithoutSignature)
```

RouteGuard verifies the signature against the registered carrier public key.

---

# 10. HCS event model

Use one RouteGuard testnet topic for all project events.

The demo topic must be created **without a submit key** so that the independent carrier accounts can submit their own `BID_COMMITTED` messages. Each carrier account must hold enough testnet HBAR to pay its own `TopicMessageSubmit` fee.

Full private business data remains off-chain.

Before every HCS submission, RouteGuard or the carrier client must assert:

```ts
const messageBytes = Buffer.byteLength(JSON.stringify(message), "utf8");
if (messageBytes >= 1024) {
  throw new Error("HCS_MESSAGE_TOO_LARGE");
}
```

All application messages must remain below **1,024 bytes** to avoid chunking and preserve simple one-message/one-sequence reconciliation.

## 10.1 `TENDER_OPENED`

```json
{
  "schema": "routeguard-freight/1",
  "event": "TENDER_OPENED",
  "tenderId": "TENDER-2026-001",
  "tenderHash": "sha256:...",
  "rulesHash": "sha256:...",
  "auctionEndsAt": "2026-07-15T18:00:00Z",
  "tenderVersion": 1
}
```

## 10.2 `BID_COMMITTED`

```json
{
  "schema": "routeguard-freight/1",
  "event": "BID_COMMITTED",
  "tenderId": "TENDER-2026-001",
  "bidId": "BID-CARRIER-D-001",
  "carrierId": "CARRIER-D",
  "bidHash": "sha256:...",
  "acceptanceReceiptHash": "sha256:...",
  "bidVersion": 1
}
```

The carrier client submits this directly.

## 10.3 `AUCTION_CLOSE_BARRIER`

```json
{
  "schema": "routeguard-freight/1",
  "event": "AUCTION_CLOSE_BARRIER",
  "tenderId": "TENDER-2026-001",
  "auctionEndsAt": "2026-07-15T18:00:00Z"
}
```

## 10.4 `WINNER_SELECTED`

```json
{
  "schema": "routeguard-freight/1",
  "event": "WINNER_SELECTED",
  "tenderId": "TENDER-2026-001",
  "winningBidId": "BID-CARRIER-D-001",
  "winningBidHash": "sha256:...",
  "evaluatedBidSetHash": "sha256:...",
  "decisionManifestHash": "sha256:...",
  "rulesHash": "sha256:...",
  "engineVersion": "routeguard-auction-1.0"
}
```

## 10.5 `ROUTE_RESERVED`

```json
{
  "schema": "routeguard-freight/1",
  "event": "ROUTE_RESERVED",
  "reservationId": "RES-2026-001",
  "tenderId": "TENDER-2026-001",
  "winningBidHash": "sha256:...",
  "reservationHash": "sha256:...",
  "paymentAsset": "0.0.429274",
  "paymentAmountAtomic": "500000",
  "paymentTransactionId": "0.0.x@..."
}
```

---

# 11. Bid submission protocol

1. Carrier discovers the tender.
2. Carrier builds and signs the full bid.
3. Carrier sends the private full bid to RouteGuard.
4. RouteGuard validates schema, signature, tender relationship, payment options, account identity, and expiry.
5. RouteGuard stores the full bid.
6. RouteGuard returns a signed acceptance receipt.
7. Carrier calculates the commitment hash including its salt.
8. Carrier submits `BID_COMMITTED` directly to HCS.
   - Consensus timestamp is authoritative.
   - Carrier clients should submit at least **60 seconds before `auctionEndsAt`**.
   - A commitment transmitted before the deadline but reaching consensus after it is late by design.
9. Carrier stores:
   - Full signed bid
   - Salt
   - RouteGuard acceptance receipt
   - HCS transaction/message evidence

## RouteGuard acceptance receipt

```json
{
  "event": "BID_ACCEPTED_FOR_COMMITMENT",
  "receiptId": "BIDREC-001",
  "tenderId": "TENDER-2026-001",
  "bidId": "BID-CARRIER-D-001",
  "bidHash": "sha256:...",
  "acceptedAt": "..."
}
```

The receipt is an application artifact, not an x402 receipt.

---

# 12. Auction closing and Mirror Node reconciliation

Local time passing the deadline does not immediately authorize winner selection.

## 12.1 Close-barrier algorithm

1. Wait until local time is at or after `auctionEndsAt`.
2. Submit `AUCTION_CLOSE_BARRIER` to the same HCS topic.
3. Poll Mirror Node until the exact barrier appears.
4. Assert `barrier.consensusTimestamp >= auctionEndsAt`.
5. If the barrier consensus timestamp is earlier than the auction deadline, discard it as the closing boundary, submit a new barrier after the deadline, and repeat.
6. Record the valid barrier sequence number.
7. Retrieve all topic messages from the tender-open sequence through `barrierSequence - 1`.
8. Resolve pagination.
9. Verify there are no missing sequence numbers in the retrieved range.
10. Select `BID_COMMITTED` events for the tender.
11. Classify commitments by consensus timestamp.
12. Remain fail-closed if the valid barrier or complete range is unavailable.

## Authoritative timing rule

```text
consensusTimestamp <= auctionEndsAt
    → timely

consensusTimestamp > auctionEndsAt
    → late
```

The carrier’s local creation time, HTTP time, and transaction-submission time are not authoritative. Carrier software should commit at least 60 seconds before the deadline; a commitment that reaches consensus after the deadline is late by design.

## Pending state

```text
AUCTION_RECONCILIATION_PENDING
```

No winner is selected while reconciliation is incomplete.

---

# 13. Auction Decision Manifest

Every timely commitment before the close barrier must appear in the decision manifest, including commitments for which RouteGuard cannot find a matching private full bid.

```json
{
  "tenderId": "TENDER-2026-001",
  "engineVersion": "routeguard-auction-1.0",
  "rulesHash": "sha256:...",
  "commitments": [
    {
      "bidId": "BID-CARRIER-A-001",
      "hcsSequence": 42,
      "consensusTimestamp": "...",
      "decision": "QUALIFIED"
    },
    {
      "bidId": "BID-CARRIER-B-001",
      "hcsSequence": 43,
      "consensusTimestamp": "...",
      "decision": "REJECTED",
      "reasonCode": "DELIVERY_DEADLINE_MISSED"
    },
    {
      "bidId": "BID-CARRIER-C-001",
      "hcsSequence": 44,
      "consensusTimestamp": "...",
      "decision": "REJECTED",
      "reasonCode": "FULL_BID_MISSING"
    }
  ],
  "winningBidId": "BID-CARRIER-A-001"
}
```

The canonical manifest is hashed. The hash is included in `WINNER_SELECTED`.

A timely commitment with no matching off-chain bid must be recorded as:

```text
decision = REJECTED
reasonCode = FULL_BID_MISSING
```

A carrier that retained RouteGuard’s acceptance receipt can then disprove a false `FULL_BID_MISSING` claim, making the manifest a genuine dispute artifact.

This does not eliminate operator trust. It creates:

- Commitment accountability
- Explicit rejection reasons
- Reproducible evaluation evidence
- Coverage of every timely commitment
- A dispute artifact for carriers

---

# 14. Eligibility and winner selection

## 14.1 Eligibility

A bid is eligible only when:

- HCS commitment was timely
- Private full bid exists
- Full bid hash matches commitment
- Acceptance receipt matches
- Carrier signature verifies
- Carrier registry entry is active
- Bid is not expired
- Required equipment matches
- Capacity is confirmed
- Pickup window is feasible
- Delivery deadline is met
- Freight price is at or below tender maximum
- Payment recipient matches registered carrier account
- Offered payment options satisfy RouteGuard schema

## 14.2 Selection policy

Use:

```text
LOWEST_QUALIFIED_PRICE_V1
```

Tie-break order:

1. Lowest freight price
2. Earliest estimated delivery
3. Earliest HCS commitment consensus timestamp
4. Lexicographically lowest `bidId`

The same eligible input set must produce the same result.

Do not use subjective reliability scores in v1.

---

# 15. x402 resource-server model

For the bounty implementation, RouteGuard hosts the protected reservation endpoint on behalf of the winning carrier.

Funds settle directly to the carrier’s Hedera account.

This provides:

- One stable resource server
- One implementation of settlement-first logic
- One policy layer
- Direct payment to the commercial seller
- Reliable demo behavior

Future carriers may host their own resource servers, but that is outside v1.

## Protected resource

```http
POST /api/reservations/:tenderId/:bidId
```

The protected response is the completed reservation object.

---

# 16. Dual-asset payment architecture

## 16.1 Seller authority

The winning bid contains fixed USDC and HBAR reservation options.

RouteGuard’s `402` advertises only terms from the signed winning bid.

The shipper may select one offered option. It may not change:

- Scheme
- Network
- Asset
- Amount
- Recipient
- Expiry
- Resource
- Tender
- Bid

## 16.2 Preferred design and hard timebox

One endpoint advertises two `accepts` entries.

This implementation experiment has a **hard 60-minute timebox** during Phase 3. If the installed Hedera/x402 route configuration does not compile and settle both same-network assets cleanly within that window, stop the experiment and adopt the two-endpoint design permanently for the bounty build.

The one-route form is a presentation preference, not a critical requirement.

## 16.3 Primary compatibility fallback

If the installed Hedera/x402 middleware cannot safely express two assets on the same network within the 60-minute timebox, expose:

```http
POST /api/reservations/:tenderId/:bidId/pay/usdc
POST /api/reservations/:tenderId/:bidId/pay/hbar
```

Both routes are seller-configured. The UI selects an endpoint; it does not rewrite a challenge.

Do not patch the x402 library merely to preserve a single endpoint.

## 16.4 User interface

```text
Preferred settlement rail

[ USDC ]   [ HBAR ]
```

This is a configuration selector for the autonomous shipper client, not a checkout confirmation.

## 16.5 CLI

```powershell
npm run demo:live -- --asset=usdc
npm run demo:live -- --asset=hbar
```

## 16.6 No automatic fallback

Once a payment attempt reaches `PAYMENT_SUBMITTED`, its asset is immutable.

Unsafe:

```text
USDC timeout
→ try HBAR
```

Correct:

```text
USDC timeout
→ reconcile known USDC transaction
→ do not create another payment
```

A new asset may only be selected if no payment was signed, or the earlier attempt is conclusively failed with no on-chain settlement.

---

# 17. Facilitator preflight

Run before any live transaction.

Required assertions:

```text
Facilitator reachable
x402Version = 2
scheme = exact
network = hedera:testnet
feePayer present
```

If any fail:

```text
PREFLIGHT_FAILED
LIVE_SIGNING_DISABLED
```

Save the JSON response under:

```text
evidence/blocky402-supported.json
```

Do not hardcode a permanent fee payer without validating the live response.

---

# 18. USDC preflight

Required checks:

- Token `0.0.429274` exists
- Token type is fungible
- Symbol/metadata match expected testnet USDC
- Decimals are retrieved from ledger metadata
- Shipper account is associated
- Winning carrier account is associated
- Shipper balance is sufficient
- Network is testnet
- Live smoke transaction succeeds before video recording

Possible states:

```text
USDC_RAIL_ENABLED
USDC_RAIL_DISABLED_TOKEN_MISMATCH
USDC_RAIL_DISABLED_SHIPPER_NOT_ASSOCIATED
USDC_RAIL_DISABLED_CARRIER_NOT_ASSOCIATED
USDC_RAIL_DISABLED_INSUFFICIENT_BALANCE
```

Do not enable the website USDC option if preflight fails.

---

# 19. HBAR preflight

Required checks:

- Asset ID is `0.0.0`
- Shipper balance is sufficient
- Shipper key matches account
- Live HBAR smoke transaction succeeds before final recording

HBAR is independently supported. It is not a recovery path for an unresolved USDC payment.

---

# 20. Challenge validation

Before the signer is invoked, RouteGuard’s buyer policy verifies:

- `x402Version`
- Scheme
- Network
- Asset
- Amount
- `payTo`
- Fee payer from live facilitator discovery
- HTTP method
- Exact resource path
- Tender ID
- Winning bid ID
- Winning bid hash
- Reservation option ID
- Offer expiry
- Bid validity
- Reservation availability
- Request/payment identifier
- Asset is not already locked to another unresolved attempt

Failure returns:

```text
BLOCKED_BEFORE_SIGNATURE
```

Reason codes:

```text
VERSION_MISMATCH
SCHEME_MISMATCH
NETWORK_MISMATCH
ASSET_MISMATCH
AMOUNT_MISMATCH
PAYTO_MISMATCH
FEEPAYER_MISMATCH
RESOURCE_MISMATCH
TENDER_MISMATCH
BID_MISMATCH
BID_EXPIRED
RESERVATION_ALREADY_EXISTS
PAYMENT_ATTEMPT_UNRESOLVED
```

The isolated signer receives only the validated payment object.

---


# 21. Settlement-first reservation

The trust-critical reservation route must be implemented **explicitly from the start** using the x402 core resource-server APIs, Hedera scheme support, and facilitator client.

Do not use `@x402/hono` middleware as the primary implementation for the reservation state transition. It may be used only for throwaway smoke endpoints where no operational state is created.

## Required primary lifecycle

```text
receive unpaid request
→ build and return exact 402 requirements

receive paid retry
→ decode payment payload
→ validate RouteGuard business rules
→ facilitator verify
→ facilitator settle
→ confirm settlement success
→ persist PAYMENT_SETTLED
→ create reservation
→ create HCS/outbox events
→ return 200
```

The explicit handler must enforce:

```text
verify → settle → confirm → persist → reserve → 200
```

Never:

```text
reserve or return resource
→ settle later
```

A failed or rejected settlement must produce:

- No reservation
- No `ROUTE_RESERVED` HCS event
- Payment attempt in `PAYMENT_FAILED`
- A non-200 response to the buyer

The implementation must not depend on undocumented middleware lifecycle behavior for this guarantee.


# 22. Payment state and idempotency

## 22.1 Business key

Enforce:

```text
unique(tenderId, winningBidId, shipperId)
```

## 22.2 Logical request ID

```text
reservationRequestId = rg_res_<16-to-128-char-id>
```

## 22.3 Request fingerprint

Bind the logical request to:

- Scheme
- Network
- Asset
- Amount
- Recipient
- Resource path
- HTTP method
- Tender ID
- Bid ID
- Shipper ID

Reusing the same identifier with a different fingerprint returns `409 Conflict`.

## 22.4 Payment attempt

The Hedera transaction ID is generated client-side when the transfer transaction is constructed. It is therefore required before submission, not optional.

Persist before the facilitator call:

```ts
interface PaymentAttempt {
  paymentAttemptId: string;
  paymentIdentifier: string;
  requestFingerprint: string;
  reservationId: string;
  tenderId: string;
  bidId: string;
  shipperId: string;
  selectedAsset: string;
  amountAtomic: string;
  payTo: string;
  transactionId: string;
  validStartTimestamp: string;
  transactionValidDurationSeconds: number;
  paymentPayloadHash: string;
  status:
    | "PAYMENT_ATTEMPT_CREATED"
    | "PAYMENT_SUBMITTED"
    | "PAYMENT_SETTLED"
    | "PAYMENT_FAILED"
    | "SETTLEMENT_RECONCILIATION_REQUIRED";
}
```

The transition to `PAYMENT_SUBMITTED` must fail unless all of these are present:

```text
transactionId
validStartTimestamp
transactionValidDurationSeconds
paymentPayloadHash
selectedAsset
amountAtomic
payTo
```

## 22.5 Duplicate retry

Same identifier and same fingerprint:

- Return cached reservation if complete
- Return current attempt state if unresolved
- Do not request another payment

Same identifier and different fingerprint:

```text
409 PAYMENT_IDENTIFIER_FINGERPRINT_MISMATCH
```


# 23. Crash and orphan-payment recovery

Failure scenario:

```text
Hedera settles
→ RouteGuard crashes
→ local reservation not committed
```

## 23.1 Minimum mandatory protection

1. Persist the payment attempt before facilitator settlement.
2. Require the exact `transactionId`.
3. Persist `validStartTimestamp` and `transactionValidDurationSeconds`.
4. Lock the selected asset.
5. Block any new payment while the attempt is unresolved.
6. Reconcile the exact transaction.
7. Create the missing reservation idempotently after verified success.

## 23.2 Deterministic settlement outcomes

### Found and successful

```text
Mirror Node / network record exists
AND transaction result = SUCCESS
```

Action:

- Verify network, payer, recipient, asset, and amount.
- Mark `PAYMENT_SETTLED`.
- Create or recover the reservation idempotently.

### Found and failed

```text
Transaction record exists
AND result != SUCCESS
```

Action:

- Mark `PAYMENT_FAILED` immediately.
- Do not create a reservation.
- The business operation may start a new payment attempt only through a new identifier and explicit policy decision.

### No record yet

Remain:

```text
SETTLEMENT_RECONCILIATION_REQUIRED
```

Do not unlock the operation while the transaction could still be accepted.

### Conclusively failed

An attempt is conclusively failed only when both are true:

```text
1. A query for the exact transactionId returns no transaction record.
2. now >
   validStartTimestamp
   + transactionValidDurationSeconds
   + 60-second safety buffer.
```

For the bounty configuration:

```text
transactionValidDurationSeconds = 180
safetyBufferSeconds = 60
```

After this boundary, mark `PAYMENT_FAILED`. The operation may then start a new attempt, including selection of a different seller-supported asset.

This rule prevents both:

- Permanent unresolved-payment locks
- Premature second payments

## 23.3 Reconciliation command

```powershell
npm run reconcile:payment -- --payment-id=PAY-RES-001
```

It verifies:

- Exact transaction ID
- Transaction result
- Network
- Payer
- Recipient
- Asset/token
- Exact amount

Expected invariant:

```text
On-chain payments: 1
Reservations:      1
```

## 23.4 Honest limitation

Hedera settlement and the RouteGuard database are not one atomic transaction. The system provides recoverable eventual consistency.

Fully automated recovery is a strong enhancement. The uncertain-payment lock and deterministic conclusive-failure test are mandatory.

# 24. Reservation creation

Inside one local transaction:

- Mark payment `PAYMENT_SETTLED`
- Create reservation
- Cache successful response
- Create HCS-outbox event
- Create two webhook events

Result:

```json
{
  "status": "ROUTE_RESERVED",
  "reservationId": "RES-2026-001",
  "tenderId": "TENDER-2026-001",
  "winningBidId": "BID-CARRIER-D-001",
  "shipperId": "SHIPPER-A",
  "carrierId": "CARRIER-D",
  "pickupWindow": {
    "earliest": "2026-07-17T08:00:00Z",
    "latest": "2026-07-17T16:00:00Z"
  },
  "deliveryDeadline": "2026-07-22T16:00:00Z",
  "freightPriceCents": 361000,
  "payment": {
    "network": "hedera:testnet",
    "asset": "0.0.429274",
    "amountAtomic": "500000",
    "transactionId": "0.0.x@..."
  },
  "reservedAt": "..."
}
```

---

# 25. Webhook integration

Use a minimal durable outbox.

Recipients:

- Shipper TMS
- Winning carrier TMS

Payload:

```json
{
  "eventId": "EVT-ROUTE-RESERVED-001",
  "eventType": "route.reserved",
  "eventVersion": "1.0",
  "reservationId": "RES-2026-001",
  "tenderId": "TENDER-2026-001",
  "winningBidId": "BID-CARRIER-D-001",
  "paymentTransactionId": "0.0.x@...",
  "status": "ROUTE_RESERVED"
}
```

Required:

- HMAC signature
- Stable event ID
- Receiver deduplication
- Limited retry
- Durable status

Deferred:

- Manual replay UI
- Advanced analytics
- Long-term retry policy
- Multi-tenant webhook administration

---

# 26. State machines

## 26.1 Auction

```text
DRAFT
→ OPEN
→ BIDDING
→ AUCTION_RECONCILIATION_PENDING
→ AUCTION_CLOSED
→ WINNER_SELECTED
```

Exception states:

```text
NO_QUALIFIED_BID
LATE_BID_REJECTED
INVALID_BID_SIGNATURE
INCOMPLETE_HCS_WINDOW
WINNING_BID_EXPIRED
```

## 26.2 Payment/reservation

```text
PAYMENT_NOT_STARTED
→ PAYMENT_ATTEMPT_CREATED
→ PAYMENT_SUBMITTED
→ PAYMENT_SETTLED
→ ROUTE_RESERVED
→ NOTIFICATIONS_PENDING
→ COMPLETED
```

Recovery/failure:

```text
PAYMENT_BLOCKED
PAYMENT_FAILED
SETTLEMENT_RECONCILIATION_REQUIRED
RESERVATION_RECOVERED
NOTIFICATION_RETRY_PENDING
```

`ROUTE_RESERVED` can only follow confirmed settlement or verified recovery of a confirmed settlement.

---

# 27. API surface

```http
POST /api/tenders
GET  /api/tenders
GET  /api/tenders/:tenderId
GET  /api/tenders/:tenderId/evidence

POST /api/tenders/:tenderId/bids
POST /api/tenders/:tenderId/close
GET  /api/tenders/:tenderId/result

POST /api/reservations/:tenderId/:bidId
GET  /api/reservations/:reservationId

GET  /api/evidence/:tenderId
GET  /api/health
```

Compatibility fallback:

```http
POST /api/reservations/:tenderId/:bidId/pay/usdc
POST /api/reservations/:tenderId/:bidId/pay/hbar
```

Internal/demo webhook receivers:

```http
POST /demo/shipper-tms/webhooks
POST /demo/carrier-tms/webhooks
```

---

# 28. Website/dashboard

The dashboard is an observability and configuration surface. It is not a human checkout flow.

## Panel 1 — Tender

- Lane
- Cargo qualifiers
- Auction deadline
- Tender hash
- HCS sequence
- Status

## Panel 2 — Bids

- Carrier
- HCS consensus timestamp
- Timely/late
- Qualified/rejected
- Reason code
- Winner

## Panel 3 — Payment

- Preferred rail switch
- Seller-supported options
- `402` received
- Validation checklist
- Selected asset
- Transaction ID
- HashScan link

## Panel 4 — Reservation

- `ROUTE_RESERVED`
- Payment asset/amount
- HCS reservation evidence
- Shipper webhook
- Carrier webhook
- Mirror reconciliation status

## Switch behavior

```text
Preferred settlement rail:
[ USDC ] [ HBAR ]
```

The switch changes shipper policy before a request. It does not edit payment requirements or approve a payment manually.

---

# 29. Technology stack

## Core

- Node.js 20+
- TypeScript strict mode
- Hono
- `@hono/node-server`
- `@x402/core@2.16.0`
- `@x402/fetch@2.16.0`
- `@x402/hedera@2.16.0`
- `@x402/hono@2.16.0`
- `@hiero-ledger/sdk`
- Zod
- Vitest
- `tsx`
- `dotenv`
- SQLite through a repository abstraction

## Optional package

- `@x402/extensions`, only after confirming a compatible published version

## Dependency policy

- Pin all x402 packages to the same exact version
- Commit `package-lock.json`
- Do not upgrade dependencies during final stabilization
- Inspect installed type definitions rather than relying on remembered APIs

## Not used

- Hedera Agent Kit
- Solidity/EVM
- Scheduled Transactions
- HashPack checkout
- LLM tool routing

---

# 30. Repository structure

```text
routeguard-freight-exchange/
├── README.md
├── LICENSE
├── AGENTS.md
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
├── tsconfig.json
├── vitest.config.ts
├── docs/
│   ├── architecture.md
│   ├── protocol.md
│   ├── threat-model.md
│   ├── standards-alignment.md
│   ├── demo-script.md
│   └── evidence.md
├── evidence/
│   ├── blocky402-supported.json
│   ├── hbar/
│   ├── usdc/
│   └── hcs/
├── src/
│   ├── domain/
│   │   ├── tender.ts
│   │   ├── bid.ts
│   │   ├── reservation.ts
│   │   ├── payment-option.ts
│   │   └── canonical-hash.ts
│   ├── auction/
│   │   ├── eligibility.ts
│   │   ├── ranking.ts
│   │   ├── decision-manifest.ts
│   │   ├── state-machine.ts
│   │   ├── close-barrier.ts
│   │   └── mirror-reconciler.ts
│   ├── registry/
│   │   └── carriers.ts
│   ├── hedera/
│   │   ├── client.ts
│   │   ├── hcs-events.ts
│   │   ├── mirror-node.ts
│   │   └── hashscan.ts
│   ├── x402/
│   │   ├── facilitator-discovery.ts
│   │   ├── resource-server.ts
│   │   ├── buyer-client.ts
│   │   ├── requirement-selector.ts
│   │   ├── challenge-validator.ts
│   │   ├── signer.ts
│   │   ├── idempotency.ts
│   │   ├── payment-attempt.ts
│   │   └── settlement-reconciler.ts
│   ├── storage/
│   │   ├── repository.ts
│   │   ├── transaction-manager.ts
│   │   └── outbox-repository.ts
│   ├── webhooks/
│   │   ├── signer.ts
│   │   └── worker.ts
│   ├── server/
│   │   ├── app.ts
│   │   └── index.ts
│   └── config.ts
├── clients/
│   ├── shipper-client.ts
│   ├── carrier-a-client.ts
│   └── carrier-d-client.ts
├── scripts/
│   ├── preflight.ts
│   ├── setup-usdc.ts
│   ├── setup-hcs-topic.ts
│   ├── smoke-hbar.ts
│   ├── smoke-usdc.ts
│   ├── demo-live.ts
│   ├── demo-attack.ts
│   ├── demo-retry.ts
│   ├── reconcile-payment.ts
│   └── export-evidence.ts
├── test/
│   ├── auction.test.ts
│   ├── hashing.test.ts
│   ├── state-machine.test.ts
│   ├── close-barrier.test.ts
│   ├── challenge-validator.test.ts
│   ├── dual-asset.test.ts
│   ├── idempotency.test.ts
│   ├── payment-recovery.test.ts
│   └── webhook.test.ts
└── web/
    └── dashboard/
```

---

# 31. Security controls

## Keys

- Testnet keys only
- No mainnet configuration
- No keys in Git
- No keys in browser code
- No keys in logs
- No keys in AI context
- Shipper payment key accessible only to isolated signer
- Carrier bid keys stay in carrier clients

## Kill switches

```env
NETWORK=hedera:testnet
ENABLE_LIVE_HEDERA=false
ENABLE_LIVE_HBAR_PAYMENTS=false
ENABLE_LIVE_USDC_PAYMENTS=false
```

Signing requires:

- Correct network
- Facilitator preflight
- Relevant asset switch enabled
- Account preflight
- Valid business state

## HCS privacy

Do not publish:

- Customer names
- Street addresses
- Contact information
- Full cargo details
- Full bid prices
- Private commercial conditions

Publish:

- IDs
- Hashes
- Versions
- Deadlines
- Consensus evidence
- State labels
- Payment transaction reference

---

# 32. Threat model

## Threat: wrong recipient

Correct asset and amount, wrong `payTo`.

Result:

```text
BLOCKED_BEFORE_SIGNATURE
PAYTO_MISMATCH
```

## Threat: wrong token

Correct amount and recipient, unapproved HTS token.

Result:

```text
BLOCKED_BEFORE_SIGNATURE
ASSET_MISMATCH
```

## Threat: changed amount

Result:

```text
BLOCKED_BEFORE_SIGNATURE
AMOUNT_MISMATCH
```

## Threat: late bid

Result:

```text
LATE_BID_REJECTED
authoritativeSource=HCS_CONSENSUS_TIMESTAMP
```

## Threat: operator omits a commitment

Mitigation:

- Complete HCS window
- Decision manifest includes every timely commitment
- Commitment evidence retained by carrier
- Manifest hash anchored to HCS

Residual risk:

- Operator can still lie about off-chain bid availability or leak bid content
- Public evidence supports dispute; it does not eliminate operator trust

## Threat: duplicate payment after timeout

Mitigation:

- Persist payment attempt
- Lock asset
- Payment identifier/request fingerprint
- No new payment while unresolved
- Reconcile known transaction

## Threat: server crashes after settlement

Mitigation:

- Reconciliation command/worker
- Idempotent reservation creation
- Cached successful response
- One business reservation key

## Threat: Mirror Node lag

Mitigation:

- Same-topic close barrier
- Poll until exact barrier is visible
- Fetch complete sequence range
- Fail closed on missing sequence

## Threat: testnet USDC reset/configuration drift

Mitigation:

- Live token metadata
- Association checks
- Balance check
- Rail disabled on mismatch
- Separate HBAR support

---

# 33. Testing strategy

## 33.1 Offline unit tests

### Canonicalization and signatures

- Same object produces same canonical encoding
- Key order does not affect hash
- One changed field changes hash
- Salt changes commitment
- Valid carrier signature passes
- Invalid signature fails

### Decision manifest

- Every timely commitment appears exactly once
- Missing private full bid produces `FULL_BID_MISSING`
- Manifest hash changes when any decision row changes

### Eligibility

- Equipment mismatch rejected
- Weight mismatch rejected
- Delivery deadline miss rejected
- Freight ceiling exceeded rejected
- Expired bid rejected

### Ranking

- Lowest qualified price wins
- Delivery tie-break works
- HCS timestamp tie-break works
- `consensusTimestamp == auctionEndsAt` is timely
- `consensusTimestamp > auctionEndsAt` is late
- Bid ID final tie-break works
- Same input produces same output

### State machines

- Invalid transition rejected
- Winner cannot be selected before reconciliation
- Early close barrier is rejected and replaced
- HCS message at or above 1,024 bytes is rejected locally
- Reservation cannot precede payment settlement
- Asset cannot change after `PAYMENT_SUBMITTED`
- `PAYMENT_SUBMITTED` cannot be entered without a transaction ID

### Challenge validation

- Wrong version rejected
- Wrong network rejected
- Wrong scheme rejected
- Wrong token rejected
- Wrong amount rejected
- Wrong recipient rejected
- Wrong fee payer rejected
- Wrong route rejected
- Wrong tender rejected
- Wrong bid rejected

### Idempotency

- Same ID/same fingerprint returns existing state
- Same ID/different fingerprint returns `409`
- Duplicate business reservation rejected
- Uncertain attempt blocks second payment

### Webhooks

- HMAC verifies
- Duplicate event ignored
- Failed delivery retries
- Stable event ID preserved

## 33.2 Live tests

- Live `/supported` preflight
- HBAR `402 → settlement → 200`
- USDC `402 → settlement → 200`
- HashScan transaction opens
- Token transfer amount exact
- Recipient exact
- HCS `TENDER_OPENED`
- Two direct carrier `BID_COMMITTED`
- Close barrier
- Mirror complete window
- `WINNER_SELECTED`
- `ROUTE_RESERVED`
- Wrong-recipient attack creates no transaction
- Failed/rejected settlement produces:
  - no reservation
  - no `ROUTE_RESERVED` HCS event
  - payment attempt in `PAYMENT_FAILED`
  - a 402/4xx/5xx response, never 200
- Duplicate retry creates no second payment
- USDC amount is calculated from ledger-retrieved decimals and matches the expected six-decimal token configuration

## 33.3 Crash-recovery test

Simulate:

```text
settlement succeeds
→ process throws before reservation commit
→ restart/reconcile
```

Verify:

```text
payments = 1
reservations = 1
```

---

# 34. Evidence package

The repository must contain a judge-friendly evidence index.

## `docs/evidence.md`

Include:

- Live Blocky402 capability response
- HBAR HashScan transaction
- USDC HashScan transaction
- HCS topic link
- `TENDER_OPENED` sequence
- Both `BID_COMMITTED` sequences
- Close-barrier sequence
- `WINNER_SELECTED` sequence
- `ROUTE_RESERVED` sequence
- Wrong-recipient terminal output
- Test summary
- Video link

## Evidence exporter

```powershell
npm run evidence:export
```

Generates a Markdown/JSON evidence summary from saved run artifacts.

---

# 35. README structure

The first visible section must contain:

1. Project name
2. One-line pitch
3. Architecture diagram
4. Demo link
5. USDC HashScan link
6. HBAR HashScan link
7. HCS topic link
8. Quickstart

Then:

- Problem
- What the reservation fee buys
- End-to-end flow
- Why Hedera
- Why x402
- Dual-asset behavior
- Three-layer security framing
- Auction transparency and limitations
- Challenge protection
- Idempotency/recovery
- API
- Tests
- Standards alignment
- Known limitations
- Reproduction instructions
- Reference attribution

## Three-layer framing

### Layer 1 — Deterministic commerce rules

Signed bids, hard eligibility, reproducible winner.

### Layer 2 — Pre-signature x402 validation

Exact network, asset, amount, recipient, resource, and business binding.

### Layer 3 — Hedera evidence

Consensus-timestamped bid window and public settlement/state evidence.

---

# 36. Demo plan under five minutes

## 0:00–0:20 — Product

> Carrier software offers transport capacity. Shipper software accepts the winning offer through x402 in USDC or HBAR. Hedera settlement converts payment into a synchronized route reservation.

## 0:20–1:35 — Live USDC payment

Show:

```text
Preferred rail: USDC
POST reservation
→ 402
→ challenge validated
→ signer invoked
→ facilitator settles
→ HashScan
→ ROUTE_RESERVED
```

## 1:35–2:00 — HBAR support

Show:

- HBAR seller option
- Previously completed HBAR smoke transaction
- HashScan proof

Do not pay twice for the same reservation.

## 2:00–2:35 — Wrong-recipient block

Show:

```text
Correct USDC amount
Correct network
Wrong carrier account
→ BLOCKED_BEFORE_SIGNATURE
→ funds moved: 0
```

## 2:35–3:35 — HCS auction evidence

Show:

- Tender commitment
- Two bid commitments
- Consensus timestamps
- Close barrier
- Complete sequence range
- Decision manifest
- Winner

Use a completed live run. Do not wait for Mirror indexing on camera.

## 3:35–4:20 — Reliability and integration

Show:

- One logical request
- One payment
- One reservation
- Shipper webhook
- Carrier webhook
- HCS reservation event

Mention recoverable eventual consistency.

## 4:20–4:50 — Close

> HCS establishes the authoritative bid window. RouteGuard verifies the commercial terms. The shipper selects one carrier-supported payment rail, and confirmed Hedera settlement reserves the capacity.

Leave ten seconds of safety margin.

---

# 37. Bounty alignment and differentiation matrix

| Classification | Requirement or differentiator | RouteGuard evidence |
|---|---|
| Official criterion | x402 standard | Official v2 Hedera `exact` payment flow |
| Official criterion | Hedera testnet | HBAR, USDC, and HCS live on testnet |
| Product alignment | Software pays software | Shipper client programmatically pays RouteGuard/carrier resource |
| Product alignment | Stablecoin commerce | Hedera testnet USDC |
| Differentiator | Native Hedera rail | HBAR alternative |
| Official criterion | Real on-chain payment | HashScan links |
| Official criterion | Meaningful Hedera usage | HCS bid-window evidence plus HTS/HBAR settlement |
| Official requirement | Public open source | Public GitHub repository |
| Official criterion | End-to-end flow | Tender → bids → winner → 402 → settlement → reservation |
| Official requirement | Demo under five minutes | Payment-first video |
| Product alignment | No human checkout | Programmatic client and signer |
| Differentiator | Physical-world state transition | Payment creates freight-capacity state transition |

---

# 38. Implementation phases and hard gates

## Phase 0 — Public repository and source verification

Deliverables:

- Public repository
- README
- Frozen ADR
- Reference repository commit recorded
- Live `/supported` saved
- Meaningful initial commits

Gate:

```text
public repo exists
live facilitator response verified
reference tests/typecheck pass
```

## Phase 1 — HBAR smoke path

Deliverables:

- Minimal protected route
- HBAR buyer client
- Real settlement
- HashScan evidence

Gate:

```text
402 → HBAR settlement → 200
```

## Phase 2 — USDC smoke path

Deliverables:

- USDC metadata check
- Associations
- Funding
- Real settlement
- HashScan evidence

Gate:

```text
402 → USDC settlement → 200
```

## Phase 3 — Dual-asset seller offer

Deliverables:

- Run the one-route `accepts[]` experiment for no more than 60 minutes
- If successful, seller offers USDC and HBAR on one route
- Otherwise, permanently adopt two seller-defined asset endpoints
- Buyer preference selector
- CLI flag
- Website switch
- Asset-aware validation
- No fallback after submission

Gate:

```text
both assets selectable
one-route experiment timebox respected
no challenge rewriting
no asset switch after PAYMENT_SUBMITTED
```

## Phase 4 — Freight domain

Deliverables:

- Tender schema
- Bid schema
- Carrier registry
- Signatures
- Eligibility
- Ranking
- State machine
- Decision manifest

Gate:

```text
deterministic offline auction tests pass
```

## Phase 5 — HCS auction evidence

Deliverables:

- Topic setup without a submit key
- Carrier account HBAR funding preflight
- One test HCS submission from each carrier account
- Tender commitment
- Two carrier commitments
- Close barrier
- Mirror reconciliation
- Winner evidence

Gate:

```text
complete authoritative HCS window
winner reproducible
```

## Phase 6 — Reservation integration

Deliverables:

- Winning-bid protected endpoint
- Challenge binding
- Settlement-first reservation
- HCS reservation event
- Signed webhooks

Gate:

```text
one successful payment creates exactly one reservation
both systems receive event
```

## Phase 7 — Reliability and attacks

Deliverables:

- Wrong-recipient attack
- Wrong-token attack
- Duplicate retry
- Uncertain-payment lock
- Reconciliation
- Crash simulation

Gate:

```text
unsafe payments blocked
no duplicate charge
orphan payment recoverable
```

## Phase 8 — Judge experience

Deliverables:

- Dashboard
- README
- Evidence exporter
- Demo
- Submission

Gate:

```text
new reviewer understands and verifies project in under five minutes
```

---

# 39. Minimum winning cut

If implementation pressure rises, preserve this order.

## Must ship

1. Public repo
2. Live facilitator preflight
3. Real USDC x402 settlement
4. Real HBAR x402 settlement/proof
5. Wrong-recipient block
6. Settlement-before-reservation
7. One tender and two carriers
8. HCS tender, bid commitments, close barrier, winner
9. Decision manifest
10. Route reservation
11. One payment-attempt record
12. No second payment while unresolved
13. Signed shipper/carrier notifications
14. HashScan/HCS evidence
15. Under-five-minute video

## Strong-to-have

- Official Payment Identifier extension
- Automated recovery worker
- Polished dashboard
- Additional attack demonstrations

## Defer without regret

- DID/VC
- Signed Offers and Receipts
- Full webhook administration
- Mainnet
- Real carrier integrations
- Full freight invoice
- Escrow
- EVM
- GPS
- Proof of delivery
- Insurance settlement
- Reputation
- Multi-leg routing

---

# 40. Definition of done

- [ ] Public GitHub repository
- [ ] Clean clone installs with `npm ci`
- [ ] Typecheck passes
- [ ] Offline tests pass
- [ ] Live facilitator preflight passes
- [ ] HBAR x402 settlement works
- [ ] USDC x402 settlement works
- [ ] Both HashScan links saved
- [ ] USDC associations and metadata verified
- [ ] Seller defines both payment options
- [ ] Buyer selects without editing terms
- [ ] Asset locked after `PAYMENT_SUBMITTED`
- [ ] Tender committed to HCS
- [ ] Two carrier commitments visible
- [ ] Close barrier visible
- [ ] Close barrier consensus timestamp is at or after auction deadline
- [ ] Every HCS event is below 1,024 bytes
- [ ] Demo topic has no submit key
- [ ] Carrier A and Carrier D can submit directly and have sufficient HBAR
- [ ] Mirror sequence window complete
- [ ] Decision manifest generated
- [ ] Every timely commitment appears, including `FULL_BID_MISSING` rows
- [ ] Winner evidence committed
- [ ] Reservation created only after settlement
- [ ] `ROUTE_RESERVED` committed to HCS
- [ ] Wrong recipient blocked before signature
- [ ] Duplicate retry does not pay twice
- [ ] `PAYMENT_SUBMITTED` always has a required transaction ID
- [ ] Conclusive-failure expiry logic is tested
- [ ] Uncertain payment blocks new settlement
- [ ] Failed settlement creates no reservation and no `ROUTE_RESERVED` event
- [ ] Recovery path tested
- [ ] Both webhook receivers receive signed event
- [ ] No secrets in files or Git history
- [ ] README contains proof links
- [ ] Video below five minutes
- [ ] Submission form completed before deadline

---

# 41. Immediate implementation steps

Use the F: drive project location.

## Step 1 — Create the repository

```powershell
$Root = "F:\Projects\RouteGuard"
$Project = "$Root\routeguard-freight-exchange"

New-Item -ItemType Directory -Force $Root | Out-Null

if (Test-Path $Project) {
    throw "Project directory already exists: $Project. Inspect before continuing."
}

New-Item -ItemType Directory $Project | Out-Null
Set-Location $Project

git init
git branch -M main
```

Create:

- `README.md`
- `.gitignore`
- `docs/ADR-001-frozen-architecture.md`
- `evidence/`

Commit and publish immediately.

## Step 2 — Clone the reference separately

```powershell
Set-Location "F:\Projects\RouteGuard"
git clone https://github.com/matevszm/x402-hedera-example.git x402-hedera-reference
Set-Location "F:\Projects\RouteGuard\x402-hedera-reference"

git rev-parse HEAD
npm ci
npm run typecheck
npm test
npm run web:typecheck
npm list @x402/core @x402/fetch @x402/hedera @x402/hono
```

Do not modify the reference checkout.

## Step 3 — Capture live facilitator capabilities

```powershell
Set-Location "F:\Projects\RouteGuard\routeguard-freight-exchange"

$Supported = Invoke-RestMethod `
  -Uri "https://api.testnet.blocky402.com/supported" `
  -Method Get

$Supported |
  ConvertTo-Json -Depth 20 |
  Tee-Object -FilePath "evidence\blocky402-supported.json"
```

Assert that one advertised kind matches:

```text
x402Version = 2
scheme = exact
network = hedera:testnet
```

Commit the evidence.

## Step 4 — Scaffold the typed server

Create:

- `package.json`
- `tsconfig.json`
- `vitest.config.ts`
- `src/config.ts`
- `src/server/app.ts`
- `src/server/index.ts`
- `scripts/preflight.ts`
- `test/health.test.ts`

Milestone:

```text
GET /api/health → 200
npm run preflight
npm run typecheck
npm test
```

Commit and push.

## Step 5 — HBAR smoke path

Adapt the reference implementation to:

```http
POST /api/smoke/hbar
```

Deliver:

```text
402 → real HBAR settlement → 200
```

Save:

- Transaction ID
- HashScan link
- Request/response logs

Do not build the freight auction before this works.

## Step 6 — HCS topic and carrier-account preconditions

Before any direct carrier commitment:

- Create the RouteGuard testnet topic **without a submit key**.
- Verify the topic accepts public submissions.
- Verify shipper, Carrier A, and Carrier D accounts are funded with sufficient testnet HBAR.
- Submit one test message from each carrier account.
- Confirm both messages through Mirror Node.

Then continue with the asset smoke paths.

## Step 7 — USDC smoke path

- Query token metadata
- Associate buyer and carrier
- Fund buyer
- Create protected USDC route
- Complete real settlement
- Save proof

## Step 8 — Dual-asset selector

Test one-route `accepts[]` for a maximum of **60 minutes**.

If it compiles, verifies, and settles both assets cleanly within the timebox:

- Use one endpoint

On any friction or incomplete proof when the timebox expires:

- Permanently use two seller-defined asset endpoints for the bounty build

Add CLI selector and website switch.

Only then begin freight domain implementation.

---


# 42. Implementation handoff rules

The final constrained review is complete. Implementation begins under these rules:

1. Do not reopen architecture without a live reproducible blocker.
2. Complete and commit each phase gate before adding the next layer.
3. The explicit settlement-first reservation route is mandatory.
4. `transactionId` is mandatory before `PAYMENT_SUBMITTED`.
5. An unresolved payment attempt blocks any replacement payment.
6. HCS close-barrier and message-size assertions are mandatory.
7. The one-route dual-asset experiment stops after 60 minutes.
8. If schedule pressure rises, cut the dashboard first, then automated recovery, while retaining the manual reconciliation command.
9. Record every live transaction, HCS sequence, test result, and failure artifact as evidence.
10. No feature is complete until its negative-path test passes.

# 43. Final narrative

> **RouteGuard Freight Exchange is a deterministic software-to-software freight market. Shipper software publishes a time-limited tender. Carrier systems submit signed private capacity bids and commit salted bid hashes directly to Hedera Consensus Service. HCS establishes the consensus timestamp and ordering of the bid commitments, while RouteGuard accounts for every timely commitment in a Decision Manifest and applies transparent, reproducible qualification and winner-selection rules. The shipper accepts the winning capacity through x402 in either testnet USDC or native HBAR. RouteGuard verifies the exact asset, amount, recipient, resource, and winning bid before any signature. Confirmed Hedera settlement creates one route reservation, anchors the result to HCS, and synchronizes the shipper and carrier systems through signed webhooks.**

## Closing line

> **Carrier software offers capacity. Shipper software pays to accept it. Hedera proves the payment and timing. RouteGuard turns it into movement.**

---


# 44. Final patch audit

| Patch | Integrated requirement | Location |
|---:|---|---|
| 1 | Required `transactionId` before `PAYMENT_SUBMITTED` | §§22–23 |
| 2 | Deterministic conclusive-failure rule | §23 |
| 3 | Explicit core-API settlement route is primary | §21 |
| 4 | Negative live settlement test | §33.2 |
| 5 | Barrier timestamp sanity assertion | §12 |
| 6 | `FULL_BID_MISSING` manifest row | §13 |
| 7 | 60-minute one-route dual-asset timebox | §16, Phase 3, immediate steps |
| 8 | HCS messages strictly below 1,024 bytes | §10, tests, definition of done |
| 9 | No topic submit key; funded carrier accounts | §§6, 10, Phase 5, immediate steps |
| 10 | Carrier 60-second submission margin | §§11–12 |
| 11 | Matrix separates official criteria from differentiators | §37 |
| 12 | Inclusive deadline boundary test | §33.1 |

All required fixes are part of the core implementation plan.

---

# 45. Source list for verification

- Hedera x402 bounty:  
  `https://hedera.com/x402-bounty/`

- Hedera official x402 specification and implementation guide:  
  `https://docs.hedera.com/solutions/ai/x402`

- Live Blocky402 testnet capabilities:  
  `https://api.testnet.blocky402.com/supported`

- x402 seller quickstart and `accepts` configuration:  
  `https://docs.x402.org/getting-started/quickstart-for-sellers`

- x402 Payment Identifier extension:  
  `https://docs.x402.org/extensions/payment-identifier`

- Circle USDC network addresses:  
  `https://developers.circle.com/stablecoins/usdc-contract-addresses`

- Hedera reference project:  
  `https://github.com/matevszm/x402-hedera-example`

- Hedera pay-per-use marketplace template:  
  `https://github.com/hedera-dev/scaffold-hbar/tree/templates/x402-pay-per-use`

---

**End of implementation-ready plan v1.5.**
