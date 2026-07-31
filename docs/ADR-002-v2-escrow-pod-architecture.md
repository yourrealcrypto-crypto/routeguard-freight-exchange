# ADR-002: RouteGuard v2 Escrow, Access Payments, and POD Architecture

- **Status:** Accepted
- **Date:** 2026-07-31
- **Supersedes in part:** ADR-001 exclusion of *all* escrow (Scheduled Transaction
  escrow remains excluded; HTS smart-contract freight escrow is authorized here)
- **Does not supersede:** ADR-001 x402 v2 / exact / hedera:testnet / deterministic
  TypeScript core / no LLM in the trust-critical release path

## Context

RouteGuard v1 proves capacity-reservation settlement through x402 and HCS on
Hedera testnet. Its live final-demo evidence is complete and immutable.

RouteGuard v2 evolves the product to:

1. Pre-fund a maximum freight budget in HTS USDC escrow.
2. Gate tender activation and durable carrier offers with small x402 access
   payments.
3. Allocate the winning freight amount on-chain and release only after POD
   acceptance, deemed acceptance, or human referee resolution.

## Decision

### v1 / v2 separation

- v1 live evidence under `evidence/final-demo-*` remains immutable.
- Do not re-run the v1 live final-auction for v2 work.
- v2 modules live under `src/v2/` (and related docs/tests).
- Future v2 evidence belongs only under `evidence/v2/`.
- v1 reservation dual-asset demo fee remains a historical / challenge-compliance
  surface; it is not the v2 freight-principal story.

### Two x402 access gates

Protected exact-scheme USDC actions:

1. Tender activation (`TENDER_ACTIVATE`)
2. Durable carrier-offer submission (`BID_SUBMIT`)

Product access price: **0.001 USDC** per protected action (RouteGuard product
price, not a Hedera-mandated universal price and not the challenge-stated
network transfer cost).

Token: Hedera testnet USDC `0.0.429274`, decimals **6**, derived atomic amount
**1000**. Access `payTo` is configuration
`ROUTEGUARD_ACCESS_TREASURY_ACCOUNT_ID` (not required as a concrete value in
Phase A1).

### Freight-principal escrow (HTS USDC smart contract)

- Shipper pre-funds `maximumFreightBudgetAtomic` (authoritative integer-string
  atomic USDC units).
- After winner selection, the winning amount is locked and excess refunded.
- Release, refund, or partial release occurs only after POD acceptance, deemed
  acceptance, or signed human referee resolution.
- Freight principal is **never** an x402 access payment.

### HCS 2.0 evidence layer

- Schema identifier: `routeguard-hcs-2.0`.
- Public-safe identifiers, hashes, enums, amounts, and timestamps only.
- Full POD documents stay encrypted off-chain.

### Encrypted off-chain POD

- Ciphertext storage reference + AES-256-GCM metadata + content/ciphertext
  hashes.
- No POD plaintext or personal-data fields on HCS or in public schemas.

### Shipper review and deemed acceptance

- Default review window: 48 hours (172800 s).
- Default correction window: 24 hours (86400 s).
- Post-resubmit review window: 24 hours (86400 s).
- Missing correction by the correction deadline opens `POD_DISPUTED`.
- Shipper silence after the signed review deadline creates `POD_DEEMED_ACCEPTED`.

### Advisory-only AI

- AI POD Assurance Adviser is non-binding.
- AI cannot accept/reject POD, trigger deemed acceptance, release or refund
  funds, or resolve disputes.

### Human referee

- Phase A1 model: single short-lived allowlisted referee key.
- Resolutions are human-signed (`RELEASE_FULL`, `REFUND_FULL`, `PARTIAL`).
- Future multisig and on-chain signature verification are documented goals,
  not Phase A1 implementation.

### Separate v2 evidence namespace

- `evidence/v2/` only for future v2 artifacts.
- Never overwrite `evidence/final-demo-result.json` or other v1 live proof.

## Explicit non-goals (Phase A1 and architectural)

- Scheduled Transaction escrow
- Freight principal settlement through x402
- AI or LLM authorization of fund movement
- Mainnet deployment (testnet-first until a later ADR)
- EVM auction contracts
- Manual wallet checkout as the primary software-to-software path
- Rewriting or re-running v1 live final-demo evidence
- Phase A1: HTTP routes, facilitator/Mirror/HCS network writes, Solidity,
  POD upload/encryption execution, AI providers, timeout workers, dispute APIs,
  website changes, live v2 evidence

## Consequences

- ADR-001 remains authoritative for v1 reservation architecture and challenge
  transfer-cost economics metadata.
- Implementation proceeds incrementally (A1 schemas → A2 state machine/HCS/CAS →
  B access gates → C escrow → D POD/AI/review → E timeout/dispute/release → F UI).
- Trust-critical money uses integer strings / BigInt paths only; no floats.

## References

- `docs/plans/routeguard-v2-architecture-migration-plan.md`
- `docs/ADR-001-frozen-architecture.md`
- `src/v2/`
