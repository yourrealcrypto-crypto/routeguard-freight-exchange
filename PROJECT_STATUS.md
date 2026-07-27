# RouteGuard Freight Exchange — PROJECT STATUS

**Version:** 0.4.1
**Date:** 2026-07-27
**Project:** `routeguard-freight-exchange@0.1.0` — deterministic freight-capacity reservation over x402 and Hedera Testnet
**Branch:** `fix/live-readiness-winning-demo` (local only; do not push during this checkpoint)
**Prior checkpoint HEAD:** `54db2b1d92f44a63c9dac4569f27f9513a89ce46` (v0.4.0)
**Authoritative plan:** `RouteGuard_Freight_Exchange_Final_Project_Plan_v1.5.md`
**Winning Demo blueprint:** `F:\x402\crqitiques\RouteGuard_Claude_Winning_Demo_Design_2026-07-19.md`

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
