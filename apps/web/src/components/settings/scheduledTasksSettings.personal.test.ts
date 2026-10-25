import {
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { scheduleFromDraft, taskToDraft } from "./scheduledTasksSettings.logic";

const legacyTask: ScheduledTask = {
  id: ScheduledTaskId.make("legacy-task"),
  title: "Review issues",
  prompt: "Review open issues",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId: ProjectId.make("project"),
  threadId: null,
  workspaceStrategy: { type: "worktree", baseRef: "release" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
};

describe("personal scheduled time editing", () => {
  it.each([
    ["0:05", "00:05"],
    ["9:00", "09:00"],
    ["09:00", "09:00"],
    ["23:59", "23:59"],
  ])("preserves the scheduled time when editing %s", (timeOfDay, canonicalTime) => {
    const draft = taskToDraft({
      ...legacyTask,
      schedule: { type: "fixed_time", timeOfDay },
    });
    expect(draft.timeOfDay).toBe(canonicalTime);
    expect(scheduleFromDraft({ ...draft, title: "Updated title" })).toMatchObject({
      type: "fixed_time",
      timeOfDay: canonicalTime,
    });
  });
});
