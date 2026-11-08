import { describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "../../test/render";

import { setMarkdownTaskChecked } from "@t3tools/shared/markdownTaskList";

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

const formulas = (container: HTMLElement) =>
  [...container.querySelectorAll("span[data-markdown-math]")].map((formula) =>
    formula.getAttribute("data-markdown-copy"),
  );

describe("ChatMarkdown math", () => {
  it("typesets only when enabled, keeping prices and task offsets intact", async () => {
    const text = "Area $\\pi r^2$ costs $5 and $10.\n\n\\[\nE = mc^2\n\\]\n\n- [ ] check \\(x\\)";
    await using plain = await render(<ChatMarkdown cwd="/tmp/project" text={text} />);
    expect(formulas(plain.container)).toEqual([]);
    // Raw HTML carrying the math classes stays code while the setting is off.
    await using raw = await render(
      <ChatMarkdown cwd="/tmp/project" text={'<code class="language-math math-inline">x</code>'} />,
    );
    expect(formulas(raw.container)).toEqual([]);
    using _settings = {
      [Symbol.dispose]: () => {
        settingsOverrides.mathRenderingEnabled = false;
      },
    };

    settingsOverrides.mathRenderingEnabled = true;
    // Both the sanitized raw-HTML pipeline and the literal one keep the math classes.
    for (const parseRawHtml of [true, false]) {
      let edited: string | undefined;
      await using screen = await render(
        <ChatMarkdown
          cwd="/tmp/project"
          text={text}
          parseRawHtml={parseRawHtml}
          onTaskListChange={({ markerOffset, checked }) => {
            edited = setMarkdownTaskChecked(text, markerOffset, checked);
          }}
        />,
      );
      expect(formulas(screen.container)).toEqual([
        "\\(\\pi r^2\\)",
        "\\[\nE = mc^2\n\\]\n\n",
        "\\(x\\)",
      ]);
      await act(async () =>
        screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
      );
      expect(edited).toBe(text.replace("- [ ]", "- [x]"));
    }
    // List indentation recovery parses blocks again; they still typeset.
    await using indented = await render(
      <ChatMarkdown
        cwd="/tmp/project"
        text={"-       intro\n\n        $$\n        x^2\n        $$"}
      />,
    );
    expect(formulas(indented.container)).toEqual(["\\[\nx^2\n\\]\n\n"]);
  });
});
