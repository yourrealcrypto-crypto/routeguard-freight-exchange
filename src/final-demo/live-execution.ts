/**
 * Guarded live final-demo execution path (Phase 6B.4).
 *
 * Production entry always enforces every live guard and readiness gate.
 * No skip* flags are accepted. Tests exercise orchestration via
 * OFFLINE_DRY_RUN with mocked transports, not by weakening this API.
 *
 * Settlement authority is ALWAYS ReservationService.
 */

import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

import {
  FINAL_DEMO_LIVE_ATTEMPT_PATH,
  FINAL_DEMO_MODE_LIVE,
  FINAL_DEMO_CARRIER_BETA_ACCOUNT,
  FINAL_DEMO_PAYER_ACCOUNT,
  FINAL_DEMO_WINNER_ACCOUNT,
  HISTORICAL_PHASE5_TOPIC_ID,
} from "./constants";
import { FinalDemoError } from "./errors";
import { assertFinalDemoLiveAuthorized } from "./guards";
import {
  assertSafeToStartFinalDemoLive,
  loadFinalDemoAttempt,
  type FinalDemoAttemptRecord,
} from "./attempt-store";
import { assertSecretScanPass } from "./secret-scan";
import { checkFacilitatorPreflight } from "./facilitator-preflight";
import { loadFinalDemoAuthoritativeMaterials } from "./materials";
import {
  runFinalDemoOrchestration,
  type FinalDemoOrchestrationResult,
} from "./orchestration";
import type {
  FinalDemoClock,
  FinalDemoHcsTransport,
  FinalDemoTopicMirrorReader,
  FinalDemoTopicTransport,
  PaymentPayloadFactory,
  SessionFacilitatorTransport,
} from "./transports";
import type { MirrorConfirmationTransport } from "../reservation/transports";
import type { WebhookDeliveryTransport } from "../reservation/transports";
import {
  assertUsdcReadinessPass,
  checkFinalDemoUsdcReadiness,
} from "./usdc-readiness";
import {
  checkFinalDemoHcsIdentityReadiness,
  type FinalDemoHcsIdentity,
} from "./hcs-identity-readiness";
import { selectAuthorizedHcsSubmitter } from "./hcs-submit-authority";
import { buildFinalDemoTopicCreateTransaction } from "./topic-configuration";
import type { AccountCheckResult } from "./transports";

/**
 * Production live deps — only real transports / production options.
 * Extra properties (including any skip*) are rejected.
 */
export type FinalDemoLiveDeps = {
  env?: NodeJS.ProcessEnv;
  attemptPath?: string;
  materialsPath?: string;
  workDir?: string;
  resultJsonPath?: string;
  resultMdPath?: string;
  reservationStoreDir?: string;
  topicTransport?: FinalDemoTopicTransport;
  hcsTransport?: FinalDemoHcsTransport;
  topicMirrorReader?: FinalDemoTopicMirrorReader;
  paymentPayloadFactory?: PaymentPayloadFactory;
  facilitatorTransport?: SessionFacilitatorTransport;
  paymentMirrorTransport?: MirrorConfirmationTransport;
  webhookTransport?: WebhookDeliveryTransport;
  webhookSigningPrivateKey?: string;
  hcsIdentityPreflight?: () => Promise<AccountCheckResult>;
  clock?: FinalDemoClock;
  /** When true, build real live transports from env (production CLI). */
  useProductionTransports?: boolean;
};

const FORBIDDEN_SKIP_KEYS = [
  "skipEnvLiveGuard",
  "skipSecretScan",
  "skipUsdcReadiness",
  "skipAccountReadiness",
  "skipFacilitatorPreflight",
] as const;

function rejectSkipBypasses(deps: object): void {
  for (const k of FORBIDDEN_SKIP_KEYS) {
    if (Object.prototype.hasOwnProperty.call(deps, k)) {
      throw new FinalDemoError(
        `Production live entry rejects ${k} — no guard bypasses`,
        "GUARD_BYPASS_FORBIDDEN",
      );
    }
  }
  // Adversarial: any skip* property
  for (const k of Object.keys(deps)) {
    if (/^skip/i.test(k)) {
      throw new FinalDemoError(
        `Production live entry rejects skip property ${k}`,
        "GUARD_BYPASS_FORBIDDEN",
      );
    }
  }
}

/**
 * Pre-flight for live final demo readiness checks (no network writes).
 */
export function assertFinalDemoLiveReady(
  deps: FinalDemoLiveDeps = {},
): {
  attemptPath: string;
  materialsLoaded: boolean;
  existing: FinalDemoAttemptRecord | null;
} {
  rejectSkipBypasses(deps);
  const env = deps.env ?? process.env;
  assertFinalDemoLiveAuthorized({
    enableFinalDemoLive: env.ENABLE_FINAL_DEMO_LIVE,
    enableLiveHedera: env.ENABLE_LIVE_HEDERA,
    enableLiveUsdcPayments: env.ENABLE_LIVE_USDC_PAYMENTS,
    enableLiveHcsWrites: env.ENABLE_LIVE_HCS_WRITES,
    enableLiveTopicCreate: env.ENABLE_LIVE_TOPIC_CREATE,
    enablePhase6bLiveExecute: env.ENABLE_PHASE6B_LIVE_EXECUTE,
    confirmFinalDemo: env.CONFIRM_FINAL_DEMO,
  });
  assertSecretScanPass({ rootDir: process.cwd() });

  const attemptPath = deps.attemptPath ?? FINAL_DEMO_LIVE_ATTEMPT_PATH;
  const existing = loadFinalDemoAttempt(attemptPath);
  if (
    existing &&
    (existing.status === "COMPLETED" ||
      existing.status === "AMBIGUOUS" ||
      existing.status === "TOPIC_CREATE_AMBIGUOUS" ||
      existing.status === "FAILED" ||
      existing.topicCreateClaim.status === "AMBIGUOUS")
  ) {
    assertSafeToStartFinalDemoLive(existing);
  }

  let materialsLoaded = false;
  try {
    loadFinalDemoAuthoritativeMaterials(deps.materialsPath);
    materialsLoaded = true;
  } catch {
    materialsLoaded = false;
  }

  return { attemptPath, materialsLoaded, existing };
}

/**
 * Live entry — always enforces all guards. Wire real transports via
 * useProductionTransports or inject production-shaped adapters.
 */
export async function runFinalDemoLiveExecution(
  deps: FinalDemoLiveDeps = {},
): Promise<FinalDemoOrchestrationResult> {
  rejectSkipBypasses(deps);
  const env = deps.env ?? process.env;

  assertFinalDemoLiveAuthorized({
    enableFinalDemoLive: env.ENABLE_FINAL_DEMO_LIVE,
    enableLiveHedera: env.ENABLE_LIVE_HEDERA,
    enableLiveUsdcPayments: env.ENABLE_LIVE_USDC_PAYMENTS,
    enableLiveHcsWrites: env.ENABLE_LIVE_HCS_WRITES,
    enableLiveTopicCreate: env.ENABLE_LIVE_TOPIC_CREATE,
    enablePhase6bLiveExecute: env.ENABLE_PHASE6B_LIVE_EXECUTE,
    confirmFinalDemo: env.CONFIRM_FINAL_DEMO,
  });

  let topicTransport = deps.topicTransport;
  let hcsTransport = deps.hcsTransport;
  let topicMirrorReader = deps.topicMirrorReader;
  let paymentPayloadFactory = deps.paymentPayloadFactory;
  let facilitatorTransport = deps.facilitatorTransport;
  let paymentMirrorTransport = deps.paymentMirrorTransport;
  let webhookTransport = deps.webhookTransport;
  let clock = deps.clock;
  let hcsIdentityPreflight = deps.hcsIdentityPreflight;

  if (deps.useProductionTransports) {
    const built = await buildProductionLiveTransports(env);
    topicTransport = built.topicTransport;
    hcsTransport = built.hcsTransport;
    topicMirrorReader = built.topicMirrorReader;
    paymentPayloadFactory = built.paymentPayloadFactory;
    facilitatorTransport = built.facilitatorTransport;
    paymentMirrorTransport = built.paymentMirrorTransport;
    webhookTransport = built.webhookTransport;
    clock = built.clock;
    hcsIdentityPreflight = built.hcsIdentityPreflight;
  }

  if (
    !topicTransport ||
    !hcsTransport ||
    !topicMirrorReader ||
    !paymentPayloadFactory ||
    !facilitatorTransport ||
    !paymentMirrorTransport ||
    !webhookTransport ||
    !clock ||
    !hcsIdentityPreflight
  ) {
    throw new FinalDemoError(
      "Live final-demo requires all production transports and the HCS identity/funding preflight.",
      "LIVE_TRANSPORTS_REQUIRED",
    );
  }

  // Always run readiness — no skip. F-002 facilitator preflight runs before
  // anything irreversible; the orchestrator re-runs it via `readiness` too.
  assertSecretScanPass({ rootDir: process.cwd() });
  await checkFacilitatorPreflight({
    ...(env.FACILITATOR_URL ? { facilitatorUrl: env.FACILITATOR_URL } : {}),
  });
  const usdc = await checkFinalDemoUsdcReadiness();
  assertUsdcReadinessPass(usdc);

  return runFinalDemoOrchestration({
    mode: FINAL_DEMO_MODE_LIVE,
    env,
    clock,
    ...(deps.workDir !== undefined ? { workDir: deps.workDir } : {}),
    ...(deps.attemptPath !== undefined ? { attemptPath: deps.attemptPath } : {}),
    ...(deps.materialsPath !== undefined
      ? { materialsPath: deps.materialsPath }
      : {}),
    ...(deps.resultJsonPath !== undefined
      ? { resultJsonPath: deps.resultJsonPath }
      : {}),
    ...(deps.resultMdPath !== undefined
      ? { resultMdPath: deps.resultMdPath }
      : {}),
    ...(deps.reservationStoreDir !== undefined
      ? { reservationStoreDir: deps.reservationStoreDir }
      : {}),
    topicTransport,
    hcsTransport,
    topicMirrorReader,
    paymentPayloadFactory,
    facilitatorTransport,
    paymentMirrorTransport,
    webhookTransport,
    ...(deps.webhookSigningPrivateKey !== undefined
      ? { webhookSigningPrivateKey: deps.webhookSigningPrivateKey }
      : {}),
    readiness: {
      secretScan: () => assertSecretScanPass({ rootDir: process.cwd() }),
      facilitatorPreflight: async () => {
        await checkFacilitatorPreflight({
          ...(env.FACILITATOR_URL ? { facilitatorUrl: env.FACILITATOR_URL } : {}),
        });
      },
      accountCheck: hcsIdentityPreflight,
      usdcReadiness: async () => {
        const r = await checkFinalDemoUsdcReadiness();
        assertUsdcReadinessPass(r);
        return r;
      },
    },
  });
}

/**
 * Build real Hedera / x402 / Mirror transports for production live CLI.
 */
export async function buildProductionLiveTransports(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  topicTransport: FinalDemoTopicTransport;
  hcsTransport: FinalDemoHcsTransport;
  topicMirrorReader: FinalDemoTopicMirrorReader;
  paymentPayloadFactory: PaymentPayloadFactory;
  facilitatorTransport: SessionFacilitatorTransport;
  paymentMirrorTransport: MirrorConfirmationTransport;
  webhookTransport: WebhookDeliveryTransport;
  hcsIdentityPreflight: () => Promise<AccountCheckResult>;
  clock: FinalDemoClock;
}> {
  const operatorAccount =
    env.SHIPPER_ACCOUNT_ID?.trim() || env.HEDERA_OPERATOR_ID?.trim();
  const operatorKey =
    env.SHIPPER_PRIVATE_KEY?.trim() || env.HEDERA_OPERATOR_KEY?.trim();
  if (!operatorAccount || !operatorKey) {
    throw new FinalDemoError(
      "SHIPPER_ACCOUNT_ID and SHIPPER_PRIVATE_KEY required for live final demo",
      "OPERATOR_REQUIRED",
    );
  }
  if (operatorAccount !== FINAL_DEMO_PAYER_ACCOUNT) {
    throw new FinalDemoError(
      "Live operator must be payer account 0.0.9197513",
      "WRONG_PAYER",
    );
  }

  const carrierAlphaAccount = env.FINAL_DEMO_CARRIER_ALPHA_ACCOUNT_ID?.trim();
  const carrierAlphaKey = env.FINAL_DEMO_CARRIER_ALPHA_PRIVATE_KEY?.trim();
  const carrierBetaAccount = env.FINAL_DEMO_CARRIER_BETA_ACCOUNT_ID?.trim();
  const carrierBetaKey = env.FINAL_DEMO_CARRIER_BETA_PRIVATE_KEY?.trim();
  if (
    !carrierAlphaAccount ||
    !carrierAlphaKey ||
    !carrierBetaAccount ||
    !carrierBetaKey
  ) {
    throw new FinalDemoError(
      "Final-demo carrier alpha/beta account IDs and private keys are required for direct HCS submission",
      "CARRIER_IDENTITIES_REQUIRED",
    );
  }
  if (carrierAlphaAccount !== FINAL_DEMO_WINNER_ACCOUNT) {
    throw new FinalDemoError(
      "Carrier alpha account must match the configured final-demo winner account",
      "CARRIER_ALPHA_ACCOUNT_MISMATCH",
    );
  }
  if (carrierBetaAccount !== FINAL_DEMO_CARRIER_BETA_ACCOUNT) {
    throw new FinalDemoError(
      "Carrier beta account must match the configured final-demo beta account",
      "CARRIER_BETA_ACCOUNT_MISMATCH",
    );
  }

  const {
    AccountId,
    Client,
    Hbar,
    PrivateKey,
    Status,
    TopicId,
    TopicMessageSubmitTransaction,
  } = await import("@hiero-ledger/sdk");
  const { MirrorNodeClient } = await import("../hcs/mirror-node-client");
  const {
    LiveFacilitatorAdapter,
    LiveMirrorTransactionAdapter,
    LocalDemoWebhookTransport: WebhookLocal,
  } = await import("../reservation/live/adapters");
  const { createLivePayerPaymentPayloadFactory } = await import(
    "../reservation/live/payer-payload"
  );
  const { envelopeHash, serializeEnvelopeForSubmit } = await import(
    "../hcs/message-envelope"
  );

  let privateKey: InstanceType<typeof PrivateKey>;
  let carrierAlphaPrivateKey: InstanceType<typeof PrivateKey>;
  let carrierBetaPrivateKey: InstanceType<typeof PrivateKey>;
  try {
    privateKey = PrivateKey.fromStringECDSA(operatorKey);
    carrierAlphaPrivateKey = PrivateKey.fromStringECDSA(carrierAlphaKey);
    carrierBetaPrivateKey = PrivateKey.fromStringECDSA(carrierBetaKey);
  } catch {
    throw new FinalDemoError(
      "Failed to parse one or more final-demo ECDSA identity keys",
      "HCS_IDENTITY_KEY_INVALID",
    );
  }
  const accountId = AccountId.fromString(operatorAccount);
  const client = Client.forTestnet();
  client.setOperator(accountId, privateKey);
  const carrierAlphaAccountId = AccountId.fromString(carrierAlphaAccount);
  const carrierAlphaClient = Client.forTestnet();
  carrierAlphaClient.setOperator(carrierAlphaAccountId, carrierAlphaPrivateKey);
  const carrierBetaAccountId = AccountId.fromString(carrierBetaAccount);
  const carrierBetaClient = Client.forTestnet();
  carrierBetaClient.setOperator(carrierBetaAccountId, carrierBetaPrivateKey);

  const identities: FinalDemoHcsIdentity[] = [
    {
      role: "ROUTEGUARD_OPERATOR",
      accountId: operatorAccount,
      publicKeyHex: privateKey.publicKey.toStringRaw().toLowerCase(),
    },
    {
      role: "CARRIER_ALPHA",
      accountId: carrierAlphaAccount,
      publicKeyHex: carrierAlphaPrivateKey.publicKey.toStringRaw().toLowerCase(),
    },
    {
      role: "CARRIER_BETA",
      accountId: carrierBetaAccount,
      publicKeyHex: carrierBetaPrivateKey.publicKey.toStringRaw().toLowerCase(),
    },
  ];
  const hcsIdentityPreflight = async (): Promise<AccountCheckResult> =>
    checkFinalDemoHcsIdentityReadiness({ identities });

  const submitterContexts = {
    ROUTEGUARD_OPERATOR: { accountId: operatorAccount, client },
    CARRIER_ALPHA: {
      accountId: carrierAlphaAccount,
      client: carrierAlphaClient,
    },
    CARRIER_BETA: {
      accountId: carrierBetaAccount,
      client: carrierBetaClient,
    },
  } as const;

  let createCount = 0;
  let submitCount = 0;
  let boundTopicId: string | null = null;
  const mirror = new MirrorNodeClient();

  const topicTransport: FinalDemoTopicTransport = {
    async createTopic(memo: string) {
      createCount += 1;
      if (createCount > 1) {
        throw new FinalDemoError(
          "Topic create budget exhausted",
          "TOPIC_CREATE_BUDGET",
        );
      }
      const tx = buildFinalDemoTopicCreateTransaction(memo);
      const response = await tx.execute(client);
      const receipt = await response.getReceipt(client);
      if (receipt.status !== Status.Success) {
        throw new FinalDemoError(
          `TopicCreateTransaction failed: ${receipt.status.toString()}`,
          "TOPIC_CREATE_FAILED",
        );
      }
      const topicId = receipt.topicId?.toString();
      if (!topicId) {
        throw new FinalDemoError(
          "TopicCreateTransaction SUCCESS but topicId missing",
          "TOPIC_CREATE_FAILED",
        );
      }
      if (topicId === HISTORICAL_PHASE5_TOPIC_ID) {
        throw new FinalDemoError(
          "Historical topic forbidden",
          "HISTORICAL_TOPIC_FORBIDDEN",
        );
      }
      boundTopicId = topicId;
      return {
        topicId,
        transactionId: response.transactionId.toString(),
        topicMemo: memo,
        createdAt: new Date().toISOString(),
        receiptStatus: receipt.status.toString(),
      };
    },
    getCreateCount: () => createCount,
  };

  const hcsTransport: FinalDemoHcsTransport = {
    async submitMessage(input) {
      const submitter = selectAuthorizedHcsSubmitter(submitterContexts, input);
      submitCount += 1;
      if (submitCount > 5) {
        throw new FinalDemoError(
          "HCS submit budget exhausted",
          "HCS_BUDGET_EXHAUSTED",
        );
      }
      if (boundTopicId && input.topicId !== boundTopicId) {
        throw new FinalDemoError("Topic mismatch on submit", "WRONG_TOPIC");
      }
      const hash = envelopeHash(input.envelope);
      const body = serializeEnvelopeForSubmit(input.envelope);
      if (body.byteLength !== input.exactBytes.byteLength) {
        throw new FinalDemoError(
          "exactBytes mismatch",
          "ENVELOPE_BYTES_MISMATCH",
        );
      }
      const tx = new TopicMessageSubmitTransaction()
        .setTopicId(TopicId.fromString(input.topicId))
        .setMessage(input.exactBytes)
        .setMaxTransactionFee(new Hbar(5));
      const response = await tx.execute(submitter.client);
      const receipt = await response.getReceipt(submitter.client);
      if (receipt.status !== Status.Success) {
        throw new FinalDemoError(
          `TopicMessageSubmitTransaction failed: ${receipt.status.toString()}`,
          "HCS_SUBMIT_FAILED",
        );
      }
      const observed = await mirror.waitForEnvelopeHash(input.topicId, hash, {
        timeoutMs: 90_000,
        pollIntervalMs: 1_500,
      });
      return {
        topicId: observed.topicId,
        sequence: observed.sequence,
        transactionId: response.transactionId.toString(),
        consensusTimestamp: observed.consensusTimestamp,
        envelopeHash: hash,
        receiptStatus: receipt.status.toString(),
      };
    },
    getSubmitCount: () => submitCount,
  };

  const topicMirrorReader: FinalDemoTopicMirrorReader = {
    listMessages: async (topicId) => {
      const raw = await mirror.fetchAllTopicMessages(topicId);
      return mirror.decodeAll(topicId, raw);
    },
    waitForEnvelopeHash: async (topicId, hash, options) =>
      mirror.waitForEnvelopeHash(topicId, hash, {
        timeoutMs: options?.timeoutMs ?? 90_000,
        pollIntervalMs: options?.pollIntervalMs ?? 1_500,
      }),
  };

  const facilitator = new LiveFacilitatorAdapter({
    facilitatorUrl:
      env.FACILITATOR_URL?.trim() || "https://api.testnet.blocky402.com",
    allowNetwork: true,
  }) as SessionFacilitatorTransport;

  const phase6bFactory = createLivePayerPaymentPayloadFactory({ env });
  // Capture actual reservation binding when factory is invoked from orchestrator.
  // The PaymentPayloadFactory interface already receives selected+challenge;
  // we bind reservationId/offerHash from selected when ReservationService
  // has populated them — no placeholders.
  const paymentPayloadFactory: PaymentPayloadFactory = async (input) => {
    if (!input.selected.payerAccount || !input.challenge.resource) {
      throw new FinalDemoError(
        "Payer factory requires durable selected option and challenge",
        "PAYER_CONTEXT_INCOMPLETE",
      );
    }
    // Extract reservationId from resource path when present
    const resource = input.challenge.resource;
    const reservationIdMatch = /reservations\/([^/]+)/.exec(resource);
    const reservationId =
      reservationIdMatch?.[1] ??
      // selected may carry reservationId on production SelectedPaymentOption
      (input.selected as { reservationId?: string }).reservationId;
    if (!reservationId) {
      throw new FinalDemoError(
        "Cannot derive reservationId for payment payload",
        "PAYER_CONTEXT_INCOMPLETE",
      );
    }
    const offerHash =
      (input.selected as { offerHash?: string }).offerHash ?? "";
    const offerVersion =
      (input.selected as { offerVersion?: number }).offerVersion ?? 1;
    if (!offerHash || /^sha256:0+$/.test(offerHash.replace(/sha256:/, ""))) {
      throw new FinalDemoError(
        "offerHash must be the durable selected offer hash (no placeholders)",
        "PAYER_PLACEHOLDER_FORBIDDEN",
      );
    }
    return phase6bFactory({
      selected: {
        reservationId,
        optionId: "USDC",
        scheme: "exact",
        network: "hedera:testnet",
        asset: input.selected.asset,
        amountAtomic: input.selected.amountAtomic,
        payTo: input.selected.payTo,
        payerAccount: input.selected.payerAccount,
        offerHash,
        offerVersion,
        selectedAt:
          (input.selected as { selectedAt?: string }).selectedAt ??
          new Date().toISOString(),
        resourcePath: resource,
      },
      challenge: input.challenge,
    });
  };

  const clock: FinalDemoClock = {
    nowMs: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };

  return {
    topicTransport,
    hcsTransport,
    topicMirrorReader,
    paymentPayloadFactory,
    facilitatorTransport: facilitator,
    paymentMirrorTransport: new LiveMirrorTransactionAdapter(),
    webhookTransport: new WebhookLocal(),
    hcsIdentityPreflight,
    clock,
  };
}

export function rejectHistoricalTopic(topicId: string): void {
  if (topicId === HISTORICAL_PHASE5_TOPIC_ID) {
    throw new FinalDemoError(
      "Historical Phase 5 topic 0.0.9587459 cannot be used for final demo",
      "HISTORICAL_TOPIC_FORBIDDEN",
    );
  }
}

export function rejectDirectSettlement(): void {
  throw new FinalDemoError(
    "Final-demo script must not call facilitator.settle directly — ReservationService is sole settle authority",
    "DIRECT_SETTLE_FORBIDDEN",
  );
}

export function assertPaymentPayloadNotPersisted(record: unknown): void {
  const text = JSON.stringify(record);
  if (
    text.includes("PAYMENT-SIGNATURE") ||
    text.includes("signedPaymentPayload") ||
    /"paymentPayload"\s*:/.test(text)
  ) {
    throw new FinalDemoError(
      "Payment payload/signature must not be persisted",
      "PAYMENT_PAYLOAD_PERSISTED",
    );
  }
}

export type FinalDemoPayerPaymentPayloadFactory = (input: {
  challenge: {
    x402Version: number;
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    resource: string;
    maxTimeoutSeconds: number;
  };
}) => Promise<{
  paymentPayload: PaymentPayload;
  requirement: PaymentRequirements;
  paymentPayloadHash: string;
}>;

void FINAL_DEMO_MODE_LIVE;
