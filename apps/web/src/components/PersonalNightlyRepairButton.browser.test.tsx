import "../index.css";
import { Atom, AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadLaunchInput,
} from "@t3tools/contracts";
import { decodePersonalUpdateStatus } from "@t3tools/shared/personalUpdate";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render";

const state = vi.hoisted(() => ({
  deniedEnvironment: null as string | null,
  allowed: true,
  launch: vi.fn(),
  navigate: vi.fn(),
  projects: [] as Array<unknown>,
  configs: new Map(),
  environments: [] as Array<unknown>,
  providers: new Map(),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => state.navigate,
}));
vi.mock("~/state/entities", () => ({
  useProjects: () => state.projects,
  useServerConfigs: () => state.configs,
  useActiveEnvironmentId: () => null,
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
  useEnvironmentProviders: () => state.providers,
}));
vi.mock("~/state/session", () => ({
  useEnvironmentScope: (id: string) => state.allowed && id !== state.deniedEnvironment,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.launch }));
vi.mock("~/state/orchestration", () => ({
  orchestrationEnvironment: {
    v2: {
      launchThread: {
        permissionAtom: (id: string) => Atom.make(state.allowed && id !== state.deniedEnvironment),
      },
    },
  },
}));

import { PersonalNightlyRepairButton } from "./PersonalNightlyRepairButton";
import { ToastProvider } from "./ui/toast";

function setup(episode: string) {
  state.allowed = true;
  state.deniedEnvironment = null;
  state.launch.mockReset();
  state.navigate.mockReset().mockResolvedValue(undefined);
  const environmentId = EnvironmentId.make("repair-environment");
  const projectId = ProjectId.make("repair-project");
  const modelSelection = {
    instanceId: ProviderInstanceId.make("custom-codex"),
    model: "gpt-6.1-sol",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  state.projects = [
    {
      id: projectId,
      environmentId,
      title: "T3 Code",
      workspaceRoot: "/source/t3code",
      repositoryIdentity: { canonicalKey: "github.com/pingdotgg/t3code" },
      defaultModelSelection: modelSelection,
    },
  ];
  state.configs = new Map([
    [
      environmentId,
      {
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          defaultRuntimeMode: "auto",
          providerInstances: { [modelSelection.instanceId]: { driver: "codex", enabled: true } },
        },
      },
    ],
  ]);
  state.environments = [
    { environmentId, label: "Development VPS", connection: { phase: "connected" } },
  ];
  state.providers = new Map([
    [
      environmentId,
      [
        {
          instanceId: modelSelection.instanceId,
          driver: "codex",
          enabled: true,
          installed: true,
          authenticated: true,
          status: "ready",
          models: [{ slug: modelSelection.model, name: "GPT 6.1 Sol", isDefault: true }],
        },
      ],
    ],
  ]);
  const status = decodePersonalUpdateStatus({
    schema: 1,
    phase: "conflict",
    upstreamTag: "v0.1.2-nightly.20261021.3486",
    conflicts: ["pnpm-lock.yaml"],
    conflictIdentity: episode,
    conflictPullRequest: 22883,
    runUrl: "https://github.com/NikitaMGrimm/t3code/actions/runs/39661444253",
    releasedVersion: null,
    baseCommit: "a".repeat(40),
  });
  return { status, environmentId, projectId, modelSelection };
}

it("starts one isolated repair with the failure context and shares its thread across entry points", async () => {
  const { status, environmentId, projectId, modelSelection } = setup("repair-shared-receipt");
  let finish!: (value: unknown) => void;
  state.launch.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await using screen = await render(
    <>
      <PersonalNightlyRepairButton status={status} />
      <PersonalNightlyRepairButton status={status} />
    </>,
  );
  await screen.getByRole("button", { name: "Repair personal nightly" }).first().click();
  await expect
    .element(screen.getByRole("button", { name: "Starting repair…" }).first())
    .toBeDisabled();
  await expect
    .element(screen.getByRole("button", { name: "Starting repair…" }).nth(1))
    .toBeDisabled();
  expect(state.launch).toHaveBeenCalledTimes(1);
  const sent = state.launch.mock.calls[0]![0] as {
    environmentId: EnvironmentId;
    input: OrchestrationV2ThreadLaunchInput;
  };
  expect(sent).toMatchObject({
    environmentId,
    input: {
      projectId,
      modelSelection,
      runtimeMode: "auto",
      interactionMode: "default",
      workspaceStrategy: { type: "worktree", baseRef: "HEAD", startFromOrigin: false },
    },
  });
  expect(sent.input.initialMessage?.text).toContain("https://github.com/NikitaMGrimm/t3code.git");
  expect(sent.input.initialMessage?.text).toContain("Do not assume origin");
  expect(sent.input.initialMessage?.text).toContain(status.baseCommit);
  expect(sent.input.initialMessage?.text).toContain(status.runUrl);
  finish(AsyncResult.success({ threadId: ThreadId.make("repair-started") }));
  await expect
    .element(screen.getByRole("button", { name: "Open repair thread" }).nth(1))
    .toBeEnabled();
  await screen.getByRole("button", { name: "Open repair thread" }).nth(1).click();
  expect(state.launch).toHaveBeenCalledTimes(1);
  expect(state.navigate).toHaveBeenLastCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId: "repair-started" },
  });
});

it("retries a failed launch with the same command and thread instead of duplicating an agent", async () => {
  const { status } = setup("repair-retry-receipt");
  state.launch
    .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Offline"))))
    .mockResolvedValueOnce(AsyncResult.success({ threadId: ThreadId.make("retried-repair") }));
  await using screen = await render(
    <ToastProvider>
      <PersonalNightlyRepairButton status={status} />
    </ToastProvider>,
  );
  await screen.getByRole("button", { name: "Repair personal nightly" }).click();
  await expect.element(page.getByText("Could not start the repair")).toBeVisible();
  await screen.getByRole("button", { name: "Repair personal nightly" }).click();
  await expect.element(screen.getByRole("button", { name: "Open repair thread" })).toBeEnabled();
  expect(state.launch.mock.calls[1]![0]).toEqual(state.launch.mock.calls[0]![0]);
});

it("keeps repair unavailable on a connection without write permission", async () => {
  const { status } = setup("repair-read-only");
  state.allowed = false;
  await using screen = await render(<PersonalNightlyRepairButton status={status} />);
  await expect
    .element(screen.getByRole("button", { name: "Repair personal nightly" }))
    .toBeDisabled();
  expect(state.launch).not.toHaveBeenCalled();
});

it("lets a read-only default connection choose a writable repair destination", async () => {
  const { status, environmentId } = setup("repair-choose-writable");
  const writable = EnvironmentId.make("writable-environment");
  state.deniedEnvironment = environmentId;
  state.projects = [
    state.projects[0],
    { ...(state.projects[0] as object), environmentId: writable, title: "Writable T3" },
  ];
  state.environments.push({
    environmentId: writable,
    label: "Writable host",
    connection: { phase: "connected" },
  });
  state.configs.set(writable, state.configs.get(environmentId));
  state.providers.set(writable, state.providers.get(environmentId));
  state.launch.mockResolvedValue(
    AsyncResult.success({ threadId: ThreadId.make("writable-repair") }),
  );
  await using screen = await render(<PersonalNightlyRepairButton status={status} />);
  await screen.getByRole("button", { name: "Repair personal nightly" }).click();
  await expect.element(page.getByRole("button", { name: "Start repair" })).toBeDisabled();
  await page.getByRole("combobox", { name: "Repair project" }).click();
  await page.getByRole("option", { name: /Writable T3/ }).click();
  await page.getByRole("button", { name: "Start repair" }).click();
  await expect.element(screen.getByRole("button", { name: "Open repair thread" })).toBeEnabled();
  expect(state.launch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ environmentId: writable }),
  );
});
