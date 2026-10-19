// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vite-plus/test";

import { chatMarkdownClipboardPayload, serializeCodeBlockToMarkdown } from "./markdown-clipboard";

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe("copying rendered Mermaid", () => {
  it.each(["across", "inside", "starts inside", "ends inside"])(
    "preserves fenced source when the selection is %s the diagram",
    (mode) => {
      const markdown = "```mermaid\nflowchart LR\n    A[Select message] --> B[Copy Markdown]\n```";
      document.body.innerHTML = `<div class="chat-markdown"><p>Before diagram.</p><div data-markdown-mermaid=""><button><svg><text>Select message</text></svg></button></div><p>After diagram.</p></div>`;
      document
        .querySelector("[data-markdown-mermaid]")!
        .setAttribute("data-markdown-copy", `${markdown}\n\n`);
      const before = document.querySelector("p")!.firstChild!;
      const after = document.querySelectorAll("p")[1]!.firstChild!;
      const label = document.querySelector("text")!.firstChild!;
      const range = document.createRange();
      range.setStart(mode === "inside" || mode === "starts inside" ? label : before, 2);
      range.setEnd(mode === "inside" || mode === "ends inside" ? label : after, 5);
      const selection = window.getSelection()!;
      selection.addRange(range);

      const expected = [
        mode === "across" || mode === "ends inside" ? "fore diagram." : null,
        markdown,
        mode === "across" || mode === "starts inside" ? "After" : null,
      ]
        .filter(Boolean)
        .join("\n\n");
      expect(chatMarkdownClipboardPayload(selection)?.text).toBe(expected);
    },
  );

  it("uses a fence longer than backticks in the source", () => {
    expect(serializeCodeBlockToMarkdown("flowchart LR\n%% ```\n", "mermaid")).toBe(
      "````mermaid\nflowchart LR\n%% ```\n````\n\n",
    );
  });

  it.each(["across", "whole", "inside"])(
    "preserves a longer fence when copying %s a diagram",
    (mode) => {
      const source = 'flowchart LR\n  A["contains ```"] --> B["`first  \n\n\nlast`"]\n  B --> C';
      const markdown = serializeCodeBlockToMarkdown(source, "mermaid").trim();
      document.body.innerHTML = `<div class="chat-markdown"><p>Before.</p><div data-markdown-mermaid=""><svg><text>Diagram</text></svg></div><p>After.</p></div>`;
      document
        .querySelector("[data-markdown-mermaid]")!
        .setAttribute("data-markdown-copy", `${markdown}\n\n`);
      const paragraphs = document.querySelectorAll("p");
      const range = document.createRange();
      if (mode === "whole") {
        range.selectNode(document.querySelector("[data-markdown-mermaid]")!);
      } else if (mode === "inside") {
        range.selectNodeContents(document.querySelector("text")!);
      } else {
        range.setStart(paragraphs[0]!.firstChild!, 0);
        range.setEnd(paragraphs[1]!.firstChild!, 6);
      }
      const selection = window.getSelection()!;
      selection.addRange(range);

      expect(chatMarkdownClipboardPayload(selection)?.text).toBe(
        mode === "across" ? `Before.\n\n${markdown}\n\nAfter.` : markdown,
      );
    },
  );

  it.each([
    ["blockquote", "python"],
    ["list", "python"],
    ["blockquote", "mermaid"],
    ["list", "mermaid"],
    ["list quote", "python"],
    ["list quote", "mermaid"],
  ])("preserves code whitespace in a %s containing %s", (wrapper, language) => {
    const nested =
      wrapper === "blockquote"
        ? "<blockquote></blockquote>"
        : wrapper === "list quote"
          ? "<ul><li><blockquote></blockquote></li></ul>"
          : "<ul><li></li></ul>";
    document.body.innerHTML = `<div class="chat-markdown"><p>Before.</p>${nested}<p>After.</p></div>`;
    const parent = document.querySelector(wrapper === "list" ? "li" : "blockquote")!;
    if (language === "mermaid") {
      const diagram = document.createElement("div");
      diagram.setAttribute("data-markdown-mermaid", "");
      diagram.setAttribute(
        "data-markdown-copy",
        serializeCodeBlockToMarkdown(
          'flowchart LR\n  A["contains ```"] --> B["first  \n\n\nlast"]',
          "mermaid",
        ),
      );
      parent.append(diagram);
    } else {
      parent.innerHTML = '<pre data-language="python"><code></code></pre>';
      parent.querySelector("code")!.textContent = 'message = """first  \n\n\nlast"""';
    }
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(".chat-markdown")!);
    const selection = window.getSelection()!;
    selection.addRange(range);

    const copied = chatMarkdownClipboardPayload(selection)?.text;
    expect(copied).toContain("first  \n");
    expect(copied).toMatch(/first {2}\n(?:[ >]*\n){2}[ >]*last/);
    expect(copied).toContain(language === "mermaid" ? "````mermaid" : "```python");
    expect(copied).toContain("Before.");
    expect(copied).toContain("After.");
  });

  it("does not treat inline backticks as the opener of a following code block", () => {
    const source = 'message = """first  \nlast"""';
    document.body.innerHTML =
      '<div class="chat-markdown"><p><code></code></p><pre><code></code></pre><p>After.</p></div>';
    document.querySelector("p code")!.textContent = "``";
    document.querySelector("pre code")!.textContent = source;
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(".chat-markdown")!);
    const selection = window.getSelection()!;
    selection.addRange(range);

    expect(chatMarkdownClipboardPayload(selection)?.text).toContain(source);
  });

  it("preserves source whitespace when the language token contains a backtick", () => {
    const source = 'message = """first  \n\n\nlast"""';
    document.body.innerHTML =
      '<div class="chat-markdown"><p>Before.</p><pre><code class="language-unknown`lang"></code></pre><p>After.</p></div>';
    document.querySelector("pre code")!.textContent = source;
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(".chat-markdown")!);
    const selection = window.getSelection()!;
    selection.addRange(range);

    expect(chatMarkdownClipboardPayload(selection)?.text).toBe(
      `Before.\n\n\u0060\u0060\u0060\n${source}\n\u0060\u0060\u0060\n\nAfter.`,
    );
  });

  it.each([
    ["ul", true],
    ["ul", false],
    ["ol", true],
    ["ol", false],
  ])("preserves code whitespace in a %s task with checked=%s", (list, checked) => {
    document.body.innerHTML = `<div class="chat-markdown"><p>Before.</p><${list}><li><p><input type="checkbox"><br></p><pre data-language="python"><code></code></pre></li></${list}><p>After.</p></div>`;
    document.querySelector("input")!.checked = checked;
    document.querySelector("pre code")!.textContent = 'message = """first  \n\n\nlast"""';
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(".chat-markdown")!);
    const selection = window.getSelection()!;
    selection.addRange(range);

    const copied = chatMarkdownClipboardPayload(selection)?.text;
    expect(copied).toContain("first  \n");
    expect(copied).toMatch(/first {2}\n\n\n[ ]*last/);
    expect(copied).toContain(`[${checked ? "x" : " "}] \u0060\u0060\u0060python`);
    expect(copied).toContain("Before.");
    expect(copied).toContain("After.");
  });

  it("copies inline code within deeply nested lists and quotes", () => {
    document.body.innerHTML = '<div class="chat-markdown"><p>Before.</p><p>After.</p></div>';
    const markdown = document.querySelector(".chat-markdown")!;
    let parent: HTMLElement = document.createElement("div");
    markdown.insertBefore(parent, markdown.lastChild);
    for (let depth = 0; depth < 16; depth += 1) {
      const quote = document.createElement("blockquote");
      quote.innerHTML = "<ul><li><p>Item</p></li></ul>";
      parent.append(quote);
      parent = quote.querySelector("li")!;
    }
    const paragraph = document.createElement("p");
    paragraph.innerHTML = "<code></code>";
    paragraph.querySelector("code")!.textContent = "``";
    parent.append(paragraph);
    const range = document.createRange();
    range.selectNodeContents(markdown);
    const selection = window.getSelection()!;
    selection.addRange(range);

    const copied = chatMarkdownClipboardPayload(selection)?.text;
    expect(copied).toContain("Before.");
    expect(copied).toContain("After.");
    expect(copied?.match(/Item/g)).toHaveLength(16);
    expect(copied).toContain("``` `` ```");
  });

  it("keeps source-view selections partial", () => {
    document.body.innerHTML = `<div class="chat-markdown" data-language="mermaid"><pre><code>flowchart LR\n    A --> B</code></pre></div>`;
    const code = document.querySelector("code")!.firstChild!;
    const range = document.createRange();
    range.setStart(code, 0);
    range.setEnd(code, 9);
    const selection = window.getSelection()!;
    selection.addRange(range);

    expect(chatMarkdownClipboardPayload(selection)?.text).toBe("flowchart");
  });
});
