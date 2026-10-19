import { StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { refreshPersonalUpdateStatus } from "../hooks/usePersonalUpdateStatus";
import { PersonalUpdateNotification } from "./PersonalUpdateStatus";
import { ToastProvider } from "./ui/toast";

vi.mock("@tanstack/react-router", () => ({ useParams: () => ({}) }));

async function withNotifications(
  initial: object,
  run: (page: {
    container: HTMLElement;
    setStatus: (next: object) => Promise<void>;
    refresh: () => Promise<void>;
    notices: () => Element[];
    detailsLink: () => HTMLAnchorElement | undefined;
    dismiss: () => Promise<void>;
  }) => Promise<void>,
) {
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
  let status = initial;
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(status)));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const refresh = () => act(() => refreshPersonalUpdateStatus());
  const live = (element: Element) => !element.closest("[data-ending-style]");

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
    await run({
      container,
      setStatus: (next) => {
        status = next;
        return refresh();
      },
      refresh,
      notices: () => [...document.querySelectorAll('[data-slot="toast-title"]')].filter(live),
      detailsLink: () => [...document.querySelectorAll("a")].find(live),
      dismiss: async () =>
        act(() =>
          [
            ...document.querySelectorAll<HTMLButtonElement>(
              'button[aria-label="Dismiss notification"]',
            ),
          ]
            .find(live)!
            .click(),
        ),
    });
  } finally {
    await act(() => root.unmount());
    container.remove();
    if (animations) Object.defineProperty(Element.prototype, "getAnimations", animations);
    else Reflect.deleteProperty(Element.prototype, "getAnimations");
    vi.unstubAllGlobals();
  }
}

const failed = {
  schema: 1,
  sequence: 1791417149067,
  phase: "failed",
  upstreamTag: "v0.0.46-nightly.20261008.2801",
  conflicts: [] as string[],
  runUrl: "https://github.com/NikitaMGrimm/t3code/actions/runs/123",
  releasedVersion: "0.0.46-nightly.20261007.1791417149067",
};

it("keeps dismissed failures quiet across polling and shows a failed rerun of the same workflow", async () => {
  await withNotifications(
    failed,
    async ({ container, setStatus, refresh, notices, detailsLink, dismiss }) => {
      let status = failed;
      const update = (changes: Partial<typeof failed>) => {
        status = { ...status, ...changes };
        return setStatus(status);
      };
      expect(notices()).toHaveLength(1);
      expect(document.body.textContent).toContain("Nightly checks or packaging failed");
      expect(container.textContent).toBe("");
      expect(detailsLink()?.href).toBe(status.runUrl);

      await dismiss();
      await refresh();
      await refresh();
      expect(notices()).toHaveLength(0);

      await update({ phase: "building" });
      await update({ phase: "failed" });
      expect(notices()).toHaveLength(0);

      await update({ phase: "building", sequence: status.sequence + 1 });
      expect(notices()).toHaveLength(0);
      await update({ phase: "failed" });
      expect(notices()).toHaveLength(1);
      expect(detailsLink()?.href).toBe(status.runUrl);
      await refresh();
      expect(notices()).toHaveLength(1);

      await dismiss();
      await refresh();
      expect(notices()).toHaveLength(0);

      await update({
        phase: "conflict",
        runUrl: status.runUrl.replace("123", "456"),
        conflicts: ["apps/web/src/components/ChatView.tsx"],
      });
      expect(notices()).toHaveLength(1);
      expect(document.body.textContent).toContain(
        "Nightly update has merge conflicts: apps/web/src/components/ChatView.tsx",
      );
      expect(detailsLink()?.href).toBe(status.runUrl);

      await update({ phase: "ready", conflicts: [] });
      expect(notices()).toHaveLength(0);
    },
  );
});

it("keeps a dismissed content conflict quiet across unrelated attempts until waiting clears it", async () => {
  const conflict = {
    ...failed,
    phase: "conflict",
    conflicts: ["apps/web/src/components/ChatView.tsx"],
    conflictIdentity: "a".repeat(64),
  };
  const waiting = {
    ...failed,
    phase: "ready",
    sequence: failed.sequence + 2,
    runUrl: failed.runUrl.replace("123", "789"),
    waiting: {
      pullRequest: 18308,
      baseCommit: "284ce8fe2ff99076657707fd754e538403d88d76",
      paths: ["apps/web/src/components/ChatView.tsx"],
    },
  };
  await withNotifications(conflict, async ({ setStatus, notices, dismiss }) => {
    expect(notices()).toHaveLength(1);
    await dismiss();
    await setStatus({
      ...conflict,
      sequence: conflict.sequence + 1,
      runUrl: conflict.runUrl.replace("123", "456"),
    });
    expect(notices()).toHaveLength(0);

    await setStatus(waiting);
    expect(notices()).toHaveLength(0);

    await setStatus({ ...conflict, sequence: waiting.sequence + 1 });
    expect(notices()).toHaveLength(1);
  });
});
