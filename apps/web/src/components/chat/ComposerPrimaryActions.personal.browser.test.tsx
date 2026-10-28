import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import "~/index.css";

function Actions() {
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
          pendingAction={null}
          isRunning={false}
          canInterrupt={false}
          showPlanFollowUpPrompt={false}
          promptHasText
          isSendBusy={false}
          sendDisabledReason={null}
          isEnvironmentUnavailable={false}
          isPreparingWorktree={false}
          hasSendableContent
          onPreviousPendingQuestion={() => {}}
          onInterrupt={() => {}}
          onImplementPlanInNewThread={() => {}}
          compactBeforeSendTokens={tokens}
          keepFullHistory={keepFullHistory}
          onToggleKeepFullHistory={() => setKeepFullHistory((current) => !current)}
          leadingActions={<button aria-label="Attach">Attach</button>}
        />
      </div>
    </>
  );
}

it("keeps the attach control mounted and stationary as the Compact chip changes", async () => {
  await using screen = await render(<Actions />);
  await document.fonts.ready;
  const attach = screen.container.querySelector<HTMLButtonElement>('button[aria-label="Attach"]')!;
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
});
