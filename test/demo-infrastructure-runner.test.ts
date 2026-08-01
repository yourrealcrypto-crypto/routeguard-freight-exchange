import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ACCEPTED_BYTECODE_SHA256,
  DEMO_INFRA_CONFIRM_VALUE,
  DEMO_INFRA_MAX_WRITES,
  DEMO_INFRA_REQUIRED_BRANCH,
  FILE_APPEND_CHARS,
  FILE_CREATE_CHARS,
  projectDemoInfrastructureWrites,
} from "../scripts/run-v2-demo-infrastructure-live";

describe("Operations Demo infrastructure runner", () => {
  it("pins the one-time live guard, branch and accepted bytecode identity", () => {
    expect(DEMO_INFRA_CONFIRM_VALUE).toBe("I_UNDERSTAND_TESTNET_DEMO_INFRA_WRITES");
    expect(DEMO_INFRA_REQUIRED_BRANCH).toBe("feat/routeguard-v2-operations-demo-infra");
    expect(DEMO_INFRA_MAX_WRITES).toBe(7);
    expect(ACCEPTED_BYTECODE_SHA256).toBe("584bf3710a13fb798f73734a2afea5213afda437d672ee91078a72315c30abe5");
  });

  it("projects the accepted 7,639-byte escrow to exactly seven writes", () => {
    expect(projectDemoInfrastructureWrites(7_639)).toEqual({
      fileCreateWrites: 1,
      fileAppendWrites: 3,
      contractCreateWrites: 1,
      contractAssociationWrites: 1,
      topicCreateWrites: 1,
      totalStateChangingWrites: 7,
      bytecodeHexChars: 15_278,
    });
  });

  it("fails the exact projection if a fourth append would be required", () => {
    const bytes = Math.floor((FILE_CREATE_CHARS + FILE_APPEND_CHARS * 3) / 2) + 1;
    expect(projectDemoInfrastructureWrites(bytes)).toMatchObject({ fileAppendWrites: 4, totalStateChangingWrites: 8 });
  });

  it("contains no transaction constructor outside the seven-write infrastructure set", () => {
    const source = readFileSync("scripts/run-v2-demo-infrastructure-live.ts", "utf8");
    for (const forbidden of [
      "new AccountAllowanceApproveTransaction",
      "new AccountCreateTransaction",
      "new TokenCreateTransaction",
      "new TopicMessageSubmitTransaction",
      '.setFunction("registerTender")',
      '.setFunction("fundTender")',
      '.setFunction("allocateWinner")',
      '.setFunction("releaseFull")',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
