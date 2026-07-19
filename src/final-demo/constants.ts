/**
 * Final-demo public constants (Phase 6B.4).
 * No private keys. No hard-coded HCS topic ID for the live chain.
 */

export const FINAL_DEMO_NETWORK = "hedera:testnet" as const;
export const FINAL_DEMO_MODE_LIVE = "LIVE_FINAL_DEMO" as const;
export const FINAL_DEMO_MODE_DRY = "OFFLINE_DRY_RUN" as const;

export const FINAL_DEMO_PAYER_ACCOUNT = "0.0.9197513" as const;
export const FINAL_DEMO_WINNER_ACCOUNT = "0.0.9215954" as const;
export const FINAL_DEMO_CARRIER_BETA_ACCOUNT = "0.0.9100002" as const;
export const FINAL_DEMO_FACILITATOR_FEE_PAYER = "0.0.7162784" as const;

export const FINAL_DEMO_USDC_TOKEN = "0.0.429274" as const;
export const FINAL_DEMO_USDC_AMOUNT_ATOMIC = "10000" as const;
export const FINAL_DEMO_USDC_DISPLAY = "0.01" as const;

/** Historical exploratory topic — never used as final-demo authority. */
export const HISTORICAL_PHASE5_TOPIC_ID = "0.0.9587459" as const;

export const HISTORICAL_TOPIC_DISCLOSURE =
  "Earlier exploratory Phase 5 auction run. Its private random commitment materials were not retained, so it is not used as the authority for the final reservation demonstration." as const;

/**
 * Live-mode disclosure: business data is synthetic; settlement/HCS writes are
 * real Hedera testnet transactions when executed under live guards.
 */
export const SYNTHETIC_DATA_DISCLOSURE =
  "All auction and carrier data in this final demonstration is deliberately synthetic and publicly disclosed for reproducibility. The Hedera payment and consensus transactions are real testnet transactions." as const;

/**
 * Dry-mode disclosure (F-007): rehearsal only — zero network writes; identifiers
 * are simulated and must not be presented as live HashScan evidence.
 */
export const DRY_SYNTHETIC_DATA_DISCLOSURE =
  "OFFLINE_DRY_RUN rehearsal only. All auction, carrier, topic, and payment identifiers in this evidence are deliberately synthetic and simulated for reproducibility. Zero network writes occurred: no Hedera topic was created, no HCS messages were submitted, and no payment was settled. These are not real testnet transactions and must not be treated as live HashScan evidence." as const;

export const DATA_CLASSIFICATION_PUBLIC =
  "PUBLIC_SYNTHETIC_DEMO" as const;

/** Non-affiliation disclaimer required for Hedera trademark use. */
export const HEDERA_NON_AFFILIATION_DISCLAIMER =
  "RouteGuard is an independent open-source project built on the Hedera testnet. It is not affiliated with, sponsored by, or endorsed by Hedera Hashgraph, LLC." as const;

/** F-011 plan differentiator sentence (exact wording). */
export const PRIVATE_BID_COMMITMENT_SENTENCE =
  "Private off-chain bids with salted, consensus-timestamped HCS commitments and reproducible deterministic evaluation." as const;

export const CONFIRM_FINAL_DEMO_VALUE =
  "CREATE_NEW_TOPIC_AND_EXECUTE_ONE_USDC_RESERVATION" as const;

export const FINAL_DEMO_TEMPLATE_PATH =
  "demo/fixtures/final-auction-template.json" as const;

/** @deprecated Shared path removed — use dry/live specific paths. */
export const FINAL_DEMO_MATERIALS_PATH =
  "evidence/final-demo-live-authoritative-materials.json" as const;

export const FINAL_DEMO_LIVE_MATERIALS_PATH =
  "evidence/final-demo-live-authoritative-materials.json" as const;
export const FINAL_DEMO_DRY_MATERIALS_PATH =
  "evidence/final-demo-dry-run-authoritative-materials.json" as const;

export const FINAL_DEMO_LIVE_ATTEMPT_PATH =
  "evidence/final-demo-live-attempt.json" as const;
export const FINAL_DEMO_RESULT_JSON_PATH =
  "evidence/final-demo-result.json" as const;
export const FINAL_DEMO_RESULT_MD_PATH =
  "evidence/final-demo-result.md" as const;

export const FINAL_DEMO_DRY_RUN_JSON_PATH =
  "evidence/final-demo-dry-run.json" as const;
export const FINAL_DEMO_DRY_RUN_MD_PATH =
  "evidence/final-demo-dry-run.md" as const;
export const FINAL_DEMO_DRY_RUN_ATTEMPT_PATH =
  "evidence/final-demo-dry-run-attempt.json" as const;

export const FINAL_DEMO_LIVE_RESERVATION_DIR =
  "data/final-demo-live-reservations" as const;
export const FINAL_DEMO_DRY_RESERVATION_DIR =
  "data/final-demo-dry-reservations" as const;

export const FINAL_DEMO_PLANNED_TOPIC_CREATES = 1 as const;
export const FINAL_DEMO_PLANNED_HCS_SUBMISSIONS = 5 as const;
export const FINAL_DEMO_PLANNED_PAYMENT_SUBMISSIONS = 1 as const;

/** Setup buffer before auction opens (topic create / prep). */
export const FINAL_DEMO_PREP_BUFFER_SECONDS = 120 as const;
/** Default live auction window after auctionOpensAt. */
export const FINAL_DEMO_AUCTION_WINDOW_SECONDS = 300 as const;
export const FINAL_DEMO_BARRIER_SAFETY_MARGIN_MS = 5_000 as const;
/** Fail closed if less than 30s remains before auctionEndsAt for commitments. */
export const FINAL_DEMO_COMMITMENT_SAFETY_MARGIN_MS = 30_000 as const;

export const FINAL_DEMO_ATTEMPT_SCHEMA = "final-demo-live-attempt-1.1" as const;

export const FINAL_DEMO_ATTEMPT_STATUSES = [
  "PLANNED",
  "MATERIALS_PERSISTED",
  "TOPIC_CREATE_CLAIMED",
  "TOPIC_CREATED",
  "TOPIC_CREATE_AMBIGUOUS",
  "WAITING_AUCTION_OPEN",
  "SEQ1_CLAIMED",
  "SEQ1_CONFIRMED",
  "SEQ2_CLAIMED",
  "SEQ2_CONFIRMED",
  "SEQ3_CLAIMED",
  "SEQ3_CONFIRMED",
  "WAITING_AUCTION_CLOSE",
  "SEQ4_CLAIMED",
  "SEQ4_CONFIRMED",
  "MIRROR_RECONCILED",
  "PROOF_RECONSTRUCTED",
  "PAYMENT_READY",
  "PAYMENT_SUBMISSION_CLAIMED",
  "PAYMENT_SUBMITTED",
  "PAYMENT_CONFIRMED",
  "SEQ5_CLAIMED",
  "SEQ5_CONFIRMED",
  "EVIDENCE_PENDING",
  "EVIDENCE_WRITING",
  "EVIDENCE_WRITTEN",
  "COMPLETED",
  "FAILED",
  "AMBIGUOUS",
  "MANUAL_REVIEW_REQUIRED",
  "DRY_RUN_COMPLETE",
] as const;

export type FinalDemoAttemptStatus =
  (typeof FINAL_DEMO_ATTEMPT_STATUSES)[number];

export const FINAL_DEMO_MESSAGE_LABELS = [
  "AUCTION_OPEN",
  "BID_COMMITMENT_ALPHA",
  "BID_COMMITMENT_BETA",
  "AUCTION_CLOSE_BARRIER",
  "ROUTE_RESERVED",
] as const;

export type FinalDemoMessageLabel =
  (typeof FINAL_DEMO_MESSAGE_LABELS)[number];
