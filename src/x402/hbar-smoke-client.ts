import { decodePaymentRequiredHeader } from "@x402/core/http";
import type {
  PaymentRequired,
  PaymentRequirements,
} from "@x402/core/types";

export const DEFAULT_HBAR_SMOKE_URL =
  "http://localhost:3000/api/x402/hbar-smoke";
export const HBAR_SMOKE_NETWORK = "hedera:testnet" as const;
export const HBAR_SMOKE_SCHEME = "exact" as const;
export const HBAR_SMOKE_ASSET = "0.0.0" as const;
export const HBAR_SMOKE_AMOUNT_TINYBARS = "1000000" as const;
export const HBAR_SMOKE_X402_VERSION = 2 as const;

type FetchImplementation = typeof globalThis.fetch;

export type HbarSmokeLogger = Pick<Console, "log">;

export type ValidatedHbarSmokeChallenge = {
  paymentRequired: PaymentRequired;
  requirement: PaymentRequirements;
  response: Response;
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
      paymentRequired: PaymentRequired;
      requirement: PaymentRequirements;
    };

export type RunHbarSmokeClientOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImplementation?: FetchImplementation;
  logger?: HbarSmokeLogger;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function requireEnvironmentValue(
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

  if (
    !isRecord(requirement.extra) ||
    typeof requirement.extra.feePayer !== "string" ||
    !requirement.extra.feePayer.trim()
  ) {
    throw new Error("Missing Hedera fee payer in payment requirement.");
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
  };
}

function createValidatedChallengeFetch(
  smokeUrl: string,
  challengeResponse: Response,
  fetchImplementation: FetchImplementation,
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

    return fetchImplementation(request);
  };
}

async function executeLiveHbarPayment(
  smokeUrl: string,
  expectedReceiver: string,
  challenge: ValidatedHbarSmokeChallenge,
  env: NodeJS.ProcessEnv,
  fetchImplementation: FetchImplementation,
): Promise<Response> {
  const shipperAccountId = requireEnvironmentValue(
    env,
    "SHIPPER_ACCOUNT_ID",
  );
  const shipperPrivateKeyText = requireEnvironmentValue(
    env,
    "SHIPPER_PRIVATE_KEY",
  );

  const [coreClientModule, fetchModule, hederaModule, hederaExactModule] =
    await Promise.all([
      import("@x402/core/client"),
      import("@x402/fetch"),
      import("@x402/hedera"),
      import("@x402/hedera/exact/client"),
    ]);

  let shipperPrivateKey: ReturnType<
    typeof hederaModule.PrivateKey.fromString
  >;

  try {
    shipperPrivateKey = hederaModule.PrivateKey.fromString(
      shipperPrivateKeyText,
    );
  } catch {
    throw new Error("Invalid SHIPPER_PRIVATE_KEY.");
  }

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

  const validatedChallengeFetch = createValidatedChallengeFetch(
    smokeUrl,
    challenge.response,
    fetchImplementation,
  );
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
    throw new Error("Live HBAR x402 payment attempt failed.");
  }

  if (!paidResponse.ok) {
    throw new Error(
      `Live HBAR x402 payment retry returned HTTP ${paidResponse.status}.`,
    );
  }

  return paidResponse;
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

  const paidResponse = await executeLiveHbarPayment(
    smokeUrl,
    expectedReceiver,
    challenge,
    env,
    fetchImplementation,
  );

  logger.log(`Live HBAR x402 payment completed with HTTP ${paidResponse.status}.`);

  return {
    mode: "paid",
    status: paidResponse.status,
    paymentRequired: challenge.paymentRequired,
    requirement: challenge.requirement,
  };
}
