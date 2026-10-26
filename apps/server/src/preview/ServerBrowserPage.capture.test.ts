import * as NodeEvents from "node:events";

import type { CDPSession, Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import * as ServerBrowserPage from "./ServerBrowserPage.ts";

afterEach(() => vi.useRealTimers());

const makePage = (extra: object = {}) => {
  const events = new NodeEvents.EventEmitter();
  const mainFrame = {};
  const page = {
    on: (name: string, listener: (...args: unknown[]) => void) => events.on(name, listener),
    off: (name: string, listener: (...args: unknown[]) => void) => events.off(name, listener),
    mainFrame: () => mainFrame,
    ...extra,
  } as unknown as Page;
  return {
    page,
    ready: () => events.emit("domcontentloaded"),
    navigate: () => events.emit("framenavigated", mainFrame),
  };
};

const makeCdp = (send: unknown) => {
  const events = new NodeEvents.EventEmitter();
  const cdp = {
    send,
    on: (name: string, listener: (...args: unknown[]) => void) => events.on(name, listener),
    off: (name: string, listener: (...args: unknown[]) => void) => events.off(name, listener),
  } as unknown as CDPSession;
  return {
    cdp,
    committed: (frame: { parentId?: string } = {}) => events.emit("Page.frameNavigated", { frame }),
    listeners: () => events.listenerCount("Page.frameNavigated"),
  };
};

describe("server browser capture deadlines", () => {
  it("lets a retired session release its guard without a late answer releasing the replacement", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const oldResponse = Promise.withResolvers<{ data: string }>();
    const nextResponse = Promise.withResolvers<{ data: string }>();
    const send = vi
      .fn()
      .mockReturnValueOnce(oldResponse.promise)
      .mockReturnValueOnce(nextResponse.promise);
    const { page } = makePage();
    const { cdp } = makeCdp(send);
    const retired = new AbortController();
    const options = { format: "png", scale: 1 } as const;
    const first = ServerBrowserPage.captureViewport(page, cdp, options, retired.signal);
    retired.abort();
    const second = ServerBrowserPage.captureViewport(page, cdp, options);
    oldResponse.resolve({ data: "old" });
    await first;
    await expect(ServerBrowserPage.captureViewport(page, cdp, options)).rejects.toThrow(
      "did not draw a frame",
    );
    expect(send).toHaveBeenCalledTimes(2);
    nextResponse.resolve({ data: "new" });
    await expect(second).resolves.toBe("new");
  });

  it("refuses overlapping captures until Chromium answers the timed-out request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const response = Promise.withResolvers<{ data: string }>();
    const send = vi.fn().mockReturnValueOnce(response.promise).mockResolvedValue({ data: "fresh" });
    const { page } = makePage();
    const { cdp } = makeCdp(send);
    const options = { format: "png", scale: 1 } as const;
    const rejected = expect(ServerBrowserPage.captureViewport(page, cdp, options)).rejects.toThrow(
      "did not draw a frame",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    await expect(ServerBrowserPage.captureViewport(page, cdp, options)).rejects.toThrow(
      "did not draw a frame",
    );
    expect(send).toHaveBeenCalledTimes(1);
    response.resolve({ data: "late" });
    await vi.advanceTimersByTimeAsync(0);
    await expect(ServerBrowserPage.captureViewport(page, cdp, options)).resolves.toBe("fresh");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("releases a timed-out capture only when a new main document commits", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const oldResponse = Promise.withResolvers<{ data: string }>();
    const nextResponse = Promise.withResolvers<{ data: string }>();
    const send = vi
      .fn()
      .mockReturnValueOnce(oldResponse.promise)
      .mockReturnValueOnce(nextResponse.promise);
    const { page, navigate, ready } = makePage();
    const { cdp, committed, listeners } = makeCdp(send);
    const options = { format: "png", scale: 1 } as const;
    const first = expect(ServerBrowserPage.captureViewport(page, cdp, options)).rejects.toThrow(
      "did not draw a frame",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await first;
    // An iframe's navigation leaves the old document's capture pending.
    committed({ parentId: "main" });
    await expect(ServerBrowserPage.captureViewport(page, cdp, options)).rejects.toThrow(
      "did not draw a frame",
    );
    navigate();
    await expect(ServerBrowserPage.captureViewport(page, cdp, options)).rejects.toThrow(
      "did not draw a frame",
    );
    ready();
    await expect(ServerBrowserPage.captureViewport(page, cdp, options)).rejects.toThrow(
      "did not draw a frame",
    );
    committed();
    expect(listeners()).toBe(0);
    const second = ServerBrowserPage.captureViewport(page, cdp, options);
    // The old document's late answer must not release the replacement's guard.
    oldResponse.resolve({ data: "old" });
    await vi.advanceTimersByTimeAsync(0);
    await expect(ServerBrowserPage.captureViewport(page, cdp, options)).rejects.toThrow(
      "did not draw a frame",
    );
    expect(send).toHaveBeenCalledTimes(2);
    nextResponse.resolve({ data: "new" });
    await expect(second).resolves.toBe("new");
    expect(listeners()).toBe(0);
  });

  it("keeps upstream viewport and offset options when applying the deadline", async () => {
    const send = vi.fn().mockResolvedValue({ data: "scaled" });
    await expect(
      ServerBrowserPage.captureViewport(makePage().page, makeCdp(send).cdp, {
        format: "png",
        scale: 0.5,
        viewport: { width: 900, height: 700 },
        offset: { x: 30, y: 40 },
      }),
    ).resolves.toBe("scaled");
    expect(send).toHaveBeenCalledExactlyOnceWith("Page.captureScreenshot", {
      format: "png",
      clip: { x: 30, y: 40, width: 900, height: 700, scale: 0.5 },
    });
  });

  it("derives document offsets using the browser's zoom when none is supplied", async () => {
    const send = vi.fn(async (method: string) =>
      method === "Page.getLayoutMetrics"
        ? { cssVisualViewport: { pageX: 20, pageY: 30, zoom: 1.5 } }
        : { data: "scaled" },
    );
    await ServerBrowserPage.captureViewport(
      makePage({ viewportSize: () => ({ width: 800, height: 600 }) }).page,
      makeCdp(send).cdp,
      { format: "jpeg", quality: 80, scale: 0.5 },
    );
    expect(send).toHaveBeenLastCalledWith("Page.captureScreenshot", {
      format: "jpeg",
      quality: 80,
      clip: { x: 30, y: 45, width: 800, height: 600, scale: 0.5 },
    });
  });

  it("bounds a snapshot when the page's main thread never answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const never = () => new Promise<never>(() => {});
    const mainFrame = {};
    const page = {
      frames: () => [mainFrame],
      mainFrame: () => mainFrame,
      viewportSize: () => ({ width: 800, height: 600 }),
      evaluate: never,
      ariaSnapshot: never,
      on: () => {},
      off: () => {},
    } as unknown as Page;
    const { cdp } = makeCdp((method: string) =>
      method === "Page.captureScreenshot" ? Promise.resolve({ data: "" }) : never(),
    );
    const settled = ServerBrowserPage.snapshot({
      page,
      cdp,
      renderScale: 1,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    }).then(() => null, ServerBrowserPage.toOperationError);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await settled).toMatchObject({ tag: "PreviewAutomationTimeoutError" });
  });
});
