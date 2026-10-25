import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { PreviewEvent, PreviewSessionSnapshot } from "./preview.ts";
import { PreviewAutomationHost, PreviewAutomationStatus } from "./previewAutomation.ts";

const decodeSnapshot = Schema.decodeUnknownSync(PreviewSessionSnapshot);
const decodePreviewEvent = Schema.decodeUnknownSync(PreviewEvent);
const decodeAutomationHost = Schema.decodeUnknownSync(PreviewAutomationHost);
const decodeAutomationStatus = Schema.decodeUnknownSync(PreviewAutomationStatus);

describe("PreviewAutomationHost", () => {
  it("accepts legacy hosts and current operation advertisements", () => {
    expect(decodeAutomationHost({ clientId: "legacy", environmentId: "environment-1" })).toEqual({
      clientId: "legacy",
      environmentId: "environment-1",
    });
    expect(
      decodeAutomationHost({
        clientId: "current",
        environmentId: "environment-1",
        supportedOperations: ["status", "resize"],
      }).supportedOperations,
    ).toEqual(["status", "resize"]);
  });
});

describe("PreviewAutomationStatus", () => {
  it("accepts old hosts without viewport data and exposes it from current hosts", () => {
    const base = {
      available: true,
      visible: false,
      tabId: "preview-t",
      url: "https://example.com",
      title: "Example",
      loading: false,
    };
    expect(decodeAutomationStatus(base)).toEqual(base);
    expect(
      decodeAutomationStatus({
        ...base,
        viewportSetting: { _tag: "preset", presetId: "pixel-8", width: 412, height: 915 },
        viewport: { width: 412, height: 915 },
      }).viewport,
    ).toEqual({ width: 412, height: 915 });
  });
});

describe("PreviewSessionSnapshot", () => {
  const legacySnapshot = {
    threadId: "thread-1",
    tabId: "preview-thread-1",
    navStatus: {
      _tag: "Success" as const,
      url: "http://localhost:5173/",
      title: "Vite App",
    },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const jsonCodec = Schema.toCodecJson(PreviewSessionSnapshot);
  const encodeJson = Schema.encodeSync(jsonCodec);
  const decodeJson = Schema.decodeUnknownSync(jsonCodec);

  it("round-trips a legacy snapshot without choosing a page backing", () => {
    const snapshot = decodeJson(encodeJson(decodeSnapshot(legacySnapshot)));
    expect(snapshot).toEqual(legacySnapshot);
    expect(snapshot).not.toHaveProperty("serverPageMode");
  });

  it.each(["native", "headless"] as const)("preserves %s server page backing over JSON", (mode) => {
    const snapshot = decodeSnapshot({
      ...legacySnapshot,
      runtime: "server",
      serverPageMode: mode,
    });
    expect(decodeJson(encodeJson(snapshot))).toEqual({
      ...legacySnapshot,
      runtime: "server",
      serverPageMode: mode,
    });
  });

  it("rejects a runtime value used as a page backing", () => {
    expect(() =>
      decodeSnapshot({ ...legacySnapshot, runtime: "server", serverPageMode: "server" }),
    ).toThrow();
  });
});

describe("PreviewEvent", () => {
  it("preserves the headless fallback in a snapshot update sent to clients", () => {
    const event = decodePreviewEvent({
      type: "navigated",
      threadId: "t",
      tabId: "preview-t",
      createdAt: "2026-01-01T00:00:00.000Z",
      serverEpoch: "server-a",
      revision: 2,
      snapshot: {
        threadId: "t",
        tabId: "preview-t",
        runtime: "server",
        serverPageMode: "headless",
        navStatus: { _tag: "Loading", url: "https://example.com/", title: "" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const jsonCodec = Schema.toCodecJson(PreviewEvent);
    const received = Schema.decodeUnknownSync(jsonCodec)(Schema.encodeSync(jsonCodec)(event));
    expect(received).toEqual(event);
    expect(received.type === "navigated" && received.snapshot.serverPageMode).toBe("headless");
  });
});
