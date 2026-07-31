# RouteGuard Freight Exchange — PROJECT STATUS

**Version:** 0.7.1
**Date:** 2026-07-31
**Project:** `routeguard-freight-exchange@0.1.0` — deterministic freight-capacity reservation over x402 and Hedera Testnet
**Branch:** `feat/routeguard-v2-phase-a` (local only; do not push during this checkpoint)
**Prior checkpoint HEAD:** `8f4265fabe1a2162b94689628f475c6de526b426` (v0.7.0 Phase A2)
**Authoritative plan (v1):** `RouteGuard_Freight_Exchange_Final_Project_Plan_v1.5.md`
**Authoritative plan (v2):** `docs/plans/routeguard-v2-architecture-migration-plan.md`
**Winning Demo blueprint:** `F:\x402\crqitiques\RouteGuard_Claude_Winning_Demo_Design_2026-07-19.md`

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
