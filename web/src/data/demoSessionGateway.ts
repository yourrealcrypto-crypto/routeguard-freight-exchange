import type { DemoActionResult, DemoCapabilities, DemoMode, DemoSessionGateway, DemoSessionSnapshot, LifecycleState, Role } from './demoSessionTypes';
import { getRouteGuardEvidence } from './routeguardEvidence';

type ApiMode = 'SIMULATION' | 'LIVE';
type ApiSession = {
  sessionId: string;
  mode: ApiMode;
  role: Role;
  scenario: { tenderId: string; origin: string; destination: string; transportMode: string; equipment: string; weightKg: number; pickupWindow: string; deliveryDeadline: string; illustrativeCommercialQuoteUsdc: string };
  workflowState: string;
  availableActions: string[];
  writesUsed: number;
  fixedAmounts: { maximumBudgetAtomic: string; winningAmountAtomic: string; excessRefundAtomic: string };
  transactions: Array<{ transactionId: string }>;
  contractId: string | null;
  topicId: string | null;
  hcsSequences: number[];
  escrowState: string;
  lockedAmountAtomic: string;
  recoverableError: { code: string; message: string } | null;
};
type ReplayProof = { contractId: string; topicId: string; releaseTransactionId: string; hcsSequence: Array<{ sequenceNumber: number }>; finalState: 'RELEASED'; lockedAmountAtomic: '0'; networkWrites: 0; immutable: true };

const snapshots = new Map<string, DemoSessionSnapshot>();
const apiModes = new Map<string, ApiMode>();
const timeoutMs = 10_000;

export class DemoGatewayError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { ...init, signal: controller.signal, headers: { 'content-type': 'application/json', ...init.headers } });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new DemoGatewayError(String(body.error ?? 'DEMO_REQUEST_FAILED'), String(body.message ?? `Request failed (${response.status})`), response.status);
    return body as T;
  } catch (error) {
    if (error instanceof DemoGatewayError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') throw new DemoGatewayError('DEMO_REQUEST_TIMEOUT', 'The server did not respond before the safe timeout.', 504);
    throw new DemoGatewayError('DEMO_CONNECTION_FAILED', 'The same-origin RouteGuard gateway is unavailable.', 503);
  } finally { window.clearTimeout(timer); }
}

const dollars = (atomic: string) => Number(atomic) / 1_000_000;
const stateMap: Record<string, LifecycleState> = {
  CREATED: 'SHIPMENT_DEFINED', ESCROW_FUNDED: 'ESCROW_FUNDED', ACCESS_ACTIVATED: 'TENDER_OPEN', OFFER_ACCEPTED: 'OFFER_SUBMITTED',
  WINNER_ALLOCATED: 'WINNING_AMOUNT_LOCKED', POD_SUBMITTED: 'POD_SUBMITTED', ADVISORY_ANCHORED: 'POD_SUBMITTED', POD_ACCEPTED: 'POD_ACCEPTED', COMPLETED: 'COMPLETED',
};
const stepMap: Record<string, number> = { CREATED: 2, ESCROW_FUNDED: 3, ACCESS_ACTIVATED: 4, OFFER_ACCEPTED: 5, WINNER_ALLOCATED: 6, POD_SUBMITTED: 7, ADVISORY_ANCHORED: 7, POD_ACCEPTED: 8, COMPLETED: 8 };

function draft(mode: DemoMode, role: Role, liveEnabled = false, reason = ''): DemoSessionSnapshot {
  return {
    mode, connectionStatus: mode === 'local-simulation' ? 'LOCAL ENGINE · ZERO NETWORK WRITES' : liveEnabled ? 'CONTROLLED HEDERA TESTNET' : `TESTNET DISABLED · ${reason || 'SERVER POLICY'}`,
    sessionId: `local:${mode}:not-started`, role, scenarioId: 'lax-phx', currentStep: 1, lifecycleState: 'DRAFT',
    route: 'Los Angeles → Phoenix', transportMode: 'Truck', equipment: 'Dry Van', weight: '12,500 kg', pickupWindow: '05–06 Aug 2026', deliveryDeadline: '08 Aug 2026',
    illustrativeQuote: '1,850 USDC', maxBudget: '0.02 USDC', maxBudgetNumeric: 0.02, carrierOffers: [], podState: 'PENDING', settlementState: 'PENDING',
    writeCount: 0, latestTransaction: 'LOCAL_SIMULATION_NO_TRANSACTION', hcsTopic: 'LOCAL_SIMULATION_NO_TOPIC', hcsSequence: '0', escrowState: 'NOT FUNDED', lockedAmount: 0,
    availableActions: liveEnabled || mode === 'local-simulation' ? ['DEFINE_SHIPMENT'] : [], apiSession: false, liveEnabled,
  };
}

function replaySnapshot(role: Role, proof: ReplayProof): DemoSessionSnapshot {
  const evidence = getRouteGuardEvidence();
  return {
    mode: 'completed-replay', connectionStatus: 'IMMUTABLE HEDERA TESTNET EVIDENCE', sessionId: 'replay:routeguard-v2-completed-proof', role, scenarioId: 'sea-chi', currentStep: 8, lifecycleState: 'COMPLETED',
    route: 'Seattle → Chicago', transportMode: evidence.auction.transportMode ?? 'Intermodal', equipment: evidence.auction.equipmentType ?? '40ft FCL', weight: evidence.auction.weight ?? '18,000 kg',
    pickupWindow: evidence.auction.pickupWindow ?? '03–04 Aug 2026', deliveryDeadline: evidence.auction.deliveryDeadline ?? '08 Aug 2026', illustrativeQuote: '1.00 USDC', maxBudget: evidence.economics.maximumFreightPrincipal.display, maxBudgetNumeric: 1,
    carrierOffers: [{ carrierId: 'carrier-alpha', amountUsdc: 0.75, qualification: 'qualified', selectionResult: 'winner', reason: 'Lowest valid qualified offer', evidenceClassification: 'live-proven-winning-offer' }],
    selectedWinner: 'carrier-alpha', winningAmount: 0.75, excessRefund: 0.25, lockedAmount: 0, podState: 'ACCEPTED', settlementState: 'RELEASED', writeCount: 0,
    latestTransaction: proof.releaseTransactionId, hcsTopic: proof.topicId, hcsSequence: String(proof.hcsSequence.at(-1)?.sequenceNumber ?? 5), escrowState: proof.finalState, availableActions: [], apiSession: false, liveEnabled: false,
  };
}

function fromApi(session: ApiSession, mode: DemoMode, role = session.role): DemoSessionSnapshot {
  const max = dollars(session.fixedAmounts.maximumBudgetAtomic);
  const allocated = ['WINNER_ALLOCATED', 'POD_SUBMITTED', 'ADVISORY_ANCHORED', 'POD_ACCEPTED', 'COMPLETED'].includes(session.workflowState);
  return {
    mode, connectionStatus: mode === 'local-simulation' ? 'LOCAL ENGINE · ZERO NETWORK WRITES' : 'CONTROLLED HEDERA TESTNET', sessionId: session.sessionId, role, scenarioId: session.scenario.tenderId,
    currentStep: stepMap[session.workflowState] ?? 1, lifecycleState: stateMap[session.workflowState] ?? 'DRAFT', route: `${session.scenario.origin} → ${session.scenario.destination}`,
    transportMode: session.scenario.transportMode, equipment: session.scenario.equipment, weight: `${session.scenario.weightKg.toLocaleString()} kg`, pickupWindow: session.scenario.pickupWindow.replace('/', '–'), deliveryDeadline: session.scenario.deliveryDeadline,
    illustrativeQuote: `${session.scenario.illustrativeCommercialQuoteUsdc} USDC`, maxBudget: `${max.toFixed(2)} USDC`, maxBudgetNumeric: max,
    carrierOffers: allocated || ['OFFER_ACCEPTED'].includes(session.workflowState) ? [{ carrierId: 'carrier-demo', amountUsdc: dollars(session.fixedAmounts.winningAmountAtomic), qualification: 'qualified', selectionResult: allocated ? 'winner' : 'pending', reason: 'Deterministic qualified offer', evidenceClassification: 'simulated-comparison-offer' }] : [],
    ...(allocated ? { selectedWinner: 'carrier-demo', winningAmount: dollars(session.fixedAmounts.winningAmountAtomic), excessRefund: dollars(session.fixedAmounts.excessRefundAtomic) } : {}),
    lockedAmount: dollars(session.lockedAmountAtomic), podState: session.workflowState === 'POD_SUBMITTED' || session.workflowState === 'ADVISORY_ANCHORED' ? 'SUBMITTED' : ['POD_ACCEPTED', 'COMPLETED'].includes(session.workflowState) ? 'ACCEPTED' : 'PENDING',
    settlementState: session.workflowState === 'COMPLETED' ? 'RELEASED' : 'PENDING', writeCount: session.writesUsed,
    latestTransaction: session.transactions.at(-1)?.transactionId ?? (mode === 'local-simulation' ? 'LOCAL_SIMULATION_NO_TRANSACTION' : 'NOT SUBMITTED'),
    hcsTopic: session.topicId ?? (mode === 'local-simulation' ? 'LOCAL_SIMULATION_NO_TOPIC' : 'NOT CREATED'), hcsSequence: String(session.hcsSequences.at(-1) ?? 0), escrowState: session.escrowState,
    ...(session.recoverableError ? { recoverableError: `${session.recoverableError.code}: ${session.recoverableError.message}` } : {}), availableActions: session.availableActions, apiSession: true, liveEnabled: mode === 'interactive-testnet',
  };
}

class ProductionDemoGateway implements DemoSessionGateway {
  private replayProof: ReplayProof | null = null;
  private liveAuthorization = '';

  setLiveAuthorization(token: string): void { this.liveAuthorization = token; }

  async createSession(mode: DemoMode, role: Role): Promise<DemoSessionSnapshot> {
    if (mode === 'completed-replay') {
      this.replayProof = await requestJson<ReplayProof>('/api/operations-demo/replay');
      const snap = replaySnapshot(role, this.replayProof); snapshots.set(snap.sessionId, snap); return snap;
    }
    if (mode === 'local-simulation') { const snap = draft(mode, role); snapshots.set(snap.sessionId, snap); return snap; }
    const capabilities = await requestJson<DemoCapabilities>('/api/operations-demo/capabilities');
    const snap = draft(mode, role, capabilities.liveModeEnabled, capabilities.liveModeReason); snapshots.set(snap.sessionId, snap); return snap;
  }

  async changeRole(sessionId: string, role: Role): Promise<DemoSessionSnapshot> { const snap = await this.getSession(sessionId); const next = { ...snap, role }; snapshots.set(sessionId, next); return next; }
  async defineShipment(sessionId: string): Promise<DemoActionResult> {
    const prior = snapshots.get(sessionId); if (!prior) throw new DemoGatewayError('DEMO_SESSION_NOT_FOUND', 'Session not found.', 404);
    if (prior.mode === 'interactive-testnet' && !prior.liveEnabled) return { success: false, snapshot: prior, error: prior.connectionStatus };
    if (prior.mode === 'interactive-testnet' && !this.liveAuthorization) return { success: false, snapshot: prior, error: 'A session-only operator authorization is required. It is never persisted.' };
    const apiMode: ApiMode = prior.mode === 'local-simulation' ? 'SIMULATION' : 'LIVE';
    const headers = apiMode === 'LIVE' ? { authorization: `Bearer ${this.liveAuthorization}` } : undefined;
    const session = await requestJson<ApiSession>('/api/operations-demo/sessions', { method: 'POST', ...(headers ? { headers } : {}), body: JSON.stringify({ mode: apiMode, role: prior.role }) });
    apiModes.set(session.sessionId, apiMode); const snap = fromApi(session, prior.mode, prior.role); snapshots.delete(sessionId); snapshots.set(snap.sessionId, snap); return { success: true, snapshot: snap };
  }

  private async act(sessionId: string, action: string, payload: Record<string, unknown> = {}): Promise<DemoActionResult> {
    const before = snapshots.get(sessionId); if (!before?.apiSession) return { success: false, snapshot: before ?? draft('local-simulation', 'SHIPPER'), error: 'Define the shipment first.' };
    const nonce = crypto.randomUUID();
    await requestJson(`/api/operations-demo/sessions/${encodeURIComponent(sessionId)}/actions`, { method: 'POST', body: JSON.stringify({ action, actionId: `ui-${action.toLowerCase()}-${nonce}`, idempotencyKey: `routeguard-ui-${nonce}`, payload }) });
    const session = await requestJson<ApiSession>(`/api/operations-demo/sessions/${encodeURIComponent(sessionId)}`); const snap = fromApi(session, before.mode, before.role); snapshots.set(sessionId, snap); return { success: true, snapshot: snap };
  }
  fundEscrow = (id: string) => this.act(id, 'FUND_ESCROW');
  openTender = (id: string) => this.act(id, 'OPEN_TENDER');
  submitOffer = (id: string, amount: number) => this.act(id, 'SUBMIT_OFFER', { illustrativeOfferUsdc: amount });
  selectWinner = (id: string) => this.act(id, 'SELECT_WINNER');
  submitPod = (id: string, fileData?: unknown) => this.act(id, 'SUBMIT_POD', { demoDocumentProvided: Boolean(fileData) });
  async acceptPod(id: string): Promise<DemoActionResult> { const first = await this.act(id, 'RUN_ADVISORY'); return first.success ? this.act(id, 'ACCEPT_POD') : first; }
  releaseFreight = (id: string) => this.act(id, 'RELEASE_FREIGHT');
  async requestCorrection(id: string): Promise<DemoActionResult> { const snap = await this.getSession(id); return { success: false, snapshot: snap, error: 'Correction is intentionally unavailable in this fixed demo scenario.' }; }
  async openDispute(id: string): Promise<DemoActionResult> { const snap = await this.getSession(id); return { success: false, snapshot: snap, error: 'Dispute execution is outside this fixed demo scenario.' }; }
  async getSession(id: string): Promise<DemoSessionSnapshot> { const cached = snapshots.get(id); if (!cached) throw new DemoGatewayError('DEMO_SESSION_NOT_FOUND', 'Session not found.', 404); if (!cached.apiSession) return { ...cached }; const api = await requestJson<ApiSession>(`/api/operations-demo/sessions/${encodeURIComponent(id)}`); const next = fromApi(api, cached.mode, cached.role); snapshots.set(id, next); return next; }
  async resetSession(id: string): Promise<DemoSessionSnapshot> { const current = snapshots.get(id); if (!current) throw new DemoGatewayError('DEMO_SESSION_NOT_FOUND', 'Session not found.', 404); return this.createSession(current.mode, current.role); }
  async setStep(id: string, step: number): Promise<DemoSessionSnapshot> { const snap = await this.getSession(id); if (snap.mode !== 'completed-replay') return snap; const next = { ...snap, currentStep: Math.max(1, Math.min(8, step)) }; snapshots.set(id, next); return next; }
  watchSession(id: string, onSnapshot: (snapshot: DemoSessionSnapshot) => void): () => void {
    const cached = snapshots.get(id); if (!cached?.apiSession) return () => undefined;
    let closed = false; let source: EventSource | null = null; let poll: number | null = null; let reconnect = 1_000;
    const refresh = () => this.getSession(id).then(onSnapshot).catch(() => undefined);
    const connect = () => { if (closed) return; source = new EventSource(`/api/operations-demo/sessions/${encodeURIComponent(id)}/events`); source.onmessage = refresh; source.addEventListener('confirmed_state', refresh); source.addEventListener('terminal_state', refresh); source.onerror = () => { source?.close(); if (poll === null) poll = window.setInterval(refresh, 4_000); window.setTimeout(connect, reconnect); reconnect = Math.min(reconnect * 2, 15_000); }; source.onopen = () => { reconnect = 1_000; if (poll !== null) { window.clearInterval(poll); poll = null; } }; };
    connect(); return () => { closed = true; source?.close(); if (poll !== null) window.clearInterval(poll); };
  }
}

export const gateway: DemoSessionGateway = new ProductionDemoGateway();
