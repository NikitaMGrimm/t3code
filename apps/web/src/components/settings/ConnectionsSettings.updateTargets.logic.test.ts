// @vitest-environment jsdom

import {
  EnvironmentId,
  type ServerConfig,
  type ServerSelfUpdateCapability,
} from "@t3tools/contracts";
import type { PersonalUpdateStatus } from "@t3tools/shared/personalUpdate";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/branding", () => ({ APP_VERSION: "0.0.46-nightly.20261007.100" }));

import { resolveConnectionServerVersionMismatch } from "./ConnectionsSettings";

const clientVersion = "0.0.46-nightly.20261007.100";
const releaseVersion = "0.0.46-nightly.20261008.200";
const status: PersonalUpdateStatus = {
  schema: 1,
  phase: "ready",
  upstreamTag: "v0.0.46-nightly.20261008.2801",
  conflicts: [],
  runUrl: "https://github.com/NikitaMGrimm/t3code/actions/runs/123",
  releasedVersion: releaseVersion,
};

function config(
  serverVersion: string,
  serverSelfUpdate: ServerSelfUpdateCapability | undefined = "respawn",
): Pick<ServerConfig, "environment"> {
  return {
    environment: {
      environmentId: EnvironmentId.make("remote"),
      label: "Remote",
      platform: { os: "linux", arch: "x64" },
      serverVersion,
      capabilities: { repositoryIdentity: true, serverSelfUpdate },
    },
  };
}

describe("connection update targets shared by row, bulk, and primary actions", () => {
  it.each([clientVersion, "0.0.46-nightly.20261006.50"])(
    "targets the newer personal release when the server runs %s",
    (serverVersion) => {
      expect(resolveConnectionServerVersionMismatch(config(serverVersion), status)).toMatchObject({
        serverVersion,
        clientVersion: releaseVersion,
      });
    },
  );

  it("recalculates the target when the personal feed changes without a server version change", () => {
    const server = config(clientVersion);
    expect(resolveConnectionServerVersionMismatch(server, null)).toBeNull();
    expect(resolveConnectionServerVersionMismatch(server, status)?.clientVersion).toBe(
      releaseVersion,
    );
    expect(
      resolveConnectionServerVersionMismatch(server, { ...status, releasedVersion: clientVersion }),
    ).toBeNull();
  });

  it("preserves desktop-managed targets from the installed client", () => {
    expect(
      resolveConnectionServerVersionMismatch(config(clientVersion, "desktop-managed"), status),
    ).toBeNull();
    expect(
      resolveConnectionServerVersionMismatch(
        config("0.0.46-nightly.20261006.50", "desktop-managed"),
        status,
      )?.clientVersion,
    ).toBe(clientVersion);
  });

  it("discovers personal releases for standalone WSL and Linux background services", () => {
    expect(
      resolveConnectionServerVersionMismatch(config(clientVersion, "boot-service"), status)
        ?.clientVersion,
    ).toBe(releaseVersion);
    expect(
      resolveConnectionServerVersionMismatch(config(releaseVersion, "boot-service"), status),
    ).toBeNull();
  });

  it("keeps the client-version fallback and excludes missing or already updated servers", () => {
    expect(
      resolveConnectionServerVersionMismatch(config("0.0.46-nightly.20261006.50"), null)
        ?.clientVersion,
    ).toBe(clientVersion);
    expect(resolveConnectionServerVersionMismatch(config(releaseVersion), status)).toBeNull();
    expect(resolveConnectionServerVersionMismatch(null, status)).toBeNull();
  });
});
