import { useImperativeHandle, useRef, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render, type Screen } from "../../../test/render";
import { ComposerHandleContext } from "../../composerHandleContext";
import { BranchPicker } from "../BranchPicker";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { ComboboxItem, ComboboxTrigger } from "../ui/combobox";
import type { ChatComposerHandle } from "./ChatComposer";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerControl } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { isComposerControlPaste } from "./composerFocusRedirect";
import { ComposerFooterModeControls } from "./ComposerFooterControls";
import { runtimeModeConfig } from "./runtimeModeConfig";

const runtimeModeOptions = (["approval-required", "full-access"] as const).map((mode) => ({
  mode,
  ...runtimeModeConfig[mode],
}));

function BranchControl() {
  const [open, setOpen] = useState(false);
  const popupProps = useComposerMenuProps(() => setOpen(false));
  return (
    <BranchPicker
      items={["main", "feature"]}
      filteredItems={["main", "feature"]}
      value="main"
      query=""
      resultsQuery=""
      onQueryChange={() => {}}
      open={open}
      onOpenChange={setOpen}
      onSelectItem={() => setOpen(false)}
      hasNextPage={false}
      isFetchingNextPage={false}
      onLoadNext={() => {}}
      statusText={null}
      popupProps={popupProps}
      renderItem={(value, index) => (
        <ComboboxItem key={value} index={index} value={value}>
          {value}
        </ComboboxItem>
      )}
    >
      <ComboboxTrigger render={<ComposerControl size="xs" />}>Branch</ComboboxTrigger>
    </BranchPicker>
  );
}

// The real editor and composer controls. The handle forwards to the editor as
// ChatComposer's does when long-text folding declines the paste.
function ComposerHarness({ draft }: { draft: string }) {
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const [prompt, setPrompt] = useState({ value: draft, cursor: draft.length });
  const composerRef = useRef<ChatComposerHandle | null>(null);
  useImperativeHandle(composerRef, () => {
    const handle: Pick<ChatComposerHandle, "restoreFocus" | "pasteClipboardEvent"> = {
      restoreFocus: () => editorRef.current?.restoreFocus(),
      pasteClipboardEvent: (event) => editorRef.current?.pasteClipboardEvent(event) ?? false,
    };
    return handle as ChatComposerHandle;
  }, []);
  return (
    <ComposerHandleContext value={composerRef}>
      <div data-testid="draft">{prompt.value}</div>
      <ComposerPromptEditor
        editorRef={editorRef}
        value={prompt.value}
        cursor={prompt.cursor}
        richTextEnabled={false}
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        onChange={(value, cursor) => setPrompt({ value, cursor })}
        onPaste={() => {}}
      />
      <ComposerFooterModeControls
        showInteractionModeToggle
        interactionMode="default"
        runtimeMode="approval-required"
        runtimeModeOptions={runtimeModeOptions}
        onToggleInteractionMode={() => {}}
        onRuntimeModeChange={() => {}}
      />
      <CompactComposerControlsMenu
        interactionMode="default"
        runtimeMode="approval-required"
        runtimeModeOptions={runtimeModeOptions}
        showInteractionModeToggle
        onToggleInteractionMode={() => {}}
        onRuntimeModeChange={() => {}}
      />
      <BranchControl />
      <button type="button" onClick={() => editorRef.current?.focusAt(5)}>
        Place caret
      </button>
    </ComposerHandleContext>
  );
}

function pasteOnFocused(text: string): ClipboardEvent {
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", text);
  const event = new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

async function expectDraft(screen: Screen, text: string) {
  await expect.element(screen.getByTestId("draft")).toHaveTextContent(text);
  // Exactly once: a second insertion would still contain the substring.
  expect(screen.getByTestId("draft").element().textContent).toBe(text);
}

async function renderComposer() {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await render(<ComposerHarness draft="hello world" />));
  // Leaves a retained caret after "hello" that the editor keeps while blurred.
  await userEvent.click(screen.getByRole("button", { name: "Place caret" }));
  stack.move();
  return screen;
}

describe("composer picker paste", () => {
  it("dismisses the access picker and pastes once at the draft's retained caret", async () => {
    await using screen = await renderComposer();
    await userEvent.click(screen.getByRole("combobox", { name: "Runtime mode" }));
    await expect.element(page.getByRole("listbox")).toBeVisible();

    const event = pasteOnFocused(" there");

    expect(event.defaultPrevented).toBe(true);
    await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();
    await expectDraft(screen, "hello there world");
    expect(document.activeElement?.closest(".tiptap")).not.toBeNull();
  });

  it("dismisses the compact controls menu and pastes into the draft", async () => {
    await using screen = await renderComposer();
    await userEvent.click(screen.getByRole("button", { name: "More composer controls" }));
    await expect.element(page.getByRole("menu")).toBeVisible();

    pasteOnFocused(" there");

    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    await expectDraft(screen, "hello there world");
  });

  it("sends a paste in an auto-focused search to the draft until the user searches", async () => {
    await using screen = await renderComposer();
    const branch = screen.getByText("Branch");
    await userEvent.click(branch);
    const search = page.getByPlaceholder("Search refs...");
    await expect.element(search).toHaveFocus();

    pasteOnFocused(" there");

    await expect.element(search).not.toBeInTheDocument();
    await expectDraft(screen, "hello there world");

    await userEvent.click(branch);
    await expect.element(search).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    const searchPaste = pasteOnFocused("feat");

    expect(searchPaste.defaultPrevented).toBe(false);
    await expect.element(search).toBeVisible();
    await expectDraft(screen, "hello there world");
  });

  it("keeps a paste in a search the user clicked", async () => {
    await using screen = await renderComposer();
    await userEvent.click(screen.getByText("Branch"));
    const search = page.getByPlaceholder("Search refs...");
    await userEvent.click(search);

    expect(pasteOnFocused("feat").defaultPrevented).toBe(false);
    await expect.element(search).toBeVisible();
  });

  it.each([false, true])(
    "preserves the draft selection after toggling closed (range: %s)",
    async (range) => {
      await using screen = await renderComposer();
      if (range) await userEvent.keyboard("{Shift>}{End}{/Shift}");
      const trigger = screen.getByRole("button", { name: "More composer controls" });
      await userEvent.click(trigger);
      await expect.element(page.getByRole("menu")).toBeVisible();
      await userEvent.click(trigger);

      await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
      await vi.waitFor(() => expect(document.activeElement?.closest(".tiptap")).not.toBeNull());
      pasteOnFocused(" there");
      await expectDraft(screen, range ? "hello there" : "hello there world");
    },
  );

  it.each(["{Control>}a{/Control}", "{Control>}{Home}{/Control}", "{Alt>}{ArrowLeft}{/Alt}"])(
    "keeps paste in a search after deliberate modified navigation: %s",
    async (keys) => {
      await using screen = await renderComposer();
      await userEvent.click(screen.getByText("Branch"));
      const search = page.getByPlaceholder("Search refs...");
      await expect.element(search).toHaveFocus();
      await userEvent.keyboard(keys);

      expect(pasteOnFocused("feat").defaultPrevented).toBe(false);
      await expect.element(search).toBeVisible();
      await expectDraft(screen, "hello world");
    },
  );

  it("routes a paste on a focused composer control only while no popup is open", async () => {
    await using screen = await renderComposer();
    const toggle = screen.getByRole("button", { name: /click to enter plan mode/i });
    (toggle.element() as HTMLElement).focus();
    const listener = (event: ClipboardEvent) => {
      routed.push(isComposerControlPaste(event));
    };
    const routed: boolean[] = [];
    window.addEventListener("paste", listener, true);
    try {
      pasteOnFocused("text");
      await userEvent.click(screen.getByRole("combobox", { name: "Runtime mode" }));
      await expect.element(page.getByRole("listbox")).toBeVisible();
      (toggle.element() as HTMLElement).focus();
      pasteOnFocused("text");
    } finally {
      window.removeEventListener("paste", listener, true);
    }
    expect(routed).toEqual([true, false]);
  });
});
