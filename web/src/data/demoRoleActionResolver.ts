import { DemoSessionSnapshot, Role, LifecycleState } from './demoSessionTypes';

export interface RoleWorkspace {
  step: number;
  availableAction: string | null;
  message: string;
}

export function getRoleWorkspaceState(session: DemoSessionSnapshot, requestedRole: Role): RoleWorkspace {
  const { lifecycleState, role: activeRole } = session;

  if (requestedRole === 'SHIPPER') {
    switch (lifecycleState) {
      case 'DRAFT':
        return { step: 1, availableAction: 'DEFINE SHIPMENT', message: 'Define shipment' };
      case 'SHIPMENT_DEFINED':
        return { step: 2, availableAction: 'FUND TESTNET ESCROW', message: 'Fund maximum budget' };
      case 'ESCROW_FUNDED':
        return { step: 3, availableAction: 'ACTIVATE TESTNET TENDER', message: 'Activate tender' };
      case 'TENDER_OPEN':
        return { step: 4, availableAction: null, message: 'Waiting for carrier offer' };
      case 'OFFER_SUBMITTED':
        return { step: 5, availableAction: 'SELECT QUALIFIED WINNER', message: 'Review carrier offer' };
      case 'WINNER_SELECTED':
      case 'WINNING_AMOUNT_LOCKED':
        return { step: 6, availableAction: null, message: 'Waiting for carrier POD' };
      case 'POD_SUBMITTED':
        return { step: 7, availableAction: 'ACCEPT POD', message: 'Review POD' };
      case 'POD_ACCEPTED':
      case 'PAYMENT_RELEASED':
      case 'COMPLETED':
        return { step: 8, availableAction: null, message: 'Settlement and completed result' };
      default:
        return { step: 1, availableAction: null, message: 'Unknown state' };
    }
  } else {
    // CARRIER
    switch (lifecycleState) {
      case 'DRAFT':
      case 'SHIPMENT_DEFINED':
      case 'ESCROW_FUNDED':
        return { step: 1, availableAction: null, message: 'Waiting for shipper to activate the tender' };
      case 'TENDER_OPEN':
        return { step: 4, availableAction: 'SUBMIT TESTNET OFFER', message: 'Carrier qualification and offer input' };
      case 'OFFER_SUBMITTED':
        return { step: 5, availableAction: null, message: 'Waiting for shipper selection' };
      case 'WINNER_SELECTED':
      case 'WINNING_AMOUNT_LOCKED':
        return { step: 6, availableAction: 'UPLOAD DEMO POD', message: 'OFFER SELECTED' };
      case 'POD_SUBMITTED':
        return { step: 7, availableAction: null, message: 'Waiting for shipper review' };
      case 'POD_ACCEPTED':
      case 'PAYMENT_RELEASED':
      case 'COMPLETED':
        return { step: 8, availableAction: null, message: 'PAYMENT RECEIVED' };
      default:
        return { step: 1, availableAction: null, message: 'Unknown state' };
    }
  }
}
