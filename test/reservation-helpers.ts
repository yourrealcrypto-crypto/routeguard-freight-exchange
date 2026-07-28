/**
 * Mock transports and service factory for reservation tests.
 */

import { canonicalSha256 } from "../src/domain/canonical-hash";
import {
  InMemoryReservationStore,
  type ReservationStore,
} from "../src/reservation/attempt-store";
import { ReservationService } from "../src/reservation/reservation-service";
import type {
  FacilitatorTransport,
  HcsPublicationResolveResult,
  HcsPublicationResolver,
  HcsPublisherTransport,
  MirrorConfirmationTransport,
  WebhookDeliveryTransport,
  X402ChallengeTransport,
} from "../src/reservation/transports";
import type {
  FacilitatorSettleResult,
  FacilitatorVerifyResult,
  MirrorConfirmation,
  PaymentChallenge,
  SelectedPaymentOption,
} from "../src/reservation/types";
import { DEMO_RESERVATION_FEE_NOTE } from "../src/reservation/types";
import type { HcsEnvelope } from "../src/hcs/types";
import {
  DEMO_HCS_TOPIC,
  DEMO_PAYER_ACCOUNT,
  RESERVATION_TEST_WEBHOOK_PRIVATE_KEY,
  buildVerifiedWinnerBundle,
  createReservationInputFromBundle,
  type WinnerBundle,
} from "./fixtures/reservation-fixtures";

export type MockControls = {
  verifyResult: FacilitatorVerifyResult;
  verifyImpl?: FacilitatorTransport["verify"];
  settleResult: FacilitatorSettleResult;
  settleImpl?: FacilitatorTransport["settle"];
  mirrorResult: MirrorConfirmation;
  mirrorImpl?: MirrorConfirmationTransport["getTransaction"];
  mirrorCallCount: number;
  challengeCallCount: number;
  challengeImpl?: X402ChallengeTransport["createChallenge"];
  webhookOk: boolean;
  webhookImpl?: WebhookDeliveryTransport["deliver"];
  webhookDeliveries: Array<{
    recipient: "shipper" | "carrier";
    eventId: string;
    payloadHash: string;
  }>;
  hcsOk: boolean;
  hcsImpl?: HcsPublisherTransport["publish"];
  hcsPublishCallCount: number;
  hcsPublishedEnvelopes: HcsEnvelope[];
  hcsResolveResult: HcsPublicationResolveResult;
  hcsResolveImpl?: HcsPublicationResolver["resolvePublication"];
  hcsResolveCallCount: number;
  settleCallCount: number;
  verifyCallCount: number;
};

export function defaultMirrorSuccess(
  selected: SelectedPaymentOption,
  txId: string,
): MirrorConfirmation {
  if (selected.optionId === "HBAR") {
    return {
      status: "SUCCESS",
      transactionId: txId,
      consensusTimestamp: "2026-07-15T19:05:00.123456789Z",
      result: "SUCCESS",
      hbarTransfers: [
        { account: selected.payerAccount, amount: "-1000000" },
        { account: selected.payTo, amount: "1000000" },
        // fee payer separate
        { account: "0.0.7162784", amount: "-50000" },
      ],
      tokenTransfers: [],
    };
  }
  return {
    status: "SUCCESS",
    transactionId: txId,
    consensusTimestamp: "2026-07-15T19:05:00.123456789Z",
    result: "SUCCESS",
    hbarTransfers: [
      { account: "0.0.7162784", amount: "-75699963" },
    ],
    tokenTransfers: [
      {
        account: selected.payerAccount,
        amount: "-10000",
        tokenId: "0.0.429274",
      },
      {
        account: selected.payTo,
        amount: "10000",
        tokenId: "0.0.429274",
      },
    ],
  };
}

export function createMockControls(
  overrides: Partial<MockControls> = {},
): MockControls {
  const txId = "0.0.9197513@1784142000.100000000";
  return {
    verifyResult: { isValid: true },
    settleResult: {
      success: true,
      transactionId: txId,
      network: "hedera:testnet",
      payerAccountId: DEMO_PAYER_ACCOUNT,
    },
    mirrorResult: {
      status: "SUCCESS",
      transactionId: txId,
      consensusTimestamp: "2026-07-15T19:05:00.123456789Z",
      result: "SUCCESS",
      hbarTransfers: [],
      tokenTransfers: [],
    },
    webhookOk: true,
    webhookDeliveries: [],
    hcsOk: true,
    hcsPublishCallCount: 0,
    hcsPublishedEnvelopes: [],
    hcsResolveResult: { status: "NOT_FOUND_CONCLUSIVE" },
    hcsResolveCallCount: 0,
    settleCallCount: 0,
    verifyCallCount: 0,
    mirrorCallCount: 0,
    challengeCallCount: 0,
    ...overrides,
  };
}

export function buildService<S extends ReservationStore = InMemoryReservationStore>(opts?: {
  controls?: MockControls;
  bundle?: WinnerBundle;
  now?: string;
  store?: S;
  confirmationTimeoutMs?: number;
  mirrorPollIntervalMs?: number;
}): {
  service: ReservationService;
  store: S;
  controls: MockControls;
  bundle: WinnerBundle;
  setNow: (iso: string) => void;
  advanceMs: (ms: number) => void;
} {
  const bundle = opts?.bundle ?? buildVerifiedWinnerBundle();
  const controls = opts?.controls ?? createMockControls();
  const store = (opts?.store ?? new InMemoryReservationStore()) as S;

  const challenge: X402ChallengeTransport = {
    async createChallenge(selected) {
      controls.challengeCallCount += 1;
      if (controls.challengeImpl) {
        return controls.challengeImpl(selected);
      }
      const c: PaymentChallenge = {
        x402Version: 2,
        scheme: selected.scheme,
        network: selected.network,
        asset: selected.asset,
        amount: selected.amountAtomic,
        payTo: selected.payTo,
        resource: selected.resourcePath,
        maxTimeoutSeconds: 180,
        description: DEMO_RESERVATION_FEE_NOTE,
      };
      return c;
    },
  };

  const facilitator: FacilitatorTransport = {
    async verify(input) {
      controls.verifyCallCount += 1;
      if (controls.verifyImpl) {
        return controls.verifyImpl(input);
      }
      return controls.verifyResult;
    },
    async settle(input) {
      controls.settleCallCount += 1;
      if (controls.settleImpl) {
        return controls.settleImpl(input);
      }
      return {
        ...controls.settleResult,
        payerAccountId:
          controls.settleResult.payerAccountId || input.selected.payerAccount,
      };
    },
  };

  const mirror: MirrorConfirmationTransport = {
    async getTransaction(transactionId) {
      controls.mirrorCallCount += 1;
      if (controls.mirrorImpl) {
        return controls.mirrorImpl(transactionId);
      }
      // Auto-build asset-correct mirror if empty transfers
      if (
        controls.mirrorResult.status === "SUCCESS" &&
        controls.mirrorResult.hbarTransfers.length === 0 &&
        controls.mirrorResult.tokenTransfers.length === 0
      ) {
        // caller should set properly; return as-is for failure tests
        return {
          ...controls.mirrorResult,
          transactionId,
        };
      }
      return {
        ...controls.mirrorResult,
        transactionId: controls.mirrorResult.transactionId || transactionId,
      };
    },
  };

  const webhooks: WebhookDeliveryTransport = {
    async deliver(recipient, webhook) {
      controls.webhookDeliveries.push({
        recipient,
        eventId: webhook.headers["X-RouteGuard-Event-Id"],
        payloadHash: webhook.payloadHash,
      });
      if (controls.webhookImpl) {
        return controls.webhookImpl(recipient, webhook);
      }
      return controls.webhookOk
        ? { ok: true }
        : { ok: false, error: "webhook down" };
    },
  };

  const hcs: HcsPublisherTransport = {
    async publish(envelope) {
      controls.hcsPublishCallCount += 1;
      controls.hcsPublishedEnvelopes.push(envelope);
      if (controls.hcsImpl) {
        return controls.hcsImpl(envelope);
      }
      if (!controls.hcsOk) {
        throw new Error("HCS publish failed");
      }
      return {
        // Bind to the reservation auction topic used by fixtures (not a universal constant).
        topicId: DEMO_HCS_TOPIC,
        sequence: 5,
        transactionId: "0.0.9197513@1784142100.1",
        consensusTimestamp: "2026-07-15T19:06:00.000000001Z",
      };
    },
  };

  const hcsResolver: HcsPublicationResolver = {
    async resolvePublication(input) {
      controls.hcsResolveCallCount += 1;
      if (controls.hcsResolveImpl) {
        return controls.hcsResolveImpl(input);
      }
      return controls.hcsResolveResult;
    },
  };

  let clock = opts?.now ?? "2026-07-15T19:01:00.000Z";
  let clockMs = Date.parse(clock);
  if (!Number.isFinite(clockMs)) {
    clockMs = Date.parse("2026-07-15T19:01:00.000Z");
  }

  const service = new ReservationService({
    store,
    registry: bundle.registry,
    challenge,
    facilitator,
    mirror,
    webhooks,
    hcs,
    hcsResolver,
    webhookSigningPrivateKey: RESERVATION_TEST_WEBHOOK_PRIVATE_KEY,
    now: () => clock,
    nowMs: () => clockMs,
    // Injected sleep advances the fake clock — no wall-clock waits.
    sleep: async (ms: number) => {
      clockMs += ms;
      clock = new Date(clockMs).toISOString();
    },
    confirmationTimeoutMs: opts?.confirmationTimeoutMs ?? 1000,
    mirrorPollIntervalMs: opts?.mirrorPollIntervalMs ?? 100,
  });

  return {
    service,
    store,
    controls,
    bundle,
    setNow: (iso: string) => {
      clock = iso;
      const parsed = Date.parse(iso);
      if (Number.isFinite(parsed)) clockMs = parsed;
    },
    advanceMs: (ms: number) => {
      clockMs += ms;
      clock = new Date(clockMs).toISOString();
    },
  };
}

/**
 * Client-frozen transaction reference matching createMockControls' default
 * settle transaction ID (v1.5 §22.4 test binding).
 */
export const DEMO_CLIENT_TX_ID = "0.0.9197513@1784142000.100000000" as const;
export function demoClientTransaction(
  transactionId: string = DEMO_CLIENT_TX_ID,
): {
  transactionId: string;
  validStartTimestamp: string;
  transactionValidDurationSeconds: number;
} {
  const m = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(transactionId);
  if (!m) throw new Error(`bad demo tx id ${transactionId}`);
  const seconds = Number(m[2]);
  const nanos = (m[3] ?? "0").padStart(9, "0").slice(0, 9);
  const iso = new Date(seconds * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, `.${nanos}Z`);
  return {
    transactionId,
    validStartTimestamp: iso,
    transactionValidDurationSeconds: 180,
  };
}

export async function createAndSelect(
  service: ReservationService,
  bundle: WinnerBundle,
  optionId: "USDC" | "HBAR",
  reservationId = "res-test-001",
): Promise<{
  reservationId: string;
  offerHash: string;
  paymentPayloadHash: string;
  clientTransaction: ReturnType<typeof demoClientTransaction>;
}> {
  const input = createReservationInputFromBundle(bundle, reservationId);
  const record = await service.createReservation(input, bundle.tender);
  await service.selectOption({
    reservationId,
    optionId,
    offerHash: record.offer.offerHash,
    offerVersion: record.offer.offerVersion,
    payerAccount: DEMO_PAYER_ACCOUNT,
  });
  await service.issueChallenge(reservationId, optionId);
  return {
    reservationId,
    offerHash: record.offer.offerHash,
    paymentPayloadHash: canonicalSha256({ payload: "signed-demo", optionId }),
    clientTransaction: demoClientTransaction(),
  };
}

export {
  DEMO_HCS_TOPIC,
  DEMO_PAYER_ACCOUNT,
  createReservationInputFromBundle,
  buildVerifiedWinnerBundle,
};
