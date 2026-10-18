import { useEffect, useRef, useState } from "react";
import { Blocks, ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatToolCallDuration } from "@/lib/tool-call-duration";
import { useOptionalMessageList } from "./message-list-provider";
import { useCurrentSessionActivityStatus } from "./current-tool-lifecycle-context";
import { appCreationParts, appCreationProgress, type AppCreationRun } from "@/react-app/domains/apps/app-creation-progress";
import { BuiltAppChatPreview } from "@/react-app/domains/apps/built-app-chat-preview";
import { appBuilderResultFailed } from "@/react-app/domains/apps/built-mcp-app-model";
import { CapabilityCallLine } from "./capability-call-line";
import { CodeModeTool } from "./code-mode-tool";
import { codeModeToolCalls } from "@/lib/code-mode-tools";
import type { DynamicToolUIPart } from "ai";

/** Keep the actionable reason short; full input/output remains inspectable. */
export function appBuildProblem(part: DynamicToolUIPart): string | null {
  if (part.state !== "output-error" || !part.errorText.trim()) return null;
  const sentences = part.errorText.replace(/\s+/g, " ").trim().split(/(?<=\.)\s+/);
  const reason = sentences.find(sentence => !/compilation failed|^error:/i.test(sentence)) ?? sentences[0] ?? "";
  return reason.replace(/^Generated MCP Apps cannot /i, "Can’t ").replace(/\.$/, "").slice(0, 120) || null;
}

/** The person's App stays one named object. Its disclosure contains observed
 * calls, never a checklist that marks skipped or failed stages as completed. */
export function AppBuilderStep({ run, active, activity = null, startedAt = null, completedAt = null }: {
  run: AppCreationRun;
  active: boolean;
  startedAt?: number | null;
  completedAt?: number | null;
  activity?: string | null;
}) {
  const context = useOptionalMessageList();
  const sessionActivity = useCurrentSessionActivityStatus();
  const waiting = active && sessionActivity === "waiting";
  const progress = appCreationProgress(run, active && !context?.syncDegraded && !waiting);
  const parts = appCreationParts(run);
  const timedParts = [...(run.executions ?? []), ...parts];
  const starts = timedParts.flatMap(part => typeof part.callProviderMetadata?.openwork?.toolStartedAt === "number"
    ? [part.callProviderMetadata.openwork.toolStartedAt] : []);
  const ends = timedParts.flatMap(part => typeof part.callProviderMetadata?.openwork?.toolCompletedAt === "number"
    ? [part.callProviderMetadata.openwork.toolCompletedAt] : []);
  const firstObservedAt = useRef(Date.now());
  const beganAt = run.startedAt ?? (starts.length ? Math.min(...starts) : startedAt ?? firstObservedAt.current);
  const [now, setNow] = useState(Date.now);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!progress.running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [progress.running]);
  const built = Boolean(progress.app || progress.builtUnrecorded);
  const terminal = built || progress.failed || progress.unavailable;
  const endedAt = terminal ? (ends.length ? Math.max(...ends) : completedAt) : now;
  const elapsed = endedAt === null ? null : Math.max(0, endedAt - beganAt);
  const shownElapsed = elapsed !== null && (active || terminal || starts.length > 0) ? formatToolCallDuration(elapsed) : null;
  const title = progress.title ? `App “${progress.title}”` : "App";
  const status = progress.app ? "Saved"
    : progress.builtUnrecorded ? "Result not recorded"
    : progress.failed ? "Needs attention"
    : progress.unavailable ? "Result unavailable"
    : context?.syncDegraded ? "Reconnecting"
    : waiting ? "Waiting for your response"
    : progress.running ? "In progress" : "Paused";
  const failureIds = new Set(progress.failures.map(part => part.toolCallId));
  const callLine = (part: DynamicToolUIPart) => {
    if (part.state !== "output-error" && appBuilderResultFailed(part)) {
      return <CapabilityCallLine part={part} failureText="The App step did not complete. Check its details before retrying." />;
    }
    const calls = codeModeToolCalls(part);
    return calls ? <CodeModeTool part={part} calls={calls} lifecycle={progress.running ? "running" : null} connectors={context?.connectorIdentities ?? []} /> : <CapabilityCallLine part={part} />;
  };

  return <section className="group/step min-w-0" data-app-builder-step data-app-creation-stage={progress.stage} aria-label={`${title}: ${status}`}>
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex min-h-6 min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <Blocks className="size-4 shrink-0" aria-hidden="true" />
        <CollapsibleTrigger className="flex min-w-0 items-center gap-2 text-left hover:text-foreground" aria-label={`${open ? "Hide" : "Show"} ${title} activity`}>
          <ChevronRight className={`size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-90" : ""}`} aria-hidden="true" />
          <span className="truncate">{title}</span>
          <span className={`shrink-0 text-xs ${progress.running ? "ow-text-shimmer motion-reduce:animate-none" : ""}`} data-app-builder-status>{status}</span>
        </CollapsibleTrigger>
        {shownElapsed ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70" data-app-builder-elapsed>{shownElapsed}</span> : null}
        {progress.app && progress.build ? <BuiltAppChatPreview part={progress.build} compact /> : null}
      </div>
      {/* Failures are decisions, not diagnostics. They never disappear inside a
          completed-turn rail or the App's own activity disclosure. */}
      {progress.failures.map(part => <div key={part.toolCallId} className="ml-6 mt-1" data-app-builder-failure>{callLine(part)}</div>)}
      {progress.unavailable || progress.builtUnrecorded ? <p className="ml-6 text-xs text-muted-foreground">The App result wasn’t recorded. Check your Library before trying again.</p> : null}
      <CollapsibleContent>
        <div className="ml-6 mt-1 flex min-w-0 flex-col gap-1" data-app-builder-activity>
          {parts.filter(part => !failureIds.has(part.toolCallId)).map(part => <div key={part.toolCallId}>{callLine(part)}</div>)}
          {progress.running && activity ? <p className="truncate text-xs text-muted-foreground">{activity}</p> : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  </section>;
}
