// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off - Boundary to the independently installed phone adapter; owned child and loopback HTTP only.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  DeviceOperationError,
  DeviceHostUnavailableError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as DeviceHost from "./DeviceHost.ts";

// Configured SSH/EAS host ids cannot contain a colon, so this cannot replace one.
export const IPHONE_X_HOST_ID = "physical:iphone-x";
const MODULE = "ios_device_lab.iphone_x.hub";
const PREFIX = "/vendor/iphone-x/api/";

interface Bridge {
  readonly origin: string;
  readonly token: string;
  readonly isRunning: () => boolean;
  readonly stop: () => Promise<void>;
}

export const startBridge = (
  python: string,
  signal: AbortSignal,
  spawn = (executable: string) =>
    NodeChildProcess.spawn(executable, ["-m", MODULE, "serve"], {
      stdio: "pipe",
      windowsHide: true,
    }),
): Promise<Bridge> =>
  new Promise((resolve, reject) => {
    const child = spawn(python);
    child.stdin.on("error", () => {});
    let output = "";
    let ready = false;
    let settled = false;
    let exited = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", fail);
      child.stdin.end();
      child.kill();
      reject(
        new Error(
          "Cannot start the iPhone X adapter. Check the configured Python and ios-device-lab installation.",
        ),
      );
    };
    const timer = setTimeout(fail, 15_000);
    signal.addEventListener("abort", fail, { once: true });
    child.once("error", fail);
    child.once("exit", () => {
      exited = true;
      if (!ready) fail();
    });
    // Drain stderr without publishing paths, SSH diagnostics or credentials.
    child.stderr.resume();
    child.stdout.on("data", (data: Buffer) => {
      if (settled) return;
      output += data.toString("utf8");
      if (output.length > 4096) return fail();
      if (!output.includes("\n")) return;
      try {
        const parsed: unknown = JSON.parse(output.slice(0, output.indexOf("\n")));
        if (
          !parsed ||
          typeof parsed !== "object" ||
          !("origin" in parsed) ||
          !("token" in parsed) ||
          typeof parsed.origin !== "string" ||
          !/^http:\/\/127\.0\.0\.1:\d+$/.test(parsed.origin) ||
          typeof parsed.token !== "string" ||
          parsed.token.length < 32
        )
          return fail();
        ready = true;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", fail);
        resolve({
          origin: parsed.origin,
          token: parsed.token,
          isRunning: () => !exited && !child.killed,
          stop: () =>
            new Promise<void>((done) => {
              if (exited) return done();
              const deadline = setTimeout(() => {
                child.kill();
              }, 35_000);
              child.once("exit", () => {
                clearTimeout(deadline);
                done();
              });
              child.stdin.end();
            }),
        });
      } catch {
        fail();
      }
    });
  });

export const make = Effect.fn("IphoneXDeviceHost.make")(function* (
  python: string,
  stateDir: string,
  launch: typeof startBridge = startBridge,
) {
  const gate = yield* Semaphore.make(1);
  let bridge: Bridge | null = null;
  const operation = <A>(name: string, run: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        new DeviceOperationError({
          operation: name,
          reason: "request_failed",
          cause,
        }),
    });
  const call = (route: string, body?: unknown) =>
    operation(route, async (signal) => {
      if (!bridge?.isRunning()) throw new Error("Phone adapter stopped");
      const response = await fetch(bridge.origin + PREFIX + route, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        redirect: "error",
      });
      if (!response.ok) throw new Error(`Phone adapter refused ${route} (${response.status})`);
      return response;
    });
  const device: DeviceHost.HostDevice = {
    id: "iphone-x",
    name: "iPhone X",
    platform: "ios",
    version: "16.4.1",
    booted: false,
    physical: true,
  };
  const json = (route: string, body?: unknown) =>
    call(route, body).pipe(
      Effect.flatMap((response) =>
        operation(route, () => response.json() as Promise<Record<string, unknown>>),
      ),
    );
  const stop = gate.withPermit(
    Effect.promise(async () => {
      const previous = bridge;
      bridge = null;
      await previous?.stop();
    }),
  );
  yield* Effect.addFinalizer(() => stop);
  const ready: DeviceHost.DeviceHostAgentReady = {
    nodePath: process.execPath,
    get hub() {
      return { origin: bridge?.origin ?? "http://127.0.0.1:1" };
    },
    agentDevice: null,
    helpers: { serveSimAxSettings: null, serveSimCli: null },
    run: () =>
      Effect.succeed({
        code: 1,
        stdout: "",
        stderr: "Simulator commands are unavailable on the physical iPhone X",
      }),
    devices: {
      list: json("state").pipe(
        Effect.map((state) => ({
          devices: [{ ...device, booted: state.connected === true }],
          detail: undefined,
        })),
      ),
      boot: (_device, context) =>
        json("attach", { thread: context?.threadId }).pipe(Effect.as(device.id)),
      attach: (_device, context) =>
        json("attach", { thread: context?.threadId }).pipe(Effect.asVoid),
      detach: (_id, threadId) => json("detach", { thread: threadId }).pipe(Effect.asVoid),
      shutdown: () => json("detach", {}).pipe(Effect.asVoid),
      screenshot: () =>
        call("frame").pipe(
          Effect.flatMap((response) =>
            operation("screenshot", async () => new Uint8Array(await response.arrayBuffer())),
          ),
        ),
      agentCommand: Effect.fn("IphoneXDeviceHost.agentCommand")(function* (threadId: ThreadId) {
        const result = yield* json("agent", { thread: threadId });
        if (typeof result.agentToken !== "string" || !bridge)
          return yield* new DeviceHostUnavailableError({
            hostId: IPHONE_X_HOST_ID,
            reason: "Open the iPhone X first.",
          });
        const file = NodePath.join(
          stateDir,
          "device",
          "iphone-x",
          `${NodeCrypto.createHash("sha256").update(threadId).digest("hex")}.json`,
        );
        yield* operation("configure phone agent", async () => {
          await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
          await NodeFSP.writeFile(
            file,
            JSON.stringify({ origin: bridge!.origin, token: result.agentToken }),
            { mode: 0o600 },
          );
        });
        return {
          command: python,
          args: ["-m", MODULE, "command", "--config", file],
          quickStart:
            "Physical iPhone X. Use the returned command and targetArgs for every action. Append: status; screenshot NEW.png; ax snapshot; ax press SNAPSHOT REF; ax set-value SNAPSHOT REF TEXT; tap X Y; swipe X1 Y1 X2 Y2; type TEXT; key Return; home; claim; release. Prefer ax snapshot and its element refs for native presses and Unicode field replacement. Each snapshot is single-use, expires after 30 seconds, and is invalidated by input or control handoff; a changed page refuses the action. Read a fresh snapshot before each element action. AX frames are iOS points; tap/swipe coordinates are original screenshot pixels and require a fresh screenshot. type supports printable ASCII only; ax set-value supports Unicode on editable fields and reports readback verification. Native press acceptance does not prove navigation; inspect afterward. Human Take control blocks agent input until released or idle for 60 seconds. No simulator settings, installation or reboot actions are available through this adapter. Use device_close when finished; the panel's Disconnect phone action also releases the connection. Merely hiding the viewer keeps the phone session attached.",
        };
      }),
    },
    upstream: (path, search) =>
      Effect.succeed(
        path.startsWith(PREFIX) && bridge
          ? {
              url: bridge.origin + path + (search.size ? `?${search}` : ""),
              headers: { authorization: `Bearer ${bridge.token}` },
              protocols: [],
            }
          : null,
      ),
  };
  const ensureReady: DeviceHost.DeviceHost["Service"]["ensureReady"] = () =>
    gate.withPermit(
      Effect.gen(function* () {
        if (bridge && !bridge.isRunning()) bridge = null;
        if (!bridge)
          bridge = yield* Effect.tryPromise({
            try: (signal) => launch(python, signal),
            catch: (cause) =>
              new DeviceHost.DeviceHostError({
                hostId: IPHONE_X_HOST_ID,
                step: "starting the iPhone X adapter",
                cause,
              }),
          });
        return ready;
      }),
    );
  return DeviceHost.DeviceHost.of({
    id: IPHONE_X_HOST_ID,
    label: "iPhone X",
    summary: Effect.succeed({
      id: IPHONE_X_HOST_ID,
      label: "iPhone X",
      kind: "local",
      hubInstalled: true,
      agentDeviceInstalled: true,
      platforms: [
        { platform: "ios", available: true },
        { platform: "android", available: false },
      ],
    }),
    platformAvailability: (platform) => Effect.succeed({ platform, available: platform === "ios" }),
    ensureReady,
    ensureAgentReady: (onPhase) => ensureReady(onPhase).pipe(Effect.as(ready)),
    current: Effect.sync(() => (bridge?.isRunning() ? ready : null)),
    stopAgent: Effect.gen(function* () {
      if (bridge) yield* json("revoke-agent", {}).pipe(Effect.ignore);
    }),
    stop,
  });
});
