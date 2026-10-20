import "~/index.css";

import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: () => null,
  useSidebarStageBackdropVariant: () => null,
}));

import { render } from "../../../test/render";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

type Props = ComponentProps<typeof ComposerPrimaryActions>;

const sendProps: Props = {
  compact: true,
  canOperateThread: true,
  pendingAction: null,
  isRunning: false,
  canInterrupt: false,
  showPlanFollowUpPrompt: false,
  promptHasText: true,
  isSendBusy: false,
  sendDisabledReason: null,
  isConnecting: false,
  isEnvironmentUnavailable: false,
  isPreparingWorktree: false,
  hasSendableContent: true,
  onPreviousPendingQuestion: () => {},
  onInterrupt: () => {},
  onImplementPlanInNewThread: () => {},
};

const pendingProps: Props = {
  ...sendProps,
  pendingAction: {
    questionIndex: 0,
    isLastQuestion: true,
    canAdvance: true,
    isResponding: false,
    isComplete: true,
  },
  promptHasText: false,
  hasSendableContent: false,
};

const attach = <button type="button">Attach</button>;

async function renderActions(props: Props) {
  await using stack = new AsyncDisposableStack();
  const tabStart = document.body.appendChild(document.createElement("button"));
  stack.defer(() => tabStart.remove());
  const screen = stack.use(
    await render(<ComposerPrimaryActions {...props} leadingActions={attach} />),
  );
  return Object.assign(stack.move(), { screen, tabStart });
}

async function tabOrder({ screen, tabStart }: Awaited<ReturnType<typeof renderActions>>) {
  const labels: string[] = [];
  tabStart.focus();
  for (const _ of screen.container.querySelectorAll("button")) {
    await userEvent.tab();
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement) || !screen.container.contains(focused)) break;
    labels.push(focused.getAttribute("aria-label") ?? focused.textContent?.trim() ?? "");
  }
  return labels;
}

it("keeps the Compact chip ahead of attach and send in both of its states", async () => {
  const chip = "Compact 169k tokens of history before sending";
  await using fixture = await renderActions({ ...sendProps, compactBeforeSendTokens: 169_000 });
  expect(await tabOrder(fixture)).toEqual([chip, "Attach", "Compact and send"]);

  await fixture.screen.rerender(
    <ComposerPrimaryActions
      {...sendProps}
      compactBeforeSendTokens={169_000}
      keepFullHistory
      leadingActions={attach}
    />,
  );
  expect(await tabOrder(fixture)).toEqual([chip, "Attach", "Submit message"]);
});

it("keeps attach ahead of the primary action in every composer state", async () => {
  const cases: Array<[Props, string[]]> = [
    [sendProps, ["Attach", "Submit message"]],
    [pendingProps, ["Attach", "Submit"]],
    [{ ...sendProps, showPlanFollowUpPrompt: true }, ["Attach", "Refine"]],
    [
      { ...sendProps, showPlanFollowUpPrompt: true, promptHasText: false },
      ["Attach", "Implement", "Implementation actions"],
    ],
    [
      { ...sendProps, canInterrupt: true, hasSendableContent: false },
      ["Attach", "Stop generation"],
    ],
  ];
  for (const [props, expected] of cases) {
    await using fixture = await renderActions(props);
    expect(await tabOrder(fixture)).toEqual(expected);
  }
});

it("opens implementation actions with a mouse while the composer is resting", async () => {
  const onImplementPlanInNewThread = vi.fn();
  await using _screen = await render(
    <ComposerPrimaryActions
      compact={false}
      canOperateThread
      pendingAction={null}
      isRunning={false}
      canInterrupt={false}
      showPlanFollowUpPrompt
      promptHasText={false}
      isSendBusy={false}
      sendDisabledReason={null}
      isConnecting={false}
      isEnvironmentUnavailable={false}
      isPreparingWorktree={false}
      hasSendableContent={false}
      preserveComposerFocusOnPointerDown
      onPreviousPendingQuestion={() => {}}
      onInterrupt={() => {}}
      onImplementPlanInNewThread={onImplementPlanInNewThread}
    />,
  );

  await userEvent.click(page.getByRole("button", { name: "Implementation actions" }));
  const item = page.getByRole("menuitem", { name: "Implement in a new thread" });
  await expect.element(item).toBeVisible();
  await userEvent.click(item);
  expect(onImplementPlanInNewThread).toHaveBeenCalledTimes(1);
});
