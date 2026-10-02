import { useEffect, useState } from "react";
import { CheckCircle2, ChevronRight, Circle, CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatToolCallDuration } from "@/lib/tool-call-duration";
import { isToolPartInFlight } from "@/lib/tool-activity";
import { useOptionalMessageList } from "./message-list-provider";
import { useCurrentToolLifecycleResolver } from "./current-tool-lifecycle-context";
import {
  appCreationProgress,
  type AppCreationRun,
} from "@/react-app/domains/apps/app-creation-progress";
import { BuiltAppChatPreview } from "@/react-app/domains/apps/built-app-chat-preview";
import { TechnicalDetailsPanel } from "./capability-call-line";

const stages = [
  { id: "needs", label: "Found what it needs" },
  { id: "writing", label: "Writing the app" },
  { id: "checking", label: "Checking it" },
  { id: "ready", label: "Ready to open" },
];

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
  const parts = [...(run.executions ?? []), ...(run.discoveries ?? []), ...(run.preparation ? [run.preparation] : []), ...run.builds];
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
  const [expanded, setExpanded] = useState(false);
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
  const index = stages.findIndex((stage) => stage.id === progress.stage);
  const editing =
    progress.build && /(?:^|_)update_app$/.test(progress.build.toolName);
  const label = progress.app
    ? editing
      ? "Updated"
      : "Created"
    : editing
      ? "Updating"
      : "Creating";
  return (
    <section
      className="py-2 text-sm"
      data-app-builder-step
      data-app-creation-stage={progress.stage}
      aria-label={`${label} ${progress.title}`}
    >
      {progress.app ? (
        <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" className="h-auto justify-start gap-2 px-0 py-1 text-sm" aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}>
          <img src="/openwork-mark.svg" alt="" className="size-5 dark:invert" />
          <span>{label} “{progress.title}”</span>
          <span className="font-normal text-muted-foreground">{stages.length} steps{elapsed !== null ? ` · ${formatToolCallDuration(elapsed)}` : ""}</span>
          <ChevronRight className={`size-4 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`} />
        </Button>
        {progress.build ? <BuiltAppChatPreview part={progress.build} compact /> : null}
        </div>
      ) : <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <img src="/openwork-mark.svg" alt="" className="size-5 dark:invert" />
        <span className="font-medium">
          {label} “{progress.title}”
        </span>
        {elapsed !== null ? (
          <span className="tabular-nums text-muted-foreground">
            {formatToolCallDuration(elapsed)}
          </span>
        ) : null}
        {progress.running ? <span className="text-xs text-muted-foreground">usually a few minutes</span> : null}
        {!progress.running && !progress.app ? (
          <span className="text-muted-foreground">
            {progress.failed
              ? "Needs a fix"
              : progress.unavailable
                ? "Preview unavailable"
                : context?.syncDegraded
                  ? "Reconnecting"
                  : lifecycle === "waiting"
                    ? "Waiting for approval"
                    : "Paused"}
          </span>
        ) : null}
      </div>}
      <div hidden={Boolean(progress.app) && !expanded}>
      <ol
        className="ml-2.5 mt-3 space-y-4 border-l border-border pb-1 pl-7"
        aria-live="polite"
      >
        {stages.map((stage, i) => {
          // A direct legacy call cannot prove a preparation stage happened.
          const done = Boolean(
            progress.app || (i === 0 ? progress.prepared : i < index),
          );
          const current = i === index && !progress.app;
          const status = done
            ? "complete"
            : current && progress.failed
              ? "failed"
              : current && progress.running
                ? "running"
                : current
                  ? "paused"
                  : "pending";
          const hint =
            i === 0 && progress.preparation
              ? progress.preparation.tools
                  .slice(0, 3)
                  .map((tool) => tool.description.slice(0, 80))
                  .join(" · ") || "Self-contained app"
              : i === 0 && current && run.discoveries?.length
                ? (() => { const input = run.discoveries.at(-1)?.input; const query = input && typeof input === "object" ? Reflect.get(input, "query") : null; return typeof query === "string" ? query.slice(0, 140) : null; })()
              : i === 1 && current
                ? progress.detail || "Building the view and interactions"
                : i === 2 && current
                  ? "Validating tools and compiling the app"
                  : null;
          return (
            <li
              key={stage.id}
              data-app-creation-step={stage.id}
              data-step-status={status}
              className={`flex items-start gap-3 ${done || (current && progress.running) || status === "failed" ? "text-foreground" : "text-muted-foreground"}`}
            >
              <span className="mt-0.5 shrink-0" aria-label={status}>
                {done ? (
                  <CheckCircle2 className="size-4 text-muted-foreground" />
                ) : status === "failed" ? (
                  <CircleAlert className="size-4" />
                ) : status === "running" ? (
                  <span className="mx-1 my-1 block size-2 rounded-full bg-foreground" />
                ) : (
                  <Circle className="size-4 text-muted-foreground/50" />
                )}
              </span>
              <span>
                {i === 0 && current ? "Finding what it needs" : stage.label}
                {hint ? (
                  <span className="ml-3 text-muted-foreground">{hint}</span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
      {progress.failed ? (
        <p role="alert" className="ml-10 mt-3 text-muted-foreground">
          {progress.build
            ? "The app could not be checked. Fix the reported error and try again."
            : "The app’s tools could not be prepared. Check access or choose another tool."}
        </p>
      ) : null}
      {progress.unavailable ? (
        <p role="status" className="ml-10 mt-3 text-muted-foreground">
          The build returned without an available preview. See the result for
          the next step.
        </p>
      ) : null}
      <details className="ml-10 mt-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer">Technical details</summary>
        {parts.map((part) => (
          <TechnicalDetailsPanel key={part.toolCallId} part={part} />
        ))}
      </details>
      </div>
    </section>
  );
}
