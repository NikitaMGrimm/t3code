import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
  type ClientSettings,
  type DesktopPreviewBridge,
} from "@t3tools/contracts";
import type { ReactNode } from "react";

import "~/index.css";
import { describe, expect, it, vi } from "vite-plus/test";
import type { previewBridge } from "~/components/preview/previewBridge";

import { act, fakeTimers, render } from "../../test/render";

const mocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
  createTab: vi.fn<DesktopPreviewBridge["createTab"]>(),
  closeTab: vi.fn<DesktopPreviewBridge["closeTab"]>(),
  registerWebview: vi.fn<DesktopPreviewBridge["registerWebview"]>(),
  getPreviewConfig: vi.fn<DesktopPreviewBridge["getPreviewConfig"]>(),
  activeRecordings: new Set<string>(),
}));

vi.mock(import("~/localApi"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    ensureLocalApi: () => ({ ...actual.ensureLocalApi(), persistence: mocks as never }),
  };
});

vi.mock(import("./desktopTabLifetime"), { spy: true });

// The Electron desktop bridge; a browser has none.
vi.mock(import("~/components/preview/previewBridge"), async (original) => ({
  ...(await original()),
  previewBridge: {
    createTab: mocks.createTab,
    closeTab: mocks.closeTab,
    registerWebview: mocks.registerWebview,
    getPreviewConfig: mocks.getPreviewConfig,
  } as unknown as NonNullable<typeof previewBridge>,
}));

vi.mock(import("~/components/preview/usePreviewBridge"), async (original) => ({
  ...(await original()),
  usePreviewBridge: () => undefined,
}));

import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
} from "~/hooks/useSettings";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import * as desktopTabLifetime from "./desktopTabLifetime";
import { HostedBrowserWebview } from "./HostedBrowserWebview";

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function resetStores() {
  __resetClientSettingsPersistenceForTests();
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
}

function setup() {
  using stack = new DisposableStack();
  resetStores();
  stack.defer(resetStores);
  vi.mocked(desktopTabLifetime.acquireDesktopTab).mockClear();
  mocks.getClientSettings.mockReset();
  mocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  mocks.createTab.mockReset().mockResolvedValue(undefined);
  mocks.closeTab.mockReset().mockResolvedValue(undefined);
  mocks.registerWebview.mockReset().mockResolvedValue(undefined);
  mocks.getPreviewConfig.mockReset().mockResolvedValue({
    partition: "persist:t3-preview-work",
    webPreferences: "contextIsolation=yes",
    preloadUrl: null,
  });
  stack.use(vi.spyOn(console, "error").mockImplementation(() => undefined));
  return stack.move();
}

// The webview releases its desktop tab on a timer after unmount; run it before the test ends
// so it cannot land in the next one.
async function renderHost(ui: ReactNode) {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await render(ui));
  stack.defer(async () => {
    using _timers = fakeTimers();
    await screen.unmount();
    await vi.advanceTimersByTimeAsync(0);
  });
  const environment = stack.move();
  return Object.assign(screen, { [Symbol.asyncDispose]: () => environment.disposeAsync() });
}

describe("HostedBrowserWebview late guest", () => {
  it("releases a removed native guest without registering it when tab creation finishes late", async () => {
    using _setup = setup();
    mocks.getClientSettings.mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    await act(async () => ensureClientSettingsHydrated());
    const tabCreation = deferred<void>();
    mocks.createTab.mockReturnValueOnce(tabCreation.promise);
    const threadRef = {
      environmentId: EnvironmentId.make("headless-fallback"),
      threadId: ThreadId.make("thread-fallback"),
    };
    const runtimeTabId = "late-native-fallback";
    const createElement = document.createElement.bind(document);
    using _guest = vi.spyOn(document, "createElement").mockImplementation(((
      tagName: string,
      options?: ElementCreationOptions,
    ) => {
      const element = createElement(tagName, options);
      return tagName === "webview"
        ? Object.assign(element, { getWebContentsId: () => 41 })
        : element;
    }) as typeof document.createElement);
    await using screen = await renderHost(
      <HostedBrowserWebview
        threadRef={threadRef}
        tabId="server-tab"
        runtimeTabId={runtimeTabId}
        initialUrl="https://example.com"
        viewport={FILL_PREVIEW_VIEWPORT}
        pictureInPicture={false}
        profileId="default"
        zoomFactor={1}
        serverDriven
      />,
    );
    expect(mocks.createTab).toHaveBeenCalledOnce();
    expect(mocks.registerWebview).not.toHaveBeenCalled();
    using _timers = fakeTimers();
    await screen.unmount();
    await act(async () => {
      tabCreation.resolve();
      await tabCreation.promise;
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.registerWebview).not.toHaveBeenCalled();
    expect(mocks.closeTab).toHaveBeenCalledExactlyOnceWith(runtimeTabId);
  });
});
