import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import "~/index.css";

function DictationControl() {
  const [recording, setRecording] = useState(false);
  return (
    <button onClick={() => setRecording((current) => !current)}>
      {recording ? "Stop dictation" : "Dictate"}
    </button>
  );
}

function Actions({ mode = "send" }: { mode?: "send" | "stop" | "question" }) {
  const [tokens, setTokens] = useState<number | null>(12_345);
  const [keepFullHistory, setKeepFullHistory] = useState(false);
  return (
    <>
      <button onClick={() => setTokens((current) => (current === null ? 12_345 : null))}>
        Toggle chip
      </button>
      <div className="flex w-160 items-center justify-end gap-2">
        <ComposerPrimaryActions
          compact={false}
          canOperateThread
          pendingAction={
            mode === "question"
              ? {
                  questionIndex: 1,
                  isLastQuestion: false,
                  canAdvance: true,
                  isResponding: false,
                  isComplete: true,
                }
              : null
          }
          isRunning={mode !== "send"}
          canInterrupt={mode !== "send"}
          isSendBusy={false}
          sendDisabledReason={null}
          isEnvironmentUnavailable={false}
          isPreparingWorktree={false}
          hasSendableContent={mode === "send"}
          onPreviousPendingQuestion={() => {}}
          onInterrupt={() => {}}
          compactBeforeSendTokens={tokens}
          keepFullHistory={keepFullHistory}
          onToggleKeepFullHistory={() => setKeepFullHistory((current) => !current)}
          leadingActions={<button aria-label="Attach">Attach</button>}
        >
          <DictationControl />
        </ComposerPrimaryActions>
      </div>
    </>
  );
}

it("keeps the attach control mounted and stationary as the Compact chip changes", async () => {
  await using screen = await render(<Actions />);
  await document.fonts.ready;
  const attach = screen.container.querySelector<HTMLButtonElement>('button[aria-label="Attach"]')!;
  const dictate = [...screen.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Dictate",
  )!;
  await act(() => dictate.click());
  expect(dictate.textContent).toBe("Stop dictation");
  const left = attach.getBoundingClientRect().left;
  const chip = screen.container.querySelector<HTMLButtonElement>('button[aria-label^="Compact "]')!;
  await act(() => chip.click());
  expect(attach.getBoundingClientRect().left).toBeCloseTo(left, 1);
  await act(() =>
    [...screen.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Toggle chip")!
      .click(),
  );
  expect(screen.container.querySelector('button[aria-label="Attach"]')).toBe(attach);
  expect(attach.getBoundingClientRect().left).toBeCloseTo(left, 1);
  expect(dictate.isConnected).toBe(true);
  expect(dictate.textContent).toBe("Stop dictation");
  const buttons = [...attach.parentElement!.querySelectorAll("button")];
  expect(
    buttons.slice(-3).map((button) => button.getAttribute("aria-label") ?? button.textContent),
  ).toEqual(["Attach", "Stop dictation", "Submit message"]);
});

it.each(["stop", "question"] as const)(
  "keeps dictation next to the %s action after the attach control",
  async (mode) => {
    await using screen = await render(<Actions mode={mode} />);
    const attach = screen.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Attach"]',
    )!;
    const buttons = [...attach.parentElement!.querySelectorAll("button")];
    expect(
      buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent),
    ).toEqual(
      mode === "stop"
        ? ["Attach", "Dictate", "Stop generation"]
        : ["Attach", "Stop generation", "Previous", "Dictate", "Next question"],
    );
    const dictate = buttons.find((button) => button.textContent === "Dictate")!;
    await act(() => dictate.click());
    expect(dictate.textContent).toBe("Stop dictation");
  },
);
