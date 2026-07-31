/**
 * Shared harness for the v2 x402 access-route tests.
 *
 * The real x402 resource server, scheme, and route composition are exercised;
 * only the facilitator is a double, injected through the standard
 * `FacilitatorClient` interface. No network call is ever made.
 */

import { PrivateKey } from "@hiero-ledger/sdk";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { Hono } from "hono";

import {
  InMemoryCarrierRegistry,
  type CarrierRecord,
} from "../src/domain/carrier";
import { bidSubmitResource, tenderActivateResource } from "../src/v2/access/resource";
import {
  X402AccessGate,
  type AccessActionBinding,
} from "../src/v2/access/x402-gate";
import { buildCarrierBidSignPayload } from "../src/v2/auth/canonical";
import { signCarrierBidForTests } from "../src/v2/auth/verify";
import { resolveV2AccessConfig, type V2AccessConfig } from "../src/v2/config";
import {
  createV2AccessApp,
  type V2AccessRouteDeps,
  type V2TenderCatalog,
} from "../src/v2/http/routes";
import type { LifecycleRecord } from "../src/v2/lifecycle/record";
import {
  parseV2CarrierBid,
  v2BidHash,
  type V2CarrierBid,
} from "../src/v2/schemas/bid";
import { parseV2FreightTender, type V2FreightTender } from "../src/v2/schemas/tender";
import { InMemoryBidBodyStore } from "../src/v2/store/bid-body-store";
import { LifecycleService } from "../src/v2/store/lifecycle-service";
import { InMemoryLifecycleStore } from "../src/v2/store/lifecycle-store";
import {
  AUCTION_ENDS,
  BUDGET,
  defaultTrustPolicy,
  HASH,
  T0,
  TREASURY,
} from "./v2-lifecycle-fixtures";

export const TENDER_ID = "tender-b1";
export const TENDER_VERSION = 1;
export const BID_ID = "bid-alpha-1";
export const CARRIER_ID = "carrier-alpha";
export const CARRIER_ACCOUNT = "0.0.9215954";
export const PAYER_ACCOUNT = "0.0.7162784";
export const FEE_PAYER_ACCOUNT = "0.0.5555";
export const SERVER_NOW = "2026-07-31T13:00:00.000Z";
/** Distinctive test salt — must not collide with other fixture hex constants. */
export const SALT = "9c4e".repeat(16);
export const FREIGHT_AMOUNT = "700000";

/** Ephemeral carrier signing key — generated per test process, never committed. */
export const CARRIER_PRIVATE = PrivateKey.generateECDSA();
export const CARRIER_PUBLIC = CARRIER_PRIVATE.publicKey.toStringRaw();

export type FacilitatorScript = {
  readonly verify?: (
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    calls: number,
  ) => VerifyResponse | Promise<VerifyResponse>;
  readonly settle?: (
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    calls: number,
  ) => SettleResponse | Promise<SettleResponse>;
  /** Simulated facilitator latency (deterministic, not a sleep-based race). */
  readonly delayMs?: number;
};

/** Injectable facilitator double: verified / rejected / failed / duplicate. */
export class MockFacilitator implements FacilitatorClient {
  verifyCalls = 0;
  settleCalls = 0;
  /** Never reset: each settlement must yield a distinct transaction id. */
  private settleSequence = 0;
  readonly settledTransactions: string[] = [];

  constructor(private readonly script: FacilitatorScript = {}) {}

  /** Reset call counters (used after harness setup, never mid-assertion). */
  resetCounts(): void {
    this.verifyCalls = 0;
    this.settleCalls = 0;
  }

  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: "hedera:testnet",
          extra: { feePayer: FEE_PAYER_ACCOUNT },
        },
      ],
      extensions: [],
      signers: {},
    };
  }

  private async pause(): Promise<void> {
    if (this.script.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.script.delayMs));
    }
  }

  async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    this.verifyCalls += 1;
    await this.pause();
    if (this.script.verify) {
      return this.script.verify(
        paymentPayload,
        paymentRequirements,
        this.verifyCalls,
      );
    }
    return { isValid: true, payer: PAYER_ACCOUNT };
  }

  async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    this.settleCalls += 1;
    this.settleSequence += 1;
    await this.pause();
    const result = this.script.settle
      ? await this.script.settle(
          paymentPayload,
          paymentRequirements,
          this.settleSequence,
        )
      : ({
          success: true,
          transaction: `0.0.7162784@178517389${this.settleSequence}.000000001`,
          network: "hedera:testnet",
          payer: PAYER_ACCOUNT,
        } satisfies SettleResponse);
    if (result.success) {
      this.settledTransactions.push(result.transaction);
    }
    return result;
  }
}

export class InMemoryTenderCatalog implements V2TenderCatalog {
  private readonly tenders = new Map<string, V2FreightTender>();

  set(tender: V2FreightTender): void {
    this.tenders.set(`${tender.tenderId}|${tender.version}`, tender);
  }

  async get(
    tenderId: string,
    tenderVersion: number,
  ): Promise<V2FreightTender | null> {
    return this.tenders.get(`${tenderId}|${tenderVersion}`) ?? null;
  }
}

export function testTender(
  overrides: Partial<V2FreightTender> = {},
): V2FreightTender {
  return parseV2FreightTender({
    tenderId: TENDER_ID,
    shipperId: "shipper-1",
    origin: "Rotterdam",
    destination: "Munich",
    cargo: {
      type: "palletized-dry",
      weightKg: 12_000,
      pallets: 24,
      dangerousGoods: false,
    },
    requiredEquipment: "dry-van-13.6m",
    pickupWindow: {
      earliest: "2026-08-03T06:00:00.000Z",
      latest: "2026-08-03T18:00:00.000Z",
    },
    deliveryDeadline: "2026-08-05T18:00:00.000Z",
    auctionEndsAt: AUCTION_ENDS,
    maximumFreightBudgetAtomic: BUDGET,
    selectionPolicy: "LOWEST_QUALIFIED_PRICE_V1",
    version: TENDER_VERSION,
    ...overrides,
  });
}

export function testCarrierRecord(
  overrides: Partial<CarrierRecord> = {},
): CarrierRecord {
  return {
    carrierId: CARRIER_ID,
    carrierAccountId: CARRIER_ACCOUNT,
    signingPublicKey: CARRIER_PUBLIC,
    active: true,
    allowedEquipment: ["dry-van-13.6m"],
    registryVersion: 1,
    ...overrides,
  };
}

export function testBid(overrides: Partial<V2CarrierBid> = {}): V2CarrierBid {
  return parseV2CarrierBid({
    bidId: BID_ID,
    tenderId: TENDER_ID,
    tenderVersion: TENDER_VERSION,
    carrierId: CARRIER_ID,
    carrierAccountId: CARRIER_ACCOUNT,
    freightAmountAtomic: FREIGHT_AMOUNT,
    equipment: "dry-van-13.6m",
    proposedPickupAt: "2026-08-03T08:00:00.000Z",
    estimatedDelivery: "2026-08-05T12:00:00.000Z",
    capacityConfirmed: true,
    bidValidUntil: "2026-08-02T00:00:00.000Z",
    commitmentSalt: SALT,
    nonce: "nonce-1",
    version: 1,
    ...overrides,
  });
}

export function signBid(input: {
  bid: V2CarrierBid;
  actionId: string;
  signedAt?: string;
  privateKey?: PrivateKey;
}): string {
  const payload = buildCarrierBidSignPayload({
    tenderId: input.bid.tenderId,
    tenderVersion: input.bid.tenderVersion,
    bidId: input.bid.bidId,
    carrierId: input.bid.carrierId,
    carrierAccountId: input.bid.carrierAccountId,
    bidHash: v2BidHash(input.bid),
    signedAt: input.signedAt ?? SERVER_NOW,
    actionId: input.actionId,
  });
  return signCarrierBidForTests(
    (input.privateKey ?? CARRIER_PRIVATE).toStringRaw(),
    payload,
  );
}

export type Harness = {
  readonly app: Hono;
  readonly deps: V2AccessRouteDeps;
  readonly facilitator: MockFacilitator;
  readonly gate: X402AccessGate;
  readonly config: V2AccessConfig;
  readonly lifecycle: LifecycleService;
  readonly bidBodies: InMemoryBidBodyStore;
  readonly carriers: InMemoryCarrierRegistry;
  readonly tenders: InMemoryTenderCatalog;
  setNow(value: string): void;
  record(): Promise<LifecycleRecord | null>;
  activationBinding(
    tenderId?: string,
    tenderVersion?: number,
  ): AccessActionBinding;
  bidBinding(bidId?: string, tenderId?: string, tenderVersion?: number): AccessActionBinding;
  paymentHeader(
    binding: AccessActionBinding,
    overrides?: Partial<PaymentRequirements> & { resourceUrl?: string },
  ): Promise<string>;
};

export type HarnessOptions = {
  readonly script?: FacilitatorScript;
  readonly treasury?: string;
  readonly carriers?: CarrierRecord[];
  readonly tender?: V2FreightTender;
  /** Seed the lifecycle up to ESCROW_FUNDED (default) or leave in DRAFT. */
  readonly seedState?: "DRAFT" | "ESCROW_FUNDED";
  readonly now?: string;
};

export async function createHarness(
  options: HarnessOptions = {},
): Promise<Harness> {
  const treasury = options.treasury ?? TREASURY;
  const config = resolveV2AccessConfig({
    ENABLE_V2_ACCESS_ROUTES: "true",
    ROUTEGUARD_ACCESS_TREASURY_ACCOUNT_ID: treasury,
  });

  const facilitator = new MockFacilitator(options.script);
  let now = options.now ?? SERVER_NOW;
  const gate = new X402AccessGate({
    facilitator,
    config,
    now: () => now,
  });

  const carriers = new InMemoryCarrierRegistry(
    options.carriers ?? [testCarrierRecord()],
  );
  const store = new InMemoryLifecycleStore();
  const lifecycle = new LifecycleService(store, { carriers });
  const bidBodies = new InMemoryBidBodyStore();
  const tenders = new InMemoryTenderCatalog();
  tenders.set(options.tender ?? testTender());

  await lifecycle.create({
    tenderId: TENDER_ID,
    tenderVersion: TENDER_VERSION,
    tenderHash: HASH,
    maximumFreightBudgetAtomic: BUDGET,
    auctionEndsAt: AUCTION_ENDS,
    createdAt: T0,
    trust: defaultTrustPolicy({ accessTreasuryAccountId: treasury }),
  });

  if ((options.seedState ?? "ESCROW_FUNDED") === "ESCROW_FUNDED") {
    await lifecycle.apply(TENDER_ID, {
      type: "ESCROW_FUNDING_CONFIRMED",
      actionId: "seed-funding",
      eventTime: T0,
      fundingTxId: "0.0.1@1.1",
      tokenId: "0.0.429274",
      fundedAmountAtomic: BUDGET,
      tenderId: TENDER_ID,
      tenderVersion: TENDER_VERSION,
    });
  }

  const deps: V2AccessRouteDeps = {
    lifecycle,
    bidBodies,
    tenders,
    carriers,
    gate,
    config,
    now: () => now,
  };
  const app = createV2AccessApp(deps);

  const activationBinding = (
    tenderId = TENDER_ID,
    tenderVersion = TENDER_VERSION,
  ): AccessActionBinding => ({
    actionType: "TENDER_ACTIVATE",
    tenderId,
    tenderVersion,
    bidId: null,
    resource: tenderActivateResource(tenderId, tenderVersion),
    description: "RouteGuard v2 tender activation access fee",
  });

  const bidBinding = (
    bidId = BID_ID,
    tenderId = TENDER_ID,
    tenderVersion = TENDER_VERSION,
  ): AccessActionBinding => ({
    actionType: "BID_SUBMIT",
    tenderId,
    tenderVersion,
    bidId,
    resource: bidSubmitResource(tenderId, tenderVersion, bidId),
    description: "RouteGuard v2 durable bid submission access fee",
  });

  return {
    app,
    deps,
    facilitator,
    gate,
    config,
    lifecycle,
    bidBodies,
    carriers,
    tenders,
    setNow(value: string) {
      now = value;
    },
    async record() {
      return lifecycle.get(TENDER_ID);
    },
    activationBinding,
    bidBinding,
    async paymentHeader(binding, overrides) {
      const required = await gate.paymentRequired(binding);
      const accepted = required.accepts[0]!;
      const { resourceUrl, ...requirementOverrides } = overrides ?? {};
      const payload: PaymentPayload = {
        x402Version: required.x402Version,
        resource: { url: resourceUrl ?? binding.resource },
        accepted: { ...accepted, ...requirementOverrides },
        payload: { signedTransaction: "0xtest-signed-transfer" },
      };
      return encodePaymentSignatureHeader(payload);
    },
  };
}

/** Convenience: POST helper that always sends JSON. */
export async function post(
  app: Hono,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

export function activatePath(
  tenderId = TENDER_ID,
  tenderVersion: number | string = TENDER_VERSION,
): string {
  return `/api/v2/tenders/${tenderId}/v/${tenderVersion}/activate`;
}

export function bidPath(
  bidId = BID_ID,
  tenderId = TENDER_ID,
  tenderVersion: number | string = TENDER_VERSION,
): string {
  return `/api/v2/tenders/${tenderId}/v/${tenderVersion}/bids/${bidId}`;
}
