# RouteGuard v2 — freight-principal escrow (Phase C1 + C2 + E1)

Reference for `contracts/RouteGuardFreightEscrow.sol` and the TypeScript
boundary under `src/v2/escrow/`.

> **Phase C2 status (2026-07-31): live on Hedera testnet.** The freight-principal
> escrow contract is deployed, associated with HTS USDC, funded with a synthetic
> 1.00 USDC budget, and allocated (0.75 USDC locked / 0.25 USDC excess refunded).
> Evidence: `evidence/v2/escrow/`. No x402 access payment was repeated. No HCS
> write. No POD, dispute, or freight release.

---

## 1. Purpose and separation from x402

| | x402 access fee | Freight principal |
|---|---|---|
| What it buys | Tender activation / durable bid submission | The transport itself |
| Amount | Exactly `1000` atomic (0.001 USDC) | `maximumFreightBudgetAtomic` per tender |
| Recipient | RouteGuard access treasury | Escrow contract, then carrier and/or shipper |
| Mechanism | x402 `exact` scheme, facilitator settlement | HTS USDC held by this contract |
| Proven | Live on testnet (Phase B2b) | **Live on testnet (Phase C2)** |

Both use HTS USDC `0.0.429274` on testnet, and that is their only overlap. The
freight principal is never presented as an x402 access payment, and the access
fee never enters the escrow contract — a 1000-atomic "funding" attempt for a
1,000,000-atomic tender is rejected as an amount mismatch.

## 2. Contract model

One contract custodies many tenders, keyed by a canonical `bytes32` tender key:

```
tenderKey = keccak256(abi.encode(
  keccak256("ROUTEGUARD_V2_FREIGHT_ESCROW_TENDER_KEY_V1"),  // domain separator
  keccak256(utf8(tenderId)),                                 // identity hash
  uint32(tenderVersion)
))
```

Registration recomputes the key from `(tenderIdHash, tenderVersion)` and rejects
any mismatch, so a hash minted for another purpose can never occupy a tender
slot, and two tender versions are always distinct slots.

The HTS USDC token is `immutable` and bound at construction. There is no
per-tender token and no setter.

### States

```
UNREGISTERED → REGISTERED → FUNDED → ALLOCATED → RELEASED
                              │          │     ↘ DISPUTED → RELEASED
                              │          │                ↘ REFUNDED
                              │          │                ↘ PARTIALLY_RELEASED
                              ↘ REFUNDED (no qualified bid)
```

`RELEASED`, `REFUNDED`, and `PARTIALLY_RELEASED` are terminal: every other
entry point reverts from them (proved by the offline tests).

### Money rules

- **Exact funding.** `fundTender` requires `amount == maxBudget`. Underfunding
  and overfunding both revert — the Phase A policy, unchanged. No unmodeled
  residual can enter the escrow.
- **Allocation conservation.** `excess = fundedAmount - winningAmount`, the
  winning amount is locked, and the exact excess is returned to the shipper in
  the same transaction:
  `winningAmount + excessRefunded == fundedAmount`.
  After allocation the tender's escrow balance equals exactly the winning
  amount, and **the carrier has received nothing**.
- **Settlement moves only the locked amount**, always in full: to the carrier
  (`releaseFull` / `resolveDisputeRelease`), to the shipper (`refundFull`), or
  split with strict conservation (`partialRelease`).
- **Integer safety.** Amounts arrive as `uint256`, are bounded to
  `int64.max` (`9223372036854775807`), and only then narrowed to `uint64`, so a
  value like `2^64 + budget` can never wrap into a valid amount.
  `totalEscrowedAmount` tracks the aggregate unsettled balance and always equals
  the sum of per-tender balances.

## 3. Operations

| Function | Caller | From state | To state |
|---|---|---|---|
| `registerTender` | operator | `UNREGISTERED` | `REGISTERED` |
| `fundTender` | **registered shipper** | `REGISTERED` | `FUNDED` |
| `allocateWinner` | operator | `FUNDED` | `ALLOCATED` (+ excess refund) |
| `refundNoQualifiedBid` | operator | `FUNDED` | `REFUNDED` |
| `releaseFull` | operator | `ALLOCATED` | `RELEASED` |
| `openDispute` | operator | `ALLOCATED` | `DISPUTED` |
| `resolveDisputeRelease` | operator | `DISPUTED` | `RELEASED` |
| `refundFull` | operator | `DISPUTED` | `REFUNDED` |
| `partialRelease` | operator | `DISPUTED` | `PARTIALLY_RELEASED` |
| `associateEscrowToken` | operator | — | — (HTS association) |

Once a dispute is open the **ordinary** `releaseFull` path is closed; only the
three referee-authorized resolutions can settle the tender.

## 4. Authorization model (demo)

- A tightly scoped operator role via OpenZeppelin `Ownable2Step`: transfer is
  two-step, so the role can never be handed to an address that has not accepted
  it, and it is never left unowned.
- Only the operator registers, allocates, opens disputes, and executes
  settlement. Only the **registered shipper** can fund their own tender. No
  other caller can move freight funds.
- RouteGuard verifies shipper and referee signatures **off-chain** (Phase A
  domain-separated ECDSA over canonical payloads) and submits the resulting
  canonical authorization hash. The contract records that hash and enforces
  **global single use** — an authorization hash consumed anywhere can never be
  replayed, on this tender or another.
- **AI has no authority.** The contract accepts no model output, evaluates no
  POD document, and an "AI advisory" is simply an unauthorized caller. The AI
  POD adviser remains non-binding, exactly as ADR-002 requires.

### Limitations of this model

The contract trusts the operator to submit only hashes that a verified
signature produced. A compromised operator key could settle a tender in a way
no shipper or referee authorized, though it still cannot violate conservation,
exceed the locked amount, pay an unregistered address, or escape a terminal
state. Production hardening options — on-chain ECDSA verification of the
shipper/referee signature, an operator multisig, or a timelock on dispute
resolutions — are documented goals, not part of this phase.

## 5. HTS token transfer

`RouteGuardFreightEscrow` calls the Hedera Token Service system contract at
`0x167`:

- `transferToken(token, from, to, int64 amount)` for every movement;
- `associateToken(this, token)` once, before the contract can hold a balance;
- **every response code is checked** — anything other than `SUCCESS` (22)
  reverts the whole transaction, so contract state can never diverge from token
  balances (`TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT` is accepted for association
  idempotency);
- the HTS precompile is the **only** external callee: there is no arbitrary
  call target, no `delegatecall`, no upgrade or proxy surface, and no sweep or
  rescue function.

State changes are written **before** any transfer (checks-effects-interactions),
and every state-changing entry point is `nonReentrant`.

The state machine lives in the abstract `RouteGuardFreightEscrowBase`; the
production contract implements the transfer primitives over HTS, and the
offline test contract implements them over an in-contract ledger. The logic
under test is therefore the deployed logic — only the token rail differs.

## 6. Events

`TenderEscrowRegistered`, `TenderEscrowFunded`, `WinnerAllocated`,
`ExcessRefunded`, `NoWinnerRefunded`, `DisputeOpened`, `FreightReleased`,
`FreightRefunded`, `FreightPartiallyReleased`.

Events carry only tender keys, versions, addresses, atomic amounts, and hashes.
No private tender data, POD content, name, postal address, bid body, bid salt,
signature, private key, or dispute narrative is ever passed to the contract, so
none can appear in an event. `src/v2/escrow/events.ts` additionally projects
parsed events through an explicit per-event field allowlist.

## 7. TypeScript boundary (`src/v2/escrow/`)

| Module | Role |
|---|---|
| `tender-key.ts` | Canonical key derivation (byte-identical to the contract), identity/address/hash validation, Hedera→EVM long-zero conversion |
| `amounts.ts` | Atomic-string validation, HTS `int64` bounds, allocation and partial conservation |
| `abi.ts` | Exported ABI, asserted against the compiled contract by the test suite |
| `requests.ts` | Pure transaction-plan builders for all nine operations |
| `events.ts` | Public-safe event parser + execution-result parser |
| `states.ts` | Escrow state enum mirroring the on-chain ordinals |
| `lifecycle-map.ts` | Lifecycle ↔ escrow operation mapping |

Builders are pure: they validate and return typed argument plans marked
`networkWrite: true`. They never sign, submit, read the environment, or load a
key. Money is always an atomic integer string — never a JS number or float.

### Lifecycle mapping

| Lifecycle | Escrow |
|---|---|
| `DRAFT` | → `registerTender` |
| `ESCROW_FUNDED` | ← Mirror-confirmed `FUNDED` |
| `WINNER_SELECTED` | → `allocateWinner` |
| `WINNING_AMOUNT_LOCKED` | ← Mirror-confirmed `ALLOCATED` + exact excess handling |
| `ROUTE_RESERVED` | only after `WINNING_AMOUNT_LOCKED` |
| `NO_QUALIFIED_BID` | → `refundNoQualifiedBid` |
| `POD_ACCEPTED` / `POD_DEEMED_ACCEPTED` | → `releaseFull` |
| `POD_DISPUTED` | → `openDispute` |
| `REFEREE_DECISION` | → `resolveDisputeRelease` / `refundFull` / `partialRelease` |

This mapping is declarative. It performs no I/O, never fabricates a
confirmation, and does not weaken the lifecycle reducer, which remains the sole
authority for legal transitions.

## 8. Offline test status

| Suite | Coverage |
|---|---|
| `test/escrow-contract-registration.test.ts` | Registration, exact funding, allocation, excess refund, no-winner refund |
| `test/escrow-contract-settlement.test.ts` | Release, dispute, referee resolutions, terminal-state protection |
| `test/escrow-contract-security.test.ts` | Reentrancy, transfer failure, unsafe narrowing, multi-tender isolation, accounting integrity, access control, ABI parity |
| `test/v2-escrow-boundary.test.ts` | Tender keys (incl. on-chain parity), money validation, builders, lifecycle mapping, event/result parsing, no-network assertion |

Run with `npm run contracts:compile` and `npm run contracts:test` (or the full
`npm test`, which includes them).

## 9. Phase C2 — live testnet demonstration (completed)

Guarded runner: `npm run demo:v2-escrow-live` → `scripts/run-v2-escrow-live.ts`.

### Guards

| Env | Required value |
|---|---|
| `ROUTEGUARD_LIVE_V2_ESCROW_CONFIRM` | `I_UNDERSTAND_TESTNET_ESCROW_WRITES` |
| `ROUTEGUARD_LIVE_V2_ESCROW_MAX_WRITES` | `10` |
| `ENABLE_LIVE_HEDERA` | `true` |
| `HEDERA_NETWORK` | `hedera:testnet` |
| `USDC_TOKEN_ID` | `0.0.429274` |

Hard successful-write ceiling: **10**. No x402 settlement, no HCS, no POD, no
`releaseFull` / dispute / partial settlement in this phase.

### Live run (2026-07-31)

| Field | Value |
|---|---|
| Run ID | `v2escrow-20260731-88bbd727` |
| Contract ID | `0.0.9861047` |
| EVM address | `0x00000000000000000000000000000000009677b7` |
| Token | `0.0.429274` (decimals 6) |
| Tender | `V2-ESCROW-DEMO-v2escrow-20260731-88bbd727` v1 |
| Max budget | **1.00 USDC** (1,000,000 atomic) |
| Winning amount | **0.75 USDC** (750,000 atomic) locked |
| Excess refund | **0.25 USDC** (250,000 atomic) to shipper |
| Contract balance after allocation | 750,000 atomic |
| Carrier freight received | **0** |
| Contract state | `ALLOCATED` |
| Successful network writes | **10** |
| HCS writes | **0** |
| x402 writes | **0** |

| Step | Transaction ID |
|---|---|
| Contract create | `0.0.9197513@1785528457.557374203` |
| Associate | `0.0.9197513@1785528465.153884715` |
| Register | `0.0.9197513@1785528470.540863049` |
| Allowance (exact 1,000,000) | `0.0.9197513@1785528474.333213938` |
| Fund | `0.0.9197513@1785528475.735005438` |
| Allocate | `0.0.9197513@1785528486.479519241` |

Sanitized evidence: `evidence/v2/escrow/`. Phase B access evidence and v1
`evidence/final-demo-*` are unchanged.

### Deployment notes

- Hedera bytecode files must store the **hex-encoded ASCII** of the solc object
  (not raw EVM bytes). Raw binary produces `ERROR_DECODING_BYTESTRING`.
- Constructor: `(token, operator)` with Mirror-confirmed EVM addresses.
- Association: `associateEscrowToken()` once after create.
- Allowance: exact budget only (never unlimited).
- Mirror verification of every transaction and post-step USDC balance deltas.

### Truthful claim boundary (as of Phase C2)

- RouteGuard freight escrow is live on Hedera **testnet**.
- The contract holds real HTS testnet USDC.
- The shipper funded the maximum **synthetic** freight budget.
- RouteGuard allocated the winning amount; unused budget returned to the shipper.
- The winning amount remained locked at this checkpoint; the carrier had
  received **no** freight principal yet.
- Existing x402 access-payment evidence remains separate.
- Business tender and bid data are synthetic demonstration data.

**Superseded by §10:** Phase D2 anchored the POD and shipper acceptance, and
Phase E1 released the locked principal to the carrier.

## 10. Phase E1 — live freight release and completion (completed)

Run ID `v2rel-20260731-b4c817df`, runner `scripts/run-v2-release-live.ts`
(`npm run demo:v2-release-live`), evidence in `evidence/v2/release/`.

**STATE_CHANGING_NETWORK_WRITES=3** — one `releaseFull` contract call and two
HCS messages. **X402_WRITES=0.** **QUERY_PAYMENT_TRANSACTIONS=0**: every escrow
state read uses the free Mirror Node `contracts/call` endpoint.

Guards required before any write:

```
ROUTEGUARD_LIVE_V2_RELEASE_CONFIRM=I_UNDERSTAND_TESTNET_FREIGHT_RELEASE
ROUTEGUARD_LIVE_V2_RELEASE_MAX_WRITES=3
ENABLE_LIVE_HEDERA=true
```

`ROUTEGUARD_LIVE_V2_RELEASE_DRY_PREFLIGHT=true` runs every guard, evidence
binding check, acceptance re-verification, and read-only query, then stops
before the first write.

### What authorized the release

The Phase D2 shipper ACCEPT was re-verified from immutable evidence before the
call, not merely trusted:

1. The canonical `ROUTEGUARD_V2_SHIPPER_POD_REVIEW` payload was rebuilt from the
   recorded tender/POD identity, action, `actionId`, `signedAt`, and review
   deadline; its hash matches both the Phase D2 evidence and the durable
   lifecycle record's `lastShipperAuthPayloadHash`.
2. Hiero ECDSA signing is RFC6979-deterministic, so re-signing that payload with
   the configured shipper key reproduces the **original signature bytes**; the
   rebuilt `POD_ACCEPTED_BY_SHIPPER` event hash equals the `eventPayloadHash`
   committed in Phase D2.
3. The signature verifies against the shipper key in the durable trust snapshot.
4. The contract authorization hash is **re-derived** from the accepted POD
   identity and content hash and must equal the prepared plan's hash.
5. The `releaseFull` plan is rebuilt with the production builder under
   `requirePhaseC2LiveBindings`, and its plan hash must equal the Phase D2 one.

### Release transaction

| Field | Value |
|---|---|
| Transaction | `0.0.9197513@1785536472.599444485` |
| Function | `releaseFull(bytes32,bytes32)` |
| Tender key | `0x30741f72dc23ac11d4fee37878d9c3fc7fe000377f87cb55ff2196cc82e79f89` |
| Authorization hash | `0xc66ae24790348c848c7a8749c444b6947a47bc9760a18d2978c67bdb016c7aeb` |
| Released | **750,000 atomic USDC** (0.75) of `0.0.429274` |
| From → to | escrow `0.0.9861047` → carrier `0.0.9215954` |
| `FreightReleased` | tenderKey / winner / amount / authHash match; `fromDispute=false` |

The HTS transfer legs appear on the **child** `CRYPTOTRANSFER` spawned by the
precompile, not on the parent `CONTRACTCALL`; verification aggregates both.

| Account | Before | After | Delta |
|---|---|---|---|
| Carrier `0.0.9215954` | 22,000 | 772,000 | **+750,000** |
| Escrow `0.0.9861047` | 750,000 | 0 | **−750,000** |
| Shipper `0.0.9197513` | 19,228,000 | 19,228,000 | 0 |

Final contract state **`RELEASED`**, tender locked balance **0**, total escrowed
**0**, and `authorizationHashUsed` is now **true** — the authorization is
globally single-use and `RELEASED` is terminal, so the release cannot be
replayed.

### Complete HCS evidence chain — topic `0.0.9862010`

| Seq | Message | Phase | Transaction |
|---|---|---|---|
| 1 | `POD_SUBMITTED` | D2 | `0.0.9197513@1785534396.504175067` |
| 2 | `POD_ADVISORY_ANCHORED` | D2 | `0.0.9197513@1785534400.313437789` |
| 3 | `POD_REVIEW_ACTION` (ACCEPT) | D2 | `0.0.9197513@1785534407.535669507` |
| 4 | `ESCROW_RELEASED` | E1 | `0.0.9197513@1785536865.385875442` |
| 5 | `TENDER_COMPLETED` | E1 | `0.0.9197513@1785536867.228168869` |

All five belong to the same topic and tender. `TENDER_COMPLETED` carries
`finalState=PAYMENT_RELEASED` and a `completionRef` that is the sha256
evidence-chain digest binding the access, escrow, POD, and release run ids,
tender key, POD hashes, advisory hash, acceptance hash, authorization hash,
release plan hash, and release transaction id.

### Truthful final claim

- The x402 access payments were **real Hedera testnet transactions**.
- The HTS USDC freight escrow was **real**.
- The maximum **synthetic** freight budget was funded.
- The winning amount was locked and the excess refunded.
- The POD was **synthetic**, encrypted, and cryptographically signed.
- POD integrity and shipper acceptance were **anchored through HCS**.
- The shipper acceptance **caused the real escrowed freight amount to be
  released**.
- The winning carrier received **exactly 750,000 atomic testnet USDC**.
- The complete evidence sequence is **ordered on Hedera**.
- The deterministic adviser was **non-binding** and is not a live AI model.
- **No physical delivery and no real-world commercial freight is claimed.**

## 11. Non-goals

No upgradeability, proxy admin, governance token, `delegatecall`, arbitrary
external calls, or unrelated DeFi functionality. No Scheduled Transaction
escrow. No mainnet deployment.
