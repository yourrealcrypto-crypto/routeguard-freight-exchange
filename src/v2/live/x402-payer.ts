import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";

import { canonicalSha256 } from "../../domain/canonical-hash";

export type X402PayerConfig = {
  readonly network: "hedera:testnet";
  readonly payerAccountId: string;
  readonly privateKey: string;
  readonly tokenId: "0.0.429274";
  readonly payTo: string;
  readonly amountAtomic: "1000";
  readonly feePayer: string;
};

export type SignedX402Request = { readonly header: string; readonly payloadHash: string };

export async function createSignedX402Request(input: {
  readonly config: X402PayerConfig;
  readonly paymentRequired: PaymentRequired;
  readonly resourceUrl: string;
}): Promise<SignedX402Request> {
  const { config } = input;
  const accepted = input.paymentRequired.accepts?.[0];
  if (!accepted || accepted.scheme !== "exact" || accepted.network !== config.network) throw new Error("x402 scheme/network mismatch");
  if (accepted.asset !== config.tokenId || accepted.amount !== config.amountAtomic || accepted.payTo !== config.payTo) {
    throw new Error("x402 fixed payment binding mismatch");
  }
  const [core, hedera, exact] = await Promise.all([
    import("@x402/core/client"), import("@x402/hedera"), import("@x402/hedera/exact/client"),
  ]);
  let privateKey: ReturnType<typeof hedera.PrivateKey.fromStringECDSA>;
  try { privateKey = hedera.PrivateKey.fromStringECDSA(config.privateKey); }
  catch { throw new Error("x402 signing key is invalid"); }
  const signer = hedera.createClientHederaSigner(config.payerAccountId, privateKey, { network: config.network });
  const requirement: PaymentRequirements = {
    scheme: "exact", network: config.network, asset: config.tokenId, amount: config.amountAtomic,
    payTo: config.payTo, maxTimeoutSeconds: accepted.maxTimeoutSeconds,
    extra: { ...(accepted.extra ?? {}), feePayer: config.feePayer },
  };
  const client = new core.x402Client((version, requirements) => {
    if (version !== 2 || requirements.length !== 1) throw new Error("x402 v2 exact requirement expected");
    return requirements[0]!;
  }).register(config.network, new exact.ExactHederaScheme(signer));
  const payload: PaymentPayload = await client.createPaymentPayload({
    x402Version: 2,
    error: "Payment required for RouteGuard Operations Demo access",
    resource: { url: input.resourceUrl, description: input.paymentRequired.resource?.description ?? "RouteGuard access fee", mimeType: "application/json" },
    accepts: [requirement],
  });
  if (payload.resource?.url !== input.resourceUrl) (payload as { resource: { url: string } }).resource = { url: input.resourceUrl };
  return {
    header: encodePaymentSignatureHeader(payload),
    payloadHash: canonicalSha256({ x402Version: payload.x402Version, accepted: payload.accepted, resourceUrl: payload.resource?.url ?? null }),
  };
}

export type X402PaymentResult = {
  readonly transactionId: string;
  readonly payloadHash: string;
  readonly receiptStatus: "SUCCESS";
  readonly responseBody: Readonly<Record<string, unknown>>;
};

export class X402Payer {
  constructor(private readonly config: X402PayerConfig, private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  async pay(input: {
    readonly resourceUrl: string;
    readonly body: Readonly<Record<string, unknown>>;
    readonly journalReceipt: (result: X402PaymentResult) => Promise<void> | void;
  }): Promise<X402PaymentResult> {
    const unpaid = await this.fetchImpl(input.resourceUrl, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(input.body),
    });
    if (unpaid.status !== 402) throw new Error("protected resource did not return x402 challenge");
    const required = (await unpaid.json()) as PaymentRequired;
    const signed = await createSignedX402Request({ config: this.config, paymentRequired: required, resourceUrl: input.resourceUrl });
    const paid = await this.fetchImpl(input.resourceUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "payment-signature": signed.header },
      body: JSON.stringify(input.body),
    });
    if (!paid.ok) throw new Error(`x402 protected action failed with HTTP ${paid.status}`);
    const body = (await paid.json()) as Record<string, unknown>;
    const payment = body.payment as Record<string, unknown> | undefined;
    const transactionId = typeof payment?.transactionId === "string" ? payment.transactionId : null;
    if (!transactionId) throw new Error("x402 response omitted settlement transaction id");
    const result: X402PaymentResult = { transactionId, payloadHash: signed.payloadHash, receiptStatus: "SUCCESS", responseBody: body };
    await input.journalReceipt(result);
    return result;
  }
}
