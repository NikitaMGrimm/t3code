import { EnvironmentId, ThreadId, type DesktopPreviewTabState } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  mode: undefined as "native" | "headless" | undefined,
  listener: null as ((tabId: string, state: DesktopPreviewTabState) => void) | null,
  applyDesktopState: vi.fn(),
  unsubscribe: vi.fn(),
  reportStatus: vi.fn(),
  clearPointer: vi.fn(),
}));

vi.mock("~/previewStateStore", () => ({
  applyPreviewDesktopState: mocks.applyDesktopState,
  readThreadPreviewState: () => ({ sessions: { "tab-1": { serverPageMode: mocks.mode } } }),
}));
vi.mock("~/browserFaviconStore", () => ({
  flushPendingFaviconsForThread: vi.fn(),
  recordFaviconForThread: vi.fn(),
  useFaviconProjectRefForThread: () => null,
}));
vi.mock("~/browser/browserPointerStore", () => ({
  useBrowserPointerStore: (select: (state: { clear: typeof mocks.clearPointer }) => unknown) =>
    select({ clear: mocks.clearPointer }),
}));
vi.mock("~/state/preview", () => ({ previewEnvironment: { reportStatus: {} } }));
vi.mock("~/state/session", () => ({ usePreparedConnection: () => Option.none() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.reportStatus }));
vi.mock("./previewBridge", () => ({
  previewBridge: {
    onStateChange: (listener: typeof mocks.listener) => {
      mocks.listener = listener;
      return mocks.unsubscribe;
    },
  },
}));

import { usePreviewBridge } from "./usePreviewBridge";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};
let root: Root | undefined;

function BridgeHarness() {
  usePreviewBridge({ threadRef, tabId: "tab-1", runtimeTabId: "native-tab-1", serverDriven: true });
  return null;
}

function state(navStatus: DesktopPreviewTabState["navStatus"]): DesktopPreviewTabState {
  return {
    tabId: "tab-1",
    webContentsId: 1,
    navStatus,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1,
    pictureInPicture: false,
    colorScheme: "system",
    audioMuted: false,
    audible: false,
    controller: "none",
    favicon: {
      dataUrl: "data:image/png;base64,AAAA",
      pageUrl: "https://example.com/",
      capturedAt: 1,
    },
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
}

async function mount() {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<BridgeHarness />));
}

async function unmount() {
  await act(async () => root?.unmount());
  root = undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mode = undefined;
  mocks.listener = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await unmount();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("native bridge lifetime", () => {
  it("drops late native state when the server switches this tab to headless", async () => {
    mocks.mode = "native";
    await mount();
    mocks.listener?.(
      "native-tab-1",
      state({ kind: "Loading", url: "https://example.com/", title: "" }),
    );
    expect(mocks.applyDesktopState).toHaveBeenLastCalledWith(
      threadRef,
      "tab-1",
      expect.objectContaining({ loading: true }),
    );
    expect(mocks.reportStatus).not.toHaveBeenCalled();

    mocks.mode = "headless";
    mocks.listener?.(
      "native-tab-1",
      state({ kind: "Success", url: "https://other.example/", title: "Late" }),
    );
    expect(mocks.applyDesktopState).toHaveBeenLastCalledWith(threadRef, "tab-1", null);
    expect(mocks.reportStatus).not.toHaveBeenCalled();

    await unmount();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    expect(mocks.applyDesktopState).toHaveBeenLastCalledWith(threadRef, "tab-1", null);
  });

  it("clears the native overlay on headless unmount even without another native event", async () => {
    await mount();
    mocks.listener?.(
      "native-tab-1",
      state({ kind: "Loading", url: "https://example.com/", title: "" }),
    );
    mocks.mode = "headless";
    await unmount();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    expect(mocks.applyDesktopState).toHaveBeenLastCalledWith(threadRef, "tab-1", null);
  });
});
