import { useEffect, useState } from "react";
import type { DynamicToolUIPart } from "ai";
import { LoaderCircle } from "lucide-react";
import { CapabilityCallLine, ConnectorMark, DetailsToggle, isOpenWorkActivity, OPENWORK_IDENTITY, TechnicalDetailsPanel } from "./capability-call-line";
import { LaneChevron, LeadingLane, RAIL_LINE, RAIL_ROW, RailDuration, RailMeta, TextSentenceLine, TrailingChevron } from "./activity-rail";
import { useTextActivityRail } from "./text-activity-rail-store";
import { isOpenWorkSkillCall } from "@/lib/created-skill";
import { splitSentence } from "@/lib/text-activity";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { getCapabilityCallSentence } from "@/lib/capability-call";
import { codeModeSummary } from "@/lib/code-mode-summary";
import type { CapabilityCallSentence } from "@/lib/capability-call";
import { savedSkillSentence, skillShareFailureReason, skillShareRequest, skillShareSentence } from "@/lib/created-skill";
import { openWorkNativeSentence } from "@/lib/openwork-native-activity";
import { useCreatedSkills } from "./created-skill-card";
import { codeModeScriptError, codeModeToolCalls } from "@/lib/code-mode-tools";
import type { CurrentToolLifecycle } from "@/lib/current-tool-lifecycle";
import { formatElapsedSeconds, getToolCallStartedAt, trackToolCallDuration } from "@/lib/tool-call-duration";
import { isToolPartInFlight } from "@/lib/tool-activity";
import { cn } from "@/lib/utils";
import { resolveConnectorToolIdentity, type ConnectorToolIdentity } from "@/react-app/domains/connections/connector-tool-identity";

/** Keep the script's activity on the same rail as the rest of the turn. */
/** The agent reading its own toolbox: plumbing, not work the person asked for. */
export function isToolLookup(call: DynamicToolUIPart) {
  return call.toolName === "search" || call.toolName.endsWith("search_capabilities")
    // Reading what the app offers is the same kind of plumbing (T2).
    || (call.toolName === "openwork_context" && call.state === "output-available");
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
  const textRail = useTextActivityRail();
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
  const { shareLabels } = useCreatedSkills();
  // The same sentences the rows use, so the group's label and its steps agree.
  const knownSentence = (call: DynamicToolUIPart): CapabilityCallSentence | null => {
    const saved = savedSkillSentence(call);
    if (saved) return { service: null, ...saved };
    if (skillShareRequest(call)) return { service: null, ...skillShareSentence(shareLabels.get(call.toolCallId) ?? null) };
    return openWorkNativeSentence(call);
  };
  const isBlocked = (call: DynamicToolUIPart) => skillShareRequest(call) !== null && skillShareFailureReason(call) === "blocked";
  const blockedCalls = calls.filter(isBlocked);
  const failedCalls = calls.filter(call => call.state === "output-error" && !isBlocked(call));
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
  const summary = codeModeSummary(calls, { running, failed, serviceName, sentence: knownSentence, isBlocked });
  const current = [...calls].reverse().find(call => isToolPartInFlight(call));
  const currentSentence = current && !statusUnknown && !waiting
    ? (knownSentence(current) ?? getCapabilityCallSentence(current, { connectionName: serviceName(current), includeQuery: false })).present
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
      <div data-code-mode-call={part.toolCallId} className={RAIL_ROW}>
        <div className={RAIL_LINE}>
          <LeadingLane>{running && !textRail ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin text-muted-foreground motion-reduce:animate-none" /> : null}</LeadingLane>
          {textRail
            ? <TextSentenceLine {...splitSentence(label)} tone={failed ? "failed" : running ? "running" : "normal"} className="shrink-0" />
            : <span className={cn("shrink-0", failed && "text-destructive", running && "ow-text-shimmer motion-reduce:animate-none")}>{label}</span>}
          {failed && reason ? <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{reason}</span> : null}
          <RailDuration value={duration} />
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

  // Text-first: a group whose calls all reached one service carries that
  // service's real mark inline ("[OpenWork] Looked up 2 tools"), never a glyph.
  const groupMarks = textRail ? [...new Map(calls.map((call) => {
    const identity = resolveConnectorToolIdentity(call, connectors)
      ?? (isOpenWorkSkillCall(call) || isOpenWorkActivity(call) || call.toolName.startsWith("openwork-cloud_") ? OPENWORK_IDENTITY : null);
    return [identity?.id ?? "", identity] as const;
  })).values()] : [];
  const groupMark = groupMarks.length === 1 ? groupMarks[0] ?? null : null;

  return (
    <Collapsible open={open} onOpenChange={setUserOpen} data-code-mode-call={part.toolCallId}>
      <div className={cn(RAIL_ROW, RAIL_LINE)}>
        <CollapsibleTrigger
          className="group flex min-h-6.5 min-w-0 flex-1 items-center gap-2 text-start text-sm text-muted-foreground hover:text-foreground"
          aria-label={`${label}. ${open ? "Hide steps" : "Show steps"}`}
        >
          <LaneChevron open={open} />
          {textRail ? (
            <>
              <TextSentenceLine {...splitSentence(label)} mark={groupMark ? <ConnectorMark connector={groupMark} /> : null} tone={running && !current ? "running" : "normal"} />
            </>
          ) : (
            <span className={cn("min-w-0 truncate", running && !current && "ow-text-shimmer motion-reduce:animate-none")}>{label}</span>
          )}
          {calls.length > 0 && !textRail ? <RailMeta>{calls.length} {calls.length === 1 ? "step" : "steps"}</RailMeta> : null}
          {waitingOn ? <RailMeta>Waiting on {waitingOn}</RailMeta> : null}
          {failedCalls.length > 0 ? <RailMeta className={textRail ? "text-red-11" : "text-destructive"}>{failedCalls.length} failed</RailMeta> : null}
          {blockedCalls.length > 0 ? <RailMeta>{blockedCalls.length} blocked</RailMeta> : null}
          <RailDuration value={duration} />
          <TrailingChevron open={open} />
        </CollapsibleTrigger>
        <DetailsToggle open={detailsOpen} onToggle={() => setDetailsOpen(!detailsOpen)} label={label} alwaysVisible={failed} />
      </div>
      {detailsOpen ? <TechnicalDetailsPanel part={part} /> : null}
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-180 ease-out data-starting-style:h-0 data-ending-style:h-0 motion-reduce:transition-none [&[hidden]:not([hidden='until-found'])]:hidden">
        {/* Flat, not boxed (S1): the group's steps indent under its label. */}
        <div className={cn("mt-2 flex flex-col gap-2", !textRail && "ps-7")}>
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
