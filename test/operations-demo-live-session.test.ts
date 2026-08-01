import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { PrivateKey } from "@hiero-ledger/sdk";
import type { PaymentRequired } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";

import { resolveOperationsDemoConfig } from "../src/operations-demo/config";
import {
  OPERATIONS_LIVE_BASELINE,
  OPERATIONS_LIVE_CONFIRM_VALUE,
  OPERATIONS_LIVE_MAX_WRITES,
  OPERATIONS_LIVE_REQUIRED_BRANCH,
  createOrLoadLiveSessionPlan,
} from "../src/operations-demo/live-preflight";
import { escrowTenderKey } from "../src/v2/escrow/tender-key";
import { X402Payer } from "../src/v2/live/x402-payer";
import { SUPERVISED_AUCTION_WINDOW_MS, loadOrCreateSupervisedRuntime } from "../src/operations-demo/live-composition";

describe("Operations Demo supervised live boundary", () => {
  it("pins the branch, baseline, explicit guard and exact twelve-write ceiling", () => {
    expect(OPERATIONS_LIVE_REQUIRED_BRANCH).toBe("testnet/routeguard-v2-operations-demo-session");
    expect(OPERATIONS_LIVE_BASELINE).toBe("b105809ec8730e39e277621726f140f0138f815e");
    expect(OPERATIONS_LIVE_CONFIRM_VALUE).toBe("I_UNDERSTAND_TESTNET_DEMO_SESSION_WRITES");
    expect(OPERATIONS_LIVE_MAX_WRITES).toBe(12);
    expect(SUPERVISED_AUCTION_WINDOW_MS).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it("keeps transaction construction inside extracted production services", () => {
    const source = readFileSync("scripts/run-v2-operations-demo-session-live.ts", "utf8");
    for (const forbidden of [
      "new ContractExecuteTransaction",
      "new AccountAllowanceApproveTransaction",
      "new TopicMessageSubmitTransaction",
      "new TopicCreateTransaction",
      "new ContractCreateTransaction",
    ]) expect(source).not.toContain(forbidden);
    expect(source).toContain("createLiveOperationsComposition");
    expect(source).toContain("/api/operations-demo/sessions");
  });

  it("persists one stable run identity with the canonical escrow tender key", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "routeguard-operations-plan-"));
    const first = createOrLoadLiveSessionPlan(dir);
    const second = createOrLoadLiveSessionPlan(dir);
    expect(second).toEqual(first);
    expect(first.tenderKey).toBe(escrowTenderKey(first.tenderId, 1));
    expect(new Set(Object.values(first.actionIds))).toHaveLength(8);
    expect(new Set(Object.values(first.idempotencyKeys))).toHaveLength(8);
  });

  it("persists the supervised deadline before writes and preserves it across restart", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "routeguard-operations-runtime-"));
    const createdAt = "2026-08-01T12:00:00.000Z";
    const first = loadOrCreateSupervisedRuntime(dir, () => createdAt);
    const second = loadOrCreateSupervisedRuntime(dir, () => "2026-08-01T13:00:00.000Z");
    expect(Date.parse(first.auctionEndsAt) - Date.parse(first.createdAt)).toBeGreaterThanOrEqual(30 * 60_000);
    expect(second).toEqual(first);
    expect(readFileSync(path.join(dir, "live-runtime.json"), "utf8")).toContain(first.auctionEndsAt);
  });

  it("allows persistent local paths only under the explicit supervised-process flag", () => {
    const operator = PrivateKey.generateECDSA();
    const carrier = PrivateKey.generateECDSA();
    const env = {
      ROUTEGUARD_OPERATIONS_LIVE_ENABLED: "true",
      ROUTEGUARD_OPERATIONS_SUPERVISED_LOCAL: "true",
      ROUTEGUARD_DEMO_DATA_DIR: "F:/tmp/demo-sessions",
      ROUTEGUARD_V2_DATA_DIR: "F:/tmp/v2",
      ROUTEGUARD_DEMO_ADMIN_TOKEN: "ephemeral-admin-token",
      ROUTEGUARD_OPERATOR_PRIVATE_KEY: operator.toStringRaw(),
      ROUTEGUARD_CARRIER_PRIVATE_KEY: carrier.toStringRaw(),
      ROUTEGUARD_OPERATOR_PUBLIC_KEY: operator.publicKey.toStringRaw(),
      ROUTEGUARD_CARRIER_PUBLIC_KEY: carrier.publicKey.toStringRaw(),
      ROUTEGUARD_POD_MASTER_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
    };
    expect(resolveOperationsDemoConfig(env).liveEnabled).toBe(true);
    expect(resolveOperationsDemoConfig(env)).toMatchObject({ idleTtlMinutes: 45, absoluteTtlMinutes: 60 });
    expect(resolveOperationsDemoConfig({ ...env, ROUTEGUARD_OPERATIONS_SUPERVISED_LOCAL: "false" }).liveEnabled).toBe(false);
  });

  it("binds the signed relative resource while calling the loopback endpoint and accepts the production accessPayment receipt", async () => {
    const payer = PrivateKey.generateECDSA();
    const resourceUrl = "/api/v2/tenders/RG-DEMO/v/1/activate";
    const requestUrl = `http://127.0.0.1:38766${resourceUrl}`;
    const required: PaymentRequired = {
      x402Version: 2,
      error: "PAYMENT_REQUIRED",
      resource: { url: resourceUrl, description: "RouteGuard access", mimeType: "application/json" },
      accepts: [{ scheme: "exact", network: "hedera:testnet", asset: "0.0.429274", amount: "1000", payTo: "0.0.9215954", maxTimeoutSeconds: 180, extra: { feePayer: "0.0.7162784" } }],
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(required), { status: 402, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessPayment: { transactionId: "0.0.9197513@1.2" } }), { status: 200, headers: { "content-type": "application/json" } }));
    const journal = vi.fn();
    const x402 = new X402Payer({ network: "hedera:testnet", payerAccountId: "0.0.9197513", privateKey: payer.toStringRaw(), tokenId: "0.0.429274", payTo: "0.0.9215954", amountAtomic: "1000", feePayer: "0.0.7162784" }, fetchImpl);
    const result = await x402.pay({ resourceUrl, requestUrl, body: { actionId: "activate-1" }, journalReceipt: journal });
    expect(result.transactionId).toBe("0.0.9197513@1.2");
    expect(fetchImpl).toHaveBeenNthCalledWith(1, requestUrl, expect.any(Object));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, requestUrl, expect.any(Object));
    expect(journal).toHaveBeenCalledOnce();
  });
});
