import { describe, expect, it } from "vite-plus/test";
import { decodePersonalUpdateStatus, personalUpdateMessage } from "./personalUpdate.ts";

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
  it("allows conflicts before the first successful release", () => {
    expect(
      decodePersonalUpdateStatus({ ...status, releasedVersion: null }).releasedVersion,
    ).toBeNull();
  });
  it("preserves the producer's attempt sequence and accepts older feeds without it", () => {
    expect(decodePersonalUpdateStatus({ ...status, sequence: 1791417149067 }).sequence).toBe(
      1791417149067,
    );
    expect(decodePersonalUpdateStatus(status).sequence).toBeUndefined();
    expect(() => decodePersonalUpdateStatus({ ...status, sequence: "1791417149067" })).toThrow();
  });
});
