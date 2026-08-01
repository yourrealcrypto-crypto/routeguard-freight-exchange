# RouteGuard v2 Architecture and Migration Plan

> **Document control (repository copy)**
>
> - Owner decisions locked: **2026-07-31**
> - Implementation proceeds **incrementally** by phase (A1 through F)
> - **v1 live evidence remains immutable** - do not re-run the live final-auction or modify `evidence/final-demo-*`
> - Source plan imported from the owner-approved architecture analysis; content below is preserved

---

# RouteGuard v2 — Architecture & Migration Plan (Read-Only)

**Repository:** `F:\Projects\RouteGuard\routeguard-freight-exchange`  
**Branch context:** `feat/routeguard-brand-assets` · status **v0.5.1**  
**Mode:** Strictly read-only · **NETWORK_WRITES=0**  
**Baseline authority:** Live final demo evidence (topic `0.0.9794225`, sequences 1–5, payment `0.0.7162784@1785173890.867086556`) is immutable v1 proof and must not be re-run or rewritten.

---

## 1. Executive verdict

**v2 is feasible as a deliberate product-architecture evolution, not a small patch.** The repository already has strong foundations for auction ranking, HCS evidence, x402 exact USDC settlement, idempotent payment claims, and fail-closed state machines. Almost none of the v2 freight-escrow / POD / dispute path exists yet.

| Area | Verdict |
|---|---|
| Preserve v1 live demo as immutable baseline | **Yes** — isolate under `v1/` docs/evidence labels; do not re-execute live final-auction |
| Dual x402 access gates (tender + bid) | **Yes** — `@x402/hono` multi-route `RoutesConfig` + existing exact USDC stack |
| Access fee 0.001 USDC atomic amount | **Yes** — token `0.0.429274`, **decimals = 6** → **1000** atomic units |
| HTS USDC freight escrow (smart contract) | **Yes, greenfield** — no Solidity/HTS escrow code today; ADR must be reopened |
| POD + AI advisory + human referee | **Yes, greenfield** — keep AI advisory-only; release only via contract + signed resolutions |
| Phase A readiness (offline schemas/SM/tests) | **Yes** — can start without network writes |

**Strategic framing**

- **v1 product:** capacity-reservation fee via x402 → `ROUTE_RESERVED` (freight invoice explicitly *not* settled).
- **v2 product:** (A) micro x402 **access** payments + (B) **freight-principal escrow** in HTS USDC with POD acceptance / dispute release.

These must stay economically and cryptographically separate forever.

**ADR impact:** `docs/ADR-001-frozen-architecture.md` currently freezes *“No Scheduled Transaction escrow; no full freight-invoice settlement through x402.”* v2 reopens that ADR for **smart-contract HTS escrow** (not Scheduled Transactions, and **not** freight-through-x402). Implementation must not begin until that ADR amendment is owner-locked.

---

## 2. Current-vs-target gap table

| Capability | Current (v1) | Target (v2) | Gap |
|---|---|---|---|
| Tender model | `FreightTender` with `maximumFreightPriceCents`; no funding state | Pre-fund max budget → `ESCROW_FUNDED` → x402-gated open | New tender lifecycle + escrow fund tx |
| Tender open gate | Operator orchestration / dry path; no per-action x402 | Exact x402 **0.001 USDC** on tender activation | New protected route + paid receipt |
| Bid submission | Off-chain full bid + HCS `BID_COMMITMENT` | Durable offer submission requires x402 access payment | Gate + bid-payment binding |
| Auction selection | `LOWEST_QUALIFIED_PRICE_V1` | Same policy (keep) | Reuse |
| HCS ordering | OPEN / COMMITMENT / BARRIER / ROUTE_RESERVED | Extended event set (fund, allocate, POD meta, accept, dispute, release) | New message types + schema version |
| Settlement economics | Demo reservation fee **0.01 USDC** to winner via x402 | Access fees to platform; freight principal via escrow | Split payment surfaces; rewrite economics docs |
| Escrow | Explicitly excluded | Smart-contract HTS USDC max-budget escrow | Greenfield contract + adapters |
| Winner allocation | Immediate pay winner reservation fee | Lock winning amount; refund excess to shipper | Contract `allocate` / `refundExcess` |
| Post-reserve ops | Webhooks + HCS evidence → COMPLETED | IN_TRANSIT → POD → review → release | New lifecycle after ROUTE_RESERVED |
| POD | None | Encrypted off-chain package; HCS hashes only | Storage boundary + hash schemas |
| AI | Forbidden on trust path | POD Assurance Adviser (non-binding) | Advisory service interface only |
| Shipper review | None | 48h window; accept / correct / reject | APIs + timeout worker |
| Correction | None | 24h correction window | State + deadlines |
| Dispute / referee | Manifest is dispute *artifact* only | Human referee + signed resolution → release/refund/partial | Auth model + contract calls |
| Frontend | Dev shell + Winning Demo report | Judge Mode, escrow/POD/dispute explorer | Phase F UI |
| Idempotency | Settle claim CAS, outbox, recovery | Same patterns for every new transition | Extend attempt stores |
| Live evidence | Immutable v1 final demo | Separate v2 testnet demo artifacts | Do not overwrite v1 paths |

### Conflicting assumptions (must resolve before code)

| # | v1 assumption | v2 conflict | Resolution |
|---|---|---|---|
| C1 | Reservation x402 fee *is* the economic settlement before `ROUTE_RESERVED` | Freight principal is escrow; x402 is access only | Two rails: access vs freight |
| C2 | ADR: no escrow; no full freight via x402 | Escrow required; freight still not via x402 | Reopen ADR for contract escrow only |
| C3 | No LLM on trust-critical path | AI POD review exists | AI advisory-only; never signs release |
| C4 | Terminal auction state ends product story | Long post-award lifecycle | Unified tender lifecycle SM (not only auction SM) |
| C5 | Bid `reservationPaymentOptions` for dual-asset reservation fee | Access fee is fixed platform price; freight is escrow USDC | Retire dual-rail reservation fee for v2 freight path (keep smoke rails for challenge compliance) |
| C6 | `freightPriceCents` integer USD cents | Escrow uses HTS USDC atomic units | Map: cents ↔ USDC atomic via decimals=6 (1 cent = 10_000 atomic at 6 decimals? Wait: 1 USD = 100 cents = 1_000_000 atomic USDC; 1 cent = 10_000 atomic). Must lock money model |
| C7 | Final-demo one payment then done | Multiple access payments + fund + allocate + release | New demo script & write budgets |

**Money-model note (lock before Phase A):**  
Keep **freight amounts in USDC atomic strings** (`bigint` path) on the escrow path. Keep `freightPriceCents` only if defined as exact integer USD cents with deterministic conversion:

- `atomic = freightPriceCents × 10^(decimals-2)` for decimals=6 → `× 10_000`.

Do not introduce floats.

---

## 3. Proposed architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     RouteGuard Application                       │
│  Deterministic TypeScript policies · CAS stores · outboxes       │
├──────────────┬───────────────────┬───────────────────────────────┤
│ x402 Access  │ Auction / HCS     │ Escrow + POD Lifecycle        │
│ Gate Layer   │ Ordering Layer    │ Settlement Layer              │
├──────────────┼───────────────────┼───────────────────────────────┤
│ POST activate│ HCS topic messages│ Hedera Smart Contract (HTS)   │
│  @ exact     │ OPEN/COMMIT/…     │ fund / allocate / refund /    │
│  0.001 USDC  │ POD_* hashes only │ release / partial / dispute   │
│ POST bid     │ Mirror reconcile  │                               │
│  @ exact     │ DecisionManifest  │ Off-chain encrypted POD store │
│  0.001 USDC  │                   │ AI Adviser (read-only advice) │
│ Blocky402    │                   │ Referee signed resolutions    │
└──────────────┴───────────────────┴───────────────────────────────┘
```

### Layers

1. **Access payment layer (x402 exact)**  
   - Protected actions: tender activation, durable bid submission.  
   - `payTo` = RouteGuard access treasury (config).  
   - Amount = **1000** atomic USDC.  
   - Facilitator: Blocky402 testnet (same stack as smoke).

2. **Ordering / evidence layer (HCS)**  
   - Authoritative event log for auction + lifecycle metadata.  
   - Public hashes/IDs only; no POD plaintext; no PII.

3. **Freight principal layer (HTS USDC escrow contract)**  
   - Shipper funds `maxBudgetAtomic`.  
   - On winner: lock `winningAmount`; refund `maxBudget - winning`.  
   - Release only on accept / deemed accept / signed referee resolution.

4. **POD storage layer (off-chain)**  
   - Encrypted blob store (object storage or app-local durable store for demo).  
   - Application holds keys or uses shipper/carrier shared-secret envelope encryption.  
   - HCS gets content hashes, ciphertext size, key-id references — never document bodies.

5. **Advisory layer (AI)**  
   - Inputs: POD integrity metadata + structured extraction (decrypted only in secure review plane).  
   - Output: non-binding report with finding codes.  
   - **Cannot** call escrow release.

6. **Human control layer**  
   - Shipper: accept / correction request / reject-to-dispute.  
   - Referee: signed resolution with amounts.  
   - Timeout worker: deterministic deemed acceptance.

### What to reuse unchanged (or nearly)

| Module | Reuse |
|---|---|
| `src/auction/ranking.ts`, `eligibility.ts`, `decision-manifest.ts`, `closure-proof.ts` | Core selection |
| `src/hcs/message-envelope.ts`, Mirror client, reconciliation patterns | Extend message types |
| `src/domain/canonical-hash.ts`, `signature.ts`, `time.ts`, `money.ts` | Trust primitives |
| `src/x402/usdc-*`, `@x402/hono` middleware, facilitator preflight | Access gates |
| `src/reservation/*` settle-claim / CAS / Mirror confirm / recovery | **Pattern**, not product semantics |
| Final-demo guards (multi-flag fail-closed live writes) | v2 live demos |
| Brand assets / report generator patterns | Phase F |

### What becomes v1-only (preserve, do not drive v2 product)

| Artifact | Treatment |
|---|---|
| `evidence/final-demo-*` live + dry | Immutable baseline |
| Reservation dual-asset **demo fee** as freight story | Historical / challenge smoke only |
| ADR-001 pre-v2 exclusions | Superseded by ADR-002 (v2) |
| `ROUTE_RESERVED` payload fields tied to reservation fee payment | Version or dual-schema for v2 escrow-backed reserve |

---

## 4. State-machine specification

### 4.1 Unified tender lifecycle (authoritative v2)

```
DRAFT
  → ESCROW_FUNDED                 [contract Funded event + Mirror SUCCESS]
  → TENDER_OPENED                 [x402 tender-activation paid + HCS TENDER_OPENED/AUCTION_OPEN]
  → BIDDING
  → AUCTION_CLOSED                [barrier + complete sequence range]
  → WINNER_SELECTED | NO_QUALIFIED_BID
  → WINNING_AMOUNT_LOCKED         [allocate + excess refund txs confirmed]
  → ROUTE_RESERVED                [HCS after allocate success]
  → IN_TRANSIT
  → DELIVERY_REPORTED
  → POD_SUBMITTED
  → POD_UNDER_REVIEW              [reviewDeadline = now + reviewWindow]
  → POD_CORRECTION_REQUESTED      [correctionDeadline = now + correctionWindow]
  → POD_RESUBMITTED               → POD_UNDER_REVIEW
  → POD_ACCEPTED | POD_DEEMED_ACCEPTED | POD_DISPUTED
  → REFEREE_DECISION              [from POD_DISPUTED]
  → PAYMENT_RELEASED | PARTIAL_RELEASE | REFUNDED
  → TENDER_COMPLETED
```

**Terminal failures (illustrative):** `NO_QUALIFIED_BID` → full refund path → `REFUNDED` → `TENDER_COMPLETED`; incomplete HCS window remains fail-closed (no winner allocation).

### 4.2 Legal transitions (core)

| From | To | Guard |
|---|---|---|
| DRAFT | ESCROW_FUNDED | Escrow fund Mirror SUCCESS; amount ≥ maxBudget; token = verified USDC |
| ESCROW_FUNDED | TENDER_OPENED | x402 access payment for activate; resource binds tenderId+version |
| TENDER_OPENED | BIDDING | First valid paid bid or explicit open-bidding event |
| BIDDING | AUCTION_CLOSED | endsAt passed + authentic closure proof |
| AUCTION_CLOSED | WINNER_SELECTED | Independent re-rank matches manifest |
| WINNER_SELECTED | WINNING_AMOUNT_LOCKED | allocate+refundExcess confirmed |
| WINNING_AMOUNT_LOCKED | ROUTE_RESERVED | HCS publish after allocate |
| ROUTE_RESERVED | IN_TRANSIT | Carrier status (signed) |
| IN_TRANSIT | DELIVERY_REPORTED | Carrier delivery notice |
| DELIVERY_REPORTED | POD_SUBMITTED | POD package hash stored; HCS POD_SUBMITTED |
| POD_SUBMITTED | POD_UNDER_REVIEW | AI report optional; review clock starts |
| POD_UNDER_REVIEW | POD_ACCEPTED | Explicit shipper accept |
| POD_UNDER_REVIEW | POD_CORRECTION_REQUESTED | Structured correction before deadline |
| POD_UNDER_REVIEW | POD_DISPUTED | Structured rejection |
| POD_UNDER_REVIEW | POD_DEEMED_ACCEPTED | now ≥ reviewDeadline; no action |
| POD_CORRECTION_REQUESTED | POD_RESUBMITTED | Carrier resubmits before correctionDeadline |
| POD_CORRECTION_REQUESTED | POD_DISPUTED | Correction timeout or reject |
| POD_RESUBMITTED | POD_UNDER_REVIEW | New review window (policy: full or shortened — **deployment policy**) |
| POD_ACCEPTED / POD_DEEMED_ACCEPTED | PAYMENT_RELEASED | Contract release to winner |
| POD_DISPUTED | REFEREE_DECISION | Valid signed referee resolution |
| REFEREE_DECISION | PAYMENT_RELEASED \| PARTIAL_RELEASE \| REFUNDED | Contract executes resolution |
| *release states* | TENDER_COMPLETED | Final HCS + bookkeeping |

**Idempotency rule:** every transition is `(from,to,tenderId,tenderVersion,actionId)` CAS; same actionId replays same result.

### 4.3 Nested machines (implementation detail)

Keep specialized sub-machines for complexity isolation:

- **Auction SM** (existing) — remains for bidding window / closure.  
- **AccessPayment SM** — per protected action: CHALLENGE → SUBMIT → SETTLE_CLAIM → MIRROR → PAID.  
- **Escrow SM** — UNFUNDED → FUNDED → ALLOCATED → RELEASED/REFUNDED/PARTIAL.  
- **POD SM** — subset of lifecycle from DELIVERY_REPORTED onward.

Parent lifecycle state is the product truth; children cannot advance parent illegally.

### 4.4 Existing machines: validity under v2

| Machine | Status |
|---|---|
| Auction SM | **Valid** through WINNER_SELECTED; post-award states move to lifecycle SM |
| Reservation SM | **Valid for v1 / smoke dual-asset path**; **not** the v2 freight-release SM |
| Final-demo attempt statuses | **Valid as v1 baseline**; new v2 demo attempt schema |

---

## 5. Data schemas

### 5.1 Money & token (locked)

| Field | Value | Source |
|---|---|---|
| Token | `0.0.429274` | `VERIFIED_USDC_TOKEN_ID` + live smoke |
| Decimals | **6** | Mirror metadata recorded in `usdc-constants.ts`; smoke evidence `"decimals": 6` |
| Access price display | `0.001` USDC | Product target |
| Access price atomic | **`1000`** | `displayAmountToSmallestUnits("0.001", 6)` |
| Freight amounts | atomic string integers | No floats |

Do not hardcode atomic `1000` without a test that recomputes from display+decimals.

### 5.2 Tender (v2 extensions)

```ts
// Additive fields beyond FreightTender
{
  tenderId, shipperId, origin, destination, cargo, ...,
  maximumFreightPriceCents, // or maximumFreightBudgetAtomic — pick one authority
  maximumFreightBudgetAtomic: string, // preferred authority for escrow
  selectionPolicy: "LOWEST_QUALIFIED_PRICE_V1",
  version: number,
  reviewWindowSeconds: number,      // default 172800 (48h) — config default
  correctionWindowSeconds: number,  // default 86400 (24h)
  escrowContractId: string | null,
  escrowFundTxId: string | null,
  accessTreasuryAccount: string,
}
```

### 5.3 Access payment receipt (durable)

```ts
{
  actionType: "TENDER_ACTIVATE" | "BID_SUBMIT",
  actionId: string,           // idempotency key
  tenderId, tenderVersion,
  bidId?: string,             // for BID_SUBMIT
  payerAccount: string,
  payTo: string,
  asset: "0.0.429274",
  amountAtomic: "1000",
  resource: string,           // exact path bound in challenge
  paymentTransactionId: string,
  paymentConsensusTimestamp: string,
  paymentPayloadHash: string,
  status: "PAID",
}
```

### 5.4 Escrow allocation record

```ts
{
  tenderId, tenderVersion,
  maxBudgetAtomic: string,
  winningAmountAtomic: string,
  excessRefundAtomic: string,
  winnerAccount: string,
  shipperAccount: string,
  allocateTxId: string,
  refundExcessTxId: string | null,
  decisionManifestHash: string,
}
```

### 5.5 POD package (off-chain, encrypted)

```ts
{
  podId, tenderId, bidId, carrierId,
  ciphertextBlobRef: string,     // storage key, not content
  encryption: {
    alg: "AES-256-GCM",
    keyId: string,
    iv: string,
    aadBinding: string,          // hash of tenderId|podId|contentHash
  },
  contentHash: string,           // sha256 of plaintext package
  ciphertextHash: string,
  manifest: {                    // non-sensitive structure counts only
    documentCount: number,
    totalBytes: number,
    mimeTypes: string[],         // optional coarse
  },
  submittedAt: string,
}
```

### 5.6 AI advisory report (non-binding)

```ts
{
  reportId, podId, tenderId,
  engine: string,                // model id — advisory metadata only
  findings: Array<{
    code: "MISSING_SIGNATURE" | "INCONSISTENT_DATES" | "DUPLICATE" | "ANOMALY" | "COMPLETE" | ...,
    severity: "INFO" | "WARN" | "FAIL",
    message: string,             // no raw PII dumps
  }>,
  completenessScore: number | null, // optional; never authorizes release
  reportHash: string,
  createdAt: string,
  binding: "NON_BINDING_ADVISORY",
}
```

### 5.7 Shipper review action

```ts
{
  action: "ACCEPT" | "REQUEST_CORRECTION" | "REJECT_DISPUTE",
  tenderId, podId,
  shipperId,
  reasons?: StructuredReason[],  // required for correction/reject
  signature: string,
  signedAt: string,
  reviewDeadlineAt: string,      // bound at action time for audit
}
```

### 5.8 Referee resolution

```ts
{
  disputeId, tenderId, podId,
  resolution: "RELEASE_FULL" | "REFUND_FULL" | "PARTIAL",
  releaseAmountAtomic: string,
  refundAmountAtomic: string,
  rationaleCode: string,         // structured; free text off-chain
  refereeId: string,
  refereePublicKey: string,
  signature: string,
  signedPayloadHash: string,
  decidedAt: string,
}
```

---

## 6. API contracts

All amounts atomic strings; all times UTC ISO-8601; all mutating POSTs require `Idempotency-Key` / `actionId`.

### Access-gated

| Method | Path | Gate | Success |
|---|---|---|---|
| `POST` | `/api/v2/tenders/:tenderId/activate` | x402 exact 1000 USDC | 200 `{ state: TENDER_OPENED, accessPayment, hcsOpen? }` |
| `POST` | `/api/v2/tenders/:tenderId/bids` | x402 exact 1000 USDC | 200 `{ bidId, commitmentPending, accessPayment }` |

Unauthenticated first hit → **HTTP 402** with `PAYMENT-REQUIRED` (surface A style), same as USDC smoke.

### Escrow / lifecycle (authenticated app roles; not x402 freight)

| Method | Path | Role | Purpose |
|---|---|---|---|
| `POST` | `/api/v2/tenders` | Shipper | Create DRAFT |
| `POST` | `/api/v2/tenders/:id/escrow/fund` | Shipper | Build/submit fund intent or record external fund |
| `POST` | `/api/v2/tenders/:id/close` | Operator | Barrier + evaluate |
| `POST` | `/api/v2/tenders/:id/allocate` | Operator | Contract allocate after winner |
| `POST` | `/api/v2/tenders/:id/status` | Carrier | IN_TRANSIT / DELIVERY_REPORTED |
| `POST` | `/api/v2/tenders/:id/pod` | Carrier | Upload encrypted POD + metadata |
| `GET`  | `/api/v2/tenders/:id/pod/advisory` | Shipper/Referee | AI report |
| `POST` | `/api/v2/tenders/:id/review` | Shipper | ACCEPT / CORRECTION / REJECT |
| `POST` | `/api/v2/tenders/:id/pod/resubmit` | Carrier | POD_RESUBMITTED |
| `POST` | `/api/v2/tenders/:id/disputes/:disputeId/resolve` | Referee | Signed resolution |
| `POST` | `/api/v2/tenders/:id/timeouts/tick` | Operator/worker | Deemed acceptance processing |
| `GET`  | `/api/v2/tenders/:id` | Parties | Public-safe status view |
| `GET`  | `/api/v2/tenders/:id/evidence` | Judge Mode | HCS + payment index |

### Challenge binding requirements

Access challenge must bind:

- `scheme=exact`, `network=hedera:testnet`, `asset=0.0.429274`, `amount=1000`
- `payTo=ACCESS_TREASURY`
- `resource` = exact path including tenderId (and bidId/actionId where applicable)
- Optional description: `TENDER_ACTIVATE` / `BID_SUBMIT`

Reuse `src/reservation/challenge.ts` binding pattern; **do not** reuse reservation fee amounts.

---

## 7. HCS message contracts

### 7.1 Schema versioning

- Keep v1 envelopes readable: `routeguard-hcs-1.0` historical.  
- Introduce **`routeguard-hcs-2.0`** for v2 lifecycle messages (or additive `messageType`s with careful payload budget).  
- Hard limit remains **`< 1024` bytes**.

### 7.2 Message types

| Type | When | Public payload (no PII) |
|---|---|---|
| `AUCTION_OPEN` / `TENDER_OPENED` | After activate paid | tenderId/version/hash, endsAt, policy, **accessPaymentTxId**, escrowContractId, maxBudgetAtomic |
| `BID_COMMITMENT` | After bid access paid + commitment built | existing + **accessPaymentTxId** / accessPaymentHash |
| `AUCTION_CLOSE_BARRIER` | Close | existing |
| `WINNER_ALLOCATED` | After allocate | winningBidId, winnerAccount, winningAmountAtomic, excessRefundAtomic, allocateTxId, refundTxId, manifestHash |
| `ROUTE_RESERVED` | After allocate | Align with allocate; drop reservation-fee-centric fields or dual-version |
| `POD_SUBMITTED` | POD stored | podId, contentHash, ciphertextHash, size, carrierId |
| `POD_ADVISORY_ANCHORED` | Optional | reportHash only |
| `POD_REVIEW_ACTION` | Accept/correct/reject | action enum, actor role hash/id, deadline refs |
| `POD_DEEMED_ACCEPTED` | Timeout | reviewDeadline, tickId |
| `DISPUTE_OPENED` | Reject | disputeId, podId |
| `REFEREE_RESOLUTION` | Decision | resolution enum, amounts, resolutionHash (not free text) |
| `ESCROW_RELEASED` / `ESCROW_REFUNDED` / `ESCROW_PARTIAL` | Funds moved | txIds, amounts, accounts |

### 7.3 Privacy rules (fail-closed)

Never on HCS: names, addresses, phone, plate numbers, POD images, signatures images, free-text dispute narratives, private keys, payment payloads, full bids, salts.

---

## 8. Escrow-contract interface

**Greenfield.** No Solidity in repo today. Recommended: Hedera Smart Contract Service + HTS via system contracts (`IHRC` / token associate + transfer).

### 8.1 Interface (logical ABI)

```solidity
// Logical interface — not implementation
function fund(bytes32 tenderId, int64 maxBudget) // USDC transfer-in
function allocate(
  bytes32 tenderId,
  address winner,
  int64 winningAmount,
  bytes32 decisionManifestHash
) // lock winning; refund excess to shipper
function release(bytes32 tenderId, bytes32 authorizationHash)
function refund(bytes32 tenderId, bytes32 authorizationHash)
function partialRelease(
  bytes32 tenderId,
  int64 toWinner,
  int64 toShipper,
  bytes32 authorizationHash
)
function openDispute(bytes32 tenderId)
function applyRefereeResolution(
  bytes32 tenderId,
  uint8 outcome,
  int64 toWinner,
  int64 toShipper,
  bytes resolutionSig
)
```

### 8.2 Authorization model (recommended)

- **Fund:** shipper only (or anyone paying for shipper — policy).  
- **Allocate:** RouteGuard operator key *or* multisig; must verify off-chain that HCS/manifest authorize amounts; bind `decisionManifestHash` on-chain.  
- **Release on accept / deemed accept:** operator submits with authorization hash of shipper signature or timeout proof.  
  *Stricter variant (prefer long-term):* contract verifies shipper ECDSA/ed25519 — may exceed demo scope; document as Phase C vs E.  
- **Referee:** on-chain referee public key allowlist or EIP-712-like signed resolution verified in contract.  
- **AI:** no contract role.

### 8.3 State in contract (minimal)

`tenderId → { shipper, maxBudget, lockedAmount, winner, status, decisionManifestHash, disputeOpen }`

### 8.4 Explicit non-goals

- Not Scheduled Transaction escrow (ADR exclusion can remain for that specific mechanism).  
- Not x402 for freight principal.  
- Not EVM payment path for access fees.

### 8.5 Feasibility

Hedera SCS can hold/transfer HTS USDC — **ESCROW_FEASIBLE=YES**, with implementation + association + testnet deploy work in Phase C.

---

## 9. POD storage & encryption design

| Concern | Design |
|---|---|
| Storage | Off-chain object store / local `data/v2-pods/` for testnet demo |
| Encryption | AES-256-GCM; per-POD data key; data key wrapped to shipper+carrier+referee key ring |
| Integrity | `contentHash = sha256(plaintext)`; store ciphertext separately; HCS anchors both hashes |
| Access | Application authorization; decrypt only in review plane |
| Retention | Deployment policy (days); not protocol constant |
| Virus/size limits | App policy; reject oversize before hash |
| Dedup | contentHash uniqueness per tender (anomaly if duplicate across tenders) |

**Boundary:** storage adapter interface `putPod`, `getPodCiphertext`, `headMetadata` — no AI or escrow imports into storage module.

---

## 10. AI advisory boundary

| Allowed | Forbidden |
|---|---|
| Read POD plaintext in isolated worker | Call escrow `release` / `refund` |
| Emit structured findings + reportHash | Auto-transition to POD_ACCEPTED |
| Anchor reportHash on HCS (optional) | Appear as on-chain authority |
| Assist referee with same report type | Modify shipper deadlines |

**Interface:**

```ts
interface PodAssuranceAdviser {
  review(input: {
    tenderPublic: PublicTenderView;
    podMeta: PodPublicMeta;
    plaintextPackage: PodPlaintext; // only inside secure worker
  }): Promise<AdvisoryReport>;
}
```

Trust-critical path remains deterministic TypeScript. Model choice, prompts, and thresholds are **deployment policy**.

---

## 11. Acceptance / timeout / dispute design

### Windows (defaults — config, not hardcoded protocol)

| Window | Default | Starts when |
|---|---|---|
| Review | 48h | `POD_UNDER_REVIEW` entered |
| Correction | 24h | `POD_CORRECTION_REQUESTED` |
| Post-resubmit review | policy (recommend full 48h or 24h) | `POD_RESUBMITTED` → `POD_UNDER_REVIEW` |

### Shipper actions

1. **ACCEPT** → `POD_ACCEPTED` → escrow release full locked amount → `PAYMENT_RELEASED`.  
2. **REQUEST_CORRECTION** (structured codes required) → correction window.  
3. **REJECT_DISPUTE** (structured codes required) → `POD_DISPUTED` → funds remain locked → `openDispute`.

### Silence

Worker at/after `reviewDeadline` with no valid action → `POD_DEEMED_ACCEPTED` → same release path as accept.  
Must be **idempotent** and HCS-audited with `tickId`.

### Correction timeout

If no valid resubmit by `correctionDeadline` → auto `POD_DISPUTED` or auto reject policy — **must be locked** (recommend dispute to protect carrier/shipper ambiguity).

---

## 12. Referee authorization model

| Element | Spec |
|---|---|
| Identity | `refereeId` + public key in deployment allowlist |
| Appointment | Per-tender or global; recorded off-chain + HCS dispute open |
| Authority | Only while `POD_DISPUTED` |
| Artifact | Signed resolution over canonical payload (amounts, outcome, tenderId, podId, disputeId) |
| Verification | App verifies signature; contract verifies if Phase E on-chain path enabled |
| AI | Optional advisory input; resolution signature is solely human referee |
| Partial | `toWinner + toShipper == lockedAmount` (strict conservation) |

Compromise of referee key is catastrophic for locked funds — mitigate with short-lived appointment keys and multi-sig later (**policy**).

---

## 13. Security & privacy threats

| Threat | Mitigation |
|---|---|
| Double spend access payment / replay | Settle-claim CAS; resource+actionId binding; Mirror SUCCESS |
| Bid spam without payment | x402 gate before durable accept |
| Allocate without real winner | Bind decisionManifestHash; re-rank before allocate |
| Early release | Contract status machine; no AI keys |
| Timeout griefing (clock skew) | UTC deadlines from server; Mirror timestamps for chain events |
| POD plaintext leak on HCS | Schema prohibitions + size tests |
| Referee forgery | Allowlist keys; canonical signed payload |
| Facilitator drift | Existing `/supported` preflight |
| Wrong token / decimals | Fail closed unless `0.0.429274` + decimals 6 |
| Idempotent storm | Keyed mutex + versioned records (existing pattern) |
| Access fee paid to wrong party | Challenge `payTo` = treasury only |
| Freight confused with access | Separate modules, separate evidence panels, separate economics docs |
| PII in AI logs | Redaction policy; no raw POD in app logs |
| Re-running v1 live demo | Guards + explicit prohibition; v2 uses new evidence paths |

---

## 14. Test strategy

### Tests that remain valid (keep green)

| Suite | Why still valid |
|---|---|
| `auction-*.test.ts`, `decision-manifest.test.ts` | Selection math unchanged |
| `hcs-message-envelope.test.ts`, `hcs-reconciliation.test.ts` | v1 schema still true |
| `usdc-smoke-*.test.ts`, `hbar-smoke-*.test.ts` | Challenge compliance surface A |
| `payment-payload-canonical.test.ts` | Hash hygiene |
| `hedera-transfer-costs.test.ts` | Network fee metadata |
| `reservation-*.test.ts` (most) | v1 reservation path + patterns |
| `final-demo*.test.ts` | v1 baseline regression — **pin** so v2 changes do not mutate live evidence expectations |
| `final-demo-report.test.ts` | Presentation of **v1** evidence |

### New Phase A tests (offline)

- Lifecycle legal/illegal transitions  
- Access fee atomic derivation (`0.001` → `1000`)  
- HCS v2 envelope size `< 1024`  
- POD schema rejects PII fields  
- Advisory report cannot trigger release reducer  
- Deemed-acceptance boundary times  
- Referee signature verify / reject  
- Escrow amount conservation (`win + excess == max`, `release + refund == locked`)

### Phase B+

- Dual-route x402 middleware integration (mock facilitator)  
- Live testnet: one activate + one bid payment (guarded)  
- Contract unit + integration on testnet  
- Timeout worker determinism  
- End-to-end v2 demo dry then live

---

## 15. Migration plan

1. **Freeze v1**  
   - Tag docs: “v1 capacity-reservation baseline”.  
   - Do not re-run `demo:final-auction` live.  
   - Evidence paths stay authoritative.

2. **ADR-002**  
   - Reopen architecture for HTS escrow + dual payment rails.  
   - Reaffirm: no freight via x402; no AI release; testnet-only until mainnet ADR.

3. **Code layout**  
   - Prefer `src/v2/*` for new lifecycle/escrow/pod without breaking v1 imports.  
   - Or feature-flag modules under `src/lifecycle`, `src/escrow`, `src/pod`.

4. **Economics rewrite**  
   - README / page / compliance matrix: three amounts — access fee, freight escrow, network transfer cost.

5. **Demo path**  
   - New `demo:v2-*` scripts; never overwrite `evidence/final-demo-result.json`.

6. **Website** after backend phases A–E stable offline + testnet slices.

---

## 16. Incremental file plan by phase

### Phase A — schemas, SM, persistence, HCS defs, offline tests

| Action | Paths (proposed) |
|---|---|
| Add | `src/v2/lifecycle/states.ts`, `state-machine.ts` |
| Add | `src/v2/access/fee.ts` (derive 1000 atomic) |
| Add | `src/v2/schemas/tender.ts`, `pod.ts`, `advisory.ts`, `referee.ts`, `access-receipt.ts` |
| Add | `src/hcs/v2-types.ts`, envelope builders |
| Add | `src/v2/store/*` CAS persistence |
| Add | `test/v2-lifecycle-*.test.ts`, `test/v2-access-fee.test.ts`, `test/v2-hcs-envelope.test.ts` |
| Update | `docs/ADR-002-v2-escrow-pod-architecture.md` |
| Do not touch | `evidence/final-demo-*`, live reservation records |

### Phase B — x402 tender + bid gates (testnet)

| Action | Paths |
|---|---|
| Add | `src/v2/access/routes.ts` (multi-route middleware) |
| Add | `src/v2/access/payment-service.ts` (claim/settle/mirror — adapt reservation patterns) |
| Wire | `src/server/app.ts` register v2 routes |
| Add | clients + `test/v2-access-gate*.test.ts` |
| Evidence | `evidence/v2-access-tender-payment.*`, `evidence/v2-access-bid-payment.*` (new) |

### Phase C — escrow contract

| Action | Paths |
|---|---|
| Add | `contracts/FreightEscrow.sol` (or equivalent) |
| Add | `src/v2/escrow/abi.ts`, `client.ts`, `allocate.ts` |
| Scripts | `scripts/v2-deploy-escrow.ts`, fund/allocate dry+live guards |
| Tests | contract + adapter offline mocks |

### Phase D — POD + AI + shipper review

| Action | Paths |
|---|---|
| Add | `src/v2/pod/storage.ts`, `encryption.ts`, `routes.ts` |
| Add | `src/v2/advisory/adviser.ts` (interface + stub/provider) |
| Add | review API + HCS anchors |
| Tests | encryption, schema, non-binding boundary |

### Phase E — timeout, dispute, referee, release

| Action | Paths |
|---|---|
| Add | `src/v2/timeouts/worker.ts` |
| Add | `src/v2/dispute/*`, referee verify |
| Escrow | release/refund/partial paths |
| Tests | deadline matrix, signature, conservation |

### Phase F — website, Judge Mode, E2E demo

| Action | Paths |
|---|---|
| Update | `src/server/page.ts` — escrow, access fees, POD, dispute panels |
| Add | `scripts/render-v2-demo-report.ts`, `docs/demo-script-v2.md` |
| Add | Judge Mode evidence explorer routes |
| Brand | reuse production SVGs; do not alter Hedera marks |

---

## 17. Bounty demo plan (minimum truthful v2 claim)

**Do not claim v2 live completeness until the following exist as real testnet artifacts:**

| Step | Real testnet proof |
|---|---|
| 1 | Shipper funds escrow with max budget USDC |
| 2 | x402 tender activation payment (0.001 USDC) — HTTP 402→200 |
| 3 | ≥1 carrier x402 bid access payment |
| 4 | HCS open + commitments + barrier |
| 5 | Winner allocate + excess refund txs |
| 6 | ROUTE_RESERVED / WINNER_ALLOCATED on HCS |
| 7 | POD submit (encrypted) + HCS hash message |
| 8 | One of: explicit accept **or** deemed accept **or** referee partial — with matching escrow release/refund |

**Truthful claim language**

- Access micro-payments via x402 exact USDC.  
- Freight principal in HTS escrow (not x402).  
- AI advisory non-binding.  
- Synthetic business data OK if labeled; chain txs real.

**v1 claim remains** for capacity-reservation demo on topic `0.0.9794225` — separate narrative panel.

---

## 18. Decisions that must be locked before Codex implementation

1. **ADR-002 approved** — reopen frozen “no escrow” for HTS smart-contract escrow only.  
2. **Money authority** — `maximumFreightBudgetAtomic` vs cents-only; conversion rule.  
3. **Access `payTo` account** — platform treasury id (testnet).  
4. **Access amount** — confirm product **0.001 USDC = 1000 atomic** (decimals 6).  
5. **Escrow auth** — operator-mediated release vs on-chain shipper/referee verify for demo.  
6. **Correction timeout policy** — dispute vs refund vs other.  
7. **Post-resubmit review window** — 48h vs 24h.  
8. **POD encryption key custody** — who can decrypt in demo.  
9. **Referee key management** — single key vs multisig.  
10. **HCS schema** — new `2.0` vs additive types on `1.0`.  
11. **Whether v1 reservation dual-rail remains** in product UI or only smoke/compliance.  
12. **v2 evidence path naming** — never overwrite `evidence/final-demo-result.json`.  
13. **AI provider** — stub for Phase D offline vs live model; still non-binding.  
14. **No live final-auction re-run** remains absolute.  
15. **Website scope** — Phase F only after A–E acceptance criteria.

---

## Website changes required after backend (Phase F summary)

| Surface | Change |
|---|---|
| Dev shell sections | Escrow funded status; access-fee 402 panel; bid payments; allocate/refund; POD review countdown; dispute; referee |
| Payment summary | Three-line economics: access / freight locked / network fee |
| Remove/confuse | “Reservation fee = settlement” as sole story |
| Judge Mode | Sequence explorer for v2 HCS types + HashScan links |
| Report | New v2 report generator; keep v1 report intact |
| How-it-works | Trust lane steps extended through POD/release |

---

## Reusable vs conflicting (summary)

**Reusable:** auction ranking/eligibility/manifest; HCS envelope discipline; x402 exact USDC stack; facilitator preflight; CAS/settle-claim/Mirror recovery patterns; canonical hashing; brand/report tooling; live-write guards.

**Conflicting:** single reservation-fee settlement story; ADR no-escrow; ROUTE_RESERVED payment fields as freight; LLM total ban vs advisory AI; auction terminal = product terminal; `freightPriceCents` without atomic escrow mapping.

---

## Exact access fee derivation (verified)

| Input | Value |
|---|---|
| Token | `0.0.429274` (Circle Hedera Testnet USDC) |
| Decimals | **6** (code + Mirror metadata + `evidence/usdc-smoke-payment.json`) |
| Display | `0.001` |
| Atomic | **`1000`** (`0.001 × 10^6`) |

Live smoke used `10000` atomic for **0.01** USDC — consistent with decimals 6 (`0.01 × 10^6 = 10000`).

---

## Machine-readable flags

```
CURRENT_V1_BASELINE_PRESERVABLE=YES
X402_TENDER_GATE_FEASIBLE=YES
X402_BID_GATE_FEASIBLE=YES
TOKEN_DECIMALS_VERIFIED=YES
ESCROW_FEASIBLE=YES
POD_WORKFLOW_FEASIBLE=YES
AI_ADVISORY_BOUNDARY_FEASIBLE=YES
TIMEOUT_ACCEPTANCE_FEASIBLE=YES
DISPUTE_RESOLUTION_FEASIBLE=YES
PHASE_A_READY_FOR_CODEX=YES
NETWORK_WRITES=0
```

**Note on Phase A:** Ready for Codex **after** owner locks the decisions in §18 (especially ADR-002, money authority, correction timeout, access treasury). Schema/SM work can scaffold with stated defaults (48h/24h, atomic budget strings, 1000 access fee) if the owner accepts those as interim constants marked `CONFIG_DEFAULT`.