import { canonicalSha256 } from "../domain/canonical-hash";
import { DemoError } from "./errors";
import type { DemoAction, DemoActionRequest, DemoWorkflowState } from "./types";

export const ACTION_TRANSITIONS: Readonly<Record<DemoAction, readonly [DemoWorkflowState, DemoWorkflowState] | null>> = Object.freeze({
  FUND_ESCROW: ["CREATED", "ESCROW_FUNDED"],
  OPEN_TENDER: ["ESCROW_FUNDED", "ACCESS_ACTIVATED"],
  SUBMIT_OFFER: ["ACCESS_ACTIVATED", "OFFER_ACCEPTED"],
  SELECT_WINNER: ["OFFER_ACCEPTED", "WINNER_ALLOCATED"],
  SUBMIT_POD: ["WINNER_ALLOCATED", "POD_SUBMITTED"],
  RUN_ADVISORY: ["POD_SUBMITTED", "ADVISORY_ANCHORED"],
  ACCEPT_POD: ["ADVISORY_ANCHORED", "POD_ACCEPTED"],
  RELEASE_FREIGHT: ["POD_ACCEPTED", "COMPLETED"],
  REQUEST_CORRECTION: null,
  OPEN_DISPUTE: null,
});

const FORBIDDEN_NETWORK_FIELDS = new Set([
  "amount", "amountAtomic", "token", "tokenId", "recipient", "payTo", "winner", "winnerAccount",
  "account", "accountId", "address", "contract", "contractId", "contractAddress", "topic", "topicId",
  "network", "allowance", "allowanceAmount", "settlementAmount", "privateKey", "mnemonic",
]);

export function assertSafeActionRequest(request: DemoActionRequest): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(request.actionId)) throw new DemoError("DEMO_ACTION_CONFLICT", "actionId is invalid");
  if (request.idempotencyKey.length < 8 || request.idempotencyKey.length > 256) throw new DemoError("DEMO_ACTION_CONFLICT", "idempotencyKey is invalid");
  const inspect = (value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_NETWORK_FIELDS.has(key)) throw new DemoError("DEMO_ACTION_CONFLICT", `${key} is server-controlled`);
      inspect(nested);
    }
  };
  inspect(request.payload);
}

export function transitionFor(state: DemoWorkflowState, action: DemoAction): DemoWorkflowState {
  if (state === "COMPLETED" || state === "EXPIRED" || state === "ABORTED") {
    throw new DemoError("DEMO_ACTION_NOT_ALLOWED", `${state} is terminal`, 409);
  }
  const transition = ACTION_TRANSITIONS[action];
  if (!transition || transition[0] !== state) throw new DemoError("DEMO_ACTION_NOT_ALLOWED", `${action} is not allowed from ${state}`, 409);
  return transition[1];
}

export function actionIdentityHash(request: DemoActionRequest): string {
  return canonicalSha256({ action: request.action, actionId: request.actionId, idempotencyKey: request.idempotencyKey, payload: request.payload });
}

export function availableActions(state: DemoWorkflowState): readonly DemoAction[] {
  if (state === "POD_SUBMITTED") return ["RUN_ADVISORY"];
  return (Object.entries(ACTION_TRANSITIONS) as Array<[DemoAction, readonly [DemoWorkflowState, DemoWorkflowState] | null]>)
    .filter(([, transition]) => transition?.[0] === state)
    .map(([action]) => action);
}
