/**
 * Pre-network authoritative material generation for the final demo.
 *
 * Generates ephemeral ECDSA keypairs in memory, signs synthetic bids/receipts,
 * persists a public package (no private keys), then destroys private key refs.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { PrivateKey } from "@hiero-ledger/sdk";

import { computeRulesHash } from "../auction/rules";
import {
  acceptanceReceiptHash,
  signAcceptanceReceipt,
  verifyAcceptanceReceiptSignature,
  type SignedAcceptanceReceipt,
} from "../domain/acceptance-receipt";
import {
  bidHash,
  signCarrierBid,
  verifyCarrierBidSignature,
  type SignedCarrierBid,
} from "../domain/bid";
import type { CarrierRecord } from "../domain/carrier";
import {
  HBAR_ASSET,
  USDC_TESTNET_ASSET,
} from "../domain/payment-option";
import { parseFreightTender, tenderHash } from "../domain/tender";
import {
  createAuctionOpenEnvelope,
  createBidCommitmentEnvelope,
  envelopeHash,
} from "../hcs/message-envelope";
import {
  COMMITMENT_SCHEMA_VERSION,
  type AuctionOpenEnvelope,
  type BidCommitmentEnvelope,
} from "../hcs/types";
import { ENGINE_VERSION, SELECTION_POLICY } from "../auction/types";
import { atomicWriteJson } from "./atomic-write";
import {
  DATA_CLASSIFICATION_PUBLIC,
  FINAL_DEMO_AUCTION_WINDOW_SECONDS,
  FINAL_DEMO_MATERIALS_PATH,
  FINAL_DEMO_USDC_AMOUNT_ATOMIC,
  FINAL_DEMO_USDC_TOKEN,
  SYNTHETIC_DATA_DISCLOSURE,
} from "./constants";
import { FinalDemoError } from "./errors";
import {
  loadFinalAuctionTemplate,
  type FinalAuctionTemplate,
} from "./template";
import { assertNoPrivateKeyFields } from "./secret-scan";

export type FinalDemoAuthoritativeMaterials = {
  schemaVersion: "final-demo-authoritative-materials-1.0";
  dataClassification: typeof DATA_CLASSIFICATION_PUBLIC;
  disclosure: typeof SYNTHETIC_DATA_DISCLOSURE;
  attemptId: string;
  shortAttemptId: string;
  runId: string;
  runBaseTime: string;
  network: "hedera:testnet";
  tenderBody: ReturnType<typeof parseFreightTender>;
  tenderHash: string;
  rulesHash: string;
  auctionEndsAt: string;
  relativeTimestamps: {
    auctionWindowSeconds: number;
    pickupEarliest: string;
    pickupLatest: string;
    deliveryDeadline: string;
    bidValidUntil: string;
  };
  routeGuardPublicKey: string;
  carriers: CarrierRecord[];
  signedBids: SignedCarrierBid[];
  signedReceipts: SignedAcceptanceReceipt[];
  bidHashes: { alpha: string; beta: string };
  receiptHashes: { alpha: string; beta: string };
  commitmentPayloads: {
    alpha: BidCommitmentEnvelope;
    beta: BidCommitmentEnvelope;
  };
  commitmentEnvelopeHashes: { alpha: string; beta: string };
  auctionOpenEnvelope: AuctionOpenEnvelope;
  auctionOpenEnvelopeHash: string;
  identifiers: {
    tenderId: string;
    bidAlphaId: string;
    bidBetaId: string;
    reservationId: string;
    barrierId: string;
  };
  expectedWinner: {
    carrierId: string;
    carrierAccountId: string;
    bidId: string;
  };
  accounts: FinalAuctionTemplate["accounts"];
  createdAt: string;
};

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function addSecondsIso(iso: string, seconds: number): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new FinalDemoError(`Invalid ISO timestamp: ${iso}`, "BAD_TIMESTAMP");
  }
  return new Date(ms + seconds * 1000).toISOString();
}

function generateEcdsaKeypair(): { privateKeyHex: string; publicKeyHex: string } {
  const key = PrivateKey.generateECDSA();
  return {
    privateKeyHex: Buffer.from(key.toBytesRaw()).toString("hex"),
    publicKeyHex: key.publicKey.toStringRaw().toLowerCase(),
  };
}

function shortIdFromAttempt(attemptId: string): string {
  // Prefer last UUID segment / trailing hex for short bounded IDs
  const compact = attemptId.replace(/[^a-fA-F0-9]/g, "");
  const tail = compact.slice(-8).toLowerCase() || randomHex(4);
  return tail.slice(0, 8);
}

function paymentOptionsFor(accountId: string) {
  return [
    {
      optionId: "USDC" as const,
      scheme: "exact" as const,
      network: "hedera:testnet" as const,
      asset: USDC_TESTNET_ASSET,
      amountAtomic: FINAL_DEMO_USDC_AMOUNT_ATOMIC,
      payTo: accountId,
    },
    {
      optionId: "HBAR" as const,
      scheme: "exact" as const,
      network: "hedera:testnet" as const,
      asset: HBAR_ASSET,
      amountAtomic: "1000000",
      payTo: accountId,
    },
  ];
}

export type GenerateMaterialsInput = {
  attemptId?: string;
  runBaseTime?: string;
  templatePath?: string;
  template?: FinalAuctionTemplate;
  /** Override auction window (tests). */
  auctionWindowSeconds?: number;
  materialsPath?: string;
  /** When false, do not write disk (tests). Default true. */
  persist?: boolean;
};

/**
 * Create durable final-demo attempt IDs + complete public authoritative package.
 * Private signing keys exist only in local variables and are never returned/persisted.
 */
export function generateFinalDemoAuthoritativeMaterials(
  input: GenerateMaterialsInput = {},
): FinalDemoAuthoritativeMaterials {
  const template =
    input.template ?? loadFinalAuctionTemplate(input.templatePath);
  const attemptId =
    input.attemptId ?? `final-demo-${randomUUID()}`;
  const shortAttemptId = shortIdFromAttempt(attemptId);
  const runBaseTime = input.runBaseTime ?? new Date().toISOString();
  const windowSeconds =
    input.auctionWindowSeconds ??
    template.auction.windowSeconds ??
    FINAL_DEMO_AUCTION_WINDOW_SECONDS;

  const auctionEndsAt = addSecondsIso(runBaseTime, windowSeconds);
  const pickupEarliest = addSecondsIso(
    auctionEndsAt,
    template.relativeOffsets.pickupEarliestAfterAuctionEndSeconds,
  );
  const pickupLatest = addSecondsIso(
    pickupEarliest,
    template.relativeOffsets.pickupWindowDurationSeconds,
  );
  const deliveryDeadline = addSecondsIso(
    pickupLatest,
    template.relativeOffsets.deliveryAfterPickupLatestSeconds,
  );
  const bidValidUntil = addSecondsIso(
    auctionEndsAt,
    template.relativeOffsets.bidValidAfterAuctionEndSeconds,
  );

  const tenderId = `tender-final-${shortAttemptId}`;
  const bidAlphaId = `bid-alpha-final-${shortAttemptId}`;
  const bidBetaId = `bid-beta-final-${shortAttemptId}`;
  const reservationId = `reservation-final-${shortAttemptId}`;
  const barrierId = `barrier-final-${shortAttemptId}`;
  const runId = `final-${shortAttemptId}`;

  // --- Ephemeral keys (memory only) ---
  const routeGuard = generateEcdsaKeypair();
  const alphaKeys = generateEcdsaKeypair();
  const betaKeys = generateEcdsaKeypair();

  try {
    const tender = parseFreightTender({
      tenderId,
      shipperId: template.route.shipperId,
      origin: template.route.origin,
      destination: template.route.destination,
      cargo: template.cargo,
      requiredEquipment: template.equipment,
      pickupWindow: {
        earliest: pickupEarliest,
        latest: pickupLatest,
      },
      deliveryDeadline,
      auctionEndsAt,
      maximumFreightPriceCents: template.maximumFreightPriceCents,
      selectionPolicy: SELECTION_POLICY,
      version: template.tenderVersion,
    });
    const tHash = tenderHash(tender);
    const rulesHash = computeRulesHash();

    const carriers: CarrierRecord[] = [
      {
        carrierId: template.carriers.alpha.carrierId,
        carrierAccountId: template.carriers.alpha.carrierAccountId,
        signingPublicKey: alphaKeys.publicKeyHex,
        active: true,
        allowedEquipment: template.carriers.alpha.allowedEquipment,
        registryVersion: 1,
      },
      {
        carrierId: template.carriers.beta.carrierId,
        carrierAccountId: template.carriers.beta.carrierAccountId,
        signingPublicKey: betaKeys.publicKeyHex,
        active: true,
        allowedEquipment: template.carriers.beta.allowedEquipment,
        registryVersion: 1,
      },
    ];

    const signedAlpha = signCarrierBid(
      {
        bidId: bidAlphaId,
        tenderId,
        carrierId: template.carriers.alpha.carrierId,
        carrierAccountId: template.carriers.alpha.carrierAccountId,
        freightPriceCents: template.carriers.alpha.freightPriceCents,
        equipment: template.equipment,
        proposedPickupAt: addSecondsIso(
          pickupEarliest,
          template.relativeOffsets.alphaPickupOffsetSeconds,
        ),
        estimatedDelivery: addSecondsIso(
          pickupLatest,
          template.relativeOffsets.alphaDeliveryOffsetSeconds,
        ),
        capacityConfirmed: true,
        bidValidUntil,
        reservationPaymentOptions: paymentOptionsFor(
          template.carriers.alpha.carrierAccountId,
        ),
        commitmentSalt: randomHex(32),
        nonce: `nonce-alpha-${randomHex(8)}`,
        version: 1,
      },
      alphaKeys.privateKeyHex,
    );

    const signedBeta = signCarrierBid(
      {
        bidId: bidBetaId,
        tenderId,
        carrierId: template.carriers.beta.carrierId,
        carrierAccountId: template.carriers.beta.carrierAccountId,
        freightPriceCents: template.carriers.beta.freightPriceCents,
        equipment: template.equipment,
        proposedPickupAt: addSecondsIso(
          pickupEarliest,
          template.relativeOffsets.betaPickupOffsetSeconds,
        ),
        estimatedDelivery: addSecondsIso(
          pickupLatest,
          template.relativeOffsets.betaDeliveryOffsetSeconds,
        ),
        capacityConfirmed: true,
        bidValidUntil,
        reservationPaymentOptions: paymentOptionsFor(
          template.carriers.beta.carrierAccountId,
        ),
        commitmentSalt: randomHex(32),
        nonce: `nonce-beta-${randomHex(8)}`,
        version: 1,
      },
      betaKeys.privateKeyHex,
    );

    if (
      !verifyCarrierBidSignature(signedAlpha, alphaKeys.publicKeyHex) ||
      !verifyCarrierBidSignature(signedBeta, betaKeys.publicKeyHex)
    ) {
      throw new FinalDemoError(
        "Generated bid signatures failed verification",
        "SIGNATURE_VERIFY_FAILED",
      );
    }

    const bidHashAlpha = bidHash(signedAlpha.bid);
    const bidHashBeta = bidHash(signedBeta.bid);
    const acceptAt = runBaseTime;

    const receiptAlpha = signAcceptanceReceipt(
      {
        receiptId: `receipt-${bidAlphaId}`,
        tenderId,
        bidId: bidAlphaId,
        bidHash: bidHashAlpha,
        acceptedAt: acceptAt,
        version: 1,
      },
      routeGuard.privateKeyHex,
    );
    const receiptBeta = signAcceptanceReceipt(
      {
        receiptId: `receipt-${bidBetaId}`,
        tenderId,
        bidId: bidBetaId,
        bidHash: bidHashBeta,
        acceptedAt: acceptAt,
        version: 1,
      },
      routeGuard.privateKeyHex,
    );

    if (
      !verifyAcceptanceReceiptSignature(
        receiptAlpha,
        routeGuard.publicKeyHex,
      ) ||
      !verifyAcceptanceReceiptSignature(receiptBeta, routeGuard.publicKeyHex)
    ) {
      throw new FinalDemoError(
        "Generated receipt signatures failed verification",
        "SIGNATURE_VERIFY_FAILED",
      );
    }

    const receiptHashAlpha = acceptanceReceiptHash(receiptAlpha.receipt);
    const receiptHashBeta = acceptanceReceiptHash(receiptBeta.receipt);

    const envMeta = {
      runId,
      tenderId,
      tenderVersion: tender.version,
      tenderHash: tHash,
    };

    const auctionOpenEnvelope = createAuctionOpenEnvelope({
      ...envMeta,
      createdAt: runBaseTime,
      payload: {
        tenderId,
        tenderVersion: tender.version,
        tenderHash: tHash,
        auctionEndsAt,
        selectionPolicy: SELECTION_POLICY,
        engineVersion: ENGINE_VERSION,
        rulesHash,
      },
    });

    const commitmentAlpha = createBidCommitmentEnvelope({
      ...envMeta,
      createdAt: runBaseTime,
      payload: {
        bidId: bidAlphaId,
        carrierId: template.carriers.alpha.carrierId,
        bidHash: bidHashAlpha,
        acceptanceReceiptHash: receiptHashAlpha,
        bidVersion: signedAlpha.bid.version,
        commitmentSchemaVersion: COMMITMENT_SCHEMA_VERSION,
      },
    });

    const commitmentBeta = createBidCommitmentEnvelope({
      ...envMeta,
      createdAt: runBaseTime,
      payload: {
        bidId: bidBetaId,
        carrierId: template.carriers.beta.carrierId,
        bidHash: bidHashBeta,
        acceptanceReceiptHash: receiptHashBeta,
        bidVersion: signedBeta.bid.version,
        commitmentSchemaVersion: COMMITMENT_SCHEMA_VERSION,
      },
    });

    // Asset sanity
    if (template.reservationPayment.usdc.asset !== FINAL_DEMO_USDC_TOKEN) {
      throw new FinalDemoError("Template USDC asset mismatch", "WRONG_TOKEN");
    }
    if (
      template.reservationPayment.usdc.amountAtomic !==
      FINAL_DEMO_USDC_AMOUNT_ATOMIC
    ) {
      throw new FinalDemoError("Template USDC amount mismatch", "WRONG_AMOUNT");
    }
    if (
      template.carriers.alpha.carrierAccountId !==
      template.accounts.winnerReceiverAccountId
    ) {
      throw new FinalDemoError(
        "Alpha winner account must match winnerReceiverAccountId",
        "WRONG_RECEIVER",
      );
    }

    const materials: FinalDemoAuthoritativeMaterials = {
      schemaVersion: "final-demo-authoritative-materials-1.0",
      dataClassification: DATA_CLASSIFICATION_PUBLIC,
      disclosure: SYNTHETIC_DATA_DISCLOSURE,
      attemptId,
      shortAttemptId,
      runId,
      runBaseTime,
      network: "hedera:testnet",
      tenderBody: tender,
      tenderHash: tHash,
      rulesHash,
      auctionEndsAt,
      relativeTimestamps: {
        auctionWindowSeconds: windowSeconds,
        pickupEarliest,
        pickupLatest,
        deliveryDeadline,
        bidValidUntil,
      },
      routeGuardPublicKey: routeGuard.publicKeyHex,
      carriers,
      signedBids: [signedAlpha, signedBeta],
      signedReceipts: [receiptAlpha, receiptBeta],
      bidHashes: { alpha: bidHashAlpha, beta: bidHashBeta },
      receiptHashes: { alpha: receiptHashAlpha, beta: receiptHashBeta },
      commitmentPayloads: {
        alpha: commitmentAlpha,
        beta: commitmentBeta,
      },
      commitmentEnvelopeHashes: {
        alpha: envelopeHash(commitmentAlpha),
        beta: envelopeHash(commitmentBeta),
      },
      auctionOpenEnvelope,
      auctionOpenEnvelopeHash: envelopeHash(auctionOpenEnvelope),
      identifiers: {
        tenderId,
        bidAlphaId,
        bidBetaId,
        reservationId,
        barrierId,
      },
      expectedWinner: {
        carrierId: template.carriers.alpha.carrierId,
        carrierAccountId: template.carriers.alpha.carrierAccountId,
        bidId: bidAlphaId,
      },
      accounts: template.accounts,
      createdAt: new Date().toISOString(),
    };

    assertNoPrivateKeyFields(materials, "authoritative-materials");

    if (input.persist !== false) {
      const materialsPath = input.materialsPath ?? FINAL_DEMO_MATERIALS_PATH;
      atomicWriteJson(materialsPath, materials);
      // Re-load and re-assert (persisted form)
      const reloaded = loadFinalDemoAuthoritativeMaterials(materialsPath);
      assertNoPrivateKeyFields(reloaded, "authoritative-materials-reload");
    }

    return materials;
  } finally {
    // Destroy private key material (best-effort wipe of string refs)
    routeGuard.privateKeyHex = "";
    alphaKeys.privateKeyHex = "";
    betaKeys.privateKeyHex = "";
  }
}

export function loadFinalDemoAuthoritativeMaterials(
  materialsPath?: string,
): FinalDemoAuthoritativeMaterials {
  const absolute = path.resolve(materialsPath ?? FINAL_DEMO_MATERIALS_PATH);
  if (!existsSync(absolute)) {
    throw new FinalDemoError(
      "Authoritative materials package missing",
      "MATERIALS_MISSING",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absolute, "utf8"));
  } catch {
    throw new FinalDemoError(
      "Authoritative materials are not valid JSON",
      "MATERIALS_CORRUPT",
    );
  }
  return parseFinalDemoAuthoritativeMaterials(raw);
}

export function parseFinalDemoAuthoritativeMaterials(
  raw: unknown,
): FinalDemoAuthoritativeMaterials {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FinalDemoError("Materials must be an object", "MATERIALS_INVALID");
  }
  const o = raw as FinalDemoAuthoritativeMaterials;
  if (o.schemaVersion !== "final-demo-authoritative-materials-1.0") {
    throw new FinalDemoError(
      "Unsupported materials schemaVersion",
      "MATERIALS_INVALID",
    );
  }
  if (o.dataClassification !== DATA_CLASSIFICATION_PUBLIC) {
    throw new FinalDemoError(
      "Materials dataClassification must be PUBLIC_SYNTHETIC_DEMO",
      "MATERIALS_INVALID",
    );
  }
  assertNoPrivateKeyFields(raw, "authoritative-materials");
  if (!o.tenderBody || !Array.isArray(o.signedBids) || o.signedBids.length !== 2) {
    throw new FinalDemoError(
      "Materials incomplete: need tender + 2 signed bids",
      "MATERIALS_INCOMPLETE",
    );
  }
  // Verify signatures still hold
  const alpha = o.signedBids[0]!;
  const beta = o.signedBids[1]!;
  const alphaCarrier = o.carriers.find(
    (c) => c.carrierId === alpha.bid.carrierId,
  );
  const betaCarrier = o.carriers.find((c) => c.carrierId === beta.bid.carrierId);
  if (!alphaCarrier || !betaCarrier) {
    throw new FinalDemoError("Carrier registry incomplete", "MATERIALS_INCOMPLETE");
  }
  if (!verifyCarrierBidSignature(alpha, alphaCarrier.signingPublicKey)) {
    throw new FinalDemoError("Alpha bid signature invalid", "SIGNATURE_INVALID");
  }
  if (!verifyCarrierBidSignature(beta, betaCarrier.signingPublicKey)) {
    throw new FinalDemoError("Beta bid signature invalid", "SIGNATURE_INVALID");
  }
  for (const r of o.signedReceipts) {
    if (!verifyAcceptanceReceiptSignature(r, o.routeGuardPublicKey)) {
      throw new FinalDemoError("Receipt signature invalid", "SIGNATURE_INVALID");
    }
  }
  // Hash reproducibility
  if (bidHash(alpha.bid) !== o.bidHashes.alpha) {
    throw new FinalDemoError("Alpha bidHash mismatch", "HASH_MISMATCH");
  }
  if (bidHash(beta.bid) !== o.bidHashes.beta) {
    throw new FinalDemoError("Beta bidHash mismatch", "HASH_MISMATCH");
  }
  if (tenderHash(parseFreightTender(o.tenderBody)) !== o.tenderHash) {
    throw new FinalDemoError("Tender hash mismatch", "HASH_MISMATCH");
  }
  return o;
}

/**
 * Adversarial helper: deep-clone materials without writing disk.
 */
export function cloneMaterials(
  materials: FinalDemoAuthoritativeMaterials,
): FinalDemoAuthoritativeMaterials {
  return JSON.parse(
    JSON.stringify(materials),
  ) as FinalDemoAuthoritativeMaterials;
}
