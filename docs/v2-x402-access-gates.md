# RouteGuard v2 — x402 access gates (Phase B2b)

Protocol reference for the two paid RouteGuard v2 actions: tender activation and
durable carrier-bid submission.

> **Phase B2b status: two real Hedera testnet x402 access payments completed.**
> Tender activation and durable bid submission each settled **0.001 USDC
> (1000 atomic)** of token `0.0.429274` on `hedera:testnet` via Blocky402.
> Evidence: `evidence/v2/access/`. **Freight escrow is not live** (`ESCROW_PHASE=C_PENDING`).
> HCS messages remain offline outbox records only (`HCS_NETWORK_WRITES=0`).
> Automated tests continue to use facilitator doubles; do not re-run the live
> demo during CI.

---

## 1. Endpoints

| Method | Path | Protected resource purchased |
|---|---|---|
| `POST` | `/api/v2/tenders/:tenderId/v/:tenderVersion/activate` | Opening one tender version for bidding |
| `POST` | `/api/v2/tenders/:tenderId/v/:tenderVersion/bids/:bidId` | Durable acceptance of one carrier bid |

The protected resource string is produced by the Phase A canonical builders
(`tenderActivateResource`, `bidSubmitResource`) and is the exact value a payment
must declare:

```
/api/v2/tenders/<tenderId>/v/<tenderVersion>/activate
/api/v2/tenders/<tenderId>/v/<tenderVersion>/bids/<bidId>
```

Routes are registered only when `ENABLE_V2_ACCESS_ROUTES=true`; otherwise both
paths answer `503 ACCESS_NOT_CONFIGURED`.

## 2. The access fee

| Field | Value |
|---|---|
| Display amount | `0.001 USDC` |
| Token | `0.0.429274` (verified Hedera testnet USDC) |
| Decimals | `6` |
| Atomic amount | `1000` (derived, never hard-coded as sole authority) |
| Scheme | `exact` |
| Network | `hedera:testnet` |
| `payTo` | `ROUTEGUARD_ACCESS_TREASURY_ACCOUNT_ID` |

This is the **RouteGuard application access price**. It is **not** the Hedera
network fee, the freight principal, escrow funding, freight payment, or a
payment to a carrier. Freight money is denominated separately as
`maximumFreightBudgetAtomic` on the tender and never flows through an access
gate. The access treasury is trusted server configuration; it is never read from
a request, a payment payload, or a lifecycle event, and it must match the trust
snapshot stored on the tender (`ACCESS_NOT_CONFIGURED` otherwise).

## 3. Request → 402 → paid retry

```
POST /api/v2/tenders/t-1/v/1/activate          →  402 Payment Required
      (no payment header)                          PAYMENT-REQUIRED header
                                                   + x402 PaymentRequired body

POST /api/v2/tenders/t-1/v/1/activate          →  200 OK
      X-PAYMENT: <base64 payment payload>          activated tender + receipt
```

Both gates run **all** pre-payment validation first. A request that can never
legally succeed is rejected **before** any challenge is issued, so nobody is
charged for an impossible action.

**Activation pre-payment checks:** tender exists; path `tenderId` and
`tenderVersion` match the record; state is `ESCROW_FUNDED`; not already
activated; trust snapshot valid and treasury configured; body and `actionId`
valid; no conflicting completed action.

**Bid pre-payment checks:** tender exists and matches; state permits bidding;
auction still open per the injected server clock; `bidId` matches the body; bid
passes schema validation; carrier is registered, active, account-matched, and
authorized for the equipment; equipment, pickup window, delivery deadline, and
capacity satisfy the tender; freight amount is a valid atomic integer string not
exceeding `maximumFreightBudgetAtomic`; carrier signature verifies against the
**registered** key; the bid is not already durably accepted; `actionId` is free.

Malformed, ineligible, late, over-budget, and unsigned bids therefore never
reach the facilitator.

## 4. Paid path ordering and durable claim

1. decode the `X-PAYMENT` / `PAYMENT-SIGNATURE` header (real x402 codec);
2. assert the declared terms match this exact action (scheme, network, token,
   amount, `payTo`, and the exact protected resource);
3. `verifyPayment` through the injected facilitator;
4. create or atomically acquire a durable payment claim;
5. mark the claim `SETTLING`, then call `settlePayment`;
6. persist the transaction id and settlement timestamp immediately as
   `SETTLED_PENDING_COMMIT`;
7. for bids: retain the private bid body in its separate content-addressed store;
8. commit the lifecycle transition, the access-settlement index entry, and the
   bid registry entry **atomically** in one durable record write;
9. mark the claim `COMMITTED` with a stable resource reference;
10. return the protected resource plus a payment-receipt summary.

Settlement is orchestrated before resource delivery so the receipt always binds
the authoritative settlement identity. The claim journal closes the crash gap
between settlement and that resource commit. The Hono `paymentMiddleware` settles only *after* the route
handler has produced its response, which cannot bind a settlement id into
durable state — so the v2 gates orchestrate the real `x402ResourceServer`
(`buildPaymentRequirements` / `createPaymentRequiredResponse` / `verifyPayment` /
`settlePayment`) with `ExactHederaScheme` directly instead.

### Claim lifecycle and crash recovery

`CLAIMED -> SETTLING -> SETTLED_PENDING_COMMIT -> COMMITTED` is the successful
path; conclusive failure enters `FAILED`. Claims bind the action type,
`actionId`, tender and version, optional bid id, payer, treasury, asset, exact
amount, exact resource, canonical payment-payload hash, and a hash of the
validated protected request. They never contain a raw payment header, private
key, full bid body, salt, or signature-bearing error detail.

| Restart state | Recovery behavior |
|---|---|
| `CLAIMED` | Verify the identical submitted payment and safely begin settlement |
| `SETTLING` | Invoke the injected reconciliation boundary; never blindly resettle |
| `SETTLED_PENDING_COMMIT` | Commit the missing activation or bid without settlement |
| `COMMITTED` | Rebuild the original result from lifecycle state; no settlement or version bump |
| `FAILED` | Preserve safe failure classification and fail closed |

The file adapter uses an atomic journal replacement under a cross-process lock;
the memory adapter has the same acquire/transition semantics. The lifecycle
record remains the authoritative protected-resource store, so payment-journal
transitions do not consume Phase A lifecycle versions. If a crash occurs after
the resource write but before claim finalization, lifecycle action idempotency
proves the resource is already committed and the retry only finalizes the claim.

## 5. Payment binding

Every committed access payment binds: action type, `actionId`, `tenderId`,
`tenderVersion`, `bidId` (bids only), payer account, configured `payTo`, token,
exact amount, exact resource, canonical payment-payload hash, settlement
transaction id, settlement timestamp, and `PAID` status.

Rejected: wrong token, amount, `payTo`, network, scheme, or resource; a payment
for another tender, another tender version, or another bid; a tender-activation
payment presented for a bid (and the reverse); a modified payload; a malformed
transaction reference; a payer equal to the treasury.

## 6. Idempotency and replay

| Situation | Behavior |
|---|---|
| Unpaid repeat | Same deterministic payment requirements |
| Paid identical retry | Original resource, `outcome: "REPLAYED"`, no second settlement, no new transition, no version bump, no duplicate bid |
| Same `actionId`, changed payload | `409 ACTION_ID_CONFLICT` |
| Settlement reused for another action | `409 PAYMENT_REPLAY` (append-only settlement index, unique transaction ids) |
| Bid already accepted | `409 PERSISTENCE_CONFLICT` |

A committed `actionId` short-circuits the request before the facilitator is
contacted, so a retry can never settle twice.

The former Phase B1 settlement-to-commit crash gap is closed by the durable
claim and reconciliation flow. Phase B2b exercised the claim path with real
facilitator settlement and Mirror confirmation (see `evidence/v2/access/`).

### Live demo runner

```bash
# Requires explicit guards + configured treasury (public account id).
ROUTEGUARD_LIVE_V2_ACCESS_CONFIRM=I_UNDERSTAND_TESTNET_WRITES \
ROUTEGUARD_LIVE_V2_ACCESS_MAX_SETTLEMENTS=2 \
ENABLE_V2_ACCESS_ROUTES=true \
ROUTEGUARD_ACCESS_TREASURY_ACCOUNT_ID=<distinct-usdc-associated-account> \
ENABLE_LIVE_HEDERA=true \
ENABLE_LIVE_USDC_PAYMENTS=true \
npm run demo:v2-access-live
```

Maximum **two** successful settlements per completed run. Replay must not create
a third. The runner refuses when evidence already shows a completed SUCCESS run.

### Live run claim boundary (truthful)

| Claim | Status |
|---|---|
| Real testnet x402 access payments (activation + bid) | **YES** |
| Synthetic business tender/bid data | YES |
| HCS submitted | **NO** |
| Live freight-principal escrow | **NO** (`C_PENDING`) |
| POD / freight release | **NO** |
| v1 final-demo evidence | Unchanged |

## 7. Bidding state

The first durably accepted paid bid performs `TENDER_OPENED → BIDDING` as part
of the same atomic commit. Later accepted bids remain in `BIDDING` (self
transition) and never repeat it. No shortcut edge is added to the Phase A graph.

## 8. Privacy

The bid body — freight amount, commitment salt, nonce — is private. It is stored
only in the bid-body store, never in the lifecycle record, never in public
evidence, and never in an HTTP response. The lifecycle record and the HCS
`BID_COMMITMENT` payload carry only the salted bid hash, the carrier id, the bid
id, and the access-payment transaction id.

## 9. Evidence (built, not submitted)

`src/v2/hcs/outbox.ts` builds validated `TENDER_OPENED` and `BID_COMMITMENT`
HCS 2.0 envelopes from durable state alone (size- and privacy-checked). Phase B2a
**does not submit them**; the committed `commitmentPayloadHash` binds each bid to
the exact evidence a later guarded phase may publish.

## 10. Error codes

`TENDER_NOT_FOUND` · `TENDER_VERSION_MISMATCH` · `INVALID_LIFECYCLE_STATE` ·
`ESCROW_NOT_CONFIRMED` · `AUCTION_CLOSED` · `BID_INVALID` · `BID_INELIGIBLE` ·
`PAYMENT_REQUIRED` · `PAYMENT_INVALID` · `PAYMENT_RESOURCE_MISMATCH` ·
`PAYMENT_AMOUNT_MISMATCH` · `PAYMENT_ASSET_MISMATCH` ·
`PAYMENT_RECIPIENT_MISMATCH` · `PAYMENT_SCHEME_MISMATCH` ·
`PAYMENT_NETWORK_MISMATCH` · `PAYMENT_SETTLEMENT_FAILED` · `PAYMENT_REPLAY` ·
`PAYMENT_CLAIM_CONFLICT` · `PAYMENT_SETTLEMENT_UNKNOWN` ·
`PAYMENT_ALREADY_USED` · `PAYMENT_RECOVERY_FAILED` · `RESOURCE_COMMIT_FAILED` ·
`ACTION_ID_CONFLICT` · `PERSISTENCE_CONFLICT` · `ACCESS_NOT_CONFIGURED` ·
`INTERNAL_ERROR`

Responses carry a code and a short safe message only — never stack traces,
payment payloads, signatures, secrets, private bid fields, or filesystem paths.

## 11. Configuration

| Variable | Required | Meaning |
|---|---|---|
| `ENABLE_V2_ACCESS_ROUTES` | — | `true` registers the v2 access routes |
| `ROUTEGUARD_ACCESS_TREASURY_ACCOUNT_ID` | when enabled | Access-fee `payTo`; a public testnet account id, not a secret |
| `USDC_TOKEN_ID` | — | Must remain the verified `0.0.429274` |
| `FACILITATOR_URL` | — | Existing Blocky402 facilitator setting (reused) |
| `ROUTEGUARD_V2_DATA_DIR` | — | Durable v2 state root (default `data/v2`) |
| `ROUTEGUARD_V2_CARRIER_REGISTRY_PATH` | — | Trusted carrier registry JSON |
| `ROUTEGUARD_LIVE_V2_ACCESS_CONFIRM` | live only | Must equal `I_UNDERSTAND_TESTNET_WRITES` |
| `ROUTEGUARD_LIVE_V2_ACCESS_MAX_SETTLEMENTS` | live only | Must equal `2` |

No private key is ever stored or committed by these routes. Live payer keys are
read only by the guarded demo runner from the local untracked `.env`.

## 12. Phase B2b live evidence

| Field | Value |
|---|---|
| Run ID | `v2access-20260731-918f5748` |
| Activation tx | `0.0.7162784@1785519911.424021609` |
| Bid tx | `0.0.7162784@1785520014.520040785` |
| Amount each | 1000 atomic USDC (0.001) |
| Token | `0.0.429274` |
| Successful settlements | **2** |
| HCS writes | **0** |
| Freight escrow | **not live** |

Artifacts: `evidence/v2/access/*`.
