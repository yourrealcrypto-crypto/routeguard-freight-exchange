# ADR-001: Frozen RouteGuard Architecture

## Decision

RouteGuard Freight Exchange uses:

- x402 version 2
- Hedera `exact` scheme
- `hedera:testnet`
- Testnet USDC and native HBAR
- Hedera Consensus Service for auction evidence
- Deterministic TypeScript policies
- Settlement before reservation
- Application-level idempotency and payment reconciliation

## Excluded from the trust-critical core

- LLM transaction decisions
- Hedera Agent Kit
- Manual wallet checkout
- EVM auction contracts
- Scheduled Transaction escrow
- Mainnet
- Full freight-invoice settlement

## Change rule

This architecture may only be reopened if a live integration test or current official specification disproves an implementation assumption.