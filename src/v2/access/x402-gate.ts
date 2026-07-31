/**
 * RouteGuard v2 x402 access gate.
 *
 * Uses the real x402 resource server (`@x402/core/server` + `ExactHederaScheme`)
 * to build payment requirements, verify payloads, and settle. The facilitator is
 * injected through the standard `FacilitatorClient` interface, so tests can
 * supply unpaid / verified / rejected / settlement-failure / duplicate /
 * delayed behavior without any network call and without test-only switches in
 * production request parameters.
 *
 * Ordering note: settlement completes **before** the protected lifecycle
 * transition is committed, so the durable access receipt always carries the
 * settlement identity. The Hono `paymentMiddleware` settles only after the
 * route handler has produced its response, which cannot bind a settlement id
 * into durable state — hence the explicit orchestration here.
 */

import {
  x402ResourceServer,
  type FacilitatorClient,
} from "@x402/core/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type {
  Network,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
} from "@x402/core/types";
import { ExactHederaScheme } from "@x402/hedera/exact/server";

import { canonicalSha256 } from "../../domain/canonical-hash";
import { paymentPayloadForCanonicalHash } from "../../domain/payment-payload-canonical";
import { isValidHederaAccountId } from "../../domain/payment-option";
import { isUtcIsoTimestamp } from "../../domain/time";
import type { V2AccessConfig } from "../config";
import type { AccessActionType } from "./fee";

const TRANSACTION_REF_RE = /^[A-Za-z0-9._@:-]{1,128}$/;

export const ACCESS_PAYMENT_HEADERS = [
  "payment-signature",
  "x-payment",
] as const;

export type AccessPaymentErrorCode =
  | "PAYMENT_INVALID"
  | "PAYMENT_SCHEME_MISMATCH"
  | "PAYMENT_NETWORK_MISMATCH"
  | "PAYMENT_ASSET_MISMATCH"
  | "PAYMENT_AMOUNT_MISMATCH"
  | "PAYMENT_RECIPIENT_MISMATCH"
  | "PAYMENT_RESOURCE_MISMATCH"
  | "PAYMENT_SETTLEMENT_FAILED";

export class AccessPaymentError extends Error {
  constructor(
    readonly code: AccessPaymentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AccessPaymentError";
  }
}

/** Canonical binding a payment must satisfy to authorize one access action. */
export type AccessActionBinding = {
  readonly actionType: AccessActionType;
  readonly tenderId: string;
  readonly tenderVersion: number;
  readonly bidId: string | null;
  /** Canonical protected resource path from the Phase A resource builders. */
  readonly resource: string;
  readonly description: string;
};

/** Normalized, settled access payment ready to be committed durably. */
export type SettledAccessPayment = {
  readonly transactionId: string;
  readonly payerAccount: string;
  readonly payTo: string;
  readonly asset: string;
  readonly amountAtomic: string;
  readonly resource: string;
  readonly paymentPayloadHash: string;
  /** Facilitator consensus timestamp when supplied, else the observation time. */
  readonly consensusTimestamp: string;
  readonly settledAt: string;
};

export type X402AccessGateDeps = {
  readonly facilitator: FacilitatorClient;
  readonly config: V2AccessConfig;
  /** Injected UTC clock; never `Date.now()` inside the gate. */
  readonly now: () => string;
};

/**
 * Read the x402 payment header, if any. Absence means "unpaid request" and must
 * produce a 402 challenge rather than an error.
 */
export function readAccessPaymentHeader(
  header: (name: string) => string | undefined,
): string | null {
  for (const name of ACCESS_PAYMENT_HEADERS) {
    const value = header(name);
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export class X402AccessGate {
  private readonly server: x402ResourceServer;
  private initialized: Promise<void> | null = null;

  constructor(private readonly deps: X402AccessGateDeps) {
    this.server = new x402ResourceServer(deps.facilitator).register(
      "hedera:*" as Network,
      new ExactHederaScheme(),
    );
  }

  /** Facilitator capability sync — performed once, lazily. */
  private async ready(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.server.initialize().catch((error: unknown) => {
        this.initialized = null;
        throw error;
      });
    }
    await this.initialized;
  }

  /** Build the exact payment requirements for one protected resource. */
  async requirementsFor(
    binding: AccessActionBinding,
  ): Promise<PaymentRequirements[]> {
    await this.ready();
    const { config } = this.deps;
    return this.server.buildPaymentRequirements({
      scheme: config.scheme,
      network: config.network as Network,
      payTo: config.accessTreasuryAccountId,
      price: {
        amount: config.amountAtomic,
        asset: config.asset,
      },
      maxTimeoutSeconds: config.maxTimeoutSeconds,
    });
  }

  /** Build the complete 402 body for an unpaid request. */
  async paymentRequired(
    binding: AccessActionBinding,
    error?: string,
  ): Promise<PaymentRequired> {
    const requirements = await this.requirementsFor(binding);
    return this.server.createPaymentRequiredResponse(
      requirements,
      {
        url: binding.resource,
        description: binding.description,
        mimeType: "application/json",
        serviceName: "routeguard-freight-exchange",
      },
      error,
    );
  }

  /** Decode an x402 payment header. Malformed payloads fail closed. */
  decodePayment(rawHeader: string): PaymentPayload {
    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(rawHeader);
    } catch {
      throw new AccessPaymentError(
        "PAYMENT_INVALID",
        "payment payload could not be decoded",
      );
    }
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof payload.x402Version !== "number" ||
      !payload.accepted ||
      typeof payload.accepted !== "object" ||
      !payload.payload ||
      typeof payload.payload !== "object"
    ) {
      throw new AccessPaymentError(
        "PAYMENT_INVALID",
        "payment payload is structurally invalid",
      );
    }
    return payload;
  }

  /**
   * Assert the declared payment terms match this exact protected action before
   * any facilitator call. Rejects wrong scheme, network, token, amount,
   * recipient, and any resource belonging to another tender, version, or bid.
   */
  assertBinding(payload: PaymentPayload, binding: AccessActionBinding): void {
    const { config } = this.deps;
    const accepted = payload.accepted;

    if (accepted.scheme !== config.scheme) {
      throw new AccessPaymentError(
        "PAYMENT_SCHEME_MISMATCH",
        `payment scheme must be ${config.scheme}`,
      );
    }
    if (accepted.network !== config.network) {
      throw new AccessPaymentError(
        "PAYMENT_NETWORK_MISMATCH",
        `payment network must be ${config.network}`,
      );
    }
    if (accepted.asset !== config.asset) {
      throw new AccessPaymentError(
        "PAYMENT_ASSET_MISMATCH",
        "payment asset is not the configured access token",
      );
    }
    if (accepted.amount !== config.amountAtomic) {
      throw new AccessPaymentError(
        "PAYMENT_AMOUNT_MISMATCH",
        "payment amount is not the exact access fee",
      );
    }
    if (accepted.payTo !== config.accessTreasuryAccountId) {
      throw new AccessPaymentError(
        "PAYMENT_RECIPIENT_MISMATCH",
        "payment recipient is not the configured access treasury",
      );
    }
    // The resource is what a payment buys: it must be declared and must be the
    // exact tender-versioned (and bid-bound) path for this action.
    const declaredResource = payload.resource?.url;
    if (typeof declaredResource !== "string" || declaredResource.length === 0) {
      throw new AccessPaymentError(
        "PAYMENT_RESOURCE_MISMATCH",
        "payment payload must declare the protected resource it pays for",
      );
    }
    if (declaredResource !== binding.resource) {
      throw new AccessPaymentError(
        "PAYMENT_RESOURCE_MISMATCH",
        "payment was issued for a different protected resource",
      );
    }
  }

  /**
   * Verify then settle. Returns a normalized settlement bound to the action.
   * Settlement precedes the durable lifecycle commit.
   */
  async verifyAndSettle(input: {
    payload: PaymentPayload;
    binding: AccessActionBinding;
  }): Promise<SettledAccessPayment> {
    const { payload, binding } = input;
    this.assertBinding(payload, binding);

    const requirements = await this.requirementsFor(binding);
    const matched =
      this.server.findMatchingRequirements(requirements, payload) ??
      undefined;
    if (!matched) {
      throw new AccessPaymentError(
        "PAYMENT_INVALID",
        "payment does not match any advertised payment requirement",
      );
    }

    const verified = await this.server.verifyPayment(payload, matched);
    if (!verified.isValid) {
      throw new AccessPaymentError(
        "PAYMENT_INVALID",
        "payment verification failed",
      );
    }

    const settled = await this.server.settlePayment(payload, matched);
    if (!settled.success) {
      throw new AccessPaymentError(
        "PAYMENT_SETTLEMENT_FAILED",
        "payment settlement did not succeed",
      );
    }
    const transactionId = settled.transaction;
    if (
      typeof transactionId !== "string" ||
      !TRANSACTION_REF_RE.test(transactionId)
    ) {
      throw new AccessPaymentError(
        "PAYMENT_INVALID",
        "settlement returned a malformed transaction reference",
      );
    }
    if (settled.network !== this.deps.config.network) {
      throw new AccessPaymentError(
        "PAYMENT_NETWORK_MISMATCH",
        "settlement network does not match the configured network",
      );
    }

    const payerAccount = settled.payer ?? verified.payer;
    if (
      typeof payerAccount !== "string" ||
      !isValidHederaAccountId(payerAccount)
    ) {
      throw new AccessPaymentError(
        "PAYMENT_INVALID",
        "settlement did not identify a valid payer account",
      );
    }
    if (payerAccount === this.deps.config.accessTreasuryAccountId) {
      throw new AccessPaymentError(
        "PAYMENT_RECIPIENT_MISMATCH",
        "payer and access treasury must differ",
      );
    }

    const observedAt = this.deps.now();
    const extraTimestamp = (settled.extra as { consensusTimestamp?: unknown } | undefined)
      ?.consensusTimestamp;
    const consensusTimestamp =
      typeof extraTimestamp === "string" && isUtcIsoTimestamp(extraTimestamp)
        ? extraTimestamp
        : observedAt;

    return {
      transactionId,
      payerAccount,
      payTo: matched.payTo,
      asset: matched.asset,
      amountAtomic: matched.amount,
      resource: binding.resource,
      paymentPayloadHash: canonicalSha256(
        paymentPayloadForCanonicalHash(payload),
      ),
      consensusTimestamp,
      settledAt: observedAt,
    };
  }
}
