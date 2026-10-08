import { useEffect, useState } from "react";
import { resolveExtensionIconSrc } from "@/react-app/design-system/extension-icon-src";
import { formatToolCallDuration } from "@/lib/tool-call-duration";
import { isToolPartInFlight } from "@/lib/tool-activity";
import { useOptionalMessageList } from "./message-list-provider";
import { useCurrentToolLifecycleResolver } from "./current-tool-lifecycle-context";
import {
  appCreationProgress,
  type AppCreationRun,
} from "@/react-app/domains/apps/app-creation-progress";
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

export function AppBuilderStep({
  run,
  active,
}: {
  run: AppCreationRun;
  active: boolean;
}) {
  const context = useOptionalMessageList();
  const resolveLifecycle = useCurrentToolLifecycleResolver();
  const latest = run.builds.at(-1) ?? run.preparation ?? run.discoveries?.at(-1);
  const lifecycle = latest
    ? resolveLifecycle(latest.toolCallId, isToolPartInFlight(latest))
    : null;
  const progress = appCreationProgress(
    run,
    active &&
      !context?.syncDegraded &&
      lifecycle !== "interrupted" &&
      lifecycle !== "waiting",
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
  const terminal = progress.app || progress.failed || progress.unavailable;
  const elapsed =
    starts.length && (progress.running || (terminal && ends.length))
      ? Math.max(
          0,
          (progress.running ? now : Math.max(...ends)) - Math.min(...starts),
        )
      : null;
  const editing =
    progress.build && /(?:^|_)update_app$/.test(progress.build.toolName);
  // One plain rail row, like every other step: what is happening to which
  // app, a short state, Open when there is something to open, and the raw
  // calls behind the details icon.
  const title = `“${progress.title}”`;
  const sentence = progress.app || progress.builtUnrecorded
    ? `${editing ? "Updated" : "Created"} artifact ${title}`
    : progress.failed
      ? `Couldn’t ${editing ? "update" : "create"} artifact ${title}`
      : progress.stage === "checking"
        ? `Checking artifact ${title}`
        : progress.stage === "writing"
          ? `${editing ? "Updating" : "Writing"} artifact ${title}`
          : `Preparing artifact ${title}`;
  const state = progress.failed
    ? latestProblem
    : progress.builtUnrecorded
      ? "Open it from your Library"
      : progress.unavailable
        ? "Preview unavailable"
        : !progress.running && !progress.app
          ? context?.syncDegraded ? "Reconnecting" : lifecycle === "waiting" ? "Waiting for approval" : "Paused"
          : fixedProblems.length > 0 && progress.running
            ? `fixed ${fixedProblems.length} ${fixedProblems.length === 1 ? "problem" : "problems"}`
            : null;
  const shownElapsed = elapsed !== null && (progress.running || terminal) ? formatToolCallDuration(elapsed) : null;
  return (
    <section
      className="group/step min-w-0"
      data-app-builder-step
      data-app-creation-stage={progress.stage}
      aria-label={sentence}
    >
      <div className="flex min-h-6 min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <img src={resolveExtensionIconSrc("/openwork-mark.svg")} alt="" className="size-4 shrink-0 opacity-80 dark:invert" />
        <span className={`shrink-0 ${progress.running ? "ow-text-shimmer motion-reduce:animate-none" : ""}`}>{sentence}</span>
        {state ? <span className="min-w-0 truncate text-xs text-muted-foreground">{state}</span> : null}
        {shownElapsed ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">{shownElapsed}</span> : null}
        {progress.app && progress.build ? <BuiltAppChatPreview part={progress.build} compact /> : null}
        <DetailsToggle open={detailsOpen} onToggle={() => setDetailsOpen(!detailsOpen)} label={sentence} alwaysVisible={progress.failed} />
      </div>
      {detailsOpen ? (
        <div className="mt-1 flex flex-col gap-2">
          {fixedProblems.map((problem, index) => (
            <p key={index} className="text-xs text-muted-foreground">Fixed: {problem}</p>
          ))}
          {parts.map((part) => (
            <TechnicalDetailsPanel key={part.toolCallId} part={part} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
