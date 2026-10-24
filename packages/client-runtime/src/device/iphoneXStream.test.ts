import { afterEach, expect, it, vi } from "vite-plus/test";
import { createIphoneXStream } from "./iphoneXStream.ts";

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const writes: Array<{
    route: string;
    body: { controller: string; request?: unknown; action?: string };
  }> = [];
  let owner: string | null = null;
  let expired = false;
  let inputGate: Promise<void> = Promise.resolve();
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      decode = async () => {};
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (expired) return new Response("Expired", { status: 401 });
      const route = new URL(url).pathname.split("/").at(-1)!;
      if (init?.body) {
        const body = JSON.parse(String(init.body));
        writes.push({ route, body });
        if (route === "control") {
          if (body.action === "take" && owner && owner !== body.controller)
            return new Response("Owned elsewhere", { status: 409 });
          owner = body.action === "take" ? body.controller : null;
        }
        if (route === "input") await inputGate;
        return Response.json({ ok: true });
      }
      return route === "state"
        ? Response.json({
            connected: true,
            width: 10,
            height: 20,
            owner: owner ? "human" : null,
            controlsInput: owner === new URL(url).searchParams.get("controller"),
          })
        : new Response(new Blob(["frame"], { type: "image/png" }));
    }),
  );
  const present = vi.fn(() => true);
  const events = {
    onStatus: vi.fn(),
    onScreen: vi.fn(),
    onUnauthorized: vi.fn(),
    onMjpegFallback: vi.fn(),
    onInputConnected: vi.fn(),
  };
  const create = () =>
    createIphoneXStream(
      {
        platform: "ios",
        deviceId: "iphone-x",
        inputControllerId: "persistent-viewer",
        access: {
          httpBase: "https://device.test/api/device-hub",
          wsBase: "wss://device.test",
          query: { hostId: "physical:iphone-x" },
          credentials: true,
        },
      },
      { present },
      events,
    );
  return {
    client: create(),
    create,
    writes,
    present,
    events,
    expire: (value: boolean) => {
      expired = value;
    },
    blockInput: (gate: Promise<void>) => {
      inputGate = gate;
    },
  };
}

it("preserves viewer ownership when an expired access ticket restarts the client", async () => {
  const f = fixture();
  let replacement: ReturnType<typeof createIphoneXStream> | undefined;
  try {
    f.client.start();
    await vi.waitFor(() => expect(f.present).toHaveBeenCalled());
    f.client.takeControl?.();
    await vi.waitFor(() =>
      expect(f.events.onInputConnected).toHaveBeenLastCalledWith(true, undefined),
    );
    f.expire(true);
    f.client.pressButton("home");
    await vi.waitFor(() => expect(f.events.onUnauthorized).toHaveBeenCalled());
    f.client.stop();
    f.expire(false);
    f.events.onInputConnected.mockClear();
    replacement = f.create();
    replacement.start();
    await vi.waitFor(() =>
      expect(f.events.onInputConnected.mock.calls.some(([owned]) => owned)).toBe(true),
    );
  } finally {
    f.client.stop();
    replacement?.stop();
  }
});

it("disables input immediately and releases even with a full queue behind an operation", async () => {
  const f = fixture();
  let finishInput = () => {};
  const gate = new Promise<void>((resolve) => {
    finishInput = resolve;
  });
  try {
    f.client.start();
    await vi.waitFor(() => expect(f.present).toHaveBeenCalled());
    f.client.takeControl?.();
    await vi.waitFor(() =>
      expect(f.events.onInputConnected).toHaveBeenLastCalledWith(true, undefined),
    );
    f.blockInput(gate);
    f.client.pressButton("home");
    await vi.waitFor(() => expect(f.writes.at(-1)?.route).toBe("input"));
    for (let index = 0; index < 32; index++) f.client.pressButton("home");
    f.client.releaseControl?.();
    expect(f.events.onInputConnected).toHaveBeenLastCalledWith(false, undefined);
    f.client.pressButton("home");
    finishInput();
    await vi.waitFor(() => expect(f.writes.at(-1)?.body.action).toBe("release"));
    expect(f.writes.map(({ route, body }) => body.action ?? route)).toEqual([
      "take",
      "input",
      "release",
    ]);
  } finally {
    finishInput();
    f.client.stop();
  }
});

it("shows frames while read-only and sends pixel-bound input only after explicit control", async () => {
  const { client, writes, present, events } = fixture();
  try {
    client.start();
    await vi.waitFor(() => expect(present).toHaveBeenCalled());
    client.pressButton("home");
    expect(writes).toEqual([]);
    client.takeControl?.();
    await vi.waitFor(() =>
      expect(events.onInputConnected).toHaveBeenLastCalledWith(true, undefined),
    );
    client.sendTouch("begin", 1, 1);
    client.sendTouch("end", 1, 1);
    await vi.waitFor(() =>
      expect(writes.at(-1)?.body.request).toMatchObject({ op: "tap", x: 9, y: 19 }),
    );
    client.releaseControl?.();
    await vi.waitFor(() =>
      expect(events.onInputConnected).toHaveBeenLastCalledWith(false, undefined),
    );
    const before = writes.length;
    client.pressButton("home");
    expect(writes).toHaveLength(before);
  } finally {
    client.stop();
  }
});

it("discards queued input and late frames when stopped", async () => {
  const { client, writes, present } = fixture();
  client.start();
  client.stop();
  client.takeControl?.();
  await Promise.resolve();
  expect(writes).toEqual([]);
  expect(present).not.toHaveBeenCalled();
});
