import { useEffect, useRef, useState } from "react";
import { Blocks, CircleCheck, CircleDashed, CircleX } from "lucide-react";
import { formatToolCallDuration } from "@/lib/tool-call-duration";
import { isToolPartInFlight } from "@/lib/tool-activity";
import { useOptionalMessageList } from "./message-list-provider";
import { useCurrentSessionActivityStatus } from "./current-tool-lifecycle-context";
import {
  appCreationProgress,
  appRead,
  isAppGuidePart,
  type AppCreationRun,
} from "@/react-app/domains/apps/app-creation-progress";
import { appBuilderResultFailed } from "@/react-app/domains/apps/built-mcp-app-model";
import { BuiltAppChatPreview } from "@/react-app/domains/apps/built-app-chat-preview";
import { DetailsToggle, TechnicalDetailsPanel } from "./capability-call-line";
import type { DynamicToolUIPart } from "ai";

/**
 * Den's build rejection, shortened to what changed: "MCP App compilation
 * failed. Generated MCP Apps cannot use timers. Use …" → "Can't use timers".
 */
export function appBuildProblem(part: DynamicToolUIPart): string | null {
  if (part.state !== "output-error" || !part.errorText.trim()) return null;
  const sentences = part.errorText.replace(/\s+/g, " ").trim().split(/(?<=\.)\s+/);
  const reason = sentences.find((sentence) => !/compilation failed|^error:/i.test(sentence)) ?? sentences[0] ?? "";
  return reason
    .replace(/^Generated MCP Apps cannot /i, "Can’t ")
    .replace(/\.$/, "")
    .slice(0, 120) || null;
}

type StageState = "done" | "active" | "failed" | "pending";
type Stage = { key: string; label: string; state: StageState; notes?: string[] };

/**
 * The fixed stages of making an App, each labelled from the agent's own
 * calls: the tools it searched and prepare_app checked, the source it is
 * writing, each problem it fixed, and the build. Edits read the App instead
 * of finding and checking tools.
 */
function appCreationStages(
  run: AppCreationRun,
  progress: ReturnType<typeof appCreationProgress>,
  editing: boolean,
  fixedProblems: string[],
  latestProblem: string | null,
): Stage[] {
  const discoveries = run.discoveries ?? [];
  const searches = discoveries.filter((part) => /(?:^|_)search_capabilities$/.test(part.toolName));
  const query = Reflect.get(Object(searches.at(-1)?.input), "query");
  const build = progress.build;
  const built = Boolean(progress.app || progress.builtUnrecorded);
  const building = Boolean(build && build.state !== "input-streaming");
  const writing = progress.stage === "writing" || Boolean(build) || (run.script !== undefined && run.script.kind !== "prepare");
  const checking = Boolean(run.preparation) || run.script?.kind === "prepare"
    || (discoveries.length > 0 && !searches.some(isToolPartInFlight));
  const preparationFailed = Boolean(run.preparation && appBuilderResultFailed(run.preparation) && !progress.preparation);
  // The stage the agent is on; every earlier one is done.
  const current = built ? Infinity : building || progress.failed || progress.unavailable ? 3 : writing ? 2 : checking ? 1 : 0;
  const stateOf = (index: number, failed = false): StageState => index < current
    ? "done"
    : index > current ? "pending" : failed ? "failed" : "active";
  const buildFailed = progress.failed || progress.unavailable;
  const buildStage: Stage = {
    key: "build",
    state: stateOf(3, buildFailed),
    label: buildFailed
      ? progress.unavailable ? "Built, but the preview is unavailable" : `Couldn’t build${latestProblem ? `: ${latestProblem}` : " it"}`
      : current > 3 ? "Built and verified" : current === 3 ? "Building and verifying" : "Build and verify",
    ...(fixedProblems.length > 0 ? { notes: fixedProblems.map((problem) => `Fixed: ${problem}`) } : {}),
  };
  const readyStage: Stage = { key: "ready", state: built ? "done" : "pending", label: built ? "Ready" : "Open beside the chat" };

  if (editing) {
    const read = discoveries.map(appRead).find(Boolean);
    return [
      { key: "read", state: "done", label: read?.title ? `Read “${read.title}”` : "Read the App" },
      { key: "write", state: stateOf(2), label: current > 2 ? "Wrote the changes" : current === 2 ? "Writing the changes" : "Write the changes" },
      buildStage,
      readyStage,
    ];
  }
  const count = progress.preparation?.tools.length;
  return [
    {
      key: "find",
      state: stateOf(0),
      label: current > 0
        ? searches.length === 1 && typeof query === "string" && query
          ? `Searched your connections for “${query}”`
          : searches.length > 1 ? `Searched your connections ${searches.length} times`
            : discoveries.some(isAppGuidePart) ? "Read the build guide" : "Chose its tools"
        : current === 0 ? "Finding the right tools" : "Find the right tools",
    },
    {
      key: "check",
      state: stateOf(1, preparationFailed),
      label: preparationFailed
        ? "Couldn’t check the tools"
        : current > 1
          ? count === undefined ? "Tools ready" : count === 0 ? "No tools needed" : `Checked ${count} ${count === 1 ? "tool" : "tools"}`
          : current === 1 ? "Checking the tools" : "Check the tools",
    },
    { key: "write", state: stateOf(2), label: current > 2 ? "Wrote the App" : current === 2 ? "Writing the App" : "Write the App" },
    buildStage,
    readyStage,
  ];
}

function StageMark({ state, running }: { state: StageState; running: boolean }) {
  if (state === "done") {
    return <CircleCheck className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />;
  }
  if (state === "failed") {
    return <CircleX className="size-4 shrink-0 text-destructive" strokeWidth={1.5} aria-hidden="true" />;
  }
  if (state === "active") {
    return <span className="inline-flex size-4 shrink-0 items-center justify-center gap-0.5 rounded-full border border-current text-foreground" aria-hidden="true">
      {[0, 1, 2].map(dot => <span key={dot} className={`size-0.5 rounded-full bg-current ${running ? "ow-app-progress-dot" : ""}`} style={{ animationDelay: `${dot * 160}ms` }} />)}
    </span>;
  }
  return <CircleDashed className="size-4 shrink-0 text-muted-foreground/60" strokeWidth={1.5} aria-hidden="true" />;
}

export function AppBuilderStep({
  run,
  active,
  activity = null,
  startedAt = null,
  completedAt = null,
}: {
  run: AppCreationRun;
  active: boolean;
  startedAt?: number | null;
  completedAt?: number | null;
  /** While the panel is live: the agent's latest thought or call, shown under the active stage. */
  activity?: string | null;
}) {
  const context = useOptionalMessageList();
  const sessionActivity = useCurrentSessionActivityStatus();
  const waiting = active && sessionActivity === "waiting";
  // The App spans many tools. A finished/superseded tool is not a pause
  // while the parent turn is still active; Stop is reflected by active.
  const progress = appCreationProgress(
    run,
    active &&
      !context?.syncDegraded &&
      !waiting,
  );
  const parts = [...(run.executions ?? []), ...(run.attempts ?? []), ...(run.discoveries ?? []), ...(run.preparation ? [run.preparation] : []), ...run.builds];
  const starts = parts.flatMap((part) =>
    typeof part.callProviderMetadata?.openwork?.toolStartedAt === "number"
      ? [part.callProviderMetadata.openwork.toolStartedAt]
      : [],
  );
  const ends = parts.flatMap((part) =>
    typeof part.callProviderMetadata?.openwork?.toolCompletedAt === "number"
      ? [part.callProviderMetadata.openwork.toolCompletedAt]
      : [],
  );
  // A persisted message timestamp also covers engines without per-tool timing.
  // Keep the optimistic fallback stable for the lifetime of this App card.
  const firstObservedAt = useRef(Date.now());
  const beganAt = run.startedAt ?? (starts.length ? Math.min(...starts) : startedAt ?? firstObservedAt.current);
  const [now, setNow] = useState(Date.now);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Earlier rejected builds are progress on the same app, not new apps.
  const fixedProblems = [...(run.attempts ?? []), ...run.builds.slice(0, -1)].flatMap((part) => {
    const problem = appBuildProblem(part);
    return problem ? [problem] : [];
  });
  const latestProblem = progress.build ? appBuildProblem(progress.build) : null;
  useEffect(() => {
    if (!progress.running) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [progress.running]);
  const terminal = progress.app || progress.builtUnrecorded || progress.failed || progress.unavailable;
  const endedAt = terminal ? (ends.length ? Math.max(...ends) : completedAt) : now;
  const elapsed = endedAt === null ? null : Math.max(0, endedAt - beganAt);
  const editing = Boolean(
    run.intent?.kind === "edit" ||
    run.script?.kind === "update" ||
    (progress.build && /(?:^|_)update_app$/.test(progress.build.toolName)),
  );
  const built = Boolean(progress.app || progress.builtUnrecorded);
  const title = progress.title ? ` “${progress.title}”` : "";
  const sentence = built
    ? `${editing ? "Updated" : "Created"} MCP App${title}`
    : progress.failed
      ? `Couldn’t ${editing ? "update" : "create"} MCP App${title}`
      : `${editing ? "Updating" : "Creating"} MCP App${title}`;
  const state = progress.builtUnrecorded
    ? "Open it from your Library"
    : progress.unavailable
      ? "Preview unavailable"
      : !progress.running && !built && !progress.failed && !progress.unavailable
      ? context?.syncDegraded ? "Reconnecting" : waiting ? "Waiting for your response" : "Paused"
      : null;
  const shownElapsed = elapsed !== null && (active || terminal || starts.length > 0) ? formatToolCallDuration(elapsed) : null;

  // The stages show while the agent works, or after it failed or paused; a
  // ready App folds them into one row.
  const stages = built ? [] : appCreationStages(run, progress, editing, fixedProblems, latestProblem);
  const done = stages.filter((stage) => stage.state === "done").length;
  const details = detailsOpen ? (
    <div className="mt-2 flex flex-col gap-2">
      {parts.map((part) => (
        <TechnicalDetailsPanel key={part.toolCallId} part={part} />
      ))}
    </div>
  ) : null;

  if (stages.length === 0) {
    return (
      <section
        className="group/step min-w-0"
        data-app-builder-step
        data-app-creation-stage={progress.stage}
        aria-label={sentence}
      >
        <div className="flex min-h-6 min-w-0 items-center gap-2 text-sm text-muted-foreground">
          <Blocks className="size-4 shrink-0" aria-hidden="true" />
          <span className="shrink-0">{sentence}</span>
          {state ? <span className="min-w-0 truncate text-xs text-muted-foreground">{state}</span> : null}
          {shownElapsed ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70" data-app-builder-elapsed>{shownElapsed}</span> : null}
          {progress.app && progress.build ? <BuiltAppChatPreview part={progress.build} compact /> : null}
          <DetailsToggle open={detailsOpen} onToggle={() => setDetailsOpen(!detailsOpen)} label={sentence} />
        </div>
        {details}
      </section>
    );
  }

  return (
    <section
      className="group/step w-full min-w-0 max-w-lg rounded-xl border border-border px-4 py-3"
      data-app-builder-step
      data-app-creation-stage={progress.stage}
      aria-label={sentence}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-sm text-muted-foreground">{sentence}</span>
        {state ? <span className="shrink-0 text-xs text-muted-foreground">{state}</span> : null}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {shownElapsed ? <span className="text-xs tabular-nums text-muted-foreground/70" data-app-builder-elapsed>{shownElapsed}</span> : null}
          <DetailsToggle open={detailsOpen} onToggle={() => setDetailsOpen(!detailsOpen)} label={sentence} alwaysVisible={progress.failed} />
        </span>
      </div>
      <div
        className="sr-only"
        role="progressbar"
        aria-label={`${sentence} progress`}
        aria-valuemin={0}
        aria-valuemax={stages.length}
        aria-valuenow={done}
      />
      <ol className="mt-2 flex flex-col gap-2 text-sm" aria-label={`Stages of ${sentence}`} data-app-builder-checklist>
        {stages.map((stage) => (
          <li key={stage.key} className="flex min-w-0 flex-col" data-checklist-state={stage.state}>
            <span className="flex min-w-0 items-center gap-2">
              <StageMark state={stage.state} running={progress.running} />
              <span
                className={`min-w-0 truncate ${
                  stage.state === "pending"
                    ? "text-muted-foreground/60"
                    : stage.state === "failed"
                      ? "text-destructive"
                      : stage.state === "active"
                        ? `text-foreground ${progress.running ? "ow-text-shimmer motion-reduce:animate-none" : ""}`
                        : "text-foreground"
                }`}
              >
                {stage.label}
              </span>
            </span>
            {stage.notes?.map((note) => (
              <span key={note} className="ml-6 truncate text-muted-foreground">{note}</span>
            ))}
            {/* Reserve one line throughout the active step, including gaps
                between thoughts and tool calls, so the checklist stays still. */}
            {stage.state === "active" ? (
              <span
                className="ml-6 h-4 shrink-0 truncate text-xs text-muted-foreground"
                data-app-builder-activity
                aria-hidden={!progress.running || !activity}
              >
                {progress.running ? activity : null}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      {details}
    </section>
  );
}
