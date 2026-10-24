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
  let pointer: { x: number; y: number } | null = null;
  let pendingMove: { request: { op: "pointer"; phase: "move"; x: number; y: number } } | null =
    null;
  let stateAt = -Infinity;
  let pending: Promise<void> = Promise.resolve();
  let queued = 0;
  const url = (route: string) =>
    withDeviceHubQuery(`${target.access.httpBase}/vendor/iphone-x/api/${route}`, target.access);
  const report = (connected: boolean, detail?: string) => {
    if (owned && !connected) {
      pointer = null;
      pendingMove = null;
      inputGeneration++;
    }
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
    const ending =
      "request" in body &&
      typeof body.request === "object" &&
      body.request !== null &&
      "phase" in body.request &&
      (body.request.phase === "end" || body.request.phase === "cancel");
    if (!current || (queued >= 32 && !releasing && !ending)) return false;
    queued++;
    pending = pending
      .then(async () => {
        if (pendingMove === body) pendingMove = null;
        // A queued release must precede any later take, even after input was invalidated.
        if (
          active !== current ||
          current.signal.aborted ||
          (!releasing && inputGeneration !== generation)
        )
          return;
        try {
          await request(route, current, body);
          if (active === current && inputGeneration === generation && route === "control") {
            inputGeneration++;
            report("action" in body && body.action === "take");
          }
        } catch (error) {
          if (active === current && !current.signal.aborted && inputGeneration === generation) {
            relinquish(error instanceof Error ? error.message : "Phone input failed.");
          }
        }
      })
      .finally(() => {
        queued--;
      });
    return true;
  };
  const relinquish = (detail?: string): void => {
    const wasOwned = owned;
    owned = false;
    pointer = null;
    pendingMove = null;
    inputGeneration++;
    if (wasOwned) perform("control", { action: "release" });
    report(false, detail);
  };
  const input = (request: object) => {
    if (owned) perform("input", { request });
  };
  const frame = async (current: AbortController) => {
    const started = performance.now();
    try {
      if (started - stateAt >= 1000) {
        const generation = inputGeneration;
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
        stateAt = performance.now();
        if (generation === inputGeneration)
          report(
            ownershipDesired && "controlsInput" in state && state.controlsInput === true,
            "owner" in state && state.owner === "agent"
              ? "The agent has control. Take control to use the phone."
              : "Take control to interact with the phone.",
          );
      }
      const blob = await (await request("frame?preview=1", current)).blob();
      if (!["image/png", "image/jpeg"].includes(blob.type) || blob.size > 32 * 1024 * 1024)
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
      relinquish();
      events.onStatus(
        "error",
        error instanceof Error ? error.message : "The iPhone X connection failed.",
      );
      return;
    }
    if (active === current)
      timer = setTimeout(
        () => {
          void frame(current);
        },
        Math.max(0, 50 - (performance.now() - started)),
      );
  };
  const touch: DeviceStreamClient["sendTouch"] = (phase, x, y) => {
    if (!owned || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const point = {
      x: Math.round(Math.max(0, Math.min(1, x)) * (size.width - 1)),
      y: Math.round(Math.max(0, Math.min(1, y)) * (size.height - 1)),
    };
    if (phase === "begin") {
      pendingMove = null;
      if (!pointer && perform("input", { request: { op: "pointer", phase, ...point } }))
        pointer = point;
      return;
    }
    if (!pointer) return;
    pointer = point;
    if (phase === "move") {
      if (pendingMove) pendingMove.request = { op: "pointer", phase, ...point };
      else {
        const body = { request: { op: "pointer" as const, phase, ...point } };
        if (perform("input", body)) pendingMove = body;
      }
      return;
    }
    pointer = null;
    pendingMove = null;
    perform("input", { request: { op: "pointer", phase, ...point } });
  };
  return {
    start() {
      if (active) return;
      stateAt = -Infinity;
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
      pendingMove = null;
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
      inputGeneration++;
      ownershipDesired = true;
      perform("control", { action: "take" });
    },
    releaseControl: () => {
      ownershipDesired = false;
      inputGeneration++;
      pointer = null;
      pendingMove = null;
      report(false);
      perform("control", { action: "release" });
    },
    sendTouch: touch,
    sendRawTouch: touch,
    cancelTouch: () => {
      if (!owned || !pointer) return;
      const point = pointer;
      pointer = null;
      pendingMove = null;
      perform("input", { request: { op: "pointer", phase: "cancel", ...point } });
    },
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
