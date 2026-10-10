import { useEffect, useState } from "react";
import type { DynamicToolUIPart } from "ai";
import { ChevronRight } from "lucide-react";
import { CapabilityCallLine, DetailsToggle, TechnicalDetailsPanel } from "./capability-call-line";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { getCapabilityCallSentence } from "@/lib/capability-call";
import { codeModeSummary } from "@/lib/code-mode-summary";
import { codeModeScriptError, codeModeToolCalls } from "@/lib/code-mode-tools";
import type { CurrentToolLifecycle } from "@/lib/current-tool-lifecycle";
import { formatElapsedSeconds, getToolCallStartedAt, trackToolCallDuration } from "@/lib/tool-call-duration";
import { isToolPartInFlight } from "@/lib/tool-activity";
import { cn } from "@/lib/utils";
import { resolveConnectorToolIdentity, type ConnectorToolIdentity } from "@/react-app/domains/connections/connector-tool-identity";

/** Keep the script's activity on the same rail as the rest of the turn. */
/** The agent reading its own toolbox: plumbing, not work the person asked for. */
function isToolLookup(call: DynamicToolUIPart) {
  return call.toolName === "search" || call.toolName.endsWith("search_capabilities");
}

/**
 * A finished script that did no visible work (no calls, or only catalog
 * lookups) renders nothing; callers drop it before layout so it leaves no gap.
 */
export function isSilentCodeModePart(part: DynamicToolUIPart): boolean {
  const calls = codeModeToolCalls(part);
  if (!calls || isToolPartInFlight(part) || part.state === "output-error") return false;
  return calls.every(isToolLookup);
}

/** One short line from a script error, for the row itself. */
function shortReason(part: DynamicToolUIPart): string | null {
  const text = codeModeScriptError(part) ?? (part.state === "output-error" ? part.errorText : null);
  if (!text) return null;
  const first = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] ?? "";
  return first.length > 90 ? `${first.slice(0, 89)}…` : first || null;
}

export function CodeModeTool({ part, calls: allCalls, lifecycle, connectors }: {
  part: DynamicToolUIPart;
  calls: DynamicToolUIPart[];
  lifecycle: CurrentToolLifecycle | null;
  connectors: ConnectorToolIdentity[];
}) {
  // Catalog lookups are the agent reading its own toolbox, never shown.
  const calls = allCalls.filter((call) => !isToolLookup(call));
  // A finished group folds unless the person explicitly chose otherwise.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [lastActivityAt, setLastActivityAt] = useState(Date.now());
  const activityKey = calls.map(call => `${call.toolCallId}:${call.state}`).join("|");
  useEffect(() => setLastActivityAt(Date.now()), [activityKey]);
  const inFlight = isToolPartInFlight(part);
  const waiting = inFlight && lifecycle === "waiting";
  const running = inFlight && lifecycle === "running";
  const statusUnknown = inFlight && !running && !waiting;
  useEffect(() => {
    if (!running) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [running]);
  // Groups never open or close on their own: live progress shows in the
  // collapsed line, so finishing a step doesn't make the chat jump. Only the
  // person's choice opens a group, and it stays as they left it.
  const open = userOpen ?? false;
  const failedCalls = calls.filter(call => call.state === "output-error");
  const failed = part.state === "output-error";
  const startedAt = running ? getToolCallStartedAt(part) : null;
  const liveDuration = startedAt === null ? null : Math.floor((now - startedAt) / 1_000);
  const duration = running && liveDuration !== null && liveDuration >= 1
    ? formatElapsedSeconds(liveDuration)
    : statusUnknown ? null : trackToolCallDuration(part);
  const serviceName = (call: DynamicToolUIPart) => {
    // Catalog search is an OpenWork mechanism, not a service the person used.
    if (call.toolName.endsWith("search_capabilities")) return null;
    // The service a call reached (Render, Slack…) wins. Only calls with no
    // connector of their own, such as Den scripts, are named by where they
    // ran; the MCP's settings title ("Cloud Control") is plumbing.
    const connector = resolveConnectorToolIdentity(call, connectors);
    if (connector?.name) return connector.name;
    if (call.toolName.startsWith("openwork-cloud_")) return "OpenWork Cloud";
    return getCapabilityCallSentence(call, { includeQuery: false }).service;
  };
  const summary = codeModeSummary(calls, { running, failed, serviceName });
  const current = [...calls].reverse().find(call => isToolPartInFlight(call));
  const currentSentence = current && !statusUnknown && !waiting
    ? getCapabilityCallSentence(current, { connectionName: serviceName(current), includeQuery: false }).present
    : null;
  const waitingOn = running && current && now - lastActivityAt >= 8_000 ? serviceName(current) : null;
  // The same action can be phrased with an article in the group label but not
  // in the child sentence ("Creating a note" versus "Creating note").
  const comparable = (value: string) => value.toLowerCase().replace(/\b(?:a|an|the)\b/g, "").replace(/\s+/g, " ").trim();
  const distinctCurrent = currentSentence && !comparable(summary).startsWith(comparable(currentSentence));
  const label = statusUnknown ? `${summary}, status unavailable`
    : waiting ? "Waiting for your action"
      : !open && distinctCurrent ? `${summary} · ${currentSentence}` : summary;

  // A finished script that only read the tool catalog did no work the
  // person asked for: show nothing rather than "Checked which tools…".
  if (allCalls.length > 0 && calls.length === 0 && !isToolPartInFlight(part) && part.state !== "output-error") return null;

  // A script with no tool calls did no work a person can see: hide it once
  // it succeeds; while running or after failing it is one quiet row.
  if (calls.length === 0 && !waiting) {
    if (!inFlight && !failed) return null;
    const reason = shortReason(part);
    return (
      <div data-code-mode-call={part.toolCallId} className="group/step min-w-0">
        <div className="flex min-h-6 min-w-0 items-center gap-2 text-sm text-muted-foreground">
          <span className={cn("shrink-0", running && "ow-text-shimmer")}>{label}</span>
          {failed && reason ? <span className="min-w-0 truncate text-xs text-muted-foreground">{reason}</span> : null}
          {duration ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">{duration}</span> : null}
          <DetailsToggle open={detailsOpen} onToggle={() => setDetailsOpen(!detailsOpen)} label={label} alwaysVisible={failed} />
        </div>
        {detailsOpen ? <TechnicalDetailsPanel part={part} /> : null}
      </div>
    );
  }

  // One call is one step: no nested rail, no "1 step", no repeated sentence.
  // The row's details icon opens the script (its source and its error).
  const only = calls.length === 1 && !waiting && !statusUnknown ? calls[0] : undefined;
  if (only) {
    // The call's own input is the readable one (a Den script's source). Its
    // own captured result wins; otherwise show the script's result.
    const merged: DynamicToolUIPart = only.state === "output-available" && only.output === undefined && part.state === "output-available"
      ? { ...only, output: part.output } : only;
    return (
      <div data-code-mode-call={part.toolCallId}>
        <CapabilityCallLine
          part={merged}
          connector={resolveConnectorToolIdentity(only, connectors)}
          quietFailure
          hideDuration
          shimmer={running}
          statusUnknown={isToolPartInFlight(only) && (!running || !inFlight)}
        />
      </div>
    );
  }

  // Rows inside a group named for one service drop that name, and identical
  // consecutive finished calls fold into one row ("2 times").
  const services = [...new Set(calls.map(serviceName).filter((name): name is string => Boolean(name)))];
  const groupService = services.length === 1 ? services[0] ?? null : null;
  const rowLabel = (call: DynamicToolUIPart) => `${call.state}:${getCapabilityCallSentence(call, { connectionName: serviceName(call) }).past}`;
  const rows: Array<{ call: DynamicToolUIPart; repeat: number }> = [];
  for (const call of calls) {
    const previous = rows.at(-1);
    if (previous && !isToolPartInFlight(call) && rowLabel(previous.call) === rowLabel(call)) previous.repeat += 1;
    else rows.push({ call, repeat: 1 });
  }

  return (
    <Collapsible open={open} onOpenChange={setUserOpen} data-code-mode-call={part.toolCallId}>
      <div className="group/step flex min-w-0 items-center gap-2">
        <CollapsibleTrigger
          className="group flex min-w-0 max-w-full items-center gap-2 text-start text-sm text-muted-foreground hover:text-foreground"
          aria-label={`${label}. ${open ? "Hide steps" : "Show steps"}`}
        >
          <ChevronRight aria-hidden="true" className={cn("size-4 shrink-0 transition-transform duration-150 ease-out motion-reduce:transition-none", open && "rotate-90")} />
          <span className={cn("min-w-0 truncate", running && !current && "ow-text-shimmer")}>{label}</span>
          {calls.length > 0 ? <span className="shrink-0 text-xs">{calls.length} {calls.length === 1 ? "step" : "steps"}</span> : null}
          {waitingOn ? <span className="shrink-0 text-xs">Waiting on {waitingOn}</span> : null}
          {failedCalls.length > 0 ? <span className="shrink-0 text-xs">{failedCalls.length} failed</span> : null}
          {duration ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">{duration}</span> : null}
        </CollapsibleTrigger>
        <DetailsToggle open={detailsOpen} onToggle={() => setDetailsOpen(!detailsOpen)} label={label} alwaysVisible={failed} />
      </div>
      {detailsOpen ? <TechnicalDetailsPanel part={part} /> : null}
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-180 ease-out data-starting-style:h-0 data-ending-style:h-0 motion-reduce:transition-none [&[hidden]:not([hidden='until-found'])]:hidden">
        <div className="mt-2 flex flex-col gap-1 border-s border-border ps-3">
          {rows.map(({ call, repeat }) => (
            <CapabilityCallLine
              key={call.toolCallId}
              part={call}
              connector={resolveConnectorToolIdentity(call, connectors)}
              statusUnknown={isToolPartInFlight(call) && (!running || !inFlight)}
              quietFailure
              hideDuration
              groupService={groupService}
              repeat={repeat}
              shimmer={running && call.toolCallId === current?.toolCallId}
            />
          ))}
          {calls.length === 0 && running ? <span className="text-xs text-muted-foreground">Starting…</span> : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
