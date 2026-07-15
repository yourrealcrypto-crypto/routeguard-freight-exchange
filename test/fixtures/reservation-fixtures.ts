/**
 * Shared fixtures for Phase 6A reservation tests.
 * Builds authentic VerifiedAuctionClosureProof via factory.
 */

import {
  createAuctionClosureProof,
  type VerifiedAuctionClosureProof,
} from "../../src/auction/closure-proof";
import { PrivateKey } from "@hiero-ledger/sdk";
import {
  acceptanceReceiptHash,
  signAcceptanceReceipt,
} from "../../src/domain/acceptance-receipt";
import { bidHash, signCarrierBid, type CarrierBid } from "../../src/domain/bid";
import {
  InMemoryCarrierRegistry,
  type CarrierRecord,
} from "../../src/domain/carrier";
import {
  HBAR_ASSET,
  USDC_TESTNET_ASSET,
} from "../../src/domain/payment-option";
import { parseFreightTender, tenderHash } from "../../src/domain/tender";
import {
  CARRIER_KEYS,
  ROUTEGUARD_PRIVATE_KEY,
  ROUTEGUARD_PUBLIC_KEY,
} from "./auction-fixtures";

export const RESERVATION_TEST_WEBHOOK_PRIVATE_KEY =
  "7a8b9c0d1e2f30415263748596a7b8c9d0e1f2031425364758697a8b9c0d1e2f";
export const RESERVATION_TEST_WEBHOOK_PUBLIC_KEY = PrivateKey.fromStringECDSA(
  RESERVATION_TEST_WEBHOOK_PRIVATE_KEY,
)
  .publicKey.toStringRaw()
  .toLowerCase();

export const DEMO_WINNER_ACCOUNT = "0.0.9215954" as const;
export const DEMO_PAYER_ACCOUNT = "0.0.9197513" as const;
export const DEMO_HCS_TOPIC = "0.0.9587459" as const;

function paymentOptions(accountId: string) {
  return [
    {
      optionId: "USDC" as const,
      scheme: "exact" as const,
      network: "hedera:testnet" as const,
      asset: USDC_TESTNET_ASSET,
      amountAtomic: "10000",
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

export type WinnerBundle = {
  tender: ReturnType<typeof parseFreightTender>;
  tHash: string;
  registry: InMemoryCarrierRegistry;
  proof: VerifiedAuctionClosureProof;
  winningBidId: string;
  winningBidHash: string;
  winningCarrierId: string;
  winningCarrierAccount: string;
  evaluationTimestamp: string;
  auctionEndsAt: string;
};

export function buildVerifiedWinnerBundle(): WinnerBundle {
  const auctionEndsAt = "2026-07-15T18:58:10.865Z";
  const evaluationTimestamp = "2026-07-15T18:58:17.944297247Z";
  const tender = parseFreightTender({
    tenderId: "tender-ham-ist-hcs-c8b3e38a",
    shipperId: "shipper-nordic-logistics",
    origin: "Hamburg, DE",
    destination: "Istanbul, TR",
    cargo: {
      type: "electronics",
      weightKg: 8200,
      pallets: 12,
      dangerousGoods: false,
    },
    requiredEquipment: "Curtainsider",
    pickupWindow: {
      earliest: "2026-07-17T06:00:00.000Z",
      latest: "2026-07-17T18:00:00.000Z",
    },
    deliveryDeadline: "2026-07-20T16:00:00.000Z",
    auctionEndsAt,
    maximumFreightPriceCents: 400_000,
    selectionPolicy: "LOWEST_QUALIFIED_PRICE_V1",
    version: 1,
  });
  const tHash = tenderHash(tender);

  const registry = new InMemoryCarrierRegistry([
    {
      carrierId: CARRIER_KEYS.alpha.carrierId,
      carrierAccountId: DEMO_WINNER_ACCOUNT,
      signingPublicKey: CARRIER_KEYS.alpha.publicKey,
      active: true,
      allowedEquipment: ["Curtainsider", "Box"],
      registryVersion: 1,
    } satisfies CarrierRecord,
    {
      carrierId: CARRIER_KEYS.beta.carrierId,
      carrierAccountId: CARRIER_KEYS.beta.accountId,
      signingPublicKey: CARRIER_KEYS.beta.publicKey,
      active: true,
      allowedEquipment: ["Curtainsider"],
      registryVersion: 1,
    } satisfies CarrierRecord,
  ]);

  const bidA: CarrierBid = {
    bidId: "bid-a-b3e38a",
    tenderId: tender.tenderId,
    carrierId: CARRIER_KEYS.alpha.carrierId,
    carrierAccountId: DEMO_WINNER_ACCOUNT,
    freightPriceCents: 350_000,
    equipment: "Curtainsider",
    proposedPickupAt: "2026-07-17T10:00:00.000Z",
    estimatedDelivery: "2026-07-19T12:00:00.000Z",
    capacityConfirmed: true,
    bidValidUntil: "2026-07-16T12:00:00.000Z",
    reservationPaymentOptions: paymentOptions(DEMO_WINNER_ACCOUNT),
    commitmentSalt: "aa".repeat(32),
    nonce: "nonce-bid-a",
    version: 1,
  };
  const bidB: CarrierBid = {
    bidId: "bid-b-b3e38a",
    tenderId: tender.tenderId,
    carrierId: CARRIER_KEYS.beta.carrierId,
    carrierAccountId: CARRIER_KEYS.beta.accountId,
    freightPriceCents: 375_000,
    equipment: "Curtainsider",
    proposedPickupAt: "2026-07-17T11:00:00.000Z",
    estimatedDelivery: "2026-07-19T10:00:00.000Z",
    capacityConfirmed: true,
    bidValidUntil: "2026-07-16T12:00:00.000Z",
    reservationPaymentOptions: paymentOptions(CARRIER_KEYS.beta.accountId),
    commitmentSalt: "bb".repeat(32),
    nonce: "nonce-bid-b",
    version: 1,
  };

  const signedA = signCarrierBid(bidA, CARRIER_KEYS.alpha.privateKey);
  const signedB = signCarrierBid(bidB, CARRIER_KEYS.beta.privateKey);
  const receiptA = signAcceptanceReceipt(
    {
      receiptId: "receipt-a",
      tenderId: tender.tenderId,
      bidId: signedA.bid.bidId,
      bidHash: bidHash(signedA.bid),
      acceptedAt: "2026-07-15T18:57:00.000Z",
      version: 1,
    },
    ROUTEGUARD_PRIVATE_KEY,
  );
  const receiptB = signAcceptanceReceipt(
    {
      receiptId: "receipt-b",
      tenderId: tender.tenderId,
      bidId: signedB.bid.bidId,
      bidHash: bidHash(signedB.bid),
      acceptedAt: "2026-07-15T18:57:05.000Z",
      version: 1,
    },
    ROUTEGUARD_PRIVATE_KEY,
  );

  const commitments = [
    {
      tenderId: tender.tenderId,
      bidId: signedA.bid.bidId,
      carrierId: signedA.bid.carrierId,
      bidHash: bidHash(signedA.bid),
      acceptanceReceiptHash: acceptanceReceiptHash(receiptA.receipt),
      bidVersion: 1,
      hcsSequence: 2,
      consensusTimestamp: "2026-07-15T18:57:05.556924104Z",
    },
    {
      tenderId: tender.tenderId,
      bidId: signedB.bid.bidId,
      carrierId: signedB.bid.carrierId,
      bidHash: bidHash(signedB.bid),
      acceptanceReceiptHash: acceptanceReceiptHash(receiptB.receipt),
      bidVersion: 1,
      hcsSequence: 3,
      consensusTimestamp: "2026-07-15T18:57:10.421468801Z",
    },
  ];

  const proof = createAuctionClosureProof({
    tender,
    auctionEndsAt,
    closeBarrierSequence: 4,
    closeBarrierConsensusTimestamp: evaluationTimestamp,
    reconciledStartSequence: 1,
    reconciledEndSequence: 4,
    observedSequences: [1, 2, 3, 4],
    evaluationTimestamp,
    reconciliationReference: `hcs-topic:${DEMO_HCS_TOPIC}:1-4`,
    commitments,
    fullBids: new Map([
      [signedA.bid.bidId, signedA],
      [signedB.bid.bidId, signedB],
    ]),
    acceptanceReceipts: new Map([
      [signedA.bid.bidId, receiptA],
      [signedB.bid.bidId, receiptB],
    ]),
    registry,
    routeGuardPublicKey: ROUTEGUARD_PUBLIC_KEY,
    now: evaluationTimestamp,
  });

  return {
    tender,
    tHash,
    registry,
    proof,
    winningBidId: signedA.bid.bidId,
    winningBidHash: bidHash(signedA.bid),
    winningCarrierId: CARRIER_KEYS.alpha.carrierId,
    winningCarrierAccount: DEMO_WINNER_ACCOUNT,
    evaluationTimestamp,
    auctionEndsAt,
  };
}

export function createReservationInputFromBundle(
  bundle: WinnerBundle,
  reservationId: string,
): import("../../src/reservation/types").CreateReservationInput {
  return {
    reservationId,
    tenderId: bundle.tender.tenderId,
    tenderVersion: bundle.tender.version,
    tenderHash: bundle.tHash,
    winningBidId: bundle.winningBidId,
    winningBidHash: bundle.winningBidHash,
    winningCarrierId: bundle.winningCarrierId,
    winningCarrierAccount: bundle.winningCarrierAccount,
    decisionManifestHash: bundle.proof.manifest.decisionManifestHash,
    evaluatedBidSetHash: bundle.proof.manifest.evaluatedBidSetHash,
    hcsTopicId: DEMO_HCS_TOPIC,
    closeBarrierSequence: 4,
    closeBarrierConsensusTimestamp: bundle.evaluationTimestamp,
    closureProof: bundle.proof,
    reservationOfferVersion: 1,
    createdAt: "2026-07-15T19:00:00.000Z",
    expiresAt: "2026-07-15T20:00:00.000Z",
  };
}
