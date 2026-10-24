// @effect-diagnostics globalFetch:off globalTimers:off - Browser/WebView transport without an Effect runtime.
import { withDeviceHubQuery } from "./hubAccess.ts";
import type { DeviceFrameSink } from "./frame.ts";
import type { DeviceStreamClient, DeviceStreamEvents, DeviceStreamTarget } from "./stream.ts";

export function createIphoneXStream(
  target: DeviceStreamTarget,
  sink: DeviceFrameSink,
  events: DeviceStreamEvents,
): DeviceStreamClient {
  let active: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const controllerId = `human:${target.inputControllerId ?? Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  let owned = false;
  let ownershipDesired = true;
  let inputGeneration = 0;
  let size = { width: 1125, height: 2436 };
  let pointer: { x: number; y: number; at: number } | null = null;
  let pending: Promise<void> = Promise.resolve();
  let queued = 0;
  const url = (route: string) =>
    withDeviceHubQuery(`${target.access.httpBase}/vendor/iphone-x/api/${route}`, target.access);
  const report = (connected: boolean, detail?: string) => {
    owned = connected;
    events.onInputConnected(connected, detail);
  };
  const request = async (route: string, current: AbortController, body?: unknown) => {
    const response = await fetch(
      url(route) +
        (url(route).includes("?") ? "&" : "?") +
        new URLSearchParams({ controller: controllerId }),
      {
        method: body === undefined ? "GET" : "POST",
        credentials: target.access.credentials ? "include" : "omit",
        ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" } }),
        ...(body === undefined
          ? {}
          : { body: JSON.stringify({ ...(body as object), controller: controllerId }) }),
        signal: AbortSignal.any([current.signal, AbortSignal.timeout(30_000)]),
      },
    );
    if (response.status === 401) events.onUnauthorized();
    if (!response.ok)
      throw new Error(
        response.status === 409
          ? "Phone control is held elsewhere. Release it there or use Take control to hand over from the agent."
          : `The iPhone X connection failed (${response.status}).`,
      );
    return response;
  };
  const perform = (route: string, body: object) => {
    const current = active;
    const generation = inputGeneration;
    const releasing = route === "control" && "action" in body && body.action === "release";
    if (!current || (queued >= 32 && !releasing)) return;
    queued++;
    pending = pending
      .then(async () => {
        if (active !== current || current.signal.aborted || inputGeneration !== generation) return;
        try {
          await request(route, current, body);
          if (active === current && inputGeneration === generation && route === "control")
            report("action" in body && body.action === "take");
        } catch (error) {
          if (active === current && !current.signal.aborted)
            report(false, error instanceof Error ? error.message : "Phone input failed.");
        }
      })
      .finally(() => {
        queued--;
      });
  };
  const input = (request: object) => {
    if (owned) perform("input", { request });
  };
  const frame = async (current: AbortController) => {
    try {
      const state: unknown = await (await request("state", current)).json();
      if (
        !state ||
        typeof state !== "object" ||
        !("connected" in state) ||
        state.connected !== true ||
        !("width" in state) ||
        !("height" in state) ||
        typeof state.width !== "number" ||
        typeof state.height !== "number" ||
        !Number.isInteger(state.width) ||
        !Number.isInteger(state.height) ||
        state.width < 1 ||
        state.height < 1 ||
        state.width * state.height > 16_000_000
      )
        throw new Error("The iPhone X is disconnected. Close and reopen it.");
      size = { width: state.width, height: state.height };
      if (active !== current) return;
      events.onScreen({ ...size, orientation: "portrait" });
      report(
        ownershipDesired && "controlsInput" in state && state.controlsInput === true,
        "owner" in state && state.owner === "agent"
          ? "The agent has control. Take control to use the phone."
          : "Take control to interact with the phone.",
      );
      const blob = await (await request("frame", current)).blob();
      if (blob.type !== "image/png" || blob.size > 32 * 1024 * 1024)
        throw new Error("Invalid phone frame.");
      const source = URL.createObjectURL(blob);
      try {
        const image = new Image();
        image.src = source;
        await image.decode();
        if (active === current && sink.present(image, size.width, size.height))
          events.onStatus("streaming");
      } finally {
        URL.revokeObjectURL(source);
      }
    } catch (error) {
      if (active !== current || current.signal.aborted) return;
      report(false);
      events.onStatus(
        "error",
        error instanceof Error ? error.message : "The iPhone X connection failed.",
      );
      return;
    }
    if (active === current)
      timer = setTimeout(() => {
        void frame(current);
      }, 500);
  };
  const touch: DeviceStreamClient["sendTouch"] = (phase, x, y) => {
    if (!owned || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const point = {
      x: Math.round(Math.max(0, Math.min(1, x)) * (size.width - 1)),
      y: Math.round(Math.max(0, Math.min(1, y)) * (size.height - 1)),
    };
    if (phase === "begin") pointer = { ...point, at: performance.now() };
    if (phase !== "end" || !pointer) return;
    const from = pointer;
    pointer = null;
    const duration = Math.round(Math.max(50, Math.min(5000, performance.now() - from.at)));
    if (Math.abs(point.x - from.x) + Math.abs(point.y - from.y) < 5)
      input({ op: "tap", x: from.x, y: from.y, hold_ms: Math.max(150, duration) });
    else
      input({
        op: "swipe",
        x1: from.x,
        y1: from.y,
        x2: point.x,
        y2: point.y,
        duration_ms: duration,
      });
  };
  return {
    start() {
      if (active) return;
      active = new AbortController();
      events.onStatus("connecting");
      void frame(active);
    },
    stop() {
      const previousId = controllerId;
      const wasOwned = owned;
      active?.abort();
      active = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pointer = null;
      owned = false;
      inputGeneration++;
      if (wasOwned)
        void fetch(url("control"), {
          method: "POST",
          keepalive: true,
          credentials: target.access.credentials ? "include" : "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "release", controller: previousId }),
        }).catch(() => {});
    },
    takeControl: () => {
      ownershipDesired = true;
      perform("control", { action: "take" });
    },
    releaseControl: () => {
      ownershipDesired = false;
      inputGeneration++;
      pointer = null;
      report(false);
      perform("control", { action: "release" });
    },
    sendTouch: touch,
    sendRawTouch: touch,
    sendKey(event, phase) {
      if (phase !== "down" || event.ctrlKey || event.metaKey || event.altKey) return;
      const keys: Record<string, string> = {
        Enter: "Return",
        Backspace: "BackSpace",
        Escape: "Escape",
        Tab: "Tab",
        ArrowLeft: "Left",
        ArrowRight: "Right",
        ArrowUp: "Up",
        ArrowDown: "Down",
        Delete: "Delete",
      };
      if (keys[event.key]) input({ op: "key", key: keys[event.key] });
      else if (event.key.length === 1 && event.key >= " " && event.key <= "~")
        input({ op: "type", text: event.key });
    },
    sendText: (text) => {
      if (text.length > 0 && text.length <= 500 && /^[\x20-\x7e]+$/.test(text))
        input({ op: "type", text });
    },
    pressButton: (button) => {
      if (button === "home") input({ op: "home" });
    },
    rotate() {},
    setOrientation() {},
    setMjpegImage() {},
    controlDuo() {},
    setDuoPanels() {},
  };
}
