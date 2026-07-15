import { decodePaymentRequiredHeader } from "@x402/core/http";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { VerifyError } from "@x402/core/types";

import { displayAmountToSmallestUnits } from "./usdc-amount";
import {
  DEFAULT_USDC_SMOKE_AMOUNT_DISPLAY,
  DEFAULT_USDC_SMOKE_URL,
  USDC_SMOKE_APPROVED_FACILITATOR,
  USDC_SMOKE_APPROVED_PAYER,
  USDC_SMOKE_APPROVED_RECEIVER,
  USDC_SMOKE_KNOWN_FEE_PAYER,
  USDC_SMOKE_MAX_TIMEOUT_SECONDS,
  USDC_SMOKE_NETWORK,
  USDC_SMOKE_SCHEME,
  USDC_SMOKE_X402_VERSION,
  VERIFIED_USDC_DECIMALS,
  VERIFIED_USDC_TOKEN_ID,
} from "./usdc-constants";

type FetchImplementation = typeof globalThis.fetch;

export type UsdcSmokeLogger = Pick<Console, "log">;

export type ValidatedUsdcSmokeChallenge = {
  paymentRequired: PaymentRequired;
  requirement: PaymentRequirements;
  response: Response;
  fetchedAt: string;
  expectedFeePayer: string;
};

export type UsdcSmokeClientResult =
  | {
      mode: "challenge-only";
      paymentRequired: PaymentRequired;
      requirement: PaymentRequirements;
    }
  | {
      mode: "paid";
      status: number;
      transactionId: string;
      paymentRequired: PaymentRequired;
      requirement: PaymentRequirements;
    };

export type RunUsdcSmokeClientOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImplementation?: FetchImplementation;
  logger?: UsdcSmokeLogger;
  /**
   * Optional pre-resolved fee payer. When omitted, the client fetches the
   * live Blocky402 /supported fee payer before private-key access.
   */
  expectedFeePayer?: string;
};

export type UsdcSmokeVerificationResult = {
  isValid: VerifyResponse["isValid"];
  invalidReason: VerifyResponse["invalidReason"];
  invalidMessage: VerifyResponse["invalidMessage"];
  payer: VerifyResponse["payer"];
};

export type UsdcSmokeExpectedAmounts = {
  tokenId: string;
  decimals: number;
  displayAmount: string;
  smallestUnits: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

export function requireEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

/**
 * Live USDC settlement requires both the global Hedera live switch and the
 * USDC-specific live switch.
 */
export function canSignUsdcPayment(
  liveHederaEnabled: boolean,
  liveUsdcPaymentsEnabled: boolean,
): boolean {
  return liveHederaEnabled && liveUsdcPaymentsEnabled;
}

export function resolveUsdcSmokeExpectedAmounts(
  env: NodeJS.ProcessEnv = {},
): UsdcSmokeExpectedAmounts {
  const tokenId = env.USDC_TOKEN_ID?.trim() || VERIFIED_USDC_TOKEN_ID;
  const decimals = VERIFIED_USDC_DECIMALS;
  const displayAmount =
    env.USDC_SMOKE_AMOUNT_DISPLAY?.trim() ||
    DEFAULT_USDC_SMOKE_AMOUNT_DISPLAY;
  const smallestUnits = displayAmountToSmallestUnits(
    displayAmount,
    decimals,
  );

  return {
    tokenId,
    decimals,
    displayAmount,
    smallestUnits,
  };
}

export function validateUsdcSmokeSettlement(
  settlement: SettleResponse,
  expectedPayer: string,
  expectedAmountSmallestUnits: string,
): SettleResponse {
  if (!settlement.success) {
    throw new Error("Facilitator reported unsuccessful USDC settlement.");
  }

  if (settlement.network !== USDC_SMOKE_NETWORK) {
    throw new Error("Facilitator returned an unexpected settlement network.");
  }

  if (settlement.payer !== expectedPayer) {
    throw new Error("Facilitator returned an unexpected settlement payer.");
  }

  if (
    typeof settlement.transaction !== "string" ||
    !settlement.transaction.trim()
  ) {
    throw new Error("Facilitator settlement is missing a transaction ID.");
  }

  if (
    settlement.amount !== undefined &&
    settlement.amount !== expectedAmountSmallestUnits
  ) {
    throw new Error("Facilitator returned an unexpected settlement amount.");
  }

  return settlement;
}

export function describeUsdcSmokeSettlementFailure(
  settlement: SettleResponse,
): string {
  return `${settlement.errorReason ?? "unknown_reason"}: ${settlement.errorMessage ?? "no message"}`;
}

// Process-level guard: exactly one USDC settlement attempt per process.
// Isolated from the HBAR settlement guard.
let usdcSettlementGuardClaimed = false;

export function claimUsdcSettlementAttempt(): void {
  if (usdcSettlementGuardClaimed) {
    throw new Error(
      "USDC settlement guard already claimed. Only one payment attempt is allowed per process.",
    );
  }
  usdcSettlementGuardClaimed = true;
}

export function isUsdcSettlementGuardClaimed(): boolean {
  return usdcSettlementGuardClaimed;
}

export function resetUsdcSettlementGuardForTests(): void {
  usdcSettlementGuardClaimed = false;
}

/**
 * Fetch the live Blocky402 Hedera fee payer from /supported.
 * Falls back is not applied — missing/invalid responses fail closed.
 */
export async function fetchLiveFacilitatorFeePayer(
  facilitatorUrl: string,
  fetchImplementation: FetchImplementation = globalThis.fetch,
): Promise<string> {
  const baseUrl = facilitatorUrl.endsWith("/")
    ? facilitatorUrl
    : `${facilitatorUrl}/`;
  const supportedUrl = new URL("supported", baseUrl);

  let response: Response;

  try {
    response = await fetchImplementation(supportedUrl, {
      headers: {
        accept: "application/json",
      },
    });
  } catch {
    throw new Error("Unable to fetch facilitator /supported for fee payer.");
  }

  if (!response.ok) {
    throw new Error(
      `Facilitator /supported returned HTTP ${response.status}.`,
    );
  }

  const payload: unknown = await response.json();

  if (!isRecord(payload) || !Array.isArray(payload.kinds)) {
    throw new Error("Invalid facilitator /supported response structure.");
  }

  const hederaKind = payload.kinds.find((kind) => {
    return (
      isRecord(kind) &&
      kind.x402Version === USDC_SMOKE_X402_VERSION &&
      kind.scheme === USDC_SMOKE_SCHEME &&
      kind.network === USDC_SMOKE_NETWORK
    );
  });

  if (
    !isRecord(hederaKind) ||
    !isRecord(hederaKind.extra) ||
    typeof hederaKind.extra.feePayer !== "string" ||
    !hederaKind.extra.feePayer.trim()
  ) {
    throw new Error(
      "Blocky402 does not advertise a Hedera testnet fee payer.",
    );
  }

  return hederaKind.extra.feePayer.trim();
}

function validateSingleUsdcRequirement(
  requirement: unknown,
  expectedReceiver: string,
  expectedAsset: string,
  expectedAmountSmallestUnits: string,
  expectedFeePayer: string,
): PaymentRequirements {
  if (!isRecord(requirement)) {
    throw new Error("Invalid payment requirement entry.");
  }

  if (requirement.scheme !== USDC_SMOKE_SCHEME) {
    throw new Error("Unexpected scheme in payment requirement.");
  }

  if (requirement.network !== USDC_SMOKE_NETWORK) {
    throw new Error("Unexpected network in payment requirement.");
  }

  if (requirement.asset !== expectedAsset) {
    throw new Error("Unexpected asset in payment requirement.");
  }

  if (requirement.amount !== expectedAmountSmallestUnits) {
    throw new Error("Unexpected amount in payment requirement.");
  }

  if (requirement.payTo !== expectedReceiver) {
    throw new Error("Unexpected payTo recipient in payment requirement.");
  }

  if (requirement.maxTimeoutSeconds !== USDC_SMOKE_MAX_TIMEOUT_SECONDS) {
    throw new Error(
      `Unexpected maxTimeoutSeconds in payment requirement. Got ${requirement.maxTimeoutSeconds}`,
    );
  }

  if (
    !isRecord(requirement.extra) ||
    typeof requirement.extra.feePayer !== "string" ||
    !requirement.extra.feePayer.trim()
  ) {
    throw new Error("Missing Hedera fee payer in payment requirement.");
  }

  if (requirement.extra.feePayer !== expectedFeePayer) {
    throw new Error("Unexpected feePayer in payment requirement.");
  }

  return requirement as unknown as PaymentRequirements;
}

export function validateUsdcSmokePaymentRequirements(
  paymentRequired: unknown,
  expectedReceiver: string,
  expectedAsset: string,
  expectedAmountSmallestUnits: string,
  expectedFeePayer: string,
): {
  paymentRequired: PaymentRequired;
  requirement: PaymentRequirements;
} {
  if (!isRecord(paymentRequired)) {
    throw new Error("Invalid decoded payment requirement.");
  }

  if (paymentRequired.x402Version !== USDC_SMOKE_X402_VERSION) {
    throw new Error("Unexpected x402Version in payment requirement.");
  }

  if (!("accepts" in paymentRequired)) {
    throw new Error("Missing accepts array in payment requirement.");
  }

  if (!Array.isArray(paymentRequired.accepts)) {
    throw new Error("Invalid accepts array in payment requirement.");
  }

  if (paymentRequired.accepts.length !== 1) {
    throw new Error(
      `Expected exactly one payment requirement, got ${paymentRequired.accepts.length}.`,
    );
  }

  const requirement = validateSingleUsdcRequirement(
    paymentRequired.accepts[0],
    expectedReceiver,
    expectedAsset,
    expectedAmountSmallestUnits,
    expectedFeePayer,
  );

  return {
    paymentRequired: paymentRequired as unknown as PaymentRequired,
    requirement,
  };
}

export async function fetchAndValidateUsdcSmokeChallenge(
  smokeUrl: string,
  expectedReceiver: string,
  expectedAsset: string,
  expectedAmountSmallestUnits: string,
  expectedFeePayer: string,
  fetchImplementation: FetchImplementation = globalThis.fetch,
): Promise<ValidatedUsdcSmokeChallenge> {
  let response: Response;

  try {
    response = await fetchImplementation(smokeUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
      },
    });
  } catch {
    throw new Error("Unable to fetch the USDC smoke payment challenge.");
  }

  if (response.status !== 402) {
    throw new Error(
      `Expected 402 Payment Required, got HTTP ${response.status}.`,
    );
  }

  const paymentRequiredHeader = response.headers.get("PAYMENT-REQUIRED");

  if (!paymentRequiredHeader) {
    throw new Error("Missing PAYMENT-REQUIRED header in 402 response.");
  }

  let decodedPaymentRequired: unknown;

  try {
    decodedPaymentRequired = decodePaymentRequiredHeader(
      paymentRequiredHeader,
    );
  } catch {
    throw new Error("Malformed PAYMENT-REQUIRED header.");
  }

  const validated = validateUsdcSmokePaymentRequirements(
    decodedPaymentRequired,
    expectedReceiver,
    expectedAsset,
    expectedAmountSmallestUnits,
    expectedFeePayer,
  );

  return {
    ...validated,
    response,
    fetchedAt: new Date().toISOString(),
    expectedFeePayer,
  };
}

function createValidatedChallengeFetch(
  smokeUrl: string,
  challengeResponse: Response,
  fetchImplementation: FetchImplementation,
  onPaymentRetry?: () => void,
): FetchImplementation {
  const expectedUrl = new URL(smokeUrl).href;
  let challengeServed = false;

  return async (input, init) => {
    const request = new Request(input, init);

    if (!challengeServed) {
      challengeServed = true;

      if (
        request.url !== expectedUrl ||
        request.method !== "GET" ||
        request.headers.has("PAYMENT-SIGNATURE") ||
        request.headers.has("X-PAYMENT")
      ) {
        throw new Error("Payment retry did not preserve the validated request.");
      }

      return challengeResponse;
    }

    onPaymentRetry?.();
    return fetchImplementation(request);
  };
}

function assertRequirementUnchanged(
  selected: PaymentRequirements,
  validated: PaymentRequirements,
): void {
  if (
    selected.scheme !== validated.scheme ||
    selected.network !== validated.network ||
    selected.asset !== validated.asset ||
    selected.amount !== validated.amount ||
    selected.payTo !== validated.payTo ||
    selected.maxTimeoutSeconds !== validated.maxTimeoutSeconds ||
    selected.extra?.feePayer !== validated.extra?.feePayer
  ) {
    throw new Error(
      "Payment creation did not preserve the validated requirement.",
    );
  }
}

/**
 * Live USDC payment path. Fully implemented but not executed in this milestone
 * (requires ENABLE_LIVE_HEDERA=true and ENABLE_LIVE_USDC_PAYMENTS=true).
 */
async function executeLiveUsdcPayment(
  smokeUrl: string,
  expectedReceiver: string,
  expectedAmountSmallestUnits: string,
  challenge: ValidatedUsdcSmokeChallenge,
  env: NodeJS.ProcessEnv,
  fetchImplementation: FetchImplementation,
): Promise<{
  response: Response;
  settlement: SettleResponse;
}> {
  const { client, payer } = await createUsdcPaymentClient(
    expectedReceiver,
    env,
  );
  const facilitatorUrl = requireApprovedFacilitatorUrl(env);
  const coreClientModule = await import("@x402/core/client");
  const fetchModule = await import("@x402/fetch");
  let preverification: UsdcSmokeVerificationResult | undefined;
  let paymentStage = "before-payload-creation";

  const clientFrozenTxIdHolder: { value?: string } = {};
  const timing = {
    challengeFetch: challenge.fetchedAt,
    payloadCreation: undefined as string | undefined,
    signedRetry: undefined as string | undefined,
    facilitatorResponse: undefined as string | undefined,
  };

  client.onAfterPaymentCreation(async (context) => {
    paymentStage = "payload-created";
    timing.payloadCreation = new Date().toISOString();
    assertRequirementUnchanged(
      context.selectedRequirements,
      challenge.requirement,
    );

    try {
      const hederaMod = await import("@x402/hedera");
      const txBase64 =
        (context.paymentPayload as { payload?: { transaction?: string } })
          ?.payload?.transaction ??
        (context.paymentPayload as { transaction?: string })?.transaction;
      if (typeof txBase64 === "string" && txBase64.length > 0) {
        const inspected = hederaMod.inspectHederaTransaction(txBase64);
        if (inspected && typeof inspected.transactionId === "string") {
          clientFrozenTxIdHolder.value = inspected.transactionId;
          console.log(`CLIENT_FROZEN_TX_ID: ${inspected.transactionId}`);
        }
      }
    } catch {
      // non-fatal for observability
    }

    preverification = await verifyUsdcPaymentPayload(
      context.paymentPayload,
      challenge.requirement,
      facilitatorUrl,
    );
    paymentStage = "payload-preverified";

    if (!preverification.isValid) {
      throw new Error("Facilitator rejected the signed USDC payload.");
    }
  });

  const validatedChallengeFetch = createValidatedChallengeFetch(
    smokeUrl,
    challenge.response,
    fetchImplementation,
    () => {
      paymentStage = "signed-retry-sent";
      timing.signedRetry = new Date().toISOString();
    },
  );

  claimUsdcSettlementAttempt();

  const fetchWithPayment = fetchModule.wrapFetchWithPayment(
    validatedChallengeFetch,
    client,
  );

  let paidResponse: Response;

  try {
    paidResponse = await fetchWithPayment(smokeUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
      },
    });
  } catch {
    timing.facilitatorResponse = new Date().toISOString();
    if (preverification && !preverification.isValid) {
      throw new Error(
        `Facilitator verification rejected the signed USDC payload: ${preverification.invalidReason ?? "unknown_reason"}: ${preverification.invalidMessage ?? "no message"}.`,
      );
    }

    throw new Error(
      `Live USDC x402 payment attempt failed at stage: ${paymentStage}.`,
    );
  }

  timing.facilitatorResponse = new Date().toISOString();

  console.log(
    `TIMING challengeFetch=${timing.challengeFetch} payloadCreation=${timing.payloadCreation} signedRetry=${timing.signedRetry} facilitatorResponse=${timing.facilitatorResponse}`,
  );

  if (!preverification?.isValid) {
    throw new Error(
      "Live USDC payment retry was blocked because preverification did not complete.",
    );
  }

  const httpClient = new coreClientModule.x402HTTPClient(client);
  let settlement: SettleResponse | undefined;

  try {
    settlement = httpClient.getPaymentSettleResponse((name) =>
      paidResponse.headers.get(name),
    );
  } catch {
    settlement = undefined;
  }

  if (paidResponse.status !== 200) {
    if (settlement && !settlement.success) {
      throw new Error(
        `Facilitator settlement failed: ${describeUsdcSmokeSettlementFailure(settlement)}.`,
      );
    }

    throw new Error(
      `Live USDC x402 payment retry returned HTTP ${paidResponse.status}.`,
    );
  }

  if (!settlement) {
    throw new Error(
      "Final HTTP 200 response is missing a valid facilitator settlement result.",
    );
  }

  return {
    response: paidResponse,
    settlement: validateUsdcSmokeSettlement(
      settlement,
      payer,
      expectedAmountSmallestUnits,
    ),
  };
}

export async function createUsdcPaymentClient(
  expectedReceiver: string,
  env: NodeJS.ProcessEnv,
) {
  const shipperAccountId = requireEnvironmentValue(
    env,
    "SHIPPER_ACCOUNT_ID",
  );

  if (shipperAccountId !== USDC_SMOKE_APPROVED_PAYER) {
    throw new Error("SHIPPER_ACCOUNT_ID does not match the approved payer.");
  }

  if (expectedReceiver !== USDC_SMOKE_APPROVED_RECEIVER) {
    throw new Error(
      "CARRIER_ACCOUNT_ID does not match the approved receiver.",
    );
  }

  const shipperPrivateKeyText = requireEnvironmentValue(
    env,
    "SHIPPER_PRIVATE_KEY",
  );

  const [coreClientModule, hederaModule, hederaExactModule] =
    await Promise.all([
      import("@x402/core/client"),
      import("@x402/hedera"),
      import("@x402/hedera/exact/client"),
    ]);

  let shipperPrivateKey: ReturnType<
    typeof hederaModule.PrivateKey.fromStringECDSA
  >;

  try {
    shipperPrivateKey = hederaModule.PrivateKey.fromStringECDSA(
      shipperPrivateKeyText,
    );
  } catch {
    throw new Error("Invalid SHIPPER_PRIVATE_KEY.");
  }

  // Exact public key match using the installed @hiero-ledger/sdk path via @x402/hedera.
  // Performed after challenge validation and private key read, before signer construction.
  const derivedPublicKey = shipperPrivateKey.publicKey;
  const derivedHex = derivedPublicKey.toStringRaw().toLowerCase();
  const EXPECTED_PAYER_PUBKEY =
    "02c07aaa7bc004c9c44186395f496639cf46741b6bc8092c024156e5ac68d5fde5";
  if (derivedHex !== EXPECTED_PAYER_PUBKEY) {
    throw new Error(
      "Derived public key does not match the approved ECDSA payer key.",
    );
  }
  console.log("PUBLIC_KEY_MATCH: PASS");

  const signer = hederaModule.createClientHederaSigner(
    shipperAccountId,
    shipperPrivateKey,
    {
      network: USDC_SMOKE_NETWORK,
    },
  );

  const expectedAmounts = resolveUsdcSmokeExpectedAmounts(env);
  const expectedFeePayer =
    env.USDC_EXPECTED_FEE_PAYER?.trim() || USDC_SMOKE_KNOWN_FEE_PAYER;

  const client = new coreClientModule.x402Client(
    (x402Version, requirements) => {
      if (x402Version !== USDC_SMOKE_X402_VERSION) {
        throw new Error("Unexpected x402Version during payment creation.");
      }

      if (requirements.length !== 1) {
        throw new Error(
          `Expected exactly one payment requirement during payment creation, got ${requirements.length}.`,
        );
      }

      return validateSingleUsdcRequirement(
        requirements[0],
        expectedReceiver,
        expectedAmounts.tokenId,
        expectedAmounts.smallestUnits,
        expectedFeePayer,
      );
    },
  ).register(
    USDC_SMOKE_NETWORK,
    new hederaExactModule.ExactHederaScheme(signer),
  );

  return {
    client,
    payer: shipperAccountId,
  };
}

export function requireApprovedFacilitatorUrl(env: NodeJS.ProcessEnv): string {
  const facilitatorUrl = requireEnvironmentValue(
    env,
    "FACILITATOR_URL",
  ).replace(/\/+$/, "");

  if (facilitatorUrl !== USDC_SMOKE_APPROVED_FACILITATOR) {
    throw new Error("FACILITATOR_URL does not match the approved facilitator.");
  }

  return facilitatorUrl;
}

export async function verifyUsdcPaymentPayload(
  paymentPayload: PaymentPayload,
  requirement: PaymentRequirements,
  facilitatorUrl: string,
): Promise<UsdcSmokeVerificationResult> {
  const { HTTPFacilitatorClient } = await import("@x402/core/server");
  const facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl });

  try {
    const response = await facilitator.verify(
      paymentPayload,
      requirement,
    );

    return {
      isValid: response.isValid,
      invalidReason: response.invalidReason,
      invalidMessage: response.invalidMessage,
      payer: response.payer,
    };
  } catch (error: unknown) {
    if (!(error instanceof VerifyError)) {
      throw new Error("Facilitator verification request failed.");
    }

    return {
      isValid: false,
      invalidReason: error.invalidReason,
      invalidMessage: error.invalidMessage,
      payer: error.payer,
    };
  }
}

export async function runUsdcSmokeClient(
  options: RunUsdcSmokeClientOptions = {},
): Promise<UsdcSmokeClientResult> {
  const env = options.env ?? process.env;
  const fetchImplementation =
    options.fetchImplementation ?? globalThis.fetch;
  const logger = options.logger ?? console;
  const expectedReceiver = requireEnvironmentValue(
    env,
    "CARRIER_ACCOUNT_ID",
  );

  if (expectedReceiver !== USDC_SMOKE_APPROVED_RECEIVER) {
    throw new Error(
      "CARRIER_ACCOUNT_ID does not match the approved receiver.",
    );
  }

  const smokeUrl = env.USDC_SMOKE_URL?.trim() || DEFAULT_USDC_SMOKE_URL;
  const liveHederaEnabled = env.ENABLE_LIVE_HEDERA === "true";
  const liveUsdcPaymentsEnabled =
    env.ENABLE_LIVE_USDC_PAYMENTS === "true";
  const expectedAmounts = resolveUsdcSmokeExpectedAmounts(env);

  logger.log("USDC smoke client starting...");
  logger.log(`Requesting payment requirement from: ${smokeUrl}`);
  logger.log(`  expected asset: ${expectedAmounts.tokenId}`);
  logger.log(
    `  expected amount: ${expectedAmounts.smallestUnits} smallest units (${expectedAmounts.displayAmount} USDC, ${expectedAmounts.decimals} decimals)`,
  );

  const facilitatorUrl = (
    env.FACILITATOR_URL?.trim() || USDC_SMOKE_APPROVED_FACILITATOR
  ).replace(/\/+$/, "");

  if (facilitatorUrl !== USDC_SMOKE_APPROVED_FACILITATOR) {
    throw new Error("FACILITATOR_URL does not match the approved facilitator.");
  }

  // Resolve fee payer from live facilitator before any private-key access.
  const expectedFeePayer =
    options.expectedFeePayer ??
    (await fetchLiveFacilitatorFeePayer(facilitatorUrl, fetchImplementation));

  logger.log(`  expected feePayer (live facilitator): ${expectedFeePayer}`);

  const challenge = await fetchAndValidateUsdcSmokeChallenge(
    smokeUrl,
    expectedReceiver,
    expectedAmounts.tokenId,
    expectedAmounts.smallestUnits,
    expectedFeePayer,
    fetchImplementation,
  );

  logger.log("Validated x402 USDC smoke payment requirement successfully.");
  logger.log(`  x402Version: ${challenge.paymentRequired.x402Version}`);
  logger.log(`  network: ${challenge.requirement.network}`);
  logger.log(`  scheme: ${challenge.requirement.scheme}`);
  logger.log(`  asset: ${challenge.requirement.asset}`);
  logger.log(`  payTo: ${challenge.requirement.payTo}`);
  logger.log(
    `  amount: ${challenge.requirement.amount} smallest units`,
  );
  logger.log(
    `  feePayer: ${String(challenge.requirement.extra?.feePayer ?? "")}`,
  );

  if (!canSignUsdcPayment(liveHederaEnabled, liveUsdcPaymentsEnabled)) {
    logger.log(
      "Challenge-only dry run complete: live Hedera and live USDC payments are not both enabled.",
    );
    logger.log(
      "No private key was read; no signer, signed payload, or payment submission was created.",
    );

    return {
      mode: "challenge-only",
      paymentRequired: challenge.paymentRequired,
      requirement: challenge.requirement,
    };
  }

  // Stash fee payer for createUsdcPaymentClient re-validation during live path.
  const liveEnv: NodeJS.ProcessEnv = {
    ...env,
    USDC_EXPECTED_FEE_PAYER: expectedFeePayer,
  };

  const livePayment = await executeLiveUsdcPayment(
    smokeUrl,
    expectedReceiver,
    expectedAmounts.smallestUnits,
    challenge,
    liveEnv,
    fetchImplementation,
  );

  logger.log(
    `Live USDC x402 payment completed with HTTP ${livePayment.response.status}.`,
  );
  logger.log(`Hedera transaction ID: ${livePayment.settlement.transaction}`);

  return {
    mode: "paid",
    status: livePayment.response.status,
    transactionId: livePayment.settlement.transaction,
    paymentRequired: challenge.paymentRequired,
    requirement: challenge.requirement,
  };
}
