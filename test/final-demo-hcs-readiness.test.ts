import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FINAL_DEMO_CARRIER_BETA_ACCOUNT,
  FINAL_DEMO_MODE_DRY,
  FINAL_DEMO_MODE_LIVE,
  FINAL_DEMO_PAYER_ACCOUNT,
  FINAL_DEMO_WINNER_ACCOUNT,
  type FinalDemoMessageLabel,
} from "../src/final-demo/constants";
import { createFinalDemoDryRunTransports } from "../src/final-demo/dry-transports";
import {
  checkFinalDemoHcsIdentityReadiness,
  type FinalDemoHcsIdentity,
} from "../src/final-demo/hcs-identity-readiness";
import {
  requiredSubmitterForLabel,
  selectAuthorizedHcsSubmitter,
} from "../src/final-demo/hcs-submit-authority";
import {
  resolveRouteReservedFromMirror,
  type FinalDemoHcsResolverBinding,
} from "../src/final-demo/hcs-resolver";
import { runFinalDemoOrchestration } from "../src/final-demo/orchestration";
import { buildFinalDemoTopicCreateTransaction } from "../src/final-demo/topic-configuration";
import { offlineUsdcReadinessPass } from "../src/final-demo/usdc-readiness";
import { envelopeHash } from "../src/hcs/message-envelope";
import type { HcsEnvelope, ObservedHcsMessage } from "../src/hcs/types";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "final-demo-hcs-"));
  dirs.push(dir);
  return dir;
}

const TOPIC = "0.0.9700000";
const AUCTION_RUN = "final-test0001";
const RESERVATION_RUN = "reservation-reservation-final-test0001";
const TENDER = "tender-final-test0001";

function testEnvelope(
  sequence: number,
  overrides: Partial<HcsEnvelope> = {},
): HcsEnvelope {
  const messageTypes = [
    "AUCTION_OPEN",
    "BID_COMMITMENT",
    "BID_COMMITMENT",
    "AUCTION_CLOSE_BARRIER",
    "ROUTE_RESERVED",
  ] as const;
  return {
    schemaVersion: "routeguard-hcs-1.0",
    messageType: messageTypes[sequence - 1]!,
    runId: sequence === 5 ? RESERVATION_RUN : AUCTION_RUN,
    tenderId: TENDER,
    tenderVersion: 1,
    tenderHash: "sha256:" + "11".repeat(32),
    createdAt: `2026-08-01T12:00:0${sequence}.000Z`,
    payloadHash: "sha256:" + String(sequence).repeat(64).slice(0, 64),
    payload: { sequence },
    ...overrides,
  } as HcsEnvelope;
}

function observedWindow(): ObservedHcsMessage[] {
  return [1, 2, 3, 4, 5].map((sequence) => {
    const envelope = testEnvelope(sequence);
    return {
      topicId: TOPIC,
      sequence,
      consensusTimestamp: `2026-08-01T12:00:0${sequence}.000000000Z`,
      mirrorConsensusTimestamp: `178558560${sequence}.000000000`,
      envelope,
      envelopeHash: envelopeHash(envelope),
    };
  });
}

const binding: FinalDemoHcsResolverBinding = {
  topicId: TOPIC,
  auctionRunId: AUCTION_RUN,
  routeReservedRunId: RESERVATION_RUN,
  tenderId: TENDER,
  expectedSequence: 5,
};

function resolve(messages: ObservedHcsMessage[], expectedHash?: string) {
  return resolveRouteReservedFromMirror(messages, {
    topicId: TOPIC,
    envelopeHash: expectedHash ?? observedWindow()[4]!.envelopeHash,
    binding,
  });
}

describe("F-004 final-demo HCS resolver", () => {
  it("finds the exact pristine sequence-5 publication without inventing a transaction id", () => {
    const messages = observedWindow();
    expect(resolve(messages, messages[4]!.envelopeHash)).toEqual({
      status: "FOUND",
      topicId: TOPIC,
      sequence: 5,
      transactionId: null,
      consensusTimestamp: messages[4]!.consensusTimestamp,
      envelopeHash: messages[4]!.envelopeHash,
    });
  });

  it("does not call a currently missing Mirror publication conclusively absent", () => {
    expect(resolve(observedWindow().slice(0, 4))).toEqual({
      status: "AMBIGUOUS",
    });
  });

  it("fails closed on duplicate matching envelopes and contamination", () => {
    const duplicate = observedWindow();
    duplicate.push({ ...duplicate[4]! });
    expect(resolve(duplicate)).toEqual({ status: "AMBIGUOUS" });

    const contaminated = observedWindow();
    contaminated.push({ ...contaminated[4]!, sequence: 6 });
    expect(resolve(contaminated)).toEqual({ status: "AMBIGUOUS" });
  });

  const mismatchCases: Array<
    [string, (message: ObservedHcsMessage) => ObservedHcsMessage]
  > = [
    ["wrong topic", (m: ObservedHcsMessage) => ({ ...m, topicId: "0.0.999" })],
    [
      "wrong run",
      (m: ObservedHcsMessage) => {
        const envelope = { ...m.envelope, runId: "wrong-run" } as HcsEnvelope;
        return { ...m, envelope, envelopeHash: envelopeHash(envelope) };
      },
    ],
    [
      "wrong tender",
      (m: ObservedHcsMessage) => {
        const envelope = { ...m.envelope, tenderId: "wrong-tender" } as HcsEnvelope;
        return { ...m, envelope, envelopeHash: envelopeHash(envelope) };
      },
    ],
    [
      "wrong type",
      (m: ObservedHcsMessage) => {
        const envelope = {
          ...m.envelope,
          messageType: "BID_COMMITMENT",
        } as HcsEnvelope;
        return { ...m, envelope, envelopeHash: envelopeHash(envelope) };
      },
    ],
    ["wrong sequence", (m: ObservedHcsMessage) => ({ ...m, sequence: 4 })],
    [
      "invalid consensus timestamp",
      (m: ObservedHcsMessage) => ({ ...m, consensusTimestamp: "not-a-timestamp" }),
    ],
  ];

  it.each(mismatchCases)("classifies %s as ambiguous", (_name, mutate) => {
    const messages = observedWindow();
    messages[4] = mutate(messages[4]!);
    expect(resolve(messages, messages[4]!.envelopeHash)).toEqual({
      status: "AMBIGUOUS",
    });
  });

  it("classifies an expected envelope-hash mismatch as ambiguous", () => {
    expect(resolve(observedWindow(), "sha256:" + "ff".repeat(32))).toEqual({
      status: "AMBIGUOUS",
    });
  });

  it("recovers a response-lost sequence 5 on restart with one submit and five confirmed messages", async () => {
    const workDir = tempDir();
    const transports = createFinalDemoDryRunTransports({
      clockMs: Date.parse("2026-08-01T12:00:00.000Z"),
    });
    transports.network.setForceSubmitResponseLoss("ROUTE_RESERVED");

    const originalList = transports.topicMirrorReader.listMessages;
    let failFirstResolverRead = true;
    transports.topicMirrorReader.listMessages = async (topicId) => {
      const messages = await originalList(topicId);
      if (
        failFirstResolverRead &&
        transports.network.getSubmitCountForLabel("ROUTE_RESERVED") === 1 &&
        messages.length === 5
      ) {
        failFirstResolverRead = false;
        throw new Error("mock Mirror temporarily unavailable after response loss");
      }
      return messages;
    };

    const deps = {
      mode: FINAL_DEMO_MODE_DRY,
      clock: transports.clock,
      workDir,
      runBaseTime: "2026-08-01T12:00:00.000Z",
      auctionWindowSeconds: 90,
      prepBufferSeconds: 0,
      topicTransport: transports.topicTransport,
      hcsTransport: transports.hcsTransport,
      topicMirrorReader: transports.topicMirrorReader,
      paymentPayloadFactory: transports.paymentPayloadFactory,
      facilitatorTransport: transports.facilitatorTransport,
      paymentMirrorTransport: transports.paymentMirrorTransport,
      webhookTransport: transports.webhookTransport,
      readiness: {
        secretScan: () => undefined,
        usdcReadiness: async () => offlineUsdcReadinessPass(),
      },
    } as const;

    await expect(runFinalDemoOrchestration(deps)).rejects.toThrow(
      /temporarily unavailable/,
    );
    expect(transports.network.getSubmitCountForLabel("ROUTE_RESERVED")).toBe(1);

    transports.network.setForceSubmitResponseLoss(null);
    const recovered = await runFinalDemoOrchestration(deps);
    expect(transports.network.getSubmitCountForLabel("ROUTE_RESERVED")).toBe(1);
    expect(recovered.networkWrites.hcsSubmits).toBe(5);
    expect(recovered.sequences).toHaveLength(5);
    expect(recovered.attempt.messageOutbox.every((message) => message.status === "CONFIRMED")).toBe(true);
    expect(recovered.routeReserved.transactionId).toBeNull();
    expect(
      transports.network
        .getTopic(recovered.topic.topicId)
        ?.submissions.map((submission) => submission.submitter),
    ).toEqual([
      "ROUTEGUARD_OPERATOR",
      "CARRIER_ALPHA",
      "CARRIER_BETA",
      "ROUTEGUARD_OPERATOR",
      "ROUTEGUARD_OPERATOR",
    ]);
  });
});

const identities: FinalDemoHcsIdentity[] = [
  {
    role: "ROUTEGUARD_OPERATOR",
    accountId: FINAL_DEMO_PAYER_ACCOUNT,
    publicKeyHex: "02" + "11".repeat(32),
  },
  {
    role: "CARRIER_ALPHA",
    accountId: FINAL_DEMO_WINNER_ACCOUNT,
    publicKeyHex: "02" + "22".repeat(32),
  },
  {
    role: "CARRIER_BETA",
    accountId: FINAL_DEMO_CARRIER_BETA_ACCOUNT,
    publicKeyHex: "03" + "33".repeat(32),
  },
];

function mirrorFetch(options?: {
  wrongKeyAccount?: string;
  lowBalanceAccount?: string;
}) {
  return async (input: string | URL | Request) => {
    const url = String(input);
    const accountId = decodeURIComponent(url.split("/").pop()!);
    const identity = identities.find((candidate) => candidate.accountId === accountId)!;
    return new Response(
      JSON.stringify({
        account: accountId,
        deleted: false,
        key: {
          _type: "ECDSA_SECP256K1",
          key:
            options?.wrongKeyAccount === accountId
              ? "02" + "ff".repeat(32)
              : identity.publicKeyHex,
        },
        balance: {
          balance:
            options?.lowBalanceAccount === accountId ? 1 : 500_000_000,
        },
      }),
      { status: 200 },
    );
  };
}

describe("F-005 final-demo HCS authority and readiness", () => {
  it("builds an immutable topic transaction with no submit key and no admin key", () => {
    const transaction = buildFinalDemoTopicCreateTransaction("routeguard-final:test");
    expect(transaction.submitKey).toBeNull();
    expect(transaction.adminKey).toBeNull();
    expect(transaction.autoRenewAccountId).toBeNull();
  });

  it("selects alpha and beta configured account/client contexts directly", () => {
    const alphaClient = { name: "alpha-client" };
    const betaClient = { name: "beta-client" };
    const contexts = {
      ROUTEGUARD_OPERATOR: {
        accountId: FINAL_DEMO_PAYER_ACCOUNT,
        client: { name: "operator-client" },
      },
      CARRIER_ALPHA: {
        accountId: FINAL_DEMO_WINNER_ACCOUNT,
        client: alphaClient,
      },
      CARRIER_BETA: {
        accountId: FINAL_DEMO_CARRIER_BETA_ACCOUNT,
        client: betaClient,
      },
    };
    expect(
      selectAuthorizedHcsSubmitter(contexts, {
        label: "BID_COMMITMENT_ALPHA",
        submitter: "CARRIER_ALPHA",
      }),
    ).toEqual({ accountId: FINAL_DEMO_WINNER_ACCOUNT, client: alphaClient });
    expect(
      selectAuthorizedHcsSubmitter(contexts, {
        label: "BID_COMMITMENT_BETA",
        submitter: "CARRIER_BETA",
      }),
    ).toEqual({ accountId: FINAL_DEMO_CARRIER_BETA_ACCOUNT, client: betaClient });
    expect(() =>
      selectAuthorizedHcsSubmitter(contexts, {
        label: "BID_COMMITMENT_ALPHA",
        submitter: "ROUTEGUARD_OPERATOR",
      }),
    ).toThrow(/must be submitted by CARRIER_ALPHA/);
  });

  it("preserves exactly five roles with only carrier commitments delegated", () => {
    const labels: FinalDemoMessageLabel[] = [
      "AUCTION_OPEN",
      "BID_COMMITMENT_ALPHA",
      "BID_COMMITMENT_BETA",
      "AUCTION_CLOSE_BARRIER",
      "ROUTE_RESERVED",
    ];
    expect(labels.map(requiredSubmitterForLabel)).toEqual([
      "ROUTEGUARD_OPERATOR",
      "CARRIER_ALPHA",
      "CARRIER_BETA",
      "ROUTEGUARD_OPERATOR",
      "ROUTEGUARD_OPERATOR",
    ]);
  });

  it("passes exact account/public-key bindings and HBAR funding", async () => {
    const result = await checkFinalDemoHcsIdentityReadiness({
      identities,
      fetchImpl: mirrorFetch() as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(result.checkedAccounts).toHaveLength(3);
  });

  it("fails wrong account/public-key binding and insufficient carrier funding", async () => {
    const wrongKey = await checkFinalDemoHcsIdentityReadiness({
      identities,
      fetchImpl: mirrorFetch({
        wrongKeyAccount: FINAL_DEMO_WINNER_ACCOUNT,
      }) as typeof fetch,
    });
    expect(wrongKey.ok).toBe(false);
    expect(wrongKey.reasons.join(" ")).toMatch(/CARRIER_ALPHA.*public-key binding/i);

    const lowFunding = await checkFinalDemoHcsIdentityReadiness({
      identities,
      fetchImpl: mirrorFetch({
        lowBalanceAccount: FINAL_DEMO_CARRIER_BETA_ACCOUNT,
      }) as typeof fetch,
    });
    expect(lowFunding.ok).toBe(false);
    expect(lowFunding.reasons.join(" ")).toMatch(/CARRIER_BETA.*below required/i);
  });

  it("rejects duplicate identities before any account lookup", async () => {
    let fetchCalls = 0;
    const result = await checkFinalDemoHcsIdentityReadiness({
      identities: [identities[0]!, identities[1]!, { ...identities[2]!, accountId: identities[1]!.accountId }],
      fetchImpl: (async () => {
        fetchCalls += 1;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/distinct/);
    expect(fetchCalls).toBe(0);
  });

  it("aborts a live-shaped orchestration before topic creation on failed identity preflight", async () => {
    const transports = createFinalDemoDryRunTransports({
      clockMs: Date.parse("2026-08-01T12:00:00.000Z"),
    });
    await expect(
      runFinalDemoOrchestration({
        mode: FINAL_DEMO_MODE_LIVE,
        env: {
          ENABLE_FINAL_DEMO_LIVE: "true",
          ENABLE_LIVE_HEDERA: "true",
          ENABLE_LIVE_USDC_PAYMENTS: "true",
          ENABLE_LIVE_HCS_WRITES: "true",
          ENABLE_LIVE_TOPIC_CREATE: "true",
          ENABLE_PHASE6B_LIVE_EXECUTE: "true",
          CONFIRM_FINAL_DEMO:
            "CREATE_NEW_TOPIC_AND_EXECUTE_ONE_USDC_RESERVATION",
        },
        clock: transports.clock,
        workDir: tempDir(),
        topicTransport: transports.topicTransport,
        hcsTransport: transports.hcsTransport,
        topicMirrorReader: transports.topicMirrorReader,
        paymentPayloadFactory: transports.paymentPayloadFactory,
        facilitatorTransport: transports.facilitatorTransport,
        paymentMirrorTransport: transports.paymentMirrorTransport,
        webhookTransport: transports.webhookTransport,
        readiness: {
          secretScan: () => undefined,
          accountCheck: async () => ({
            ok: false,
            reasons: ["carrier funding insufficient"],
          }),
          usdcReadiness: async () => offlineUsdcReadinessPass(),
        },
      }),
    ).rejects.toThrow(/Account check failed/);
    expect(transports.network.createCount).toBe(0);
  });
});
