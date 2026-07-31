# RouteGuard Freight Exchange — PROJECT STATUS

**Version:** 0.11.0
**Date:** 2026-08-01
**Project:** `routeguard-freight-exchange@0.1.0` — deterministic freight-capacity reservation over x402 and Hedera Testnet
**Branch:** `feat/routeguard-v2-phase-e` (local only; do not push during this checkpoint)
**Prior checkpoint HEAD:** `ca6700be31080ea620a99e87af81580ded05ef17` (v0.10.1 Phase D2 live POD acceptance)
**Authoritative plan (v1):** `RouteGuard_Freight_Exchange_Final_Project_Plan_v1.5.md`
**Authoritative plan (v2):** `docs/plans/routeguard-v2-architecture-migration-plan.md`
**Winning Demo blueprint:** `F:\x402\crqitiques\RouteGuard_Claude_Winning_Demo_Design_2026-07-19.md`

---

## RouteGuard v2 Phase E1 — live freight settlement (v0.11.0)

The RouteGuard v2 freight lifecycle is **complete on Hedera testnet**. The
signed Phase D2 shipper acceptance was re-verified and executed: the locked
freight principal moved to the winning carrier and the release and completion
were anchored to the existing POD topic.

**STATE_CHANGING_NETWORK_WRITES=3** — `CONTRACT_WRITES=1`,
`HCS_MESSAGE_WRITES=2`, `X402_WRITES=0`, `OTHER_STATE_CHANGING_WRITES=0`.
**QUERY_PAYMENT_TRANSACTIONS=0** — every escrow state read used the free Mirror
Node `contracts/call` endpoint. v1 `evidence/final-demo-*`, `evidence/v2/access/`,
`evidence/v2/escrow/`, and `evidence/v2/pod/` are **unchanged**.

### Live run

| Field | Value |
|---|---|
| Run ID | `v2rel-20260731-b4c817df` |
| Execution date | 2026-08-01 (UTC; consensus 2026-07-31T22:21Z–22:27Z) |
| Network | `hedera:testnet` |
| Escrow contract | `0.0.9861047` / `0x00000000000000000000000000000000009677b7` |
| Tender | `V2-ESCROW-DEMO-v2escrow-20260731-88bbd727` v1 |
| Tender key | `0x30741f72dc23ac11d4fee37878d9c3fc7fe000377f87cb55ff2196cc82e79f89` |
| POD | `POD-v2pod-20260731-4b203b9c` v1 |
| Topic | `0.0.9862010` (reused from Phase D2 — no new topic) |
| Token | `0.0.429274` |
| Successful state-changing writes | **3** (ceiling 3) |

| Step | Transaction ID | Result |
|---|---|---|
| `releaseFull` | `0.0.9197513@1785536472.599444485` | SUCCESS |
| `ESCROW_RELEASED` (seq **4**) | `0.0.9197513@1785536865.385875442` | SUCCESS |
| `TENDER_COMPLETED` (seq **5**) | `0.0.9197513@1785536867.228168869` | SUCCESS |

### Carrier payment — exactly 750,000 atomic USDC

| Account | Before | After | Delta |
|---|---|---|---|
| Carrier `0.0.9215954` | 22,000 | 772,000 | **+750,000** |
| Escrow `0.0.9861047` | 750,000 | 0 | **−750,000** |
| Shipper `0.0.9197513` | 19,228,000 | 19,228,000 | 0 |

The HTS transfer legs are recorded on the **child** `CRYPTOTRANSFER` spawned by
the precompile, not on the parent `CONTRACTCALL`; verification aggregates both
and rejects any foreign token or unexpected leg. The `FreightReleased` event
matches tender key, winner EVM address (bound at Phase C2 allocation), amount
750,000, and the authorization hash, with `fromDispute=false`.

### Final contract state

| Field | Value |
|---|---|
| Contract state | **`RELEASED`** (terminal) |
| Tender locked balance | **0** |
| Total escrowed | 0 |
| `authorizationHashUsed` | **true** — globally single-use, replay impossible |
| Dispute / refund / partial release | none |

### Authorization chain re-verified before the call

1. The canonical `ROUTEGUARD_V2_SHIPPER_POD_REVIEW` ACCEPT payload was rebuilt
   from immutable evidence; its hash matches Phase D2 evidence **and** the
   durable lifecycle `lastShipperAuthPayloadHash`.
2. Hiero ECDSA is RFC6979-deterministic, so re-signing reproduced the
   **original signature bytes**: the rebuilt `POD_ACCEPTED_BY_SHIPPER` event
   hash equals the `eventPayloadHash` committed in Phase D2.
3. The signature verifies against the durable trust-snapshot shipper key.
4. The contract authorization hash was **re-derived** from the accepted POD
   identity and content hash and matched the prepared plan.
5. The `releaseFull` plan was rebuilt with the production builder under
   `requirePhaseC2LiveBindings`; its plan hash matched
   `sha256:0a722dd3043830e0d5a7beaef668699abe1c1e431e351d86e4df94d844dacf95`.

### Complete live evidence chain — topic `0.0.9862010`

| Seq | Message | Phase |
|---|---|---|
| 1 | `POD_SUBMITTED` | D2 |
| 2 | `POD_ADVISORY_ANCHORED` | D2 |
| 3 | `POD_REVIEW_ACTION` (ACCEPT) | D2 |
| 4 | `ESCROW_RELEASED` | E1 |
| 5 | `TENDER_COMPLETED` | E1 |

All five belong to the same topic and tender, in consensus order, with message
bytes SHA-256-matched to the local canonical envelopes. `TENDER_COMPLETED`
carries `finalState=PAYMENT_RELEASED` and `completionRef`
`975b152ec9352c493091e22962bdc9ae1e4319a1713178cc5ec86420790f7042` — the
evidence-chain digest binding the access, escrow, POD, and release run ids,
tender key, POD hashes, advisory hash, acceptance hash, authorization hash,
release plan hash, and release transaction id.

### Truthful final claim

- The x402 access payments were **real Hedera testnet transactions**.
- The HTS USDC freight escrow was **real**.
- The maximum **synthetic** freight budget was funded (1.00 USDC).
- The winning amount was locked (0.75) and the excess refunded (0.25).
- The POD was **synthetic**, encrypted, and cryptographically signed.
- POD integrity and shipper acceptance were **anchored through HCS**.
- The shipper acceptance **caused the real escrowed freight amount to be
  released**.
- The winning carrier received **exactly 750,000 atomic testnet USDC**.
- The complete evidence sequence is **ordered on Hedera**.
- The deterministic adviser was **non-binding** and is not a live AI model.
- **No physical delivery and no real-world commercial freight is claimed.**

### Changed / added files (v0.11.0)

| File | Change |
|---|---|
| `PROJECT_STATUS.md` | v0.11.0 Phase E1 live settlement checkpoint |
| `docs/v2-freight-escrow.md` | **New §10** — Phase E1 release, balances, final state, HCS chain, claim boundary; §9 boundary marked superseded; non-goals renumbered to §11 |
| `docs/v2-pod-review.md` | **New §11** — the signed acceptance was settled in Phase E1 |
| `package.json` | `demo:v2-release-live` script |
| `scripts/run-v2-release-live.ts` | **New** — guarded restart-aware release runner (max 3 state-changing writes) |
| `evidence/v2/release/*` | **New** — sanitized live settlement evidence (10 files) |
| `data/v2-live-release/*` | Runtime progress (gitignored) |
| `data/v2-live-pod/lifecycle/*` | Lifecycle advanced `POD_ACCEPTED → PAYMENT_RELEASED → TENDER_COMPLETED` (gitignored) |

### Validation (v0.11.0)

- Live runner: **PASS** — 3 state-changing writes, ordering 1→5, `RELEASED`, locked 0
- `npm run typecheck`: **PASS**
- Phase A/B/C/D/E focused tests: **PASS** — 29 files / **377** tests; 0 failed
- Solidity compile: **PASS** — solc 0.8.28
- Solidity offline tests: **PASS** — 3 files / **60** tests
- full `npm test`: **PASS** — 73 files / **934** tests; 0 failed
- `npm run check:secrets`: **PASS** — 345 files scanned
- `git diff --check`: **PASS**
- `npm run verify`: **PASS**
- v1 / v2 access / v2 escrow / v2 POD evidence: **unchanged**

### Current state

The RouteGuard v2 lifecycle is complete end to end on Hedera testnet: paid x402
access → HTS USDC freight escrow → allocation with exact excess refund →
encrypted signed POD → non-binding advisory → signed shipper acceptance →
**real freight release to the carrier** → ordered on-chain evidence chain. The
escrow holds nothing further for this tender.

### Next step

**Phase F: production website integration, Judge Mode, deployment, and the
submission package.** Do not re-run any earlier live phase — every prior write
is immutable evidence.

**NETWORK_WRITES=3** (application state-changing writes, this checkpoint).

---

## RouteGuard v2 Phase D2 — live POD acceptance on Hedera testnet (v0.10.1)

Guarded live execution of the Phase D1 encrypted-POD and signed shipper-review
workflow against real Hedera testnet HCS. **NETWORK_WRITES=4** (one dedicated
topic creation + three HCS messages). **CONTRACT_WRITES=0**. **X402_WRITES=0**.
**OTHER_HEDERA_WRITES=0**. The live escrow is untouched: **750,000 atomic USDC
remains locked** in `ALLOCATED` for Phase E. v1 `evidence/final-demo-*`,
`evidence/v2/access/`, and `evidence/v2/escrow/` are **unchanged**.

### Truthful claim boundary

| Label | Value |
|---|---|
| `SYNTHETIC_BUSINESS_DATA` | **YES** |
| `LIVE_POD_CRYPTO` | **YES** |
| `LIVE_APPLICATION_SIGNATURES` | **YES** |
| `LIVE_HCS_ANCHORS` | **YES** |
| `LIVE_AI_MODEL` | **NO** |
| `ADVISER_IMPLEMENTATION` | `DETERMINISTIC_STUB` |
| `LIVE_PHYSICAL_DELIVERY` | **NO** |
| `LIVE_FREIGHT_RELEASE` | **NO** |
| `ESCROW_STATE_AFTER_RUN` | `ALLOCATED` |
| `LOCKED_AMOUNT_AFTER_RUN` | **750000** |

### Live run

| Field | Value |
|---|---|
| Run ID | `v2pod-20260731-4b203b9c` |
| Execution date | 2026-07-31 (UTC) |
| Network | `hedera:testnet` |
| Escrow contract | `0.0.9861047` / `0x00000000000000000000000000000000009677b7` |
| Tender | `V2-ESCROW-DEMO-v2escrow-20260731-88bbd727` v1 |
| Escrow tender key | `0x30741f72dc23ac11d4fee37878d9c3fc7fe000377f87cb55ff2196cc82e79f89` |
| Operator / shipper | `0.0.9197513` |
| Carrier (winner) | `0.0.9215954` |
| POD | `POD-v2pod-20260731-4b203b9c` v1 |
| **Dedicated HCS topic** | **`0.0.9862010`** (memo `RouteGuard v2 POD evidence`) |
| Topic create tx | `0.0.9197513@1785534392.284127053` |
| Successful writes | **4** (ceiling 4) |

| Seq | Message | Transaction ID | Consensus |
|---|---|---|---|
| 1 | `POD_SUBMITTED` | `0.0.9197513@1785534396.504175067` | `1785534402.627198807` |
| 2 | `POD_ADVISORY_ANCHORED` | `0.0.9197513@1785534400.313437789` | `1785534407.116885660` |
| 3 | `POD_REVIEW_ACTION` (ACCEPT) | `0.0.9197513@1785534407.535669507` | `1785534411.170948313` |

Mirror: all four transactions **SUCCESS**, transaction ids unique, sequence
order 1 → 2 → 3, and every message body byte-identical (SHA-256) to the local
canonical envelope. The v1 topic `0.0.9794225` was **not** used.

### POD proof

- **Carrier POD signature verified** — real ECDSA secp256k1 over the production
  `ROUTEGUARD_V2_POD_SUBMISSION` canonical payload, checked against the
  registered carrier key before the package was accepted.
- **Encrypted POD storage proof** — AES-256-GCM with a unique per-POD data key
  and IV, key wrapped under `ROUTEGUARD_POD_MASTER_KEY_BASE64`, AAD bound to
  tender/POD identity + manifest hash. The stored envelope was reloaded,
  validated, decrypted, and compared file-by-file against the signed input.
- 3 synthetic documents / 3,469 plaintext bytes / 5,981 ciphertext bytes.
- Manifest hash `sha256:169bf54c…2ef582`, package content hash
  `sha256:696f18c5…231697`, ciphertext hash `sha256:8cf571af…da7f68`.
- **POD plaintext was generated in an isolated runtime directory outside the
  repository and removed after the encrypted commit.** No plaintext, ciphertext
  blob, key, IV, tag, or signature appears in Git or evidence.

### Advisory and acceptance

- **Deterministic non-binding advisory** — engine
  `routeguard-deterministic-pod-assurance-v1`, `binding=NON_BINDING_ADVISORY`,
  recommendation `ACCEPT`, single `COMPLETE`/`INFO` finding, report
  `adv-967a3992d9cd6d40`. **No live AI model was invoked**; the adviser performs
  no lifecycle acceptance and constructs no escrow authorization.
- **Signed shipper acceptance** — real signature over the canonical
  `ROUTEGUARD_V2_SHIPPER_POD_REVIEW` ACCEPT payload, cryptographically verified
  before the lifecycle event; `POD_UNDER_REVIEW → POD_ACCEPTED`. Review deadline
  `2026-08-02T21:46:35.884Z`.
- **`releaseFull` plan prepared, not submitted** — bound to contract
  `0.0.9861047`, EVM `0x…9677b7`, the exact live tender key, locked amount
  `750000`, authorization hash
  `0xc66ae24790348c848c7a8749c444b6947a47bc9760a18d2978c67bdb016c7aeb`; plan
  hash `sha256:0a722dd3…dacf95`.

### Escrow untouched

| Field | Before | After |
|---|---|---|
| Contract state | `ALLOCATED` | `ALLOCATED` |
| Locked tender balance | 750,000 | **750,000** |
| Total escrowed | 750,000 | 750,000 |
| Carrier USDC | 22,000 | 22,000 |
| Release authorization consumed | — | **false** |

Re-confirmed independently through the free Mirror Node `contracts/call`
endpoint. **Carrier freight principal received remains 0.**

### Ledger footprint disclosure

The four authorized writes are the only RouteGuard state changes. Read-only
escrow verification through the SDK `ContractCallQuery` path additionally billed
**7 Hedera query-payment `CRYPTOTRANSFER`s** — HBAR node fees that move no USDC
and mutate no contract state. The runner now performs escrow state reads through
the free Mirror Node `contracts/call` endpoint, so a repeat run adds none.

### Changed / added files (v0.10.1)

| File | Change |
|---|---|
| `PROJECT_STATUS.md` | v0.10.1 Phase D2 live proof |
| `docs/v2-pod-review.md` | D1/D2 scope header + §10 rewritten as the executed live run |
| `package.json` | `demo:v2-pod-live` script |
| `scripts/run-v2-pod-live.ts` | **New** — guarded restart-aware live runner (max 4 writes) |
| `evidence/v2/pod/*` | **New** — sanitized live evidence package (14 files) |
| `data/v2-live-pod/*`, `data/v2-pods/*` | Runtime progress + encrypted POD storage (gitignored) |

### Validation (v0.10.1)

- Live runner: **PASS** — 4 writes, ordering 1→2→3, escrow `ALLOCATED`/750000
- `npm run typecheck`: **PASS**
- Phase A/B/C/D focused tests: **PASS** — 29 files / **377** tests; 0 failed
- Solidity compile: **PASS** — solc 0.8.28
- Solidity offline tests: **PASS** — 3 files / **60** tests
- full `npm test`: **PASS** — 73 files / **934** tests; 0 failed
- `npm run check:secrets`: **PASS** — 334 files scanned
- `git diff --check`: **PASS**
- `npm run verify`: **PASS**
- v1 `evidence/final-demo-*`: **unchanged**
- `evidence/v2/access/`: **unchanged**
- `evidence/v2/escrow/`: **unchanged**

### Current state

Phase D2 complete: an encrypted, carrier-signed synthetic POD is anchored on a
dedicated testnet HCS topic, a deterministic non-binding advisory is anchored by
hash, and a cryptographically verified shipper ACCEPT has moved the lifecycle to
`POD_ACCEPTED` with a `releaseFull` plan prepared. **No freight principal moved:
750,000 atomic USDC remains locked in `ALLOCATED`.**

### Next step

**Phase E1: execute the real freight release and anchor `ESCROW_RELEASED` plus
`TENDER_COMPLETED` to HCS.** Do not re-run Phase B access payments, the Phase C2
escrow setup, or this Phase D2 run.

**NETWORK_WRITES=4** (this checkpoint).

---

## RouteGuard v2 Phase D1 — encrypted POD and shipper review (v0.10.0)

Offline-complete POD workflow: signed carrier submission, AES-256-GCM encrypted
storage, deterministic non-binding advisory, signed shipper review, and escrow
release/dispute **transaction plans** only.

**NETWORK_WRITES=0.** No HCS submit, Mirror call, live AI provider, freight
release, contract dispute call, x402 payment, or live Phase D evidence.
v1 `evidence/final-demo-*`, `evidence/v2/access/`, and `evidence/v2/escrow/` are
**unchanged**.

### Architecture

| Concern | Choice |
|---|---|
| Content encryption | AES-256-GCM, unique DEK + IV per POD version |
| AAD | tenderId, tenderVersion, podId, podVersion, manifestHash |
| Key protection | `PodKeyProtector` + AES-256-GCM wrap under `ROUTEGUARD_POD_MASTER_KEY_BASE64` (32 bytes) |
| Storage | `routeguard-v2-pod-store-1.0` envelope; `data/v2-pods/` (gitignored) |
| Carrier auth | `ROUTEGUARD_V2_POD_SUBMISSION` domain-separated ECDSA |
| Shipper auth | Existing `ROUTEGUARD_V2_SHIPPER_POD_REVIEW` |
| Adviser | Deterministic stub `routeguard-deterministic-pod-assurance-v1` (`NON_BINDING_ADVISORY`) |
| Escrow | `releaseFull` / `openDispute` plans bound to Phase C builders; never submitted |
| HCS | `POD_SUBMITTED`, `POD_ADVISORY_ANCHORED`, `POD_REVIEW_ACTION`, `DISPUTE_OPENED` outbox only |

Windows: review **48h**, correction **24h**, post-resubmit review **24h**.

### Changed / added files (v0.10.0)

| File | Change |
|---|---|
| `PROJECT_STATUS.md` | v0.10.0 Phase D1 checkpoint |
| `docs/v2-pod-review.md` | **New** — POD, crypto, advisory, review, plan boundary, D2 prep |
| `src/v2/pod/*` | **New** — package, policy, encrypt, storage, service, routes, adviser, plans, outbox |
| `src/v2/auth/canonical.ts` | Carrier POD submission sign payload |
| `src/v2/auth/verify.ts` | `verifyCarrierPodSubmission` + test helper |
| `test/v2-pod-workflow.test.ts` | **New** — focused Phase D1 matrix |

### Validation (v0.10.0)

- `npm run typecheck`: **PASS**
- Phase D1 focused suite (POD + A/C samples): **PASS** — 9 files / **191** tests
- Solidity compile: **PASS** — solc 0.8.28
- Solidity offline tests: **PASS** — **60** tests
- full `npm test`: **PASS** — 73 files / **934** tests; 0 failed
- `npm run check:secrets`: **PASS** — 319 files scanned
- `git diff --check`: **PASS**
- v1 / v2 access / v2 escrow evidence: **unchanged**
- live Hedera / HCS / AI: **NOT RUN**

### Current state

Phase D1 complete offline: encrypted POD path connects the live ALLOCATED escrow
to a typed release/dispute plan without moving funds. No live POD evidence yet.

### Next step

**Phase D2: guarded live synthetic POD, HCS anchors, and shipper acceptance
proof** — still no freight release (Phase E). Do not re-run Phase B or C2 live
writes.

**NETWORK_WRITES=0.**

---

## RouteGuard v2 Phase C2 — live testnet freight escrow (v0.9.1)

Guarded Hedera **testnet** deployment and first live freight-principal demo.
**NETWORK_WRITES=10** (contract deploy + associate + register + allowance + fund
+ allocate only). **HCS_NETWORK_WRITES=0**. **X402_NETWORK_WRITES=0**.
**LIVE_FREIGHT_ESCROW=YES**. No POD, dispute, or carrier freight release.
v1 `evidence/final-demo-*` and Phase B `evidence/v2/access/` are **unchanged**.

### Live run

| Field | Value |
|---|---|
| Run ID | `v2escrow-20260731-88bbd727` |
| Network | `hedera:testnet` |
| Token | `0.0.429274` (decimals 6) |
| Contract ID | `0.0.9861047` |
| EVM address | `0x00000000000000000000000000000000009677b7` |
| Operator / shipper | `0.0.9197513` |
| Carrier (winner) | `0.0.9215954` |
| Tender | `V2-ESCROW-DEMO-v2escrow-20260731-88bbd727` v1 |
| Max budget | **1.00 USDC** / 1,000,000 atomic |
| Winning amount locked | **0.75 USDC** / 750,000 atomic |
| Excess refunded to shipper | **0.25 USDC** / 250,000 atomic |
| Contract balance after allocation | **750,000** atomic |
| Carrier freight received | **0** |
| Contract state | `ALLOCATED` |
| Successful writes | **10** (ceiling 10) |

| Step | Transaction ID |
|---|---|
| File create (hex bytecode) | `0.0.9197513@1785528439.471076750` |
| File append (first chunk) | `0.0.9197513@1785528444.730665937` |
| Contract create | `0.0.9197513@1785528457.557374203` |
| Associate USDC | `0.0.9197513@1785528465.153884715` |
| Register tender | `0.0.9197513@1785528470.540863049` |
| Shipper allowance (exact) | `0.0.9197513@1785528474.333213938` |
| Fund tender | `0.0.9197513@1785528475.735005438` |
| Allocate winner + excess refund | `0.0.9197513@1785528486.479519241` |

Mirror: every step **SUCCESS**; post-allocation tender balance 750,000; shipper
net −750,000 atomic; carrier USDC unchanged at allocation.

### Economic separation

| Rail | Amount | Notes |
|---|---|---|
| x402 access (Phase B2b, immutable) | 0.001 USDC × 2 | Not repeated; `evidence/v2/access/` untouched |
| Freight principal (this run) | 1.00 → 0.75 locked + 0.25 refund | HTS escrow — **not** x402 |

### Changed / added files (v0.9.1)

| File | Change |
|---|---|
| `PROJECT_STATUS.md` | v0.9.1 Phase C2 live proof |
| `docs/v2-freight-escrow.md` | Live status, contract IDs, txs, claim boundary |
| `package.json` | `demo:v2-escrow-live` script |
| `scripts/run-v2-escrow-live.ts` | **New** — guarded live runner (max 10 writes) |
| `evidence/v2/escrow/*` | **New** — sanitized live evidence package |
| `data/v2-live-escrow/*` | Local restart progress (public-safe fields) |

### Validation (v0.9.1)

- Live runner: **PASS** — 10 writes, state `ALLOCATED`, conservation OK
- Solidity compile: **PASS** — solc 0.8.28
- Solidity offline tests: **PASS** — 3 files / **60** tests
- `npm run typecheck`: **PASS**
- Phase A/B/C focused tests: **PASS** — 14 files / **234** tests
- full `npm test`: **PASS** — 72 files / **910** tests; 0 failed
- `npm run check:secrets`: **PASS** — 303 files scanned
- `git diff --check`: **PASS**
- v1 evidence: **unchanged**
- v2 access evidence: **unchanged**

### Current state

Phase C2 complete: RouteGuard freight escrow holds real HTS testnet USDC with
the winning amount locked and the carrier unpaid. POD and settlement remain
future work.

### Next step

**Phase D1: encrypted POD upload, POD hashing, and advisory-only AI review.**
Do not release freight principal until Phase E. Do not re-run Phase B access
payments or the v1 final-auction.

**NETWORK_WRITES=10** (this checkpoint).

---

## RouteGuard v2 Phase C1 — freight-principal escrow contract (v0.9.0)

The HTS USDC freight escrow that will custody the actual freight principal,
plus its TypeScript integration boundary. **Entirely offline.**

**NETWORK_WRITES=0.** **LIVE_FREIGHT_ESCROW=NO.** No contract deployed, no
escrow funded, no Hedera transaction, HCS message, Mirror query, facilitator
call, or x402 payment. v1 evidence and the Phase B live access evidence
(`evidence/v2/access/`) are unchanged.

### Contract

`contracts/RouteGuardFreightEscrow.sol` — one contract, many tenders, keyed by a
canonical `bytes32` tender key derived from an explicit RouteGuard domain
separator, the tender identity hash, and the tender version. The HTS USDC token
is `immutable`; there is no per-tender token and no setter.

| State transition | Reached by |
|---|---|
| `UNREGISTERED` → `REGISTERED` | operator `registerTender` |
| `REGISTERED` → `FUNDED` | **shipper** `fundTender` (exact budget) |
| `FUNDED` → `ALLOCATED` | operator `allocateWinner` (+ immediate exact excess refund) |
| `FUNDED` → `REFUNDED` | operator `refundNoQualifiedBid` |
| `ALLOCATED` → `RELEASED` | operator `releaseFull` (POD accepted / deemed accepted) |
| `ALLOCATED` → `DISPUTED` | operator `openDispute` |
| `DISPUTED` → `RELEASED` / `REFUNDED` / `PARTIALLY_RELEASED` | referee-authorized `resolveDisputeRelease` / `refundFull` / `partialRelease` |

`RELEASED`, `REFUNDED`, and `PARTIALLY_RELEASED` are terminal and inescapable.
Once a dispute is open the ordinary `releaseFull` path is closed.

### Money model

- **Exact funding**, matching the Phase A lock: underfunding and overfunding
  both revert. No unmodeled residual can enter the escrow.
- **Allocation conservation:** `winningAmount + excessRefunded == fundedAmount`.
  The exact excess returns to the shipper in the same transaction, the tender's
  escrow balance then equals exactly the winning amount, and the carrier
  receives nothing during allocation.
- **Settlement** moves only the locked amount, in full, with strict partial
  conservation.
- Amounts arrive as `uint256`, are bounded to `int64.max` and only then narrowed
  to `uint64`, so no wrap can produce a valid amount. `totalEscrowedAmount`
  always equals the sum of per-tender balances.

### Authorization model

OpenZeppelin `Ownable2Step` operator (two-step transfer, never unowned) plus
`ReentrancyGuard`. Only the operator registers/allocates/disputes/settles; only
the registered shipper funds their own tender. RouteGuard verifies shipper and
referee signatures **off-chain** and submits the canonical authorization hash,
which the contract records and enforces as **globally single-use**. The contract
evaluates no POD document and accepts no AI output as authorization — an
"AI advisory" is simply an unauthorized caller. On-chain signature verification
/ multisig remains a documented production hardening option and is stated as a
limitation in `docs/v2-freight-escrow.md`.

### HTS token-transfer architecture

The production contract calls the HTS system contract at `0x167`
(`transferToken`, `associateToken`) with the immutable escrow token, checks
**every** response code (only `SUCCESS` proceeds), and uses the precompile as
its **only** external callee — no arbitrary call target, `delegatecall`,
upgrade/proxy surface, or sweep function. State is written before transfers
(checks-effects-interactions) and every entry point is `nonReentrant`.

The state machine lives in the abstract `RouteGuardFreightEscrowBase`; the
production contract implements the transfer primitives over HTS and the offline
test contract over an in-contract ledger, so the tested logic is the deployed
logic and only the token rail differs.

### Tooling added (development only unless noted)

| Package | Scope | Why |
|---|---|---|
| `solc@0.8.28` | dev | Pinned Solidity compiler; pure JS, local imports only, no external binary |
| `@ethereumjs/evm@3.1.1`, `@ethereumjs/util@9.1.0` | dev | In-process EVM so contract tests run under the existing vitest runner |
| `@openzeppelin/contracts@5.1.0` | dev | Proven `Ownable2Step` + `ReentrancyGuard`; no custom access control or cryptography |
| `ethers@6.16.0` | **prod** | keccak256 / ABI coding / log decoding for the TS boundary (already present transitively via `@hiero-ledger/sdk`, so no new install weight) |

New scripts: `npm run contracts:compile`, `npm run contracts:test`. Generated
`artifacts/` is gitignored and recreated by the compile script.

### Changed / added files (v0.9.0)

| File | Change |
|---|---|
| `PROJECT_STATUS.md` | v0.9.0 Phase C1 checkpoint |
| `docs/v2-freight-escrow.md` | **New** — purpose, x402 separation, states, money rules, authorization limits, HTS transfers, events, TS boundary, offline test status, Phase C2 configuration plan |
| `contracts/RouteGuardFreightEscrowBase.sol` | **New** — abstract state machine, accounting, authorization-hash single use |
| `contracts/RouteGuardFreightEscrow.sol` | **New** — deployable HTS implementation |
| `contracts/interfaces/IHederaTokenService.sol` | **New** — minimal HTS surface + response codes |
| `contracts/test/MockLedgerFreightEscrow.sol` | **New** — offline ledger harness (never deployed) |
| `contracts/test/ReentrantSettlementAttacker.sol` | **New** — offline reentrancy probe |
| `scripts/compile-contracts.ts` | **New** — offline solc compilation + artifacts |
| `src/v2/escrow/tender-key.ts` | **New** — canonical key derivation and identity validation |
| `src/v2/escrow/amounts.ts` | **New** — atomic validation, HTS bounds, conservation |
| `src/v2/escrow/abi.ts` | **New** — exported ABI |
| `src/v2/escrow/requests.ts` | **New** — pure transaction-plan builders |
| `src/v2/escrow/events.ts` | **New** — public-safe event and result parsers |
| `src/v2/escrow/states.ts` | **New** — escrow state enum mirroring the contract |
| `src/v2/escrow/lifecycle-map.ts` | **New** — lifecycle ↔ escrow mapping |
| `src/v2/escrow/index.ts` | **New** — boundary barrel |
| `test/helpers/escrow-evm.ts` | **New** — in-process EVM harness |
| `test/helpers/escrow-fixtures.ts` | **New** — shared escrow fixtures |
| `test/escrow-contract-registration.test.ts` | **New** — 28 tests |
| `test/escrow-contract-settlement.test.ts` | **New** — 20 tests |
| `test/escrow-contract-security.test.ts` | **New** — 12 tests |
| `test/v2-escrow-boundary.test.ts` | **New** — 28 tests |
| `package.json` / `package-lock.json` | Contract toolchain + scripts |
| `.gitignore` | Ignore generated `artifacts/` |

### Validation (v0.9.0)

- Solidity compile (`npm run contracts:compile`): **PASS** — solc 0.8.28, 0 errors
- Solidity offline tests (`npm run contracts:test`): **PASS** — 3 files / **60** tests
- `npm run typecheck`: **PASS**
- Phase A + B + C1 focused tests: **PASS** — 28 files / 353 tests
- full `npm test`: **PASS** — 72 files / **910** tests; 0 failed
- `npm run check:secrets`: **PASS** — 289 files scanned
- `git diff --check`: **PASS**
- v1 `evidence/final-demo-*` and Phase B `evidence/v2/access/`: **unchanged** — 0 modified paths
- live Hedera / HCS / Mirror / facilitator / x402: **NOT RUN**

### Current state

The freight-principal escrow contract exists, compiles, and is proved offline
against its real bytecode: registration, exact funding, allocation with exact
excess refund, no-winner refund, POD release, dispute, referee resolutions,
terminal-state protection, reentrancy, transfer-failure rollback, unsafe
narrowing, multi-tender isolation, accounting integrity, and access control.
The TypeScript boundary derives tender keys byte-identically to the contract and
produces transaction plans only. **No freight escrow is deployed and no freight
principal has moved.**

### Next step

**Phase C2: guarded Hedera testnet contract deployment**, escrow registration,
funding, winner allocation, and excess-refund proof — with Mirror verification
at each step and evidence written only under `evidence/v2/`. Do **not** re-run
the v1 live final-auction and do **not** repeat the Phase B access payments.

**NETWORK_WRITES=0.**

---

## RouteGuard v2 Phase B2b — live testnet x402 access payments (v0.8.2)

Guarded live execution of **exactly two** successful Hedera testnet x402
`exact` USDC access payments (tender activation + durable bid). **NETWORK_WRITES=2**
(x402 settlements only). **HCS_NETWORK_WRITES=0**. **LIVE_FREIGHT_ESCROW=NO**
(`ESCROW_PHASE=C_PENDING`). v1 `evidence/final-demo-*` unchanged.

### Live run

| Field | Value |
|---|---|
| Run ID | `v2access-20260731-918f5748` |
| Scheme / network | `exact` / `hedera:testnet` |
| Token | `0.0.429274` |
| Amount each | **1000** atomic (0.001 USDC) |
| Access treasury (`payTo`) | `0.0.9215954` |
| Activation payer | `0.0.9197513` (shipper) |
| Bid access payer | `0.0.9197513` (shipper; treasury is the only other USDC-associated account that is not the shipper — carrier cannot pay itself) |
| Bid signature | carrier-alpha registered key |
| Activation tx | `0.0.7162784@1785519911.424021609` |
| Bid tx | `0.0.7162784@1785520014.520040785` |
| Mirror | both **SUCCESS**, amount/payer/treasury legs verified |
| Replays | both returned **REPLAYED** without a second settlement |
| Escrow precondition | synthetic offline fixture labeled non-live |
| Facilitator | `https://api.testnet.blocky402.com` (fee payer `0.0.7162784`) |

### Changed / added files (v0.8.2)

| File | Change |
|---|---|
| `PROJECT_STATUS.md` | v0.8.2 Phase B2b live proof |
| `docs/v2-x402-access-gates.md` | Live status, runner, claim boundary, evidence table |
| `package.json` | `demo:v2-access-live` script |
| `scripts/run-v2-access-live.ts` | **New** — guarded live runner (max 2 settlements) |
| `src/v2/access/mirror-reconcile.ts` | **New** — Mirror USDC verification + claim reconciler |
| `evidence/v2/access/*` | **New** — sanitized live evidence package |
| `data/v2-live-access/*` | Local durable state for the live run (not v1 paths) |

### Validation (v0.8.2)

- Live runner: **PASS** — 2 settlements, 0 HCS writes
- `npm run typecheck`: **PASS**
- Phase A+B focused tests: **265 passed / 0 failed** (24 files)
- full `npm test`: **822 passed / 0 failed** (68 files)
- `npm run check:secrets`: **PASS** (273 files; no private-key fields in public paths)
- `git diff --check`: **PASS**
- v1 evidence (`evidence/final-demo-*`): **unchanged**

### Current state

Phase B2b complete: tender-activation and bid-submission x402 access fees are
proven on Hedera testnet with durable claim recovery and Mirror confirmation.
Freight escrow, POD, and HCS submission remain future work.

### Next step

**Phase C1: HTS freight-escrow contract and offline tests.** Do not re-run the
v1 live final-auction. Do not re-run Phase B2b live payments unless explicitly
authorized with a new run id and evidence namespace.

**NETWORK_WRITES=2** (this checkpoint).

---

## RouteGuard v2 Phase B2a — durable payment recovery (v0.8.1)

The documented Phase B1 settlement-to-resource-commit crash gap is closed for
both tender activation and durable carrier-bid submission. **NETWORK_WRITES=0**:
all settlement and reconciliation behavior in this checkpoint is injected and
mocked; no facilitator, Hedera, Mirror Node, or HCS network operation ran. v1
evidence is unchanged.

### Delivered recovery model

- A separate durable payment-claim journal preserves Phase A lifecycle version
  semantics while binding action type, `actionId`, tender/version, optional bid,
  payer, treasury, asset, amount, protected resource, canonical payment payload
  hash, and validated-request hash.
- The successful path is `CLAIMED -> SETTLING -> SETTLED_PENDING_COMMIT ->
  COMMITTED`; conclusive failures enter `FAILED` with safe retry
  classification. Raw payment headers, private bid bodies, salts, private keys,
  and sensitive signatures are never stored in claims or public errors.
- Payment verification now precedes atomic claim acquisition; settlement starts
  only after `SETTLING` is durable. Transaction identity and timestamps are
  persisted immediately before the lifecycle/resource commit.
- `SETTLED_PENDING_COMMIT` resumes the missing activation or bid commit without
  settlement. `COMMITTED` rebuilds the original protected result without a
  lifecycle version bump or duplicate bid/private-body/offline-outbox work.
- An uncertain `SETTLING` claim invokes the injected reconciliation boundary.
  The production-safe default returns unknown without a network read and never
  blindly resettles.
- The file adapter uses atomic replacement under a cross-process lock; the
  in-memory adapter has matching atomic acquire/transition semantics.
- Deterministic internal fault injection covers after claim creation, after
  durable settlement, before resource commit, after resource commit, and before
  claim finalization. No production request parameter was added.

### Exact changed files (v0.8.1)

| File | Change |
|---|---|
| `PROJECT_STATUS.md` | v0.8.1 Phase B2a checkpoint and validation evidence |
| `docs/v2-x402-access-gates.md` | Claim lifecycle, ordering, recovery, and Phase B2b boundary |
| `src/v2/access/payment-claim.ts` | Durable claim/reconciliation/fault-boundary types |
| `src/v2/access/x402-gate.ts` | Split verify from settlement for claim-before-settle ordering |
| `src/v2/http/app.ts` | Durable file claim store and network-free default reconciler |
| `src/v2/http/errors.ts` | Stable claim, unknown-settlement, recovery, and commit errors |
| `src/v2/http/routes.ts` | Claim acquisition, recovery orchestration, and idempotent commit |
| `src/v2/store/payment-claim-store.ts` | Atomic memory/file claim journals with replay uniqueness |
| `test/v2-access-route-fixtures.ts` | Injected claim store, reconciler, and internal fault hook |
| `test/v2-payment-claim-recovery.test.ts` | Claim ordering, crash, reconciliation, replay, and restart tests |

### Validation (v0.8.1)

- `npm run typecheck`: **PASS**
- Phase A + B1 + B2a focused tests (`test/v2-*.test.ts`): **PASS** — 24 files /
  265 tests; 0 failed
- full `npm test`: **PASS** — 68 files / 822 tests; 0 failed
- `npm run check:secrets`: **PASS** — 250 files scanned
- `git diff --check`: **PASS**
- v1 evidence `evidence/` + `data/`: **unchanged** — 0 modified paths
- live facilitator / Hedera / Mirror / HCS: **NOT RUN**

### Current state

Phase B2a is complete locally. Paid activation and bid requests now converge
after every modeled internal crash boundary without a second settlement,
duplicate lifecycle transition, duplicate bid registry entry, duplicate private
bid body, or duplicate offline HCS commitment envelope.

### Next step

**Phase B2b: guarded live Hedera testnet tender and bid payments**, using the
durable claim flow plus an injected live reconciliation implementation. Do not
re-run or modify the v1 live final-auction evidence.

**NETWORK_WRITES=0.**

---

## RouteGuard v2 Phase B1 — x402 access gates (v0.8.0)

Two real x402-protected RouteGuard actions implemented on the existing Hedera /
x402 stack, with **mocked facilitator settlement** and complete offline
integration tests. Phase A is accepted and unchanged in intent.

**NETWORK_WRITES=0.** No real Hedera transfer, facilitator settlement, live HCS
submission, Mirror confirmation, escrow funding, contract deployment, or live
evidence generation occurred. v1 evidence is unchanged.

### Delivered routes

| Action | Route | Protected resource |
|---|---|---|
| Tender activation | `POST /api/v2/tenders/:tenderId/v/:tenderVersion/activate` | `/api/v2/tenders/<id>/v/<version>/activate` |
| Durable carrier bid | `POST /api/v2/tenders/:tenderId/v/:tenderVersion/bids/:bidId` | `/api/v2/tenders/<id>/v/<version>/bids/<bidId>` |

Both charge exactly **0.001 USDC = 1000 atomic units** of token **`0.0.429274`**
(6 decimals, derived) to **`ROUTEGUARD_ACCESS_TREASURY_ACCOUNT_ID`**, scheme
`exact`, network `hedera:testnet`. The fee is the RouteGuard application access
price — never the network fee, freight principal, escrow funding, freight
payment, or a payment to a carrier.

### Implementation notes

- Real x402 composition: `x402ResourceServer` + `ExactHederaScheme` +
  `@x402/core/http` codecs build the 402, decode payloads, verify, and settle.
  The facilitator is injected through the standard `FacilitatorClient`
  interface, so tests supply unpaid / verified / rejected / settlement-failure /
  duplicate-transaction / delayed behavior with no test-only production switch.
- **Settlement precedes the durable commit** so the receipt binds the settlement
  identity. The Hono `paymentMiddleware` settles only after the handler has
  produced its response, which cannot bind a settlement id into durable state —
  documented in `docs/v2-x402-access-gates.md`.
- Pre-payment validation runs before any challenge: malformed, ineligible, late,
  over-budget, unsigned, wrong-state, and unknown-tender requests are never
  charged.
- Atomic commit: lifecycle transition + processed action + access-settlement
  index entry + bid registry entry land in one durable record write, reusing the
  Phase A CAS, immutable-field, and strict-envelope guarantees.
- New durable fields `accessPayments` (append-only settlement index, unique
  transaction ids) and `bidRegistry` (public-safe accepted bids) with full
  persisted-envelope validation and cross-field invariants.
- First accepted paid bid performs `TENDER_OPENED → BIDDING` atomically; later
  bids stay in `BIDDING`. No new graph edge.
- Private bid bodies (freight amount, salt, nonce) live only in a
  content-addressed bid-body store — never in the record, public evidence, or a
  response.
- `TENDER_OPENED` / `BID_COMMITMENT` HCS 2.0 envelopes are built and validated
  offline from durable state; **not submitted** in Phase B1.
- Dependencies unchanged: no x402 package upgrade was required.

### Changed / added files (v0.8.0)

| File | Change |
|---|---|
| `PROJECT_STATUS.md` | v0.8.0 Phase B1 checkpoint |
| `docs/v2-x402-access-gates.md` | **New** — endpoints, 402 → paid flow, fee, binding, idempotency, privacy, error codes, config |
| `src/v2/config.ts` | **New** — validated access config; fails closed without a treasury |
| `src/v2/access/x402-gate.ts` | **New** — real x402 requirements / decode / verify / settle boundary |
| `src/v2/http/routes.ts` | **New** — both protected routes, pre-payment validation, sanitized errors |
| `src/v2/http/errors.ts` | **New** — stable error vocabulary and status mapping |
| `src/v2/http/app.ts` | **New** — production composition (file stores, facilitator, registry) |
| `src/v2/hcs/outbox.ts` | **New** — offline TENDER_OPENED / BID_COMMITMENT builders |
| `src/v2/schemas/bid.ts` | **New** — v2 carrier bid, salted commitment, public projection |
| `src/v2/store/bid-body-store.ts` | **New** — private content-addressed bid bodies (memory + file) |
| `src/v2/auth/canonical.ts` | Carrier-bid domain-separated sign payload |
| `src/v2/auth/verify.ts` | Sealed carrier-bid verification against the registered key |
| `src/v2/lifecycle/events.ts` | `BID_SUBMISSION_PAID` event |
| `src/v2/lifecycle/record.ts` | `accessPayments` + `bidRegistry` durable fields |
| `src/v2/lifecycle/reducer.ts` | Paid-bid rules, settlement replay guard, activation payment index |
| `src/v2/store/persisted-record.ts` | Validation + cross-field invariants for the new fields |
| `src/v2/store/lifecycle-service.ts` | Carrier registry injection and paid-bid verification |
| `src/server/app.ts` | Conditional v2 route registration; 503 when disabled |
| `test/v2-access-route-fixtures.ts` | **New** — facilitator double + route harness |
| `test/v2-tender-activation-route.test.ts` | **New** — 19 tests |
| `test/v2-bid-access-route.test.ts` | **New** — 13 tests |
| `test/v2-x402-route-replay.test.ts` | **New** — 8 tests |
| `test/v2-x402-route-config.test.ts` | **New** — 11 tests |

### Validation (v0.8.0)

- `npm run typecheck`: **PASS**
- Phase A + Phase B1 focused tests (`test/v2-*.test.ts`): **PASS** — 23 files /
  247 tests; 0 failed
- full `npm test`: **PASS** — 67 files / 804 tests; 0 failed
- `npm run check:secrets`: **PASS** — 258 files scanned
- `git diff --check`: **PASS** (CRLF warnings only)
- v1 evidence `evidence/` + `data/`: **unchanged** — 0 modified paths
- explicit no-egress assertion during a complete paid flow: **PASS**
- live Hedera / facilitator / Mirror / HCS: **NOT RUN**

### Current state

Phase A is accepted; Phase B1 is implemented. Both access gates return a correct
x402 402 challenge, verify and settle through the injected facilitator boundary,
and commit the protected resource atomically with its durable access receipt.
All settlement in this checkpoint is mocked.

### Next step

**Phase B2: guarded Hedera testnet tender and bid payments** — real facilitator
settlement plus Mirror confirmation, a settle-to-commit reconciliation claim for
the crash window, and HCS submission of the already-built `TENDER_OPENED` and
`BID_COMMITMENT` envelopes. Do **not** re-run the v1 live final-auction.

**NETWORK_WRITES=0.**

---

## RouteGuard v2 Phase A accepted (v0.7.5)

**Checkpoint:** focused closure of all remaining Phase A medium/low findings.
**Date:** 2026-07-31.
**Network writes:** **0**. **v1 evidence:** unchanged.

### Acceptance verdict

**PHASE_A_ACCEPTED = YES**
**PHASE_B_READY = YES**

| Finding | Status | Closure |
|---|---|---|
| RG-V2-A-R01 | **FIXED** | Both stores share a typed `IMMUTABLE_FIELD_VIOLATION` CAS boundary for tender identity/version/hash/budget, the complete trust snapshot, and an established access receipt. |
| RG-V2-A-R02 | **FIXED** | Lock acquisition and stale-age evaluation use an injected UTC epoch-millisecond provider; production defaults at the `FileLifecycleStore` boundary and deterministic tests pin the fresh/stale boundary. |
| RG-V2-A-R03 | **FIXED** | `createTrustPolicy` and resolution-time lookup share explicit, separator-normalized reserved automation identity validation without substring matching human names. |
| RG-V2-A-008 | **FIXED** | Funding must exactly equal `maximumFreightBudgetAtomic`; underfunding and overfunding both fail, so no unmodeled residual can enter the lifecycle. |
| RG-V2-A-009 | **FIXED** | HCS payloads reject unknown fields, public IDs use a structured character set, and dispute reasons are a closed enum; narratives/PII cannot be smuggled through free-text fields. |
| RG-V2-A-010 | **FIXED** | HCS public IDs are capped at 64 characters and every message type is tested with realistic maximum valid values under the strict UTF-8 `< 1024` byte limit. |
| RG-V2-A-011 | **FIXED** | Lifecycle creation validates `maximumFreightBudgetAtomic` through authoritative `PositiveAtomicSchema`; malformed, zero/negative, decimal, exponent, signed, leading-zero, and non-string unsafe inputs fail. |
| RG-V2-A-012 | **FIXED** | Reducer events and persisted history are monotonic non-decreasing; explicit same-timestamp ordering remains valid. |
| RG-V2-A-013 | **FIXED** | Initial POD evidence binds version 1 plus content/ciphertext hashes; resubmission must retain the POD id, supply both hashes, and increment the POD version exactly. Persisted records and HCS POD metadata retain the binding. |
| RG-V2-A-014 | **FIXED** | Focused regressions cover every closure above, including memory/file parity and deterministic lock timing. |

### Locked invariants

- Direct memory and file CAS use the same immutable-field checks. An identical
  snapshot remains valid; a changed tender id/version/hash/budget, shipper key
  fingerprint/public key, referee registry, treasury, trust schema/algorithm,
  configured USDC token, or configured access amount is rejected before write.
- Exact funding is the Phase A invariant: `fundedAmountAtomic ===
  maximumFreightBudgetAtomic`. The no-qualified-bid refund therefore returns
  the complete funded amount without a separate residual ledger.
- Lifecycle event time may equal `updatedAt` but may never precede it. Persisted
  history also rejects timestamps before `createdAt` or earlier than a prior
  committed action.
- Public HCS payload shape is closed per message type. No dispute narrative,
  POD plaintext, personal data, or unmodeled note field is public evidence.
- The reducer remains pure: no wall clock, filesystem, network, env, or random
  reads. No HTTP, x402 middleware, facilitator, Mirror, HCS submission, escrow
  transfer, Solidity, POD upload, AI provider, frontend, or live artifacts were
  introduced.

### Validation

| Check | Result |
|---|---|
| `npm run typecheck` | **PASS** |
| Phase A focused tests (`test/v2-*.test.ts`) | **PASS** - 19 files / 196 tests |
| full `npm test` | **PASS** - 63 files / 753 tests |
| `npm run check:secrets` | **PASS** - 233 files scanned |
| `git diff --check` | **PASS** (CRLF conversion warnings only) |
| v1 `evidence/` + `data/` diff | **UNCHANGED** - 0 paths |
| Live Hedera / x402 / HCS | **NOT RUN** |

### Exact changed files (v0.7.5)

| File | Change |
|---|---|
| `PROJECT_STATUS.md` | v0.7.5 Phase A acceptance checkpoint |
| `docs/v2-lifecycle-file-store.md` | Injected lock-clock and exact stale-boundary documentation |
| `src/hcs/v2/envelope.ts` | Closed payload shapes, structured public ids, reason enum validation, size budgets, POD version validation |
| `src/hcs/v2/types.ts` | HCS id budget, dispute reason codes, POD version contract |
| `src/v2/lifecycle/events.ts` | POD submission/resubmission version input |
| `src/v2/lifecycle/record.ts` | Authoritative creation money validation and durable POD version/ciphertext hash |
| `src/v2/lifecycle/reducer.ts` | Exact funding, monotonic time, and POD evidence binding |
| `src/v2/schemas/pod.ts` | POD metadata version schema |
| `src/v2/store/file-lock.ts` | Injected lock time provider |
| `src/v2/store/lifecycle-store.ts` | Shared immutable CAS boundary and outer clock default |
| `src/v2/store/persisted-record.ts` | Exact funding, monotonic history, and complete POD evidence validation |
| `src/v2/store/persistence-errors.ts` | Typed immutable-field violation |
| `src/v2/trust/policy.ts` | Creation-time human referee identity validation |
| `test/v2-hcs-v2-messages.test.ts` | Realistic maximum HCS UTF-8 envelopes |
| `test/v2-hcs-v2-privacy.test.ts` | Free-text reason and unknown-field rejection |
| `test/v2-lifecycle-deadlines.test.ts` | Versioned POD resubmission fixtures |
| `test/v2-lifecycle-file-lock.test.ts` | Deterministic injected-clock stale boundary |
| `test/v2-lifecycle-fixtures.ts` | Initial POD version fixture |
| `test/v2-phase-a-closeout.test.ts` | R01-R03 and A-008-A-014 regression matrix |
| `test/v2-privacy-boundary.test.ts` | Versioned public POD metadata fixture |

### Current state

RouteGuard v2 Phase A is accepted. All recorded Phase A critical, high,
medium, and low findings are closed with focused regression proof. v1 evidence
and live behavior remain untouched, and no network write occurred.

### Next step

Phase B: x402 tender-activation and carrier-bid access gates under the existing
testnet/live-write guards. Do **not** re-run the v1 live final-auction.

**NETWORK_WRITES=0.**

---

## RouteGuard v2 Phase A remediation re-review (v0.7.4)

**Review type:** independent adversarial re-review of A3a (`322247e`) + A3b
(`6012921`) only. **Documentation-only** (this file).  
**Scope:** RG-V2-A-001 … A-007 plus residual defects introduced by remediations.  
**Network writes:** **0**. **v1 evidence:** unchanged.

### Validation (re-review)

| Check | Result |
|---|---|
| `npm run typecheck` | **PASS** |
| Phase A focused tests (18 files) | **PASS** — 145 / 145 |
| full `npm test` | **PASS** — 62 files / 702 tests |
| `npm run check:secrets` | **PASS** — 244 files |
| `git diff --check` | **PASS** |
| Live Hedera / x402 / HCS | **NOT RUN** |

### Verdict

**REMEDIATION_REVIEW = PASS**

| Finding | Status |
|---|---|
| RG-V2-A-001 referee self-allowlist | **FIXED** |
| RG-V2-A-002 crypto signature verification | **FIXED** |
| RG-V2-A-003 exact settlement binding | **FIXED** |
| RG-V2-A-004 file CAS concurrency | **FIXED** |
| RG-V2-A-005 persisted-state validation | **FIXED** |
| RG-V2-A-006 versioned access resource | **FIXED** |
| RG-V2-A-007 access treasury binding | **FIXED** |

**New CRITICAL:** 0 · **New HIGH:** 0 · **New MEDIUM:** 1 · **New LOW:** 2  
**Blocking findings:** **NONE**

### Verification summary (A-001 … A-007)

#### A-001 FIXED — Referee trust boundary
- Event type `REFEREE_RESOLUTION_RECORDED` has **no** allowlist field.
- Keys resolve only via `TrustPolicy` snapshotted at create (`record.trust`).
- Optional `event.refereePublicKey` must equal registry key or fail (`REFEREE_KEY_MISMATCH`).
- Unknown `refereeId` fails; AI-shaped IDs rejected at resolve.
- Reducer requires **sealed** referee auth; self-constructed objects fail WeakSet check.

#### A-002 FIXED — Cryptographic signatures
- Shipper + referee use `verifyCanonicalPayload` (Hiero ECDSA secp256k1).
- Domain separation: `ROUTEGUARD_V2_SHIPPER_POD_REVIEW` / `ROUTEGUARD_V2_REFEREE_RESOLUTION`.
- Bind tenderId/version, pod/dispute, action, amounts, reasons, actionId, signedAt.
- Transplant and forge cases covered in `test/v2-authorization-signatures.test.ts`.
- Sealed `VerifiedAuth` resists structural forgery / casting (test present).

#### A-003 FIXED — Settlement exact match
- PARTIAL: event amounts must equal stored referee decision (not only conserve).
- RELEASE_FULL / REFUND_FULL: decision type + amounts bound to locked amount.
- Covered in `test/v2-referee-resolution-binding.test.ts`.

#### A-004 FIXED — File CAS concurrency
- Full CAS sequence under per-tender `wx` lock (`file-lock.ts` + `FileLifecycleStore.compareAndSet`).
- Independent store instances (separate in-process mutexes) still serialize via lock file; concurrency test exercises filesystem exclusion, not a shared process mutex.
- Stale reclamation via atomic rename + token re-check; foreign lock release refused; malformed lock fails closed (not auto-deleted).
- Lifecycle + processedActions commit in one envelope rename.

#### A-005 FIXED — Persisted envelope validation
- Schema `routeguard-v2-lifecycle-store-1.0`; no `JSON.parse as Type` trust.
- Full nested + cross-field validation; integrity hashes recompute; unsupported version fails distinctly.
- Corruption does not reset to DRAFT or promote `.tmp`.
- Extensive negative cases in `test/v2-lifecycle-persisted-validation.test.ts`.

#### A-006 FIXED — Versioned resources
- Canonical paths include `/v/{tenderVersion}/` for activate and bid submit.
- Cross-version and unversioned path rejected at reduce and in access-receipt load validation.

#### A-007 FIXED — Treasury binding
- Expected payTo = `record.trust.accessTreasuryAccountId` only.
- Access receipt revalidated on load (token 0.0.429274, 1000 atomic, treasury, versioned resource).
- Access receipt does not authorize freight settlement (settlement uses locked/decision amounts).

### Residual findings (non-blocking)

#### RG-V2-A-R01 — MEDIUM — CAS does not pin trust-policy immutability
- **Category:** Persistence / trust boundary (defense in depth)  
- **Location:** `src/v2/store/lifecycle-store.ts` `assertCasPreconditions` (~98–133)  
- **Current:** CAS enforces tenderId, tenderVersion, expected version, and processed-action durability; it does **not** require `trust` / `tenderHash` / `maximumFreightBudgetAtomic` byte-identity with the prior record.  
- **Scenario:** A privileged direct `compareAndSet` caller (bypassing `LifecycleService`/`reduceLifecycle`) could swap the snapshotted shipper/referee/treasury keys while advancing version. Events and the normal service path cannot do this.  
- **Expected:** CAS rejects mutation of create-time identity bindings (trust snapshot, tenderHash, budget).  
- **Minimal fix:** Compare canonical hashes of immutable fields in `assertCasPreconditions`.  
- **Regression test:** CAS with altered `trust.shipperPublicKey` fails; prior version retained.  
- **Block Phase B:** No (service path remains correct; fix in A3c).

#### RG-V2-A-R02 — LOW — Stale-lock reclamation is wall-clock based
- **Category:** File lock  
- **Location:** `src/v2/store/file-lock.ts` ~273–276  
- **Current:** Staleness uses `Date.now() - acquiredAt`. Severe multi-host clock skew could reclaim a live lock.  
- **Expected:** Acceptable for single-host demo (documented in `docs/v2-lifecycle-file-store.md`); multi-instance needs DB/strong consistency.  
- **Minimal fix:** Document only, or add optional lease heartbeat for multi-host later.  
- **Block Phase B:** No.

#### RG-V2-A-R03 — LOW — AI referee IDs not rejected at trust-policy create
- **Category:** Trust policy  
- **Location:** `src/v2/trust/policy.ts` `createTrustPolicy` vs `resolveTrustedReferee`  
- **Current:** AI-shaped IDs rejected at resolve time, not at policy construction.  
- **Expected:** Fail closed at create for consistency.  
- **Minimal fix:** Share AI-id check in `createTrustPolicy`.  
- **Block Phase B:** No.

### Test quality notes (no new defects)

- Concurrency tests use **two `FileLifecycleStore` instances** (independent KeyedMutex); exclusion is filesystem lock + CAS re-read under lock — claim is established without child processes for same-OS exclusive `wx`.  
- Integrity tests corrupt then **omit reseal** so stale hashes fail; receipt mutations reseal to exercise field validators.  
- Signature tests use domain-separated payloads with transplant matrices.

### Changed files (v0.7.4)

| File | Change |
|---|---|
| `PROJECT_STATUS.md` | **Only** — this re-review record |

### Current state

A-001…A-007 verified fixed. No new CRITICAL/HIGH. Residual MEDIUM/LOW for A3c cleanup. Phase B still deferred until product readiness after A3c.

### Next steps

1. Phase A3c: medium/low cleanup (R01 trust pin on CAS; R02/R03 polish).  
2. Then plan Phase B x402 tender/bid gates under existing live-write guards.  
3. Do **not** re-run v1 live final-auction.

**Network writes in this checkpoint: 0.**

---

## RouteGuard v2 Phase A3b — lifecycle persistence hardening (v0.7.3)

Remediation of the remaining independent-review blockers **RG-V2-A-004** (file
CAS concurrency) and **RG-V2-A-005** (unvalidated persisted state). Offline
only: no HTTP routes, x402 middleware, facilitator, Mirror, HCS submit, escrow,
POD, AI, timeout worker, frontend, or testnet work. **Network writes: 0.**
v1 behaviour and v1 live evidence unchanged.

### Findings fixed

| ID | Fix |
|---|---|
| RG-V2-A-004 | Per-tender cross-process lock file (`wx` exclusive create) wraps the entire read → validate → compare → write → verify sequence; loser fails closed with `VERSION_CONFLICT`/`LOCK_BUSY`/`LOCK_TIMEOUT` |
| RG-V2-A-005 | Raw `JSON.parse(...) as LifecycleRecord` replaced by a versioned persisted envelope with complete structural, nested, and cross-field validation; typed corruption errors |

### Persisted-envelope validation

- Storage schema `routeguard-v2-lifecycle-store-1.0`, version `1`; unknown
  identifiers/versions fail closed with `UNSUPPORTED_STORAGE_VERSION`.
- Envelope carries schema id/version, tenderId, tenderVersion, monotonic
  `recordVersion`, `createdAt`/`updatedAt`, the lifecycle record, the
  trust-policy snapshot, a tender-bound processed-action index, and sha256
  integrity metadata over record + action index.
- Load path: read bytes → strict UTF-8 decode → guarded `JSON.parse` → schema
  gate → strict envelope validation → full record validation → cross-field
  invariants → integrity recomputation. No `as` cast substitutes for validation;
  unknown persisted fields are rejected.
- Cross-field invariants: envelope↔record tender/version/recordVersion/timestamp
  equality; trust snapshot equality plus shipper fingerprint recomputation;
  per-action tender binding, uniqueness, and record agreement;
  `history.length === processedActions size`, `recordVersion === history + 1`;
  `createdAt <= updatedAt`; state-specific required metadata; absence of
  state-incompatible settlement metadata; funded ≥ budget; win ≤ budget;
  `locked === winning` and `locked + excess === budget`; referee decisions
  conserve the locked amount, match the resolution kind, and name a referee in
  the persisted registry; access receipt pinned to token `0.0.429274`, amount
  `1000` atomic, configured treasury, and the canonical tender-versioned
  resource.
- New durable field `record.accessReceipt` (written by the reducer at
  `TENDER_ACTIVATION_PAID`) makes the paid access gate re-verifiable after
  restart. `payerAccount` is now validated as a Hedera account id.

### Locking implementation

- One lock file per tender (`lifecycle-<tenderId>.lock`) — never a global lock.
- Atomic exclusive create; metadata `{ v, pid, host, token, tenderId, acquiredAt }`.
- Release verifies the ownership token; another owner's lock is never removed.
- Bounded retry/backoff with explicit timeout — defaults `acquireTimeoutMs 5000`,
  `retryIntervalMs 20`, `staleAfterMs 60000`; `acquireTimeoutMs: 0` fails
  immediately with `LOCK_BUSY`.
- In-process `KeyedMutex` retained as an optimization only.

### Stale-lock policy

- Reclaim only when metadata is valid **and** age exceeds `staleAfterMs`.
- Race-safe: atomic rename aside to `<lock>.stale.<token>`, then confirmation
  that the moved lock carries the exact inspected ownership token; a replacement
  observed mid-flight fails closed with `LOCK_CORRUPT` and preserves evidence.
- Malformed/empty/unreadable locks are never auto-deleted — `LOCK_CORRUPT`
  requires operator recovery.

### Atomic-write strategy and corruption behaviour

- Unique temp name (`pid` + lock token + UUID) in the target directory, created
  with `wx`; write → fsync → atomic rename → best-effort directory fsync →
  read-back re-validation; lock released only after the rename.
- Failure preserves the previous authoritative record, cleans up only the owned
  temp file, releases the lock, and raises `ATOMIC_WRITE_FAILED`.
- `.tmp` files are never authoritative or promoted;
  `cleanupAbandonedLifecycleTempFiles()` gives deterministic, age-bounded
  recovery that never touches `.json` or `.lock` files.
- Corrupt authoritative state is never deleted, repaired, or reset to `DRAFT`.
- Typed categories: `RECORD_NOT_FOUND`, `VERSION_CONFLICT`, `LOCK_BUSY`,
  `LOCK_TIMEOUT`, `LOCK_CORRUPT`, `RECORD_CORRUPT`,
  `UNSUPPORTED_STORAGE_VERSION`, `ATOMIC_WRITE_FAILED`, `ACTION_ID_CONFLICT`.
  Public messages expose no filesystem paths, POD content, or key material.

### Store parity

In-memory and file adapters now share expected-version checks, action-id
replay/conflict rules, tender/version binding, full record validation, and
store-owned version increment. Only lock/corruption behaviour differs.

### Changed / added files (v0.7.3)

| File | Change |
|---|---|
| `PROJECT_STATUS.md` | v0.7.3 A3b checkpoint |
| `docs/v2-lifecycle-file-store.md` | **New** — storage schema, lock model, stale policy, atomic write, corruption + operator recovery, Windows assumptions, limitations |
| `src/v2/store/persistence-errors.ts` | **New** — typed persistence error categories |
| `src/v2/store/file-lock.ts` | **New** — per-tender cross-process lock, stale reclamation |
| `src/v2/store/persisted-record.ts` | **New** — persisted envelope + complete validation |
| `src/v2/store/lifecycle-store.ts` | Lock-held CAS, envelope persistence, atomic write + verify, temp-file recovery, in-memory parity |
| `src/v2/lifecycle/record.ts` | `accessReceipt` durable field |
| `src/v2/lifecycle/reducer.ts` | Records the access receipt; validates `payerAccount` |
| `src/v2/lifecycle/errors.ts` | Stable `code` on not-found / version-conflict / action-conflict errors |
| `test/v2-lifecycle-fixtures.ts` | `rejectToDispute`, `recordRefereeDecision` helpers |
| `test/v2-lifecycle-file-lock.test.ts` | **New** — 9 tests |
| `test/v2-lifecycle-persisted-validation.test.ts` | **New** — 36 tests |
| `test/v2-lifecycle-file-store-concurrency.test.ts` | **New** — 10 tests |
| `test/v2-lifecycle-atomic-write.test.ts` | **New** — 3 tests |

### Validation (v0.7.3)

- `npm run typecheck`: **PASS**
- Phase A1/A2/A3a/A3b focused tests (`test/v2-*.test.ts`): **PASS** — 18 files /
  145 tests; 0 failed
- full `npm test`: **PASS** — 62 files / 702 tests; 0 failed
- `npm run check:secrets`: **PASS** — 244 files scanned
- `git diff --check`: **PASS** (CRLF warnings only)
- v1 evidence `evidence/` + `data/`: **unchanged** (0 modified paths)
- live Hedera / x402 / HCS writes: **NOT RUN**

### Current state

Phase A blockers RG-V2-A-001 … A-007 are all remediated. Lifecycle persistence
is concurrency-safe across processes, fully validated on load, atomically
committed with its idempotency index, and documented for operators. Local-file
persistence remains a guarded testnet/demo choice — production multi-instance
deployment should use a transactional database or equivalent strongly
consistent store (not introduced in this phase).

### Next step

Targeted independent re-review of **RG-V2-A-001 through A-007 and Phase A3b**;
only then plan Phase B x402 tender/bid gates. Do **not** re-run the v1 live
final-auction.

**Network writes in this checkpoint: 0.**

---

## RouteGuard v2 Phase A3a — authorization bindings (v0.7.2)

Remediation of independent-review findings **RG-V2-A-001, A-002, A-003, A-006,
A-007**. No network writes. File-store concurrency/corruption (A-004/A-005)
deferred to Phase A3b.

### Findings fixed

| ID | Fix |
|---|---|
| RG-V2-A-001 | Referee allowlist removed from events; registry only on injected `TrustPolicy` snapshotted at create |
| RG-V2-A-002 | Real Hiero ECDSA verify via `verifyCanonicalPayload` over domain-separated payloads; sealed `VerifiedAuth` (WeakSet) required by reducer |
| RG-V2-A-003 | Settlement confirmation amounts must exactly match recorded referee decision (not merely conserve lock) |
| RG-V2-A-006 | Access resources bind `tenderId` + `tenderVersion` (`tenderActivateResource` / `bidSubmitResource`) |
| RG-V2-A-007 | `payTo` must equal `record.trust.accessTreasuryAccountId` |

### Cryptographic approach

- Reuses existing `src/domain/signature.ts` (Hiero ECDSA secp256k1, 64-byte r‖s hex).
- No new cryptography dependencies.
- Domain separation purposes:
  - `ROUTEGUARD_V2_SHIPPER_POD_REVIEW`
  - `ROUTEGUARD_V2_REFEREE_RESOLUTION`
- Canonical JSON via repository `canonicalize()` (sorted keys).
- Tests generate ephemeral ECDSA key pairs at runtime (never committed).

### Trust-policy boundary

- `src/v2/trust/policy.ts` — immutable `TrustPolicy` (shipper key, referee registry, access treasury).
- Snapshotted onto lifecycle record at create; events cannot override.
- Verification in `LifecycleService` before pure reduce; reducer never reads env/files.

### Changed / added files (v0.7.2)

| File | Change |
|---|---|
| `PROJECT_STATUS.md` | v0.7.2 A3a checkpoint |
| `src/v2/trust/policy.ts` | **New** — external trust policy |
| `src/v2/access/resource.ts` | **New** — versioned protected resources |
| `src/v2/auth/canonical.ts` | **New** — domain-separated sign payloads |
| `src/v2/auth/verify.ts` | **New** — ECDSA verify + sealed auth |
| `src/v2/lifecycle/events.ts` | Shipper/referee fields; remove event allowlist |
| `src/v2/lifecycle/record.ts` | Trust snapshot + resolution binding fields |
| `src/v2/lifecycle/reducer.ts` | Auth, treasury, resource, settlement exact match |
| `src/v2/store/lifecycle-service.ts` | Pre-reduce verification |
| `test/v2-lifecycle-fixtures.ts` | Ephemeral keys + signed helpers |
| `test/v2-lifecycle-*.test.ts` | Updated for auth |
| `test/v2-authorization-signatures.test.ts` | **New** |
| `test/v2-referee-resolution-binding.test.ts` | **New** |
| `test/v2-access-policy-binding.test.ts` | **New** |

### Validation (v0.7.2)

- `npm run typecheck`: **PASS**
- Phase A focused tests: **PASS** — 14 files / 87 tests
- full `npm test`: **PASS** — 58 files / 644 tests
- `npm run check:secrets`: **PASS** — 236 files scanned
- `git diff --check`: **PASS**
- v1 evidence: **unchanged**
- Network writes: **0**

### Unresolved blockers (deferred)

- **RG-V2-A-004** — File CAS concurrency lock
- **RG-V2-A-005** — File load schema validation / corrupt-state fail-closed

### Current state

Authorization and access-payment bindings hardened. Phase B still blocked on
A-004/A-005 file-store hardening (A3b).

### Next steps

1. Phase A3b: file-store concurrency and corruption hardening (A-004, A-005).
2. Re-review blockers; then Phase B x402 tender/bid gates.
3. Do **not** re-run v1 live final-auction.

**Network writes in this checkpoint: 0.**

---

## RouteGuard v2 Phase A independent review (v0.7.1)

**Review type:** adversarial, documentation-only (no production source/test changes).  
**Scope:** Phase A1 (`875c352`) + Phase A2 (`8f4265f`) only.  
**Network writes:** **0**.  
**v1 evidence:** **unchanged**.

### Review validation

| Check | Result |
|---|---|
| `npm run typecheck` | **PASS** |
| Phase A focused tests (11 files) | **PASS** — 63 / 63 |
| full `npm test` | **PASS** — 55 files / 620 tests |
| `npm run check:secrets` | **PASS** — 229 files |
| `git diff --check` | **PASS** |
| Live Hedera / x402 / HCS writes | **NOT RUN** |

### Verdict

**PHASE_A_REVIEW = FAIL** (blocking defects).  
**PHASE_B_READY = NO** until CRITICAL/HIGH findings are remediated.

Category scores (relative to Phase A claims):

| Category | Score | Notes |
|---|---|---|
| State machine graph | PASS | Intended edges; terminal complete path; no illegal shortcuts found |
| Event binding | FAIL | Referee allowlist attacker-controlled; weak auth bindings |
| Deadlines | PASS | 48h/24h/24h exact; at-boundary accept/deemed; after-boundary reject |
| Action idempotency | PASS | Canonical payload hash; replay no version bump; conflict on payload change |
| CAS persistence | FAIL | No concurrent lock; unvalidated file load |
| Money conservation | FAIL | Allocation OK; partial settlement not bound to referee amounts |
| Access fee model | PASS | Derived 1000; minor binding gaps (version/payTo) |
| AI non-binding | PASS | Advisory cannot authorize settlement states |
| Referee authorization | FAIL | No crypto verify; allowlist from event |
| HCS 2.0 contracts | PASS | 16 types; UTF-8 `<1024`; privacy by field name (gaps on free text) |

### Findings

#### RG-V2-A-001 — CRITICAL — Referee authorization
- **Category:** Referee authorization / event binding  
- **Location:** `src/v2/lifecycle/reducer.ts` ~793–798 (`REFEREE_RESOLUTION_RECORDED`)  
- **Current:** `event.allowlistedRefereeKeys.includes(event.refereePublicKey)` — allowlist is **supplied by the event**.  
- **Attack:** Submit a resolution with `allowlistedRefereeKeys: [attackerKey]` and matching `refereePublicKey`; any hex signature of length 128 passes later shape checks. Reaches `REFEREE_DECISION` then release/refund/partial.  
- **Expected:** Allowlist from deployment config / tender record only; never from the untrusted event body.  
- **Minimal fix:** Store `allowlistedRefereeKeys` on lifecycle create or config; ignore event allowlist; fail if event tries to supply one.  
- **Regression test:** Event carrying self-allowlisted key must fail; config allowlist must succeed.  
- **Block Phase B:** **YES** (before any settlement-dependent path; treat as blocker for A remediation even if B is access-only).

#### RG-V2-A-002 — CRITICAL — Signature presence ≠ verification
- **Category:** Referee / shipper authorization  
- **Location:** `reducer.ts` ~656–661 (shipper), ~799–809 (referee); `src/v2/schemas/referee.ts` ~33–35  
- **Current:** Only format checks (non-empty / 128 hex). No ECDSA verify over canonical resolution/accept payload. `signedPayloadHash` is not bound by crypto.  
- **Attack:** After A-001 fix, still forge signatures without the private key if only format is checked; transplant any 128-hex blob between disputes.  
- **Expected:** Verify signature with allowlisted key over canonical bytes of outcome, amounts, tenderId, podId, disputeId (existing `signature.ts` pattern). Shipper accept/reject similarly.  
- **Minimal fix:** Call `verifyCanonicalPayload` (or equivalent) before transitioning.  
- **Regression test:** Wrong signature fails; signature for dispute A fails on dispute B (transplant).  
- **Block Phase B:** **YES** for settlement; **YES** for any path claiming human authorization.

#### RG-V2-A-003 — HIGH — Partial settlement not bound to referee decision amounts
- **Category:** Money conservation / event binding  
- **Location:** `reducer.ts` ~891–924 (`ESCROW_PARTIAL_RELEASE_CONFIRMED`)  
- **Current:** Checks `release + refund === locked` only; does **not** require equality with `record.releaseAmountAtomic` / `record.refundAmountAtomic` set at `REFEREE_DECISION`.  
- **Attack:** Referee records 400k/300k; later settlement event posts 100k/600k (still conserves lock) — different economic outcome than the signed decision.  
- **Expected:** Settlement amounts must exactly match recorded referee resolution (and resolution type).  
- **Minimal fix:** Assert event amounts === record fields; fail closed on mismatch.  
- **Regression test:** Mismatched partial amounts after referee decision fail.  
- **Block Phase B:** **YES** before escrow release integration.

#### RG-V2-A-004 — HIGH — File CAS lacks concurrency control
- **Category:** CAS / persistence  
- **Location:** `src/v2/store/lifecycle-store.ts` ~146–171 (`FileLifecycleStore.compareAndSet`)  
- **Current:** Read version → check → writeAtomic with no file lock / mutex (unlike v1 reservation store).  
- **Failure:** Two writers both observe version N; both write N+1; last writer wins; one transition lost despite CAS intent.  
- **Expected:** Exclusive lock or atomic CAS primitive; loser must fail and retry after re-read.  
- **Minimal fix:** Port reservation-style `wx` lock or keyed mutex around read-check-write.  
- **Regression test:** Concurrent applies; at most one succeeds per version; no silent clobber.  
- **Block Phase B:** **YES** if multi-process/server writers; **YES** before production-like durability claims.

#### RG-V2-A-005 — HIGH — File load trusts unvalidated JSON
- **Category:** CAS / persistence  
- **Location:** `lifecycle-store.ts` ~138–144 (`get`); no schema assert on CAS write  
- **Current:** `JSON.parse(raw) as LifecycleRecord` with no Zod/schema validation.  
- **Attack/failure:** Corrupt or hand-edited file can present `state: PAYMENT_RELEASED`, forged `lockedAmountAtomic`, empty `processedActions` → illegal economic assumptions on next apply.  
- **Expected:** Fail-closed parse via record schema (state enum, atomic strings, version).  
- **Minimal fix:** Validate with Zod on every read/write (v1 reservation pattern).  
- **Regression test:** Mutated state/amount on disk fails on load.  
- **Block Phase B:** **YES** before relying on file durability for gates/settlement.

#### RG-V2-A-006 — MEDIUM — Access resource omits tender version
- **Category:** Access fee / event binding  
- **Location:** `reducer.ts` ~315–320  
- **Current:** Resource must equal `/api/v2/tenders/${tenderId}/activate` only.  
- **Scenario:** Payment for version 1 could be presented for a different lifecycle row sharing tenderId (if versioning model ever reuses ids) or resource replay across versions.  
- **Expected:** Resource binds tenderId **and** tenderVersion (and ideally actionId).  
- **Minimal fix:** Include version in expected path or challenge description fields.  
- **Regression test:** Wrong version resource fails.  
- **Block Phase B:** Recommended before x402 gate wiring.

#### RG-V2-A-007 — MEDIUM — Access payTo not bound to treasury
- **Category:** Access fee  
- **Location:** `reducer.ts` `TENDER_ACTIVATION_PAID`; `fee.ts` documents env key only  
- **Current:** Asset/amount checked; `payTo`/`payerAccount` not validated against `ROUTEGUARD_ACCESS_TREASURY_ACCOUNT_ID`.  
- **Scenario:** Access receipt can name arbitrary payTo while still opening tender.  
- **Expected:** When treasury configured, payTo must match; fail closed if required and missing.  
- **Minimal fix:** Bind payTo from config in reducer/service.  
- **Regression test:** Wrong payTo fails.  
- **Block Phase B:** Recommended for Phase B gates.

#### RG-V2-A-008 — MEDIUM — Overfund excess not modeled on no-bid refund
- **Category:** Money conservation  
- **Location:** `reducer.ts` ~939–945  
- **Current:** NO_QUALIFIED_BID refund must equal `maximumFreightBudgetAtomic`, not `fundedAmountAtomic`.  
- **Scenario:** Shipper funded budget+delta; only budget refunded; leftover stuck in escrow model.  
- **Expected:** Refund funded amount or explicit residual accounting.  
- **Minimal fix:** Refund `fundedAmountAtomic` (or locked residual field).  
- **Regression test:** Overfund → full fund refund.  
- **Block Phase B:** No (escrow Phase C).

#### RG-V2-A-009 — MEDIUM — HCS free-text fields can smuggle PII
- **Category:** HCS privacy  
- **Location:** `src/hcs/v2/privacy.ts` (key-name blocklist only); `DISPUTE_OPENED.reasonCode` free string  
- **Current:** Privacy is field-name based; values in `reasonCode` / similar can hold names, phones, narratives.  
- **Expected:** Structured reason codes only, or length/charset limits + denylist content checks for free text.  
- **Minimal fix:** Enum reason codes; reject free narrative fields.  
- **Regression test:** PII-like reasonCode fails or is rejected by schema.  
- **Block Phase B:** No.

#### RG-V2-A-010 — MEDIUM — HCS size only checked on small samples
- **Category:** HCS contracts / tests  
- **Location:** `src/hcs/v2/envelope.ts` `assertHcsV2EnvelopeWithinLimit`; `test/v2-hcs-v2-messages.test.ts`  
- **Current:** Build path enforces UTF-8 `<1024` (good); tests use short IDs. Max-length IDs (128) across fields may fail at runtime only.  
- **Expected:** Explicit max-budget envelope fixture test; consider tighter field budgets.  
- **Minimal fix:** Add worst-case size test; shrink allowed id lengths if needed.  
- **Regression test:** Max-length fields still `<1024` or fail closed predictably.  
- **Block Phase B:** No.

#### RG-V2-A-011 — MEDIUM — Lifecycle create lacks money/schema guards
- **Category:** Money / persistence  
- **Location:** `src/v2/lifecycle/record.ts` `createLifecycleRecord`  
- **Current:** Accepts any string budget/hash without atomic/hash validation.  
- **Expected:** Positive atomic budget; valid tenderHash at create.  
- **Minimal fix:** Validate on create and on store write.  
- **Regression test:** Invalid budget/hash rejected.  
- **Block Phase B:** Recommended.

#### RG-V2-A-012 — LOW — No monotonic eventTime guard
- **Category:** Deadlines  
- **Location:** `reducer.ts` (all events)  
- **Current:** `eventTime` can be earlier than `updatedAt`.  
- **Expected:** Optional fail-closed non-decreasing eventTime for audit integrity.  
- **Minimal fix:** Reject `eventTime < updatedAt` where appropriate.  
- **Regression test:** Backward eventTime fails.  
- **Block Phase B:** No.

#### RG-V2-A-013 — LOW — POD resubmit omits ciphertextHash requirement
- **Category:** Event binding  
- **Location:** `reducer.ts` ~637–646  
- **Current:** Requires podId + contentHash only.  
- **Expected:** Require ciphertextHash as on first submit.  
- **Minimal fix:** Require both hashes.  
- **Regression test:** Missing ciphertextHash fails.  
- **Block Phase B:** No.

#### RG-V2-A-014 — LOW — Test gaps (non-exhaustive)
- **Category:** Test adequacy  
- **Missing:** crypto verify/transplant; concurrent file CAS; load corrupt JSON; max HCS size; actionId after process restart via file store; cross-tender service misuse; overfund refund; resource version binding.  
- **Block Phase B:** No by itself; required with A-001–A-005 fixes.

### Positive controls confirmed

- Access fee `0.001` → derived **1000** atomic via decimals 6 (not bare hardcode as sole authority).  
- Token pin `0.0.429274`.  
- Pure reducer: no `Date.now` / random / network in lifecycle reduce path.  
- Deadline boundaries (at/after) covered by tests.  
- AI `POD_ADVISORY_ANCHORED` cannot move to release/accept/dispute.  
- Allocation conservation `win + excess = max` enforced.  
- HCS schema `routeguard-hcs-2.0`; size uses UTF-8 byte length.  
- v1 final-demo evidence and tests unaffected (suite green).

### Changed files (v0.7.1)

| File | Change |
|---|---|
| `PROJECT_STATUS.md` | **Only** — this independent review record |

### Current state

Phase A1+A2 implementation remains as committed. Independent review found **2 CRITICAL**, **3 HIGH**, **6 MEDIUM**, **3 LOW**. Remediation required before Phase B.

### Next steps

1. Focused Codex remediation of **RG-V2-A-001 … A-005** (blockers), then A-006/A-007/A-011.  
2. Add regression tests listed per finding.  
3. Re-review; only then plan Phase B x402 tender/bid gates.  
4. Do **not** re-run v1 live final-auction.

**Network writes in this checkpoint: 0.**

---

## RouteGuard v2 Phase A2 — lifecycle engine and HCS 2.0 (v0.7.0)

Deterministic, pure lifecycle reducer with legal-transition guards, deadline
arithmetic, action-id idempotency, CAS persistence (memory + filesystem), and
offline `routeguard-hcs-2.0` message contracts. **No network writes. No HTTP
routes, x402 middleware, HCS submit, escrow runtime, or POD upload.** Phase A1
schemas preserved. v1 live evidence unchanged.

### Delivered

| Area | Implementation |
|---|---|
| Events + reducer | `src/v2/lifecycle/events.ts`, `reducer.ts` — pure; no Date.now/random/IO |
| Deadlines | `src/v2/lifecycle/deadlines.ts` — 48h review / 24h correction / 24h post-resubmit |
| Record | `src/v2/lifecycle/record.ts` — versioned history + processedActions |
| CAS store | `src/v2/store/lifecycle-store.ts` — InMemory + File (atomic write/rename) |
| Idempotency service | `src/v2/store/lifecycle-service.ts` — replay vs conflict |
| HCS 2.0 | `src/hcs/v2/*` — 16 message types, builders, size & privacy checks |

### Changed / added files (v0.7.0)

| File | Change |
|---|---|
| `PROJECT_STATUS.md` | Version 0.7.0 Phase A2 checkpoint |
| `src/v2/lifecycle/deadlines.ts` | **New** — deadline arithmetic |
| `src/v2/lifecycle/errors.ts` | **New** — typed lifecycle errors |
| `src/v2/lifecycle/events.ts` | **New** — typed events |
| `src/v2/lifecycle/record.ts` | **New** — durable record shape |
| `src/v2/lifecycle/reducer.ts` | **New** — pure reducer + legal graph |
| `src/v2/store/lifecycle-store.ts` | **New** — CAS memory/file stores |
| `src/v2/store/lifecycle-service.ts` | **New** — apply + idempotency |
| `src/hcs/v2/types.ts` | **New** — HCS 2.0 message types |
| `src/hcs/v2/privacy.ts` | **New** — public-safe field enforcement |
| `src/hcs/v2/envelope.ts` | **New** — builders, serialize, size checks |
| `test/v2-lifecycle-fixtures.ts` | **New** — shared A2 fixtures |
| `test/v2-lifecycle-state-machine.test.ts` | **New** |
| `test/v2-lifecycle-deadlines.test.ts` | **New** |
| `test/v2-lifecycle-idempotency.test.ts` | **New** |
| `test/v2-lifecycle-store.test.ts` | **New** |
| `test/v2-hcs-v2-messages.test.ts` | **New** |
| `test/v2-hcs-v2-privacy.test.ts` | **New** |

### Validation (v0.7.0)

- `npm run typecheck`: **PASS**
- Phase A1+A2 focused vitest: **PASS** — 11 files / 63 tests; 0 failed
- full `npm test`: **PASS** — 55 files / 620 tests; 0 failed
- `npm run check:secrets`: **PASS** — 229 files scanned
- `git diff --check`: **PASS**
- v1 evidence `evidence/final-demo-*`: **unchanged**
- live final-auction / Hedera writes: **NOT RUN**

### Current state

Phase A2 complete offline: lifecycle engine, CAS, idempotency, and HCS 2.0
contracts are test-backed. Ready for independent Phase A review, then Phase B
x402 tender/bid access gates.

### Next steps

1. Independent Phase A review.
2. Phase B: x402 tender-activation and bid-submission gates (testnet-ready, guarded).
3. Do **not** re-run v1 live final-auction.

**Network writes in this checkpoint: 0.**

---

## Production brand assets finalized (v0.6.1)

Pre-existing untracked production brand candidates under
`assets/brand/routeguard/` are validated and committed so the working tree is
clean before Phase A2. **No redesign, no regeneration, no application-code
changes.** Phase A1 commit `875c352` is preserved (not amended). Network
writes: **0**.

### Files retained (production)

| Asset | Role / check |
|---|---|
| `routeguard-logo.svg` | General horizontal lockup; XML OK; no embedded raster; no external resources |
| `routeguard-social-card.svg` | OG / social composite 1200×630; already in manifest §14 |
| `routeguard-video-title.svg` | Video title 1920×1080; already in manifest §15 |
| `routeguard-favicon-16.png` | 16×16 ARGB favicon render of favicon SVG |
| `routeguard-favicon-32.png` | 32×32 ARGB favicon render |
| `routeguard-favicon-48.png` | 48×48 ARGB favicon render |

### Files removed as duplicates

None — none of the six candidates were byte-duplicates of tracked masters, and
no scrap/export/thumbnail files remained untracked on this branch.

### Manifest

`ROUTEGUARD_BRAND_ASSET_MANIFEST.md` updated: favicon PNG renders (12a–12c) and
`routeguard-logo.svg` (§16) documented; social/video entries already present.

### Changed / added files (v0.6.1)

| File | Change |
|---|---|
| `PROJECT_STATUS.md` | Version 0.6.1 brand-asset finalization |
| `assets/brand/routeguard/routeguard-logo.svg` | **Tracked** — production lockup |
| `assets/brand/routeguard/routeguard-social-card.svg` | **Tracked** — social composite |
| `assets/brand/routeguard/routeguard-video-title.svg` | **Tracked** — video title |
| `assets/brand/routeguard/routeguard-favicon-16.png` | **Tracked** — 16×16 favicon |
| `assets/brand/routeguard/routeguard-favicon-32.png` | **Tracked** — 32×32 favicon |
| `assets/brand/routeguard/routeguard-favicon-48.png` | **Tracked** — 48×48 favicon |
| `assets/brand/routeguard/ROUTEGUARD_BRAND_ASSET_MANIFEST.md` | Index entries for logo + favicon PNGs |

### Validation (v0.6.1)

- SVG integrity (XML parse; no `data:image` / base64; no external hrefs): **PASS**
- PNG dimensions 16 / 32 / 48: **PASS**
- `npm run check:secrets`: **PASS**
- `git diff --check`: **PASS**
- Phase A1 commit `875c352`: **preserved**
- v1 evidence `evidence/final-demo-*`: **unchanged**
- Network writes: **0**

### Current state

Working tree brand dirt cleared; production brand set complete for tracked
canonical assets. Phase A1 schemas/ADR remain as committed. Ready for Phase A2.

### Next steps

1. Phase A2: deterministic lifecycle state machine, CAS persistence, HCS v2 definitions.
2. Do **not** re-run v1 live final-auction.

**Network writes in this checkpoint: 0.**

---

## RouteGuard v2 Phase A1 — architecture, money model, schemas (v0.6.0)

Owner-approved ADR-002 and Phase A1 offline foundation: architecture plan
import, access-fee derivation, lifecycle vocabulary, typed Zod schemas, and
focused tests. **No network writes. No HTTP/x402 routes. No HCS/escrow/POD
runtime. v1 live evidence unchanged.**

### ADR-002

**Accepted** (2026-07-31): `docs/ADR-002-v2-escrow-pod-architecture.md`

- HTS smart-contract freight escrow authorized; Scheduled Transaction escrow still excluded
- Two x402 access gates at product price 0.001 USDC (1000 atomic @ 6 decimals)
- Freight principal never presented as x402 access payment
- HCS 2.0 public-safe evidence; encrypted off-chain POD; advisory-only AI; human referee
- Separate `evidence/v2/` namespace; v1 `evidence/final-demo-*` immutable

### Changed / added files (v0.6.0)

| File | Change |
|---|---|
| `PROJECT_STATUS.md` | Version 0.6.0 Phase A1 checkpoint |
| `docs/plans/routeguard-v2-architecture-migration-plan.md` | **New** — owner-locked architecture plan copy |
| `docs/ADR-002-v2-escrow-pod-architecture.md` | **New** — Accepted ADR-002 |
| `src/v2/access/fee.ts` | **New** — access fee derivation + atomic money helpers |
| `src/v2/lifecycle/states.ts` | **New** — lifecycle vocabulary (no reducer) |
| `src/v2/schemas/common.ts` | **New** — shared hash/atomic/PII helpers |
| `src/v2/schemas/tender.ts` | **New** — v2 tender schema |
| `src/v2/schemas/access-receipt.ts` | **New** — access payment receipt schema |
| `src/v2/schemas/pod.ts` | **New** — POD metadata schema |
| `src/v2/schemas/advisory.ts` | **New** — non-binding AI advisory schema |
| `src/v2/schemas/shipper-review.ts` | **New** — shipper review actions |
| `src/v2/schemas/referee.ts` | **New** — human referee resolution |
| `src/v2/schemas/escrow-allocation.ts` | **New** — escrow allocation conservation |
| `test/v2-access-fee.test.ts` | **New** — access fee derivation tests |
| `test/v2-lifecycle-states.test.ts` | **New** — lifecycle vocabulary tests |
| `test/v2-schemas.test.ts` | **New** — schema tests |
| `test/v2-money-model.test.ts` | **New** — money model tests |
| `test/v2-privacy-boundary.test.ts` | **New** — privacy / advisory boundary tests |

### Validation (v0.6.0)

- `npm run typecheck`: **PASS**
- focused vitest (`test/v2-*.test.ts`): **PASS** — 5 files / 31 tests; 0 failed
- full `npm test`: **PASS** — 49 files / 588 tests; 0 failed
- `npm run check:secrets`: **PASS** — 212 files scanned
- `git diff --check`: **PASS**
- v1 evidence `evidence/final-demo-*`: **unchanged** (not modified)
- live final-auction / Hedera writes: **NOT RUN**

### Current state

Phase A1 complete: locked decisions are encoded as ADR-002, schemas, and offline
tests. Product access fee derives to **1000** atomic USDC. Ready for Phase A2
(deterministic lifecycle state machine, HCS v2 message definitions, CAS
persistence) — still offline-first.

### Next steps

1. Phase A2: deterministic state machine, HCS v2 definitions, CAS persistence.
2. Phase B+: x402 access gates, escrow contract, POD/review, dispute, website.
3. Do **not** re-run v1 live final-auction; do not write `evidence/v2/` until authorized live work.

**Network writes in this checkpoint: 0.** No Hedera transaction, HCS submission,
payment, push, deployment, or other network write occurred.

---

## RouteGuard production brand integration (v0.5.1)

Approved Stitch production SVG assets and the brand integration handoff are
copied into the repository and wired into the existing development shell and
public proof report. **No payment, auction, settlement, or live evidence values
changed.** Hedera brand assets remain unmodified. Network writes: **0**.

### Brand assets integrated

Source: `F:\Temp\RouteGuard_Stitch_Production_Assets` →
`assets/brand/routeguard/` (canonical) and `public/brand/routeguard/` (served).

| Asset | Role |
|---|---|
| `routeguard-full-lockup-light.svg` | Design-system / formal identity |
| `routeguard-full-lockup-dark.svg` | Dark footer brand anchor |
| `routeguard-compact-header-light.svg` | Desktop global / proof header |
| `routeguard-compact-header-dark.svg` | Ops console expanded sidebar |
| `routeguard-symbol.svg` | Ops console collapsed sidebar |
| `routeguard-symbol-small.svg` | Mobile header / proof mobile header |
| `routeguard-trust-lane-horizontal.svg` | How-it-works + proof timeline motif |
| `routeguard-proof-rail-mobile.svg` | Mobile process / evidence rail |
| `routeguard-route-divider.svg` | Available divider motif |
| `routeguard-favicon.svg` | Browser favicon |
| `routeguard-app-icon.svg` | App icon source |
| `routeguard-full-lockup-monochrome.svg` | Single-color formal lockup |
| `routeguard-full-lockup-white.svg` | White formal lockup |
| `ROUTEGUARD_BRAND_ASSET_MANIFEST.md` | Asset index |
| `routeguard-logo-specification.md` | Geometry specification |
| `ROUTEGUARD_BRAND_INTEGRATION_HANDOFF.md` | Screen/component placement contract |

### Screens / components updated

| Surface | Placements |
|---|---|
| Design system / development shell (`src/server/page.ts`) | Master identity (full lockup light); desktop compact header; mobile symbol-small; ops sidebar expanded/collapsed; how-it-works trust-lane + mobile proof-rail; dark footer full lockup; favicon |
| Live proof report (`scripts/render-final-demo-report.ts` → `evidence/*-report.html`) | Light brand bar compact header; mobile symbol-small; trust-lane + mobile proof-rail on timeline (labels/timestamps preserved); dark footer lockup; favicon |
| Static serving (`src/server/app.ts`) | `/brand/*` from `public/` (RouteGuard + existing Hedera) |

Responsive substitutions (≤480px): compact → symbol-small; trust-lane → proof-rail-mobile.
Accessibility: meaningful alt on lockups/symbols; empty alt + `aria-hidden` on motifs.
Symbol is not used as a status icon. Sequence labels and verified facts unchanged.

### Changed / added files (v0.5.1)

| File | Change |
|---|---|
| `PROJECT_STATUS.md` | Version 0.5.1 brand integration checkpoint |
| `assets/brand/routeguard/routeguard-*.svg` (production family) | Exact copy from Stitch production package |
| `assets/brand/routeguard/ROUTEGUARD_BRAND_ASSET_MANIFEST.md` | Manifest |
| `assets/brand/routeguard/routeguard-logo-specification.md` | Logo specification |
| `assets/brand/routeguard/ROUTEGUARD_BRAND_INTEGRATION_HANDOFF.md` | Integration handoff |
| `public/brand/routeguard/*.svg` | Served production SVGs (byte-identical copies) |
| `src/server/page.ts` | Brand placements per handoff |
| `src/server/app.ts` | Static `/brand/*` serving |
| `scripts/render-final-demo-report.ts` | Live-proof brand placements |
| `evidence/final-demo-report.html` | Regenerated presentation only |
| `evidence/final-demo-dry-run-report.html` | Regenerated presentation only |

### Validation (v0.5.1)

- all referenced SVG files exist: **PASS**
- no embedded raster / external SVG resources: **PASS**
- source ↔ `assets` ↔ `public` SHA-256 match for 13 production SVGs: **PASS**
- responsive substitutions present in CSS: **PASS**
- accessibility alt / aria-hidden rules: **PASS**
- aspect ratios via width + height:auto (no forced square distortion): **PASS**
- Hedera assets under `public/brand/hedera/` unchanged: **PASS**
- live evidence JSON/MD/reservation record byte-identical: **PASS**
- `npm run typecheck`: **PASS**
- `npm test`: **PASS** — 44 files / 557 tests; 0 failed
- `npm run report:final-demo`: **PASS** (presentation regeneration only)
- `npm run check:secrets`: **PASS** — 205 files scanned
- `git diff --check` (integration paths): **PASS**
- no `lint` script in package.json (not currently supported)
- no separate `build` script; typecheck is the compile gate
- `npm run verify` / live demo: **NOT RUN** (prohibited)

### Current state

Production brand family is integrated into the development shell and judge-facing
reports per the Stitch handoff. Authoritative live evidence remains unchanged.
Ready for owner review of visual placement; still no live re-run.

### Next steps

1. Owner visual review of development shell + reports with brand assets.
2. Record submission video when authorized (no live payment).
3. Push / PR only when owner authorizes publish.

**Network writes in this checkpoint: 0.** No Hedera transaction, HCS submission,
payment, push, deployment, or other network write occurred.

---

## RouteGuard vector brand assets (v0.5.0)

The approved raster reference has been reconstructed as a controlled,
production-grade SVG family. The reference remains the visual authority.
Geometry was measured programmatically, constructed with intentional SVG
primitives, and compared through rendered overlay and side-by-side previews.
Typography uses the closest locally available open-source face, Poppins;
production typography is outlined and fitted to the measured glyph boxes, with
no runtime font dependency and no bitmap tracing.

### Changed / added files (v0.5.0)

| File | Change |
|---|---|
| `PROJECT_STATUS.md` | Version 0.5.0 brand-asset checkpoint |
| `assets/brand/routeguard/reference/routeguard-logo-reference.png` | Approved visual reference supplied for reconstruction |
| `assets/brand/routeguard/build-brand-assets.ps1` | Deterministic local SVG builder using intentional primitives and Poppins glyph outlines |
| `assets/brand/routeguard/routeguard-logo-measurements.md` | Pixel measurements and visible-bounds-normalized percentages |
| `assets/brand/routeguard/ROUTEGUARD_LOGO_SPEC.md` | Naming hierarchy, construction, palette, usage, accessibility, and prohibitions |
| `assets/brand/routeguard/routeguard-freight-exchange-master.svg` | Production outlined full lockup; transparent and font-independent |
| `assets/brand/routeguard/routeguard-freight-exchange-editable.svg` | Editable semantic Poppins text master with recorded font parameters |
| `assets/brand/routeguard/routeguard-symbol.svg` | Deliberately optimized 256 × 256 small-size symbol |
| `assets/brand/routeguard/routeguard-horizontal-compact.svg` | Symbol + RouteGuard compact lockup; no descriptor |
| `assets/brand/routeguard/routeguard-monochrome.svg` | One-color charcoal formal lockup |
| `assets/brand/routeguard/routeguard-reverse.svg` | White + verified-green lockup for charcoal surfaces |
| `assets/brand/routeguard/previews/master-light.png` | 1305 × 329 light-background master preview |
| `assets/brand/routeguard/previews/master-dark.png` | 1305 × 329 dark-background reverse preview |
| `assets/brand/routeguard/previews/compact-header.png` | 1024 × 258 compact-lockup preview |
| `assets/brand/routeguard/previews/symbol-16.png` | 16 × 16 symbol legibility preview |
| `assets/brand/routeguard/previews/symbol-24.png` | 24 × 24 symbol legibility preview |
| `assets/brand/routeguard/previews/symbol-32.png` | 32 × 32 symbol legibility preview |
| `assets/brand/routeguard/previews/symbol-48.png` | 48 × 48 symbol legibility preview |
| `assets/brand/routeguard/previews/symbol-192.png` | 192 × 192 application-icon preview |
| `assets/brand/routeguard/previews/reference-overlay.png` | Measured reference/master alignment overlay |
| `assets/brand/routeguard/previews/reference-side-by-side.png` | Reference and SVG render at matched visible bounds |

### Validation (v0.5.0)

- deterministic asset generation: **PASS**
- static SVG policy validation: **PASS** — 6 SVGs; expected 18 requested deliverables present
- SVG XML parse: **PASS** — all 6 files
- viewBoxes, semantic groups, title/description, and descriptor spelling: **PASS**
- embedded raster / external resources / filters / masks / gradients: **NONE**
- production master font dependency: **NONE**
- transparent SVG backgrounds: **PASS**
- small-size symbol previews: **PASS** — 16, 24, 32, 48, and 192 px
- `npm run typecheck`: **PASS**
- `npm test`: **PASS** — 44 files / 557 tests; 0 failed
- `npm run check:secrets`: **PASS** — 183 files scanned
- `git diff --check`: **PASS**
- `npm run verify`: deliberately **NOT RUN** because it invokes the prohibited auction demo

### Current state

The formal outlined master, editable text master, compact lockup, optimized
symbol, monochrome variant, reverse variant, previews, objective comparison,
measurements, and usage specification are complete. Application code and
live-demo evidence are unchanged.

### Next steps

1. Use `routeguard-freight-exchange-master.svg` as the formal production source
   of truth.
2. Select the compact or symbol asset for future application integration in a
   separately authorized application-code change.
3. Re-run the local asset builder only when Poppins is available at the recorded
   local font paths; committed production SVGs do not require those fonts.

**Network writes in this checkpoint: 0.** No Hedera transaction, HCS submission,
payment, push, deployment, or other network write occurred.

---

## Submission-readiness corrections (v0.4.4)

Narrow documentation, evidence packaging, report-generator, and test fixes from the
read-only Opus audit. **Zero live Hedera network writes.** Authoritative live
evidence JSON/MD (payment, topic, sequences 1–5) is **unchanged**. **No further
live execution is permitted.**

### What changed

| Item | Detail |
|---|---|
| LICENSE | Root `LICENSE` — standard ISC text; Copyright 2026 `yourrealcrypto-crypto` (repo owner from git/package repository URL) |
| HTTP 402 proof visible | README + generated live report surface canonical `@x402/hono` 402 → signed retry → 200 proof from `evidence/usdc-smoke-payment.json` (tx `0.0.7162784@1784141033.517654222`) |
| Surfaces distinguished | **A** protocol HTTP 402 handshake vs **B** freight-reservation orchestration (reuses x402 exact + facilitator; does **not** claim reservation endpoint returned HTTP 402) |
| Fail-closed framing | Section renamed to **Fail-closed guarantees — verified by automated tests** with test file refs; live fact: exactly one facilitator settle call (not live wrong-recipient/duplicate experiments) |
| Computed report invariants | Report derives PASS/FAIL for barrier≥endsAt, HCS messages under 1024 B, Mirror sequences 1–5; bid sequence numbers from evidence labels; live generation fails closed if invariants false |
| Live reservation record tracked | Verbatim copy: `evidence/final-demo-live-reservation-record.json` ← `data/final-demo-live-reservations/reservation-final-8b73c264.json` |
| Sequence 5 payment binding | README + report: seq 5 embeds payment tx id + payment consensus timestamp; verifiable from topic `0.0.9794225` |
| Recovery wording | One restrained README sentence; compact report footnote for seq4→payment time gap (no stack trace) |
| Network write counts | Labeled **Writes performed by the resumed process** (`topicCreates: 0`, `hcsSubmits: 1`, `payments: 1`) — not whole-run totals |
| Video script | `docs/demo-script.md` replaced with evidence-based five-minute script; **private, commitment-based auction**; no live payment on camera |

### Changed / added files (v0.4.4)

| File | Change |
|---|---|
| `LICENSE` | **New** — ISC, Copyright 2026 yourrealcrypto-crypto |
| `README.md` | HTTP 402 proof; surface A/B; fail-closed tests table; seq 5 binding; recovery sentence; license; reservation record ref |
| `PROJECT_STATUS.md` | This version |
| `docs/demo-script.md` | Evidence-based five-minute video script (no live re-run) |
| `scripts/render-final-demo-report.ts` | Computed invariants; HTTP 402 section; fail-closed rename; recovery footnote; resumed-process write label; evidence-derived bid sequences |
| `test/final-demo-report.test.ts` | Regression tests for invariants, fail-closed live gates, HTTP 402 section, framing |
| `evidence/final-demo-live-reservation-record.json` | **New** — verbatim tracked copy of live reservation record |
| `evidence/final-demo-report.html` | Regenerated (presentation only) |
| `evidence/final-demo-dry-run-report.html` | Regenerated (presentation only) |

### Authoritative live evidence (unchanged)

| Artifact | Status |
|---|---|
| `evidence/final-demo-result.json` | Unchanged authoritative live result |
| `evidence/final-demo-result.md` | Unchanged |
| `evidence/final-demo-live-attempt.json` | Unchanged |
| `data/final-demo-live-reservations/reservation-final-8b73c264.json` | Unchanged source record |
| Topic / payment / sequences 1–5 | Unchanged live facts |

### Validation (v0.4.4)

- `npm run report:final-demo`: expected PASS (read-only render)
- `npm run typecheck`: expected PASS
- `npx vitest run`: expected PASS
- `npm run check:secrets`: expected PASS (includes new reservation record)
- `git diff --check`: expected PASS (CRLF warnings only)

**No further live execution should be performed.** This checkpoint performs
**0** topic creates, **0** HCS submissions, and **0** payments.

### Current state

Live final demonstration is **complete and evidenced**. Submission-readiness
docs/report/test polish applied. Ready to **record video**, then push / merge /
submit when the owner authorizes — **without** re-running the live demo.

### Remaining next steps (no network writes)

1. Record submission video from completed evidence + `docs/demo-script.md` (no live payment).
2. Push branch / open PR when owner authorizes publish.
3. Merge and complete bounty submission package.

### Explicit prohibitions

- **Do not** run `npm run demo:final-auction` under live flags again.
- **Do not** create another topic or re-submit HCS / payment.
- **Do not** delete recovery or live-attempt evidence.
- **Do not** push until owner-authorized.

---

## Live final demo completed + report presentation (v0.4.3)

Successful recovery resume and live final execution on Hedera testnet, plus a
narrow judge-facing report presentation cleanup. **Zero further live network
writes in this documentation checkpoint.**

### Successful recovery and final execution

| Field | Value |
|---|---|
| Mode | `LIVE_FINAL_DEMO` |
| `realNetwork` | `true` |
| runId / reservation | `final-8b73c264` / `reservation-final-8b73c264` |
| Topic ID | **`0.0.9794225`** |
| Topic create | exactly **once** (`0.0.9197513@1785171882.373802899`) |
| Topic admin key | **none** (immutable config: no admin key, no submit key) |
| Topic submit key | **none** |
| Winner | `carrier-alpha` / `0.0.9215954` |
| Carrier beta | `0.0.9793912` (sequence 3 submitter) |
| HCS sequences | **1–5 complete** (all `SUCCESS` / `CONFIRMED`) |
| Submitter order | operator → alpha → beta → operator → operator |
| Payment status | Mirror **`SUCCESS`** |
| Payment transaction | **`0.0.7162784@1785173890.867086556`** |
| Payer | `0.0.9197513` |
| Receiver | `0.0.9215954` |
| Asset / amount | `0.0.429274` / **10000** atomic USDC (0.01 USDC) |
| Payment consensus | `2026-07-27T17:38:16.977444275Z` |
| ROUTE_RESERVED consensus | `2026-07-27T17:38:23.453477104Z` |
| Settlement before reservation | **YES** (payment precedes sequence 5) |
| Facilitator settle count | **exactly 1** (`settleCallCount: 1`) |
| Duplicate payment | **none** (single confirmed payment claim + single settle) |

Recovery path: v0.4.2 cleared a pre-submission `PAYMENT_SUBMISSION_CLAIMED`
claim with null transaction id; resume reused topic `0.0.9794225` and
confirmed sequences 1–4; then constructed/settled one USDC payment and
published sequence 5 `ROUTE_RESERVED` only after Mirror SUCCESS.

### Report presentation cleanup (same checkpoint)

Removed the overly defensive **Honest limitations / What we do NOT claim**
section from the generated Winning Demo HTML (source:
`scripts/render-final-demo-report.ts`). Also removed the repeated standalone
differentiator sentence that sat under that section.

**Retained disclosures:**

| Location | Content |
|---|---|
| Report footer (live) | Concise: synthetic demo data; real testnet HCS + USDC settlement |
| Report footer | Independent-project / Hedera non-affiliation disclaimer (unchanged) |
| Report body | Labeled differentiator sentence (once) |
| README collapsed **Technical scope** | Off-chain bid evaluation + eventual-consistency recovery caveats |
| Evidence JSON / MD | Full synthetic + real-testnet disclosure strings |

Authoritative live evidence JSON was **not** rewritten for presentation; only
the HTML generator and regenerated reports changed for that cleanup.

### Changed / generated files

| File | Change |
|---|---|
| `evidence/final-demo-result.json` | **New** — authoritative live result |
| `evidence/final-demo-result.md` | **New** — authoritative live markdown |
| `evidence/final-demo-report.html` | **New** — live Winning Demo report (regenerated) |
| `evidence/final-demo-live-attempt.json` | Completed live attempt (seq 5 + payment confirmed) |
| `evidence/final-demo-live-authoritative-materials.json` | Preserved live materials |
| `data/final-demo-live-reservations/reservation-final-8b73c264.json` | Completed reservation + Mirror SUCCESS |
| `evidence/final-demo-dry-run*.json/md/html` | Deterministic dry regeneration (tracked artifacts) |
| `scripts/render-final-demo-report.ts` | Remove limitations section; concise live footer disclosure |
| `test/final-demo-report.test.ts` | Assert limitations section absent; footer disclosure present |
| `test/final-demo-payment-claim-recovery.test.ts` | Use frozen pre-submission fixtures (not completed live attempt) |
| `test/fixtures/final-demo-live-attempt-pre-submission-8b73c264.json` | **New** — frozen stuck attempt for recovery tests |
| `test/fixtures/final-demo-live-reservation-pre-submission-8b73c264.json` | **New** — frozen pre-payment reservation for recovery tests |
| `README.md` | Live-proof section + collapsed Technical scope |
| `PROJECT_STATUS.md` | This version |

### Validation (v0.4.3)

- `npm run report:final-demo`: **PASS** (read-only render from existing evidence)
- `npm run typecheck`: **PASS**
- `npx vitest run`: **PASS** — 44 files / **552** tests; 0 failed
- `npm run check:secrets`: **PASS** — 189 files scanned
- `git diff --check`: **PASS** (CRLF warnings only)

**No further live execution should be performed.** This checkpoint performs
**0** topic creates, **0** HCS submissions, and **0** payments.

### Current state

Live final demonstration is **complete and evidenced**. Local branch holds
recovery fix + live evidence + presentation polish. Ready for final audit,
video capture, push, and bounty submission — **without** re-running the live
demo.

### Remaining next steps (no network writes)

1. Final audit of live evidence and `evidence/final-demo-report.html` at 1920×1080.
2. Record submission video from the live report + HashScan links.
3. Push branch / open PR when owner authorizes publish.
4. Bounty submission package (repo URL, HashScan, report, disclosures).

### Explicit prohibitions

- **Do not** run `npm run demo:final-auction` under live flags again.
- **Do not** create another topic or re-submit HCS / payment.
- **Do not** delete recovery or live-attempt evidence.
- **Do not** push until owner-authorized.

---

## Live payment pre-submission recovery (v0.4.2)

Critical live-state recovery. **Zero live network writes in this checkpoint.**

### Existing live attempt (do not discard)

| Field | Value |
|---|---|
| runId | `final-8b73c264` |
| reservationId | `reservation-final-8b73c264` |
| topicId | **`0.0.9794225`** |
| topic-create tx | `0.0.9197513@1785171882.373802899` |
| attempt status | `PAYMENT_SUBMISSION_CLAIMED` |
| reservation state | `PAYMENT_CHALLENGE_ISSUED` |

### Confirmed HCS sequences 1–4 (SUCCESS — reuse only)

| Seq | Label | Transaction ID |
|---|---|---|
| 1 | AUCTION_OPEN | `0.0.9197513@1785171886.464403601` |
| 2 | BID_COMMITMENT_ALPHA | `0.0.9215954@1785171891.401438362` |
| 3 | BID_COMMITMENT_BETA | `0.0.9793912@1785171896.489501448` |
| 4 | AUCTION_CLOSE_BARRIER | `0.0.9197513@1785172306.496939544` |
| 5 | ROUTE_RESERVED | **PENDING** — not submitted |

### Exact failure

```
Unsupported value at $.extensions: undefined object property.
```

Root cause: `@x402/core` v2 `createPaymentPayload` always assigns
`extensions: mergeExtensions(...)`. When no extensions are declared,
`mergeExtensions` returns `undefined`, so the payload object carries a real
property `extensions: undefined`. RouteGuard then hashes with strict
`canonicalSha256` / `canonicalize`, which correctly **rejects** undefined
object properties fail-closed.

The outer payment claim was written **before** construction completed, so the
durable attempt stayed `PAYMENT_SUBMISSION_CLAIMED` while construction died on
hash.

### Proof that no payment transaction existed

| Field | Live value |
|---|---|
| `paymentSubmissionClaim.transactionId` | `null` |
| `paymentPayloadHash` | `null` |
| `clientTransaction` | `null` |
| `settleClaim` | `null` |
| `facilitatorSettle` | `null` |
| `transactionId` | `null` |
| `mirrorConfirmation` | `null` |
| Reconcile CLI | `NOT_RECONCILABLE` — pre-submission; nothing signed for submission |

**PAYMENT_WAS_PREVIOUSLY_SUBMITTED = NO**  
**PAYMENT_WAS_PREVIOUSLY_SETTLED = NO**  
**SAFE_TO_RESUME_EXISTING_ATTEMPT = YES**

### Repair (narrow)

1. **`paymentPayloadForCanonicalHash`** (`src/domain/payment-payload-canonical.ts`)  
   Shallow-omits optional top-level keys whose value is strictly `undefined`
   (notably `extensions`) **before** strict canonical hashing.  
   - Does **not** weaken `canonicalize`.  
   - Does **not** convert `undefined` → `null`.  
   - Nested undefined still fails closed.  
   - Non-empty `extensions` pass through and still bind hashes.

2. Wired into live payer factory, phase6b hash recompute, and dry payload factory.

3. **Pre-submission claim recovery** (`src/final-demo/payment-claim-recovery.ts`)  
   When claim is `CLAIMED` with **no** tx id / payload hash / clientTransaction /
   settle / facilitator / reservation tx, a validated transition clears the
   claim to `NONE` and sets attempt status `PAYMENT_READY` so a single fresh
   construction may proceed. Any identity or mid-payment state fails closed.

4. Orchestration resume reuses the existing topic and confirmed sequences 1–4;
   sequence 5 remains gated on Mirror SUCCESS after settlement.

### Changed files

| File | Change |
|---|---|
| `src/domain/payment-payload-canonical.ts` | **New** — omit optional undefined before hash |
| `src/final-demo/payment-claim-recovery.ts` | **New** — safe pre-submission claim clear |
| `src/final-demo/orchestration.ts` | Resume path clears proven pre-submission claim |
| `src/reservation/live/payer-payload.ts` | Hash via `paymentPayloadForCanonicalHash` |
| `src/reservation/live/live-execution.ts` | Recompute hash via same helper |
| `src/final-demo/dry-transports.ts` | Dry hash via same helper |
| `test/payment-payload-canonical.test.ts` | **New** — serialization regression (7) |
| `test/final-demo-payment-claim-recovery.test.ts` | **New** — recovery + orchestrated resume (7) |
| `evidence/final-demo-live-attempt.json` | Preserved real live attempt (not rewritten by this fix) |
| `evidence/final-demo-live-authoritative-materials.json` | Preserved real materials |
| `PROJECT_STATUS.md` | This section |

### Deliberately not changed

- Auction rules, x402 terms, amount, payer, receiver, token, network
- Canonical serialization strictness
- Recovery architecture for settled / mid-payment / ambiguous cases
- No second topic; no re-submit of sequences 1–4; no blind claim clear

### Owner resume command (after this patch)

Prefer the existing orchestrator recovery path (no new CLI, no manual JSON edit):

```bash
npm run demo:final-auction
```

with the **same live env flags** already used for the stuck attempt
(`ENABLE_FINAL_DEMO_LIVE=true`, `ENABLE_LIVE_HEDERA=true`,
`ENABLE_LIVE_USDC_PAYMENTS=true`, `ENABLE_LIVE_HCS_WRITES=true`,
`ENABLE_LIVE_TOPIC_CREATE=true`, `ENABLE_PHASE6B_LIVE_EXECUTE=true`,
`CONFIRM_FINAL_DEMO=CREATE_NEW_TOPIC_AND_EXECUTE_ONE_USDC_RESERVATION`).

Despite the confirm string naming, resume loads the durable attempt and
**must not** create a new topic when `topicId` is already set.

### Explicit prohibitions

- **Do not** create another topic.
- **Do not** blind-rerun after deleting attempt/reservation files.
- **Do not** clear `paymentSubmissionClaim` by hand.
- **Do not** re-submit HCS sequences 1–4.
- **Do not** publish sequence 5 before Mirror SUCCESS on the payment.

### Validation (v0.4.2)

- `npm run typecheck`: **PASS**
- `npx vitest run`: **PASS** — 44 files / **551** tests; 0 failed
- `npm run check:secrets`: **PASS** — 184 files scanned
- `git diff --check`: **PASS** (CRLF warnings only)

Live Hedera network writes in this checkpoint: **0 topic creates, 0 HCS
submissions, 0 payments**.

### Current state

Code and offline recovery path are ready. Live attempt
`final-8b73c264` / topic `0.0.9794225` with sequences 1–4 SUCCESS remains
pre-submission and is safe to resume via the owner command above.
Sequence 5 and payment still outstanding until that authorized resume.

---

## Carrier-beta identity migration (v0.4.1)

Narrow, security-relevant testnet identity migration. No architecture change, no
report redesign, no payment or recovery change, and zero live network writes.

### Reason

The final demo requires three **distinct** HCS identities, and carrier beta must
sign HCS sequence 3 (`BID_COMMITMENT_BETA`) itself. The previously configured
beta account **`0.0.9100002` was not owner-accessible** — no controlled ECDSA
key, so it could neither be funded to the 1 HBAR readiness floor nor sign its
own commitment. A new owner-controlled testnet account was created outside this
repository and now replaces it.

### Active topology (unchanged except beta)

| Role | Account | Notes |
|---|---|---|
| Operator / shipper / payer | `0.0.9197513` | HCS sequences 1, 4, 5 |
| Carrier alpha (winner) | `0.0.9215954` | HCS sequence 2; payment receiver |
| **Carrier beta** | **`0.0.9793912`** | HCS sequence 3; own ECDSA key; ≥ 1 HBAR |

HCS submit authority for sequences 1–5 remains
`ROUTEGUARD_OPERATOR, CARRIER_ALPHA, CARRIER_BETA, ROUTEGUARD_OPERATOR, ROUTEGUARD_OPERATOR`.
All three account identities and all three public keys must remain distinct;
`checkFinalDemoHcsIdentityReadiness` still fails closed before any Mirror lookup
when they are not.

### Changed files

| File | Change |
|---|---|
| `src/final-demo/constants.ts` | `FINAL_DEMO_CARRIER_BETA_ACCOUNT` → `0.0.9793912`, with migration rationale |
| `demo/fixtures/final-auction-template.json` | `carriers.beta.carrierAccountId` and `accounts.carrierBetaDemoAccountId` → `0.0.9793912` |
| `scripts/render-final-demo-report.ts` | Carrier-beta actor card no longer hard-codes an account; renders `FINAL_DEMO_CARRIER_BETA_ACCOUNT` |
| `test/fixtures/auction-fixtures.ts` | Synthetic `carrier-beta` fixture account aligned to `0.0.9793912` |
| `test/final-demo-beta-identity.test.ts` | **New** — migration regression suite (see below) |
| `evidence/final-demo-dry-run.json` | Regenerated (`npm run demo:final-auction`) |
| `evidence/final-demo-dry-run.md` | Regenerated |
| `evidence/final-demo-dry-run-attempt.json` | Regenerated |
| `evidence/final-demo-dry-run-authoritative-materials.json` | Regenerated with the new beta identity |
| `evidence/final-demo-dry-run-report.html` | Regenerated (`npm run report:final-demo`) |
| `evidence/final-demo-authoritative-materials.json` | **Deleted** — orphaned legacy-path artifact, unreferenced by any code path and superseded by the dry-run materials file; it still carried the retired beta id and could not be regenerated |
| `PROJECT_STATUS.md` | This section |

### Deliberately not changed

- `.env` and `.env.backup-before-final-demo` — untracked local environment files;
  not read and not modified. **Owner action required:** set
  `FINAL_DEMO_CARRIER_BETA_ACCOUNT_ID=0.0.9793912` and its matching ECDSA key in
  `.env` before any live run.
- `src/reservation/live/phase5-public-materials.json` — sealed Phase 5
  exploratory materials whose ECDSA signatures cover the historical carrier
  account. It is explicitly **not** final-demo authority (historical topic
  `0.0.9587459`), and rewriting the account id there would invalidate genuine
  signatures. Retained as history and allow-listed in the regression scan.
- `.env.example` — carries placeholders only; no account id to migrate.

### Regression tests (`test/final-demo-beta-identity.test.ts`, 9 tests)

- `0.0.9793912` is the required beta account (constant + template, both fields).
- The retired `0.0.9100002` is rejected before any Mirror lookup.
- Beta collapsed onto operator or alpha is rejected as non-distinct.
- Beta must hold its own ECDSA key and ≥ 1 HBAR (`100000000` tinybars floor).
- HCS sequence 3 (`BID_COMMITMENT_BETA`) still requires `CARRIER_BETA`.
- Sequence 1–5 authority order is pinned to operator, alpha, beta, operator, operator.
- Repository scan over `src/`, `scripts/`, `test/`, `demo/`, `evidence/`, `docs/`,
  `public/`, `README.md`, `.env.example`: the retired id appears in **no** active
  surface (only the allow-listed sealed Phase 5 materials).

### Validation (v0.4.1)

- `npm run typecheck`: **PASS**
- `npx vitest run`: **PASS** — 42 files / **537** tests; 0 failed
- `npm run check:secrets`: **PASS** — 178 files scanned
- `npm run demo:final-auction`: **PASS** (OFFLINE_DRY_RUN; zero real network writes)
- `npm run report:final-demo`: **PASS** (dry HTML regenerated; live deferred)
- `npm run verify`: **PASS**
- `git diff --check`: **PASS** (CRLF warnings only)

Live Hedera network writes in this checkpoint: **0 topic creates, 0 HCS
submissions, 0 payments, 0 accounts created**.

### Current state

Offline/dry path is fully consistent with the new beta identity and green across
typecheck, tests, secret scan, dry demo, report and verify. Owner-live readiness
is unchanged in substance but is now **blocked on local `.env` configuration**
of the new beta account id and key — the repository can no longer be run live
against the unavailable account by accident, because readiness fails closed on
any beta account other than `0.0.9793912`.

### Exact next steps

1. In local `.env` (never committed): set `FINAL_DEMO_CARRIER_BETA_ACCOUNT_ID=0.0.9793912`
   and `FINAL_DEMO_CARRIER_BETA_PRIVATE_KEY` to the new account's ECDSA key.
2. Fund `0.0.9793912` with ≥ 1 HBAR on Hedera testnet.
3. Run `npm run check:accounts` (read-only) and confirm the three-identity
   readiness preflight passes for operator, alpha and beta.
4. Re-run `npm run verify` to confirm the offline gate is still green.
5. Manually review `evidence/final-demo-dry-run-report.html` at 1920×1080 / 100% zoom.
6. With explicit owner authorization, run the live final demo once, then
   `npm run report:final-demo` to emit `evidence/final-demo-report.html`.
7. Verify HashScan links only on the live report; retain attempt/evidence files.

---

## Submission-presentation checkpoint (v0.4.0)

This version completes the owner-live **submission / presentation** work on top of the
reviewed technical-readiness checkpoint. No live network actions were performed.
Architecture was not reopened. Payment/auction/reservation/HCS trust-critical
behavior was changed only for the two reviewed medium corrections.

### Phase 1 — reviewed medium corrections

| Item | Result | Notes |
|---|---|---|
| F-001 transaction ID normalization | **PASS** | `assessTimedOutConfirmationRecovery` uses `transactionIdsEqual` for facilitator settle and mirror-poll IDs. Tests cover SDK vs Mirror form of the same exact transaction (accept) and a different ID (reject). |
| F-008 reporting strict `< 1024` | **PASS** | Final-demo and phase6b `envelopeWithinLimit` predicates and tests use `< 1024` / `toBeLessThan(1024)`. Enforcement already rejected equality. |

### Phase 2 — evidence and compliance

| Item | Result | Notes |
|---|---|---|
| F-007 dry evidence | **PASS** | Dry-specific disclosure states zero network writes and that identifiers are simulated/not real testnet transactions. Dry JSON/MD omit active HashScan URLs (`hashScan*` = null). Simulated IDs labeled in markdown. |
| F-011 compliance | **PASS** | Exact differentiator sentence added; matrix classifies Official requirement / Official judging criterion / Product alignment / RouteGuard differentiator; no inferred scoring weights. |
| F-012 verify | **PASS** | `npm run verify` runs typecheck, full tests, secret scan, dry final-demo, and practical evidence/git cleanliness checks without new dependencies. |

### Phase 3 — official Hedera branding

| Item | Result | Notes |
|---|---|---|
| Official assets | **PASS** | Retrieved only from https://brand.hedera.com/ asset CDN on 2026-07-20. Logo library ZIP on hedera.com returned HTTP 404; no third-party logo sites; no Styrene fonts. |
| Asset manifest | **PASS** | External archive `F:\x402\brand-assets\hedera-official\` + `public/brand/hedera/ASSET_SOURCES.md` record source, filename, date, SHA-256, usage, trademark constraints. |
| Trademark compliance | **PASS** | RouteGuard remains primary brand; Hedera marks subordinate; required non-affiliation disclaimer present in constants, README, report footer, and ASSET_SOURCES. Marks unmodified. |

### Phase 4 — Winning Demo report

| Item | Result | Notes |
|---|---|---|
| Generator | **PASS** | `scripts/render-final-demo-report.ts` + `npm run report:final-demo` |
| Dry report | **YES** | `evidence/final-demo-dry-run-report.html` generated |
| Live generator ready | **YES** | Fail-closed on dry evidence, placeholders, missing payment/topic/sequences 1–5/settlement confirmation/reservation proof. Live HTML written only when complete `evidence/final-demo-result.json` exists. |
| Blueprint coverage | **PASS** | Mode banner, RouteGuard hero, one-sentence business line, actors, 7-step timeline, HCS vs payment visual split, economics without cross-unit arithmetic, sequences 1–5, Decision Manifest, fail-closed demos, disclosures, limitations, disclaimer, repo link, semantic HTML. |

### Validation (v0.4.0)

- `npm run typecheck`: **PASS**
- `npx vitest run`: **PASS** — 41 files / **528** tests; 0 failed
- `npm run check:secrets`: **PASS** — 178 files scanned
- `npm run demo:final-auction`: **PASS** (OFFLINE_DRY_RUN; zero real network writes)
- `npm run report:final-demo`: **PASS** (dry HTML written; live deferred)
- `npm run verify`: **PASS**
- `git diff --check`: **PASS** (CRLF warnings only)

No live Hedera network action: **0 topic creates, 0 HCS submissions, 0 payments**.
No `.env` or private keys were read for implementation content. Nothing was pushed.

### Current readiness verdict

**OWNER_LIVE_TECHNICALLY_READY = YES** (unchanged from v0.3.1 review)

**READY_FOR_MANUAL_VISUAL_QA = YES** — open `evidence/final-demo-dry-run-report.html` at 1920×1080 / 100% zoom before recording. Live report requires a future owner-authorized live run.

### Exact next steps

1. Manually review the dry HTML report at 1920×1080 for spacing, hierarchy, and HCS/payment distinction.
2. Configure external env identities/keys/funding (never commit secrets).
3. With explicit owner authorization, run live final demo once; then `npm run report:final-demo` to emit `evidence/final-demo-report.html`.
4. Verify HashScan links only on the live report; retain attempt/evidence files.
5. Optional polish: N-004 and any remaining non-blocking submission docs.

---

## Prior independent technical review (v0.3.1)

Reviewed range `f7137e4..6328553`; 0 blockers / 0 highs; two pre-live mediums
(now corrected in v0.4.0 Phase 1). Full narrative retained in git history of
this file at commit `a3da71b`.
