/**
 * Phase 6B live-reservation constants (Hedera testnet).
 * Public identities + sealed authoritative hash expectations.
 */

export const PHASE6B_NETWORK = "hedera:testnet" as const;

export const PHASE6B_PAYER_ACCOUNT = "0.0.9197513" as const;
export const PHASE6B_CARRIER_ACCOUNT = "0.0.9215954" as const;
export const PHASE6B_FACILITATOR_FEE_PAYER = "0.0.7162784" as const;

export const PHASE6B_USDC_TOKEN = "0.0.429274" as const;
export const PHASE6B_USDC_AMOUNT_ATOMIC = "10000" as const;
export const PHASE6B_USDC_DISPLAY = "0.01" as const;

export const PHASE6B_HCS_TOPIC = "0.0.9587459" as const;
export const PHASE6B_CLOSE_BARRIER_SEQUENCE = 4 as const;

export const PHASE6B_TENDER_ID = "tender-ham-ist-hcs-c8b3e38a" as const;
export const PHASE6B_WINNING_BID_ID = "bid-a-b3e38a" as const;
export const PHASE6B_WINNING_CARRIER_ID = "carrier-alpha" as const;

/**
 * Public Phase 5 HCS topic evidence (topic 0.0.9587459, sequences 1–4).
 * commitmentEnvelopeHashes and tenderHash are on-chain and reconstructible.
 *
 * NOTE on evaluatedBidSetHash / decisionManifestHash:
 * The historical live demo used random commitmentSalt/nonce values that were
 * never persisted to git. Those specific hashes
 * (6ea347e8… / 2d4eb6ab… / winner 5864999e…) cannot be reproduced offline.
 * AUTHORITATIVE_HASHES below are the sealed reconstructible materials that
 * createAuctionClosureProof MUST match exactly — fail closed, no public-ID
 * fallback. tenderHash matches the live Phase 5 public tender body.
 */
export const PHASE5_LIVE_PUBLIC = Object.freeze({
  tenderHash:
    "sha256:4f15fd82ad0237eef84f1ab1f2b70f7b6f94bd17b8608bc94ca805a4d382c55f",
  closeBarrierConsensusTimestamp: "2026-07-15T18:58:17.944297247Z",
  auctionEndsAt: "2026-07-15T18:58:10.865Z",
  commitmentEnvelopeHashes: [
    "sha256:9a2ff0618e93060ffb29ce09c9e9552a8338e624fc1f5b47960ef27a44d2f128",
    "sha256:c9746b7aa932382f7d3b7a6ee7d6af6efd7d8e68643ca62088bb13fe5e504db8",
  ] as const,
  /** Historical live-run hashes (random salts; not reconstructible offline). */
  historicalLiveRunEvaluatedBidSetHash:
    "sha256:6ea347e8fccd4f703b0b36cd524c506748030cc7d41393a81886074115785e23",
  historicalLiveRunDecisionManifestHash:
    "sha256:2d4eb6abac3ea3924289996e31cae0804a9c021984bbbf829b0342d64dcba523",
  historicalLiveRunWinnerBidHash:
    "sha256:5864999e92f3cfa91605805209449d94e717f854981a1f3219b584c6c4b2635a",
});

/**
 * Exact hashes that createAuctionClosureProof MUST reproduce from the sealed
 * authoritative materials package (phase5-authoritative-source.json).
 * Fail closed on any mismatch. No public-identity-only validation path.
 */
export const AUTHORITATIVE_HASHES = Object.freeze({
  tenderHash:
    "sha256:4f15fd82ad0237eef84f1ab1f2b70f7b6f94bd17b8608bc94ca805a4d382c55f",
  winningBidHash:
    "sha256:d90b48dcdc8c9ed8995ccab379edb997ec08cf19c94f4321c13cd5a328996452",
  evaluatedBidSetHash:
    "sha256:65bdcc7a122ad87faeaa1ee28ba26c84fa9dc0218687e0b5e935213a1ba75781",
  decisionManifestHash:
    "sha256:2d13d468c7cfac7ca4b519b2a84866abaec1adb6cd00284e8cde9c532449a110",
});

export const CONFIRM_PHASE6B_RESERVATION_VALUE =
  "EXECUTE_ONE_USDC_ROUTE_RESERVATION" as const;

export const PHASE6B_DRY_RUN_ATTEMPT_PATH =
  "evidence/phase6b-dry-run-attempt.json" as const;
export const PHASE6B_DRY_RUN_EVIDENCE_JSON =
  "evidence/phase6b-dry-run.json" as const;
export const PHASE6B_DRY_RUN_EVIDENCE_MD =
  "evidence/phase6b-dry-run.md" as const;

export const PHASE6B_LIVE_ATTEMPT_PATH =
  "evidence/phase6b-live-reservation-attempt.json" as const;
export const PHASE6B_LIVE_EVIDENCE_JSON =
  "evidence/phase6b-live-reservation.json" as const;
export const PHASE6B_LIVE_EVIDENCE_MD =
  "evidence/phase6b-live-reservation.md" as const;

/** Fixed reservation id for the single planned live USDC run. */
export const PHASE6B_RESERVATION_ID = "res-phase6b-usdc-0001" as const;
export const PHASE6B_LIVE_ATTEMPT_ID = "phase6b-live-attempt-0001" as const;

export const PHASE6B_ATTEMPT_STATUSES = [
  "PLANNED",
  "DRY_RUN_COMPLETE",
  "PAYMENT_SUBMISSION_CLAIMED",
  "PAYMENT_SUBMITTED",
  "PAYMENT_CONFIRMED",
  "HCS_CLAIMED",
  "HCS_PUBLISHED",
  "SUCCESS",
  "FAILED",
  "AMBIGUOUS",
] as const;

export type Phase6bAttemptStatus = (typeof PHASE6B_ATTEMPT_STATUSES)[number];

/**
 * Public sealed materials for Phase 6B.1 historical path only.
 * No private keys. Historical topic 0.0.9587459 is exploratory evidence —
 * not the authority for the final demonstration (see src/final-demo/).
 */
export const AUTHORITATIVE_SOURCE_RELATIVE_PATH =
  "src/reservation/live/phase5-public-materials.json" as const;
