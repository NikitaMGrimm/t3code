import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { setMarkdownTaskChecked } from "./files/filePreviewMode";

const settingsOverrides = vi.hoisted(() => ({ mathRenderingEnabled: false }));

vi.mock(import("../hooks/useSettings"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useClientSettings: ((select?: (value: unknown) => unknown) => {
      const value = { ...actual.getClientSettings(), ...settingsOverrides };
      return select ? select(value) : value;
    }) as never,
  };
});
// Atoms derived from the server config run in the real registry over a missing config.
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));

import ChatMarkdown from "./ChatMarkdown";

const roots: Root[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  settingsOverrides.mathRenderingEnabled = false;
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function render(element: ReactElement) {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
}

const formulas = (container: HTMLElement) =>
  [...container.querySelectorAll("span[data-markdown-math]")].map((formula) =>
    formula.getAttribute("data-markdown-copy"),
  );

describe("ChatMarkdown math", () => {
  it("typesets only when enabled, keeping prices and task offsets intact", async () => {
    const text = "Area $\\pi r^2$ costs $5 and $10.\n\n\\[\nE = mc^2\n\\]\n\n- [ ] check \\(x\\)";
    expect(formulas(await render(<ChatMarkdown cwd="/tmp/project" text={text} />))).toEqual([]);
    // Raw HTML carrying the math classes stays code while the setting is off.
    expect(
      formulas(
        await render(
          <ChatMarkdown
            cwd="/tmp/project"
            text={'<code class="language-math math-inline">x</code>'}
          />,
        ),
      ),
    ).toEqual([]);

    settingsOverrides.mathRenderingEnabled = true;
    // Both the sanitized raw-HTML pipeline and the literal one keep the math classes.
    for (const parseRawHtml of [true, false]) {
      let edited: string | undefined;
      const container = await render(
        <ChatMarkdown
          cwd="/tmp/project"
          text={text}
          parseRawHtml={parseRawHtml}
          onTaskListChange={({ markerOffset, checked }) => {
            edited = setMarkdownTaskChecked(text, markerOffset, checked);
          }}
        />,
      );
      expect(formulas(container)).toEqual(["\\(\\pi r^2\\)", "\\[\nE = mc^2\n\\]\n\n", "\\(x\\)"]);
      await act(async () =>
        container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
      );
      expect(edited).toBe(text.replace("- [ ]", "- [x]"));
    }
    // List indentation recovery parses blocks again; they still typeset.
    expect(
      formulas(
        await render(
          <ChatMarkdown
            cwd="/tmp/project"
            text={"-       intro\n\n        $$\n        x^2\n        $$"}
          />,
        ),
      ),
    ).toEqual(["\\[\nx^2\n\\]\n\n"]);
  });
});
