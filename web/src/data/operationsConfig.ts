export interface OperationsScenario {
  id: string;
  label: string;
  status: 'LIVE HEDERA PROOF AVAILABLE' | 'INTERACTIVE SIMULATION';
  isLive: boolean;
  route: string;
  transportMode: string;
  equipment: string;
  weight: string; // e.g. "18,000 kg"
  pickupWindow: string;
  deliveryDeadline: string;
  maxBudget: string;
  maxBudgetNumeric?: number;
  winningOffer?: string;
  excessReturned?: string;
  winningCarrier?: string;
  podState?: string;
  settlementState?: string;
}

export const operationsScenarios: OperationsScenario[] = [
  {
    id: 'sea-chi',
    label: 'Seattle → Chicago',
    status: 'LIVE HEDERA PROOF AVAILABLE',
    isLive: true,
    route: 'SEA (Seattle) → CHI (Chicago)',
    transportMode: 'Intermodal',
    equipment: '40ft FCL',
    weight: '18,000 kg',
    pickupWindow: '03–04 Aug 2026',
    deliveryDeadline: '08 Aug 2026',
    maxBudget: '1.00 USDC',
    winningOffer: '0.75 USDC',
    excessReturned: '0.25 USDC',
    winningCarrier: 'carrier-alpha',
    podState: 'ACCEPTED',
    settlementState: 'RELEASED'
  },
  {
    id: 'lax-phx',
    label: 'Los Angeles → Phoenix',
    status: 'INTERACTIVE SIMULATION',
    isLive: false,
    route: 'LAX (Los Angeles) → PHX (Phoenix)',
    transportMode: 'Truck',
    equipment: 'Dry Van',
    weight: '12,500 kg',
    pickupWindow: '05–06 Aug 2026',
    deliveryDeadline: '08 Aug 2026',
    maxBudget: '1,850 USDC',
    maxBudgetNumeric: 1850
  },
  {
    id: 'atl-mia',
    label: 'Atlanta → Miami',
    status: 'INTERACTIVE SIMULATION',
    isLive: false,
    route: 'ATL (Atlanta) → MIA (Miami)',
    transportMode: 'Truck',
    equipment: 'Refrigerated',
    weight: '8,000 kg',
    pickupWindow: '06 Aug 2026',
    deliveryDeadline: '07 Aug 2026',
    maxBudget: '2,400 USDC',
    maxBudgetNumeric: 2400
  }
];

export const simulatedOffers = [
  {
    carrier: 'carrier-charlie',
    amount: '0.70 USDC',
    status: 'NOT QUALIFIED',
    reason: 'Required equipment rule failed'
  }
];
