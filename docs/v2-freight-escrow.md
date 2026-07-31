# RouteGuard v2 — freight-principal escrow (Phase C1)

Reference for `contracts/RouteGuardFreightEscrow.sol` and the TypeScript
boundary under `src/v2/escrow/`.

> **Phase C1 status: offline only.** The contract is written, compiled, and
> exercised against real bytecode in an in-process EVM. **No freight escrow is
> deployed. No contract is funded. No Hedera transaction, HCS message, Mirror
> query, facilitator call, or x402 payment was made.** Guarded testnet
> deployment is Phase C2 and is still pending.

---

## 1. Purpose and separation from x402

| | x402 access fee | Freight principal |
|---|---|---|
| What it buys | Tender activation / durable bid submission | The transport itself |
| Amount | Exactly `1000` atomic (0.001 USDC) | `maximumFreightBudgetAtomic` per tender |
| Recipient | RouteGuard access treasury | Escrow contract, then carrier and/or shipper |
| Mechanism | x402 `exact` scheme, facilitator settlement | HTS USDC held by this contract |
| Proven | Live on testnet (Phase B2b) | **Not yet live** |

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

## 9. Phase C2 deployment configuration (prepared, not executed)

Required **public** configuration:

| Item | Value / source |
|---|---|
| HTS USDC token | `0.0.429274` (testnet, decimals 6) |
| Token EVM address | long-zero form of the token id, confirmed on Mirror Node |
| Operator account | RouteGuard operator (`ECDSA` account able to submit contract calls) |
| Shipper account | Funds the tender; must be USDC-associated with sufficient balance |
| Carrier account | Receives the released freight; must be USDC-associated |
| Constructor args | `(token, operator)` |
| Gas | deploy ≈ 3M; `fundTender`/settlement ≈ 900k; `allocateWinner` ≈ 1.2M; `partialRelease` ≈ 1.4M |
| Association | `associateEscrowToken()` once after deployment, before funding |
| Allowance | The shipper must approve the contract for the exact budget before `fundTender` (HTS `transferToken` from the shipper requires it) |

Mirror verification required before any lifecycle advance:

- contract creation → contract id and bytecode present;
- `fundTender` → `TenderEscrowFunded`, escrow token balance equals the budget;
- `allocateWinner` → `WinnerAllocated` + `ExcessRefunded`, shipper credited the
  exact excess, escrow balance equals exactly the winning amount, carrier
  balance unchanged;
- settlement → the exact locked amount at the intended recipients and a zero
  residual escrow balance for the tender.

No private key belongs in the repository or in the contract. Live Phase C
evidence belongs under `evidence/v2/` only after Phase C2 authorization.

## 10. Non-goals

No upgradeability, proxy admin, governance token, `delegatecall`, arbitrary
external calls, or unrelated DeFi functionality. No Scheduled Transaction
escrow. No mainnet deployment.
