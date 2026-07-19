/**
 * Owner-operated deterministic settlement reconciliation (v1.5 §23.2–§23.3).
 *
 *   npm run reconcile:payment -- --reservation-id=<id> [--dir=<store dir>] [--apply]
 *
 * Read-only by default: performs the EXACT-transaction Mirror lookup for the
 * client-frozen transaction persisted on the reservation (settle claim or
 * clientTransaction binding), verifies network/payer/recipient/asset/amount
 * via the exact transfer-shape verifier, and prints the deterministic verdict:
 *
 *   FOUND_SUCCESS            — exact tx SUCCESS on ledger (invariant 1 payment)
 *   FOUND_FAILED             — exact tx present with non-SUCCESS result
 *   RECONCILIATION_PENDING   — no record yet AND validity window not elapsed
 *   CONCLUSIVELY_FAILED      — no record AND validStart+duration+60 s elapsed
 *
 * With --apply, durable state is updated through compare-and-set:
 *   FOUND_SUCCESS → adopt the exact transaction (MIRROR_CONFIRMATION_PENDING);
 *                   complete the run with the production orchestrator
 *                   (npm run demo:final-auction), never from this CLI.
 *   FOUND_FAILED / CONCLUSIVELY_FAILED → terminal failure state.
 * This CLI NEVER signs, settles, creates webhooks, or publishes HCS messages.
 * Requires no private keys.
 */

import "dotenv/config";

import {
  FileSystemReservationStore,
} from "../src/reservation/attempt-store";
import { recoverInProgressState } from "../src/reservation/attempt-store";
import {
  conclusiveFailureBoundaryMs,
  SETTLEMENT_SAFETY_BUFFER_SECONDS,
} from "../src/reservation/client-transaction";
import { LiveMirrorTransactionAdapter } from "../src/reservation/live/adapters";
import { verifyMirrorPayment } from "../src/reservation/payment-verifier";
import type { ReservationRecord } from "../src/reservation/types";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const reservationId = arg("reservation-id");
  if (!reservationId) {
    console.error(
      "Usage: npm run reconcile:payment -- --reservation-id=<id> [--dir=<store dir>] [--apply]",
    );
    process.exitCode = 2;
    return;
  }
  const dir = arg("dir") ?? "data/final-demo-live-reservations";
  const apply = flag("apply");

  const store = new FileSystemReservationStore(dir);
  const record = await store.get(reservationId);
  if (!record) {
    console.error(`NOT_FOUND: reservation ${reservationId} in ${dir}`);
    process.exitCode = 2;
    return;
  }

  console.log(`Reservation : ${record.reservationId}`);
  console.log(`State       : ${record.state}`);
  console.log(`Attempt no. : ${record.attemptNumber}`);

  if (record.routeReserved) {
    console.log("Verdict     : FOUND_SUCCESS (already ROUTE_RESERVED)");
    console.log(`  On-chain payments: 1`);
    console.log(`  Reservations:      1`);
    console.log(`  Transaction: ${record.routeReserved.transactionId}`);
    return;
  }

  const ref = record.settleClaim ?? record.clientTransaction;
  if (!ref || !("transactionId" in ref) || !ref.transactionId) {
    console.error(
      "NOT_RECONCILABLE: no client-frozen transaction identity persisted (pre-submission state — nothing was signed for submission).",
    );
    process.exitCode = 2;
    return;
  }
  const exactTxId = ref.transactionId;
  const boundaryMs = conclusiveFailureBoundaryMs(ref);
  const boundaryIso = new Date(boundaryMs).toISOString();
  console.log(`Exact tx    : ${exactTxId}`);
  console.log(`Valid start : ${ref.validStartTimestamp}`);
  console.log(
    `Window      : ${ref.transactionValidDurationSeconds}s + ${SETTLEMENT_SAFETY_BUFFER_SECONDS}s buffer → boundary ${boundaryIso}`,
  );

  const mirror = new LiveMirrorTransactionAdapter();
  const confirmation = await mirror.getTransaction(exactTxId);
  console.log(`Mirror      : ${confirmation.status} (result=${confirmation.result ?? "n/a"})`);

  if (confirmation.status === "SUCCESS") {
    // Exact verification: network legs, payer, recipient, asset, amount.
    if (record.selected) {
      const verified = verifyMirrorPayment(record.selected, confirmation, exactTxId);
      console.log(
        `Verified    : ${verified.amountAtomic} atomic of ${verified.asset} — ${verified.payerAccount} → ${verified.payTo}`,
      );
      console.log(`Consensus   : ${verified.consensusTimestamp}`);
    }
    console.log("Verdict     : FOUND_SUCCESS");
    console.log("  On-chain payments: 1");
    console.log(`  Reservations:      ${record.routeReserved ? 1 : 0}`);
    if (apply && !record.transactionId) {
      const adopted = recoverInProgressState(record, { transactionId: exactTxId });
      if (adopted.state !== record.state || adopted.transactionId !== record.transactionId) {
        await store.compareAndSet(reservationId, record.recordVersion, {
          ...adopted,
          updatedAt: new Date().toISOString(),
        } as ReservationRecord);
        console.log("Applied     : adopted exact transaction → MIRROR_CONFIRMATION_PENDING");
      }
    }
    console.log(
      "Next        : rerun the production orchestrator (npm run demo:final-auction with live flags) to complete confirmation → reservation. Do NOT pay again.",
    );
    return;
  }

  if (confirmation.status === "FAILED") {
    console.log("Verdict     : FOUND_FAILED (exact transaction has non-SUCCESS result)");
    console.log("  On-chain payments: 0 (failed transaction)");
    console.log("  Reservations:      0");
    if (apply) {
      const failureState =
        record.state === "PAYMENT_SUBMISSION_STARTED"
          ? "PAYMENT_REJECTED"
          : "SETTLEMENT_FAILED";
      await store.compareAndSet(reservationId, record.recordVersion, {
        ...record,
        state: failureState,
        failureCode: "SETTLE_RESULT_FAILED_ON_LEDGER",
        failureReason: `Exact transaction ${exactTxId} result ${confirmation.result ?? "unknown"}`,
        updatedAt: new Date().toISOString(),
        history: [
          ...record.history,
          {
            from: record.state,
            to: failureState,
            at: new Date().toISOString(),
            reason: "reconcile:payment FOUND_FAILED",
          },
        ],
      } as ReservationRecord);
      console.log(`Applied     : ${failureState}`);
    }
    return;
  }

  // NOT_FOUND / PENDING
  const now = Date.now();
  if (confirmation.status === "PENDING" || now <= boundaryMs) {
    console.log(`Verdict     : RECONCILIATION_PENDING (until ${boundaryIso})`);
    console.log("  Do NOT start a replacement payment. Re-run after the boundary.");
    return;
  }
  console.log("Verdict     : CONCLUSIVELY_FAILED");
  console.log("  Rule: exact lookup empty AND validStart + validDuration + 60 s elapsed.");
  console.log("  On-chain payments: 0");
  console.log("  Reservations:      0");
  if (apply) {
    const failureState =
      record.state === "PAYMENT_SUBMISSION_STARTED"
        ? "PAYMENT_REJECTED"
        : "SETTLEMENT_FAILED";
    await store.compareAndSet(reservationId, record.recordVersion, {
      ...record,
      state: failureState,
      failureCode: "CONCLUSIVELY_FAILED",
      failureReason: `No ledger record for ${exactTxId} after ${boundaryIso}`,
      updatedAt: new Date().toISOString(),
      history: [
        ...record.history,
        {
          from: record.state,
          to: failureState,
          at: new Date().toISOString(),
          reason: "reconcile:payment CONCLUSIVELY_FAILED",
        },
      ],
    } as ReservationRecord);
    console.log(`Applied     : ${failureState} (CONCLUSIVELY_FAILED)`);
    console.log(
      "  A replacement attempt (any seller-supported asset) may now be explicitly authorized.",
    );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
