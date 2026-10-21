import type { CDPSession, Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import * as ServerBrowserPage from "./ServerBrowserPage.ts";

afterEach(() => vi.useRealTimers());

describe("server browser capture deadlines", () => {
  it("lets a retired session release its guard without a late answer releasing the replacement", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const oldResponse = Promise.withResolvers<{ data: string }>();
    const nextResponse = Promise.withResolvers<{ data: string }>();
    const send = vi
      .fn()
      .mockReturnValueOnce(oldResponse.promise)
      .mockReturnValueOnce(nextResponse.promise);
    const page = {} as Page;
    const cdp = { send } as unknown as CDPSession;
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
    const page = {} as Page;
    const cdp = { send } as unknown as CDPSession;
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

  it("keeps upstream viewport and offset options when applying the deadline", async () => {
    const send = vi.fn().mockResolvedValue({ data: "scaled" });
    await expect(
      ServerBrowserPage.captureViewport({} as Page, { send } as unknown as CDPSession, {
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
      { viewportSize: () => ({ width: 800, height: 600 }) } as Page,
      { send } as unknown as CDPSession,
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
    } as unknown as Page;
    const cdp = {
      send: (method: string) =>
        method === "Page.captureScreenshot" ? Promise.resolve({ data: "" }) : never(),
    } as unknown as CDPSession;
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
