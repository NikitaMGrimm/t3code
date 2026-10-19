import katex from "katex";
import { describe, expect, it } from "vite-plus/test";

import {
  captureAssistantTextSelection,
  resolveAssistantCitationRange,
} from "./lib/assistantTextSelection";
import { chatMarkdownClipboardPayload, serializeTableElementToCsv } from "./markdown-clipboard";

// The markup MarkdownMath renders once KaTeX has typeset a formula.
function formula(tex: string, display = false) {
  const source = display ? `$$\n${tex}\n$$` : `$${tex}$`;
  const wrapper = document.createElement("span");
  if (display) wrapper.className = "chat-markdown-math-display";
  wrapper.setAttribute("data-markdown-math", "");
  wrapper.setAttribute("data-markdown-copy", display ? `${source}\n\n` : source);
  wrapper.innerHTML = katex.renderToString(tex, { displayMode: display });
  return wrapper;
}

function select(start: Node, startOffset: number, end: Node, endOffset: number) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

function glyph(wrapper: Element) {
  const walker = document.createTreeWalker(wrapper.querySelector(".katex-html")!, 4);
  return walker.nextNode() as Text;
}

describe("rendered math as its TeX source", () => {
  it("exports a table cell's formula to CSV as TeX", () => {
    document.body.innerHTML = "<table><tbody><tr><td>Area</td><td></td></tr></tbody></table>";
    document.querySelectorAll("td")[1]!.append(formula("\\pi r^2"));

    expect(serializeTableElementToCsv(document.querySelector("table")!)).toBe("Area,$\\pi r^2$");
  });

  it("puts TeX in the rich-text copy instead of KaTeX's markup", () => {
    document.body.innerHTML = `<div class="chat-markdown"><p>Area  grows.</p><p></p></div>`;
    const paragraph = document.querySelector("p")!;
    const block = paragraph.nextElementSibling!;
    const inline = formula("\\pi r^2");
    (paragraph.firstChild as Text).splitText(5).before(inline);
    const display = formula("E = mc^2", true);
    block.append(display);

    const spanning = chatMarkdownClipboardPayload(select(paragraph, 0, paragraph, 3))?.html;
    expect(spanning).toBe('<meta charset="utf-8">Area <code>$\\pi r^2$</code> grows.');
    const inside = glyph(display);
    expect(chatMarkdownClipboardPayload(select(inside, 0, inside, 1))?.html).toBe(
      '<meta charset="utf-8"><pre><code>$$\nE = mc^2\n$$</code></pre>',
    );
  });

  it("quotes a formula as its whole TeX when the selection starts inside its glyphs", () => {
    document.body.innerHTML = `<main><div data-assistant-citation-source=""><p>Area  grows.</p></div></main>`;
    const source = document.querySelector<HTMLElement>("[data-assistant-citation-source]")!;
    const paragraph = source.querySelector("p")!;
    const inline = formula("\\pi r^2");
    (paragraph.firstChild as Text).splitText(5).before(inline);
    const tail = paragraph.lastChild as Text;

    const captured = captureAssistantTextSelection(
      document.querySelector("main")!,
      select(glyph(inline), 0, tail, tail.length),
    );
    expect(captured?.selector.text).toBe("$\\pi r^2$ grows.");

    const range = resolveAssistantCitationRange(source, captured!.selector);
    expect(range?.startContainer).toBe(paragraph);
    expect(range?.cloneContents().querySelector("[data-markdown-math]")).not.toBeNull();
  });
});
