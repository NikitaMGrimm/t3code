import type {
  OrchestrationV2Notification,
  PullRequestCheck,
  PullRequestComment,
  PullRequestDetail,
  ThreadPullRequestWatch,
} from "@t3tools/contracts";

/**
 * Wakes in a row that bring only comments. Check, conflict, or push news resets the count, so
 * this only stops a chatty bot looping an agent that is replying to it.
 */
export const PULL_REQUEST_WATCH_WAKE_LIMIT = 10;
const LISTED_ITEMS = 10;
const SNIPPET_LENGTH = 200;

export type PullRequestWatchChange =
  | { readonly kind: "checks-failed"; readonly failed: ReadonlyArray<PullRequestCheck> }
  | { readonly kind: "checks-passed"; readonly count: number; readonly required: boolean }
  | { readonly kind: "remarks"; readonly remarks: ReadonlyArray<PullRequestComment> }
  | { readonly kind: "conflicting" };

export interface PullRequestWatchReport {
  /** What the agent has not been told yet. Empty means no wake. */
  readonly changes: ReadonlyArray<PullRequestWatchChange>;
  /** The watch to record, whether or not anything is reported. */
  readonly next: ThreadPullRequestWatch;
  /** This report spends the last wake before the limit, so watching stops after it. */
  readonly exhausted: boolean;
}

// "action-required" is a finished check that needs someone, so the agent hears about it.
const isFailedCheck = (check: PullRequestCheck) =>
  check.status === "failure" || check.status === "cancelled" || check.status === "action-required";

/**
 * Compares a watched pull request with what its agent was last told. Each check is reported as
 * soon as it fails, so a check that never finishes (an advisory review bot) cannot hold the
 * news back. "Passed" is reported once the checks the base branch requires all passed, or all
 * checks where the host marks none required. Remarks count when someone other than the agent's
 * own account wrote them, so its own replies never wake it. `remarks` is null when the
 * conversation could not be read; remarks then wait for a later pass.
 */
export function evaluatePullRequestWatch(
  watch: ThreadPullRequestWatch,
  detail: Pick<PullRequestDetail, "headSha" | "checks" | "mergeability" | "viewer" | "author">,
  remarks: ReadonlyArray<PullRequestComment> | null,
): PullRequestWatchReport {
  const changes: Array<PullRequestWatchChange> = [];
  const headSha = detail.headSha ?? null;
  const headMoved = headSha !== watch.headSha;

  // An empty list keeps the last state: a host can answer with one when its check read fails.
  let failedChecks = headMoved ? [] : watch.failedChecks;
  let passed = headMoved ? false : watch.passed;
  let passedChecks = headMoved ? [] : watch.passedChecks;
  if (detail.checks.length > 0) {
    const failed = detail.checks.filter(isFailedCheck);
    const newlyFailed = failed.filter((check) => !failedChecks.includes(check.name));
    if (newlyFailed.length > 0) changes.push({ kind: "checks-failed", failed: newlyFailed });
    // A check that runs again leaves the list, so a rerun that fails again is reported.
    failedChecks = failed.map((check) => check.name);

    const required = detail.checks.filter((check) => check.required === true);
    const gate = required.length > 0 ? required : detail.checks;
    const passedNow = gate.every((check) => check.status !== "pending" && !isFailedCheck(check));
    const gateNames = gate.map((check) => check.name);
    // A watch saved before passedChecks existed takes the current names, so it does not wake.
    const told = passed && passedChecks.length === 0 ? gateNames : passedChecks;
    // A required job created and finished between two passes is never seen pending. Without
    // required checks, any check counts, and advisory bots keep adding passed ones: no wake.
    const gateGrew = required.length > 0 && gateNames.some((name) => !told.includes(name));
    if (passedNow && (!passed || gateGrew)) {
      changes.push({ kind: "checks-passed", count: gate.length, required: required.length > 0 });
    }
    passed = passedNow;
    passedChecks = passedNow ? gateNames : [];
  }

  const own = (detail.viewer ?? detail.author?.login)?.toLowerCase();
  const through = Date.parse(watch.remarksThrough);
  // An edit counts as new activity, so bots that rewrite one summary comment still wake the agent.
  const activeAt = (remark: PullRequestComment) => remark.editedAt ?? remark.createdAt;
  // GitHub times are per second, so remarks at the boundary time are told apart by ID.
  const fresh = (remarks ?? []).filter((remark) => {
    const at = Date.parse(activeAt(remark));
    return (
      (at > through || (at === through && !watch.remarkIds.includes(remark.id))) &&
      remark.author?.login.toLowerCase() !== own
    );
  });
  if (fresh.length > 0) changes.push({ kind: "remarks", remarks: fresh });
  const latest = Math.max(through, ...fresh.map((remark) => Date.parse(activeAt(remark))));
  const atLatest = fresh.filter((remark) => Date.parse(activeAt(remark)) === latest);
  const remarksThrough = latest === through ? watch.remarksThrough : activeAt(atLatest[0]!);
  const remarkIds = [
    ...(latest === through ? watch.remarkIds : []),
    ...atLatest.map((remark) => remark.id),
  ];

  if (detail.mergeability === "conflicting" && !watch.conflicting) {
    changes.push({ kind: "conflicting" });
  }
  // "unknown" is GitHub still computing after a push; only a clean answer clears a conflict.
  const conflicting =
    detail.mergeability === "unknown" ? watch.conflicting : detail.mergeability === "conflicting";

  const commentsOnly = changes.length > 0 && changes.every((change) => change.kind === "remarks");
  const progress = headMoved || (changes.length > 0 && !commentsOnly);
  const wakes = (progress ? 0 : watch.wakes) + (commentsOnly ? 1 : 0);
  return {
    changes,
    next: {
      startedAt: watch.startedAt,
      headSha,
      failedChecks,
      passed,
      passedChecks,
      remarksThrough,
      remarkIds,
      conflicting,
      wakes,
    },
    exhausted: commentsOnly && wakes >= PULL_REQUEST_WATCH_WAKE_LIMIT,
  };
}

function snippet(body: string): string {
  const text = body
    .replaceAll(/<!--[\s\S]*?-->/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return text.length <= SNIPPET_LENGTH ? text : `${text.slice(0, SNIPPET_LENGTH - 3)}...`;
}

function listed<T>(items: ReadonlyArray<T>, line: (item: T) => string): Array<string> {
  const lines = items.slice(0, LISTED_ITEMS).map(line);
  if (items.length > LISTED_ITEMS) lines.push(`  - and ${items.length - LISTED_ITEMS} more`);
  return lines;
}

function changeLines(
  change: PullRequestWatchChange,
  context: { readonly baseBranch: string; readonly commit: string },
): Array<string> {
  switch (change.kind) {
    case "checks-failed":
      return [
        `- Checks failed${context.commit}:`,
        ...listed(
          change.failed,
          (check) =>
            `  - ${check.name}${check.status === "failure" ? "" : ` (${check.status})`}${check.url ? ` ${check.url}` : ""}`,
        ),
      ];
    case "checks-passed":
      return [
        `- All ${change.count} ${change.required ? "required " : ""}${change.count === 1 ? "check" : "checks"} passed${context.commit}.`,
      ];
    case "remarks":
      return [
        `- ${change.remarks.length} new ${change.remarks.length === 1 ? "comment" : "comments"}:`,
        ...listed(change.remarks, (remark) => {
          const where = remark.path === null ? "" : ` on ${remark.path}`;
          const body = snippet(remark.body);
          const said = body.length === 0 ? (remark.reviewState ?? "reviewed") : `"${body}"`;
          return `  - ${remark.author?.login ?? "someone"}${where}: ${said}${remark.url ? ` ${remark.url}` : ""}`;
        }),
      ];
    case "conflicting":
      return [`- The branch now conflicts with ${context.baseBranch}.`];
  }
}

const SUMMARY: Record<PullRequestWatchChange["kind"], string> = {
  "checks-failed": "checks failed",
  "checks-passed": "checks passed",
  remarks: "new comments",
  conflicting: "merge conflict",
};

/** What a pass has to tell a thread's agent about one pull request it watches. */
export interface PullRequestWatchNews {
  readonly repository: string;
  readonly number: number;
  /** The news itself, complete without the other pull requests' news. */
  readonly text: string;
  /** The watch goes on after this news. */
  readonly watching: boolean;
  readonly outcome: OrchestrationV2Notification["outcome"];
  /** The news in a few words, for the timeline. */
  readonly summary: string;
}

/** What changed on a watched pull request, as news for its agent. */
export function pullRequestWatchNews(input: {
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly baseBranch: string;
  readonly headSha: string | null;
  readonly report: PullRequestWatchReport;
}): PullRequestWatchNews {
  const { changes, exhausted } = input.report;
  const context = {
    baseBranch: input.baseBranch,
    commit: input.headSha === null ? "" : ` on ${input.headSha.slice(0, 7)}`,
  };
  const failed = changes.some(
    (change) => change.kind === "checks-failed" || change.kind === "conflicting",
  );
  const summary = changes.map((change) => SUMMARY[change.kind]);
  if (exhausted) summary.push("stopped watching");
  return {
    repository: input.repository,
    number: input.number,
    text: [
      `Update on pull request #${input.number} (${input.url}), which T3 Code is watching for you:`,
      ...changes.flatMap((change) => changeLines(change, context)),
      ...(exhausted
        ? [
            "",
            `T3 Code stopped watching after ${PULL_REQUEST_WATCH_WAKE_LIMIT} comment-only updates in a row. Call watch_pull_request to watch it again.`,
          ]
        : []),
    ].join("\n"),
    watching: !exhausted,
    outcome: failed
      ? "failed"
      : changes.every((change) => change.kind === "checks-passed")
        ? "completed"
        : "updated",
    summary: summary.join(", "),
  };
}

/**
 * The wake the agent reads and the timeline notification the user sees. One pass sends a thread
 * one wake for all the pull requests it watches, so news on several of them is one turn.
 */
export function pullRequestWatchMessage(news: ReadonlyArray<PullRequestWatchNews>): {
  readonly text: string;
  readonly notification: OrchestrationV2Notification;
} {
  const ordered = news.toSorted((left, right) => left.number - right.number);
  // Two repositories can use the same number, and only then does the timeline need the name.
  const label = (item: PullRequestWatchNews) =>
    ordered.some((other) => other.number === item.number && other.repository !== item.repository)
      ? `${item.repository}#${item.number}`
      : `#${item.number}`;
  // Pull requests with the same news share one entry: "#7, #9: new comments".
  const labels = new Map<string, Array<string>>();
  for (const item of ordered) {
    labels.set(item.summary, [...(labels.get(item.summary) ?? []), label(item)]);
  }
  const text = [
    ...(ordered.length > 1
      ? [`T3 Code has news on ${ordered.length} pull requests it is watching for you.`]
      : []),
    ...ordered.map((item) => item.text),
    ...(ordered.some((item) => item.watching)
      ? [
          "Look into each item and act on it as your task requires. T3 Code keeps watching and wakes you on the next change, so end your turn when you are done. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.",
        ]
      : []),
  ].join("\n\n");
  return {
    text,
    notification: {
      source: { kind: "monitor" },
      outcome: ordered.some((item) => item.outcome === "failed")
        ? "failed"
        : ordered.every((item) => item.outcome === "completed")
          ? "completed"
          : "updated",
      summary: [...labels].map(([summary, group]) => `${group.join(", ")}: ${summary}`).join("; "),
    },
  };
}
