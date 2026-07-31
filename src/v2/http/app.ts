/**
 * Production composition for the RouteGuard v2 x402 access gates.
 *
 * Wires the real facilitator client, the durable file stores, and the trusted
 * carrier registry. Tests compose `createV2AccessApp` directly with injected
 * doubles instead of using this module, so no test-only switch ever reaches a
 * production request parameter.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { HTTPFacilitatorClient } from "@x402/core/server";
import { Hono } from "hono";

import { config as serverConfig } from "../../config";
import {
  InMemoryCarrierRegistry,
  type CarrierRegistry,
} from "../../domain/carrier";
import { X402AccessGate } from "../access/x402-gate";
import { UnknownPaymentSettlementReconciler } from "../access/payment-claim";
import type { V2AccessConfig } from "../config";
import { parseV2FreightTender, type V2FreightTender } from "../schemas/tender";
import { FileBidBodyStore } from "../store/bid-body-store";
import { LifecycleService } from "../store/lifecycle-service";
import { FileLifecycleStore } from "../store/lifecycle-store";
import { FilePaymentClaimStore } from "../store/payment-claim-store";
import { createV2AccessApp, type V2TenderCatalog } from "./routes";

export const V2_DATA_DIR_ENV_KEY = "ROUTEGUARD_V2_DATA_DIR" as const;
export const V2_CARRIER_REGISTRY_ENV_KEY =
  "ROUTEGUARD_V2_CARRIER_REGISTRY_PATH" as const;

/** Tender definitions on disk: `<dataDir>/tenders/tender-<id>-v<version>.json`. */
export class FileV2TenderCatalog implements V2TenderCatalog {
  constructor(private readonly dir: string) {}

  async get(
    tenderId: string,
    tenderVersion: number,
  ): Promise<V2FreightTender | null> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(tenderId)) {
      return null;
    }
    const file = path.join(
      this.dir,
      `tender-${tenderId}-v${tenderVersion}.json`,
    );
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    return parseV2FreightTender(JSON.parse(raw));
  }
}

function loadCarrierRegistry(registryPath: string | undefined): CarrierRegistry {
  if (!registryPath) {
    return new InMemoryCarrierRegistry([]);
  }
  const raw = readFileSync(registryPath, "utf8");
  const parsed = JSON.parse(raw);
  return new InMemoryCarrierRegistry(Array.isArray(parsed) ? parsed : []);
}

export function createConfiguredV2AccessApp(
  accessConfig: V2AccessConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Hono {
  const dataDir = env[V2_DATA_DIR_ENV_KEY]?.trim() || path.join("data", "v2");
  const carriers = loadCarrierRegistry(env[V2_CARRIER_REGISTRY_ENV_KEY]?.trim());

  const lifecycle = new LifecycleService(
    new FileLifecycleStore(path.join(dataDir, "lifecycle")),
    { carriers },
  );
  const bidBodies = new FileBidBodyStore(path.join(dataDir, "bids"));
  const paymentClaims = new FilePaymentClaimStore(path.join(dataDir, "payment-claims"));
  const tenders = new FileV2TenderCatalog(path.join(dataDir, "tenders"));

  const gate = new X402AccessGate({
    facilitator: new HTTPFacilitatorClient({ url: serverConfig.facilitatorUrl }),
    config: accessConfig,
    now: () => new Date().toISOString(),
  });

  return createV2AccessApp({
    lifecycle,
    bidBodies,
    tenders,
    carriers,
    gate,
    paymentClaims,
    paymentReconciler: new UnknownPaymentSettlementReconciler(),
    config: accessConfig,
    now: () => new Date().toISOString(),
  });
}
