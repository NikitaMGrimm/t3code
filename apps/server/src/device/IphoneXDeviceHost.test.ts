// @effect-diagnostics nodeBuiltinImport:off - Real loopback fixture verifies the subprocess boundary without a phone.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { ThreadId } from "@t3tools/contracts";
import * as IphoneX from "./IphoneXDeviceHost.ts";

const fixture = async () => {
  const calls: Array<{ path: string; body: unknown; authorization: string | undefined }> = [];
  let connected = false;
  const server = NodeHttp.createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body: unknown = text ? JSON.parse(text) : undefined;
    calls.push({ path: request.url!, body, authorization: request.headers.authorization });
    if (request.url!.endsWith("attach")) connected = true;
    if (request.url!.endsWith("detach")) connected = false;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.url!.endsWith("agent") ? { agentToken: "agent-secret" } : { connected },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const origin = `http://127.0.0.1:${address.port}`;
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-iphone-x-test-"));
  return {
    calls,
    origin,
    directory,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      const configDirectory = NodePath.join(directory, "device", "iphone-x");
      for (const file of await NodeFSP.readdir(configDirectory))
        await NodeFSP.unlink(NodePath.join(configDirectory, file));
      for (const path of [configDirectory, NodePath.join(directory, "device"), directory])
        await NodeFSP.rmdir(path);
    },
  };
};

describe("iPhone X device host", () => {
  it.live("recognizes a signal-terminated adapter and can stop it after exit", () =>
    Effect.promise(async () => {
      const child = NodeChildProcess.spawn(
        process.execPath,
        [
          "-e",
          `console.log(JSON.stringify({origin:'http://127.0.0.1:12345',token:'${"x".repeat(32)}'}));process.stdin.resume();`,
        ],
        { stdio: "pipe", windowsHide: true },
      );
      try {
        const bridge = await IphoneX.startBridge(
          "fixture",
          new AbortController().signal,
          () => child,
        );
        expect(bridge.isRunning()).toBe(true);
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill();
        await exited;
        expect(bridge.isRunning()).toBe(false);
        await bridge.stop();
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
    }),
  );

  it.live("uses the phone adapter without simulator tools and closes only its own connection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* Effect.acquireRelease(Effect.promise(fixture), (f) =>
          Effect.promise(f.close),
        );
        let stopped = 0;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const host = yield* IphoneX.make("python-test", f.directory, async () => ({
              origin: f.origin,
              token: "host-secret",
              isRunning: () => stopped === 0,
              stop: async () => {
                stopped++;
              },
            }));
            const ready = yield* host.ensureReady(() => Effect.void);
            expect((yield* ready.devices.list).devices[0]).toMatchObject({
              physical: true,
              booted: false,
            });
            const threadId = ThreadId.make("phone-thread");
            const phone = (yield* ready.devices.list).devices[0]!;
            yield* ready.devices.boot(phone, { threadId });
            expect(f.calls.find((call) => call.path.endsWith("attach"))?.body).toEqual({
              thread: threadId,
            });
            const agent = yield* ready.devices.agentCommand!(threadId);
            expect(agent.command).toBe("python-test");
            const saved = JSON.parse(
              yield* Effect.promise(() => NodeFSP.readFile(agent.args.at(-1)!, "utf8")),
            );
            expect(saved).toEqual({ origin: f.origin, token: "agent-secret" });
            expect(agent.quickStart).not.toContain("agent-secret");
            expect(
              yield* ready.upstream!("/vendor/iphone-x/api/frame", new URLSearchParams()),
            ).toMatchObject({
              url: f.origin + "/vendor/iphone-x/api/frame",
              headers: { authorization: "Bearer host-secret" },
            });
            expect(
              yield* ready.upstream!("/vendor/serve-sim/api", new URLSearchParams()),
            ).toBeNull();
            yield* host.stopAgent;
            expect(f.calls.at(-1)?.path).toContain("revoke-agent");
            yield* ready.devices.detach!(phone.id, threadId);
            expect((yield* ready.devices.list).devices[0]?.booted).toBe(false);
            expect(f.calls.every((call) => call.authorization === "Bearer host-secret")).toBe(true);
          }),
        );
        expect(stopped).toBe(1);
      }),
    ),
  );
});
