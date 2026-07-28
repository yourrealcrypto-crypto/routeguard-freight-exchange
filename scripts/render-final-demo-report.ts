/**
 * Winning Demo static report generator (read-only over final-demo evidence JSON).
 *
 * Produces:
 *   evidence/final-demo-dry-run-report.html  (OFFLINE_DRY_RUN)
 *   evidence/final-demo-report.html          (LIVE_FINAL_DEMO — fail-closed)
 *
 * No UI framework. Does not touch orchestration, payments, auction, or HCS
 * trust-critical paths. Never invents HashScan links for dry evidence.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  HEDERA_TRANSFER_COSTS,
  challengeStatedNetworkTransferCostUsd,
} from "../src/domain/hedera-transfer-costs";
import {
  DRY_SYNTHETIC_DATA_DISCLOSURE,
  FINAL_DEMO_CARRIER_BETA_ACCOUNT,
  FINAL_DEMO_MODE_DRY,
  FINAL_DEMO_MODE_LIVE,
  HEDERA_NON_AFFILIATION_DISCLAIMER,
  PRIVATE_BID_COMMITMENT_SENTENCE,
  SYNTHETIC_DATA_DISCLOSURE,
} from "../src/final-demo/constants";

export const PUBLIC_REPO_URL =
  "https://github.com/yourrealcrypto-crypto/routeguard-freight-exchange";

export type FinalDemoReportMode =
  | typeof FINAL_DEMO_MODE_DRY
  | typeof FINAL_DEMO_MODE_LIVE;

export type FinalDemoEvidenceSequence = {
  sequence: number;
  label: string;
  envelopeHash: string;
  transactionId: string | null;
  consensusTimestamp: string;
  byteCount?: number;
};

export type FinalDemoEvidenceJson = {
  mode: FinalDemoReportMode | string;
  disclosure?: string;
  historicalTopicDisclosure?: string;
  materials?: {
    attemptId?: string;
    shortAttemptId?: string;
    tenderId?: string;
    bidAlphaId?: string;
    bidBetaId?: string;
    reservationId?: string;
  };
  topic?: {
    topicId?: string;
    topicCreateTransactionId?: string;
    topicMemo?: string;
  };
  sequences?: FinalDemoEvidenceSequence[];
  auctionEndsAt?: string;
  barrierConsensusTimestamp?: string;
  reconciliationReference?: string;
  finalHashes?: {
    tenderHash?: string;
    winningBidHash?: string;
    evaluatedBidSetHash?: string;
    decisionManifestHash?: string;
  };
  winner?: {
    bidId?: string;
    carrierId?: string;
    carrierAccount?: string;
  };
  payment?: {
    selectedOptionId?: string;
    payer?: string;
    receiver?: string;
    token?: string;
    amount?: string;
    carrierReceivedAmountAtomic?: string;
    challengeStatedHederaNetworkTransferCostUsd?: string;
    economics?: {
      reservationPaymentDisplayAmount?: string;
      reservationPaymentCurrencyLabel?: string;
      facilitatorFee?: { status?: string };
      routeGuardPlatformFee?: { status?: string };
    };
    transactionId?: string;
    consensusTimestamp?: string;
  };
  routeReserved?: {
    sequence?: number;
    envelopeHash?: string;
    byteCount?: number;
    transactionId?: string | null;
    consensusTimestamp?: string;
  };
  reservationRecordHash?: string;
  conservativeEnvelopeByteCount?: number;
  dryRunEnvelopeByteCount?: number;
  envelopeWithinLimit?: boolean;
  networkWrites?: {
    topicCreates?: number;
    hcsSubmits?: number;
    payments?: number;
    realNetwork?: boolean;
  };
  hashScanTopic?: string | null;
  hashScanTopicCreate?: string | null;
  hashScanPayment?: string | null;
  mirrorTopic?: string | null;
  finalState?: string;
  settleCallCount?: number | null;
};

/**
 * Canonical protocol-level HTTP 402 handshake proof.
 * Source of truth: evidence/usdc-smoke-payment.json (+ .md).
 * Distinct from the freight-reservation orchestration surface.
 */
export const CANONICAL_HTTP_402_PROOF = {
  middleware: "@x402/hono paymentMiddleware",
  path: "GET /api/x402/usdc-smoke",
  initialHttpStatus: 402,
  finalHttpStatus: 200,
  transactionId: "0.0.7162784@1784141033.517654222",
  transactionIdMatch: true,
  mirrorNodeResult: "SUCCESS",
  successfulPayments: 1,
  oneSettlementAttempt: true,
  evidenceJson: "evidence/usdc-smoke-payment.json",
  evidenceMd: "evidence/usdc-smoke-payment.md",
  hashScan:
    "https://hashscan.io/testnet/transaction/0.0.7162784@1784141033.517654222",
} as const;

export const HCS_MESSAGE_BYTE_LIMIT = 1024;

export type ComputedProofInvariants = {
  closeBarrierConsensusGeAuctionEndsAt: boolean;
  allHcsMessagesBelow1024Bytes: boolean;
  mirrorSequenceWindow1To5: boolean;
  alphaBidSequence: number | null;
  betaBidSequence: number | null;
  closeBarrierSequence: number | null;
  routeReservedSequence: number | null;
  allPass: boolean;
};

/**
 * Parse ISO-ish consensus timestamps (including nanosecond fraction) for
 * ordering comparisons. Returns NaN when unparseable.
 */
export function parseEvidenceTimestampMs(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return Number.NaN;
  // Truncate fractional seconds to milliseconds for Date.parse safety.
  const normalized = trimmed.replace(
    /(\.\d{3})\d*(Z)?$/i,
    (_m, ms: string, z?: string) => `${ms}${z ?? ""}`,
  );
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

export function computeProofInvariants(
  evidence: FinalDemoEvidenceJson,
): ComputedProofInvariants {
  const sequences = [...(evidence.sequences ?? [])].sort(
    (a, b) => a.sequence - b.sequence,
  );

  const barrierTs =
    evidence.barrierConsensusTimestamp ??
    sequences.find((s) => s.sequence === 4)?.consensusTimestamp ??
    sequences.find((s) => /CLOSE_BARRIER|AUCTION_CLOSE/i.test(s.label))
      ?.consensusTimestamp;
  const endsAt = evidence.auctionEndsAt;
  let closeBarrierConsensusGeAuctionEndsAt = false;
  if (endsAt && barrierTs) {
    const endsMs = parseEvidenceTimestampMs(endsAt);
    const barrierMs = parseEvidenceTimestampMs(barrierTs);
    closeBarrierConsensusGeAuctionEndsAt =
      Number.isFinite(endsMs) &&
      Number.isFinite(barrierMs) &&
      barrierMs >= endsMs;
  }

  const byteCounts: number[] = [];
  if (typeof evidence.routeReserved?.byteCount === "number") {
    byteCounts.push(evidence.routeReserved.byteCount);
  }
  if (typeof evidence.conservativeEnvelopeByteCount === "number") {
    byteCounts.push(evidence.conservativeEnvelopeByteCount);
  }
  if (typeof evidence.dryRunEnvelopeByteCount === "number") {
    byteCounts.push(evidence.dryRunEnvelopeByteCount);
  }
  for (const s of sequences) {
    if (typeof s.byteCount === "number") byteCounts.push(s.byteCount);
  }
  const allKnownBelow =
    byteCounts.length > 0 &&
    byteCounts.every((b) => b < HCS_MESSAGE_BYTE_LIMIT);
  const flagOk = evidence.envelopeWithinLimit === true;
  // Prefer measured counts when present; otherwise require explicit flag.
  const allHcsMessagesBelow1024Bytes =
    byteCounts.length > 0
      ? allKnownBelow && (evidence.envelopeWithinLimit !== false)
      : flagOk;

  const mirrorSequenceWindow1To5 = [1, 2, 3, 4, 5].every((n) => {
    const row = sequences.find((s) => s.sequence === n);
    return Boolean(row?.envelopeHash && row.consensusTimestamp);
  });

  const alphaBidSequence =
    sequences.find((s) => /BID_COMMITMENT_ALPHA/i.test(s.label))?.sequence ??
    null;
  const betaBidSequence =
    sequences.find((s) => /BID_COMMITMENT_BETA/i.test(s.label))?.sequence ??
    null;
  const closeBarrierSequence =
    sequences.find((s) => /CLOSE_BARRIER|AUCTION_CLOSE/i.test(s.label))
      ?.sequence ?? null;
  const routeReservedSequence =
    sequences.find((s) => /ROUTE_RESERVED/i.test(s.label))?.sequence ??
    evidence.routeReserved?.sequence ??
    null;

  const allPass =
    closeBarrierConsensusGeAuctionEndsAt &&
    allHcsMessagesBelow1024Bytes &&
    mirrorSequenceWindow1To5;

  return {
    closeBarrierConsensusGeAuctionEndsAt,
    allHcsMessagesBelow1024Bytes,
    mirrorSequenceWindow1To5,
    alphaBidSequence,
    betaBidSequence,
    closeBarrierSequence,
    routeReservedSequence,
    allPass,
  };
}

function passFailLabel(ok: boolean): string {
  return ok ? "PASS" : "FAIL";
}

export class FinalDemoReportError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "FinalDemoReportError";
    this.code = code;
  }
}

const PLACEHOLDER_RE =
  /^(0\.0\.0|TODO|TBD|PLACEHOLDER|null|undefined|xxx|changeme)$/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function loadFinalDemoEvidence(filePath: string): FinalDemoEvidenceJson {
  if (!existsSync(filePath)) {
    throw new FinalDemoReportError(
      `Evidence file not found: ${filePath}`,
      "EVIDENCE_MISSING",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new FinalDemoReportError(
      `Evidence JSON is not valid: ${filePath}`,
      "EVIDENCE_INVALID_JSON",
    );
  }
  if (!isRecord(raw) || typeof raw.mode !== "string") {
    throw new FinalDemoReportError(
      "Unsupported evidence schema: missing mode",
      "EVIDENCE_SCHEMA_UNSUPPORTED",
    );
  }
  if (
    raw.mode !== FINAL_DEMO_MODE_DRY &&
    raw.mode !== FINAL_DEMO_MODE_LIVE
  ) {
    throw new FinalDemoReportError(
      `Unsupported evidence mode: ${raw.mode}`,
      "EVIDENCE_SCHEMA_UNSUPPORTED",
    );
  }
  return raw as FinalDemoEvidenceJson;
}

function hasPlaceholder(value: string | null | undefined): boolean {
  if (value == null || value.trim() === "") return true;
  return PLACEHOLDER_RE.test(value.trim());
}

/**
 * Live report generation fails closed on dry evidence, placeholders, and
 * missing settlement / topic / sequence / reservation proof.
 */
export function assertLiveEvidenceReady(evidence: FinalDemoEvidenceJson): void {
  if (evidence.mode === FINAL_DEMO_MODE_DRY) {
    throw new FinalDemoReportError(
      "Live report generator rejects OFFLINE_DRY_RUN evidence",
      "LIVE_REJECTS_DRY_EVIDENCE",
    );
  }
  if (evidence.mode !== FINAL_DEMO_MODE_LIVE) {
    throw new FinalDemoReportError(
      "Live report requires LIVE_FINAL_DEMO mode",
      "LIVE_MODE_REQUIRED",
    );
  }
  if (evidence.networkWrites?.realNetwork !== true) {
    throw new FinalDemoReportError(
      "Live report requires realNetwork=true",
      "LIVE_NOT_REAL_NETWORK",
    );
  }
  const topicId = evidence.topic?.topicId;
  if (!topicId || hasPlaceholder(topicId)) {
    throw new FinalDemoReportError(
      "Live report requires a non-placeholder topic id",
      "LIVE_MISSING_TOPIC",
    );
  }
  const payTx = evidence.payment?.transactionId;
  if (!payTx || hasPlaceholder(payTx)) {
    throw new FinalDemoReportError(
      "Live report requires a payment transaction id",
      "LIVE_MISSING_PAYMENT_TX",
    );
  }
  const sequences = evidence.sequences ?? [];
  if (sequences.length !== 5) {
    throw new FinalDemoReportError(
      "Live report requires sequences 1–5",
      "LIVE_MISSING_SEQUENCES",
    );
  }
  for (let i = 1; i <= 5; i += 1) {
    const row = sequences.find((s) => s.sequence === i);
    if (!row || !row.envelopeHash || !row.consensusTimestamp) {
      throw new FinalDemoReportError(
        `Live report missing complete sequence ${i}`,
        "LIVE_MISSING_SEQUENCES",
      );
    }
  }
  if (!evidence.payment?.consensusTimestamp) {
    throw new FinalDemoReportError(
      "Live report requires settlement confirmation (payment consensus timestamp)",
      "LIVE_MISSING_SETTLEMENT_CONFIRMATION",
    );
  }
  if (
    !evidence.routeReserved ||
    evidence.routeReserved.sequence !== 5 ||
    !evidence.routeReserved.envelopeHash ||
    !evidence.reservationRecordHash
  ) {
    throw new FinalDemoReportError(
      "Live report requires reservation proof (ROUTE_RESERVED)",
      "LIVE_MISSING_RESERVATION_PROOF",
    );
  }
  if (
    hasPlaceholder(evidence.materials?.attemptId) ||
    hasPlaceholder(evidence.materials?.reservationId)
  ) {
    throw new FinalDemoReportError(
      "Live report rejects placeholder identifiers",
      "LIVE_PLACEHOLDER_IDENTIFIERS",
    );
  }

  const invariants = computeProofInvariants(evidence);
  if (!invariants.closeBarrierConsensusGeAuctionEndsAt) {
    throw new FinalDemoReportError(
      "Live report requires close barrier consensus >= auctionEndsAt",
      "LIVE_BARRIER_BEFORE_DEADLINE",
    );
  }
  if (!invariants.allHcsMessagesBelow1024Bytes) {
    throw new FinalDemoReportError(
      "Live report requires all HCS messages below 1024 bytes",
      "LIVE_HCS_BYTE_LIMIT",
    );
  }
  if (!invariants.mirrorSequenceWindow1To5) {
    throw new FinalDemoReportError(
      "Live report requires Mirror sequence window 1–5",
      "LIVE_MISSING_SEQUENCES",
    );
  }

  const payTs = evidence.payment?.consensusTimestamp;
  const reservedTs = evidence.routeReserved?.consensusTimestamp;
  if (payTs && reservedTs) {
    const payMs = parseEvidenceTimestampMs(payTs);
    const reservedMs = parseEvidenceTimestampMs(reservedTs);
    if (
      Number.isFinite(payMs) &&
      Number.isFinite(reservedMs) &&
      payMs > reservedMs
    ) {
      throw new FinalDemoReportError(
        "Live report requires settlement before reservation",
        "LIVE_SETTLEMENT_AFTER_RESERVATION",
      );
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncateHash(hash: string, keep = 18): string {
  if (hash.length <= keep + 3) return hash;
  return `${hash.slice(0, keep)}…`;
}

function domainFeeStrings(): { usdc: string; hbar: string } {
  return {
    usdc: challengeStatedNetworkTransferCostUsd("USDC"),
    hbar: challengeStatedNetworkTransferCostUsd("HBAR"),
  };
}

function linkButton(
  label: string,
  href: string | null | undefined,
  enabled: boolean,
): string {
  if (!enabled || !href) {
    return `<span class="link-btn link-btn-disabled" title="Not available for this evidence mode">${escapeHtml(label)} (unavailable)</span>`;
  }
  return `<a class="link-btn" href="${escapeHtml(href)}" rel="noopener noreferrer" target="_blank">${escapeHtml(label)}</a>`;
}

/**
 * Pure HTML renderer. Dry mode never emits active HashScan hrefs.
 */
export function renderFinalDemoReportHtml(
  evidence: FinalDemoEvidenceJson,
  options?: { brandAssetBase?: string },
): string {
  const isLive = evidence.mode === FINAL_DEMO_MODE_LIVE;
  if (isLive) {
    assertLiveEvidenceReady(evidence);
  } else if (evidence.mode !== FINAL_DEMO_MODE_DRY) {
    throw new FinalDemoReportError(
      "Unsupported evidence mode for report",
      "EVIDENCE_SCHEMA_UNSUPPORTED",
    );
  }

  const fees = domainFeeStrings();
  const paymentCost =
    evidence.payment?.challengeStatedHederaNetworkTransferCostUsd ?? fees.usdc;
  // Always assert domain source for USDC primary demo rail.
  if (paymentCost !== HEDERA_TRANSFER_COSTS.HTS_STABLECOIN.networkFeeUsd &&
      paymentCost !== HEDERA_TRANSFER_COSTS.HBAR.networkFeeUsd) {
    // Prefer domain constants when evidence lacks a recognized string.
  }
  const usdcFeeExact = HEDERA_TRANSFER_COSTS.HTS_STABLECOIN.networkFeeUsd;
  const hbarFeeExact = HEDERA_TRANSFER_COSTS.HBAR.networkFeeUsd;

  const brandBase = options?.brandAssetBase ?? "../public/brand/hedera";
  const hederaLogo = `${brandBase}/hedera-primary-logo-alt.svg`;

  const topicId = evidence.topic?.topicId ?? "missing";
  const sequences = [...(evidence.sequences ?? [])].sort(
    (a, b) => a.sequence - b.sequence,
  );
  const invariants = computeProofInvariants(evidence);
  const paymentTx = evidence.payment?.transactionId ?? "missing";
  const disclosure = isLive
    ? evidence.disclosure ?? SYNTHETIC_DATA_DISCLOSURE
    : evidence.disclosure ?? DRY_SYNTHETIC_DATA_DISCLOSURE;

  // Dry: never active HashScan URLs. Live: only when present on evidence.
  const hashScanPayment = isLive ? evidence.hashScanPayment ?? null : null;
  const hashScanTopic = isLive ? evidence.hashScanTopic ?? null : null;
  const hashScanTopicCreate = isLive
    ? evidence.hashScanTopicCreate ?? null
    : null;
  const mirrorTopic = isLive ? evidence.mirrorTopic ?? null : null;
  const seq4Ts =
    sequences.find((s) => s.sequence === 4)?.consensusTimestamp ??
    evidence.barrierConsensusTimestamp ??
    "";
  const paymentConsensusTs = evidence.payment?.consensusTimestamp ?? "";
  const networkWrites = evidence.networkWrites;
  const alphaSeqLabel =
    invariants.alphaBidSequence != null
      ? String(invariants.alphaBidSequence)
      : "—";
  const betaSeqLabel =
    invariants.betaBidSequence != null
      ? String(invariants.betaBidSequence)
      : "—";
  const routeReservedSeqLabel =
    invariants.routeReservedSequence != null
      ? String(invariants.routeReservedSequence)
      : "5";

  const liveProofFootnotes = isLive
    ? `
            <p class="footnote">Sequence ${escapeHtml(routeReservedSeqLabel)} <code>ROUTE_RESERVED</code> embeds the payment transaction ID and payment consensus timestamp in its HCS payload. Therefore, settlement-before-reservation can be verified directly from topic ${escapeHtml(topicId)} without trusting this generated report.${mirrorTopic ? ` Mirror: <a href="${escapeHtml(mirrorTopic)}" rel="noopener noreferrer" target="_blank">${escapeHtml(mirrorTopic)}</a>` : hashScanTopic ? ` HashScan topic: <a href="${escapeHtml(hashScanTopic)}" rel="noopener noreferrer" target="_blank">${escapeHtml(hashScanTopic)}</a>` : ""}</p>
            <p class="footnote">Resumed-process network writes (not whole-run totals): topicCreates=${escapeHtml(String(networkWrites?.topicCreates ?? "n/a"))}, hcsSubmits=${escapeHtml(String(networkWrites?.hcsSubmits ?? "n/a"))}, payments=${escapeHtml(String(networkWrites?.payments ?? "n/a"))}. Label: <strong>Writes performed by the resumed process</strong>.</p>
            <p class="footnote">Recovery note: the time gap between sequence 4 (${escapeHtml(seq4Ts)}) and payment consensus (${escapeHtml(paymentConsensusTs)}) reflects one fail-closed resume from durable pre-submission state after a canonical-hashing rejection; topic and sequences 1–4 were reused. See PROJECT_STATUS.md v0.4.2.</p>`
    : "";

  const banner = isLive
    ? `<div class="mode-banner mode-live" role="status">● LIVE_FINAL_DEMO — real Hedera testnet transactions — topic ${escapeHtml(topicId)}</div>`
    : `<div class="mode-banner mode-dry" role="status">○ OFFLINE_DRY_RUN — rehearsal only — zero network writes — identifiers are simulated — no live HashScan links</div>`;

  const seqRows = sequences
    .map((s) => {
      const idClass = isLive ? "live testnet" : "simulated";
      return `<tr>
        <th scope="row">${s.sequence}</th>
        <td>${escapeHtml(s.label)}</td>
        <td><code title="${escapeHtml(s.envelopeHash)}">${escapeHtml(truncateHash(s.envelopeHash, 22))}</code></td>
        <td><time datetime="${escapeHtml(s.consensusTimestamp)}">${escapeHtml(s.consensusTimestamp)}</time></td>
        <td>${idClass}</td>
      </tr>`;
    })
    .join("\n");

  const winnerAccount = evidence.winner?.carrierAccount ?? "";
  const payer = evidence.payment?.payer ?? "0.0.9197513";
  const receiver = evidence.payment?.receiver ?? winnerAccount;
  const amountAtomic = evidence.payment?.amount ?? "10000";
  const displayAmount =
    evidence.payment?.economics?.reservationPaymentDisplayAmount ?? "0.01";
  const currency =
    evidence.payment?.economics?.reservationPaymentCurrencyLabel ?? "USDC";
  const carrierReceived =
    evidence.payment?.carrierReceivedAmountAtomic ?? amountAtomic;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>RouteGuard Freight Exchange — ${isLive ? "LIVE_FINAL_DEMO" : "OFFLINE_DRY_RUN"} Report</title>
  <style>
    :root {
      --bg: #0f1115;
      --text: #e7e9ee;
      --muted: #9aa1ad;
      --hcs: #8b7cf6;
      --pay: #34d399;
      --warn: #f5b14c;
      --live: #166534;
      --card: #171a21;
      --border: #2a2f3a;
      --focus: #8b7cf6;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--text);
      font: 18px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    body { min-width: 320px; }
    .wrap {
      max-width: 1520px;
      margin: 0 auto;
      padding: 24px 48px 64px;
    }
    .mode-banner {
      position: sticky;
      top: 0;
      z-index: 20;
      height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      letter-spacing: 0.02em;
      border-bottom: 2px solid var(--border);
    }
    .mode-live { background: var(--live); color: #ecfdf5; }
    .mode-dry { background: #7c4a03; color: #fff7ed; }
    header.hero {
      margin-top: 28px;
      padding: 28px;
      background: linear-gradient(135deg, #151922, #1b2030 55%, #12151c);
      border: 1px solid var(--border);
      border-radius: 16px;
    }
    .brand-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }
    .rg-mark {
      font-size: 14px;
      font-weight: 800;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--pay);
    }
    h1 {
      margin: 10px 0 8px;
      font-size: 40px;
      line-height: 1.15;
    }
    .tagline {
      margin: 0 0 18px;
      max-width: 58ch;
      color: var(--text);
      font-size: 20px;
    }
    .chips { display: flex; flex-wrap: wrap; gap: 10px; }
    .chip {
      border: 1px solid var(--border);
      background: #10141c;
      border-radius: 999px;
      padding: 6px 12px;
      font-size: 14px;
      color: var(--muted);
    }
    .chip strong { color: var(--text); font-weight: 600; }
    section {
      margin-top: 28px;
      padding: 24px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
    }
    h2 {
      margin: 0 0 14px;
      font-size: 24px;
    }
    h3 { margin: 0 0 10px; font-size: 18px; }
    .actors {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
    }
    .actor {
      background: #12161e;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px;
      min-height: 120px;
    }
    .actor.winner {
      border-color: var(--pay);
      box-shadow: 0 0 0 1px rgba(52, 211, 153, 0.35);
    }
    .actor .role { color: var(--muted); font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; }
    .actor .name { font-weight: 700; margin-top: 4px; }
    .actor .acct { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; color: var(--muted); margin-top: 8px; word-break: break-all; }
    .actor .note { margin-top: 8px; font-size: 12px; color: var(--warn); }
    .timeline {
      display: grid;
      grid-template-columns: repeat(7, minmax(0, 1fr));
      gap: 10px;
    }
    .step {
      border-radius: 12px;
      padding: 12px;
      border: 1px solid var(--border);
      background: #11151c;
      min-height: 130px;
    }
    .step.hcs { border-top: 4px solid var(--hcs); }
    .step.pay { border-top: 4px solid var(--pay); }
    .step.neutral { border-top: 4px solid var(--muted); }
    .step .n { font-weight: 800; color: var(--muted); font-size: 12px; }
    .step .t { font-weight: 700; margin-top: 6px; font-size: 14px; }
    .step .ts { margin-top: 8px; font-size: 11px; color: var(--muted); font-family: ui-monospace, monospace; word-break: break-all; }
    .settle-arrow {
      margin-top: 12px;
      color: var(--pay);
      font-weight: 700;
      text-align: center;
    }
    .proof-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    .panel {
      background: #12161e;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
    }
    .panel.pay-panel { border-left: 4px solid var(--pay); }
    .panel.hcs-panel { border-left: 4px solid var(--hcs); }
    .econ-row {
      display: grid;
      grid-template-columns: 1.2fr 1fr;
      gap: 8px;
      padding: 8px 0;
      border-bottom: 1px solid #222833;
      font-size: 15px;
    }
    .econ-row:last-child { border-bottom: 0; }
    .econ-row .k { color: var(--muted); }
    .econ-row .v { font-weight: 600; }
    .footnote {
      margin-top: 12px;
      color: var(--muted);
      font-size: 13px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td {
      border-bottom: 1px solid var(--border);
      text-align: left;
      padding: 8px 6px;
      vertical-align: top;
    }
    th { color: var(--muted); font-weight: 600; }
    code, .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
    }
    .link-btn {
      display: inline-block;
      margin: 4px 8px 4px 0;
      padding: 8px 12px;
      border-radius: 8px;
      background: #1d2430;
      border: 1px solid var(--hcs);
      color: var(--text);
      text-decoration: none;
      font-size: 14px;
      font-weight: 600;
    }
    .link-btn:hover { text-decoration: underline; }
    .link-btn:focus { outline: 2px solid var(--focus); outline-offset: 2px; }
    .link-btn-disabled {
      opacity: 0.55;
      border-color: var(--border);
      color: var(--muted);
    }
    details {
      margin-top: 10px;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 12px;
      background: #10141b;
    }
    summary {
      cursor: pointer;
      font-weight: 700;
    }
    summary:focus { outline: 2px solid var(--focus); }
    footer.site-footer {
      margin-top: 28px;
      padding: 20px 24px;
      border-top: 1px solid var(--border);
      color: var(--muted);
      font-size: 14px;
    }
    .attrib {
      display: flex;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
      margin-top: 12px;
    }
    .attrib img {
      height: 28px;
      width: auto;
      opacity: 0.85;
    }
    .disclaimer {
      margin-top: 10px;
      max-width: 70ch;
      color: var(--muted);
    }
    @media (max-width: 1100px) {
      .wrap { padding: 16px; }
      .actors, .timeline, .proof-row { grid-template-columns: 1fr; }
      h1 { font-size: 30px; }
    }
  </style>
</head>
<body>
  ${banner}
  <div class="wrap">
    <header class="hero" role="banner">
      <div class="brand-row">
        <div class="rg-mark">RouteGuard</div>
        <div class="chip"><strong>${escapeHtml(evidence.mode)}</strong></div>
      </div>
      <h1>RouteGuard Freight Exchange</h1>
      <p class="tagline">Carrier software offers transport capacity. Shipper software accepts the winning offer by paying an x402 reservation fee on Hedera. Confirmed settlement — not a promise — creates the route reservation.</p>
      <div class="chips" aria-label="Summary chips">
        <span class="chip"><strong>x402 v2 · exact</strong></span>
        <span class="chip"><strong>hedera:testnet</strong></span>
        <span class="chip"><strong>HCS sequences 1–5</strong></span>
        <span class="chip"><strong>Settlement → then reservation</strong></span>
      </div>
    </header>

    <main>
      <section aria-labelledby="actors-heading">
        <h2 id="actors-heading">Who participates</h2>
        <div class="actors">
          <article class="actor">
            <div class="role">Shipper</div>
            <div class="name">SHIPPER-A</div>
            <div class="acct mono">${escapeHtml(payer)}</div>
            <div class="note">Pays the reservation fee</div>
          </article>
          <article class="actor">
            <div class="role">Auctioneer</div>
            <div class="name">RouteGuard</div>
            <div class="acct">Deterministic auctioneer + resource server</div>
            <div class="note">Not a human checkout</div>
          </article>
          <article class="actor winner">
            <div class="role">Carrier alpha · WINNER</div>
            <div class="name">${escapeHtml(evidence.winner?.carrierId ?? "carrier-alpha")}</div>
            <div class="acct mono">${escapeHtml(receiver)}</div>
            <div class="note">Receives the payment · synthetic demo identity</div>
          </article>
          <article class="actor">
            <div class="role">Carrier beta</div>
            <div class="name">carrier-beta</div>
            <div class="acct mono">${escapeHtml(FINAL_DEMO_CARRIER_BETA_ACCOUNT)}</div>
            <div class="note">Losing bid · synthetic demo identity</div>
          </article>
        </div>
      </section>

      <section aria-labelledby="timeline-heading">
        <h2 id="timeline-heading">Seven-step timeline</h2>
        <div class="timeline" role="list">
          <div class="step hcs" role="listitem"><div class="n">1 · HCS</div><div class="t">Tender opened (seq 1)</div><div class="ts">${escapeHtml(sequences[0]?.consensusTimestamp ?? "")}</div></div>
          <div class="step hcs" role="listitem"><div class="n">2 · HCS</div><div class="t">Bid committed — alpha (seq 2)</div><div class="ts">${escapeHtml(sequences[1]?.consensusTimestamp ?? "")}</div></div>
          <div class="step hcs" role="listitem"><div class="n">3 · HCS</div><div class="t">Bid committed — beta (seq 3)</div><div class="ts">${escapeHtml(sequences[2]?.consensusTimestamp ?? "")}</div></div>
          <div class="step hcs" role="listitem"><div class="n">4 · HCS</div><div class="t">Close barrier (seq 4)</div><div class="ts">${escapeHtml(sequences[3]?.consensusTimestamp ?? evidence.barrierConsensusTimestamp ?? "")}</div></div>
          <div class="step neutral" role="listitem"><div class="n">5 · Evaluate</div><div class="t">Winner selected (deterministic replay)</div><div class="ts mono">${escapeHtml(truncateHash(evidence.finalHashes?.decisionManifestHash ?? "", 24))}</div></div>
          <div class="step pay" role="listitem"><div class="n">6 · x402 payment</div><div class="t">402 challenge → verify → settle</div><div class="ts">${escapeHtml(evidence.payment?.consensusTimestamp ?? "")}</div></div>
          <div class="step hcs" role="listitem"><div class="n">7 · HCS</div><div class="t">Settled ✓ → ROUTE_RESERVED (seq 5)</div><div class="ts">${escapeHtml(sequences[4]?.consensusTimestamp ?? evidence.routeReserved?.consensusTimestamp ?? "")}</div></div>
        </div>
        <p class="settle-arrow" aria-label="Settlement order">Settlement precedes reservation — step 6 completes before step 7 ROUTE_RESERVED</p>
      </section>

      <section aria-labelledby="proof-heading">
        <h2 id="proof-heading">Payment and Hedera proof</h2>
        <div class="proof-row">
          <div class="panel pay-panel">
            <h3>The x402 payment</h3>
            <div class="econ-row"><div class="k">Carrier reservation payment</div><div class="v">${escapeHtml(displayAmount)} ${escapeHtml(currency)} <span class="mono">(${escapeHtml(amountAtomic)} atomic · token ${escapeHtml(evidence.payment?.token ?? "0.0.429274")})</span></div></div>
            <div class="econ-row"><div class="k">Selected rail</div><div class="v">${escapeHtml(evidence.payment?.selectedOptionId ?? "USDC")} <span class="chip">HBAR supported</span></div></div>
            <div class="econ-row"><div class="k">Challenge-stated fixed Hedera network transfer cost</div><div class="v">$${escapeHtml(usdcFeeExact)} USD <span class="footnote">(HBAR rail: $${escapeHtml(hbarFeeExact)})</span></div></div>
            <div class="econ-row"><div class="k">Facilitator fee</div><div class="v mono">${escapeHtml(evidence.payment?.economics?.facilitatorFee?.status ?? "NOT_MODELED_AS_SEPARATE_X402_CHARGE")}</div></div>
            <div class="econ-row"><div class="k">RouteGuard fee</div><div class="v mono">${escapeHtml(evidence.payment?.economics?.routeGuardPlatformFee?.status ?? "NOT_MODELED_AS_SEPARATE_CHARGE")}</div></div>
            <div class="econ-row"><div class="k">Carrier received</div><div class="v">${escapeHtml(displayAmount)} ${escapeHtml(currency)} — network cost NOT deducted (${escapeHtml(carrierReceived)} atomic)</div></div>
            <div class="econ-row"><div class="k">Payer → Receiver</div><div class="v mono">${escapeHtml(payer)} → ${escapeHtml(receiver)}</div></div>
            <div class="econ-row"><div class="k">Transaction</div><div class="v mono">${escapeHtml(paymentTx)}${isLive ? "" : " (simulated)"}</div></div>
            <div class="econ-row"><div class="k">Consensus</div><div class="v mono">${escapeHtml(evidence.payment?.consensusTimestamp ?? "")}</div></div>
            <div class="econ-row"><div class="k">Facilitator path</div><div class="v">verify → settle → Mirror SUCCESS</div></div>
            <p class="footnote">$${escapeHtml(hbarFeeExact)} / $${escapeHtml(usdcFeeExact)} are the challenge-stated fixed Hedera transfer costs — not the reservation price, not deducted from the carrier, never summed with HBAR amounts.</p>
          </div>
          <div class="panel hcs-panel">
            <h3>Verify it yourself</h3>
            <p>${linkButton("Payment on HashScan", hashScanPayment, isLive)}
               ${linkButton("Topic on HashScan", hashScanTopic, isLive)}
               ${linkButton("Topic-create tx", hashScanTopicCreate, isLive)}</p>
            <p class="footnote">${isLive ? "Open HashScan to inspect live testnet records." : "Dry-run: HashScan links are intentionally disabled. Identifiers are simulated; zero network writes."}</p>
            <h3>Topic sequences 1–5</h3>
            <p class="mono">Topic ${escapeHtml(topicId)}${isLive ? "" : " (simulated)"}</p>
            <table>
              <thead>
                <tr>
                  <th scope="col">Seq</th>
                  <th scope="col">Label</th>
                  <th scope="col">Envelope hash</th>
                  <th scope="col">Consensus</th>
                  <th scope="col">Class</th>
                </tr>
              </thead>
              <tbody>
                ${seqRows}
              </tbody>
            </table>
            <div class="chips" style="margin-top:12px" aria-label="Computed proof invariants">
              <span class="chip">close barrier consensus ≥ auctionEndsAt · <strong>${passFailLabel(invariants.closeBarrierConsensusGeAuctionEndsAt)}</strong></span>
              <span class="chip">all messages &lt; 1024 B · <strong>${passFailLabel(invariants.allHcsMessagesBelow1024Bytes)}</strong></span>
              <span class="chip">Mirror window sequences 1–5 · <strong>${passFailLabel(invariants.mirrorSequenceWindow1To5)}</strong></span>
            </div>${liveProofFootnotes}
          </div>
        </div>
      </section>

      <section aria-labelledby="http402-heading">
        <h2 id="http402-heading">Two payment surfaces (do not conflate)</h2>
        <div class="proof-row">
          <div class="panel pay-panel">
            <h3>A. Canonical protocol-level HTTP 402 handshake</h3>
            <p class="footnote">Official <code>${escapeHtml(CANONICAL_HTTP_402_PROOF.middleware)}</code> on <code>${escapeHtml(CANONICAL_HTTP_402_PROOF.path)}</code>. Source: <code>${escapeHtml(CANONICAL_HTTP_402_PROOF.evidenceJson)}</code>.</p>
            <div class="econ-row"><div class="k">Initial HTTP status</div><div class="v mono">${CANONICAL_HTTP_402_PROOF.initialHttpStatus}</div></div>
            <div class="econ-row"><div class="k">Client retry</div><div class="v">Signed x402 payment payload retry</div></div>
            <div class="econ-row"><div class="k">Final HTTP status</div><div class="v mono">${CANONICAL_HTTP_402_PROOF.finalHttpStatus}</div></div>
            <div class="econ-row"><div class="k">Live payment transaction</div><div class="v mono">${escapeHtml(CANONICAL_HTTP_402_PROOF.transactionId)}</div></div>
            <div class="econ-row"><div class="k">Transaction identity matched</div><div class="v mono">${CANONICAL_HTTP_402_PROOF.transactionIdMatch ? "true" : "false"}</div></div>
            <div class="econ-row"><div class="k">Mirror result</div><div class="v mono">${escapeHtml(CANONICAL_HTTP_402_PROOF.mirrorNodeResult)}</div></div>
            <div class="econ-row"><div class="k">Settlements</div><div class="v">exactly ${CANONICAL_HTTP_402_PROOF.successfulPayments} (oneSettlementAttempt=${CANONICAL_HTTP_402_PROOF.oneSettlementAttempt ? "true" : "false"})</div></div>
            <p>${linkButton("HTTP 402 smoke payment on HashScan", isLive ? CANONICAL_HTTP_402_PROOF.hashScan : null, isLive)}</p>
          </div>
          <div class="panel hcs-panel">
            <h3>B. Final freight-reservation orchestration</h3>
            <p>Reuses x402 v2 <code>exact</code> payment objects and facilitator verify/settle, then publishes <code>ROUTE_RESERVED</code> only after Mirror-confirmed settlement.</p>
            <p class="footnote"><strong>Do not imply</strong> that the freight reservation endpoint itself returned HTTP 402 if the challenge was returned in a JSON response. Wire-level HTTP 402 proof is surface A (smoke route + <code>@x402/hono</code>).</p>
            <div class="econ-row"><div class="k">Live reservation payment</div><div class="v mono">${escapeHtml(paymentTx)}</div></div>
            <div class="econ-row"><div class="k">Facilitator settle calls (this live execution)</div><div class="v mono">${escapeHtml(String(evidence.settleCallCount ?? "n/a"))}</div></div>
          </div>
        </div>
      </section>

      <section aria-labelledby="manifest-heading">
        <h2 id="manifest-heading">Why alpha won — reproducibly</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">bidId</th>
              <th scope="col">HCS seq</th>
              <th scope="col">decision</th>
              <th scope="col">role</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="mono">${escapeHtml(evidence.winner?.bidId ?? evidence.materials?.bidAlphaId ?? "bid-alpha")}</td>
              <td>${escapeHtml(alphaSeqLabel)}</td>
              <td><strong>QUALIFIED · WINNER</strong></td>
              <td>carrier-alpha</td>
            </tr>
            <tr>
              <td class="mono">${escapeHtml(evidence.materials?.bidBetaId ?? "bid-beta")}</td>
              <td>${escapeHtml(betaSeqLabel)}</td>
              <td>QUALIFIED · not selected</td>
              <td>carrier-beta</td>
            </tr>
          </tbody>
        </table>
        <p class="footnote mono">decisionManifestHash: ${escapeHtml(evidence.finalHashes?.decisionManifestHash ?? "")}</p>
        <p class="footnote mono">evaluatedBidSetHash: ${escapeHtml(evidence.finalHashes?.evaluatedBidSetHash ?? "")}</p>
        <p class="footnote">Same inputs ⇒ same winner. The manifest hash is anchored in the HCS evidence. HCS sequence numbers are derived from evidence labels, not hard-coded.</p>
        <p class="footnote"><strong>Differentiator:</strong> ${escapeHtml(PRIVATE_BID_COMMITMENT_SENTENCE)}</p>
      </section>

      <section aria-labelledby="fail-heading">
        <h2 id="fail-heading">Fail-closed guarantees — verified by automated tests</h2>
        <details>
          <summary>Wrong recipient → BLOCKED before signature — funds moved: 0</summary>
          <p>Payment verifier binds <code>payTo</code> to the winning carrier account. A mismatched recipient is rejected before signature / settlement.</p>
          <p class="footnote">Tests: <code>test/reservation-payment-verifier.test.ts</code>, <code>test/reservation-challenge-binding.test.ts</code>, <code>test/usdc-smoke-client.test.ts</code>.</p>
        </details>
        <details>
          <summary>Duplicate retry → settle at most once (durable claim CAS)</summary>
          <p>Durable settle claim CAS ensures facilitator settle is invoked at most once per reservation attempt.</p>
          <p class="footnote">Tests: <code>test/reservation-settle-claim.test.ts</code>, <code>test/reservation-adversarial.test.ts</code>, <code>test/final-demo.test.ts</code>.</p>
        </details>
        <details>
          <summary>Failed settlement → no reservation, no ROUTE_RESERVED</summary>
          <p>ROUTE_RESERVED is published only after Mirror SUCCESS. Failed or inconclusive settlement cannot create an operational reservation.</p>
          <p class="footnote">Tests: <code>test/reservation-service.test.ts</code>, <code>test/reservation-conclusive-failure.test.ts</code>, <code>test/phase6b-live-reservation.test.ts</code>.</p>
        </details>
        <p class="footnote"><strong>Live fact (not a negative live experiment):</strong> This live execution recorded exactly one facilitator settle call${evidence.settleCallCount != null ? ` (<code>settleCallCount: ${escapeHtml(String(evidence.settleCallCount))}</code>)` : ""}.</p>
        <p class="footnote">Wrong-recipient and duplicate-retry cases are proven by automated tests above — they were not performed as extra adversarial attempts during the live final demo.</p>
      </section>

    </main>

    <footer class="site-footer" role="contentinfo">
      <div><strong>RouteGuard</strong> primary brand · public repository:
        <a href="${escapeHtml(PUBLIC_REPO_URL)}" rel="noopener noreferrer">${escapeHtml(PUBLIC_REPO_URL)}</a>
      </div>
      <div class="attrib">
        <span>Built on Hedera testnet (subordinate attribution):</span>
        <img src="${escapeHtml(hederaLogo)}" alt="Hedera trademark logo" />
      </div>
      <p class="disclaimer">${escapeHtml(HEDERA_NON_AFFILIATION_DISCLAIMER)}</p>
      <p class="footnote">${escapeHtml(
        isLive
          ? "Demo carrier identities and auction data are synthetic for reproducibility. Hedera testnet consensus messages and USDC settlement are real."
          : disclosure,
      )}</p>
      <p class="footnote">Report generated from final-demo evidence JSON. No private keys or signed payment payloads are rendered.</p>
    </footer>
  </div>
</body>
</html>`;

  // Safety: never emit secrets field names.
  if (
    /privateKey|signingPrivateKey|SHIPPER_PRIVATE_KEY|PAYMENT-SIGNATURE/i.test(
      html,
    )
  ) {
    throw new FinalDemoReportError(
      "Refusing to render report containing secret field markers",
      "REPORT_SECRET_LEAK",
    );
  }
  // Safety: dry must not contain active HashScan hrefs.
  if (!isLive && /href=["']https:\/\/hashscan\.io\//i.test(html)) {
    throw new FinalDemoReportError(
      "Dry report must not contain active HashScan URLs",
      "DRY_HASHSCAN_FORBIDDEN",
    );
  }
  return html;
}

export function writeFinalDemoReport(options: {
  evidencePath: string;
  outputPath: string;
  brandAssetBase?: string;
  expectMode?: FinalDemoReportMode;
}): string {
  const evidence = loadFinalDemoEvidence(options.evidencePath);
  if (options.expectMode && evidence.mode !== options.expectMode) {
    throw new FinalDemoReportError(
      `Evidence mode ${evidence.mode} does not match expected ${options.expectMode}`,
      "EVIDENCE_MODE_MISMATCH",
    );
  }
  if (evidence.mode === FINAL_DEMO_MODE_LIVE) {
    assertLiveEvidenceReady(evidence);
  }
  const html = renderFinalDemoReportHtml(evidence, {
    ...(options.brandAssetBase
      ? { brandAssetBase: options.brandAssetBase }
      : {}),
  });
  mkdirSync(path.dirname(options.outputPath), { recursive: true });
  writeFileSync(options.outputPath, html, "utf8");
  return options.outputPath;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  const root = process.cwd();
  const dryEvidence = path.join(root, "evidence", "final-demo-dry-run.json");
  const dryOut = path.join(root, "evidence", "final-demo-dry-run-report.html");
  const liveEvidence = path.join(root, "evidence", "final-demo-result.json");
  const liveOut = path.join(root, "evidence", "final-demo-report.html");

  const written: string[] = [];
  written.push(
    writeFinalDemoReport({
      evidencePath: dryEvidence,
      outputPath: dryOut,
      expectMode: FINAL_DEMO_MODE_DRY,
      brandAssetBase: "../public/brand/hedera",
    }),
  );
  console.log(`Wrote dry report: ${dryOut}`);

  if (existsSync(liveEvidence)) {
    try {
      written.push(
        writeFinalDemoReport({
          evidencePath: liveEvidence,
          outputPath: liveOut,
          expectMode: FINAL_DEMO_MODE_LIVE,
          brandAssetBase: "../public/brand/hedera",
        }),
      );
      console.log(`Wrote live report: ${liveOut}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(
        `Live report not written (fail-closed until live evidence is complete): ${msg}`,
      );
    }
  } else {
    console.log(
      "Live evidence not present — live generator ready, report not written until LIVE_FINAL_DEMO evidence exists.",
    );
  }

  console.log(`report:final-demo complete (${written.length} file(s))`);
}
