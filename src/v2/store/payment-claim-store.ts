import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { canonicalSha256 } from "../../domain/canonical-hash";
import { KeyedMutex } from "../../reservation/keyed-mutex";
import {
  PAYMENT_CLAIM_SCHEMA,
  PAYMENT_CLAIM_STATES,
  type PaymentClaim,
  type PaymentClaimBinding,
  type PaymentClaimResultRef,
  type PaymentClaimState,
} from "../access/payment-claim";
import type { SettledAccessPayment } from "../access/x402-gate";
import {
  acquireFileLock,
  releaseFileLock,
  resolveFileLockConfig,
} from "./file-lock";

export class PaymentClaimStoreError extends Error {
  constructor(
    readonly code:
      | "PAYMENT_CLAIM_CONFLICT"
      | "PAYMENT_ALREADY_USED"
      | "PAYMENT_RECOVERY_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "PaymentClaimStoreError";
  }
}

export type AcquirePaymentClaimResult = {
  readonly claim: PaymentClaim;
  readonly outcome: "CREATED" | "EXISTING";
};

export interface PaymentClaimStore {
  getByActionId(actionId: string): Promise<PaymentClaim | null>;
  acquire(binding: PaymentClaimBinding, now: string): Promise<AcquirePaymentClaimResult>;
  transition(input: {
    actionId: string;
    from: readonly PaymentClaimState[];
    to: PaymentClaimState;
    now: string;
    settlement?: SettledAccessPayment;
    resultRef?: PaymentClaimResultRef;
    failureCode?: string;
    retryable?: boolean;
  }): Promise<PaymentClaim>;
}

function sameBinding(a: PaymentClaimBinding, b: PaymentClaimBinding): boolean {
  return canonicalSha256(a) === canonicalSha256(b);
}

function createClaim(binding: PaymentClaimBinding, now: string): PaymentClaim {
  return {
    schemaVersion: PAYMENT_CLAIM_SCHEMA,
    claimVersion: 1,
    binding,
    state: "CLAIMED",
    settlement: null,
    resultRef: null,
    failureCode: null,
    retryable: null,
    createdAt: now,
    updatedAt: now,
  };
}

function acquireIn(claims: PaymentClaim[], binding: PaymentClaimBinding, now: string): AcquirePaymentClaimResult {
  const action = claims.find((claim) => claim.binding.actionId === binding.actionId);
  if (action) {
    if (!sameBinding(action.binding, binding)) {
      throw new PaymentClaimStoreError(
        "PAYMENT_CLAIM_CONFLICT",
        "actionId is bound to a different payment claim",
      );
    }
    return { claim: action, outcome: "EXISTING" };
  }
  if (claims.some((claim) => claim.binding.paymentPayloadHash === binding.paymentPayloadHash)) {
    throw new PaymentClaimStoreError(
      "PAYMENT_ALREADY_USED",
      "payment payload is already claimed by another action",
    );
  }
  const claim = createClaim(binding, now);
  claims.push(claim);
  return { claim, outcome: "CREATED" };
}

function transitionIn(claims: PaymentClaim[], input: Parameters<PaymentClaimStore["transition"]>[0]): PaymentClaim {
  const index = claims.findIndex((claim) => claim.binding.actionId === input.actionId);
  if (index < 0) {
    throw new PaymentClaimStoreError("PAYMENT_RECOVERY_FAILED", "payment claim was not found");
  }
  const current = claims[index]!;
  if (!input.from.includes(current.state)) {
    if (current.state === input.to) return current;
    throw new PaymentClaimStoreError("PAYMENT_RECOVERY_FAILED", "payment claim state changed concurrently");
  }
  if (input.settlement) {
    const duplicate = claims.find(
      (claim, i) => i !== index && claim.settlement?.transactionId === input.settlement!.transactionId,
    );
    if (duplicate) {
      throw new PaymentClaimStoreError("PAYMENT_ALREADY_USED", "settlement is already bound to another action");
    }
  }
  const next: PaymentClaim = {
    ...current,
    claimVersion: current.claimVersion + 1,
    state: input.to,
    settlement: input.settlement ?? current.settlement,
    resultRef: input.resultRef ?? current.resultRef,
    failureCode: input.failureCode ?? current.failureCode,
    retryable: input.retryable ?? current.retryable,
    updatedAt: input.now,
  };
  claims[index] = next;
  return next;
}

export class InMemoryPaymentClaimStore implements PaymentClaimStore {
  private readonly claims: PaymentClaim[] = [];
  private readonly mutex = new KeyedMutex();

  async getByActionId(actionId: string): Promise<PaymentClaim | null> {
    return this.claims.find((claim) => claim.binding.actionId === actionId) ?? null;
  }
  async acquire(binding: PaymentClaimBinding, now: string): Promise<AcquirePaymentClaimResult> {
    return this.mutex.runExclusive("claims", async () => acquireIn(this.claims, binding, now));
  }
  async transition(input: Parameters<PaymentClaimStore["transition"]>[0]): Promise<PaymentClaim> {
    return this.mutex.runExclusive("claims", async () => transitionIn(this.claims, input));
  }
}

type ClaimEnvelope = { schemaVersion: "routeguard-v2-payment-claims-1.0"; claims: PaymentClaim[] };

function parseEnvelope(raw: string): ClaimEnvelope {
  const value = JSON.parse(raw) as ClaimEnvelope;
  if (
    value?.schemaVersion !== "routeguard-v2-payment-claims-1.0" ||
    !Array.isArray(value.claims) ||
    value.claims.some((claim) =>
      claim.schemaVersion !== PAYMENT_CLAIM_SCHEMA ||
      !PAYMENT_CLAIM_STATES.includes(claim.state) ||
      !claim.binding ||
      typeof claim.binding.actionId !== "string" ||
      typeof claim.binding.paymentPayloadHash !== "string"
    )
  ) {
    throw new PaymentClaimStoreError("PAYMENT_RECOVERY_FAILED", "payment claim journal is invalid");
  }
  return value;
}

export class FilePaymentClaimStore implements PaymentClaimStore {
  private readonly file: string;
  private readonly lock: string;
  private readonly mutex = new KeyedMutex();

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "payment-claims.json");
    this.lock = path.join(dir, "payment-claims.lock");
  }

  private read(): ClaimEnvelope {
    try {
      return parseEnvelope(readFileSync(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: "routeguard-v2-payment-claims-1.0", claims: [] };
      }
      throw error;
    }
  }

  private write(value: ClaimEnvelope): void {
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, "wx");
    try {
      writeSync(fd, `${JSON.stringify(value, null, 2)}\n`, null, "utf8");
      try { fsyncSync(fd); } catch { /* best effort */ }
    } finally { closeSync(fd); }
    try { renameSync(tmp, this.file); }
    catch (error) { try { unlinkSync(tmp); } catch { /* owned temp only */ } throw error; }
  }

  private async mutate<T>(fn: (claims: PaymentClaim[]) => T): Promise<T> {
    return this.mutex.runExclusive("claims", async () => {
      const handle = await acquireFileLock(this.lock, "payment-claims", resolveFileLockConfig(), () => Date.now());
      try {
        const envelope = this.read();
        const result = fn(envelope.claims);
        this.write(envelope);
        return result;
      } finally { releaseFileLock(handle); }
    });
  }

  async getByActionId(actionId: string): Promise<PaymentClaim | null> {
    return this.read().claims.find((claim) => claim.binding.actionId === actionId) ?? null;
  }
  async acquire(binding: PaymentClaimBinding, now: string): Promise<AcquirePaymentClaimResult> {
    return this.mutate((claims) => acquireIn(claims, binding, now));
  }
  async transition(input: Parameters<PaymentClaimStore["transition"]>[0]): Promise<PaymentClaim> {
    return this.mutate((claims) => transitionIn(claims, input));
  }
}
