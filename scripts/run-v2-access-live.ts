/**
 * Phase B2b — guarded live Hedera testnet x402 access payments.
 *
 * Exactly two successful settlements (activation + bid). No HCS writes.
 * Requires explicit confirmation flags. Never logs private keys or payment
 * payload bodies.
 *
 * Usage (with dotenv already set):
 *   ROUTEGUARD_LIVE_V2_ACCESS_CONFIRM=I_UNDERSTAND_TESTNET_WRITES \
 *   ROUTEGUARD_LIVE_V2_ACCESS_MAX_SETTLEMENTS=2 \
 *   ENABLE_V2_ACCESS_ROUTES=true \
 *   ROUTEGUARD_ACCESS_TREASURY_ACCOUNT_ID=<distinct-account> \
 *   npm run demo:v2-access-live
 */

import "dotenv/config";

import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { PrivateKey } from "@hiero-ledger/sdk";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
} from "@x402/core/types";

import { InMemoryCarrierRegistry } from "../src/domain/carrier";
import { isValidHederaAccountId } from "../src/domain/payment-option";
import {
  ACCESS_FEE_AMOUNT_ATOMIC,
  ACCESS_FEE_DISPLAY_AMOUNT,
  ACCESS_FEE_TOKEN_ID,
  ACCESS_TREASURY_ENV_KEY,
  deriveAccessFeeAtomic,
} from "../src/v2/access/fee";
import {
  hashScanTransactionUrl,
  MirrorAccessPaymentReconciler,
  verifyUsdcAccessPaymentOnMirror,
} from "../src/v2/access/mirror-reconcile";
import { bidSubmitResource, tenderActivateResource } from "../src/v2/access/resource";
import { X402AccessGate } from "../src/v2/access/x402-gate";
import {
  buildCarrierBidSignPayload,
} from "../src/v2/auth/canonical";
import { signCarrierBidForTests } from "../src/v2/auth/verify";
import {
  resolveV2AccessConfig,
  V2_ACCESS_ROUTES_ENV_KEY,
} from "../src/v2/config";
import { createV2AccessApp } from "../src/v2/http/routes";
import { canonicalSha256 } from "../src/domain/canonical-hash";
import {
  parseV2CarrierBid,
  v2BidHash,
} from "../src/v2/schemas/bid";
import { parseV2FreightTender } from "../src/v2/schemas/tender";
import { FileBidBodyStore } from "../src/v2/store/bid-body-store";
import { LifecycleService } from "../src/v2/store/lifecycle-service";
import { FileLifecycleStore } from "../src/v2/store/lifecycle-store";
import { FilePaymentClaimStore } from "../src/v2/store/payment-claim-store";
import { createTrustPolicy } from "../src/v2/trust/policy";
import {
  FINAL_DEMO_FACILITATOR_FEE_PAYER,
  FINAL_DEMO_NETWORK,
} from "../src/final-demo/constants";
import {
  HEDERA_TESTNET_MIRROR_NODE,
  USDC_SMOKE_APPROVED_FACILITATOR,
} from "../src/x402/usdc-constants";

// ---------------------------------------------------------------------------
// Constants / guards
// ---------------------------------------------------------------------------

const CONFIRM_ENV = "ROUTEGUARD_LIVE_V2_ACCESS_CONFIRM";
const CONFIRM_VALUE = "I_UNDERSTAND_TESTNET_WRITES";
const MAX_SETTLEMENTS_ENV = "ROUTEGUARD_LIVE_V2_ACCESS_MAX_SETTLEMENTS";
const MAX_SETTLEMENTS = 2;

const EVIDENCE_DIR = path.join("evidence", "v2", "access");
const DATA_DIR = path.join("data", "v2-live-access");

type PublicIds = {
  shipperAccount: string;
  carrierAccount: string;
  treasuryAccount: string;
  facilitatorUrl: string;
  feePayer: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(code: string, message: string): never {
  console.error(`FAIL [${code}]: ${message}`);
  process.exit(1);
}

function present(name: string): boolean {
  const v = process.env[name]?.trim();
  return Boolean(v && v.length > 0);
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) die("ENV_MISSING", `${name} is required`);
  return v;
}

function publicReportEnv(): void {
  const keys = [
    CONFIRM_ENV,
    MAX_SETTLEMENTS_ENV,
    V2_ACCESS_ROUTES_ENV_KEY,
    ACCESS_TREASURY_ENV_KEY,
    "SHIPPER_ACCOUNT_ID",
    "SHIPPER_PRIVATE_KEY",
    "FINAL_DEMO_CARRIER_ALPHA_ACCOUNT_ID",
    "FINAL_DEMO_CARRIER_ALPHA_PRIVATE_KEY",
    "USDC_TOKEN_ID",
    "FACILITATOR_URL",
    "HEDERA_NETWORK",
    "ENABLE_LIVE_HEDERA",
    "ENABLE_LIVE_USDC_PAYMENTS",
  ];
  for (const k of keys) {
    console.log(`ENV ${k}=${present(k) ? "PRESENT" : "MISSING"}`);
  }
}

function writeJson(filePath: string, data: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function stableRunId(): string {
  // Deterministic-looking short id from date + random bytes (once at start).
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = randomBytes(4).toString("hex");
  return `v2access-${day}-${suffix}`;
}

async function mirrorAccountUsdc(
  accountId: string,
  tokenId: string,
): Promise<{ associated: boolean; balanceAtomic: bigint }> {
  const url = `${HEDERA_TESTNET_MIRROR_NODE}/api/v1/accounts/${accountId}/tokens?limit=100`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Mirror account tokens HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    tokens?: Array<{ token_id?: string; balance?: number }>;
  };
  const hit = (body.tokens ?? []).find((t) => t.token_id === tokenId);
  if (!hit) return { associated: false, balanceAtomic: 0n };
  return {
    associated: true,
    balanceAtomic: BigInt(hit.balance ?? 0),
  };
}

async function facilitatorPreflight(
  facilitatorUrl: string,
): Promise<{ feePayer: string }> {
  const res = await fetch(`${facilitatorUrl.replace(/\/$/, "")}/supported`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    die("FACILITATOR", `facilitator /supported HTTP ${res.status}`);
  }
  const payload = (await res.json()) as {
    kinds?: Array<Record<string, unknown>>;
  };
  const hedera = (payload.kinds ?? []).find(
    (k) =>
      k.x402Version === 2 &&
      k.scheme === "exact" &&
      k.network === "hedera:testnet",
  );
  if (!hedera) {
    die("FACILITATOR", "no x402 v2 exact hedera:testnet capability");
  }
  const extra = hedera.extra as { feePayer?: string } | undefined;
  const feePayer = extra?.feePayer?.trim();
  if (!feePayer || !isValidHederaAccountId(feePayer)) {
    die("FACILITATOR", "fee payer missing or invalid");
  }
  if (feePayer !== FINAL_DEMO_FACILITATOR_FEE_PAYER) {
    console.warn(
      `WARN: facilitator fee payer ${feePayer} differs from known demo fee payer ${FINAL_DEMO_FACILITATOR_FEE_PAYER}`,
    );
  }
  return { feePayer };
}

async function createSignedPaymentHeader(input: {
  paymentRequired: PaymentRequired;
  resourceUrl: string;
  payerAccountId: string;
  privateKeyText: string;
  expectedPayTo: string;
  expectedAmount: string;
  expectedAsset: string;
  feePayer: string;
}): Promise<{ header: string; payloadHash: string }> {
  const accepted = input.paymentRequired.accepts?.[0];
  if (!accepted) {
    die("PAYMENT", "payment required has no accepts");
  }
  if (accepted.scheme !== "exact") die("PAYMENT", "scheme not exact");
  if (accepted.network !== "hedera:testnet") die("PAYMENT", "network mismatch");
  if (accepted.asset !== input.expectedAsset) die("PAYMENT", "asset mismatch");
  if (accepted.amount !== input.expectedAmount) {
    die("PAYMENT", `amount mismatch: ${accepted.amount}`);
  }
  if (accepted.payTo !== input.expectedPayTo) {
    die("PAYMENT", "payTo mismatch");
  }

  const [coreClientModule, hederaModule, hederaExactModule] = await Promise.all([
    import("@x402/core/client"),
    import("@x402/hedera"),
    import("@x402/hedera/exact/client"),
  ]);

  let privateKey: ReturnType<typeof hederaModule.PrivateKey.fromStringECDSA>;
  try {
    privateKey = hederaModule.PrivateKey.fromStringECDSA(input.privateKeyText);
  } catch {
    die("KEY", "failed to parse payer ECDSA private key");
  }

  const signer = hederaModule.createClientHederaSigner(
    input.payerAccountId,
    privateKey,
    { network: FINAL_DEMO_NETWORK },
  );

  const requirement: PaymentRequirements = {
    scheme: "exact",
    network: "hedera:testnet",
    asset: input.expectedAsset,
    amount: input.expectedAmount,
    payTo: input.expectedPayTo,
    maxTimeoutSeconds: accepted.maxTimeoutSeconds,
    extra: {
      ...(accepted.extra ?? {}),
      feePayer: input.feePayer,
    },
  };

  const client = new coreClientModule.x402Client(
    (x402Version, requirements) => {
      if (x402Version !== 2) {
        throw new Error("x402Version must be 2");
      }
      if (requirements.length !== 1) {
        throw new Error("expected exactly one requirement");
      }
      return requirements[0]!;
    },
  ).register("hedera:testnet", new hederaExactModule.ExactHederaScheme(signer));

  const paymentPayload: PaymentPayload = await client.createPaymentPayload({
    x402Version: 2,
    error: "Payment required for RouteGuard v2 access",
    resource: {
      url: input.resourceUrl,
      description:
        input.paymentRequired.resource?.description ??
        "RouteGuard v2 access fee",
      mimeType: "application/json",
    },
    accepts: [requirement],
  });

  // Ensure resource URL is the exact protected path.
  if (paymentPayload.resource?.url !== input.resourceUrl) {
    // Some clients may not set resource; force it for our gate binding check.
    (paymentPayload as { resource: { url: string } }).resource = {
      url: input.resourceUrl,
    };
  }

  const header = encodePaymentSignatureHeader(paymentPayload);
  // Hash without logging payload contents.
  const payloadHash = canonicalSha256({
    x402Version: paymentPayload.x402Version,
    accepted: paymentPayload.accepted,
    resourceUrl: paymentPayload.resource?.url ?? null,
  });
  return { header, payloadHash };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== RouteGuard v2 Phase B2b live access payments ===");
  publicReportEnv();

  // ---- Guards ----
  if (process.env[CONFIRM_ENV]?.trim() !== CONFIRM_VALUE) {
    die(
      "GUARD",
      `${CONFIRM_ENV} must be exactly ${CONFIRM_VALUE}`,
    );
  }
  if (process.env[MAX_SETTLEMENTS_ENV]?.trim() !== String(MAX_SETTLEMENTS)) {
    die(
      "GUARD",
      `${MAX_SETTLEMENTS_ENV} must be exactly ${MAX_SETTLEMENTS}`,
    );
  }
  if (process.env.ENABLE_LIVE_HEDERA !== "true") {
    die("GUARD", "ENABLE_LIVE_HEDERA must be true");
  }
  if (process.env.ENABLE_LIVE_USDC_PAYMENTS !== "true") {
    die("GUARD", "ENABLE_LIVE_USDC_PAYMENTS must be true");
  }
  if (process.env[V2_ACCESS_ROUTES_ENV_KEY] !== "true") {
    die("GUARD", `${V2_ACCESS_ROUTES_ENV_KEY} must be true`);
  }

  const network = process.env.HEDERA_NETWORK?.trim() || "hedera:testnet";
  if (network !== "hedera:testnet") {
    die("NETWORK", `network must be hedera:testnet, got ${network}`);
  }
  const tokenId = process.env.USDC_TOKEN_ID?.trim() || ACCESS_FEE_TOKEN_ID;
  if (tokenId !== ACCESS_FEE_TOKEN_ID) {
    die("TOKEN", `token must be ${ACCESS_FEE_TOKEN_ID}`);
  }
  const amountAtomic = deriveAccessFeeAtomic();
  if (amountAtomic !== "1000" || amountAtomic !== ACCESS_FEE_AMOUNT_ATOMIC) {
    die("AMOUNT", "access fee must derive to 1000 atomic");
  }

  const missing: string[] = [];
  for (const k of [
    ACCESS_TREASURY_ENV_KEY,
    "SHIPPER_ACCOUNT_ID",
    "SHIPPER_PRIVATE_KEY",
    "FINAL_DEMO_CARRIER_ALPHA_ACCOUNT_ID",
    "FINAL_DEMO_CARRIER_ALPHA_PRIVATE_KEY",
    "FACILITATOR_URL",
  ]) {
    if (!present(k)) missing.push(k);
  }
  if (missing.length > 0) {
    die(
      "ENV_MISSING",
      `missing required configuration: ${missing.join(", ")}`,
    );
  }

  const ids: PublicIds = {
    shipperAccount: requireEnv("SHIPPER_ACCOUNT_ID"),
    carrierAccount: requireEnv("FINAL_DEMO_CARRIER_ALPHA_ACCOUNT_ID"),
    treasuryAccount: requireEnv(ACCESS_TREASURY_ENV_KEY),
    facilitatorUrl: requireEnv("FACILITATOR_URL").replace(/\/+$/, ""),
    feePayer: FINAL_DEMO_FACILITATOR_FEE_PAYER,
  };

  if (!isValidHederaAccountId(ids.treasuryAccount)) {
    die("TREASURY", "treasury account id is malformed");
  }
  if (ids.treasuryAccount === ids.shipperAccount) {
    die("TREASURY", "treasury must differ from shipper (activation payer)");
  }
  // Carrier account may equal treasury when the bid access fee is paid by the
  // shipper (carrier cannot pay itself). Bid signature still uses the carrier key.
  if (ids.facilitatorUrl !== USDC_SMOKE_APPROVED_FACILITATOR) {
    die(
      "FACILITATOR",
      `FACILITATOR_URL must be ${USDC_SMOKE_APPROVED_FACILITATOR}`,
    );
  }

  // Refuse if a completed live run already exists.
  const summaryPath = path.join(EVIDENCE_DIR, "run-summary.json");
  if (existsSync(summaryPath)) {
    try {
      const existing = JSON.parse(readFileSync(summaryPath, "utf8")) as {
        status?: string;
        successfulSettlements?: number;
      };
      if (
        existing.status === "SUCCESS" &&
        existing.successfulSettlements === 2
      ) {
        die(
          "ALREADY_DONE",
          "completed live run evidence already exists under evidence/v2/access/",
        );
      }
    } catch {
      // Corrupt/incomplete summary — proceed carefully but do not overwrite blindly later.
    }
  }

  // Resume: if a prior partial run already activated a tender, continue bid only.
  type ResumeState = {
    runId: string;
    tenderId: string;
    tenderVersion: number;
    activationTx: string;
    actionActivate: string;
  } | null;
  let resume: ResumeState = null;
  const claimsPath = path.join(DATA_DIR, "payment-claims", "payment-claims.json");
  if (existsSync(claimsPath)) {
    try {
      const journal = JSON.parse(readFileSync(claimsPath, "utf8")) as {
        claims?: Array<{
          state?: string;
          binding?: {
            actionType?: string;
            actionId?: string;
            tenderId?: string;
            tenderVersion?: number;
          };
          settlement?: { transactionId?: string };
        }>;
      };
      const activationClaim = (journal.claims ?? []).find(
        (c) =>
          c.state === "COMMITTED" &&
          c.binding?.actionType === "TENDER_ACTIVATE" &&
          c.settlement?.transactionId,
      );
      if (activationClaim?.binding?.tenderId && activationClaim.settlement) {
        const tid = activationClaim.binding.tenderId;
        const runFromTender = tid.startsWith("tender-")
          ? tid.slice("tender-".length)
          : tid;
        resume = {
          runId: runFromTender,
          tenderId: tid,
          tenderVersion: activationClaim.binding.tenderVersion ?? 1,
          activationTx: activationClaim.settlement.transactionId!,
          actionActivate: activationClaim.binding.actionId ?? `act-activate-${runFromTender}`,
        };
        console.log(
          `RESUME_ACTIVATION=YES runId=${resume.runId} tx=${resume.activationTx}`,
        );
      }
    } catch {
      /* ignore malformed journal */
    }
  }

  // ---- Preflight reads ----
  const fac = await facilitatorPreflight(ids.facilitatorUrl);
  ids.feePayer = fac.feePayer;
  console.log(`FACILITATOR_OK feePayer=${ids.feePayer}`);

  const shipperUsdc = await mirrorAccountUsdc(ids.shipperAccount, tokenId);
  const carrierUsdc = await mirrorAccountUsdc(ids.carrierAccount, tokenId);
  const treasuryUsdc = await mirrorAccountUsdc(ids.treasuryAccount, tokenId);
  console.log(
    `USDC shipper associated=${shipperUsdc.associated} bal=${shipperUsdc.balanceAtomic}`,
  );
  console.log(
    `USDC carrier associated=${carrierUsdc.associated} bal=${carrierUsdc.balanceAtomic}`,
  );
  console.log(
    `USDC treasury associated=${treasuryUsdc.associated} bal=${treasuryUsdc.balanceAtomic}`,
  );
  if (!shipperUsdc.associated || shipperUsdc.balanceAtomic < 1000n) {
    die("BALANCE", "shipper needs USDC association and balance >= 1000 atomic");
  }
  if (!carrierUsdc.associated || carrierUsdc.balanceAtomic < 1000n) {
    die("BALANCE", "carrier needs USDC association and balance >= 1000 atomic");
  }
  if (!treasuryUsdc.associated) {
    die(
      "ASSOCIATION",
      "treasury must be associated with USDC (read-only check failed)",
    );
  }

  // ---- Run identity ----
  const runId = resume?.runId ?? stableRunId();
  const tenderId = resume?.tenderId ?? `tender-${runId}`;
  const tenderVersion = resume?.tenderVersion ?? 1;
  const bidId = `bid-${runId}`;
  const actionActivate = resume?.actionActivate ?? `act-activate-${runId}`;
  const actionBid = `act-bid-${runId}`;
  console.log(`LIVE_RUN_ID=${runId}`);
  console.log(`TENDER_ID=${tenderId} VERSION=${tenderVersion} BID_ID=${bidId}`);
  console.log(`RESUME_MODE=${resume ? "YES" : "NO"}`);

  // ---- Keys (public only derived) ----
  const shipperKey = PrivateKey.fromStringECDSA(
    requireEnv("SHIPPER_PRIVATE_KEY"),
  );
  const carrierKey = PrivateKey.fromStringECDSA(
    requireEnv("FINAL_DEMO_CARRIER_ALPHA_PRIVATE_KEY"),
  );
  const shipperPub = shipperKey.publicKey.toStringRaw();
  const carrierPub = carrierKey.publicKey.toStringRaw();
  // Dummy referee key for trust policy only (never used in Phase B).
  const dummyReferee = PrivateKey.generateECDSA();

  const trust = createTrustPolicy({
    shipperPublicKey: shipperPub,
    referees: [
      {
        refereeId: "ref-phase-b-placeholder",
        publicKey: dummyReferee.publicKey.toStringRaw(),
      },
    ],
    accessTreasuryAccountId: ids.treasuryAccount,
  });

  // ---- Synthetic tender / catalog / lifecycle seed ----
  const now = new Date();
  const auctionEnds = new Date(now.getTime() + 7 * 24 * 3600_000).toISOString();
  const pickupEarliest = new Date(now.getTime() + 10 * 24 * 3600_000).toISOString();
  const pickupLatest = new Date(now.getTime() + 11 * 24 * 3600_000).toISOString();
  const deliveryDeadline = new Date(now.getTime() + 14 * 24 * 3600_000).toISOString();

  const tender = parseV2FreightTender({
    tenderId,
    shipperId: "shipper-demo",
    origin: "Rotterdam (synthetic)",
    destination: "Munich (synthetic)",
    cargo: {
      type: "palletized-dry-demo",
      weightKg: 10_000,
      pallets: 20,
      dangerousGoods: false,
    },
    requiredEquipment: "dry-van-13.6m",
    pickupWindow: { earliest: pickupEarliest, latest: pickupLatest },
    deliveryDeadline,
    auctionEndsAt: auctionEnds,
    maximumFreightBudgetAtomic: "10000000",
    selectionPolicy: "LOWEST_QUALIFIED_PRICE_V1",
    version: tenderVersion,
  });

  mkdirSync(path.join(DATA_DIR, "tenders"), { recursive: true });
  mkdirSync(path.join(DATA_DIR, "lifecycle"), { recursive: true });
  mkdirSync(path.join(DATA_DIR, "bids"), { recursive: true });
  mkdirSync(path.join(DATA_DIR, "payment-claims"), { recursive: true });
  writeJson(
    path.join(DATA_DIR, "tenders", `tender-${tenderId}-v${tenderVersion}.json`),
    tender,
  );

  const carriers = new InMemoryCarrierRegistry([
    {
      carrierId: "carrier-alpha",
      carrierAccountId: ids.carrierAccount,
      signingPublicKey: carrierPub,
      active: true,
      allowedEquipment: ["dry-van-13.6m"],
      registryVersion: 1,
    },
  ]);

  const accessConfig = resolveV2AccessConfig(process.env);
  if (!accessConfig.enabled) {
    die("CONFIG", "v2 access routes not enabled after resolve");
  }

  const lifecycleStore = new FileLifecycleStore(path.join(DATA_DIR, "lifecycle"));
  const lifecycle = new LifecycleService(lifecycleStore, { carriers });
  const existingRecord = await lifecycle.get(tenderId);
  if (!existingRecord) {
    await lifecycle.create({
      tenderId,
      tenderVersion,
      tenderHash: canonicalSha256(tender),
      maximumFreightBudgetAtomic: tender.maximumFreightBudgetAtomic,
      auctionEndsAt: tender.auctionEndsAt,
      createdAt: now.toISOString(),
      trust,
    });
    // Synthetic offline escrow precondition — NOT a live freight escrow tx.
    await lifecycle.apply(tenderId, {
      type: "ESCROW_FUNDING_CONFIRMED",
      actionId: `seed-escrow-fixture-${runId}`,
      eventTime: now.toISOString(),
      fundingTxId: `PHASE_B_SYNTHETIC_ESCROW_FIXTURE_${runId}`,
      tokenId: ACCESS_FEE_TOKEN_ID,
      fundedAmountAtomic: tender.maximumFreightBudgetAtomic,
      tenderId,
      tenderVersion,
    });
    console.log(
      "ESCROW_PRECONDITION=SYNTHETIC_OFFLINE_FIXTURE LIVE_FREIGHT_ESCROW=NO",
    );
  } else {
    console.log(
      `LIFECYCLE_EXISTING state=${existingRecord.state} version=${existingRecord.recordVersion}`,
    );
  }

  const gate = new X402AccessGate({
    facilitator: new HTTPFacilitatorClient({ url: ids.facilitatorUrl }),
    config: accessConfig,
    now: () => new Date().toISOString(),
  });

  const paymentClaims = new FilePaymentClaimStore(
    path.join(DATA_DIR, "payment-claims"),
  );
  const bidBodies = new FileBidBodyStore(path.join(DATA_DIR, "bids"));
  const tenders = {
    async get(id: string, version: number) {
      if (id === tenderId && version === tenderVersion) return tender;
      return null;
    },
  };

  const app = createV2AccessApp({
    lifecycle,
    bidBodies,
    tenders,
    carriers,
    gate,
    paymentClaims,
    paymentReconciler: new MirrorAccessPaymentReconciler(),
    config: accessConfig,
    now: () => new Date().toISOString(),
  });

  // ---- HTTP server ----
  const port = 38765;
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
  // Wait briefly for listen
  await new Promise((r) => setTimeout(r, 300));

  let successfulSettlements = resume ? 1 : 0;
  let activationTx: string | null = resume?.activationTx ?? null;
  let bidTx: string | null = null;
  const evidence: Record<string, unknown> = {
    runId,
    startedAt: new Date().toISOString(),
    LIVE_X402_PAYMENT: true,
    LIVE_FREIGHT_ESCROW: false,
    ESCROW_PHASE: "C_PENDING",
    claimBoundary: {
      realTestnetAccessPayments: true,
      syntheticBusinessData: true,
      hcsSubmitted: false,
      freightEscrowLive: false,
      podLive: false,
    },
  };

  try {
    // ====================================================================
    // PAYMENT 1 — Tender activation
    // ====================================================================
    const activatePath = `/api/v2/tenders/${encodeURIComponent(tenderId)}/v/${tenderVersion}/activate`;
    const activateResource = tenderActivateResource(tenderId, tenderVersion);
    console.log(`\n--- PAYMENT 1 ACTIVATE ${activatePath} ---`);

    type ActivationResponse = {
      outcome?: string;
      tender?: { state?: string };
      accessPayment?: {
        transactionId?: string;
        amountAtomic?: string;
        payerAccount?: string;
        payTo?: string;
      } | null;
    };

    let activationMirror;
    let activationOutcome: string | null = null;

    if (resume && activationTx) {
      console.log(`SKIP_NEW_ACTIVATION_SETTLEMENT using existing ${activationTx}`);
      activationMirror = await verifyUsdcAccessPaymentOnMirror({
        transactionId: activationTx,
        payerAccount: ids.shipperAccount,
        treasuryAccount: ids.treasuryAccount,
        asset: ACCESS_FEE_TOKEN_ID,
        amountAtomic: "1000",
      });
      if (
        activationMirror.status !== "SUCCESS" ||
        !activationMirror.amountAtomicMatch
      ) {
        die(
          "ACTIVATION_MIRROR",
          `resume mirror failed: ${JSON.stringify(activationMirror)}`,
        );
      }
      // Idempotent replay without payment header
      const replayResume = await fetch(`${baseUrl}${activatePath}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ actionId: actionActivate }),
      });
      const replayResumeJson = (await replayResume.json()) as ActivationResponse;
      console.log(
        `ACTIVATION resume-replay HTTP ${replayResume.status} outcome=${replayResumeJson.outcome}`,
      );
      if (replayResume.status !== 200) {
        die("ACTIVATION_REPLAY", `resume replay HTTP ${replayResume.status}`);
      }
      activationOutcome = replayResumeJson.outcome ?? "REPLAYED";
      writeJson(path.join(EVIDENCE_DIR, "tender-activation-402.json"), {
        runId,
        note: "Original 402 not re-captured on resume; activation already COMMITTED",
        actionType: "TENDER_ACTIVATE",
        actionId: actionActivate,
        expectedTerms: {
          scheme: "exact",
          network: "hedera:testnet",
          asset: ACCESS_FEE_TOKEN_ID,
          amount: "1000",
          payTo: ids.treasuryAccount,
        },
      });
    } else {
      const unpaid1 = await fetch(`${baseUrl}${activatePath}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ actionId: actionActivate }),
      });
      console.log(`ACTIVATION unpaid HTTP ${unpaid1.status}`);
      if (unpaid1.status !== 402) {
        const text = await unpaid1.text();
        die(
          "ACTIVATION_402",
          `expected 402, got ${unpaid1.status}: ${text.slice(0, 200)}`,
        );
      }
      const unpaid1Body = (await unpaid1.json()) as PaymentRequired;
      writeJson(path.join(EVIDENCE_DIR, "tender-activation-402.json"), {
        runId,
        actionType: "TENDER_ACTIVATE",
        actionId: actionActivate,
        httpStatus: 402,
        x402Version: unpaid1Body.x402Version,
        accepts: (unpaid1Body.accepts ?? []).map((a) => ({
          scheme: a.scheme,
          network: a.network,
          asset: a.asset,
          amount: a.amount,
          payTo: a.payTo,
          maxTimeoutSeconds: a.maxTimeoutSeconds,
          feePayer:
            typeof a.extra === "object" && a.extra && "feePayer" in a.extra
              ? (a.extra as { feePayer?: string }).feePayer
              : null,
        })),
        resource: unpaid1Body.resource ?? null,
        note: "Sanitized 402 challenge — no secrets",
      });
      if (
        unpaid1Body.accepts?.[0]?.amount !== "1000" ||
        unpaid1Body.accepts?.[0]?.asset !== ACCESS_FEE_TOKEN_ID ||
        unpaid1Body.accepts?.[0]?.payTo !== ids.treasuryAccount ||
        unpaid1Body.accepts?.[0]?.scheme !== "exact" ||
        unpaid1Body.accepts?.[0]?.network !== "hedera:testnet"
      ) {
        die("ACTIVATION_402", "challenge terms mismatch");
      }

      const paidHeader1 = await createSignedPaymentHeader({
        paymentRequired: unpaid1Body,
        resourceUrl: activateResource,
        payerAccountId: ids.shipperAccount,
        privateKeyText: requireEnv("SHIPPER_PRIVATE_KEY"),
        expectedPayTo: ids.treasuryAccount,
        expectedAmount: "1000",
        expectedAsset: ACCESS_FEE_TOKEN_ID,
        feePayer: ids.feePayer,
      });

      const paid1 = await fetch(`${baseUrl}${activatePath}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "X-PAYMENT": paidHeader1.header,
        },
        body: JSON.stringify({ actionId: actionActivate }),
      });
      const paid1Text = await paid1.text();
      console.log(`ACTIVATION paid HTTP ${paid1.status}`);
      if (paid1.status !== 200) {
        die(
          "ACTIVATION_PAYMENT",
          `expected 200, got ${paid1.status}: ${paid1Text.slice(0, 300)}`,
        );
      }
      const paid1Json = JSON.parse(paid1Text) as ActivationResponse;
      activationTx =
        paid1Json.accessPayment?.transactionId ?? null;
      if (!activationTx) {
        die(
          "ACTIVATION_PAYMENT",
          `no transaction id in activation response: ${paid1Text.slice(0, 400)}`,
        );
      }
      successfulSettlements += 1;
      activationOutcome = paid1Json.outcome ?? "PAID";
      console.log(`ACTIVATION_TX=${activationTx}`);

      activationMirror = await verifyUsdcAccessPaymentOnMirror({
        transactionId: activationTx,
        payerAccount: ids.shipperAccount,
        treasuryAccount: ids.treasuryAccount,
        asset: ACCESS_FEE_TOKEN_ID,
        amountAtomic: "1000",
      });
      for (let i = 0; i < 25 && activationMirror.status !== "SUCCESS"; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        activationMirror = await verifyUsdcAccessPaymentOnMirror({
          transactionId: activationTx,
          payerAccount: ids.shipperAccount,
          treasuryAccount: ids.treasuryAccount,
          asset: ACCESS_FEE_TOKEN_ID,
          amountAtomic: "1000",
        });
      }
      if (
        activationMirror.status !== "SUCCESS" ||
        !activationMirror.amountAtomicMatch
      ) {
        die(
          "ACTIVATION_MIRROR",
          `mirror verification failed: ${JSON.stringify(activationMirror)}`,
        );
      }

      // Replay — must not second-settle
      const settleCountBeforeReplay = successfulSettlements;
      const replay1 = await fetch(`${baseUrl}${activatePath}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "X-PAYMENT": paidHeader1.header,
        },
        body: JSON.stringify({ actionId: actionActivate }),
      });
      const replay1Json = (await replay1.json()) as ActivationResponse;
      console.log(
        `ACTIVATION replay HTTP ${replay1.status} outcome=${replay1Json.outcome}`,
      );
      if (replay1.status !== 200) {
        die("ACTIVATION_REPLAY", `replay failed HTTP ${replay1.status}`);
      }
      if (
        replay1Json.accessPayment?.transactionId &&
        replay1Json.accessPayment.transactionId !== activationTx
      ) {
        die("ACTIVATION_REPLAY", "replay produced a different transaction id");
      }
      if (successfulSettlements !== settleCountBeforeReplay) {
        die("ACTIVATION_REPLAY", "replay incremented settlement counter");
      }
    }

    console.log(
      `ACTIVATION_MIRROR=PASS consensus=${activationMirror!.consensusTimestamp}`,
    );

    writeJson(path.join(EVIDENCE_DIR, "tender-activation-payment.json"), {
      runId,
      actionType: "TENDER_ACTIVATE",
      actionId: actionActivate,
      tenderId,
      tenderVersion,
      payerAccount: ids.shipperAccount,
      treasuryAccount: ids.treasuryAccount,
      network: "hedera:testnet",
      scheme: "exact",
      tokenId: ACCESS_FEE_TOKEN_ID,
      displayAmount: ACCESS_FEE_DISPLAY_AMOUNT,
      amountAtomic: "1000",
      resource: activateResource,
      paymentTransactionId: activationTx,
      consensusTimestamp: activationMirror!.consensusTimestamp,
      mirrorStatus: activationMirror!.status,
      hashScanUrl: activationMirror!.hashScanUrl,
      outcome: activationOutcome,
      LIVE_X402_PAYMENT: true,
      LIVE_FREIGHT_ESCROW: false,
      resumed: Boolean(resume),
    });
    writeJson(path.join(EVIDENCE_DIR, "tender-activation-resource.json"), {
      runId,
      resource: activateResource,
      httpStatus: 200,
      outcome: activationOutcome,
    });

    // ====================================================================
    // PAYMENT 2 — Carrier bid
    // ====================================================================
    const bidPath = `/api/v2/tenders/${encodeURIComponent(tenderId)}/v/${tenderVersion}/bids/${encodeURIComponent(bidId)}`;
    const bidResource = bidSubmitResource(tenderId, tenderVersion, bidId);
    console.log(`\n--- PAYMENT 2 BID ${bidPath} ---`);

    const salt = randomBytes(32).toString("hex");
    const signedAt = new Date().toISOString();
    const bidBody = parseV2CarrierBid({
      bidId,
      tenderId,
      tenderVersion,
      carrierId: "carrier-alpha",
      carrierAccountId: ids.carrierAccount,
      freightAmountAtomic: "7000000",
      equipment: "dry-van-13.6m",
      proposedPickupAt: pickupEarliest,
      estimatedDelivery: new Date(
        new Date(pickupEarliest).getTime() + 2 * 24 * 3600_000,
      ).toISOString(),
      capacityConfirmed: true,
      bidValidUntil: auctionEnds,
      commitmentSalt: salt,
      nonce: `nonce-${runId}`,
      version: 1,
    });
    const bidHash = v2BidHash(bidBody);
    const bidSignPayload = buildCarrierBidSignPayload({
      tenderId,
      tenderVersion,
      bidId,
      carrierId: "carrier-alpha",
      carrierAccountId: ids.carrierAccount,
      bidHash,
      signedAt,
      actionId: actionBid,
    });
    const bidSignature = signCarrierBidForTests(
      carrierKey.toStringRaw(),
      bidSignPayload,
    );

    const unpaid2 = await fetch(`${baseUrl}${bidPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        actionId: actionBid,
        signedAt,
        signature: bidSignature,
        bid: bidBody,
      }),
    });
    console.log(`BID unpaid HTTP ${unpaid2.status}`);
    if (unpaid2.status !== 402) {
      const t = await unpaid2.text();
      die("BID_402", `expected 402, got ${unpaid2.status}: ${t.slice(0, 300)}`);
    }
    const unpaid2Body = (await unpaid2.json()) as PaymentRequired;
    writeJson(path.join(EVIDENCE_DIR, "bid-submission-402.json"), {
      runId,
      actionType: "BID_SUBMIT",
      actionId: actionBid,
      bidId,
      httpStatus: 402,
      x402Version: unpaid2Body.x402Version,
      accepts: (unpaid2Body.accepts ?? []).map((a) => ({
        scheme: a.scheme,
        network: a.network,
        asset: a.asset,
        amount: a.amount,
        payTo: a.payTo,
        maxTimeoutSeconds: a.maxTimeoutSeconds,
      })),
      note: "Sanitized 402 challenge — private bid body not included",
    });

    // Access fee payer for the bid may be the shipper when the treasury is the
    // only other USDC-associated account (carrier cannot pay itself). The bid
    // signature still comes from the registered carrier key.
    const bidAccessPayer = ids.shipperAccount;
    const bidAccessKey = requireEnv("SHIPPER_PRIVATE_KEY");
    const paidHeader2 = await createSignedPaymentHeader({
      paymentRequired: unpaid2Body,
      resourceUrl: bidResource,
      payerAccountId: bidAccessPayer,
      privateKeyText: bidAccessKey,
      expectedPayTo: ids.treasuryAccount,
      expectedAmount: "1000",
      expectedAsset: ACCESS_FEE_TOKEN_ID,
      feePayer: ids.feePayer,
    });

    const paid2 = await fetch(`${baseUrl}${bidPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "X-PAYMENT": paidHeader2.header,
      },
      body: JSON.stringify({
        actionId: actionBid,
        signedAt,
        signature: bidSignature,
        bid: bidBody,
      }),
    });
    const paid2Text = await paid2.text();
    console.log(`BID paid HTTP ${paid2.status}`);
    if (paid2.status !== 200) {
      die("BID_PAYMENT", `expected 200, got ${paid2.status}: ${paid2Text.slice(0, 400)}`);
    }
    const paid2Json = JSON.parse(paid2Text) as {
      outcome?: string;
      accessPayment?: { transactionId?: string } | null;
      payment?: { transactionId?: string };
      tender?: { state?: string };
      bidId?: string;
    };
    bidTx =
      paid2Json.accessPayment?.transactionId ??
      paid2Json.payment?.transactionId ??
      null;
    if (!bidTx) {
      die(
        "BID_PAYMENT",
        `no transaction id in bid response: ${paid2Text.slice(0, 400)}`,
      );
    }
    if (bidTx === activationTx) {
      die("BID_PAYMENT", "bid settlement reused activation transaction id");
    }
    successfulSettlements += 1;
    console.log(`BID_TX=${bidTx}`);

    let bidMirror = await verifyUsdcAccessPaymentOnMirror({
      transactionId: bidTx,
      payerAccount: bidAccessPayer,
      treasuryAccount: ids.treasuryAccount,
      asset: ACCESS_FEE_TOKEN_ID,
      amountAtomic: "1000",
    });
    for (let i = 0; i < 25 && bidMirror.status !== "SUCCESS"; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      bidMirror = await verifyUsdcAccessPaymentOnMirror({
        transactionId: bidTx,
        payerAccount: bidAccessPayer,
        treasuryAccount: ids.treasuryAccount,
        asset: ACCESS_FEE_TOKEN_ID,
        amountAtomic: "1000",
      });
    }
    if (bidMirror.status !== "SUCCESS" || !bidMirror.amountAtomicMatch) {
      die("BID_MIRROR", `mirror verification failed: ${JSON.stringify(bidMirror)}`);
    }
    console.log(`BID_MIRROR=PASS consensus=${bidMirror.consensusTimestamp}`);

    writeJson(path.join(EVIDENCE_DIR, "bid-submission-payment.json"), {
      runId,
      actionType: "BID_SUBMIT",
      actionId: actionBid,
      tenderId,
      tenderVersion,
      bidId,
      carrierId: "carrier-alpha",
      payerAccount: bidAccessPayer,
      treasuryAccount: ids.treasuryAccount,
      network: "hedera:testnet",
      scheme: "exact",
      tokenId: ACCESS_FEE_TOKEN_ID,
      displayAmount: ACCESS_FEE_DISPLAY_AMOUNT,
      amountAtomic: "1000",
      resource: bidResource,
      paymentTransactionId: bidTx,
      consensusTimestamp: bidMirror.consensusTimestamp,
      mirrorStatus: bidMirror.status,
      hashScanUrl: bidMirror.hashScanUrl,
      bidHash,
      outcome: paid2Json.outcome ?? null,
      lifecycleState: paid2Json.tender?.state ?? null,
      payloadBindingHash: paidHeader2.payloadHash,
      LIVE_X402_PAYMENT: true,
      LIVE_FREIGHT_ESCROW: false,
      privateBidBodyIncluded: false,
      note: "Access fee paid by shipper when treasury is the only other USDC-associated account; bid signature is carrier",
    });
    writeJson(path.join(EVIDENCE_DIR, "bid-submission-resource.json"), {
      runId,
      resource: bidResource,
      httpStatus: 200,
      outcome: paid2Json.outcome ?? null,
      bidId,
      state: paid2Json.tender?.state ?? null,
    });

    // Bid replay
    const replay2 = await fetch(`${baseUrl}${bidPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "X-PAYMENT": paidHeader2.header,
      },
      body: JSON.stringify({
        actionId: actionBid,
        signedAt,
        signature: bidSignature,
        bid: bidBody,
      }),
    });
    const replay2Json = (await replay2.json()) as {
      outcome?: string;
      payment?: { transactionId?: string };
    };
    console.log(`BID replay HTTP ${replay2.status} outcome=${replay2Json.outcome}`);
    if (replay2.status !== 200) {
      die("BID_REPLAY", `replay failed HTTP ${replay2.status}`);
    }
    if (
      replay2Json.payment?.transactionId &&
      replay2Json.payment.transactionId !== bidTx
    ) {
      die("BID_REPLAY", "replay produced a different transaction id");
    }
    if (successfulSettlements !== 2) {
      die(
        "BUDGET",
        `successfulSettlements=${successfulSettlements} expected 2`,
      );
    }

    writeJson(path.join(EVIDENCE_DIR, "mirror-verification.json"), {
      runId,
      activation: activationMirror,
      bid: bidMirror,
      distinctTransactions: activationTx !== bidTx,
    });

    const summary = {
      status: "SUCCESS",
      runId,
      completedAt: new Date().toISOString(),
      LIVE_X402_PAYMENT: true,
      LIVE_FREIGHT_ESCROW: false,
      ESCROW_PHASE: "C_PENDING",
      HCS_NETWORK_WRITES: 0,
      OTHER_HEDERA_WRITES: 0,
      SUCCESSFUL_X402_SETTLEMENTS: 2,
      ACTIVATION_SETTLEMENTS: 1,
      BID_SETTLEMENTS: 1,
      scheme: "exact",
      network: "hedera:testnet",
      tokenId: ACCESS_FEE_TOKEN_ID,
      displayAmount: ACCESS_FEE_DISPLAY_AMOUNT,
      amountAtomic: "1000",
      treasuryAccount: ids.treasuryAccount,
      shipperPayer: ids.shipperAccount,
      carrierPayer: ids.carrierAccount,
      facilitatorUrl: ids.facilitatorUrl,
      tenderId,
      tenderVersion,
      bidId,
      activationTransactionId: activationTx,
      activationHashScan: hashScanTransactionUrl(activationTx!),
      bidTransactionId: bidTx,
      bidHashScan: hashScanTransactionUrl(bidTx!),
      syntheticEscrowPrecondition:
        "PHASE_B_SYNTHETIC_OFFLINE_FIXTURE — not a live freight escrow funding transaction",
      claims: {
        realTestnetAccessPayments: true,
        syntheticBusinessData: true,
        hcsSubmitted: false,
        freightEscrowLive: false,
        podLive: false,
        v1EvidenceUntouched: true,
        nextPhase: "C1 HTS freight-escrow contract and offline tests",
      },
    };
    writeJson(summaryPath, summary);

    writeFileSync(
      path.join(EVIDENCE_DIR, "README.md"),
      `# RouteGuard v2 Phase B2b — live x402 access payments

**Run ID:** \`${runId}\`

## What this proves

- Two **real** Hedera testnet x402 \`exact\` USDC access payments completed.
- Tender activation access fee: **0.001 USDC (1000 atomic)** to access treasury.
- Carrier bid submission access fee: **0.001 USDC (1000 atomic)** to access treasury.
- Token: \`0.0.429274\` · Network: \`hedera:testnet\` · Scheme: \`exact\`.

## Public transaction references

| Action | Transaction | HashScan |
|---|---|---|
| Tender activation | \`${activationTx}\` | ${hashScanTransactionUrl(activationTx!)} |
| Bid submission | \`${bidTx}\` | ${hashScanTransactionUrl(bidTx!)} |

## Claim boundary (truthful)

| Claim | Value |
|---|---|
| LIVE_X402_PAYMENT | YES |
| LIVE_FREIGHT_ESCROW | **NO** |
| ESCROW_PHASE | C_PENDING |
| HCS submitted | **NO** (outbox only offline) |
| POD / freight release | **NO** |
| Business tender/bid data | Synthetic demonstration data |
| v1 final-demo evidence | Unchanged / separate |

## Write budget

- Successful x402 settlements: **2**
- HCS network writes: **0**
- Other Hedera writes: **0**

## Privacy

Artifacts exclude private keys, raw payment headers, full payment payloads,
private bid bodies, and bid salts.
`,
      "utf8",
    );

    evidence.summary = summary;
    console.log("\n=== PHASE B2b COMPLETE ===");
    console.log(`SUCCESSFUL_X402_SETTLEMENTS=${successfulSettlements}`);
    console.log(`HCS_NETWORK_WRITES=0`);
    console.log(`LIVE_FREIGHT_ESCROW=NO`);
  } finally {
    // Close server (node-server Server exposes close())
    const closable = server as { close?: (cb?: () => void) => void };
    await new Promise<void>((resolve) => {
      if (typeof closable.close === "function") {
        closable.close(() => resolve());
      } else {
        resolve();
      }
      setTimeout(() => resolve(), 500);
    });
  }
}

const isDirect =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    fileURLToPath(import.meta.url);

if (isDirect) {
  main().catch((err) => {
    console.error("FATAL:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
