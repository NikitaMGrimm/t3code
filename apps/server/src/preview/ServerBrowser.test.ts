import * as NodeEvents from "node:events";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Playwright download mocks perform real file operations outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { BrowserContext, Page } from "playwright-core";
import { beforeEach, expect, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";

vi.mock("./ServerBrowserContexts.ts", () => ({
  presentAsChrome: async () => {},
  ServerBrowserContexts: class {
    private readonly onClose: ((context: BrowserContext) => void) | undefined;
    constructor(options: { onContextClose?: (context: BrowserContext) => void }) {
      this.onClose = options.onContextClose;
    }
    async contextFor(profileId: string, isolationKey?: string) {
      contextRequests.push({ profileId, isolated: isolationKey !== undefined });
      contextRequested?.resolve();
      if (contextFailure) throw contextFailure;
      await contextGate?.promise;
      const context = makeContext(this.onClose);
      contexts.push(context);
      return context as unknown as BrowserContext;
    }
    async scratchPage() {
      const page = makeContext().page;
      scratchPages.push(page);
      return page as unknown as Page;
    }
    async connectDesktopPage(endpoint: string) {
      const context = makeContext();
      desktopConnections.push({ endpoint, context });
      return { browser: { close: async () => {} }, page: context.page as unknown as Page };
    }
    async close() {
      for (const context of contexts) await context.close();
    }
  },
}));

function makeFrame() {
  const frame = {
    copy: "",
    detached: false,
    isDetached: () => frame.detached,
    recording: Promise.withResolvers<void>(),
  };
  return frame;
}

const PNG_HEADER = (() => {
  const header = Buffer.alloc(24);
  header.write("IHDR", 12);
  header.writeUInt32BE(1280, 16);
  header.writeUInt32BE(800, 20);
  return header.toString("base64");
})();

function makeSession(frame?: ReturnType<typeof makeFrame>) {
  const events = new NodeEvents.EventEmitter();
  return {
    on: vi.fn((name: string, listener: () => void) => events.on(name, listener)),
    emit: (name: string, ...args: unknown[]) => events.emit(name, ...args),
    detach: vi.fn(async () => {}),
    send: vi.fn(async (method: string, input?: unknown): Promise<Record<string, unknown>> => {
      if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{}] };
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0 } };
      if (method === "Page.captureScreenshot") {
        // A snapshot sizes its screenshot from the PNG header; viewers get JPEG frames as-is.
        return { data: (input as { format: string }).format === "png" ? PNG_HEADER : "ZnJhbWU=" };
      }
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      // Snapshots read password fields from their own isolated world in each frame.
      if (method === "Page.createIsolatedWorld") {
        return {
          executionContextId: (input as { worldName?: string }).worldName === "t3-preview" ? 1 : 7,
        };
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 1) {
        return { result: { value: [] } };
      }
      if (method === "Page.addScriptToEvaluateOnNewDocument") frame?.recording.resolve();
      if (method === "Input.dispatchKeyEvent" && (input as { commands?: unknown }).commands) {
        if (focusedFrame) focusedFrame.copy = keyCopy || focusedFrame.copy;
        else pageCopy = keyCopy || pageCopy;
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 7) {
        const value = frame ? frame.copy : pageCopy;
        if (frame) frame.copy = "";
        else pageCopy = "";
        return { result: { value } };
      }
      return { result: { value: "evaluated" } };
    }),
  };
}

function makeContext(onClose?: (context: BrowserContext) => void) {
  const events = new NodeEvents.EventEmitter();
  const nativeFileChooser = vi.fn();
  const setChooserFiles = vi.fn(async (_files: unknown) => {});
  const sessions: ReturnType<typeof makeSession>[] = [];
  let url = "about:blank";
  let viewport = { width: 1280, height: 800 };
  let closed = false;
  let contextClosed = false;
  const page = {
    on: (name: string, callback: (...args: unknown[]) => void) => events.on(name, callback),
    once: (name: string, callback: (...args: unknown[]) => void) => events.once(name, callback),
    off: (name: string, callback: (...args: unknown[]) => void) => events.off(name, callback),
    emit: (name: string, ...args: unknown[]) => events.emit(name, ...args),
    nativeFileChooser,
    setChooserFiles,
    openFileChooser: () => {
      if (
        !events.emit("filechooser", {
          isMultiple: () => false,
          element: () => ({ getAttribute: async () => ".csv" }),
          setFiles: setChooserFiles,
        })
      ) {
        nativeFileChooser();
      }
    },
    emitAsync: (name: string, ...args: unknown[]) =>
      Promise.all(events.listeners(name).map((listener) => listener(...args))),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    context: () => context,
    mainFrame: () => page,
    frames: () => [page],
    url: () => url,
    title: vi.fn(async () => "test page"),
    viewportSize: () => viewport,
    setViewportSize: vi.fn(async (size: typeof viewport) => {
      viewport = size;
    }),
    goto: vi.fn(async (next: string) => {
      url = next;
      events.emit("load");
      const pending = initialNavigation;
      initialNavigation = null;
      await pending?.();
    }),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    emulateMedia: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    evaluate: vi.fn(async (): Promise<unknown> => ({
      url,
      title: "test page",
      loading: false,
      visibleText: "delete",
      interactiveElements: [],
    })),
    ariaSnapshot: vi.fn(async () => '- button "delete" [ref=e1]'),
    locator: vi.fn(() => {
      throw new Error("Unexpected locator action");
    }),
    isClosed: () => closed,
    close: vi.fn(async () => {
      if (!closed) {
        closed = true;
        events.emit("close");
      }
    }),
  };
  const context = {
    page,
    sessions,
    newPage: async () => page as unknown as Page,
    grantPermissions: vi.fn(async () => {}),
    newCDPSession: async (target: unknown) => {
      const session = makeSession(
        target === page ? undefined : (target as ReturnType<typeof makeFrame>),
      );
      sessions.push(session);
      return session;
    },
    close: vi.fn(async () => {
      if (contextClosed) return;
      contextClosed = true;
      await page.close();
      onClose?.(context as unknown as BrowserContext);
    }),
  };
  return context;
}

const contexts: ReturnType<typeof makeContext>[] = [];
const scratchPages: ReturnType<typeof makeContext>["page"][] = [];
const contextRequests: Array<{ profileId: string; isolated: boolean }> = [];
let contextGate: PromiseWithResolvers<void> | null = null;
let pageCopy = "";
let keyCopy = "";
let focusedFrame: ReturnType<typeof makeFrame> | null = null;
let contextRequested: PromiseWithResolvers<void> | null = null;
let contextFailure: Error | null = null;
let initialNavigation: (() => Promise<void>) | null = null;
let desktopRendersNext = false;
let desktopAvailable = false;
let desktopAttachGate: PromiseWithResolvers<boolean> | null = null;
let desktopAttachStarted: PromiseWithResolvers<void> | null = null;
let desktopDetachConsumed: PromiseWithResolvers<void> | null = null;
const desktopAttachRequests: string[] = [];
/** Pages the fake desktop takes back or returns; the channel's streams emit them. */
const desktopDetaches = new NodeEvents.EventEmitter();
const desktopTabs = new Set<string>();
const desktopRenders = (tabId: string) => {
  if (desktopRendersNext) {
    desktopRendersNext = false;
    desktopTabs.add(tabId);
  }
  return desktopTabs.has(tabId);
};
const releasedDesktopTabs: Array<string> = [];
const desktopConnections: Array<{
  endpoint: string;
  context: ReturnType<typeof makeContext>;
}> = [];
const testThread = {
  threadId: ThreadId.make("browser-test-thread"),
  providerSessionId: "agent-a",
  providerInstanceId: ProviderInstanceId.make("codex"),
};
const scope = {
  environmentId: EnvironmentId.make("browser-test-environment"),
  thread: testThread,
  client: undefined,
  requestNamespace: "browser-test",
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const asSession = (providerSessionId: string) => ({
  ...scope,
  thread: { ...testThread, providerSessionId },
});
const dependencies = Layer.mergeAll(
  Broker.layer,
  Manager.layer,
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(scope.environmentId),
    getDescriptor: Effect.die("unused descriptor"),
  }),
  Layer.succeed(PreviewBrowser.PreviewBrowser, {
    executable: Effect.die("mock Chromium does not need an executable"),
    installed: Effect.die("mock Chromium does not need an executable"),
  }),
  Layer.succeed(DesktopChannel.DesktopBrowserChannel, {
    // Standalone tests have no desktop; native tests explicitly enable it.
    get available() {
      return desktopAvailable || desktopRendersNext || desktopTabs.size > 0;
    },
    awaitAttached: (key) =>
      Effect.promise(async () => {
        desktopAttachRequests.push(key.tabId);
        desktopAttachStarted?.resolve();
        return desktopAttachGate ? desktopAttachGate.promise : desktopRenders(key.tabId);
      }),
    detached: Stream.callback<{ threadId: string; tabId: string }>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const onDetach = (key: { threadId: string; tabId: string }) =>
            Queue.offerUnsafe(queue, key);
          desktopDetaches.on("detach", onDetach);
          return onDetach;
        }),
        (onDetach) => Effect.sync(() => desktopDetaches.off("detach", onDetach)),
      ),
    ).pipe(Stream.tap(() => Effect.sync(() => desktopDetachConsumed?.resolve()))),
    attached: Stream.callback<{ threadId: string; tabId: string }>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const onAttach = (key: { threadId: string; tabId: string }) =>
            Queue.offerUnsafe(queue, key);
          desktopDetaches.on("attach", onAttach);
          return onAttach;
        }),
        (onAttach) => Effect.sync(() => desktopDetaches.off("attach", onAttach)),
      ),
    ),
    isAttached: (key) => Effect.sync(() => desktopRenders(key.tabId)),
    endpoint: (key) =>
      Effect.acquireRelease(Effect.succeed(`ws://desktop/${key.tabId}`), () =>
        Effect.sync(() => releasedDesktopTabs.push(key.tabId)),
      ),
    pointer: () => Effect.void,
  }),
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-server-browser-" })),
  Layer.provideMerge(NodeServices.layer),
);
const layer = ServerBrowser.layer.pipe(Layer.provideMerge(dependencies));
const ready = Effect.gen(function* () {
  const browser = yield* ServerBrowser.ServerBrowser;
  const broker = yield* Broker.PreviewAutomationBroker;
  yield* Effect.yieldNow;
  const opened = yield* broker.invoke<PreviewAutomationStatus>({
    scope,
    operation: "open",
    input: { reuseExistingTab: false, show: false },
  });
  const tabId = PreviewTabId.make(opened.tabId!);
  return { browser, broker, tabId };
});
const stallViewer = (
  viewer: ServerBrowser.ServerBrowserViewer,
  item: ServerBrowser.ServerBrowserViewerOutput,
) => {
  const output = viewer.output as unknown as Queue.Queue<ServerBrowser.ServerBrowserViewerOutput>;
  while (Queue.offerUnsafe(output, item));
};
const viewerInput = (tabId: string, canOperate: boolean) => ({
  threadId: scope.thread.threadId,
  tabId,
  canOperate,
  maxWidth: 1280,
  maxHeight: 800,
  quality: 70,
});

beforeEach(() => {
  contexts.length = 0;
  scratchPages.length = 0;
  contextRequests.length = 0;
  contextGate = null;
  contextRequested = null;
  contextFailure = null;
  initialNavigation = null;
  pageCopy = "";
  keyCopy = "";
  focusedFrame = null;
  desktopTabs.clear();
  desktopRendersNext = false;
  desktopAvailable = false;
  desktopAttachGate = null;
  desktopAttachStarted = null;
  desktopDetachConsumed = null;
  desktopAttachRequests.length = 0;
  releasedDesktopTabs.length = 0;
  desktopConnections.length = 0;
});

it.live.each(["desktop" as const, undefined])(
  "explicit desktop targets ($0 runtime) fail without creating a server tab",
  (runtime) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const manager = yield* Manager.PreviewManager;
        const desktop = yield* manager.open({
          threadId: scope.thread.threadId,
          url: "https://example.com/original",
          ...(runtime === undefined ? {} : { runtime }),
        });
        const before = yield* manager.list({ threadId: scope.thread.threadId });
        const error = yield* broker
          .invoke<PreviewAutomationStatus>({
            scope,
            tabId: PreviewTabId.make(desktop.tabId),
            operation: "open",
            input: { url: "https://example.com/replacement", open: true },
          })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "PreviewAutomationExecutionError" });
        expect(error.message).toContain("desktop runtime");
        expect(error.message).toContain("cannot control");
        expect(yield* manager.list({ threadId: scope.thread.threadId })).toEqual(before);
        expect(contexts).toHaveLength(1);
        // A rejected explicit target must not replace this session's working tab.
        const reused = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { open: false },
        });
        expect(reused.tabId).toBe(tabId);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each([
  { method: "goto" as const, message: { type: "navigate", url: "http://10.255.255.1/" } },
  { method: "goBack" as const, message: { type: "history", delta: -1 } },
  { method: "goForward" as const, message: { type: "history", delta: 1 } },
  { method: "reload" as const, message: { type: "reload" } },
])("a pending viewer $method allows a corrected URL and text input", ({ method, message }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const started = Promise.withResolvers<void>();
      const committed = Promise.withResolvers<void>();
      const page = contexts[0]!.page;
      page[method].mockImplementationOnce(() => {
        started.resolve();
        return committed.promise;
      });
      const navigation = yield* viewer.input(message).pipe(Effect.forkScoped);
      yield* Effect.promise(() => started.promise);
      const cdp = contexts[0]!.sessions.at(-1)!;
      const send = cdp.send.getMockImplementation()!;
      const typed = Promise.withResolvers<void>();
      cdp.send.mockImplementation(async (operation, input) => {
        if (operation === "Input.insertText") typed.resolve();
        return send(operation, input);
      });
      const correction = yield* Effect.gen(function* () {
        yield* viewer.input({ type: "navigate", url: "http://localhost:5173/fixed" });
        yield* viewer.input({ type: "text", text: "hello" });
      }).pipe(Effect.forkScoped);
      yield* Effect.addFinalizer(() => Effect.sync(() => committed.resolve()));
      // The text reaches the page while the first navigation is still uncommitted.
      yield* Effect.promise(() => typed.promise);
      expect(page.goto).toHaveBeenLastCalledWith(
        "http://localhost:5173/fixed",
        expect.objectContaining({ waitUntil: "commit" }),
      );
      expect(contexts[0]!.sessions.at(-1)!.send).toHaveBeenCalledWith("Input.insertText", {
        text: "hello",
      });
      committed.resolve();
      yield* Fiber.join(navigation);
      yield* Fiber.join(correction);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("enforces provider ownership and explicit targets when a session has multiple tabs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const foreign = yield* broker
        .invoke<void>({
          scope: asSession("agent-b"),
          tabId,
          operation: "navigate",
          input: { url: "http://localhost:5173/foreign" },
        })
        .pipe(Effect.flip);
      expect(foreign).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "agentMismatch",
      });
      expect(contexts[0]!.page.goto).not.toHaveBeenCalledWith(
        "http://localhost:5173/foreign",
        expect.anything(),
      );
      yield* broker.invoke<PreviewAutomationSnapshot>({
        scope: asSession("agent-b"),
        tabId,
        operation: "snapshot",
        input: {},
      });
      const foreignEvaluate = yield* broker
        .invoke<void>({
          scope: asSession("agent-b"),
          tabId,
          operation: "evaluate",
          input: { expression: "read()" },
        })
        .pipe(Effect.flip);
      expect(foreignEvaluate).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "agentMismatch",
      });
      yield* broker.invoke({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const ambiguous = yield* broker
        .invoke<void>({ scope, operation: "evaluate", input: { expression: "ambiguous()" } })
        .pipe(Effect.flip);
      expect(ambiguous).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "tabRequired",
      });
      const ambiguousStop = yield* broker
        .invoke<void>({ scope, operation: "recordingStop", input: {} })
        .pipe(Effect.flip);
      expect(ambiguousStop).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "tabRequired",
      });
      const explicitStop = yield* broker
        .invoke<void>({ scope, tabId, operation: "recordingStop", input: {} })
        .pipe(Effect.flip);
      expect(explicitStop).toMatchObject({
        _tag: "PreviewAutomationExecutionError",
        cause: { _tag: "PreviewAutomationRecordingNotActiveError" },
      });
      const result = yield* broker.invoke({
        scope,
        tabId,
        operation: "evaluate",
        input: { expression: "owned()" },
      });
      expect(result).toBe("evaluated");
      expect(contexts).toHaveLength(2);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("streams to a read-only viewer without allowing takeover, input, or viewport changes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, false));
      const page = contexts[0]!.page;
      page.setViewportSize.mockClear();
      const session = contexts[0]!.sessions.at(-1)!;
      session.send.mockClear();
      for (const message of [
        { type: "takeControl" },
        { type: "key", action: "down", key: "a", text: "a" },
        { type: "resize", width: 390, height: 844 },
        { type: "viewport", setting: { _tag: "freeform", width: 390, height: 844 } },
      ])
        yield* viewer.input(message);
      expect(page.setViewportSize).not.toHaveBeenCalled();
      expect(session.send.mock.calls.some(([method]) => method.startsWith("Input."))).toBe(false);
      const outputs = yield* Queue.takeAll(viewer.output);
      expect(outputs).toContainEqual(
        expect.objectContaining({ _tag: "frame", data: Buffer.from("frame") }),
      );
      expect(outputs).toContainEqual(expect.objectContaining({ _tag: "viewport" }));
      expect(outputs).toContainEqual(
        expect.objectContaining({ _tag: "control", canOperate: false, controller: "agent" }),
      );
      const operator = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* operator.input({ type: "takeControl" });
      yield* operator.input({ type: "text", text: "typed" });
      yield* operator.input({ type: "resize", width: 390, height: 844 });
      expect(contexts[0]!.sessions.at(-1)!.send).toHaveBeenCalledWith("Input.insertText", {
        text: "typed",
      });
      expect(page.setViewportSize).toHaveBeenCalledWith({ width: 390, height: 844 });
      yield* operator.input({ type: "releaseControl" });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "takeover waits for the running agent and revokes snapshot refs before returning control",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
        const snapshot = yield* broker.invoke<PreviewAutomationSnapshot>({
          scope,
          tabId,
          operation: "snapshot",
          input: {},
        });
        const ref = /\[ref=([^\]]+)\]/.exec(String(snapshot.accessibilityTree))![1]!;
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        const started = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<Record<string, unknown>>();
        const session = contexts[0]!.sessions[0]!;
        session.send.mockImplementationOnce(async () => {
          started.resolve();
          return finish.promise;
        });
        const running = yield* broker
          .invoke({ scope, tabId, operation: "evaluate", input: { expression: "pending()" } })
          .pipe(Effect.forkScoped);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => finish.resolve({ result: { value: "finished" } })),
        );
        yield* Effect.promise(() => started.promise);
        const takeover = yield* viewer.input({ type: "takeControl" }).pipe(Effect.forkScoped);
        let control = yield* Queue.take(viewer.output);
        while (control._tag !== "control" || control.controller !== "you") {
          control = yield* Queue.take(viewer.output);
        }
        const rejected = yield* broker
          .invoke<void>({ scope, tabId, operation: "evaluate", input: { expression: "racing()" } })
          .pipe(Effect.flip);
        expect(rejected).toMatchObject({
          _tag: "PreviewAutomationControlInterruptedError",
          reason: "humanControl",
        });
        finish.resolve({ result: { value: "finished" } });
        expect(yield* Fiber.join(running)).toBe("finished");
        yield* Fiber.join(takeover);
        yield* viewer.input({ type: "releaseControl" });
        const stale = yield* broker
          .invoke<void>({ scope, tabId, operation: "click", input: { locator: `aria-ref=${ref}` } })
          .pipe(Effect.flip);
        expect(stale._tag).toBe("PreviewAutomationInvalidSelectorError");
        expect(contexts[0]!.page.locator).not.toHaveBeenCalled();
        expect(
          yield* broker.invoke({
            scope,
            tabId,
            operation: "evaluate",
            input: { expression: "resumed()" },
          }),
        ).toBe("evaluated");
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("reports a pending dialog without evaluating the page and resolves it explicitly", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      yield* broker.invoke({
        scope,
        tabId,
        operation: "navigate",
        input: { url: "http://localhost:5173" },
      });
      const started = Promise.withResolvers<void>();
      const resolvedEvaluation = Promise.withResolvers<Record<string, unknown>>();
      const session = contexts[0]!.sessions[0]!;
      const send = session.send.getMockImplementation()!;
      session.send.mockImplementation(async (method, input) => {
        if (method !== "Runtime.evaluate") return send(method, input);
        started.resolve();
        return resolvedEvaluation.promise;
      });
      const blockedAction = yield* broker
        .invoke({
          scope,
          tabId,
          operation: "evaluate",
          input: { expression: 'confirm("Delete row?")' },
        })
        .pipe(Effect.forkScoped);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => resolvedEvaluation.resolve({ result: { value: true } })),
      );
      yield* Effect.promise(() => started.promise);
      const dialog = {
        type: () => "confirm",
        message: () => "Delete row?",
        defaultValue: () => "",
        accept: vi.fn(async () => {
          resolvedEvaluation.resolve({ result: { value: true } });
        }),
        dismiss: vi.fn(async () => {}),
      };
      page.emit("dialog", dialog);
      page.title.mockClear();
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.dialog).toMatchObject({ type: "confirm", message: "Delete row?" });
      expect(page.title).not.toHaveBeenCalled();
      expect(dialog.dismiss).not.toHaveBeenCalled();
      const reuse = yield* broker
        .invoke<void>({
          scope,
          tabId,
          operation: "open",
          input: { url: "http://localhost:5173/other" },
        })
        .pipe(Effect.flip);
      expect(reuse).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "dialogPending",
      });
      expect(page.goto).toHaveBeenCalledTimes(1);
      yield* broker.invoke({ scope, tabId, operation: "dialog", input: { accept: true } });
      expect(yield* Fiber.join(blockedAction)).toBe(true);
      expect(dialog.accept).toHaveBeenCalledTimes(1);
      const resolved = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(resolved.dialog).toBeNull();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a tab opened to a file the browser cannot show reports the file to download", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      const events = yield* manager.subscribeEvents;
      yield* Effect.yieldNow;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      const viewer = yield* browser.attachViewer(viewerInput(opened.tabId, true));
      const page = contexts[0]!.page;
      const pdf = "https://example.com/paper.pdf";
      const request = { url: () => pdf, method: () => "GET", isNavigationRequest: () => true };
      // What Chromium reports when a navigation turns into a download.
      page.emit("requestfailed", {
        ...request,
        frame: () => page,
        failure: () => ({ errorText: "net::ERR_ABORTED" }),
      });
      const saved = yield* Queue.unbounded<string>();
      const written = Promise.withResolvers<void>();
      page.emit("download", {
        failure: async () => null,
        delete: async () => {
          // A new navigation during cleanup must not erase the settled download status.
          page.emit("request", {
            url: () => "https://example.com/next",
            method: () => "GET",
            isNavigationRequest: () => true,
            frame: () => page,
          });
        },
        saveAs: (path: string) => {
          Queue.offerUnsafe(saved, path);
          return written.promise;
        },
        suggestedFilename: () => "paper.pdf",
        url: () => pdf,
      });
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(yield* Queue.take(saved), "%PDF");
      written.resolve();
      const received = [];
      let status;
      do {
        status = yield* PubSub.take(events);
        received.push(status);
      } while (
        status.type !== "navigated" ||
        status.snapshot.navStatus._tag !== "Loading" ||
        status.snapshot.navStatus.url !== "https://example.com/next"
      );
      expect(received).toContainEqual(
        expect.objectContaining({
          type: "failed",
          url: pdf,
          download: { id: expect.any(String), fileName: "paper.pdf" },
        }),
      );
      expect((yield* Queue.clear(viewer.output)).some((item) => item._tag === "download")).toBe(
        false,
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "a late failure from a request that predates tracking leaves a newer navigation loading",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const page = contexts[0]!.page;
        const navigation = (url: string) => ({
          url: () => url,
          method: () => "GET",
          isNavigationRequest: () => true,
          frame: () => page,
          failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }),
        });
        page.emit("request", navigation("https://example.com/next"));
        // A popup's first request can start before the tab listens for requests.
        page.emit("requestfailed", navigation("https://example.com/first"));
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(status.loading).toBe(true);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("a popup closed before adoption does not leave its page behind", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const events = yield* manager.subscribeEvents;
      const reading = Promise.withResolvers<void>();
      const read = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      const list = manager.list;
      const spy = vi.spyOn(manager, "list").mockImplementationOnce((input) =>
        Effect.promise(async () => {
          reading.resolve();
          await read.promise;
        }).pipe(Effect.andThen(list(input))),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          read.resolve();
          spy.mockRestore();
        }),
      );
      const popup = makeContext();
      popup.page.once("close", () => closed.resolve());
      contexts[0]!.page.emit("popup", popup.page);
      yield* Effect.promise(() => reading.promise);
      const opened = yield* PubSub.take(events);
      expect(opened.type).toBe("opened");
      yield* manager.close({ threadId: scope.thread.threadId, tabId: opened.tabId });
      read.resolve();
      yield* Effect.promise(() => closed.promise);
      expect(popup.page.isClosed()).toBe(true);
      expect(contexts[0]!.page.isClosed()).toBe(false);
      expect(
        (yield* manager.list({ threadId: scope.thread.threadId })).sessions.map(
          (session) => session.tabId,
        ),
      ).toEqual([tabId]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("only the controlling viewer's copy and cut keys reach its clipboard", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const watcher = yield* browser.attachViewer(viewerInput(tabId, false));
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const clipboard = (queue: typeof viewer.output) =>
        Queue.clear(queue).pipe(
          Effect.map((items) => items.filter((item) => item._tag === "clipboard")),
        );
      pageCopy = "unprompted";
      yield* viewer.input({ type: "mouse", action: "move", x: 10, y: 10 });
      yield* viewer.input({ type: "wheel", x: 10, y: 10, deltaY: 40 });
      yield* viewer.input({ type: "key", action: "down", key: "v", code: "KeyV", modifiers: 4 });
      yield* viewer.input({ type: "unknown" });
      expect(yield* clipboard(viewer.output)).toEqual([]);
      keyCopy = "copied";
      yield* viewer.input({ type: "key", action: "down", key: "c", code: "KeyC", modifiers: 4 });
      const cdp = contexts[0]!.sessions.at(-1)!;
      expect(cdp.send).toHaveBeenCalledWith(
        "Input.dispatchKeyEvent",
        expect.objectContaining({ key: "c", commands: ["copy"] }),
      );
      expect(yield* clipboard(viewer.output)).toEqual([{ _tag: "clipboard", text: "copied" }]);
      keyCopy = "cut";
      yield* viewer.input({ type: "key", action: "down", key: "x", code: "KeyX", modifiers: 2 });
      expect(yield* clipboard(viewer.output)).toEqual([{ _tag: "clipboard", text: "cut" }]);
      pageCopy = "left over";
      keyCopy = "";
      yield* viewer.input({ type: "key", action: "down", key: "c", code: "KeyC", modifiers: 4 });
      expect(yield* clipboard(viewer.output)).toEqual([]);
      expect(yield* clipboard(watcher.output)).toEqual([]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each([false, true])(
  "a page download is saved, offered to the controller, and listed for the agent (delete fails: %s)",
  (deleteFails) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
        const page = contexts[0]!.page;
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        yield* viewer.input({ type: "takeControl" });
        yield* Queue.clear(viewer.output);
        const fs = yield* FileSystem.FileSystem;
        const original = `${yield* fs.makeTempDirectoryScoped()}/chromium-download`;
        yield* fs.writeFileString(original, "a,b");
        const released = Promise.withResolvers<void>();
        page.emit("download", {
          failure: async () => null,
          delete: async () => {
            try {
              if (deleteFails) throw new Error("context closed");
              await NodeFSP.rm(original);
            } finally {
              released.resolve();
            }
          },
          saveAs: (path: string) => NodeFSP.copyFile(original, path),
          suggestedFilename: () => "report.csv",
          url: () => 'data:text/csv;charset="a,b",a b\'c',
        });
        let offered = yield* Queue.take(viewer.output);
        while (offered._tag !== "download") offered = yield* Queue.take(viewer.output);
        expect(offered).toMatchObject({ _tag: "download", fileName: "report.csv", sizeBytes: 3 });
        yield* Effect.promise(() => released.promise);
        expect(yield* fs.exists(original)).toBe(deleteFails);
        const file = yield* browser.openDownload({
          threadId: scope.thread.threadId,
          tabId,
          downloadId: offered.id,
        });
        expect(Option.isSome(file) && file.value.fileName).toBe("report.csv");
        expect(yield* fs.readFileString(Option.getOrThrow(file).path)).toBe("a,b");
        if ((yield* HostProcess.Platform) !== "win32") {
          expect((yield* fs.stat(Option.getOrThrow(file).path)).mode & 0o777).toBe(0o600);
        }
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(status.downloads).toEqual([
          expect.objectContaining({
            fileName: "report.csv",
            sizeBytes: 3,
            url: "data:text/csv,…",
          }),
        ]);
        expect(
          Option.isNone(
            yield* browser.openDownload({
              threadId: scope.thread.threadId,
              tabId,
              downloadId: "guess",
            }),
          ),
        ).toBe(true);
        if ((yield* HostProcess.Platform) !== "win32") {
          const folder = (yield* Path.Path).dirname(Option.getOrThrow(file).path);
          yield* fs.chmod(folder, 0o755);
          page.emit("download", {
            failure: async () => null,
            delete: async () => {},
            saveAs: (path: string) => NodeFSP.writeFile(path, "c"),
            suggestedFilename: () => "again.csv",
            url: () => "https://example.test/again.csv",
          });
          let again = yield* Queue.take(viewer.output);
          while (again._tag !== "download") again = yield* Queue.take(viewer.output);
          expect((yield* fs.stat(folder)).mode & 0o777).toBe(0o700);
        }
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each(["save failed", "oversized"])(
  "a rejected download releases the original and keeps no saved copy (%s)",
  (outcome) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const fs = yield* FileSystem.FileSystem;
        const original = `${yield* fs.makeTempDirectoryScoped()}/chromium-download`;
        yield* fs.writeFileString(original, "a,b");
        let savedPath: string | undefined;
        const released = Promise.withResolvers<void>();
        contexts[0]!.page.emit("download", {
          failure: async () => null,
          delete: async () => {
            await NodeFSP.rm(original);
            released.resolve();
          },
          saveAs: async (path: string) => {
            savedPath = path;
            await NodeFSP.copyFile(original, path);
            if (outcome === "save failed") throw new Error("save interrupted");
            // A sparse file exercises the size limit without writing a GiB of data.
            await NodeFSP.truncate(path, 1024 ** 3 + 1);
          },
          suggestedFilename: () => "report.csv",
          url: () => "blob:http://localhost:5173/1",
        });
        yield* Effect.promise(() => released.promise);
        expect(yield* fs.exists(original)).toBe(false);
        if (savedPath !== undefined) expect(yield* fs.exists(savedPath)).toBe(false);
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(status.downloads).toEqual([]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("a page's file picker goes to the controller and takes its uploaded files", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const setFiles = vi.fn(async (_files: unknown) => {});
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({ getAttribute: async () => ".csv" }),
        setFiles,
      });
      let offered = yield* Queue.take(viewer.output);
      while (offered._tag !== "fileChooser") offered = yield* Queue.take(viewer.output);
      expect(offered).toMatchObject({ multiple: false, accept: ".csv" });
      const file = (name: string) => ({ name, mimeType: "text/csv", buffer: Buffer.from(name) });
      const answer = (chooserId: string) =>
        browser.answerFileChooser({
          threadId: scope.thread.threadId,
          tabId,
          chooserId,
          files: [file("a.csv"), file("b.csv")],
        });
      expect(yield* answer("other")).toBe(false);
      expect(yield* answer(offered.id)).toBe(true);
      expect(setFiles).toHaveBeenCalledExactlyOnceWith([file("a.csv")]);
      let closed = yield* Queue.take(viewer.output);
      while (closed._tag !== "fileChooserClosed") closed = yield* Queue.take(viewer.output);
      expect(closed.id).toBe(offered.id);
      expect(yield* answer(offered.id)).toBe(false);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("only the current controller can answer a file picker", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const first = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* first.input({ type: "takeControl" });
      const setFiles = vi.fn(async (_files: unknown) => {});
      contexts[0]!.page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({ getAttribute: async () => "" }),
        setFiles,
      });
      let offered = yield* Queue.take(first.output);
      while (offered._tag !== "fileChooser") offered = yield* Queue.take(first.output);
      const second = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* first.input({ type: "releaseControl" });
      yield* second.input({ type: "takeControl" });
      const answered = yield* browser.answerFileChooser({
        threadId: scope.thread.threadId,
        tabId,
        chooserId: offered.id,
        files: [{ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") }],
      });
      expect(answered).toBe(false);
      expect(setFiles).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "publishes a headless fallback before launch and keeps the same page after late native events",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* ServerBrowser.ServerBrowser;
        const broker = yield* Broker.PreviewAutomationBroker;
        const manager = yield* Manager.PreviewManager;
        const events = yield* manager.subscribeEvents;
        yield* Effect.yieldNow;
        desktopAvailable = true;
        const launching = Promise.withResolvers<void>();
        const launch = Promise.withResolvers<void>();
        contextRequested = launching;
        contextGate = launch;
        yield* Effect.addFinalizer(() => Effect.sync(() => launch.resolve()));
        const opening = yield* broker
          .invoke<PreviewAutomationStatus>({
            scope,
            operation: "open",
            input: { url: "http://localhost:5173/fallback", reuseExistingTab: false, show: false },
          })
          .pipe(Effect.forkScoped);
        yield* Effect.promise(() => launching.promise);
        const listed = yield* manager.list({ threadId: scope.thread.threadId });
        const snapshot = listed.sessions[0]!;
        expect(snapshot.serverPageMode).toBe("headless");
        expect(contexts).toEqual([]);
        expect(
          (yield* PubSub.takeUpTo(events, 10)).map((event) => ({
            type: event.type,
            mode: "snapshot" in event ? event.snapshot.serverPageMode : undefined,
          })),
        ).toEqual([
          { type: "opened", mode: undefined },
          { type: "resized", mode: "headless" },
        ]);
        // A native guest arriving while headless is still launching must not become another page.
        const queried = Promise.withResolvers<void>();
        const list = manager.list;
        const spy = vi
          .spyOn(manager, "list")
          .mockImplementation((input) =>
            list(input).pipe(Effect.tap(() => Effect.sync(() => queried.resolve()))),
          );
        yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
        desktopTabs.add(snapshot.tabId);
        desktopDetaches.emit("attach", { threadId: scope.thread.threadId, tabId: snapshot.tabId });
        yield* Effect.promise(() => queried.promise);
        launch.resolve();
        const opened = yield* Fiber.join(opening);
        expect(opened).toMatchObject({
          available: true,
          tabId: snapshot.tabId,
          url: "http://localhost:5173/fallback",
        });
        expect(contexts).toHaveLength(1);
        expect(contexts[0]!.page.goto).toHaveBeenCalledOnce();
        expect(desktopConnections).toEqual([]);
        const viewer = yield* browser.attachViewer(viewerInput(snapshot.tabId, false));
        expect((yield* Queue.clear(viewer.output)).some((item) => item._tag === "frame")).toBe(
          true,
        );
        const consumed = Promise.withResolvers<void>();
        desktopDetachConsumed = consumed;
        desktopTabs.delete(snapshot.tabId);
        desktopDetaches.emit("detach", { threadId: scope.thread.threadId, tabId: snapshot.tabId });
        yield* Effect.promise(() => consumed.promise);
        expect(
          yield* broker.invoke({
            scope,
            tabId: PreviewTabId.make(snapshot.tabId),
            operation: "evaluate",
            input: { expression: "42" },
          }),
        ).toBe("evaluated");
        expect(contexts[0]!.page.close).not.toHaveBeenCalled();
        expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toHaveLength(1);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live(
  "a chosen headless page stays headless when its failed launch is retried after native attachment",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* ServerBrowser.ServerBrowser;
        const broker = yield* Broker.PreviewAutomationBroker;
        const manager = yield* Manager.PreviewManager;
        yield* Effect.yieldNow;
        desktopAvailable = true;
        contextFailure = new Error("launch failed");
        yield* broker
          .invoke<PreviewAutomationStatus>({
            scope,
            operation: "open",
            input: { reuseExistingTab: false, show: false },
          })
          .pipe(Effect.flip);
        const snapshot = (yield* manager.list({ threadId: scope.thread.threadId })).sessions[0]!;
        expect(snapshot.serverPageMode).toBe("headless");
        contextFailure = null;
        desktopTabs.add(snapshot.tabId);
        const viewer = yield* browser.attachViewer(viewerInput(snapshot.tabId, false));
        expect((yield* Queue.clear(viewer.output)).some((item) => item._tag === "frame")).toBe(
          true,
        );
        expect(desktopConnections).toEqual([]);
        expect(contexts).toHaveLength(1);
        expect(desktopAttachRequests).toEqual([snapshot.tabId]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("closing a tab during its native wait prevents a headless fallback", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* Broker.PreviewAutomationBroker;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      desktopAvailable = true;
      const waiting = Promise.withResolvers<void>();
      const attached = Promise.withResolvers<boolean>();
      desktopAttachStarted = waiting;
      desktopAttachGate = attached;
      yield* Effect.addFinalizer(() => Effect.sync(() => attached.resolve(false)));
      const opening = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.promise(() => waiting.promise);
      const snapshot = (yield* manager.list({ threadId: scope.thread.threadId })).sessions[0]!;
      yield* manager.close({ threadId: scope.thread.threadId, tabId: snapshot.tabId });
      attached.resolve(false);
      yield* Fiber.join(opening);
      expect(contextRequests).toEqual([]);
      expect(contexts).toEqual([]);
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toEqual([]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "closing a tab while headless launches discards its page and prevents late native resurrection",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* Broker.PreviewAutomationBroker;
        const manager = yield* Manager.PreviewManager;
        yield* Effect.yieldNow;
        desktopAvailable = true;
        const launching = Promise.withResolvers<void>();
        const launch = Promise.withResolvers<void>();
        contextRequested = launching;
        contextGate = launch;
        yield* Effect.addFinalizer(() => Effect.sync(() => launch.resolve()));
        const opening = yield* broker
          .invoke<PreviewAutomationStatus>({
            scope,
            operation: "open",
            input: { reuseExistingTab: false, show: false },
          })
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Effect.promise(() => launching.promise);
        const snapshot = (yield* manager.list({ threadId: scope.thread.threadId })).sessions[0]!;
        yield* manager.close({ threadId: scope.thread.threadId, tabId: snapshot.tabId });
        launch.resolve();
        yield* Fiber.join(opening);
        expect(contexts[0]!.page.isClosed()).toBe(true);
        expect(contexts[0]!.close).toHaveBeenCalledOnce();
        expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toEqual([]);
        const queried = Promise.withResolvers<void>();
        const list = manager.list;
        const spy = vi
          .spyOn(manager, "list")
          .mockImplementation((input) =>
            list(input).pipe(Effect.tap(() => Effect.sync(() => queried.resolve()))),
          );
        yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
        desktopTabs.add(snapshot.tabId);
        desktopDetaches.emit("attach", { threadId: scope.thread.threadId, tabId: snapshot.tabId });
        yield* Effect.promise(() => queried.promise);
        expect(desktopConnections).toEqual([]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("headless fallbacks count toward both tab limits and free capacity when closed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* Broker.PreviewAutomationBroker;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      desktopAvailable = true;
      const open = (agent: string) =>
        broker.invoke<PreviewAutomationStatus>({
          scope: asSession(agent),
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        });
      let first: PreviewAutomationStatus | undefined;
      for (let agent = 0; agent < 4; agent++) {
        for (let count = 0; count < 8; count++) {
          const opened = yield* open(`agent-${agent}`);
          first ??= opened;
        }
        expect(yield* open(`agent-${agent}`).pipe(Effect.flip)).toMatchObject({
          reason: "tabLimit",
        });
      }
      expect(yield* open("another-agent").pipe(Effect.flip)).toMatchObject({ reason: "tabLimit" });
      expect(contexts).toHaveLength(32);
      expect(
        (yield* manager.list({ threadId: scope.thread.threadId })).sessions.every(
          (session) => session.serverPageMode === "headless",
        ),
      ).toBe(true);
      desktopTabs.add(first!.tabId!);
      desktopDetaches.emit("attach", { threadId: scope.thread.threadId, tabId: first!.tabId! });
      yield* broker.invoke({
        scope: asSession("agent-0"),
        tabId: PreviewTabId.make(first!.tabId!),
        operation: "close",
        input: {},
      });
      expect((yield* open("another-agent")).available).toBe(true);
      expect(desktopConnections).toEqual([]);
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toHaveLength(32);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a standalone server still opens a headless page when no desktop channel exists", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      expect(desktopAvailable).toBe(false);
      expect(contexts).toHaveLength(1);
      expect(desktopConnections).toEqual([]);
      expect(
        yield* broker.invoke({ scope, tabId, operation: "evaluate", input: { expression: "42" } }),
      ).toBe("evaluated");
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("agents read a human's tab with no arguments and act on it only while nobody drives", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const broker = yield* Broker.PreviewAutomationBroker;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      const opened = yield* manager.open({
        threadId: scope.thread.threadId,
        url: "http://localhost:5173/mine",
        runtime: "server",
      });
      const tabId = PreviewTabId.make(opened.tabId);
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "status",
        input: {},
      });
      expect(status).toMatchObject({
        tabId,
        control: { owner: "human", ownedByCaller: false },
      });
      expect(status.tabs).toEqual([
        expect.objectContaining({ tabId, owner: "human", ownedByCaller: false, visible: true }),
      ]);
      const evaluated = yield* broker
        .invoke<void>({ scope, operation: "evaluate", input: { expression: "read()" } })
        .pipe(Effect.flip);
      expect(evaluated).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "humanControl",
      });
      yield* broker.invoke<PreviewAutomationSnapshot>({
        scope,
        tabId,
        operation: "snapshot",
        input: {},
      });
      const refused = yield* broker
        .invoke<void>({
          scope,
          tabId,
          operation: "navigate",
          input: { url: "http://localhost:5173/agent" },
        })
        .pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "humanControl",
      });
      yield* viewer.input({ type: "releaseControl" });
      const released = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(released.control).toMatchObject({ owner: "unclaimed", ownedByCaller: false });
      yield* broker.invoke({
        scope,
        tabId,
        operation: "navigate",
        input: { url: "http://localhost:5173/agent" },
      });
      expect(contexts[0]!.page.goto).toHaveBeenCalledWith(
        "http://localhost:5173/agent",
        expect.anything(),
      );
      yield* viewer.input({ type: "takeControl" });
      const retaken = yield* broker
        .invoke<void>({ scope, tabId, operation: "press", input: { key: "Enter" } })
        .pipe(Effect.flip);
      expect(retaken).toMatchObject({ reason: "humanControl" });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a session's own tab stays its default while other sessions' tabs are listed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const other = yield* broker.invoke<PreviewAutomationStatus>({
        scope: asSession("agent-b"),
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "status",
        input: {},
      });
      expect(status.tabId).toBe(tabId);
      expect(status.tabs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tabId, owner: "agent", ownedByCaller: true }),
          expect.objectContaining({ tabId: other.tabId, owner: "agent", ownedByCaller: false }),
        ]),
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "preview_open picks a reported profile by id or name and defaults to the reported one",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* ServerBrowser.ServerBrowser;
        const broker = yield* Broker.PreviewAutomationBroker;
        const manager = yield* Manager.PreviewManager;
        yield* Effect.yieldNow;
        yield* browser.reportProfiles({
          profiles: [{ id: "profile-work", name: "Work", kind: "persistent" }],
          defaultProfileId: "profile-work",
        });
        const openWith = (profileId?: string) =>
          broker.invoke<PreviewAutomationStatus>({
            scope,
            operation: "open",
            input: {
              reuseExistingTab: false,
              show: false,
              ...(profileId === undefined ? {} : { profileId }),
            },
          });
        const byDefault = yield* openWith();
        const byName = yield* openWith("WORK");
        const byId = yield* openWith("incognito");
        const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
        const profileOf = (tabId: string | null) =>
          sessions.find((session) => session.tabId === tabId)?.profileId;
        expect(profileOf(byDefault.tabId)).toBe("profile-work");
        expect(profileOf(byName.tabId)).toBe("profile-work");
        expect(profileOf(byId.tabId)).toBe("incognito");
        expect(contextRequests).toEqual([
          { profileId: "profile-work", isolated: false },
          { profileId: "profile-work", isolated: false },
          { profileId: "incognito", isolated: true },
        ]);
        expect(byDefault).toMatchObject({
          defaultProfileId: "profile-work",
          profiles: [
            { id: "default", name: "Default" },
            { id: "incognito", name: "Incognito", incognito: true },
            { id: "profile-work", name: "Work" },
          ],
        });
        const unknown = yield* openWith("Personal").pipe(Effect.flip);
        expect(unknown).toMatchObject({
          _tag: "PreviewAutomationExecutionError",
          reason:
            'No browser profile is named "Personal". Use one of: Default (id default), Incognito (id incognito), Work (id profile-work).',
        });
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each(["wait", "pause", "capture", "resume"] as const)(
  "a stalled snapshot %s releases the tab queue and capture lock without leaking a paused viewer",
  (stage) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
        const viewer = yield* browser.attachViewer(viewerInput(tabId, stage === "wait"));
        if (stage === "wait") {
          yield* viewer.input({ type: "takeControl" });
          yield* viewer.input({ type: "key", action: "down", key: "Shift", code: "ShiftLeft" });
          yield* viewer.input({ type: "mouse", action: "down", button: "left", x: 10, y: 20 });
        }
        // Recovery must reach a viewer even when its output queue is full.
        stallViewer(viewer, { _tag: "viewport", width: 1280, height: 800 });
        const { page, sessions } = contexts[0]!;
        const session = sessions.at(-1)!;
        const blocked = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const send = session.send.getMockImplementation()!;
        let streaming = true;
        let stalled = false;
        session.send.mockImplementation(async (method, input) => {
          if (
            !stalled &&
            ((stage === "wait" && method === "Page.captureScreenshot") ||
              (stage === "pause" && method === "Page.stopScreencast") ||
              (stage === "resume" && method === "Page.startScreencast"))
          ) {
            stalled = true;
            blocked.resolve();
            if (stage !== "wait") await release.promise;
          }
          if (stalled && stage === "wait") await release.promise;
          const result = await send(method, input);
          if (method === "Page.stopScreencast") streaming = false;
          if (method === "Page.startScreencast") streaming = true;
          return result;
        });
        const cdp = sessions[0]!;
        if (stage === "wait") {
          session.detach.mockImplementation(() => release.promise);
          const tabSend = cdp.send.getMockImplementation()!;
          cdp.send.mockImplementation(async (method, input) => {
            const result = await tabSend(method, input);
            if (method.startsWith("Input.dispatch")) await release.promise;
            return result;
          });
        }
        if (stage === "capture") {
          page.ariaSnapshot.mockImplementationOnce(async () => {
            blocked.resolve();
            await release.promise;
            return '- button "delete" [ref=e1]';
          });
        }
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            release.resolve();
            vi.useRealTimers();
          }),
        );
        if (stage === "wait") {
          session.emit("Page.screencastFrame", { data: "ZnJhbWU=", sessionId: 1 });
          session.emit("Page.screencastFrame", { data: "ZnJhbWU=", sessionId: 2 });
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(200));
          yield* Effect.promise(() => blocked.promise);
        }
        const snapshot = yield* broker
          .invoke<PreviewAutomationSnapshot>({
            // A different agent can observe while the viewer controls the owning agent's tab.
            scope: stage === "wait" ? asSession("agent-b") : scope,
            tabId,
            operation: "snapshot",
            input: {},
          })
          .pipe(Effect.flip, Effect.forkScoped({ startImmediately: true }));
        yield* Effect.promise(() => blocked.promise);
        // The host must answer within the action budget, before the broker timeout.
        if (stage === "wait") {
          yield* Effect.yieldNow;
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
          // Exercise simultaneous expiry before the queued capture can start.
          yield* Effect.sync(() => vi.advanceTimersByTime(15_000));
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
        } else {
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(15_000));
        }
        expect.soft(snapshot.pollUnsafe()).toMatchObject({
          _tag: "Success",
          value: {
            _tag: "PreviewAutomationTimeoutError",
            remoteTag: "PreviewAutomationTimeoutError",
          },
        });

        if (stage === "wait") {
          expect.soft(cdp.send).toHaveBeenCalledWith("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Shift",
            code: "ShiftLeft",
          });
          expect.soft(cdp.send).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            button: "left",
            x: 10,
            y: 20,
            buttons: 0,
            clickCount: 1,
          });
          // Even the healthy session's release acknowledgements cannot hold the control queue.
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1_000));
        }
        const sendsAtTimeout = session.send.mock.calls.length;
        const releasesAtTimeout = cdp.send.mock.calls.filter(([method]) =>
          method.startsWith("Input.dispatch"),
        ).length;

        const evaluation = yield* broker
          .invoke({ scope, tabId, operation: "evaluate", input: { expression: "1 + 1" } })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
        expect.soft(evaluation.pollUnsafe()).toMatchObject({ _tag: "Success", value: "evaluated" });

        const recovered = yield* broker
          .invoke<PreviewAutomationSnapshot>({ scope, tabId, operation: "snapshot", input: {} })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
        if (stage === "wait") {
          // The old Chromium capture still owns this page until it answers.
          expect.soft(recovered.pollUnsafe()).toMatchObject({ _tag: "Failure" });
          expect(yield* Fiber.join(recovered).pipe(Effect.flip)).toMatchObject({
            reason: expect.stringContaining("did not draw a frame"),
          });
        } else {
          expect.soft(recovered.pollUnsafe()).toMatchObject({
            _tag: "Success",
            value: { visibleText: "delete", screenshot: { data: PNG_HEADER } },
          });
        }
        const readsBeforeRelease = page.ariaSnapshot.mock.calls.length;
        // A failed CDP session may be retired, but cannot remain attached and paused.
        expect.soft(streaming || session.detach.mock.calls.length > 0).toBe(true);
        let replacement: ReturnType<typeof makeSession> | undefined;
        if (stage !== "capture") {
          expect(session.detach).toHaveBeenCalled();
          expect(yield* Queue.clear(viewer.output)).toContainEqual({ _tag: "reconnect" });
          const reattached = yield* browser.attachViewer(viewerInput(tabId, false));
          replacement = sessions.at(-1)!;
          expect(replacement.send).toHaveBeenCalledWith("Page.startScreencast", expect.anything());
          if (stage === "wait")
            expect(yield* Queue.clear(reattached.output)).toContainEqual(
              expect.objectContaining({ _tag: "control", controller: "agent" }),
            );
        }

        release.resolve();
        yield* Effect.yieldNow;
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
        expect(streaming || session.detach.mock.calls.length > 0).toBe(true);
        if (replacement) expect(replacement.detach).not.toHaveBeenCalled();
        if (stage === "wait") {
          expect(page.ariaSnapshot).toHaveBeenCalledTimes(readsBeforeRelease);
          expect(session.send).toHaveBeenCalledTimes(sendsAtTimeout);
          expect(
            cdp.send.mock.calls.filter(([method]) => method.startsWith("Input.dispatch")),
          ).toHaveLength(releasesAtTimeout);
          expect(yield* Queue.clear(viewer.output)).toEqual([]);
          const fresh = yield* broker.invoke<PreviewAutomationSnapshot>({
            scope,
            tabId,
            operation: "snapshot",
            input: {},
          });
          expect(fresh).toMatchObject({
            visibleText: "delete",
            screenshot: { data: PNG_HEADER },
          });
        }
      }),
    ).pipe(Effect.provide(layer)),
);

it.live(
  "a snapshot timeout preserves recorded frames and retires a persistently stalled recording session",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        yield* broker.invoke({ scope, tabId, operation: "recordingStart", input: {} });
        const session = contexts[0]!.sessions.at(-1)!;
        const encoder = scratchPages.at(-1)!;
        const blocked = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const send = session.send.getMockImplementation()!;
        let stops = 0;
        session.send.mockImplementation(async (method, input) => {
          if (method === "Page.stopScreencast" && ++stops === 2) blocked.resolve();
          await release.promise;
          return send(method, input);
        });
        // Playwright detach waits for a command on the same stalled CDP session.
        session.detach.mockImplementation(() => release.promise);
        // Reaching the encoder limit must not tie frame draining to the stalled stop command.
        encoder.evaluate.mockResolvedValueOnce(false);
        session.emit("Page.screencastFrame", {
          data: "ZnJhbWU=",
          sessionId: 1,
          metadata: { deviceWidth: 1280 },
        });
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            release.resolve();
            vi.useRealTimers();
          }),
        );
        const snapshot = yield* broker
          .invoke({ scope, tabId, operation: "snapshot", input: {} })
          .pipe(Effect.flip, Effect.forkScoped({ startImmediately: true }));
        yield* Effect.promise(() => blocked.promise);
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(15_000));
        expect(snapshot.pollUnsafe()).toMatchObject({
          _tag: "Success",
          value: {
            _tag: "PreviewAutomationTimeoutError",
            remoteTag: "PreviewAutomationTimeoutError",
          },
        });
        expect(session.detach).toHaveBeenCalledTimes(1);
        const sendsAtTimeout = session.send.mock.calls.length;
        const framesAtTimeout = encoder.evaluate.mock.calls.length;
        session.emit("Page.screencastFrame", {
          data: "bGF0ZQ==",
          sessionId: 2,
          metadata: { deviceWidth: 1280 },
        });
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
        expect.soft(encoder.evaluate).toHaveBeenCalledTimes(framesAtTimeout);

        const recovered = yield* broker
          .invoke<PreviewAutomationSnapshot>({ scope, tabId, operation: "snapshot", input: {} })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
        expect.soft(recovered.pollUnsafe()).toMatchObject({
          _tag: "Success",
          value: { visibleText: "delete" },
        });

        encoder.evaluate
          .mockResolvedValueOnce({ mimeType: "video/webm", count: 1, bytes: 5 })
          .mockResolvedValueOnce("ZnJhbWU=");
        const stopping = yield* broker
          .invoke<{ path: string; mimeType: string; sizeBytes: number }>({
            scope,
            tabId,
            operation: "recordingStop",
            input: {},
          })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
        expect(encoder.close).toHaveBeenCalled();
        const stopped = yield* Fiber.join(stopping);
        expect(session.send).toHaveBeenCalledTimes(sendsAtTimeout);
        expect(session.detach).toHaveBeenCalledTimes(1);
        const fs = yield* FileSystem.FileSystem;
        expect(stopped).toMatchObject({ mimeType: "video/webm", sizeBytes: 5 });
        expect(yield* fs.readFileString(stopped.path)).toBe("frame");
        yield* broker.invoke({ scope, tabId, operation: "recordingStart", input: {} });
        const replacement = contexts[0]!.sessions.at(-1)!;
        expect(replacement).not.toBe(session);

        release.resolve();
        yield* Effect.yieldNow;
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
        expect(
          session.send.mock.calls.filter(([method]) => method === "Page.startScreencast"),
        ).toHaveLength(1);
        expect(replacement.detach).not.toHaveBeenCalled();
        const next = yield* broker.invoke<PreviewAutomationSnapshot>({
          scope,
          tabId,
          operation: "snapshot",
          input: {},
        });
        expect(next.visibleText).toBe("delete");
        expect(
          replacement.send.mock.calls.filter(([method]) => method === "Page.startScreencast"),
        ).toHaveLength(2);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("late desktop attachment keeps downloads and an active headless recording", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const page = contexts[0]!.page;
      const saved = Promise.withResolvers<string>();
      const written = Promise.withResolvers<void>();
      page.emit("download", {
        failure: async () => null,
        delete: async () => {},
        saveAs: (path: string) => {
          saved.resolve(path);
          return written.promise;
        },
        suggestedFilename: () => "report.csv",
        url: () => "blob:http://localhost/1",
      });
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(yield* Effect.promise(() => saved.promise), "a,b");
      written.resolve();
      const status = () =>
        broker.invoke<PreviewAutomationStatus>({ scope, tabId, operation: "status", input: {} });
      let before = yield* status();
      while (!before.downloads?.length) {
        yield* Effect.yieldNow;
        before = yield* status();
      }
      yield* broker.invoke({ scope, tabId, operation: "recordingStart", input: {} });
      const encoder = scratchPages[0]!;
      const attached = Promise.withResolvers<void>();
      const list = manager.list;
      const spy = vi
        .spyOn(manager, "list")
        .mockImplementation((input) =>
          list(input).pipe(Effect.tap(() => Effect.sync(() => attached.resolve()))),
        );
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
      desktopTabs.add(tabId);
      desktopDetaches.emit("attach", { threadId: scope.thread.threadId, tabId });
      // The stream processes this missing tab after the real attach, providing a completion barrier.
      desktopDetaches.emit("attach", { threadId: scope.thread.threadId, tabId: "attach-barrier" });
      yield* Effect.promise(() => attached.promise);
      expect(page.close).not.toHaveBeenCalled();
      expect(encoder.close).not.toHaveBeenCalled();
      expect(desktopConnections).toEqual([]);
      expect((yield* status()).downloads).toEqual(before.downloads);
      expect((yield* status()).serverPageMode).toBe("headless");
      encoder.evaluate
        .mockResolvedValueOnce({ mimeType: "video/webm", bytes: 5, count: 1 })
        .mockResolvedValueOnce("dmlkZW8=");
      const recording = yield* broker.invoke<{ path: string; sizeBytes: number }>({
        scope,
        tabId,
        operation: "recordingStop",
        input: {},
      });
      expect(recording.sizeBytes).toBe(5);
      expect(yield* fs.readFileString(recording.path)).toBe("video");
      expect(yield* fs.exists(before.downloads?.[0]?.path ?? "")).toBe(true);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a capture timeout releases the tab so the next agent action works", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const cdp = contexts[0]!.sessions[0]!;
      const started = Promise.withResolvers<void>();
      const captured = Promise.withResolvers<Record<string, unknown>>();
      const send = cdp.send.getMockImplementation()!;
      cdp.send.mockImplementation((method, input) => {
        if (method !== "Page.captureScreenshot") return send(method, input);
        started.resolve();
        return captured.promise;
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          captured.resolve({ data: "ZnJhbWU=" });
          vi.useRealTimers();
        }),
      );
      const snapshot = yield* broker
        .invoke<PreviewAutomationSnapshot>({ scope, tabId, operation: "snapshot", input: {} })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.promise(() => started.promise);
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(5_000));
      expect(yield* Fiber.join(snapshot)).toMatchObject({
        _tag: "PreviewAutomationExecutionError",
        reason: expect.stringContaining("did not draw a frame"),
      });
      expect(
        yield* broker.invoke({ scope, tabId, operation: "evaluate", input: { expression: "42" } }),
      ).toBe("evaluated");
    }),
  ).pipe(Effect.provide(layer)),
);
