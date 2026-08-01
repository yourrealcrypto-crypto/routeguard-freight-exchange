export interface SimulatedOffer {
  carrier: string;
  amount: number;
  status: 'QUALIFIED' | 'NOT QUALIFIED';
  reason?: string;
  isSimulated: boolean;
}

export type TenderState = 'DRAFT' | 'OPEN' | 'WINNER_SELECTED' | 'COMPLETED';
export type PodState = 'PENDING' | 'ACCEPTED';
export type SettlementState = 'PENDING' | 'RELEASED';

export interface ScenarioState {
  scenarioId: string;
  tenderState: TenderState;
  offers: SimulatedOffer[];
  winner?: string;
  allocatedAmount?: number;
  excessRefund?: number;
  podState: PodState;
  settlementState: SettlementState;
  maxBudgetNumeric: number;
}

export type OperationsAction =
  | { type: 'CHANGE_SCENARIO'; payload: { scenarioId: string; maxBudgetNumeric: number } }
  | { type: 'OPEN_TENDER' }
  | { type: 'SUBMIT_OFFER'; payload: { carrier: string; amount: number; maxBudget: number } }
  | { type: 'RUN_SELECTION'; payload: { maxBudget: number } }
  | { type: 'ACCEPT_POD' }
  | { type: 'SETTLE' }
  | { type: 'RESET_DEMO'; payload: { scenarioId: string; maxBudgetNumeric: number } };

const getInitialOffers = (maxBudgetNumeric: number): SimulatedOffer[] => {
  return [
    {
      carrier: 'carrier-charlie',
      amount: 0.70,
      status: 'NOT QUALIFIED',
      reason: 'Required equipment rule failed',
      isSimulated: true
    }
  ];
};

export const initialScenarioState = (scenarioId: string, maxBudgetNumeric: number): ScenarioState => ({
  scenarioId,
  tenderState: 'DRAFT',
  offers: getInitialOffers(maxBudgetNumeric),
  winner: undefined,
  allocatedAmount: undefined,
  excessRefund: undefined,
  podState: 'PENDING',
  settlementState: 'PENDING',
  maxBudgetNumeric,
});

export const operationsReducer = (state: ScenarioState, action: OperationsAction): ScenarioState => {
  switch (action.type) {
    case 'CHANGE_SCENARIO':
      return initialScenarioState(action.payload.scenarioId, action.payload.maxBudgetNumeric);

    case 'OPEN_TENDER':
      return { ...state, tenderState: 'OPEN' };

    case 'SUBMIT_OFFER': {
      const isQualified = action.payload.amount <= action.payload.maxBudget;
      const newOffer: SimulatedOffer = {
        carrier: action.payload.carrier,
        amount: action.payload.amount,
        status: isQualified ? 'QUALIFIED' : 'NOT QUALIFIED',
        reason: isQualified ? undefined : 'Offer exceeds maximum budget',
        isSimulated: true
      };
      const filteredOffers = state.offers.filter(o => o.carrier !== action.payload.carrier);
      return { ...state, offers: [...filteredOffers, newOffer] };
    }

    case 'RUN_SELECTION': {
      if (state.offers.length === 0) return state;
      const qualified = state.offers.filter(o => o.status === 'QUALIFIED');
      if (qualified.length === 0) return state; // No winner

      const winnerOffer = qualified.reduce((prev, curr) => prev.amount < curr.amount ? prev : curr);

      return {
        ...state,
        tenderState: 'WINNER_SELECTED',
        winner: winnerOffer.carrier,
        allocatedAmount: winnerOffer.amount,
        excessRefund: action.payload.maxBudget - winnerOffer.amount
      };
    }

    case 'ACCEPT_POD':
      if (state.tenderState !== 'WINNER_SELECTED') return state;
      return { ...state, podState: 'ACCEPTED' };

    case 'SETTLE':
      if (state.podState !== 'ACCEPTED') return state;
      return { ...state, settlementState: 'RELEASED', tenderState: 'COMPLETED' };

    case 'RESET_DEMO':
      return initialScenarioState(action.payload.scenarioId, action.payload.maxBudgetNumeric);

    default:
      return state;
  }
};
