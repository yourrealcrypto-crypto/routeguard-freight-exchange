export type DemoMode = 'completed-replay' | 'interactive-testnet' | 'local-simulation';
export type SessionStatus = 'IDLE' | 'READY' | 'VALIDATING' | 'SIGNING' | 'SUBMITTING' | 'AWAITING_CONSENSUS' | 'VERIFYING_MIRROR' | 'CONFIRMED' | 'PREVIEW_COMPLETE' | 'FAILED' | 'RECOVERABLE';
export type LifecycleState = 'DRAFT' | 'SHIPMENT_DEFINED' | 'ESCROW_FUNDED' | 'TENDER_OPEN' | 'OFFER_SUBMITTED' | 'WINNER_SELECTED' | 'WINNING_AMOUNT_LOCKED' | 'POD_SUBMITTED' | 'POD_ACCEPTED' | 'PAYMENT_RELEASED' | 'COMPLETED';
export type Role = 'SHIPPER' | 'CARRIER';

export interface DemoCarrierOffer {
  carrierId: string;
  amountUsdc: number;
  qualification: 'qualified' | 'not-qualified';
  selectionResult: 'winner' | 'not-selected' | 'rejected' | 'pending';
  reason: string;
  evidenceClassification: 'live-proven-winning-offer' | 'synthetic-comparison-offer' | 'simulated-comparison-offer';
}

export interface DemoCapabilities {
  replayAvailable: boolean;
  simulationAvailable: boolean;
  liveModeEnabled: boolean;
  liveModeReason: string;
  testnetOnly: true;
}

export interface DemoSessionSnapshot {
  mode: DemoMode;
  connectionStatus: string;
  sessionId: string;
  role: Role;
  scenarioId: string;
  currentStep: number;
  lifecycleState: LifecycleState;
  route: string;
  transportMode: string;
  equipment: string;
  weight: string;
  pickupWindow: string;
  deliveryDeadline: string;
  illustrativeQuote: string;
  maxBudget: string;
  maxBudgetNumeric: number;
  carrierOffers: DemoCarrierOffer[];
  selectedWinner?: string;
  winningAmount?: number;
  excessRefund?: number;
  lockedAmount?: number;
  podState: 'PENDING' | 'SUBMITTED' | 'ACCEPTED';
  settlementState: 'PENDING' | 'RELEASED';
  writeCount: number;
  latestTransaction: string;
  hcsTopic: string;
  hcsSequence: string;
  escrowState: string;
  recoverableError?: string;
  availableActions: string[];
  apiSession: boolean;
  liveEnabled: boolean;
}

export interface DemoActionResult { success: boolean; snapshot: DemoSessionSnapshot; error?: string; }
export interface DemoSessionGateway {
  setLiveAuthorization(token: string): void;
  createSession(mode: DemoMode, role: Role): Promise<DemoSessionSnapshot>;
  changeRole(sessionId: string, role: Role): Promise<DemoSessionSnapshot>;
  defineShipment(sessionId: string): Promise<DemoActionResult>;
  openTender(sessionId: string): Promise<DemoActionResult>;
  fundEscrow(sessionId: string): Promise<DemoActionResult>;
  submitOffer(sessionId: string, amount: number): Promise<DemoActionResult>;
  selectWinner(sessionId: string): Promise<DemoActionResult>;
  submitPod(sessionId: string, fileData?: unknown): Promise<DemoActionResult>;
  acceptPod(sessionId: string): Promise<DemoActionResult>;
  releaseFreight(sessionId: string): Promise<DemoActionResult>;
  requestCorrection(sessionId: string): Promise<DemoActionResult>;
  openDispute(sessionId: string): Promise<DemoActionResult>;
  getSession(sessionId: string): Promise<DemoSessionSnapshot>;
  resetSession(sessionId: string): Promise<DemoSessionSnapshot>;
  setStep(sessionId: string, step: number): Promise<DemoSessionSnapshot>;
  watchSession(sessionId: string, onSnapshot: (snapshot: DemoSessionSnapshot) => void): () => void;
}
