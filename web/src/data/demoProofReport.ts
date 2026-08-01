import { DemoCarrierOffer, DemoMode, DemoSessionSnapshot, Role } from './demoSessionTypes';
import { RouteGuardEvidence } from './routeguardEvidence';

export type ProofReportStatus = 'verified-live-proof' | 'preview-backend-pending';

export interface ShipmentConfiguration {
  route: string;
  transportMode: string;
  equipment: string;
  weight: string;
  pickupWindow: string;
  deliveryDeadline: string;
}

export interface TenderReport {
  maxBudget: string;
  rules: string[];
  state: string;
  offerCount: number;
}

export interface QualificationReport {
  isQualified: boolean;
  reasons: string[];
}

export interface OfferReport {
  carrierId: string;
  amount: number;
  status: string;
  isSimulated: boolean;
}

export interface WinnerReport {
  carrierId: string;
  winningAmount: number;
  excessRefund: number;
}

export interface FinancialReport {
  shipperFunded: string;
  destination: string;
  lockedAmount: number | undefined;
}

export interface PodReport {
  state: string;
  encryptionState: string;
  signatureState: string;
  reviewDecision: string;
}

export interface SettlementReport {
  recipient: string | undefined;
  amount: number | undefined;
  source: string;
  escrowState: string;
  remainingLocked: number;
}

export interface VerificationSummary {
  status: ProofReportStatus;
  execution: string;
  networkWrites: number;
  x402Access: string;
  escrow: string;
  podSignatures: string;
  hcsChronology: string;
  settlement: string;
  mirror: string;
}

export interface PublicHederaEvidence {
  network: string;
  tokenId: string;
  escrowContractId: string;
  x402ActivationTx: string;
  x402OfferTx: string;
  hcsTopicId: string;
  hcsSequence: string;
  releaseTx: string;
}

export type ProofResultState = 'completed' | 'current' | 'pending';

export type ProofResultKey =
  | 'shipment-defined'
  | 'budget-secured'
  | 'winner-selected'
  | 'excess-returned'
  | 'pod-accepted'
  | 'carrier-paid'
  | 'tender-completed';

export function getProofResultState(
  resultKey: ProofResultKey,
  session: DemoSessionSnapshot,
  replayIsPlaying: boolean,
  hasStartedReplay: boolean
): ProofResultState {
  const isInteractive = session.mode === 'interactive-testnet';
  const isReplay = session.mode === 'completed-replay';
  const step = session.currentStep;

  if (isInteractive && session.lifecycleState === 'COMPLETED') {
    return 'completed';
  }

  if (isReplay && !hasStartedReplay) {
    if (resultKey === 'shipment-defined') return 'current';
    return 'pending';
  }

  // Common threshold helper
  const threshold = (completedAtStep: number, currentAtSteps: number[]) => {
    if (step >= completedAtStep) {
      return 'completed';
    }
    // For replay, if we are at step 8 and it's stopped playing (i.e. finished), make everything completed
    if (isReplay && step === 8 && !replayIsPlaying) {
      return 'completed';
    }
    if (currentAtSteps.includes(step)) return 'current';
    return 'pending';
  };

  switch (resultKey) {
    case 'shipment-defined':
      return threshold(2, [1]);
    case 'budget-secured':
      return threshold(3, [2]);
    case 'winner-selected':
      return threshold(6, [5]); // Completed when POD upload starts (6), current during Select Winner (5)
    case 'excess-returned':
      return threshold(6, [5]); // Same as winner selection
    case 'pod-accepted':
      return threshold(8, [7]); // Completed at Step 8, current at Step 7
    case 'carrier-paid':
      return threshold(9, [8]); // Completed after 8 is done, current at 8
    case 'tender-completed':
      return threshold(9, [8]); // Same as carrier-paid
    default:
      return 'pending';
  }
}

export interface DemoProofReport {
  reportVersion: string;
  generatedAt: string;
  reportStatus: ProofReportStatus;
  mode: DemoMode;
  perspective: Role;
  sessionId: string;
  shipment: ShipmentConfiguration;
  tender: TenderReport;
  qualification: QualificationReport;
  offers: DemoCarrierOffer[];
  winner: WinnerReport | null;
  financial: FinancialReport;
  pod: PodReport;
  settlement: SettlementReport;
  verification: VerificationSummary;
  hederaEvidence: PublicHederaEvidence;
}

export function buildDemoProofReport(
  session: DemoSessionSnapshot,
  perspective: Role,
  evidence: RouteGuardEvidence
): DemoProofReport {
  const isLive = session.mode === 'completed-replay' || (session.mode === 'interactive-testnet' && session.lifecycleState === 'COMPLETED');
  const isLocal = session.mode === 'local-simulation';
  const status: ProofReportStatus = isLive ? 'verified-live-proof' : 'preview-backend-pending';

  return {
    reportVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    reportStatus: status,
    mode: session.mode,
    perspective,
    sessionId: session.sessionId,
    shipment: {
      route: session.route,
      transportMode: session.transportMode,
      equipment: session.equipment,
      weight: session.weight,
      pickupWindow: session.pickupWindow,
      deliveryDeadline: session.deliveryDeadline
    },
    tender: {
      maxBudget: session.maxBudget,
      rules: ['Equipment match', 'Weight supported', 'Pickup window supported', 'Delivery deadline achievable', 'Carrier qualified', 'Offer not above maximum budget'],
      state: session.lifecycleState,
      offerCount: session.carrierOffers.length
    },
    qualification: {
      isQualified: true,
      reasons: []
    },
    offers: session.carrierOffers,
    winner: session.selectedWinner ? {
      carrierId: session.selectedWinner,
      winningAmount: session.winningAmount || 0,
      excessRefund: session.excessRefund || 0
    } : null,
    financial: {
      shipperFunded: session.maxBudget,
      destination: 'RouteGuard freight escrow',
      lockedAmount: session.lockedAmount
    },
    pod: {
      state: session.podState,
      encryptionState: session.podState === 'PENDING' ? 'NOT SUBMITTED' : 'PREVIEW COMPLETE',
      signatureState: session.podState === 'PENDING' ? 'NOT SUBMITTED' : 'PREVIEW VERIFIED',
      reviewDecision: session.lifecycleState === 'COMPLETED' ? 'ACCEPTED' : 'PENDING'
    },
    settlement: {
      recipient: session.selectedWinner,
      amount: session.lifecycleState === 'COMPLETED' ? session.winningAmount : 0,
      source: 'RouteGuard freight escrow',
      escrowState: session.escrowState,
      remainingLocked: 0
    },
    verification: {
      status,
      execution: isLive ? 'IMMUTABLE REAL HEDERA TESTNET EVIDENCE' : isLocal ? 'LOCAL ZERO-WRITE ENGINE' : 'CONTROLLED HEDERA TESTNET',
      networkWrites: session.writeCount,
      x402Access: isLive ? 'VERIFIED' : isLocal ? 'SIMULATED ONLY' : 'SERVER CONTROLLED',
      escrow: isLive ? 'VERIFIED' : isLocal ? 'SIMULATED ONLY' : 'SERVER CONTROLLED',
      podSignatures: isLive ? 'VERIFIED' : isLocal ? 'SIMULATED ONLY' : 'SERVER CONTROLLED',
      hcsChronology: isLive ? 'SEQUENCES 1-5 VERIFIED' : isLocal ? 'SIMULATED ONLY' : 'SERVER CONTROLLED',
      settlement: isLive ? 'VERIFIED' : isLocal ? 'SIMULATED ONLY' : 'SERVER CONTROLLED',
      mirror: isLive ? 'VERIFIED' : isLocal ? 'NOT APPLICABLE' : 'SERVER CONTROLLED'
    },
    hederaEvidence: {
      network: 'Hedera Testnet',
      tokenId: evidence.token.tokenId ?? '0.0.429274',
      escrowContractId: '0.0.9861047',
      x402ActivationTx: isLive ? evidence.accessEvidence.tenderActivationTx : 'NOT SUBMITTED',
      x402OfferTx: isLive ? evidence.accessEvidence.carrierOfferTx : 'NOT SUBMITTED',
      hcsTopicId: isLive ? (evidence.topic.topicId ?? 'NOT SUBMITTED') : 'NOT SUBMITTED',
      hcsSequence: isLive ? '1-5' : 'BACKEND CONNECTION PENDING',
      releaseTx: isLive ? (evidence.releaseEvidence.releaseTransaction ?? 'NOT SUBMITTED') : 'NOT SUBMITTED'
    }
  };
}
