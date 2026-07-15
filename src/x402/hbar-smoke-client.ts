import { decodePaymentRequiredHeader } from "@x402/core/http";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { VerifyError } from "@x402/core/types";

export const DEFAULT_HBAR_SMOKE_URL =
  "http://localhost:3000/api/x402/hbar-smoke";
export const HBAR_SMOKE_NETWORK = "hedera:testnet" as const;
export const HBAR_SMOKE_SCHEME = "exact" as const;
export const HBAR_SMOKE_ASSET = "0.0.0" as const;
export const HBAR_SMOKE_AMOUNT_TINYBARS = "1000000" as const;
export const HBAR_SMOKE_X402_VERSION = 2 as const;
export const HBAR_SMOKE_APPROVED_PAYER = "0.0.9197513" as const;
export const HBAR_SMOKE_APPROVED_RECEIVER = "0.0.9215954" as const;
export const HBAR_SMOKE_APPROVED_FACILITATOR =
  "https://api.testnet.blocky402.com" as const;
export const HBAR_SMOKE_APPROVED_FEE_PAYER = "0.0.7162784" as const;

type FetchImplementation = typeof globalThis.fetch;

export type HbarSmokeLogger = Pick<Console, "log">;

export type ValidatedHbarSmokeChallenge = {
  paymentRequired: PaymentRequired;
  requirement: PaymentRequirements;
  response: Response;
  fetchedAt: string;
};

export type HbarSmokeClientResult =
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

export type RunHbarSmokeClientOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImplementation?: FetchImplementation;
  logger?: HbarSmokeLogger;
};

export type HbarSmokeVerificationResult = {
  isValid: VerifyResponse["isValid"];
  invalidReason: VerifyResponse["invalidReason"];
  invalidMessage: VerifyResponse["invalidMessage"];
  payer: VerifyResponse["payer"];
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

export function canSignPayment(
  liveHederaEnabled: boolean,
  liveHbarPaymentsEnabled: boolean,
): boolean {
  return liveHederaEnabled && liveHbarPaymentsEnabled;
}

export function validateHbarSmokeSettlement(
  settlement: SettleResponse,
  expectedPayer: string,
): SettleResponse {
  if (!settlement.success) {
    throw new Error("Facilitator reported unsuccessful HBAR settlement.");
  }

  if (settlement.network !== HBAR_SMOKE_NETWORK) {
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
    settlement.amount !== HBAR_SMOKE_AMOUNT_TINYBARS
  ) {
    throw new Error("Facilitator returned an unexpected settlement amount.");
  }

  return settlement;
}

export function describeHbarSmokeSettlementFailure(
  settlement: SettleResponse,
): string {
  return `${settlement.errorReason ?? "unknown_reason"}: ${settlement.errorMessage ?? "no message"}`;
}

// Process-level guard: exactly one settlement attempt per process via normal wrapped flow.
// Health checks, challenge-only, and verify-only paths must never claim it.
let settlementGuardClaimed = false;

export function claimSettlementAttempt(): void {
  if (settlementGuardClaimed) {
    throw new Error(
      "Settlement guard already claimed. Only one payment attempt is allowed per process.",
    );
  }
  settlementGuardClaimed = true;
}

export function isSettlementGuardClaimed(): boolean {
  return settlementGuardClaimed;
}

export function resetSettlementGuardForTests(): void {
  settlementGuardClaimed = false;
}

function validateSingleHbarRequirement(
  requirement: unknown,
  expectedReceiver: string,
): PaymentRequirements {
  if (!isRecord(requirement)) {
    throw new Error("Invalid payment requirement entry.");
  }

  if (requirement.scheme !== HBAR_SMOKE_SCHEME) {
    throw new Error("Unexpected scheme in payment requirement.");
  }

  if (requirement.network !== HBAR_SMOKE_NETWORK) {
    throw new Error("Unexpected network in payment requirement.");
  }

  if (requirement.asset !== HBAR_SMOKE_ASSET) {
    throw new Error("Unexpected asset in payment requirement.");
  }

  if (requirement.amount !== HBAR_SMOKE_AMOUNT_TINYBARS) {
    throw new Error("Unexpected amount in payment requirement.");
  }

  if (requirement.payTo !== expectedReceiver) {
    throw new Error("Unexpected payTo recipient in payment requirement.");
  }

  if (requirement.maxTimeoutSeconds !== 180) {
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

  if (requirement.extra.feePayer !== HBAR_SMOKE_APPROVED_FEE_PAYER) {
    throw new Error("Unexpected feePayer in payment requirement.");
  }

  return requirement as unknown as PaymentRequirements;
}

export function validateHbarSmokePaymentRequirements(
  paymentRequired: unknown,
  expectedReceiver: string,
): {
  paymentRequired: PaymentRequired;
  requirement: PaymentRequirements;
} {
  if (!isRecord(paymentRequired)) {
    throw new Error("Invalid decoded payment requirement.");
  }

  if (paymentRequired.x402Version !== HBAR_SMOKE_X402_VERSION) {
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

  const requirement = validateSingleHbarRequirement(
    paymentRequired.accepts[0],
    expectedReceiver,
  );

  return {
    paymentRequired: paymentRequired as unknown as PaymentRequired,
    requirement,
  };
}

export async function fetchAndValidateHbarSmokeChallenge(
  smokeUrl: string,
  expectedReceiver: string,
  fetchImplementation: FetchImplementation = globalThis.fetch,
): Promise<ValidatedHbarSmokeChallenge> {
  let response: Response;

  try {
    response = await fetchImplementation(smokeUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
      },
    });
  } catch {
    throw new Error("Unable to fetch the HBAR smoke payment challenge.");
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

  const validated = validateHbarSmokePaymentRequirements(
    decodedPaymentRequired,
    expectedReceiver,
  );

  return {
    ...validated,
    response,
    fetchedAt: new Date().toISOString(),
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

async function executeLiveHbarPayment(
  smokeUrl: string,
  expectedReceiver: string,
  challenge: ValidatedHbarSmokeChallenge,
  env: NodeJS.ProcessEnv,
  fetchImplementation: FetchImplementation,
): Promise<{
  response: Response;
  settlement: SettleResponse;
}> {
  const { client, payer } = await createHbarPaymentClient(
    expectedReceiver,
    env,
  );
  const facilitatorUrl = requireApprovedFacilitatorUrl(env);
  const coreClientModule = await import("@x402/core/client");
  const fetchModule = await import("@x402/fetch");
  let preverification: HbarSmokeVerificationResult | undefined;
  let paymentStage = "before-payload-creation";

  // PHASE 7: transaction ID observability + timestamps
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

    // Capture frozen tx id from the produced payload (set by feePayer before client sign in the scheme)
    // Uses public APIs from @x402/hedera (inspect + extract)
    try {
      const hederaMod = await import("@x402/hedera");
      const txBase64 =
        (context.paymentPayload as any)?.payload?.transaction ??
        (context.paymentPayload as any)?.transaction;
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

    preverification = await verifyPaymentPayload(
      context.paymentPayload,
      challenge.requirement,
      facilitatorUrl,
    );
    paymentStage = "payload-preverified";

    if (!preverification.isValid) {
      throw new Error("Facilitator rejected the signed HBAR payload.");
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

  // PHASE 6: claim the one-attempt guard immediately before initiating the payment-bearing wrapped retry
  claimSettlementAttempt();

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
        `Facilitator verification rejected the signed HBAR payload: ${preverification.invalidReason ?? "unknown_reason"}: ${preverification.invalidMessage ?? "no message"}.`,
      );
    }

    throw new Error(
      `Live HBAR x402 payment attempt failed at stage: ${paymentStage}.`,
    );
  }

  timing.facilitatorResponse = new Date().toISOString();

  // Sanitized timing record (no secrets)
  console.log(
    `TIMING challengeFetch=${timing.challengeFetch} payloadCreation=${timing.payloadCreation} signedRetry=${timing.signedRetry} facilitatorResponse=${timing.facilitatorResponse}`,
  );

  if (!preverification?.isValid) {
    throw new Error(
      "Live HBAR payment retry was blocked because preverification did not complete.",
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
        `Facilitator settlement failed: ${describeHbarSmokeSettlementFailure(settlement)}.`,
      );
    }

    throw new Error(
      `Live HBAR x402 payment retry returned HTTP ${paidResponse.status}.`,
    );
  }

  if (!settlement) {
    throw new Error(
      "Final HTTP 200 response is missing a valid facilitator settlement result.",
    );
  }

  return {
    response: paidResponse,
    settlement: validateHbarSmokeSettlement(settlement, payer),
  };
}

export async function createHbarPaymentClient(
  expectedReceiver: string,
  env: NodeJS.ProcessEnv,
) {
  const shipperAccountId = requireEnvironmentValue(
    env,
    "SHIPPER_ACCOUNT_ID",
  );

  if (shipperAccountId !== HBAR_SMOKE_APPROVED_PAYER) {
    throw new Error("SHIPPER_ACCOUNT_ID does not match the approved payer.");
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

  // PHASE 3: exact public key match using the installed @hiero-ledger/sdk
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
      network: HBAR_SMOKE_NETWORK,
    },
  );

  const client = new coreClientModule.x402Client(
    (x402Version, requirements) => {
      if (x402Version !== HBAR_SMOKE_X402_VERSION) {
        throw new Error("Unexpected x402Version during payment creation.");
      }

      if (requirements.length !== 1) {
        throw new Error(
          `Expected exactly one payment requirement during payment creation, got ${requirements.length}.`,
        );
      }

      return validateSingleHbarRequirement(
        requirements[0],
        expectedReceiver,
      );
    },
  ).register(
    HBAR_SMOKE_NETWORK,
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

  if (facilitatorUrl !== HBAR_SMOKE_APPROVED_FACILITATOR) {
    throw new Error("FACILITATOR_URL does not match the approved facilitator.");
  }

  return facilitatorUrl;
}

export async function verifyPaymentPayload(
  paymentPayload: PaymentPayload,
  requirement: PaymentRequirements,
  facilitatorUrl: string,
): Promise<HbarSmokeVerificationResult> {
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

export async function verifyHbarSmokePayment(
  options: RunHbarSmokeClientOptions = {},
): Promise<HbarSmokeVerificationResult> {
  const env = options.env ?? process.env;
  const fetchImplementation =
    options.fetchImplementation ?? globalThis.fetch;
  const logger = options.logger ?? console;
  const expectedReceiver = requireEnvironmentValue(
    env,
    "CARRIER_ACCOUNT_ID",
  );

  if (expectedReceiver !== HBAR_SMOKE_APPROVED_RECEIVER) {
    throw new Error(
      "CARRIER_ACCOUNT_ID does not match the approved receiver.",
    );
  }

  const facilitatorUrl = requireApprovedFacilitatorUrl(env);

  const smokeUrl = env.HBAR_SMOKE_URL?.trim() || DEFAULT_HBAR_SMOKE_URL;
  const challenge = await fetchAndValidateHbarSmokeChallenge(
    smokeUrl,
    expectedReceiver,
    fetchImplementation,
  );

  if (env.ENABLE_LIVE_HEDERA !== "true") {
    throw new Error("Verification signing requires ENABLE_LIVE_HEDERA=true.");
  }

  if (env.ENABLE_LIVE_HBAR_PAYMENTS === "true") {
    throw new Error(
      "Verification-only mode requires ENABLE_LIVE_HBAR_PAYMENTS=false.",
    );
  }

  const { client } = await createHbarPaymentClient(
    expectedReceiver,
    env,
  );
  const paymentPayload: PaymentPayload =
    await client.createPaymentPayload(challenge.paymentRequired);
  const verification = await verifyPaymentPayload(
    paymentPayload,
    challenge.requirement,
    facilitatorUrl,
  );

  logger.log(`Facilitator verification valid: ${verification.isValid}`);
  logger.log(
    `Facilitator invalidReason: ${verification.invalidReason ?? "none"}`,
  );
  logger.log(
    `Facilitator invalidMessage: ${verification.invalidMessage ?? "none"}`,
  );
  logger.log(`Facilitator payer: ${verification.payer ?? "unknown"}`);
  logger.log("No settlement endpoint was called.");

  return verification;
}

export async function runHbarSmokeClient(
  options: RunHbarSmokeClientOptions = {},
): Promise<HbarSmokeClientResult> {
  const env = options.env ?? process.env;
  const fetchImplementation =
    options.fetchImplementation ?? globalThis.fetch;
  const logger = options.logger ?? console;
  const expectedReceiver = requireEnvironmentValue(
    env,
    "CARRIER_ACCOUNT_ID",
  );

  if (expectedReceiver !== HBAR_SMOKE_APPROVED_RECEIVER) {
    throw new Error(
      "CARRIER_ACCOUNT_ID does not match the approved receiver.",
    );
  }

  const smokeUrl = env.HBAR_SMOKE_URL?.trim() || DEFAULT_HBAR_SMOKE_URL;
  const liveHederaEnabled = env.ENABLE_LIVE_HEDERA === "true";
  const liveHbarPaymentsEnabled =
    env.ENABLE_LIVE_HBAR_PAYMENTS === "true";

  logger.log("HBAR smoke client starting...");
  logger.log(`Requesting payment requirement from: ${smokeUrl}`);

  const challenge = await fetchAndValidateHbarSmokeChallenge(
    smokeUrl,
    expectedReceiver,
    fetchImplementation,
  );

  logger.log("Validated x402 HBAR smoke payment requirement successfully.");
  logger.log(`  x402Version: ${challenge.paymentRequired.x402Version}`);
  logger.log(`  network: ${challenge.requirement.network}`);
  logger.log(`  scheme: ${challenge.requirement.scheme}`);
  logger.log(`  asset: ${challenge.requirement.asset}`);
  logger.log(`  payTo: ${challenge.requirement.payTo}`);
  logger.log(`  amount: ${challenge.requirement.amount} tinybars`);

  if (!canSignPayment(liveHederaEnabled, liveHbarPaymentsEnabled)) {
    logger.log(
      "Challenge-only dry run complete: live Hedera and live HBAR payments are not both enabled.",
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

  const livePayment = await executeLiveHbarPayment(
    smokeUrl,
    expectedReceiver,
    challenge,
    env,
    fetchImplementation,
  );

  logger.log(
    `Live HBAR x402 payment completed with HTTP ${livePayment.response.status}.`,
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

export async function createHbarSmokeSignedPayload(
  smokeUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  paymentPayload: PaymentPayload;
  requirement: PaymentRequirements;
  paymentRequired: PaymentRequired;
  challengeFetchedAt: string;
}> {
  const expectedReceiver = requireEnvironmentValue(env, "CARRIER_ACCOUNT_ID");
  if (expectedReceiver !== HBAR_SMOKE_APPROVED_RECEIVER) {
    throw new Error("CARRIER_ACCOUNT_ID does not match the approved receiver.");
  }

  const challenge = await fetchAndValidateHbarSmokeChallenge(
    smokeUrl,
    expectedReceiver,
  );

  const { client } = await createHbarPaymentClient(
    expectedReceiver,
    env,
  );

  const paymentPayload = await client.createPaymentPayload(
    challenge.paymentRequired,
  );

  return {
    paymentPayload,
    requirement: challenge.requirement,
    paymentRequired: challenge.paymentRequired,
    challengeFetchedAt: new Date().toISOString(),
  };
}
