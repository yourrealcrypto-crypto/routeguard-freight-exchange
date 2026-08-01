/**
 * RouteGuard Freight Exchange - Centralized Evidence Data Adapter
 * Strictly holds factual blockchain, payment, consensus, and route evidence.
 * All factual values in components must flow through this adapter.
 */

export interface AmountInfo {
  display: string;
  atomic: number;
  purpose: string;
}

export interface EconomicSeparation {
  x402AccessFee: AmountInfo;
  maximumFreightPrincipal: AmountInfo;
  winningFreightSettlement: AmountInfo;
  excessRefund: AmountInfo;
  hederaNetworkFee: {
    hbarTransfer: string;
    htsTransfer: string;
  };
}

export interface AccessEvidence {
  tenderActivationTx: string;
  carrierOfferTx: string;
  amountDisplay: string;
  amountAtomic: number;
  tokenId: string;
  accessTreasury: string;
  status: string;
}

export interface EscrowEvidence {
  contractId: string;
  maxBudgetDisplay: string;
  maxBudgetAtomic: number;
  winningAmountDisplay: string;
  winningAmountAtomic: number;
  excessReturnedDisplay: string;
  excessReturnedAtomic: number;
  stateAfterAllocation: string;
  finalState: string;
  remainingLocked: number;
}

export interface PodReviewEvidence {
  hcsTopic: string;
  state: string;
  adviser: string;
  manifestHash: string;
  ciphertextHash: string;
  carrierSignatureStatus: string;
  shipperSignatureStatus: string;
}

export interface ReleaseEvidence {
  escrowContract: string;
  releasedAmount: string;
  releasedAtomicAmount: number;
  finalContractState: string;
  remainingLockedAmount: number;
  carrierBalanceIncrease: string;
  releaseTransaction: string;
  hcsTopic: string;
  releaseSequence: number;
  completionSequence: number;
  status: string;
}

export interface SyntheticRealBoundary {
  realOnHederaTestnet: string[];
  syntheticDemonstrationData: string[];
  notClaimed: string[];
}

export interface AuctionInfo {
  status: 'OPEN' | 'CLOSED' | 'MATCHING' | 'COMPLETED' | null;
  mode: string | null;
  tenderId: string | null;
  routeOrigin: string | null;
  routeDestination: string | null;
  equipmentType: string | null;
  departureDate: string | null;
  totalCarrierOffers: number | null;
  weight: string | null;
  transportMode: string | null;
  pickupWindow: string | null;
  deliveryDeadline: string | null;
}

export interface CarrierOffer {
  carrierId: string;
  commitmentHash: string | null;
  submittedSequence: number | null;
  isWinner: boolean;
  statusText: string;
}

export interface WinnerSelection {
  selectedCarrier: string | null;
  resultStatus: string | null;
  decisionEngineType: 'DETERMINISTIC' | 'MANUAL' | null;
  decisionManifestHash: string | null;
  evaluatedBidSetHash: string | null;
}

export interface PaymentInfo {
  status: 'SETTLED' | 'PENDING' | 'FAILED' | null;
  amountFormatted: string | null;
  amountAtomic: string | null;
  paymentProtocol: string | null;
  httpFlow: string | null;
}

export interface TokenInfo {
  tokenId: string | null;
  symbol: string | null;
  decimals: number | null;
  network: string | null;
}

export interface PayerReceiver {
  payerAccountId: string | null;
  receiverAccountId: string | null;
}

export interface HCSTopic {
  topicId: string | null;
  network: string | null;
}

export interface HCSMessage {
  sequenceNumber: number;
  messageType: string;
  timestamp: string | null;
  hash: string | null;
  isConfirmed: boolean;
  freightMeaning?: string;
  status?: string;
}

export interface TimestampInfo {
  settlementConsensus: string | null;
  reservationConsensus: string | null;
  displaySettlementTime: string | null;
  displayReservationTime: string | null;
}

export interface HashInfo {
  paymentTxId: string | null;
  decisionManifestHash: string | null;
  evaluatedBidSetHash: string | null;
  routeReservationHash: string | null;
}

export interface ExplorerLinks {
  paymentTxUrl: string | null;
  hcsTopicUrl: string | null;
  payerAccountUrl: string | null;
  receiverAccountUrl: string | null;
  tokenUrl: string | null;
}

export interface SettlementElapsed {
  seconds: number | null;
  formatted: string | null;
  precedesReservationVerified: boolean;
}

export interface EvidenceDownload {
  filename: string;
  generatedAt: string;
  specVersion: string;
}

export interface RouteGuardEvidence {
  proofStatus: 'LIVE PROVEN' | 'HISTORICAL_V1';
  adviserType: 'DETERMINISTIC NON-BINDING ADVISER';
  economics: EconomicSeparation;
  accessEvidence: AccessEvidence;
  escrowEvidence: EscrowEvidence;
  podReviewEvidence: PodReviewEvidence;
  releaseEvidence: ReleaseEvidence;
  syntheticRealBoundary: SyntheticRealBoundary;

  // V1 Compatibility
  liveMode: string;
  auction: AuctionInfo;
  offers: CarrierOffer[];
  winner: WinnerSelection;
  payment: PaymentInfo;
  token: TokenInfo;
  parties: PayerReceiver;
  topic: HCSTopic;
  messages: HCSMessage[];
  timestamps: TimestampInfo;
  hashes: HashInfo;
  explorer: ExplorerLinks;
  elapsed: SettlementElapsed;
  meta: EvidenceDownload;
}

export const PROOF_SURFACES = Object.freeze({
  canonicalHttp402: {
    label: 'Canonical HTTP 402 handshake',
    transactionId: '0.0.7162784@1784141033.517654222',
    url: 'https://hashscan.io/testnet/transaction/0.0.7162784@1784141033.517654222',
  },
  finalReservation: {
    label: 'Final x402 reservation',
    transactionId: '0.0.7162784@1785173890.867086556',
    url: 'https://hashscan.io/testnet/transaction/0.0.7162784@1785173890.867086556',
  },
  finalAuction: {
    label: 'Final auction evidence topic',
    topicId: '0.0.9794225',
    topicCreateTransactionId: '0.0.9197513@1785171882.373802899',
    url: 'https://hashscan.io/testnet/topic/0.0.9794225',
    createUrl: 'https://hashscan.io/testnet/transaction/0.0.9197513@1785171882.373802899',
  },
  v2: {
    tenderActivationTransactionId: '0.0.7162784@1785519911.424021609',
    carrierBidTransactionId: '0.0.7162784@1785520014.520040785',
    escrowContractId: '0.0.9861047',
    podTopicId: '0.0.9862010',
    freightReleaseTransactionId: '0.0.9197513@1785536472.599444485',
  },
});

export const V2_FACTS: RouteGuardEvidence = {
  proofStatus: 'LIVE PROVEN',
  adviserType: 'DETERMINISTIC NON-BINDING ADVISER',
  economics: {
    x402AccessFee: { display: '0.001 USDC', atomic: 1000, purpose: 'purchases machine access' },
    maximumFreightPrincipal: { display: '1.00 USDC', atomic: 1000000, purpose: 'funded into HTS escrow' },
    winningFreightSettlement: { display: '0.75 USDC', atomic: 750000, purpose: 'released to the carrier' },
    excessRefund: { display: '0.25 USDC', atomic: 250000, purpose: 'returned to the shipper' },
    hederaNetworkFee: { hbarTransfer: '$0.0001', htsTransfer: '$0.001' },
  },
  accessEvidence: {
    tenderActivationTx: '0.0.7162784@1785519911.424021609',
    carrierOfferTx: '0.0.7162784@1785520014.520040785',
    amountDisplay: '0.001 USDC',
    amountAtomic: 1000,
    tokenId: '0.0.429274',
    accessTreasury: '0.0.9215954',
    status: 'LIVE PROVEN',
  },
  escrowEvidence: {
    contractId: '0.0.9861047',
    maxBudgetDisplay: '1.00 USDC',
    maxBudgetAtomic: 1000000,
    winningAmountDisplay: '0.75 USDC',
    winningAmountAtomic: 750000,
    excessReturnedDisplay: '0.25 USDC',
    excessReturnedAtomic: 250000,
    stateAfterAllocation: 'ALLOCATED',
    finalState: 'RELEASED',
    remainingLocked: 0,
  },
  podReviewEvidence: {
    hcsTopic: '0.0.9862010',
    state: 'ACCEPTED',
    adviser: 'DETERMINISTIC · NON-BINDING',
    manifestHash: 'sha256:169bf54cb487a7ae7248d5f726885e363aacfd29e9a6f140cadd6074102ef582',
    ciphertextHash: 'sha256:8cf571af5e3475f9e3672d552ddd6b9976a51b532df0b6678b5a43614eda7f68',
    carrierSignatureStatus: 'VERIFIED',
    shipperSignatureStatus: 'VERIFIED',
  },
  releaseEvidence: {
    escrowContract: '0.0.9861047',
    releasedAmount: '0.75 USDC',
    releasedAtomicAmount: 750000,
    finalContractState: 'RELEASED',
    remainingLockedAmount: 0,
    carrierBalanceIncrease: '750,000 atomic USDC',
    releaseTransaction: '0.0.9197513@1785536472.599444485',
    hcsTopic: '0.0.9862010',
    releaseSequence: 4,
    completionSequence: 5,
    status: 'LIVE PROVEN',
  },
  syntheticRealBoundary: {
    realOnHederaTestnet: [
      'x402 payments',
      'HTS token transfers',
      'smart-contract escrow',
      'winner allocation',
      'excess refund',
      'cryptographic signatures',
      'encrypted POD processing',
      'HCS evidence',
      'freight-payment release',
      'Mirror verification',
    ],
    syntheticDemonstrationData: [
      'freight tender',
      'route',
      'carrier offer',
      'POD documents',
      'delivery event',
    ],
    notClaimed: [
      'physical freight movement',
      'real commercial delivery',
      'live model-based AI judgment',
      'Hedera endorsement or certification',
    ],
  },
  liveMode: 'LIVE_FINAL_DEMO',
  auction: {
    status: 'COMPLETED',
    mode: 'DETERMINISTIC',
    tenderId: 'Tender #4091',
    routeOrigin: 'SEA (Seattle)',
    routeDestination: 'CHI (Chicago)',
    equipmentType: '40ft FCL',
    weight: '18,000 kg',
    transportMode: 'Intermodal',
    pickupWindow: '03–04 Aug 2026',
    deliveryDeadline: '08 Aug 2026',
    departureDate: '2026-10-15',
    totalCarrierOffers: 2,
  },
  offers: [
    {
      carrierId: 'carrier-alpha',
      commitmentHash: 'sha256:17896569d821d0cafae5b1cbb304322166935713f04d6bbe6a2fe4785fe79827',
      submittedSequence: 2,
      isWinner: true,
      statusText: 'QUALIFIED · WINNER',
    },
    {
      carrierId: 'carrier-beta',
      commitmentHash: 'sha256:3d168e11b0cb1802b76022d5096ce7db1f876aacfd4d21850bee113f1edcb385',
      submittedSequence: 3,
      isWinner: false,
      statusText: 'QUALIFIED · RUNNER_UP',
    },
  ],
  winner: {
    selectedCarrier: 'carrier-alpha',
    resultStatus: 'QUALIFIED · WINNER',
    decisionEngineType: 'DETERMINISTIC',
    decisionManifestHash: 'sha256:1f0e40ccb0a14673f70565ed339473baacb5a8dd635546e6e5e7baaab1710425',
    evaluatedBidSetHash: 'sha256:5138d1c09bb513a7304c649482da7b9b68494994a2aa1bda21ee70f526c4d6b3',
  },
  payment: {
    status: 'SETTLED',
    amountFormatted: '0.75 USDC',
    amountAtomic: '750000 atomic USDC',
    paymentProtocol: 'x402 v2 exact',
    httpFlow: '402 → signed retry → 200',
  },
  token: {
    tokenId: '0.0.429274',
    symbol: 'USDC',
    decimals: 6,
    network: 'hedera:testnet',
  },
  parties: {
    payerAccountId: '0.0.9197513',
    receiverAccountId: '0.0.9861047',
  },
  topic: {
    topicId: '0.0.9862010',
    network: 'hedera:testnet',
  },
  messages: [
    {
      sequenceNumber: 1,
      messageType: 'POD_SUBMITTED',
      timestamp: '2026-07-31T22:21:02.627Z',
      hash: 'sha256:c733b89e704b6178c390088a26127e849314376a257e8be8471d7aedd2df5c3d',
      isConfirmed: true,
      freightMeaning: 'Carrier delivery evidence received',
      status: 'LIVE PROVEN',
    },
    {
      sequenceNumber: 2,
      messageType: 'POD_ADVISORY_ANCHORED',
      timestamp: '2026-07-31T22:21:07.116Z',
      hash: 'sha256:37fe616033fcc1e053671cb72abc10b4e9399a079876c186039782f18d0013c4',
      isConfirmed: true,
      freightMeaning: 'Deterministic non-binding advisory anchored',
      status: 'LIVE PROVEN',
    },
    {
      sequenceNumber: 3,
      messageType: 'POD_REVIEW_ACTION — ACCEPT',
      timestamp: '2026-07-31T22:21:11.170Z',
      hash: 'sha256:7254f085c81eaf421233af20c1d23e5410d2222fc58a4e8ac58b6299f0ff8139',
      isConfirmed: true,
      freightMeaning: 'Signed shipper acceptance recorded',
      status: 'LIVE PROVEN',
    },
    {
      sequenceNumber: 4,
      messageType: 'ESCROW_RELEASED',
      timestamp: '2026-07-31T22:27:45.385Z',
      hash: 'sha256:eafe743ed1cd68fbbaa8ec16f4197dc7ab9aa542241eacf1e282d04800b75352',
      isConfirmed: true,
      freightMeaning: 'Winning freight amount released',
      status: 'LIVE PROVEN',
    },
    {
      sequenceNumber: 5,
      messageType: 'TENDER_COMPLETED',
      timestamp: '2026-07-31T22:27:47.228Z',
      hash: 'sha256:302cd21ca9d7548f537530def985cafd589b8f797cf2258dffdcbfe0b6afac10',
      isConfirmed: true,
      freightMeaning: 'Freight lifecycle completed',
      status: 'LIVE PROVEN',
    },
  ],
  timestamps: {
    settlementConsensus: '2026-07-31T22:27:45.385875442Z',
    reservationConsensus: '2026-07-27T17:38:23.453477104Z',
    displaySettlementTime: '22:27:45.385',
    displayReservationTime: '17:38:23.453',
  },
  hashes: {
    paymentTxId: '0.0.7162784@1785173890.867086556',
    decisionManifestHash: 'sha256:1f0e40ccb0a14673f70565ed339473baacb5a8dd635546e6e5e7baaab1710425',
    evaluatedBidSetHash: 'sha256:5138d1c09bb513a7304c649482da7b9b68494994a2aa1bda21ee70f526c4d6b3',
    routeReservationHash: 'sha256:b8908c9ab19127461ab7830ee6b57105b0d9e052247d101726c5dccf98586d06',
  },
  explorer: {
    paymentTxUrl: 'https://hashscan.io/testnet/transaction/0.0.9197513@1785536472.599444485',
    hcsTopicUrl: 'https://hashscan.io/testnet/topic/0.0.9862010',
    payerAccountUrl: 'https://hashscan.io/testnet/account/0.0.9197513',
    receiverAccountUrl: 'https://hashscan.io/testnet/account/0.0.9861047',
    tokenUrl: 'https://hashscan.io/testnet/token/0.0.429274',
  },
  elapsed: {
    seconds: 6.48,
    formatted: '6.48 seconds',
    precedesReservationVerified: true,
  },
  meta: {
    filename: 'routeguard-evidence-v2-0.0.9862010.json',
    generatedAt: '2026-08-01T00:00:00Z',
    specVersion: '2.2.0-institutional-proof',
  },
};

export const CONFIRMED_FACTS = V2_FACTS;

export function getRouteGuardEvidence(): RouteGuardEvidence {
  return V2_FACTS;
}

export function downloadEvidenceJson(evidence: RouteGuardEvidence = V2_FACTS): void {
  const jsonString = JSON.stringify(evidence, null, 2);
  const blob = new Blob([jsonString], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = evidence.meta.filename || 'routeguard-evidence.json';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function getHashScanUrl(type: 'topic' | 'tx' | 'account' | 'token', id: string | null): string {
  if (!id) return 'https://hashscan.io/testnet/';
  switch (type) {
    case 'topic':
      return `https://hashscan.io/testnet/topic/${id}`;
    case 'tx':
      return `https://hashscan.io/testnet/transaction/${encodeURIComponent(id)}`;
    case 'account':
      return `https://hashscan.io/testnet/account/${id}`;
    case 'token':
      return `https://hashscan.io/testnet/token/${id}`;
    default:
      return 'https://hashscan.io/testnet/';
  }
}
