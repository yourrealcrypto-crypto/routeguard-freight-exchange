import {
  AccountBalanceQuery,
  AccountId,
  Client,
  PrivateKey,
} from "@hiero-ledger/sdk";
import { config } from "../src/config";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function formatBalance(
  balance: Awaited<ReturnType<AccountBalanceQuery["execute"]>>,
): string {
  return `${balance.hbars.toString()} HBAR`;
}

async function main(): Promise<void> {
  if (config.network !== "hedera:testnet") {
    throw new Error("Account checks are restricted to Hedera Testnet.");
  }

  const shipperAccountIdText = requireEnv("SHIPPER_ACCOUNT_ID");
  const shipperPrivateKeyText = requireEnv("SHIPPER_PRIVATE_KEY");
  const carrierAccountIdText = requireEnv("CARRIER_ACCOUNT_ID");

  const shipperAccountId = AccountId.fromString(
    shipperAccountIdText,
  );

  const carrierAccountId = AccountId.fromString(
    carrierAccountIdText,
  );

  if (shipperAccountId.equals(carrierAccountId)) {
    throw new Error(
      "SHIPPER_ACCOUNT_ID and CARRIER_ACCOUNT_ID must be different.",
    );
  }

  const shipperPrivateKey = PrivateKey.fromString(
    shipperPrivateKeyText,
  );

  const client = Client.forTestnet();

  client.setOperator(
    shipperAccountId,
    shipperPrivateKey,
  );

  try {
    const shipperBalance = await new AccountBalanceQuery()
      .setAccountId(shipperAccountId)
      .execute(client);

    const carrierBalance = await new AccountBalanceQuery()
      .setAccountId(carrierAccountId)
      .execute(client);

    console.log("RouteGuard Freight Exchange account check");
    console.log("");
    console.log(`  network          : ${config.network}`);
    console.log(`  shipper account  : ${shipperAccountId}`);
    console.log(
      `  shipper balance  : ${formatBalance(shipperBalance)}`,
    );
    console.log(`  carrier account  : ${carrierAccountId}`);
    console.log(
      `  carrier balance  : ${formatBalance(carrierBalance)}`,
    );
    console.log("  shipper key      : accepted by Hedera SDK");
    console.log("");
    console.log("ACCOUNT_CHECK_PASSED");
  } finally {
    client.close();
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : String(error);

  console.error(`ACCOUNT_CHECK_FAILED: ${message}`);
  process.exitCode = 1;
});