import { describe, expect, it } from "vitest";

import { verifyMirrorPayment } from "../src/reservation/payment-verifier";
import { ReservationError } from "../src/reservation/types";
import type { SelectedPaymentOption } from "../src/reservation/types";
import { DEMO_PAYER_ACCOUNT, DEMO_WINNER_ACCOUNT } from "./fixtures/reservation-fixtures";

function selected(optionId: "USDC" | "HBAR"): SelectedPaymentOption {
  if (optionId === "HBAR") {
    return {
      reservationId: "r",
      offerHash: "sha256:" + "aa".repeat(32),
      offerVersion: 1,
      optionId: "HBAR",
      payerAccount: DEMO_PAYER_ACCOUNT,
      payTo: DEMO_WINNER_ACCOUNT,
      asset: "0.0.0",
      amountAtomic: "1000000",
      scheme: "exact",
      network: "hedera:testnet",
      selectedAt: "2026-07-15T19:00:00.000Z",
      resourcePath: "/api/reservations/r/pay/hbar",
    };
  }
  return {
    reservationId: "r",
    offerHash: "sha256:" + "aa".repeat(32),
    offerVersion: 1,
    optionId: "USDC",
    payerAccount: DEMO_PAYER_ACCOUNT,
    payTo: DEMO_WINNER_ACCOUNT,
    asset: "0.0.429274",
    amountAtomic: "10000",
    scheme: "exact",
    network: "hedera:testnet",
    selectedAt: "2026-07-15T19:00:00.000Z",
    resourcePath: "/api/reservations/r/pay/usdc",
  };
}

const TX = "0.0.9197513@1784142000.100000000";

describe("Payment verifier", () => {
  it("accepts valid HBAR confirmation", () => {
    const result = verifyMirrorPayment(
      selected("HBAR"),
      {
        status: "SUCCESS",
        transactionId: TX,
        consensusTimestamp: "2026-07-15T19:05:00.123456789Z",
        result: "SUCCESS",
        hbarTransfers: [
          { account: DEMO_PAYER_ACCOUNT, amount: "-1000000" },
          { account: DEMO_WINNER_ACCOUNT, amount: "1000000" },
          { account: "0.0.7162784", amount: "-50000" },
        ],
        tokenTransfers: [],
      },
      TX,
    );
    expect(result.ok).toBe(true);
    expect(result.optionId).toBe("HBAR");
  });

  it("accepts valid USDC confirmation", () => {
    const result = verifyMirrorPayment(
      selected("USDC"),
      {
        status: "SUCCESS",
        transactionId: TX,
        consensusTimestamp: "2026-07-15T19:05:00.123456789Z",
        result: "SUCCESS",
        hbarTransfers: [{ account: "0.0.7162784", amount: "-1000" }],
        tokenTransfers: [
          {
            account: DEMO_PAYER_ACCOUNT,
            amount: "-10000",
            tokenId: "0.0.429274",
          },
          {
            account: DEMO_WINNER_ACCOUNT,
            amount: "10000",
            tokenId: "0.0.429274",
          },
        ],
      },
      TX,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects wrong recipient, amount, payer, token, pending, missing ts", () => {
    expect(() =>
      verifyMirrorPayment(
        selected("HBAR"),
        {
          status: "SUCCESS",
          transactionId: TX,
          consensusTimestamp: "2026-07-15T19:05:00.123456789Z",
          result: "SUCCESS",
          hbarTransfers: [
            { account: DEMO_PAYER_ACCOUNT, amount: "-1000000" },
            { account: "0.0.1", amount: "1000000" },
          ],
          tokenTransfers: [],
        },
        TX,
      ),
    ).toThrow(/Receiver|HBAR_RECEIVER/i);

    expect(() =>
      verifyMirrorPayment(
        selected("USDC"),
        {
          status: "SUCCESS",
          transactionId: TX,
          consensusTimestamp: "2026-07-15T19:05:00.123456789Z",
          result: "SUCCESS",
          hbarTransfers: [],
          tokenTransfers: [
            {
              account: DEMO_PAYER_ACCOUNT,
              amount: "-9999",
              tokenId: "0.0.429274",
            },
            {
              account: DEMO_WINNER_ACCOUNT,
              amount: "9999",
              tokenId: "0.0.429274",
            },
          ],
        },
        TX,
      ),
    ).toThrow(/USDC|amount|10000/i);

    expect(() =>
      verifyMirrorPayment(
        selected("USDC"),
        {
          status: "SUCCESS",
          transactionId: TX,
          consensusTimestamp: "2026-07-15T19:05:00.123456789Z",
          result: "SUCCESS",
          hbarTransfers: [],
          tokenTransfers: [
            {
              account: DEMO_PAYER_ACCOUNT,
              amount: "-10000",
              tokenId: "0.0.999",
            },
            {
              account: DEMO_WINNER_ACCOUNT,
              amount: "10000",
              tokenId: "0.0.999",
            },
          ],
        },
        TX,
      ),
    ).toThrow(ReservationError);

    expect(() =>
      verifyMirrorPayment(
        selected("HBAR"),
        {
          status: "PENDING",
          transactionId: TX,
          consensusTimestamp: null,
          result: null,
          hbarTransfers: [],
          tokenTransfers: [],
        },
        TX,
      ),
    ).toThrow(/SUCCESS/i);

    expect(() =>
      verifyMirrorPayment(
        selected("HBAR"),
        {
          status: "SUCCESS",
          transactionId: TX,
          consensusTimestamp: null,
          result: "SUCCESS",
          hbarTransfers: [
            { account: DEMO_PAYER_ACCOUNT, amount: "-1000000" },
            { account: DEMO_WINNER_ACCOUNT, amount: "1000000" },
          ],
          tokenTransfers: [],
        },
        TX,
      ),
    ).toThrow(/Consensus/i);

    expect(() =>
      verifyMirrorPayment(
        selected("HBAR"),
        {
          status: "SUCCESS",
          transactionId: "other",
          consensusTimestamp: "2026-07-15T19:05:00.123456789Z",
          result: "SUCCESS",
          hbarTransfers: [
            { account: DEMO_PAYER_ACCOUNT, amount: "-1000000" },
            { account: DEMO_WINNER_ACCOUNT, amount: "1000000" },
          ],
          tokenTransfers: [],
        },
        TX,
      ),
    ).toThrow(/transaction ID/i);
  });

  it("rejects duplicate full-amount USDC payer transfers", () => {
    expect(() =>
      verifyMirrorPayment(
        selected("USDC"),
        {
          status: "SUCCESS",
          transactionId: TX,
          consensusTimestamp: "2026-07-15T19:05:00.123456789Z",
          result: "SUCCESS",
          hbarTransfers: [],
          tokenTransfers: [
            {
              account: DEMO_PAYER_ACCOUNT,
              amount: "-10000",
              tokenId: "0.0.429274",
            },
            {
              account: DEMO_PAYER_ACCOUNT,
              amount: "-10000",
              tokenId: "0.0.429274",
            },
            {
              account: DEMO_WINNER_ACCOUNT,
              amount: "10000",
              tokenId: "0.0.429274",
            },
          ],
        },
        TX,
      ),
    ).toThrow(/USDC_PAYER_SHAPE|exactly one|split|duplicate/i);
  });
});

describe("Strict transfer shape (M4)", () => {
  const USDC = "0.0.429274";
  const usdcOk = {
    status: "SUCCESS" as const,
    transactionId: TX,
    consensusTimestamp: "2026-07-15T19:05:00.123456789Z",
    result: "SUCCESS" as const,
  };

  it("USDC: two payer legs summing to -10000 are rejected (no net-sum pass)", () => {
    expect(() =>
      verifyMirrorPayment(
        selected("USDC"),
        {
          ...usdcOk,
          hbarTransfers: [],
          tokenTransfers: [
            { account: DEMO_PAYER_ACCOUNT, amount: "-5000", tokenId: USDC },
            { account: DEMO_PAYER_ACCOUNT, amount: "-5000", tokenId: USDC },
            { account: DEMO_WINNER_ACCOUNT, amount: "10000", tokenId: USDC },
          ],
        },
        TX,
      ),
    ).toThrow(/USDC_PAYER_SHAPE|split|exactly one/i);
  });

  it("USDC: two carrier legs summing to +10000 are rejected", () => {
    expect(() =>
      verifyMirrorPayment(
        selected("USDC"),
        {
          ...usdcOk,
          hbarTransfers: [],
          tokenTransfers: [
            { account: DEMO_PAYER_ACCOUNT, amount: "-10000", tokenId: USDC },
            { account: DEMO_WINNER_ACCOUNT, amount: "5000", tokenId: USDC },
            { account: DEMO_WINNER_ACCOUNT, amount: "5000", tokenId: USDC },
          ],
        },
        TX,
      ),
    ).toThrow(/USDC_RECEIVER_SHAPE|split|exactly one/i);
  });

  it("USDC: a third-party selected-token transfer is rejected", () => {
    expect(() =>
      verifyMirrorPayment(
        selected("USDC"),
        {
          ...usdcOk,
          hbarTransfers: [],
          tokenTransfers: [
            { account: DEMO_PAYER_ACCOUNT, amount: "-10000", tokenId: USDC },
            { account: DEMO_WINNER_ACCOUNT, amount: "10000", tokenId: USDC },
            { account: "0.0.55501", amount: "-10000", tokenId: USDC },
            { account: "0.0.55502", amount: "10000", tokenId: USDC },
          ],
        },
        TX,
      ),
    ).toThrow(/THIRD_PARTY|third-party/i);
  });

  it("USDC: a duplicate zero+non-zero payer entry is rejected explicitly", () => {
    expect(() =>
      verifyMirrorPayment(
        selected("USDC"),
        {
          ...usdcOk,
          hbarTransfers: [],
          tokenTransfers: [
            { account: DEMO_PAYER_ACCOUNT, amount: "-10000", tokenId: USDC },
            { account: DEMO_PAYER_ACCOUNT, amount: "0", tokenId: USDC },
            { account: DEMO_WINNER_ACCOUNT, amount: "10000", tokenId: USDC },
          ],
        },
        TX,
      ),
    ).toThrow(/USDC_PAYER_SHAPE|exactly one/i);
  });

  it("USDC: exact two-party transfer with unrelated hbar fee is accepted", () => {
    const result = verifyMirrorPayment(
      selected("USDC"),
      {
        ...usdcOk,
        hbarTransfers: [{ account: "0.0.7162784", amount: "-75699963" }],
        tokenTransfers: [
          { account: DEMO_PAYER_ACCOUNT, amount: "-10000", tokenId: USDC },
          { account: DEMO_WINNER_ACCOUNT, amount: "10000", tokenId: USDC },
        ],
      },
      TX,
    );
    expect(result.ok).toBe(true);
    expect(result.optionId).toBe("USDC");
  });

  const hbarOk = {
    status: "SUCCESS" as const,
    transactionId: TX,
    consensusTimestamp: "2026-07-15T19:05:00.123456789Z",
    result: "SUCCESS" as const,
    tokenTransfers: [],
  };

  it("HBAR: split payer legs are rejected (no net-sum pass)", () => {
    expect(() =>
      verifyMirrorPayment(
        selected("HBAR"),
        {
          ...hbarOk,
          hbarTransfers: [
            { account: DEMO_PAYER_ACCOUNT, amount: "-500000" },
            { account: DEMO_PAYER_ACCOUNT, amount: "-500000" },
            { account: DEMO_WINNER_ACCOUNT, amount: "1000000" },
          ],
        },
        TX,
      ),
    ).toThrow(/HBAR_PAYER_SHAPE|split|exactly one/i);
  });

  it("HBAR: split carrier legs are rejected", () => {
    expect(() =>
      verifyMirrorPayment(
        selected("HBAR"),
        {
          ...hbarOk,
          hbarTransfers: [
            { account: DEMO_PAYER_ACCOUNT, amount: "-1000000" },
            { account: DEMO_WINNER_ACCOUNT, amount: "500000" },
            { account: DEMO_WINNER_ACCOUNT, amount: "500000" },
          ],
        },
        TX,
      ),
    ).toThrow(/HBAR_RECEIVER_SHAPE|split|exactly one/i);
  });

  it("HBAR: an extra transfer involving the payer is rejected", () => {
    expect(() =>
      verifyMirrorPayment(
        selected("HBAR"),
        {
          ...hbarOk,
          hbarTransfers: [
            { account: DEMO_PAYER_ACCOUNT, amount: "-1000000" },
            { account: DEMO_PAYER_ACCOUNT, amount: "-25000" },
            { account: DEMO_WINNER_ACCOUNT, amount: "1000000" },
          ],
        },
        TX,
      ),
    ).toThrow(/HBAR_PAYER_SHAPE|exactly one/i);
  });

  it("HBAR: exact payment plus normal facilitator/network fee entries is accepted", () => {
    const result = verifyMirrorPayment(
      selected("HBAR"),
      {
        ...hbarOk,
        hbarTransfers: [
          { account: DEMO_PAYER_ACCOUNT, amount: "-1000000" },
          { account: DEMO_WINNER_ACCOUNT, amount: "1000000" },
          // Facilitator fee payer, node fee, and network fee accounts.
          { account: "0.0.7162784", amount: "-123456" },
          { account: "0.0.98", amount: "23456" },
          { account: "0.0.800", amount: "100000" },
        ],
      },
      TX,
    );
    expect(result.ok).toBe(true);
    // Fees recorded separately; payer/carrier semantics unaffected.
    expect(result.feeTransfers).toHaveLength(3);
  });
});
