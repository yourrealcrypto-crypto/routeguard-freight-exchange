/**
 * Deterministic offline auction fixtures.
 * Demo ECDSA keys are TEST FIXTURES ONLY — not production secrets.
 */

import { PrivateKey } from "@hiero-ledger/sdk";

import {
  acceptanceReceiptHash,
  signAcceptanceReceipt,
  type SignedAcceptanceReceipt,
} from "../../src/domain/acceptance-receipt";
import {
  bidHash,
  signCarrierBid,
  type CarrierBid,
  type SignedCarrierBid,
} from "../../src/domain/bid";
import {
  InMemoryCarrierRegistry,
  type CarrierRecord,
} from "../../src/domain/carrier";
import type { CommitmentEvidence } from "../../src/domain/commitment-evidence";
import {
  HBAR_ASSET,
  USDC_TESTNET_ASSET,
  type PaymentOption,
} from "../../src/domain/payment-option";
import {
  parseFreightTender,
  type FreightTender,
} from "../../src/domain/tender";

function pubkeyFromPriv(hex: string): string {
  return PrivateKey.fromStringECDSA(hex).publicKey.toStringRaw().toLowerCase();
}

/** TEST FIXTURE ONLY — not a production key. */
export const CARRIER_KEYS = {
  alpha: {
    privateKey:
      "2c7f365877be4aff42c4d89eb5d00cca27d63f2d97b8ea3b969f38ec5b781eac",
    publicKey:
      "03c981edb800dced96de053c5570b34ae5aadf5db0de6851e9ecf5d37a06bb0d32",
    accountId: "0.0.9100001",
    carrierId: "carrier-alpha",
  },
  beta: {
    privateKey:
      "5bf93b32e395f3aef291796c943df50b88f4b1913b7cb660d1b4191699a231b5",
    publicKey:
      "03e7d77b4c6d1ffb48f73531be8dd4a1f55286cf5fd0bdf48c4e944be9bc29d4bf",
    accountId: "0.0.9100002",
    carrierId: "carrier-beta",
  },
  gamma: {
    privateKey:
      "9ce3ce0363354d11d81aa5a2df4ef2cb752099737312372507f51922b9458911",
    publicKey:
      "02e6657b65e98187232657ed9648a6b60eebfebc05f58103fcc4bb57a8d7e4e769",
    accountId: "0.0.9100003",
    carrierId: "carrier-gamma",
  },
  delta: {
    privateKey:
      "e5f43b9df9ead625969a00e3cb0704e59a9465bd31547e8e2d4d842a9bdab749",
    publicKey:
      "0337a303f44e2bb4844c8b380613c9bb13bbd4d50da5ffce69b15f3b9095648ee7",
    accountId: "0.0.9100004",
    carrierId: "carrier-delta",
  },
  epsilon: {
    privateKey:
      "1da79c325ec910fe385af583816cb7e2db38cdbcf645fb043a7e9065ec8d2bc1",
    publicKey:
      "02d9b0b61577e355ecb3473c1e7ae603035ae299a0e7ce79384261a5e7be7a8308",
    accountId: "0.0.9100005",
    carrierId: "carrier-epsilon",
  },
} as const;

/** TEST FIXTURE ONLY — RouteGuard platform signing key for unit tests. */
export const ROUTEGUARD_PRIVATE_KEY =
  "7a8b9c0d1e2f30415263748596a7b8c9d0e1f2031425364758697a8b9c0d1e2f";
export const ROUTEGUARD_PUBLIC_KEY = pubkeyFromPriv(ROUTEGUARD_PRIVATE_KEY);

export const EVALUATION_TIMESTAMP = "2026-08-01T12:00:00.000Z";
export const AUCTION_ENDS_AT = "2026-08-01T10:00:00.000Z";
export const DEFAULT_PROPOSED_PICKUP = "2026-08-03T10:00:00.000Z";

export function buildHamburgIstanbulTender(
  overrides: Partial<FreightTender> = {},
): FreightTender {
  return parseFreightTender({
    tenderId: "tender-ham-ist-001",
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
      earliest: "2026-08-03T06:00:00.000Z",
      latest: "2026-08-03T18:00:00.000Z",
    },
    deliveryDeadline: "2026-08-07T16:00:00.000Z",
    auctionEndsAt: AUCTION_ENDS_AT,
    maximumFreightPriceCents: 400_000,
    selectionPolicy: "LOWEST_QUALIFIED_PRICE_V1",
    version: 1,
    ...overrides,
  });
}

export function buildCarrierRegistry(): InMemoryCarrierRegistry {
  const records: CarrierRecord[] = [
    {
      carrierId: CARRIER_KEYS.alpha.carrierId,
      carrierAccountId: CARRIER_KEYS.alpha.accountId,
      signingPublicKey: CARRIER_KEYS.alpha.publicKey,
      active: true,
      allowedEquipment: ["Curtainsider", "Box"],
      registryVersion: 1,
    },
    {
      carrierId: CARRIER_KEYS.beta.carrierId,
      carrierAccountId: CARRIER_KEYS.beta.accountId,
      signingPublicKey: CARRIER_KEYS.beta.publicKey,
      active: true,
      allowedEquipment: ["Curtainsider"],
      registryVersion: 1,
    },
    {
      carrierId: CARRIER_KEYS.gamma.carrierId,
      carrierAccountId: CARRIER_KEYS.gamma.accountId,
      signingPublicKey: CARRIER_KEYS.gamma.publicKey,
      active: true,
      allowedEquipment: ["Curtainsider", "Reefer"],
      registryVersion: 1,
    },
    {
      carrierId: CARRIER_KEYS.delta.carrierId,
      carrierAccountId: CARRIER_KEYS.delta.accountId,
      signingPublicKey: CARRIER_KEYS.delta.publicKey,
      active: false,
      allowedEquipment: ["Curtainsider"],
      registryVersion: 1,
    },
    {
      carrierId: CARRIER_KEYS.epsilon.carrierId,
      carrierAccountId: CARRIER_KEYS.epsilon.accountId,
      signingPublicKey: CARRIER_KEYS.epsilon.publicKey,
      active: true,
      allowedEquipment: ["Box"],
      registryVersion: 1,
    },
  ];
  return new InMemoryCarrierRegistry(records);
}

function paymentOptionsFor(accountId: string): PaymentOption[] {
  return [
    {
      optionId: "USDC",
      scheme: "exact",
      network: "hedera:testnet",
      asset: USDC_TESTNET_ASSET,
      amountAtomic: "10000",
      payTo: accountId,
    },
    {
      optionId: "HBAR",
      scheme: "exact",
      network: "hedera:testnet",
      asset: HBAR_ASSET,
      amountAtomic: "1000000",
      payTo: accountId,
    },
  ];
}

let saltCounter = 0;
function nextSalt(): string {
  saltCounter += 1;
  return saltCounter.toString(16).padStart(64, "0");
}

export function resetSaltCounter(): void {
  saltCounter = 0;
}

export type BidBuildOptions = {
  bidId: string;
  carrier: keyof typeof CARRIER_KEYS;
  freightPriceCents: number;
  equipment?: string;
  proposedPickupAt?: string;
  estimatedDelivery?: string;
  capacityConfirmed?: boolean;
  bidValidUntil?: string;
  payToOverride?: string;
  commitmentSalt?: string;
  privateKeyOverride?: string;
  tenderId?: string;
  version?: number;
  carrierAccountIdOverride?: string;
};

export function buildSignedBid(options: BidBuildOptions): SignedCarrierBid {
  const carrier = CARRIER_KEYS[options.carrier];
  const bid: CarrierBid = {
    bidId: options.bidId,
    tenderId: options.tenderId ?? "tender-ham-ist-001",
    carrierId: carrier.carrierId,
    carrierAccountId:
      options.carrierAccountIdOverride ?? carrier.accountId,
    freightPriceCents: options.freightPriceCents,
    equipment: options.equipment ?? "Curtainsider",
    proposedPickupAt:
      options.proposedPickupAt ?? DEFAULT_PROPOSED_PICKUP,
    estimatedDelivery:
      options.estimatedDelivery ?? "2026-08-06T12:00:00.000Z",
    capacityConfirmed: options.capacityConfirmed ?? true,
    bidValidUntil: options.bidValidUntil ?? "2026-08-02T00:00:00.000Z",
    reservationPaymentOptions: paymentOptionsFor(
      options.payToOverride ??
        options.carrierAccountIdOverride ??
        carrier.accountId,
    ),
    commitmentSalt: options.commitmentSalt ?? nextSalt(),
    nonce: `nonce-${options.bidId}`,
    version: options.version ?? 1,
  };

  const key = options.privateKeyOverride ?? carrier.privateKey;
  return signCarrierBid(bid, key);
}

export function buildReceiptForBid(
  signed: SignedCarrierBid,
  acceptedAt = "2026-08-01T09:00:00.000Z",
): SignedAcceptanceReceipt {
  const hash = bidHash(signed.bid);
  return signAcceptanceReceipt(
    {
      receiptId: `receipt-${signed.bid.bidId}`,
      tenderId: signed.bid.tenderId,
      bidId: signed.bid.bidId,
      bidHash: hash,
      acceptedAt,
      version: 1,
    },
    ROUTEGUARD_PRIVATE_KEY,
  );
}

export function buildCommitment(
  signed: SignedCarrierBid,
  receipt: SignedAcceptanceReceipt,
  hcsSequence: number,
  consensusTimestamp: string,
): CommitmentEvidence {
  return {
    tenderId: signed.bid.tenderId,
    bidId: signed.bid.bidId,
    carrierId: signed.bid.carrierId,
    bidHash: bidHash(signed.bid),
    acceptanceReceiptHash: acceptanceReceiptHash(receipt.receipt),
    bidVersion: signed.bid.version,
    hcsSequence,
    consensusTimestamp,
  };
}

export type ScenarioBundle = {
  tender: FreightTender;
  registry: InMemoryCarrierRegistry;
  fullBids: Map<string, SignedCarrierBid>;
  receipts: Map<string, SignedAcceptanceReceipt>;
  commitments: CommitmentEvidence[];
  routeGuardPublicKey: string;
  evaluationTimestamp: string;
};

export function buildFullScenario(): ScenarioBundle {
  resetSaltCounter();
  const tender = buildHamburgIstanbulTender();
  const registry = buildCarrierRegistry();
  const fullBids = new Map<string, SignedCarrierBid>();
  const receipts = new Map<string, SignedAcceptanceReceipt>();
  const commitments: CommitmentEvidence[] = [];

  function register(
    signed: SignedCarrierBid,
    seq: number,
    consensus: string,
    includeFullBid = true,
  ): void {
    const receipt = buildReceiptForBid(signed);
    if (includeFullBid) {
      fullBids.set(signed.bid.bidId, signed);
    }
    receipts.set(signed.bid.bidId, receipt);
    commitments.push(buildCommitment(signed, receipt, seq, consensus));
  }

  register(
    buildSignedBid({
      bidId: "bid-winner-low",
      carrier: "alpha",
      freightPriceCents: 350_000,
      estimatedDelivery: "2026-08-06T10:00:00.000Z",
    }),
    10,
    "2026-08-01T09:10:00.000Z",
  );

  register(
    buildSignedBid({
      bidId: "bid-higher-price",
      carrier: "beta",
      freightPriceCents: 375_000,
      estimatedDelivery: "2026-08-06T08:00:00.000Z",
    }),
    11,
    "2026-08-01T09:11:00.000Z",
  );

  register(
    buildSignedBid({
      bidId: "bid-late-cheap",
      carrier: "gamma",
      freightPriceCents: 300_000,
      estimatedDelivery: "2026-08-06T09:00:00.000Z",
    }),
    12,
    "2026-08-01T10:00:00.001Z",
  );

  register(
    buildSignedBid({
      bidId: "bid-equip-mismatch",
      carrier: "alpha",
      freightPriceCents: 340_000,
      equipment: "Flatbed",
    }),
    13,
    "2026-08-01T09:12:00.000Z",
  );

  register(
    buildSignedBid({
      bidId: "bid-late-delivery",
      carrier: "beta",
      freightPriceCents: 355_000,
      estimatedDelivery: "2026-08-08T12:00:00.000Z",
    }),
    14,
    "2026-08-01T09:13:00.000Z",
  );

  register(
    buildSignedBid({
      bidId: "bid-over-max",
      carrier: "gamma",
      freightPriceCents: 450_000,
    }),
    15,
    "2026-08-01T09:14:00.000Z",
  );

  register(
    buildSignedBid({
      bidId: "bid-bad-sig",
      carrier: "alpha",
      freightPriceCents: 360_000,
      privateKeyOverride: CARRIER_KEYS.beta.privateKey,
    }),
    16,
    "2026-08-01T09:15:00.000Z",
  );

  register(
    buildSignedBid({
      bidId: "bid-inactive",
      carrier: "delta",
      freightPriceCents: 345_000,
    }),
    17,
    "2026-08-01T09:16:00.000Z",
  );

  register(
    buildSignedBid({
      bidId: "bid-wrong-payto",
      carrier: "beta",
      freightPriceCents: 365_000,
      payToOverride: "0.0.9999999",
    }),
    18,
    "2026-08-01T09:17:00.000Z",
  );

  {
    const signed = buildSignedBid({
      bidId: "bid-missing-full",
      carrier: "gamma",
      freightPriceCents: 348_000,
    });
    register(signed, 19, "2026-08-01T09:18:00.000Z", false);
  }

  register(
    buildSignedBid({
      bidId: "bid-tie-hcs-b",
      carrier: "alpha",
      freightPriceCents: 370_000,
      estimatedDelivery: "2026-08-06T14:00:00.000Z",
      commitmentSalt: "aa".repeat(32),
    }),
    21,
    "2026-08-01T09:20:00.000Z",
  );
  register(
    buildSignedBid({
      bidId: "bid-tie-hcs-a",
      carrier: "beta",
      freightPriceCents: 370_000,
      estimatedDelivery: "2026-08-06T14:00:00.000Z",
      commitmentSalt: "bb".repeat(32),
    }),
    20,
    "2026-08-01T09:19:00.000Z",
  );

  register(
    buildSignedBid({
      bidId: "bid-tie-zz",
      carrier: "alpha",
      freightPriceCents: 380_000,
      estimatedDelivery: "2026-08-06T15:00:00.000Z",
      commitmentSalt: "cc".repeat(32),
    }),
    30,
    "2026-08-01T09:30:00.000Z",
  );
  register(
    buildSignedBid({
      bidId: "bid-tie-aa",
      carrier: "beta",
      freightPriceCents: 380_000,
      estimatedDelivery: "2026-08-06T15:00:00.000Z",
      commitmentSalt: "dd".repeat(32),
    }),
    31,
    "2026-08-01T09:30:00.000Z",
  );

  return {
    tender,
    registry,
    fullBids,
    receipts,
    commitments,
    routeGuardPublicKey: ROUTEGUARD_PUBLIC_KEY,
    evaluationTimestamp: EVALUATION_TIMESTAMP,
  };
}

export function sequencesFromCommitments(
  commitments: { hcsSequence: number }[],
): number[] {
  return commitments.map((c) => c.hcsSequence);
}
