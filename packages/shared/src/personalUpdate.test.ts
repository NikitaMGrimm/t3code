import { describe, expect, it } from "vite-plus/test";
import {
  decodePersonalUpdateStatus,
  personalUpdateMessage,
  personalUpdateRepairKey,
  personalUpdateRepairPrompt,
} from "./personalUpdate.ts";

const status = {
  schema: 1,
  phase: "conflict",
  upstreamTag: "v0.0.46-nightly.20261007.2787",
  conflicts: ["apps/web/src/components/chat/ChatMarkdown.tsx"],
  runUrl: "https://github.com/NikitaMGrimm/t3code/actions/runs/123",
  releasedVersion: "0.0.46-nightly.20261006.123",
};

describe("personal nightly status", () => {
  it("reports conflicting files while retaining the previous release", () => {
    const decoded = decodePersonalUpdateStatus(status);
    expect(decoded.releasedVersion).toBe(status.releasedVersion);
    expect(personalUpdateMessage(decoded)).toContain(status.conflicts[0]);
    expect(personalUpdateMessage(decoded)).toContain("current build is kept");
  });
  it("rejects an untrusted details link and an invalid update target", () => {
    expect(() =>
      decodePersonalUpdateStatus({ ...status, runUrl: "https://example.com" }),
    ).toThrow();
    expect(() => decodePersonalUpdateStatus({ ...status, releasedVersion: "latest" })).toThrow();
  });
  it("links a release published without a workflow run to its fork release page", () => {
    const runUrl =
      "https://github.com/NikitaMGrimm/t3code/releases/tag/v0.0.46-nightly.20261017.1792261191643";
    expect(decodePersonalUpdateStatus({ ...status, runUrl }).runUrl).toBe(runUrl);
    for (const untrusted of [
      "https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261017.1",
      "https://github.com/NikitaMGrimm/t3code/releases/tag/latest",
      "https://github.com/NikitaMGrimm/t3code/releases/tag/v0.0.46-nightly.20261017.1/../../x",
    ]) {
      expect(() => decodePersonalUpdateStatus({ ...status, runUrl: untrusted })).toThrow();
    }
  });
  it("allows conflicts before the first successful release", () => {
    expect(
      decodePersonalUpdateStatus({ ...status, releasedVersion: null }).releasedVersion,
    ).toBeNull();
  });
  it("quietly waits for an official nightly while keeping the current release", () => {
    const waiting = {
      pullRequest: 18308,
      baseCommit: "284ce8fe2ff99076657707fd754e538403d88d76",
      paths: ["apps/web/src/components/ChatMarkdown.browser.test.tsx"],
    };
    for (const phase of ["ready", "building"]) {
      const decoded = decodePersonalUpdateStatus({ ...status, phase, conflicts: [], waiting });
      expect(decoded.waiting).toEqual(waiting);
      expect(personalUpdateMessage(decoded)).toBe(
        "Waiting for an official nightly with the upstream changes #18308 needs. Your current build is kept.",
      );
    }
    expect(decodePersonalUpdateStatus(status).waiting).toBeUndefined();
    for (const invalid of [
      { ...waiting, baseCommit: "main" },
      { ...waiting, pullRequest: 0 },
      { ...waiting, paths: [] },
    ]) {
      expect(() =>
        decodePersonalUpdateStatus({ ...status, phase: "ready", conflicts: [], waiting: invalid }),
      ).toThrow();
    }
    expect(() => decodePersonalUpdateStatus({ ...status, waiting })).toThrow();
  });
  it("carries a stable conflict identity and accepts feeds without one", () => {
    const conflictIdentity = "a".repeat(64);
    expect(decodePersonalUpdateStatus({ ...status, conflictIdentity }).conflictIdentity).toBe(
      conflictIdentity,
    );
    expect(decodePersonalUpdateStatus(status).conflictIdentity).toBeUndefined();
  });
  it("preserves the producer's attempt sequence and accepts older feeds without it", () => {
    expect(decodePersonalUpdateStatus({ ...status, sequence: 1791417149067 }).sequence).toBe(
      1791417149067,
    );
    expect(decodePersonalUpdateStatus(status).sequence).toBeUndefined();
    expect(() => decodePersonalUpdateStatus({ ...status, sequence: "1791417149067" })).toThrow();
  });
});

it("identifies PR and personal overlay conflicts without breaking older status feeds", () => {
  const pull = decodePersonalUpdateStatus({
    ...status,
    conflictStage: "pull_request",
    conflictPullRequest: 22883,
  });
  expect(personalUpdateMessage(pull)).toContain("importing PR #22883");
  const personal = decodePersonalUpdateStatus({ ...status, conflictStage: "personal" });
  expect(personalUpdateMessage(personal)).toContain("applying your personal changes");
  expect(personalUpdateMessage(decodePersonalUpdateStatus(status))).toContain("merge conflicts:");
});

it("retains the exact failure snapshot in an agent repair and uses stable conflict identity", () => {
  const recorded = {
    ...status,
    conflictIdentity: "f".repeat(64),
    baseCommit: "a".repeat(40),
    conflictPullRequest: 22883,
    inputs: {
      upstreamTag: status.upstreamTag,
      pullRequests: [{ number: 22883, headSha: "b".repeat(40), baseRef: "main" }],
      resolutions: "c".repeat(64),
    },
  };
  const decoded = decodePersonalUpdateStatus(recorded);
  const prompt = personalUpdateRepairPrompt(decoded);
  expect(prompt).toContain(recorded.baseCommit);
  expect(prompt).toContain(recorded.inputs.pullRequests[0]!.headSha);
  expect(prompt).toContain(recorded.inputs.resolutions);
  expect(prompt).toContain("diagnose the current failure");
  expect(prompt).toContain(
    "fetch refs/heads/personal-nightly directly from https://github.com/NikitaMGrimm/t3code.git",
  );
  expect(prompt).toContain("Do not assume origin");
  expect(personalUpdateRepairKey(decoded)).toBe(recorded.conflictIdentity);
  expect(() => decodePersonalUpdateStatus({ ...recorded, baseCommit: "main" })).toThrow();
});
