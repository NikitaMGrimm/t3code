import { EnvironmentId, ThreadId, type DesktopPreviewTabState } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vite-plus/test";

import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";

import { render } from "../../../test/render";

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

function BridgeHarness() {
  usePreviewBridge({ threadRef, tabId: "tab-1", runtimeTabId: "native-tab-1", serverDriven: true });
  return null;
}

function state(
  navStatus: DesktopPreviewTabState["navStatus"],
  capturing = false,
): DesktopPreviewTabState {
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
    capturing,
    favicon: {
      dataUrl: "data:image/png;base64,AAAA",
      pageUrl: "https://example.com/",
      capturedAt: 1,
    },
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
}

function mount(mode?: "native" | "headless") {
  vi.clearAllMocks();
  mocks.mode = mode;
  mocks.listener = null;
  return render(<BridgeHarness />, { router: false });
}

describe("native bridge lifetime", () => {
  it("drops late native state when the server switches this tab to headless", async () => {
    await using screen = await mount("native");
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

    await screen.unmount();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    expect(mocks.applyDesktopState).toHaveBeenLastCalledWith(threadRef, "tab-1", null);
  });

  it("clears the native overlay on headless unmount even without another native event", async () => {
    await using screen = await mount();
    mocks.listener?.(
      "native-tab-1",
      state({ kind: "Loading", url: "https://example.com/", title: "" }),
    );
    mocks.mode = "headless";
    await screen.unmount();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    expect(mocks.applyDesktopState).toHaveBeenLastCalledWith(threadRef, "tab-1", null);
  });

  it("keeps the guest painting only while the host captures it", async () => {
    const activity = () => useBrowserSurfaceStore.getState().activityByTabId["native-tab-1"];
    await using screen = await mount("native");
    const loading = { kind: "Loading", url: "https://example.com/", title: "" } as const;
    mocks.listener?.("native-tab-1", state(loading, true));
    expect(activity()).toBe(1);
    mocks.listener?.("native-tab-1", state(loading, false));
    expect(activity()).toBeUndefined();
    mocks.listener?.("native-tab-1", state(loading, true));
    // A guest whose bridge goes away while capturing must not keep painting.
    await screen.unmount();
    expect(activity()).toBeUndefined();
  });
});
