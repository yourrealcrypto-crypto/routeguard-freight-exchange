/**
 * Phase B1 — POST /api/v2/tenders/:tenderId/v/:tenderVersion/activate
 * Real x402 route composition with an injected facilitator double.
 * No network write, no live settlement, no HCS submission.
 */

import { describe, expect, it } from "vitest";

import { deriveAccessFeeAtomic } from "../src/v2/access/fee";
import { tenderActivateResource } from "../src/v2/access/resource";
import { buildTenderOpenedEnvelope } from "../src/v2/hcs/outbox";
import {
  activatePath,
  createHarness,
  post,
  PAYER_ACCOUNT,
  TENDER_ID,
  TENDER_VERSION,
} from "./v2-access-route-fixtures";
import { BUDGET, TREASURY } from "./v2-lifecycle-fixtures";

describe("v2 tender activation x402 route", () => {
  it("returns 402 with exact scheme, network, token, amount, treasury and resource", async () => {
    const h = await createHarness();
    const response = await post(h.app, activatePath(), { actionId: "act-1" });

    expect(response.status).toBe(402);
    expect(response.headers.get("PAYMENT-REQUIRED")).toBeTruthy();

    const body = (await response.json()) as {
      error: string;
      accepts: {
        scheme: string;
        network: string;
        asset: string;
        amount: string;
        payTo: string;
      }[];
      resource: { url: string };
    };
    expect(body.error).toBe("PAYMENT_REQUIRED");
    const accepted = body.accepts[0]!;
    expect(accepted.scheme).toBe("exact");
    expect(accepted.network).toBe("hedera:testnet");
    expect(accepted.asset).toBe("0.0.429274");
    expect(accepted.amount).toBe("1000");
    expect(accepted.amount).toBe(deriveAccessFeeAtomic());
    expect(accepted.payTo).toBe(TREASURY);
    expect(body.resource.url).toBe(
      tenderActivateResource(TENDER_ID, TENDER_VERSION),
    );
    expect(body.resource.url).toContain(`/v/${TENDER_VERSION}/`);

    // No facilitator settlement for an unpaid request.
    expect(h.facilitator.settleCalls).toBe(0);
    expect((await h.record())!.state).toBe("ESCROW_FUNDED");
  });

  it("the access fee is distinct from the freight budget", async () => {
    const h = await createHarness();
    const response = await post(h.app, activatePath(), { actionId: "act-1" });
    const body = (await response.json()) as { accepts: { amount: string }[] };
    expect(body.accepts[0]!.amount).toBe("1000");
    expect(body.accepts[0]!.amount).not.toBe(BUDGET);
    expect((await h.record())!.maximumFreightBudgetAtomic).toBe(BUDGET);
  });

  it("repeated unpaid requests return the same deterministic requirements", async () => {
    const h = await createHarness();
    const first = await post(h.app, activatePath(), { actionId: "act-1" });
    const second = await post(h.app, activatePath(), { actionId: "act-1" });
    expect(first.status).toBe(402);
    expect(second.status).toBe(402);
    const a = (await first.json()) as { accepts: unknown };
    const b = (await second.json()) as { accepts: unknown };
    expect(JSON.stringify(a.accepts)).toBe(JSON.stringify(b.accepts));
  });

  it("issues no payment challenge in a wrong lifecycle state", async () => {
    const draft = await createHarness({ seedState: "DRAFT" });
    const response = await post(draft.app, activatePath(), { actionId: "act-1" });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("ESCROW_NOT_CONFIRMED");
    expect(draft.facilitator.verifyCalls).toBe(0);
    expect(draft.facilitator.settleCalls).toBe(0);
  });

  it("issues no payment challenge for an unknown tender or version", async () => {
    const h = await createHarness();
    const missing = await post(h.app, activatePath("nope"), {
      actionId: "act-1",
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("TENDER_NOT_FOUND");

    const wrongVersion = await post(h.app, activatePath(TENDER_ID, 9), {
      actionId: "act-1",
    });
    expect(wrongVersion.status).toBe(404);
    expect((await wrongVersion.json()).error).toBe("TENDER_VERSION_MISMATCH");
    expect(h.facilitator.settleCalls).toBe(0);
  });

  it("issues no payment challenge for an invalid request body", async () => {
    const h = await createHarness();
    const response = await post(h.app, activatePath(), { nope: true });
    expect(response.status).toBe(400);
    expect(h.facilitator.verifyCalls).toBe(0);
    expect(h.facilitator.settleCalls).toBe(0);
  });

  it("paid retry returns 200, moves ESCROW_FUNDED to TENDER_OPENED and persists the receipt", async () => {
    const h = await createHarness();
    const header = await h.paymentHeader(h.activationBinding());
    const response = await post(
      h.app,
      activatePath(),
      { actionId: "act-1" },
      { "X-PAYMENT": header },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      outcome: string;
      tender: { state: string; recordVersion: number };
      accessPayment: {
        asset: string;
        amountAtomic: string;
        payTo: string;
        payerAccount: string;
        resource: string;
        transactionId: string;
        status: string;
      };
    };
    expect(body.outcome).toBe("PAID");
    expect(body.tender.state).toBe("TENDER_OPENED");
    expect(body.accessPayment.asset).toBe("0.0.429274");
    expect(body.accessPayment.amountAtomic).toBe("1000");
    expect(body.accessPayment.payTo).toBe(TREASURY);
    expect(body.accessPayment.payerAccount).toBe(PAYER_ACCOUNT);
    expect(body.accessPayment.status).toBe("PAID");

    const record = (await h.record())!;
    expect(record.state).toBe("TENDER_OPENED");
    expect(record.accessReceipt).toMatchObject({
      accessActionType: "TENDER_ACTIVATE",
      asset: "0.0.429274",
      amountAtomic: "1000",
      payTo: TREASURY,
      resource: tenderActivateResource(TENDER_ID, TENDER_VERSION),
    });
    expect(record.accessPayments).toHaveLength(1);
    expect(record.accessPayments[0]!.paymentTransactionId).toBe(
      h.facilitator.settledTransactions[0],
    );
    expect(h.facilitator.verifyCalls).toBe(1);
    expect(h.facilitator.settleCalls).toBe(1);
  });

  it("builds a valid unsubmitted TENDER_OPENED HCS envelope", async () => {
    const h = await createHarness();
    const header = await h.paymentHeader(h.activationBinding());
    await post(h.app, activatePath(), { actionId: "act-1" }, { "X-PAYMENT": header });

    const envelope = buildTenderOpenedEnvelope((await h.record())!);
    expect(envelope.messageType).toBe("TENDER_OPENED");
    expect(envelope.tenderId).toBe(TENDER_ID);
    expect(envelope.payload).toMatchObject({
      maxBudgetAtomic: BUDGET,
      selectionPolicy: "LOWEST_QUALIFIED_PRICE_V1",
    });
  });

  it.each([
    ["wrong amount", { amount: "999" }, "PAYMENT_AMOUNT_MISMATCH"],
    ["wrong asset", { asset: "0.0.111111" }, "PAYMENT_ASSET_MISMATCH"],
    ["wrong treasury", { payTo: "0.0.4242" }, "PAYMENT_RECIPIENT_MISMATCH"],
    ["wrong scheme", { scheme: "upto" }, "PAYMENT_SCHEME_MISMATCH"],
    [
      "wrong network",
      { network: "hedera:mainnet" as const },
      "PAYMENT_NETWORK_MISMATCH",
    ],
  ])("rejects a payment with the %s", async (_label, override, expected) => {
    const h = await createHarness();
    const header = await h.paymentHeader(
      h.activationBinding(),
      override as never,
    );
    const response = await post(
      h.app,
      activatePath(),
      { actionId: "act-1" },
      { "X-PAYMENT": header },
    );
    expect(response.status).toBe(402);
    expect((await response.json()).error).toBe(expected);
    expect(h.facilitator.settleCalls).toBe(0);
    expect((await h.record())!.state).toBe("ESCROW_FUNDED");
  });

  it("rejects a payment issued for another resource or tender version", async () => {
    const h = await createHarness();

    const otherResource = await h.paymentHeader(h.activationBinding(), {
      resourceUrl: "/api/v2/tenders/other/v/1/activate",
    });
    const wrongResource = await post(
      h.app,
      activatePath(),
      { actionId: "act-1" },
      { "X-PAYMENT": otherResource },
    );
    expect(wrongResource.status).toBe(402);
    expect((await wrongResource.json()).error).toBe("PAYMENT_RESOURCE_MISMATCH");

    const otherVersion = await h.paymentHeader(h.activationBinding(), {
      resourceUrl: tenderActivateResource(TENDER_ID, 2),
    });
    const wrongVersion = await post(
      h.app,
      activatePath(),
      { actionId: "act-2" },
      { "X-PAYMENT": otherVersion },
    );
    expect(wrongVersion.status).toBe(402);
    expect((await wrongVersion.json()).error).toBe("PAYMENT_RESOURCE_MISMATCH");
    expect(h.facilitator.settleCalls).toBe(0);
  });

  it("rejects a payment that declares no resource", async () => {
    const h = await createHarness();
    const header = await h.paymentHeader(h.activationBinding(), {
      resourceUrl: "",
    });
    const response = await post(
      h.app,
      activatePath(),
      { actionId: "act-1" },
      { "X-PAYMENT": header },
    );
    expect(response.status).toBe(402);
    expect((await response.json()).error).toBe("PAYMENT_RESOURCE_MISMATCH");
  });

  it("fails closed when verification is rejected", async () => {
    const h = await createHarness({
      script: { verify: () => ({ isValid: false, invalidReason: "bad" }) },
    });
    const header = await h.paymentHeader(h.activationBinding());
    const response = await post(
      h.app,
      activatePath(),
      { actionId: "act-1" },
      { "X-PAYMENT": header },
    );
    expect(response.status).toBe(402);
    expect((await response.json()).error).toBe("PAYMENT_INVALID");
    expect(h.facilitator.settleCalls).toBe(0);
    expect((await h.record())!.state).toBe("ESCROW_FUNDED");
  });

  it("fails closed when settlement fails", async () => {
    const h = await createHarness({
      script: {
        settle: () => ({
          success: false,
          transaction: "",
          network: "hedera:testnet",
          errorReason: "insufficient_funds",
        }),
      },
    });
    const header = await h.paymentHeader(h.activationBinding());
    const response = await post(
      h.app,
      activatePath(),
      { actionId: "act-1" },
      { "X-PAYMENT": header },
    );
    expect(response.status).toBe(402);
    expect((await response.json()).error).toBe("PAYMENT_SETTLEMENT_FAILED");
    expect((await h.record())!.state).toBe("ESCROW_FUNDED");
    expect((await h.record())!.accessPayments).toHaveLength(0);
  });

  it("fails closed on a malformed settlement transaction reference", async () => {
    const h = await createHarness({
      script: {
        settle: () => ({
          success: true,
          transaction: "not a transaction id!!",
          network: "hedera:testnet",
          payer: PAYER_ACCOUNT,
        }),
      },
    });
    const header = await h.paymentHeader(h.activationBinding());
    const response = await post(
      h.app,
      activatePath(),
      { actionId: "act-1" },
      { "X-PAYMENT": header },
    );
    expect(response.status).toBe(402);
    expect((await response.json()).error).toBe("PAYMENT_INVALID");
    expect((await h.record())!.state).toBe("ESCROW_FUNDED");
  });

  it("tolerates a delayed facilitator result", async () => {
    const h = await createHarness({ script: { delayMs: 15 } });
    const header = await h.paymentHeader(h.activationBinding());
    const response = await post(
      h.app,
      activatePath(),
      { actionId: "act-1" },
      { "X-PAYMENT": header },
    );
    expect(response.status).toBe(200);
    expect((await h.record())!.state).toBe("TENDER_OPENED");
  });
});
