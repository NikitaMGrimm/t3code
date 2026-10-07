// @vitest-environment jsdom

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useRightPanelStore } from "../../rightPanelStore";
import { PopoverCreateHandle } from "../ui/popover";
import { PanelLayoutControls } from "./PanelLayoutControls";
import { ThreadDetailsCard } from "./ThreadDetailsCard";

const threadRef = {
  environmentId: EnvironmentId.make("banner-dismissal"),
  threadId: ThreadId.make("thread"),
};
const noop = () => {};
let root: Root;
let container: HTMLDivElement;

function Fixture() {
  const anchor = useRef<HTMLDivElement>(null);
  const errorBannersRef = useRef<HTMLDivElement>(null);
  const [handle] = useState(PopoverCreateHandle);
  const [error, setError] = useState(true);
  return (
    <>
      <div ref={anchor}>
        <PanelLayoutControls
          terminalAvailable={false}
          terminalOpen={false}
          terminalShortcutLabel={null}
          threadPanelOpen={true}
          threadPanelPresentation="popover"
          threadPanelPopoverHandle={handle}
          errorBannersRef={errorBannersRef}
          threadPanelShortcutLabel={null}
          threadPanelHasAttention={false}
          rightPanelAvailable={false}
          rightPanelOpen={false}
          rightPanelShortcutLabel={null}
          onToggleTerminal={noop}
          onToggleThreadPanel={noop}
          onToggleRightPanel={noop}
          showTerminalControl={false}
          showRightPanelControl={false}
        />
      </div>
      <div ref={errorBannersRef}>
        {error && (
          <div role="alert">
            <span>Provider unavailable</span>
            <button onClick={() => setError(false)} aria-label="Dismiss error">
              <svg>
                <path />
              </svg>
            </button>
          </div>
        )}
      </div>
      <button>Outside</button>
      <ThreadDetailsCard
        threadRef={threadRef}
        anchor={anchor}
        errorBannersRef={errorBannersRef}
        handle={handle}
        onPresentationChange={noop}
      >
        {() => <button>Project actions</button>}
      </ThreadDetailsCard>
    </>
  );
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => root.render(<Fixture />));
  await click(button("Toggle thread details panel"));
  expect(panel()).not.toBeNull();
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  vi.unstubAllGlobals();
});

function panel() {
  return document.querySelector(
    '[data-slot="popover-popup"][data-open] [data-thread-details-panel="popover"]',
  );
}

function button(label: string) {
  return Array.from(document.querySelectorAll("button")).find(
    (element) => (element.getAttribute("aria-label") ?? element.textContent) === label,
  )!;
}

async function click(element: Element) {
  await act(() => {
    const pointerDown = new MouseEvent("pointerdown", { bubbles: true });
    Object.defineProperty(pointerDown, "pointerType", { value: "mouse" });
    element.dispatchEvent(pointerDown);
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    element.closest("button")?.focus();
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("workspace panel and foreground errors", () => {
  it("dismisses the error through its icon without closing the panel", async () => {
    await click(button("Dismiss error").querySelector("path")!);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(panel()).not.toBeNull();
  });

  it("keeps the panel open for banner text, but closes for other outside clicks", async () => {
    await click(document.querySelector('[role="alert"] span')!);
    expect(panel()).not.toBeNull();
    await click(button("Outside"));
    expect(panel()).toBeNull();
  });

  it("allows focus to move to the error control without closing the panel", async () => {
    await act(() => button("Project actions").focus());
    await act(() => button("Dismiss error").focus());
    expect(document.activeElement).toBe(button("Dismiss error"));
    expect(panel()).not.toBeNull();
    await act(() => button("Dismiss error").click());
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(panel()).not.toBeNull();
  });

  it("still closes on Escape while an error control has focus", async () => {
    await act(() => button("Dismiss error").focus());
    await act(() =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(panel()).toBeNull();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("returns focus to the workspace trigger on Escape after dismissing an error", async () => {
    await act(() => button("Project actions").focus());
    await click(button("Dismiss error"));
    expect(panel()).not.toBeNull();
    await act(() => button("Project actions").focus());
    await act(() =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(button("Toggle thread details panel"));
  });

  it("keeps the workspace open when the error is dismissed from trigger focus", async () => {
    await act(() => button("Toggle thread details panel").focus());
    await click(button("Dismiss error"));
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(panel()).not.toBeNull();
  });
});
