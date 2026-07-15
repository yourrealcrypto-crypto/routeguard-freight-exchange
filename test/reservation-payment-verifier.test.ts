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
    ).toThrow(/Duplicate|USDC|20000|10000/i);
  });
});
