import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { PreviewAutomationStatus } from "./previewAutomation.ts";

const decodeAutomationStatus = Schema.decodeUnknownSync(PreviewAutomationStatus);

describe("personal preview protocol compatibility", () => {
  it("preserves mixed page backings in the automation response over JSON", () => {
    const status = {
      available: true,
      visible: true,
      tabId: "native-tab",
      url: "https://example.com/",
      title: "Example",
      loading: false,
      serverPageMode: "native" as const,
      tabs: [
        { tabId: "native-tab", url: "https://example.com/", serverPageMode: "native" as const },
        { tabId: "fallback-tab", url: "https://example.com/", serverPageMode: "headless" as const },
      ],
    };
    const codec = Schema.toCodecJson(PreviewAutomationStatus);
    const decoded = decodeAutomationStatus(status);
    expect(Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(decoded))).toEqual(status);
  });
});
