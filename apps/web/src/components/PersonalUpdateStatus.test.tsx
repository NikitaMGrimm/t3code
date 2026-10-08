// @vitest-environment jsdom

import { StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { refreshPersonalUpdateStatus } from "../hooks/usePersonalUpdateStatus";
import { PersonalUpdateNotification } from "./PersonalUpdateStatus";
import { ToastProvider } from "./ui/toast";

vi.mock("@tanstack/react-router", () => ({ useParams: () => ({}) }));

it("keeps dismissed failures quiet across polling and shows a failed rerun of the same workflow", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const animations = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  let status = {
    schema: 1,
    sequence: 1791417149067,
    phase: "failed",
    upstreamTag: "v0.0.46-nightly.20261008.2801",
    conflicts: [] as string[],
    runUrl: "https://github.com/NikitaMGrimm/t3code/actions/runs/123",
    releasedVersion: "0.0.46-nightly.20261007.1791417149067",
  };
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(status)));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const refresh = () => act(() => refreshPersonalUpdateStatus());
  const notices = () =>
    [...document.querySelectorAll('[data-slot="toast-title"]')].filter(
      (element) => !element.closest("[data-ending-style]"),
    );
  const detailsLink = () =>
    [...document.querySelectorAll("a")].find((element) => !element.closest("[data-ending-style]"));
  const dismiss = () =>
    act(() =>
      [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Dismiss notification"]')]
        .find((element) => !element.closest("[data-ending-style]"))!
        .click(),
    );

  try {
    await act(() =>
      root.render(
        <StrictMode>
          <ToastProvider>
            <PersonalUpdateNotification />
          </ToastProvider>
        </StrictMode>,
      ),
    );
    await refresh();
    expect(notices()).toHaveLength(1);
    expect(document.body.textContent).toContain("Nightly checks or packaging failed");
    expect(container.textContent).toBe("");
    expect(detailsLink()?.href).toBe(status.runUrl);

    await dismiss();
    await refresh();
    await refresh();
    expect(notices()).toHaveLength(0);

    status = { ...status, phase: "building" };
    await refresh();
    status = { ...status, phase: "failed" };
    await refresh();
    expect(notices()).toHaveLength(0);

    status = { ...status, phase: "building", sequence: status.sequence + 1 };
    await refresh();
    expect(notices()).toHaveLength(0);
    status = { ...status, phase: "failed" };
    await refresh();
    expect(notices()).toHaveLength(1);
    expect(detailsLink()?.href).toBe(status.runUrl);
    await refresh();
    expect(notices()).toHaveLength(1);

    await dismiss();
    await refresh();
    expect(notices()).toHaveLength(0);

    status = {
      ...status,
      phase: "conflict",
      runUrl: status.runUrl.replace("123", "456"),
      conflicts: ["apps/web/src/components/ChatView.tsx"],
    };
    await refresh();
    expect(notices()).toHaveLength(1);
    expect(document.body.textContent).toContain(
      "Nightly update has merge conflicts: apps/web/src/components/ChatView.tsx",
    );
    expect(detailsLink()?.href).toBe(status.runUrl);

    status = { ...status, phase: "ready", conflicts: [] };
    await refresh();
    expect(notices()).toHaveLength(0);
  } finally {
    await act(() => root.unmount());
    container.remove();
    if (animations) Object.defineProperty(Element.prototype, "getAnimations", animations);
    else Reflect.deleteProperty(Element.prototype, "getAnimations");
    vi.unstubAllGlobals();
  }
});
