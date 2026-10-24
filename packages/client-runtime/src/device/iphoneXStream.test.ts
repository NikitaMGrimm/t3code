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
  let imageType = "image/png";
  let stateGate: Promise<void> = Promise.resolve();
  let takeGate: Promise<void> = Promise.resolve();
  let releaseGate: Promise<void> = Promise.resolve();
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
          if (body.action === "take") await takeGate;
          else await releaseGate;
          if (body.action === "take" && owner && owner !== body.controller)
            return new Response("Owned elsewhere", { status: 409 });
          owner = body.action === "take" ? body.controller : null;
        }
        if (route === "input") await inputGate;
        return Response.json({ ok: true });
      }
      // Body promises keep scheduling tests independent of Node's real stream clock.
      const state = {
        connected: true,
        width: 10,
        height: 20,
        owner: owner ? "human" : null,
        controlsInput: owner === new URL(url).searchParams.get("controller"),
      };
      if (route === "state") await stateGate;
      return route === "state"
        ? ({
            ok: true,
            status: 200,
            json: async () => ({
              ...state,
            }),
          } as Response)
        : ({
            ok: true,
            status: 200,
            blob: async () => new Blob(["frame"], { type: imageType }),
          } as Response);
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
    setImageType: (value: string) => {
      imageType = value;
    },
    blockState: (gate: Promise<void>) => {
      stateGate = gate;
    },
    blockTake: (gate: Promise<void>) => {
      takeGate = gate;
    },
    blockRelease: (gate: Promise<void>) => {
      releaseGate = gate;
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
      expect(writes.at(-1)?.body.request).toMatchObject({
        op: "pointer",
        phase: "end",
        x: 9,
        y: 19,
      }),
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

it("delivers touch-down immediately and retains only the latest waiting move before touch-up", async () => {
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
    f.client.sendTouch("begin", 0, 0);
    await vi.waitFor(() =>
      expect(f.writes.at(-1)?.body.request).toMatchObject({ op: "pointer", phase: "begin" }),
    );
    for (let step = 1; step <= 100; step++) f.client.sendTouch("move", step / 100, step / 100);
    f.client.sendTouch("end", 1, 1);
    finishInput();
    await vi.waitFor(() => expect(f.writes.at(-1)?.body.request).toMatchObject({ phase: "end" }));
    expect(
      f.writes.filter(({ route }) => route === "input").map(({ body }) => body.request),
    ).toEqual([
      { op: "pointer", phase: "begin", x: 0, y: 0 },
      { op: "pointer", phase: "move", x: 9, y: 19 },
      { op: "pointer", phase: "end", x: 9, y: 19 },
    ]);
  } finally {
    finishInput();
    f.client.stop();
  }
});

it("keeps consecutive queued gestures separate", async () => {
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
    f.client.sendTouch("begin", 0, 0);
    await vi.waitFor(() => expect(f.writes.at(-1)?.body.request).toMatchObject({ phase: "begin" }));
    f.client.sendTouch("move", 0.2, 0.2);
    f.client.sendTouch("end", 0.2, 0.2);
    f.client.sendTouch("begin", 0.8, 0.8);
    f.client.sendTouch("move", 1, 1);
    f.client.sendTouch("end", 1, 1);
    finishInput();
    await vi.waitFor(() =>
      expect(f.writes.filter(({ route }) => route === "input")).toHaveLength(6),
    );
    expect(
      f.writes.filter(({ route }) => route === "input").map(({ body }) => body.request),
    ).toEqual([
      { op: "pointer", phase: "begin", x: 0, y: 0 },
      { op: "pointer", phase: "move", x: 2, y: 4 },
      { op: "pointer", phase: "end", x: 2, y: 4 },
      { op: "pointer", phase: "begin", x: 7, y: 15 },
      { op: "pointer", phase: "move", x: 9, y: 19 },
      { op: "pointer", phase: "end", x: 9, y: 19 },
    ]);
  } finally {
    finishInput();
    f.client.stop();
  }
});

it("requests compact previews while preserving native coordinates", async () => {
  const f = fixture();
  f.setImageType("image/jpeg");
  try {
    f.client.start();
    await vi.waitFor(() => expect(f.present).toHaveBeenCalled());
    expect(f.present).toHaveBeenLastCalledWith(expect.any(Object), 10, 20);
    const urls = vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)));
    expect(urls.find((url) => url.pathname.endsWith("/frame"))?.searchParams.get("preview")).toBe(
      "1",
    );
  } finally {
    f.client.stop();
  }
});

it("refreshes frames without a fixed half-second pause and polls ownership separately", async () => {
  vi.useFakeTimers();
  const f = fixture();
  try {
    f.client.start();
    await vi.advanceTimersByTimeAsync(250);
    expect(f.present.mock.calls.length).toBeGreaterThanOrEqual(5);
    const stateCalls = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith("/state"));
    expect(stateCalls).toHaveLength(1);
  } finally {
    f.client.stop();
    vi.useRealTimers();
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

it("keeps a newer release when an older input fails", async () => {
  const f = fixture();
  let rejectInput = (_error: Error) => {};
  const gate = new Promise<void>((_resolve, reject) => {
    rejectInput = reject;
  });
  try {
    f.client.start();
    await vi.waitFor(() => expect(f.present).toHaveBeenCalled());
    f.client.takeControl?.();
    await vi.waitFor(() =>
      expect(f.events.onInputConnected).toHaveBeenLastCalledWith(true, undefined),
    );
    f.blockInput(gate);
    f.client.sendTouch("begin", 0, 0);
    await vi.waitFor(() => expect(f.writes.at(-1)?.body.request).toMatchObject({ phase: "begin" }));
    f.client.releaseControl?.();
    rejectInput(new Error("Older request failed"));
    await vi.waitFor(() => expect(f.writes.at(-1)?.body.action).toBe("release"));
    expect(f.events.onInputConnected).toHaveBeenLastCalledWith(false, undefined);
  } finally {
    f.client.stop();
  }
});

it("cancels a held touch once and drops the later pointer-up", async () => {
  const f = fixture();
  try {
    f.client.start();
    await vi.waitFor(() => expect(f.present).toHaveBeenCalled());
    f.client.takeControl?.();
    await vi.waitFor(() =>
      expect(f.events.onInputConnected).toHaveBeenLastCalledWith(true, undefined),
    );
    f.client.sendTouch("begin", 0.5, 0.5);
    f.client.cancelTouch?.();
    f.client.cancelTouch?.();
    f.client.sendTouch("end", 0, 0);
    await vi.waitFor(() =>
      expect(f.writes.at(-1)?.body.request).toMatchObject({ phase: "cancel" }),
    );
    expect(
      f.writes.filter(({ route }) => route === "input").map(({ body }) => body.request),
    ).toEqual([
      { op: "pointer", phase: "begin", x: 5, y: 10 },
      { op: "pointer", phase: "cancel", x: 5, y: 10 },
    ]);
  } finally {
    f.client.stop();
  }
});

it("orders a failure cleanup before a later retake and touch", async () => {
  const f = fixture();
  let rejectInput = (_error: Error) => {};
  let finishRelease = () => {};
  const input = new Promise<void>((_resolve, reject) => {
    rejectInput = reject;
  });
  const release = new Promise<void>((resolve) => {
    finishRelease = resolve;
  });
  try {
    f.client.start();
    await vi.waitFor(() => expect(f.present).toHaveBeenCalled());
    f.client.takeControl?.();
    await vi.waitFor(() =>
      expect(f.events.onInputConnected).toHaveBeenLastCalledWith(true, undefined),
    );
    f.blockInput(input);
    f.blockRelease(release);
    f.client.sendTouch("begin", 0, 0);
    await vi.waitFor(() => expect(f.writes.at(-1)?.body.request).toMatchObject({ phase: "begin" }));
    rejectInput(new Error("Failed touch"));
    await vi.waitFor(() => expect(f.writes.at(-1)?.body.action).toBe("release"));
    const count = f.writes.length;
    f.client.takeControl?.();
    expect(f.writes).toHaveLength(count);
    f.blockInput(Promise.resolve());
    finishRelease();
    await vi.waitFor(() =>
      expect(f.events.onInputConnected).toHaveBeenLastCalledWith(true, undefined),
    );
    f.client.sendTouch("begin", 1, 1);
    f.client.sendTouch("end", 1, 1);
    await vi.waitFor(() => expect(f.writes.at(-1)?.body.request).toMatchObject({ phase: "end" }));
    expect(
      f.writes.map(
        ({ route, body }) => body.action ?? (body.request as { phase?: string })?.phase ?? route,
      ),
    ).toEqual(["take", "begin", "release", "take", "begin", "end"]);
  } finally {
    finishRelease();
    f.client.stop();
  }
});

it("ignores a stale ownership poll completed after a successful take", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let finishTake = () => {};
  let finishState = () => {};
  const take = new Promise<void>((resolve) => {
    finishTake = resolve;
  });
  const state = new Promise<void>((resolve) => {
    finishState = resolve;
  });
  try {
    f.client.start();
    await vi.advanceTimersByTimeAsync(50);
    f.blockTake(take);
    f.client.takeControl?.();
    f.blockState(state);
    await vi.advanceTimersByTimeAsync(1100);
    finishTake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.events.onInputConnected).toHaveBeenLastCalledWith(true, undefined);
    f.client.sendTouch("begin", 0, 0);
    await vi.advanceTimersByTimeAsync(0);
    finishState();
    await vi.advanceTimersByTimeAsync(0);
    f.client.sendTouch("end", 0, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.writes.at(-1)?.body.request).toMatchObject({ phase: "end" });
  } finally {
    finishTake();
    finishState();
    f.client.stop();
    vi.useRealTimers();
  }
});
