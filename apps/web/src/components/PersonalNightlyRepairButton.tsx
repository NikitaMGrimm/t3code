import { useAtomValue } from "@effect/atom-react";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import {
  squashAtomCommandFailure,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthSourceControlWriteScope,
  CommandId,
  type EnvironmentId,
  type OrchestrationV2ThreadLaunchInput,
  type ScopedThreadRef,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import {
  personalUpdateRepairKey,
  personalUpdateRepairPrompt,
  type PersonalUpdateStatus,
} from "@t3tools/shared/personalUpdate";
import personalNightly from "../../../../personal-nightly.json";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useNavigate } from "@tanstack/react-router";
import { WrenchIcon } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { newMessageId, newThreadId, randomUUID } from "~/lib/utils";
import { resolveDefaultProviderModelSelection } from "~/providerInstances";
import { useProjects, useServerConfigs } from "~/state/entities";
import {
  useEnvironments,
  useEnvironmentProviders,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
} from "./ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "./ui/select";
import { toastManager } from "./ui/toast";

type Repair = {
  readonly environmentId: EnvironmentId;
  readonly input: OrchestrationV2ThreadLaunchInput;
  readonly state: "starting" | "started" | "failed";
  readonly threadRef?: ScopedThreadRef;
};
// Both entry points share the in-flight command and its receipt. A retry keeps
// the command ID so a lost response cannot start another agent.
let repairs: ReadonlyMap<string, Repair> = new Map();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getRepairs = () => repairs;
function setRepair(key: string, repair: Repair) {
  repairs = new Map(repairs).set(key, repair);
  for (const listener of listeners) listener();
}

export function PersonalNightlyRepairButton({ status }: { status: PersonalUpdateStatus }) {
  const navigate = useNavigate();
  const projects = useProjects();
  const configs = useServerConfigs();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const activeEnvironmentId = usePrimaryEnvironmentId();
  const candidates = projects.filter((project) => {
    const repository = project.repositoryIdentity?.canonicalKey.toLowerCase();
    return (
      (repository === `github.com/${personalNightly.repository.toLowerCase()}` ||
        repository === `github.com/${personalNightly.upstreamRepository.toLowerCase()}`) &&
      environments.some(
        (environment) =>
          environment.environmentId === project.environmentId &&
          environment.connection.phase === "connected",
      )
    );
  });
  const [choosing, setChoosing] = useState(false);
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const project =
    candidates.find(
      (candidate) =>
        scopedProjectKey({ environmentId: candidate.environmentId, projectId: candidate.id }) ===
        chosenKey,
    ) ??
    candidates.find((candidate) => candidate.environmentId === activeEnvironmentId) ??
    candidates[0];
  const environmentId = project?.environmentId ?? null;
  const allowed = useAtomValue(
    orchestrationEnvironment.v2.launchThread.permissionAtom(environmentId),
  );
  const canWrite = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const launch = useAtomCommand(orchestrationEnvironment.v2.launchThread, { reportFailure: false });
  const snapshot = useSyncExternalStore(subscribe, getRepairs, getRepairs);
  const key = personalUpdateRepairKey(status);
  const repair = snapshot.get(key);
  const starting = repair?.state === "starting";

  const openThread = (ref: ScopedThreadRef) =>
    navigate({ to: "/$environmentId/$threadId", params: ref });

  const start = async () => {
    const existing = repairs.get(key);
    if (existing?.state === "started" && existing.threadRef) {
      setChoosing(false);
      await openThread(existing.threadRef);
      return;
    }
    if (existing?.state === "starting" || !project || !allowed || !canWrite) return;
    const config = configs.get(project.environmentId);
    if (!config) return;
    const settings = resolveProjectSettings(config.settings, project.id, project).settings;
    const providers = (providersByEnvironment.get(project.environmentId) ?? []).filter((provider) =>
      resolveProjectProviderInstanceEnabled(settings, project.id, provider.instanceId),
    );
    const modelSelection = resolveDefaultProviderModelSelection(
      providers,
      settings.defaultModelSelection,
    );
    if (!modelSelection) {
      toastManager.add({
        type: "error",
        title: "No agent available",
        description: "Enable a provider for the T3 Code project, then try again.",
      });
      return;
    }
    const request =
      existing?.environmentId === project.environmentId && existing.input.projectId === project.id
        ? existing
        : {
            environmentId: project.environmentId,
            state: "starting" as const,
            input: {
              commandId: CommandId.make(randomUUID()),
              creationSource: "web" as const,
              threadId: newThreadId(),
              projectId: project.id,
              title: "Repair personal nightly",
              modelSelection,
              runtimeMode: settings.defaultRuntimeMode,
              interactionMode: "default" as const,
              workspaceStrategy: {
                type: "worktree" as const,
                // An upstream checkout may have no fork remote or tracking branch.
                // Let the agent fetch the explicit fork before making changes.
                baseRef: "HEAD",
                startFromOrigin: false,
              },
              initialMessage: {
                messageId: newMessageId(),
                text: personalUpdateRepairPrompt(status),
                attachments: [],
              },
            },
          };
    setRepair(key, { ...request, state: "starting" });
    setChoosing(false);
    const result = await launch({ environmentId: request.environmentId, input: request.input });
    if (result._tag === "Failure") {
      setRepair(key, { ...request, state: "failed" });
      const error = isAtomCommandInterrupted(result) ? null : squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not start the repair",
        description: error instanceof Error ? error.message : "Check the connection and try again.",
      });
      return;
    }
    const ref = { environmentId: request.environmentId, threadId: result.value.threadId };
    setRepair(key, { ...request, state: "started", threadRef: ref });
    await openThread(ref);
  };
  const onClick = () => {
    if (repair?.state === "started") {
      void start();
      return;
    }
    if (candidates.length > 1) setChoosing(true);
    else void start();
  };
  const cannotStart = starting || !project || !allowed || !canWrite;
  const disabled =
    starting || (repair?.state !== "started" && candidates.length < 2 && cannotStart);
  return (
    <>
      <Button
        variant="outline"
        size="xs"
        disabled={disabled}
        title={
          !project
            ? "Connect a T3 Code source project to repair this nightly."
            : candidates.length < 2 && (!allowed || !canWrite)
              ? "This connection needs permission to run agents and change source control."
              : undefined
        }
        onClick={onClick}
      >
        <WrenchIcon />
        {starting
          ? "Starting repair…"
          : repair?.state === "started"
            ? "Open repair thread"
            : "Repair personal nightly"}
      </Button>
      <Dialog open={choosing} onOpenChange={setChoosing}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Repair personal nightly</DialogTitle>
            <DialogDescription>
              Choose where the agent should work. It starts in a separate worktree using that
              project's default model and permissions.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Select
              value={
                project
                  ? scopedProjectKey({
                      environmentId: project.environmentId,
                      projectId: project.id,
                    })
                  : null
              }
              onValueChange={setChosenKey}
            >
              <SelectTrigger aria-label="Repair project">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {candidates.map((candidate) => {
                  const value = scopedProjectKey({
                    environmentId: candidate.environmentId,
                    projectId: candidate.id,
                  });
                  const label = `${candidate.title} · ${environments.find((environment) => environment.environmentId === candidate.environmentId)?.label ?? candidate.environmentId} · ${candidate.workspaceRoot}`;
                  return (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  );
                })}
              </SelectPopup>
            </Select>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setChoosing(false)}>
              Cancel
            </Button>
            <Button disabled={cannotStart} onClick={() => void start()}>
              Start repair
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
