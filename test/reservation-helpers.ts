/**
 * Mock transports and service factory for reservation tests.
 */

import { canonicalSha256 } from "../src/domain/canonical-hash";
import { InMemoryReservationStore } from "../src/reservation/attempt-store";
import { ReservationService } from "../src/reservation/reservation-service";
import type {
  FacilitatorTransport,
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
import {
  DEMO_PAYER_ACCOUNT,
  RESERVATION_TEST_WEBHOOK_PRIVATE_KEY,
  buildVerifiedWinnerBundle,
  createReservationInputFromBundle,
  type WinnerBundle,
} from "./fixtures/reservation-fixtures";

export type MockControls = {
  verifyResult: FacilitatorVerifyResult;
  settleResult: FacilitatorSettleResult;
  settleImpl?: FacilitatorTransport["settle"];
  mirrorResult: MirrorConfirmation;
  mirrorImpl?: MirrorConfirmationTransport["getTransaction"];
  webhookOk: boolean;
  hcsOk: boolean;
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
    hcsOk: true,
    settleCallCount: 0,
    verifyCallCount: 0,
    ...overrides,
  };
}

export function buildService(opts?: {
  controls?: MockControls;
  bundle?: WinnerBundle;
  now?: string;
}): {
  service: ReservationService;
  store: InMemoryReservationStore;
  controls: MockControls;
  bundle: WinnerBundle;
} {
  const bundle = opts?.bundle ?? buildVerifiedWinnerBundle();
  const controls = opts?.controls ?? createMockControls();
  const store = new InMemoryReservationStore();

  const challenge: X402ChallengeTransport = {
    async createChallenge(selected) {
      const c: PaymentChallenge = {
        x402Version: 2,
        scheme: selected.scheme,
        network: selected.network,
        asset: selected.asset,
        amount: selected.amountAtomic,
        payTo: selected.payTo,
        resource: selected.resourcePath,
        maxTimeoutSeconds: 180,
        description: "Demo reservation fee",
      };
      return c;
    },
  };

  const facilitator: FacilitatorTransport = {
    async verify() {
      controls.verifyCallCount += 1;
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
    async deliver() {
      return controls.webhookOk
        ? { ok: true }
        : { ok: false, error: "webhook down" };
    },
  };

  const hcs: HcsPublisherTransport = {
    async publish() {
      if (!controls.hcsOk) {
        throw new Error("HCS publish failed");
      }
      return {
        topicId: "0.0.9999999",
        sequence: 5,
        transactionId: "0.0.9197513@1784142100.1",
        consensusTimestamp: "2026-07-15T19:06:00.000000001Z",
      };
    },
  };

  let clock = opts?.now ?? "2026-07-15T19:01:00.000Z";
  const service = new ReservationService({
    store,
    registry: bundle.registry,
    challenge,
    facilitator,
    mirror,
    webhooks,
    hcs,
    webhookSigningPrivateKey: RESERVATION_TEST_WEBHOOK_PRIVATE_KEY,
    now: () => clock,
    confirmationTimeoutMs: 1000,
  });

  return { service, store, controls, bundle };
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
  };
}

export { DEMO_PAYER_ACCOUNT, createReservationInputFromBundle, buildVerifiedWinnerBundle };
