import { describe, expect, it } from "vitest";

import {
  createAuctionClosureProof,
  isVerifiedAuctionClosureProof,
} from "../src/auction/closure-proof";
import { verifyDecisionManifestIntegrity } from "../src/auction/decision-manifest";
import { computeRulesHash } from "../src/auction/rules";
import {
  createAuctionMachine,
  transitionToBidding,
  transitionToClosed,
  transitionToOpen,
  transitionToReconciliation,
  transitionToWinnerSelected,
} from "../src/auction/state-machine";
import { ENGINE_VERSION, SELECTION_POLICY } from "../src/auction/types";
import {
  acceptanceReceiptHash,
  signAcceptanceReceipt,
} from "../src/domain/acceptance-receipt";
import { bidHash, signCarrierBid, type CarrierBid } from "../src/domain/bid";
import {
  InMemoryCarrierRegistry,
  type CarrierRecord,
} from "../src/domain/carrier";
import { isCommitmentTimely } from "../src/domain/commitment-evidence";
import {
  HBAR_ASSET,
  USDC_TESTNET_ASSET,
} from "../src/domain/payment-option";
import { parseFreightTender, tenderHash } from "../src/domain/tender";
import {
  createAuctionOpenEnvelope,
  createBidCommitmentEnvelope,
  createCloseBarrierEnvelope,
  decodeHcsEnvelopeFromBase64,
  encodeHcsEnvelopeUtf8,
  envelopeHash,
} from "../src/hcs/message-envelope";
import { MirrorNodeClient } from "../src/hcs/mirror-node-client";
import { reconcileMirrorMessages } from "../src/hcs/reconciliation";
import {
  assertLiveWriteAuthorized,
  HcsTopicClientError,
} from "../src/hcs/topic-client";
import {
  CLOSE_POLICY,
  COMMITMENT_SCHEMA_VERSION,
  HCS_DEMO_CARRIER_PAYMENT_ACCOUNT,
  type ObservedHcsMessage,
} from "../src/hcs/types";
import {
  CARRIER_KEYS,
  ROUTEGUARD_PRIVATE_KEY,
  ROUTEGUARD_PUBLIC_KEY,
} from "./fixtures/auction-fixtures";

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

function observed(
  topicId: string,
  sequence: number,
  envelope: ObservedHcsMessage["envelope"],
  consensusTimestamp: string,
): ObservedHcsMessage {
  return {
    topicId,
    sequence,
    consensusTimestamp,
    mirrorConsensusTimestamp: "1.0",
    envelope,
    envelopeHash: envelopeHash(envelope),
  };
}

describe("HCS auction Phase 4 integration", () => {
  it("produces Bid A as deterministic winner through closure proof + state machine", () => {
    const auctionEndsAt = "2026-07-15T12:01:00.000Z";
    const tender = parseFreightTender({
      tenderId: "tender-ham-ist-hcs-int",
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
      selectionPolicy: SELECTION_POLICY,
      version: 1,
    });
    const tHash = tenderHash(tender);
    const runId = "run-int-001";
    const topicId = "0.0.555";
    const rulesHash = computeRulesHash();

    const registry = new InMemoryCarrierRegistry([
      {
        carrierId: CARRIER_KEYS.alpha.carrierId,
        carrierAccountId: HCS_DEMO_CARRIER_PAYMENT_ACCOUNT,
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

    const bidABody: CarrierBid = {
      bidId: "bid-a-winner",
      tenderId: tender.tenderId,
      carrierId: CARRIER_KEYS.alpha.carrierId,
      carrierAccountId: HCS_DEMO_CARRIER_PAYMENT_ACCOUNT,
      freightPriceCents: 350_000,
      equipment: "Curtainsider",
      proposedPickupAt: "2026-07-17T10:00:00.000Z",
      estimatedDelivery: "2026-07-19T12:00:00.000Z",
      capacityConfirmed: true,
      bidValidUntil: "2026-07-16T00:00:00.000Z",
      reservationPaymentOptions: paymentOptions(HCS_DEMO_CARRIER_PAYMENT_ACCOUNT),
      commitmentSalt: "aa".repeat(32),
      nonce: "nonce-bid-a",
      version: 1,
    };
    const bidBBody: CarrierBid = {
      bidId: "bid-b-higher",
      tenderId: tender.tenderId,
      carrierId: CARRIER_KEYS.beta.carrierId,
      carrierAccountId: CARRIER_KEYS.beta.accountId,
      freightPriceCents: 375_000,
      equipment: "Curtainsider",
      proposedPickupAt: "2026-07-17T11:00:00.000Z",
      estimatedDelivery: "2026-07-19T10:00:00.000Z",
      capacityConfirmed: true,
      bidValidUntil: "2026-07-16T00:00:00.000Z",
      reservationPaymentOptions: paymentOptions(CARRIER_KEYS.beta.accountId),
      commitmentSalt: "bb".repeat(32),
      nonce: "nonce-bid-b",
      version: 1,
    };

    const signedA = signCarrierBid(bidABody, CARRIER_KEYS.alpha.privateKey);
    const signedB = signCarrierBid(bidBBody, CARRIER_KEYS.beta.privateKey);
    const receiptA = signAcceptanceReceipt(
      {
        receiptId: "receipt-bid-a",
        tenderId: tender.tenderId,
        bidId: signedA.bid.bidId,
        bidHash: bidHash(signedA.bid),
        acceptedAt: "2026-07-15T12:00:05.000Z",
        version: 1,
      },
      ROUTEGUARD_PRIVATE_KEY,
    );
    const receiptB = signAcceptanceReceipt(
      {
        receiptId: "receipt-bid-b",
        tenderId: tender.tenderId,
        bidId: signedB.bid.bidId,
        bidHash: bidHash(signedB.bid),
        acceptedAt: "2026-07-15T12:00:15.000Z",
        version: 1,
      },
      ROUTEGUARD_PRIVATE_KEY,
    );

    const meta = {
      runId,
      tenderId: tender.tenderId,
      tenderVersion: tender.version,
      tenderHash: tHash,
    };

    const openEnv = createAuctionOpenEnvelope({
      ...meta,
      createdAt: "2026-07-15T12:00:00.000Z",
      payload: {
        tenderId: tender.tenderId,
        tenderVersion: 1,
        tenderHash: tHash,
        auctionEndsAt,
        selectionPolicy: SELECTION_POLICY,
        engineVersion: ENGINE_VERSION,
        rulesHash,
      },
    });
    const cAEnv = createBidCommitmentEnvelope({
      ...meta,
      createdAt: "2026-07-15T12:00:10.000Z",
      payload: {
        bidId: signedA.bid.bidId,
        carrierId: signedA.bid.carrierId,
        bidHash: bidHash(signedA.bid),
        acceptanceReceiptHash: acceptanceReceiptHash(receiptA.receipt),
        bidVersion: signedA.bid.version,
        commitmentSchemaVersion: COMMITMENT_SCHEMA_VERSION,
      },
    });
    const cBEnv = createBidCommitmentEnvelope({
      ...meta,
      createdAt: "2026-07-15T12:00:20.000Z",
      payload: {
        bidId: signedB.bid.bidId,
        carrierId: signedB.bid.carrierId,
        bidHash: bidHash(signedB.bid),
        acceptanceReceiptHash: acceptanceReceiptHash(receiptB.receipt),
        bidVersion: signedB.bid.version,
        commitmentSchemaVersion: COMMITMENT_SCHEMA_VERSION,
      },
    });

    const obsOpen = observed(topicId, 1, openEnv, "2026-07-15T12:00:00.100Z");
    const obsA = observed(topicId, 2, cAEnv, "2026-07-15T12:00:10.100Z");
    const obsB = observed(topicId, 3, cBEnv, "2026-07-15T12:00:20.100Z");

    const barrierEnv = createCloseBarrierEnvelope({
      ...meta,
      createdAt: "2026-07-15T12:01:05.000Z",
      payload: {
        barrierId: "barrier-int-1",
        tenderId: tender.tenderId,
        tenderVersion: 1,
        tenderHash: tHash,
        auctionEndsAt,
        expectedCommitmentCount: 2,
        commitmentEnvelopeHashes: [obsA.envelopeHash, obsB.envelopeHash],
        closePolicy: CLOSE_POLICY,
      },
    });
    const obsBarrier = observed(
      topicId,
      4,
      barrierEnv,
      "2026-07-15T12:01:05.100Z",
    );

    // Input order scrambled
    const reconciled = reconcileMirrorMessages({
      topicId,
      messages: [obsB, obsBarrier, obsOpen, obsA],
      expectedRunId: runId,
      expectedTenderId: tender.tenderId,
      expectedTenderVersion: 1,
      expectedTenderHash: tHash,
    });

    expect(reconciled.completeness.complete).toBe(true);
    expect(reconciled.commitmentEvidence).toHaveLength(2);
    for (const c of reconciled.commitmentEvidence) {
      expect(isCommitmentTimely(c.consensusTimestamp, auctionEndsAt)).toBe(true);
    }

    const fullBids = new Map([
      [signedA.bid.bidId, signedA],
      [signedB.bid.bidId, signedB],
    ]);
    const receipts = new Map([
      [signedA.bid.bidId, receiptA],
      [signedB.bid.bidId, receiptB],
    ]);

    const evaluationTimestamp = reconciled.evaluationTimestamp;
    const proof = createAuctionClosureProof({
      tender,
      auctionEndsAt,
      closeBarrierSequence: reconciled.barrier.sequence,
      closeBarrierConsensusTimestamp: reconciled.barrier.consensusTimestamp,
      reconciledStartSequence: 1,
      reconciledEndSequence: reconciled.barrier.sequence,
      observedSequences: reconciled.completeness.observedSequences,
      evaluationTimestamp,
      reconciliationReference: `hcs-topic:${topicId}:1-${reconciled.barrier.sequence}`,
      commitments: reconciled.commitmentEvidence,
      fullBids,
      acceptanceReceipts: receipts,
      registry,
      routeGuardPublicKey: ROUTEGUARD_PUBLIC_KEY,
      now: evaluationTimestamp,
    });

    expect(isVerifiedAuctionClosureProof(proof)).toBe(true);
    expect(proof.completeness).toBe(true);
    expect(proof.manifest.winningBidId).toBe("bid-a-winner");
    expect(proof.manifest.winningBidHash).toBe(bidHash(signedA.bid));

    const integrity = verifyDecisionManifestIntegrity({
      tender,
      results: proof.results,
      evaluationTimestamp,
      barrierSequence: reconciled.barrier.sequence,
      reconciliationReference: proof.reconciliationReference,
      manifest: proof.manifest,
    });
    expect(integrity.ok).toBe(true);

    let machine = createAuctionMachine(auctionEndsAt);
    machine = transitionToOpen(machine);
    machine = transitionToBidding(machine);
    machine = transitionToReconciliation(machine, evaluationTimestamp);
    machine = transitionToClosed(machine, proof);
    expect(machine.state).toBe("AUCTION_CLOSED");
    machine = transitionToWinnerSelected(machine);
    expect(machine.state).toBe("WINNER_SELECTED");
    expect(machine.decisionManifest?.winningBidId).toBe("bid-a-winner");
  });

  it("Mirror Node pagination collects all pages (mocked fetch)", async () => {
    let call = 0;
    const client = new MirrorNodeClient({
      baseUrl: "https://example.test",
      fetchImpl: async (_url: string) => {
        call += 1;
        if (call === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              messages: [
                {
                  sequence_number: 1,
                  consensus_timestamp: "1.0",
                  message: "YQ==",
                },
              ],
              links: { next: "/api/v1/topics/0.0.1/messages?page=2" },
            }),
            text: async () => "",
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            messages: [
              {
                sequence_number: 2,
                consensus_timestamp: "2.0",
                message: "Yg==",
              },
            ],
            links: { next: null },
          }),
          text: async () => "",
        };
      },
    });

    const all = await client.fetchAllTopicMessages("0.0.1", { limit: 1 });
    expect(all).toHaveLength(2);
    expect(all[0]?.sequence_number).toBe(1);
    expect(all[1]?.sequence_number).toBe(2);
    expect(call).toBe(2);
  });

  it("base64 decoding recovers envelope", () => {
    const tender = parseFreightTender({
      tenderId: "tender-b64",
      shipperId: "s",
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
        earliest: "2026-08-03T06:00:00.000Z",
        latest: "2026-08-03T18:00:00.000Z",
      },
      deliveryDeadline: "2026-08-07T16:00:00.000Z",
      auctionEndsAt: "2026-08-01T10:00:00.000Z",
      maximumFreightPriceCents: 400_000,
      selectionPolicy: SELECTION_POLICY,
      version: 1,
    });
    const th = tenderHash(tender);
    const env = createAuctionOpenEnvelope({
      runId: "run-b64",
      tenderId: tender.tenderId,
      tenderVersion: 1,
      tenderHash: th,
      createdAt: "2026-07-15T12:00:00.000Z",
      payload: {
        tenderId: tender.tenderId,
        tenderVersion: 1,
        tenderHash: th,
        auctionEndsAt: tender.auctionEndsAt,
        selectionPolicy: SELECTION_POLICY,
        engineVersion: ENGINE_VERSION,
        rulesHash: computeRulesHash(),
      },
    });
    const b64 = Buffer.from(encodeHcsEnvelopeUtf8(env)).toString("base64");
    const decoded = decodeHcsEnvelopeFromBase64(b64);
    expect(decoded.messageType).toBe("AUCTION_OPEN");
    expect(envelopeHash(decoded)).toBe(envelopeHash(env));
  });

  it("live writes remain disabled by default", () => {
    expect(() =>
      assertLiveWriteAuthorized({
        enableLiveHedera: false,
        enableLiveHcsWrites: false,
        confirmValue: undefined,
      }),
    ).toThrow(HcsTopicClientError);

    expect(() =>
      assertLiveWriteAuthorized({
        enableLiveHedera: true,
        enableLiveHcsWrites: true,
        confirmValue: "WRONG",
      }),
    ).toThrow(/CONFIRM_HCS_DEMO_WRITE/);
  });
});
