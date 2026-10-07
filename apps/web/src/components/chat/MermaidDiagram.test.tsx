// @vitest-environment jsdom

import { act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { MermaidDiagram } from "./MermaidDiagram";

const { renderMermaid } = vi.hoisted(() => ({
  renderMermaid: vi.fn(async () => ({ svg: "" })),
}));

vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: renderMermaid },
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// Mermaid uses KaTeX's MathML output inside an HTML label, even with htmlLabels off.
function diagramSvg(label: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">
    <foreignObject><div xmlns="http://www.w3.org/1999/xhtml">
      <span class="katex"><math xmlns="http://www.w3.org/1998/Math/MathML" display="block">
        <semantics><mrow>${label}</mrow></semantics>
      </math></span>
    </div></foreignObject>
  </svg>`;
}

async function renderDiagram(source: string, svg: string) {
  renderMermaid.mockResolvedValueOnce({ svg });
  await act(async () => {
    root.render(
      <Suspense fallback="Rendering diagram">
        <MermaidDiagram source={source} theme="light" onExpand={vi.fn()} />
      </Suspense>,
    );
  });
}

describe("MermaidDiagram math", () => {
  it("keeps MathML labels in the rendered diagram", async () => {
    await renderDiagram(
      "sequenceDiagram\nA->>B: $$x^2$$",
      diagramSvg("<msup><mi>x</mi><mn>2</mn></msup>"),
    );

    const formula = container.querySelector("math msup");
    expect(formula?.namespaceURI).toBe("http://www.w3.org/1998/Math/MathML");
    expect(formula?.textContent).toBe("x2");
    expect(formula?.children).toHaveLength(2);
  });

  it("still strips active content from math labels", async () => {
    await renderDiagram(
      "sequenceDiagram\nA->>B: $$z^2$$",
      diagramSvg(`
        <msup onclick="alert(1)"><mi href="javascript:alert(1)">z</mi><mn>2</mn></msup>
        <script>alert(1)</script>
        <mtext><a href="https://example.com">link</a><img src="https://example.com/image.png" onerror="alert(1)"></mtext>
      `),
    );

    expect(container.querySelector("math msup")?.textContent).toBe("z2");
    expect(container.querySelector("script, a, img, image")).toBeNull();
    expect(container.querySelector("[onclick], [onerror], [href], [src]")).toBeNull();
    expect(container.innerHTML).not.toContain("https://example.com");
  });
});
