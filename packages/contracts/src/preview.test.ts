import { Schema } from "effect";
import { PreviewEvent, PreviewSessionSnapshot } from "./preview.ts";
const decodeSnapshot = Schema.decodeUnknownSync(PreviewSessionSnapshot);
const decodePreviewEvent = Schema.decodeUnknownSync(PreviewEvent);
import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
import {
  PreviewAutomationHost,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationStatus,
} from "./previewAutomation.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

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

describe("PreviewAutomationInvalidSelectorError", () => {
  const invalidSelector = (selectorKind: "locator" | "selector") =>
    new PreviewAutomationInvalidSelectorError({
      operation: "click",
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
      providerSessionId: "session-1",
      providerInstanceId: ProviderInstanceId.make("claude"),
      clientId: "desktop",
      connectionId: "connection-1",
      requestId: "request-1",
      timeoutMs: 15_000,
      remoteTag: "Error",
      remoteMessageLength: 0,
      cause: null,
      selectorKind,
      selectorLength: 42,
    });

  it("tells agents which locator forms are accepted and where CSS goes", () => {
    const { message } = invalidSelector("locator");
    expect(message).toContain("aria-ref=");
    expect(message).toMatch(/role/);
    expect(message).toMatch(/text/);
    expect(message).toMatch(/CSS[^.]*\bselector\b/);
  });

  it("points an invalid CSS selector at the locator alternative", () => {
    const { message } = invalidSelector("selector");
    expect(message).toMatch(/CSS/);
    expect(message).toMatch(/\blocator\b/);
    expect(message).toContain("aria-ref=");
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


describe("PreviewEvent page backing", () => {
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
