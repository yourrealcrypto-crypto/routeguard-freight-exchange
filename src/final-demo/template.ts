/**
 * Load public synthetic final-auction template (no secrets).
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { FINAL_DEMO_TEMPLATE_PATH } from "./constants";
import { FinalDemoError } from "./errors";

export type FinalAuctionTemplate = {
  schemaVersion: string;
  dataClassification: "PUBLIC_SYNTHETIC_DEMO";
  disclosure: string;
  network: "hedera:testnet";
  auction: {
    windowSeconds: number;
    barrierSafetyMarginMs: number;
    commitmentSubmitSafetyMarginMs: number;
  };
  route: {
    origin: string;
    destination: string;
    shipperId: string;
  };
  cargo: {
    type: string;
    weightKg: number;
    pallets: number;
    dangerousGoods: boolean;
  };
  equipment: string;
  maximumFreightPriceCents: number;
  selectionPolicy: "LOWEST_QUALIFIED_PRICE_V1";
  tenderVersion: number;
  relativeOffsets: {
    pickupEarliestAfterAuctionEndSeconds: number;
    pickupWindowDurationSeconds: number;
    deliveryAfterPickupLatestSeconds: number;
    bidValidAfterAuctionEndSeconds: number;
    alphaPickupOffsetSeconds: number;
    betaPickupOffsetSeconds: number;
    alphaDeliveryOffsetSeconds: number;
    betaDeliveryOffsetSeconds: number;
  };
  carriers: {
    alpha: {
      carrierId: string;
      carrierAccountId: string;
      displayName: string;
      allowedEquipment: string[];
      freightPriceCents: number;
    };
    beta: {
      carrierId: string;
      carrierAccountId: string;
      displayName: string;
      allowedEquipment: string[];
      freightPriceCents: number;
    };
  };
  reservationPayment: {
    usdc: {
      optionId: "USDC";
      scheme: "exact";
      network: "hedera:testnet";
      asset: string;
      amountAtomic: string;
      display: string;
    };
    hbarDisplayAlternative: {
      optionId: "HBAR";
      scheme: "exact";
      network: "hedera:testnet";
      asset: string;
      amountAtomic: string;
      display: string;
    };
  };
  accounts: {
    payerAccountId: string;
    winnerReceiverAccountId: string;
    carrierBetaDemoAccountId: string;
    facilitatorFeePayer: string;
  };
  writeBudgets: {
    plannedTopicCreates: 1;
    plannedHcsSubmissions: 5;
    plannedPaymentSubmissions: 1;
  };
  historicalTopicNote: string;
};

/** Match actual secret-bearing field names, not documentation prose. */
const PRIVATE_FIELD_RE =
  /["'](?:routeGuardPrivateKeyHex|signingPrivateKeyHex|carrierPrivateKey|operatorPrivateKey|payerPrivateKey|privateKeyHex|signingPrivateKey|secretKey|privateKey)["']\s*:/i;

export function loadFinalAuctionTemplate(
  templatePath?: string,
): FinalAuctionTemplate {
  const absolute = path.resolve(templatePath ?? FINAL_DEMO_TEMPLATE_PATH);
  if (!existsSync(absolute)) {
    throw new FinalDemoError(
      `Final auction template missing at ${absolute}`,
      "TEMPLATE_MISSING",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absolute, "utf8"));
  } catch {
    throw new FinalDemoError("Template is not valid JSON", "TEMPLATE_CORRUPT");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FinalDemoError("Template must be an object", "TEMPLATE_INVALID");
  }
  const o = raw as Record<string, unknown>;
  if (o.dataClassification !== "PUBLIC_SYNTHETIC_DEMO") {
    throw new FinalDemoError(
      "Template dataClassification must be PUBLIC_SYNTHETIC_DEMO",
      "TEMPLATE_INVALID",
    );
  }
  if (o.schemaVersion !== "final-auction-template-1.0") {
    throw new FinalDemoError(
      "Unsupported template schemaVersion",
      "TEMPLATE_INVALID",
    );
  }
  const text = JSON.stringify(raw);
  if (PRIVATE_FIELD_RE.test(text)) {
    throw new FinalDemoError(
      "Template must not contain private-key or secret fields",
      "TEMPLATE_CONTAINS_SECRETS",
    );
  }
  if (text.includes('"hcsTopicId"') && !text.includes('"hcsTopicId": null')) {
    // Allow only null in prohibited block
    const parsed = raw as FinalAuctionTemplate & {
      prohibited?: { hcsTopicId?: unknown };
    };
    if (parsed.prohibited?.hcsTopicId != null) {
      throw new FinalDemoError(
        "Template must not hard-code an HCS topic ID",
        "TEMPLATE_HAS_TOPIC",
      );
    }
  }
  return raw as FinalAuctionTemplate;
}
