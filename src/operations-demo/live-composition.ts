import { canonicalSha256 } from "../domain/canonical-hash";
import { signCanonicalPayload } from "../domain/signature";
import { InMemoryCarrierRegistry } from "../domain/carrier";
import { buildHcsV2Envelope, serializeHcsV2Envelope } from "../hcs/v2/envelope";
import { mirrorTimestampToUtcIso } from "../hcs/mirror-node-client";
import type { HcsV2Envelope } from "../hcs/v2/types";
import { FINAL_DEMO_FACILITATOR_FEE_PAYER } from "../final-demo/constants";
import { buildCarrierBidSignPayload, buildCarrierPodSubmissionSignPayload, buildShipperPodReviewSignPayload } from "../v2/auth/canonical";
import { bidSubmitResource, tenderActivateResource } from "../v2/access/resource";
import { MirrorAccessPaymentReconciler, hashScanTransactionUrl, verifyUsdcAccessPaymentOnMirror } from "../v2/access/mirror-reconcile";
import { X402AccessGate } from "../v2/access/x402-gate";
import { resolveV2AccessConfig } from "../v2/config";
import { buildAllocateWinnerPlan, buildFundTenderPlan, buildRegisterTenderPlan } from "../v2/escrow/requests";
import { parseEscrowEvents } from "../v2/escrow/events";
import { escrowTenderKey } from "../v2/escrow/tender-key";
import { createV2AccessApp } from "../v2/http/routes";
import { buildDemoAllowancePlan, executeDemoAllowance } from "../v2/live/allowance";
import { createTestnetClient } from "../v2/live/client";
import { ContractExecutor } from "../v2/live/contract-executor";
import { HcsV2Submitter } from "../v2/live/hcs-submitter";
import { MirrorReader, type MirrorTransactionResult } from "../v2/live/mirror-reader";
import { X402Payer } from "../v2/live/x402-payer";
import { createTrustPolicy } from "../v2/trust/policy";
import { parseV2FreightTender, type V2FreightTender } from "../v2/schemas/tender";
import { parseV2CarrierBid, v2BidHash } from "../v2/schemas/bid";
import { FileBidBodyStore } from "../v2/store/bid-body-store";
import { LifecycleService } from "../v2/store/lifecycle-service";
import { FileLifecycleStore } from "../v2/store/lifecycle-store";
import { FilePaymentClaimStore } from "../v2/store/payment-claim-store";
import { AesGcmMasterKeyProtector, parseMasterKeyBase64 } from "../v2/pod/key-protector";
import { buildCanonicalManifest, manifestHash, packageContentHash } from "../v2/pod/manifest";
import { PodService, type PodReviewStartResult, type PodSubmitResult, type ShipperReviewResult } from "../v2/pod/service";
import { FilePodEncryptedStore } from "../v2/pod/storage";
import type { PodFileInput, PodPackageFields } from "../v2/pod/types";
import { FileV2TenderCatalog } from "../v2/http/app";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createOperationsDemoApp } from "./api";
import { LiveHederaAdapter, SimulationAdapter, type AdapterActionResult, type AdapterExecutionContext } from "./adapters";
import type { OperationsDemoConfig } from "./config";
import {
  DEMO_CARRIER_TREASURY_ACCOUNT_ID,
  DEMO_CONTRACT_EVM_ADDRESS,
  DEMO_CONTRACT_ID,
  DEMO_HCS_TOPIC_ID,
  DEMO_MAX_BUDGET_ATOMIC,
  DEMO_OPERATOR_ACCOUNT_ID,
  DEMO_TOKEN_ID,
  DEMO_WINNING_AMOUNT_ATOMIC,
  DEMO_EXCESS_REFUND_ATOMIC,
  DEMO_X402_ACCESS_FEE_ATOMIC,
} from "./constants";
import { DemoError } from "./errors";
import { OperationsDemoOrchestrator, type OperationsPodWorkflow } from "./orchestrator";
import { TransactionReceiptJournal } from "./receipt-journal";
import { CompletedReplayAdapter } from "./replay";
import { OperationsDemoStore } from "./store";
import type { DemoActionRequest, DemoWorkflowState, OperationsDemoSession, PublicTransactionReference } from "./types";
import type { LivePreflightReport, LiveSecrets, LiveSessionPlan } from "./live-preflight";

export type SupervisedRuntimeState = {
  readonly schemaVersion: "routeguard-operations-live-runtime-1.0";
  readonly createdAt: string;
  readonly auctionEndsAt: string;
  readonly bidSignedAt: string;
  readonly acceptanceSignedAt: string | null;
};

/** Leaves room for bounded Mirror polling and supervised process recovery. */
export const SUPERVISED_AUCTION_WINDOW_MS = 30 * 60_000;

export type LiveOperationsComposition = {
  readonly orchestrator: OperationsDemoOrchestrator;
  readonly store: OperationsDemoStore;
  readonly lifecycle: LifecycleService;
  readonly podService: PodService;
  readonly operationsApp: ReturnType<typeof createOperationsDemoApp>;
  readonly accessApp: ReturnType<typeof createV2AccessApp>;
  readonly close: () => void;
};

function now(): string { return new Date().toISOString(); }
function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function toBytes32(hash: string): string {
  const match = /^sha256:([0-9a-f]{64})$/.exec(hash);
  if (!match) throw new Error("sha256 hash cannot be converted to bytes32");
  return `0x${match[1]}`;
}
function longZero(id: string): string {
  const value = BigInt(id.split(".")[2] ?? "-1");
  if (value < 0n) throw new Error("Hedera id invalid");
  return `0x${value.toString(16).padStart(40, "0")}`;
}

function runtimePath(demoDataDir: string): string { return path.join(demoDataDir, "live-runtime.json"); }
export function loadOrCreateSupervisedRuntime(demoDataDir: string, clock: () => string = now): SupervisedRuntimeState {
  const file = runtimePath(demoDataDir);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as SupervisedRuntimeState;
  mkdirSync(path.dirname(file), { recursive: true });
  const createdAt = clock();
  const value: SupervisedRuntimeState = {
    schemaVersion: "routeguard-operations-live-runtime-1.0",
    createdAt,
    auctionEndsAt: new Date(Date.parse(createdAt) + SUPERVISED_AUCTION_WINDOW_MS).toISOString(),
    bidSignedAt: createdAt,
    acceptanceSignedAt: null,
  };
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return value;
}
function saveRuntime(demoDataDir: string, runtime: SupervisedRuntimeState): void {
  writeFileSync(runtimePath(demoDataDir), `${JSON.stringify(runtime, null, 2)}\n`, "utf8");
}

function buildTender(plan: LiveSessionPlan, runtime: SupervisedRuntimeState): V2FreightTender {
  return parseV2FreightTender({
    tenderId: plan.tenderId,
    shipperId: "shipper-operations-demo",
    origin: "Los Angeles",
    destination: "Phoenix",
    cargo: { type: "synthetic-palletized-dry-freight", weightKg: 12_500, pallets: 18, dangerousGoods: false },
    requiredEquipment: "Dry Van",
    pickupWindow: { earliest: "2026-08-05T08:00:00.000Z", latest: "2026-08-06T08:00:00.000Z" },
    deliveryDeadline: "2026-08-08T23:59:59.000Z",
    auctionEndsAt: runtime.auctionEndsAt,
    maximumFreightBudgetAtomic: DEMO_MAX_BUDGET_ATOMIC,
    selectionPolicy: "LOWEST_QUALIFIED_PRICE_V1",
    version: 1,
    reviewWindowSeconds: 172_800,
    correctionWindowSeconds: 86_400,
    postResubmitReviewWindowSeconds: 86_400,
    escrowContractId: DEMO_CONTRACT_ID,
    shipperAccountId: DEMO_OPERATOR_ACCOUNT_ID,
  });
}

async function pollMirror(mirror: MirrorReader, transactionId: string, includeLogs = false): Promise<MirrorTransactionResult> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await mirror.transaction(transactionId, includeLogs);
    if (result.status === "SUCCESS") return result;
    if (result.status === "FAILED") throw new Error("Mirror confirmed transaction failure");
    await wait(2_000);
  }
  throw new DemoError("DEMO_MIRROR_UNAVAILABLE", "Mirror verification timed out", 503);
}

function transferSum(result: MirrorTransactionResult, accountId: string): bigint {
  return result.tokenTransfers.filter((leg) => leg.tokenId === DEMO_TOKEN_ID && leg.accountId === accountId)
    .reduce((sum, leg) => sum + BigInt(leg.amount), 0n);
}

async function pollContractState(mirror: MirrorReader, tenderKey: string, expectedState: number, expectedBalance: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const [state, balance] = await Promise.all([
      mirror.contractCall(DEMO_CONTRACT_EVM_ADDRESS, "getState", [tenderKey]),
      mirror.contractCall(DEMO_CONTRACT_EVM_ADDRESS, "tenderBalance", [tenderKey]),
    ]);
    if (Number(state[0]) === expectedState && String(balance[0]) === expectedBalance) return;
    await wait(2_000);
  }
  throw new DemoError("DEMO_MIRROR_UNAVAILABLE", "contract state did not converge", 503);
}

async function mirrorAllowance(fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(`https://testnet.mirrornode.hedera.com/api/v1/accounts/${DEMO_OPERATOR_ACCOUNT_ID}/allowances/tokens?limit=100&spender.id=${DEMO_CONTRACT_ID}`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Mirror allowance HTTP ${response.status}`);
  const body = await response.json() as { allowances?: Array<{ token_id?: string; spender?: string; amount?: number }> };
  const allowance = (body.allowances ?? []).find((item) => item.token_id === DEMO_TOKEN_ID && item.spender === DEMO_CONTRACT_ID);
  return BigInt(allowance?.amount ?? 0).toString();
}

function transactionRef(action: DemoActionRequest["action"], transactionId: string): PublicTransactionReference {
  return { action, transactionId, hashScanUrl: hashScanTransactionUrl(transactionId), simulated: false, receiptStatus: "SUCCESS", mirrorVerified: true };
}

function outboxEnvelope(context: AdapterExecutionContext | undefined, expected: string): HcsV2Envelope {
  const result = context?.podResult as PodSubmitResult | PodReviewStartResult | ShipperReviewResult | undefined;
  const item = result?.outbox.find((entry) => entry.kind === expected);
  if (!item) throw new Error(`${expected} outbox item missing`);
  return item.envelope;
}

export function createLiveOperationsComposition(input: {
  readonly config: OperationsDemoConfig;
  readonly plan: LiveSessionPlan;
  readonly secrets: LiveSecrets;
  readonly preflight: LivePreflightReport;
  readonly getBaseUrl: () => string;
  readonly fetchImpl?: typeof fetch;
}): LiveOperationsComposition {
  const { config, plan, secrets, preflight } = input;
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const runtime = loadOrCreateSupervisedRuntime(config.demoDataDir);
  const tender = buildTender(plan, runtime);
  const tenderHash = canonicalSha256(tender);
  const carriers = new InMemoryCarrierRegistry([{
    carrierId: plan.carrierId,
    carrierAccountId: DEMO_CARRIER_TREASURY_ACCOUNT_ID,
    signingPublicKey: secrets.carrierPublicKey,
    active: true,
    allowedEquipment: ["Dry Van"],
    registryVersion: 1,
  }]);
  const lifecycle = new LifecycleService(new FileLifecycleStore(path.join(config.v2DataDir, "lifecycle")), { carriers });
  const tenderDir = path.join(config.v2DataDir, "tenders");
  mkdirSync(tenderDir, { recursive: true });
  const tenderFile = path.join(tenderDir, `tender-${plan.tenderId}-v1.json`);
  if (!existsSync(tenderFile)) writeFileSync(tenderFile, `${JSON.stringify(tender, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const accessConfig = resolveV2AccessConfig({ ENABLE_V2_ACCESS_ROUTES: "true", ROUTEGUARD_ACCESS_TREASURY_ACCOUNT_ID: DEMO_CARRIER_TREASURY_ACCOUNT_ID, USDC_TOKEN_ID: DEMO_TOKEN_ID });
  const accessApp = createV2AccessApp({
    lifecycle,
    bidBodies: new FileBidBodyStore(path.join(config.v2DataDir, "bids")),
    tenders: new FileV2TenderCatalog(tenderDir),
    carriers,
    gate: new X402AccessGate({ facilitator: new HTTPFacilitatorClient({ url: secrets.facilitatorUrl }), config: accessConfig, now }),
    paymentClaims: new FilePaymentClaimStore(path.join(config.v2DataDir, "payment-claims")),
    paymentReconciler: new MirrorAccessPaymentReconciler({ fetchImpl }),
    config: accessConfig,
    now,
  });
  const mirror = new MirrorReader({ fetchImpl });
  const operatorClient = createTestnetClient({ network: "hedera:testnet", accountId: DEMO_OPERATOR_ACCOUNT_ID, privateKey: secrets.operatorPrivateKey });
  const contractExecutor = new ContractExecutor({ contractId: DEMO_CONTRACT_ID, contractEvmAddress: DEMO_CONTRACT_EVM_ADDRESS, tokenId: DEMO_TOKEN_ID });
  const hcsSubmitter = new HcsV2Submitter(DEMO_HCS_TOPIC_ID);
  const x402Payer = new X402Payer({
    network: "hedera:testnet", payerAccountId: DEMO_OPERATOR_ACCOUNT_ID, privateKey: secrets.operatorPrivateKey,
    tokenId: DEMO_TOKEN_ID, payTo: DEMO_CARRIER_TREASURY_ACCOUNT_ID, amountAtomic: DEMO_X402_ACCESS_FEE_ATOMIC,
    feePayer: preflight.facilitatorFeePayer || FINAL_DEMO_FACILITATOR_FEE_PAYER,
  }, fetchImpl);
  const podService = new PodService({
    lifecycle,
    podStore: new FilePodEncryptedStore(config.podDataDir),
    keyProtector: new AesGcmMasterKeyProtector(parseMasterKeyBase64(secrets.podMasterKeyBase64)),
    carriers,
    now,
    escrowContractId: DEMO_CONTRACT_ID,
    escrowContractEvm: DEMO_CONTRACT_EVM_ADDRESS,
  });
  const store = new OperationsDemoStore(config.demoDataDir);
  const journal = new TransactionReceiptJournal(store);

  async function ensureLifecycle(): Promise<void> {
    if (await lifecycle.get(plan.tenderId)) return;
    const trust = createTrustPolicy({
      shipperPublicKey: secrets.operatorPublicKey,
      referees: [{ refereeId: "human-operations-demo-referee", publicKey: secrets.carrierPublicKey }],
      accessTreasuryAccountId: DEMO_CARRIER_TREASURY_ACCOUNT_ID,
    });
    await lifecycle.create({ tenderId: plan.tenderId, tenderVersion: 1, tenderHash, maximumFreightBudgetAtomic: DEMO_MAX_BUDGET_ATOMIC, auctionEndsAt: runtime.auctionEndsAt, createdAt: runtime.createdAt, trust });
  }

  async function journaled(inputStep: {
    session: OperationsDemoSession;
    request: DemoActionRequest;
    intendedState: DemoWorkflowState;
    subStep: string;
    submit: (receipt: (transactionId: string, hcsSequence?: number) => Promise<void>) => Promise<{ transactionId: string; hcsSequence?: number }>;
    verify: (transactionId: string, hcsSequence?: number) => Promise<unknown>;
  }): Promise<{ reference: PublicTransactionReference; hcsSequence?: number; evidenceHash: string }> {
    const { session, request, intendedState, subStep } = inputStep;
    const latest = store.get(session.sessionId) ?? session;
    let prior = journal.findSuccessfulReceipt(latest, request.actionId, subStep);
    if (prior?.status === "VERIFIED" && prior.verificationStatus === "VERIFIED" && prior.publicTransactionId && prior.safeEvidenceHash) {
      return {
        reference: transactionRef(request.action, prior.publicTransactionId),
        ...(prior.hcsSequence !== null ? { hcsSequence: prior.hcsSequence } : {}),
        evidenceHash: prior.safeEvidenceHash,
      };
    }
    if (!prior) {
      await journal.plan({
        sessionId: session.sessionId, action: request.action, actionId: request.actionId,
        idempotencyKeyHash: canonicalSha256(request.idempotencyKey), payloadHash: canonicalSha256(request.payload),
        expectedPreviousState: session.lastConfirmedState, intendedNextState: intendedState, subStep,
      });
      await journal.progress({ sessionId: session.sessionId, actionId: request.actionId, progress: "SIGNING" });
      await journal.progress({ sessionId: session.sessionId, actionId: request.actionId, progress: "SUBMITTING" });
      const submitted = await inputStep.submit(async (transactionId, hcsSequence) => {
        await journal.receipt({ sessionId: session.sessionId, actionId: request.actionId, subStep, transactionId, ...(hcsSequence !== undefined ? { hcsSequence } : {}) });
      });
      prior = journal.findSuccessfulReceipt(store.get(session.sessionId)!, request.actionId, subStep);
      if (!prior || prior.publicTransactionId !== submitted.transactionId) throw new Error("successful receipt was not durably journaled");
    }
    await journal.progress({ sessionId: session.sessionId, actionId: request.actionId, progress: "VERIFYING_THROUGH_MIRROR" });
    const evidence = await inputStep.verify(prior.publicTransactionId!, prior.hcsSequence ?? undefined);
    const evidenceHash = canonicalSha256(evidence);
    await journal.verify({ sessionId: session.sessionId, actionId: request.actionId, subStep, evidenceHash, ...(prior.hcsSequence !== null ? { hcsSequence: prior.hcsSequence } : {}) });
    return { reference: transactionRef(request.action, prior.publicTransactionId!), ...(prior.hcsSequence !== null ? { hcsSequence: prior.hcsSequence } : {}), evidenceHash };
  }

  async function hcsStep(session: OperationsDemoSession, request: DemoActionRequest, intendedState: DemoWorkflowState, subStep: string, envelope: HcsV2Envelope, expectedSequence: number) {
    return journaled({ session, request, intendedState, subStep,
      submit: async (durable) => {
        const receipt = await hcsSubmitter.submit(operatorClient, envelope, (record) => durable(record.transactionId, record.sequenceNumber));
        return { transactionId: receipt.transactionId, hcsSequence: receipt.sequenceNumber };
      },
      verify: async (transactionId, sequence) => {
        const tx = await pollMirror(mirror, transactionId);
        if (sequence !== expectedSequence) throw new Error(`unexpected HCS sequence ${String(sequence)}`);
        const message = await mirror.topicMessage(DEMO_HCS_TOPIC_ID, expectedSequence);
        if (!message || Buffer.from(message.messageBase64, "base64").toString("utf8") !== serializeHcsV2Envelope(envelope)) throw new Error("HCS Mirror envelope mismatch");
        return { transactionId, consensusTimestamp: tx.consensusTimestamp, sequence, envelopeHash: canonicalSha256(envelope) };
      },
    });
  }

  async function executeLive(session: OperationsDemoSession, request: DemoActionRequest, intendedState: DemoWorkflowState, context?: AdapterExecutionContext): Promise<AdapterActionResult> {
    const transactions: PublicTransactionReference[] = [];
    const hcsSequences: number[] = [];
    const evidenceHashes: string[] = [];
    const add = (result: Awaited<ReturnType<typeof journaled>>) => { transactions.push(result.reference); if (result.hcsSequence !== undefined) hcsSequences.push(result.hcsSequence); evidenceHashes.push(result.evidenceHash); };
    if (request.action === "FUND_ESCROW") {
      await ensureLifecycle();
      const register = buildRegisterTenderPlan({ tenderId: plan.tenderId, tenderVersion: 1, shipperAddress: preflight.operatorEvmAddress, maximumFreightBudgetAtomic: DEMO_MAX_BUDGET_ATOMIC, escrowTokenAddress: longZero(DEMO_TOKEN_ID), creationAuthorizationHash: plan.creationAuthorizationHash, manifestHash: toBytes32(tenderHash) });
      add(await journaled({ session, request, intendedState, subStep: "register-tender",
        submit: async (durable) => { const receipt = await contractExecutor.execute(operatorClient, register, (item) => durable(item.transactionId)); return { transactionId: receipt.transactionId }; },
        verify: async (transactionId) => { const tx = await pollMirror(mirror, transactionId, true); await pollContractState(mirror, plan.tenderKey, 1, "0"); const events = parseEscrowEvents(tx.logs); if (!events.some((event) => event.name === "TenderEscrowRegistered")) throw new Error("registration event missing"); return { transactionId, consensusTimestamp: tx.consensusTimestamp, events }; },
      }));
      const allowancePlan = buildDemoAllowancePlan({ tokenId: DEMO_TOKEN_ID, ownerAccountId: DEMO_OPERATOR_ACCOUNT_ID, spenderContractId: DEMO_CONTRACT_ID, amountAtomic: DEMO_MAX_BUDGET_ATOMIC });
      add(await journaled({ session, request, intendedState, subStep: "approve-exact-allowance",
        submit: async (durable) => { const receipt = await executeDemoAllowance(operatorClient, allowancePlan, (item) => durable(item.transactionId)); return { transactionId: receipt.transactionId }; },
        verify: async (transactionId) => { const tx = await pollMirror(mirror, transactionId); const allowance = await mirrorAllowance(fetchImpl); if (allowance !== DEMO_MAX_BUDGET_ATOMIC) throw new Error("exact allowance was not visible on Mirror"); return { transactionId, consensusTimestamp: tx.consensusTimestamp, allowanceAtomic: allowance }; },
      }));
      const fund = buildFundTenderPlan({ tenderId: plan.tenderId, tenderVersion: 1, maximumFreightBudgetAtomic: DEMO_MAX_BUDGET_ATOMIC });
      const funded = await journaled({ session, request, intendedState, subStep: "fund-escrow",
        submit: async (durable) => { const receipt = await contractExecutor.execute(operatorClient, fund, (item) => durable(item.transactionId)); return { transactionId: receipt.transactionId }; },
        verify: async (transactionId) => { const tx = await pollMirror(mirror, transactionId, true); await pollContractState(mirror, plan.tenderKey, 2, DEMO_MAX_BUDGET_ATOMIC); if (transferSum(tx, DEMO_OPERATOR_ACCOUNT_ID) !== -20_000n || transferSum(tx, DEMO_CONTRACT_ID) !== 20_000n) throw new Error("funding token transfers mismatch"); return { transactionId, consensusTimestamp: tx.consensusTimestamp, tokenTransfers: tx.tokenTransfers, events: parseEscrowEvents(tx.logs) }; },
      });
      add(funded);
      const fundingTx = transactions.at(-1)!.transactionId;
      const fundingMirror = await mirror.transaction(fundingTx);
      const record = await lifecycle.get(plan.tenderId);
      if (record?.state === "DRAFT") await lifecycle.apply(plan.tenderId, { type: "ESCROW_FUNDING_CONFIRMED", actionId: `${request.actionId}:lifecycle`, eventTime: fundingMirror.consensusTimestamp ? mirrorTimestampToUtcIso(fundingMirror.consensusTimestamp) : now(), fundingTxId: fundingTx, tokenId: DEMO_TOKEN_ID, fundedAmountAtomic: DEMO_MAX_BUDGET_ATOMIC, tenderId: plan.tenderId, tenderVersion: 1 });
    } else if (request.action === "OPEN_TENDER" || request.action === "SUBMIT_OFFER") {
      const isOpen = request.action === "OPEN_TENDER";
      const resource = isOpen ? tenderActivateResource(plan.tenderId, 1) : bidSubmitResource(plan.tenderId, 1, plan.bidId);
      let body: Record<string, unknown> = { actionId: request.actionId };
      if (!isOpen) {
        const bid = parseV2CarrierBid({ bidId: plan.bidId, tenderId: plan.tenderId, tenderVersion: 1, carrierId: plan.carrierId, carrierAccountId: DEMO_CARRIER_TREASURY_ACCOUNT_ID, freightAmountAtomic: DEMO_WINNING_AMOUNT_ATOMIC, equipment: "Dry Van", proposedPickupAt: "2026-08-05T08:00:00.000Z", estimatedDelivery: "2026-08-08T18:00:00.000Z", capacityConfirmed: true, bidValidUntil: runtime.auctionEndsAt, commitmentSalt: plan.bidCommitmentSalt, nonce: `nonce-${plan.runId}`, version: 1 });
        const signature = signCanonicalPayload(buildCarrierBidSignPayload({ tenderId: plan.tenderId, tenderVersion: 1, bidId: plan.bidId, carrierId: plan.carrierId, carrierAccountId: DEMO_CARRIER_TREASURY_ACCOUNT_ID, bidHash: v2BidHash(bid), signedAt: runtime.bidSignedAt, actionId: request.actionId }), secrets.carrierPrivateKey);
        body = { actionId: request.actionId, signedAt: runtime.bidSignedAt, signature, bid };
      }
      const subStep = isOpen ? "x402-tender-access" : "x402-carrier-offer";
      const lifecycleBefore = await lifecycle.get(plan.tenderId);
      const recovered = lifecycleBefore?.accessPayments.find((payment) => payment.actionId === request.actionId);
      const result = await journaled({ session, request, intendedState, subStep,
        submit: async (durable) => {
          if (recovered) { await durable(recovered.paymentTransactionId); return { transactionId: recovered.paymentTransactionId }; }
          const paid = await x402Payer.pay({ resourceUrl: resource, requestUrl: `${input.getBaseUrl()}${resource}`, body, journalReceipt: (item) => durable(item.transactionId) });
          return { transactionId: paid.transactionId };
        },
        verify: async (transactionId) => {
          let verified = await verifyUsdcAccessPaymentOnMirror({ transactionId, payerAccount: DEMO_OPERATOR_ACCOUNT_ID, treasuryAccount: DEMO_CARRIER_TREASURY_ACCOUNT_ID, asset: DEMO_TOKEN_ID, amountAtomic: DEMO_X402_ACCESS_FEE_ATOMIC, fetchImpl });
          for (let attempt = 0; attempt < 30 && verified.status !== "SUCCESS"; attempt += 1) { await wait(2_000); verified = await verifyUsdcAccessPaymentOnMirror({ transactionId, payerAccount: DEMO_OPERATOR_ACCOUNT_ID, treasuryAccount: DEMO_CARRIER_TREASURY_ACCOUNT_ID, asset: DEMO_TOKEN_ID, amountAtomic: DEMO_X402_ACCESS_FEE_ATOMIC, fetchImpl }); }
          if (verified.status !== "SUCCESS" || !verified.amountAtomicMatch || !verified.payerMatch || !verified.treasuryMatch) throw new DemoError("DEMO_MIRROR_UNAVAILABLE", "x402 settlement did not verify", 503);
          return verified;
        },
      });
      add(result);
    } else if (request.action === "SELECT_WINNER") {
      let record = (await lifecycle.get(plan.tenderId))!;
      if (record.state === "BIDDING") {
        const remaining = Date.parse(runtime.auctionEndsAt) - Date.now();
        if (remaining > 0) await wait(remaining + 1_000);
        const closeAt = now();
        const bidEntry = record.bidRegistry.find((entry) => entry.bidId === plan.bidId)!;
        const authoritativeBidSetHash = canonicalSha256(record.bidRegistry.map((entry) => ({ bidId: entry.bidId, bidHash: entry.bidHash, acceptedAt: entry.acceptedAt })));
        await lifecycle.apply(plan.tenderId, { type: "AUCTION_CLOSE_CONFIRMED", actionId: `${request.actionId}:close`, eventTime: closeAt, auctionEndsAt: runtime.auctionEndsAt, closureProofRef: canonicalSha256({ runId: plan.runId, authoritativeBidSetHash }), authoritativeBidSetHash });
        const decisionManifestHash = canonicalSha256({ policy: "LOWEST_QUALIFIED_PRICE_V1", winningBidId: plan.bidId, carrierId: plan.carrierId, carrierAccount: DEMO_CARRIER_TREASURY_ACCOUNT_ID, winningAmountAtomic: DEMO_WINNING_AMOUNT_ATOMIC, authoritativeBidSetHash, bidHash: bidEntry.bidHash });
        await lifecycle.apply(plan.tenderId, { type: "WINNER_SELECTION_CONFIRMED", actionId: `${request.actionId}:winner`, eventTime: now(), decisionManifestHash, winningBidId: plan.bidId, winningCarrierId: plan.carrierId, winningCarrierAccount: DEMO_CARRIER_TREASURY_ACCOUNT_ID, winningAmountAtomic: DEMO_WINNING_AMOUNT_ATOMIC, selectionPolicy: "LOWEST_QUALIFIED_PRICE_V1" });
        record = (await lifecycle.get(plan.tenderId))!;
      }
      const decisionManifestHash = record.decisionManifestHash!;
      const allocation = buildAllocateWinnerPlan({ tenderId: plan.tenderId, tenderVersion: 1, winnerAddress: longZero(DEMO_CARRIER_TREASURY_ACCOUNT_ID), fundedAmountAtomic: DEMO_MAX_BUDGET_ATOMIC, winningAmountAtomic: DEMO_WINNING_AMOUNT_ATOMIC, decisionManifestHash: toBytes32(decisionManifestHash), allocationAuthorizationHash: plan.allocationAuthorizationHash });
      const allocated = await journaled({ session, request, intendedState, subStep: "allocate-winner",
        submit: async (durable) => { const receipt = await contractExecutor.execute(operatorClient, allocation.plan, (item) => durable(item.transactionId)); return { transactionId: receipt.transactionId }; },
        verify: async (transactionId) => { const tx = await pollMirror(mirror, transactionId, true); await pollContractState(mirror, plan.tenderKey, 3, DEMO_WINNING_AMOUNT_ATOMIC); if (transferSum(tx, DEMO_OPERATOR_ACCOUNT_ID) !== 5_000n || transferSum(tx, DEMO_CONTRACT_ID) !== -5_000n || transferSum(tx, DEMO_CARRIER_TREASURY_ACCOUNT_ID) !== 0n) throw new Error("allocation/refund token transfers mismatch"); return { transactionId, consensusTimestamp: tx.consensusTimestamp, childTransactionCount: tx.childTransactionCount, tokenTransfers: tx.tokenTransfers, events: parseEscrowEvents(tx.logs) }; },
      });
      add(allocated);
      record = (await lifecycle.get(plan.tenderId))!;
      if (record.state === "WINNER_SELECTED") {
        await lifecycle.apply(plan.tenderId, { type: "WINNING_AMOUNT_ALLOCATION_CONFIRMED", actionId: `${request.actionId}:allocation`, eventTime: now(), allocateTxId: allocated.reference.transactionId, refundExcessTxId: allocated.reference.transactionId, maxBudgetAtomic: DEMO_MAX_BUDGET_ATOMIC, winningAmountAtomic: DEMO_WINNING_AMOUNT_ATOMIC, excessRefundAtomic: DEMO_EXCESS_REFUND_ATOMIC, decisionManifestHash });
        await lifecycle.apply(plan.tenderId, { type: "ROUTE_RESERVATION_PUBLISHED", actionId: `${request.actionId}:reservation`, eventTime: now(), reservationEvidenceRef: canonicalSha256({ runId: plan.runId, kind: "LOCAL_RESERVATION" }), hcsPublicationRef: "HCS_OPTIONAL_MESSAGE_OMITTED" });
        await lifecycle.apply(plan.tenderId, { type: "TRANSIT_STARTED", actionId: `${request.actionId}:transit`, eventTime: now() });
        await lifecycle.apply(plan.tenderId, { type: "DELIVERY_REPORTED", actionId: `${request.actionId}:delivery`, eventTime: now() });
      }
    } else if (request.action === "SUBMIT_POD") {
      const result = await hcsStep(session, request, intendedState, "pod-submitted-hcs", outboxEnvelope(context, "POD_SUBMITTED"), 1); add(result);
    } else if (request.action === "RUN_ADVISORY") {
      const result = await hcsStep(session, request, intendedState, "pod-advisory-hcs", outboxEnvelope(context, "POD_ADVISORY_ANCHORED"), 2); add(result);
    } else if (request.action === "ACCEPT_POD") {
      const result = await hcsStep(session, request, intendedState, "pod-review-action-hcs", outboxEnvelope(context, "POD_REVIEW_ACTION"), 3); add(result);
    } else if (request.action === "RELEASE_FREIGHT") {
      const record = (await lifecycle.get(plan.tenderId))!;
      const acceptanceActionId = plan.actionIds.ACCEPT_POD;
      const releasePlan = podService.getReleasePlan(plan.tenderId, acceptanceActionId);
      if (!releasePlan) throw new Error("PodService release plan missing");
      const release = await journaled({ session, request, intendedState, subStep: "release-full",
        submit: async (durable) => { const receipt = await contractExecutor.execute(operatorClient, releasePlan.plan, (item) => durable(item.transactionId)); return { transactionId: receipt.transactionId }; },
        verify: async (transactionId) => { const tx = await pollMirror(mirror, transactionId, true); await pollContractState(mirror, plan.tenderKey, 5, "0"); if (transferSum(tx, DEMO_CONTRACT_ID) !== -15_000n || transferSum(tx, DEMO_CARRIER_TREASURY_ACCOUNT_ID) !== 15_000n) throw new Error("freight release token transfers mismatch"); return { transactionId, consensusTimestamp: tx.consensusTimestamp, tokenTransfers: tx.tokenTransfers, events: parseEscrowEvents(tx.logs) }; },
      });
      add(release);
      let next = (await lifecycle.get(plan.tenderId))!;
      if (next.state === "POD_ACCEPTED") await lifecycle.apply(plan.tenderId, { type: "ESCROW_RELEASE_CONFIRMED", actionId: `${request.actionId}:release`, eventTime: now(), releaseTxId: release.reference.transactionId, releaseAmountAtomic: DEMO_WINNING_AMOUNT_ATOMIC });
      next = (await lifecycle.get(plan.tenderId))!;
      const releasedEnvelope = buildHcsV2Envelope({ messageType: "ESCROW_RELEASED", tenderId: plan.tenderId, tenderVersion: 1, tenderHash, createdAt: now(), payload: { releaseTxId: release.reference.transactionId, amountAtomic: DEMO_WINNING_AMOUNT_ATOMIC, winnerAccount: DEMO_CARRIER_TREASURY_ACCOUNT_ID } });
      const releasedHcs = await hcsStep(session, request, intendedState, "escrow-released-hcs", releasedEnvelope, 4); add(releasedHcs);
      if (next.state === "PAYMENT_RELEASED") await lifecycle.apply(plan.tenderId, { type: "TENDER_COMPLETION_CONFIRMED", actionId: `${request.actionId}:complete`, eventTime: now() });
      const completeEnvelope = buildHcsV2Envelope({ messageType: "TENDER_COMPLETED", tenderId: plan.tenderId, tenderVersion: 1, tenderHash, createdAt: now(), payload: { finalState: "TENDER_COMPLETED", completionRef: releasedHcs.reference.transactionId } });
      const completedHcs = await hcsStep(session, request, intendedState, "tender-completed-hcs", completeEnvelope, 5); add(completedHcs);
    } else {
      throw new DemoError("DEMO_ACTION_NOT_ALLOWED", "unsupported live action", 409);
    }
    return { steps: [], transactions, hcsSequences, evidenceHashes, writes: 0 };
  }

  const adapter = new LiveHederaAdapter(DEMO_CONTRACT_ID, DEMO_HCS_TOPIC_ID, executeLive, mirror);
  const podWorkflow: OperationsPodWorkflow = {
    service: podService,
    buildSubmission: async (session, request) => {
      const files: PodFileInput[] = [
        { fileId: "delivery-receipt", documentType: "ELECTRONIC_DELIVERY_RECEIPT", filename: "synthetic-delivery-receipt.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ synthetic: true, route: "Los Angeles to Phoenix", delivery: "No physical delivery claimed" }), "utf8") },
        { fileId: "recipient-confirmation", documentType: "RECIPIENT_CONFIRMATION", filename: "synthetic-recipient-confirmation.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ synthetic: true, acceptedBy: "controlled-demo-shipper" }), "utf8") },
      ];
      const fields: PodPackageFields = { podId: plan.podId, podVersion: 1, tenderId: plan.tenderId, tenderVersion: 1, winningBidId: plan.bidId, escrowTenderKey: escrowTenderKey(plan.tenderId, 1), carrierId: plan.carrierId, carrierAccountId: DEMO_CARRIER_TREASURY_ACCOUNT_ID, deliveryTimestamp: "2026-08-08T18:00:00.000Z", recipientConfirmationPresent: true, cargoConditionCode: "GOOD", exceptionCodes: ["NONE"], submittedAt: now(), actionId: request.actionId };
      const manifest = await buildCanonicalManifest(files);
      const mHash = manifestHash(manifest);
      const pHash = packageContentHash(fields, manifest);
      const carrierSignature = signCanonicalPayload(buildCarrierPodSubmissionSignPayload({ ...fields, manifestHash: mHash, packageContentHash: pHash }), secrets.carrierPrivateKey);
      return { tenderId: plan.tenderId, tenderVersion: 1, podId: plan.podId, package: { ...fields, files, carrierSignature, manifestHash: mHash, packageContentHash: pHash } };
    },
    buildReview: (_session, request) => ({ tenderId: plan.tenderId, tenderVersion: 1, actionId: request.actionId, eventTime: now() }),
    buildAcceptance: async (_session, request) => {
      const record = (await lifecycle.get(plan.tenderId))!;
      if (!record.reviewDeadlineAt) throw new Error("review deadline missing");
      let signedAt = loadOrCreateSupervisedRuntime(config.demoDataDir).acceptanceSignedAt;
      if (!signedAt) {
        signedAt = now();
        saveRuntime(config.demoDataDir, { ...loadOrCreateSupervisedRuntime(config.demoDataDir), acceptanceSignedAt: signedAt });
      }
      const signature = signCanonicalPayload(buildShipperPodReviewSignPayload({ tenderId: plan.tenderId, tenderVersion: 1, podId: plan.podId, reviewAction: "ACCEPT", signedAt, reviewDeadlineAt: record.reviewDeadlineAt, actionId: request.actionId }), secrets.operatorPrivateKey);
      return { tenderId: plan.tenderId, tenderVersion: 1, podId: plan.podId, action: "ACCEPT", actionId: request.actionId, signedAt, signature };
    },
  };
  const orchestrator = new OperationsDemoOrchestrator(config, store, new CompletedReplayAdapter(), new SimulationAdapter(), adapter, now, podWorkflow, () => ({ sessionId: plan.sessionId, runId: plan.runId, tenderId: plan.tenderId, podId: plan.podId, shipperActionId: plan.shipperActionId }));
  orchestrator.initialize();
  const operationsApp = createOperationsDemoApp({ orchestrator, config, mirror });
  return { orchestrator, store, lifecycle, podService, operationsApp, accessApp, close: () => operatorClient.close() };
}
