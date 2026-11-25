import { useEffect, useState } from "react";
import type { DynamicToolUIPart } from "ai";

import { CapabilityCallLine, ConnectorMark, DetailsToggle, isOpenWorkActivity, OPENWORK_IDENTITY, TechnicalDetailsPanel } from "./capability-call-line";
import { RAIL_LINE, RAIL_ROW, RailMeta, TextSentenceLine, TrailingChevron } from "./activity-rail";
import { isOpenWorkSkillCall } from "@/lib/created-skill";
import { splitSentence } from "@/lib/text-activity";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { getCapabilityCallSentence } from "@/lib/capability-call";
import { codeModeFailureReason, codeModeSummary, shortFailureReason } from "@/lib/code-mode-summary";
import type { CapabilityCallSentence } from "@/lib/capability-call";
import { savedSkillSentence, skillShareFailureReason, skillShareRequest, skillShareSentence } from "@/lib/created-skill";
import { openWorkNativeSentence } from "@/lib/openwork-native-activity";
import { useCreatedSkills } from "./created-skill-card";
import { codeModeToolCalls } from "@/lib/code-mode-tools";
import type { CurrentToolLifecycle } from "@/lib/current-tool-lifecycle";
import { isToolPartInFlight } from "@/lib/tool-activity";
import { cn } from "@/lib/utils";
import { resolveConnectorToolIdentity, type ConnectorToolIdentity } from "@/react-app/domains/connections/connector-tool-identity";

export function isToolLookup(call: DynamicToolUIPart) {
  return call.toolName === "search" || call.toolName.endsWith("search_capabilities")
    || (call.toolName === "openwork_context" && call.state === "output-available");
}

export function isSilentCodeModePart(part: DynamicToolUIPart): boolean {
  const calls = codeModeToolCalls(part);
  if (!calls || isToolPartInFlight(part) || part.state === "output-error") return false;
  return calls.every(isToolLookup);
}

const shortReason = shortFailureReason;

export function CodeModeTool({ part, calls: allCalls, lifecycle, connectors }: {
  part: DynamicToolUIPart;
  calls: DynamicToolUIPart[];
  lifecycle: CurrentToolLifecycle | null;
  connectors: ConnectorToolIdentity[];
}) {
  const calls = allCalls.filter((call) => !isToolLookup(call));
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
  const open = userOpen ?? false;
  const { shareLabels } = useCreatedSkills();
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
  const serviceName = (call: DynamicToolUIPart) => {
    if (call.toolName.endsWith("search_capabilities")) return null;
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
  const comparable = (value: string) => value.toLowerCase().replace(/\b(?:a|an|the)\b/g, "").replace(/\s+/g, " ").trim();
  const distinctCurrent = currentSentence && !comparable(summary).startsWith(comparable(currentSentence));
  const label = statusUnknown ? `${summary}, status unavailable`
    : waiting ? "Waiting for your action"
      : !open && distinctCurrent ? `${summary} · ${currentSentence}` : summary;

  if (allCalls.length > 0 && calls.length === 0 && !isToolPartInFlight(part) && part.state !== "output-error") return null;

  if (calls.length === 0 && !waiting) {
    if (!inFlight && !failed) return null;
    const reason = shortReason(part);
    return (
      <div data-code-mode-call={part.toolCallId} className={RAIL_ROW}>
        <div className={RAIL_LINE}>
          <TextSentenceLine {...splitSentence(label)} tone={failed ? "failed" : running ? "running" : "normal"} className="shrink-0" />
          {failed && reason ? <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{reason}</span> : null}
          <DetailsToggle open={detailsOpen} onToggle={() => setDetailsOpen(!detailsOpen)} label={label} alwaysVisible={failed} />
        </div>
        {detailsOpen ? <TechnicalDetailsPanel part={part} /> : null}
      </div>
    );
  }

  const only = calls.length === 1 && !waiting && !statusUnknown ? calls[0] : undefined;
  if (only) {
    const merged: DynamicToolUIPart = only.state === "output-available" && only.output === undefined && part.state === "output-available"
      ? { ...only, output: part.output } : only;
    return (
      <div data-code-mode-call={part.toolCallId}>
        <CapabilityCallLine
          part={merged}
          connector={resolveConnectorToolIdentity(only, connectors)}
          quietFailure
          shimmer={running}
          statusUnknown={isToolPartInFlight(only) && (!running || !inFlight)}
        />
      </div>
    );
  }

  const services = [...new Set(calls.map(serviceName).filter((name): name is string => Boolean(name)))];
  const groupService = services.length === 1 ? services[0] ?? null : null;
  const rowLabel = (call: DynamicToolUIPart) => `${call.state}:${getCapabilityCallSentence(call, { connectionName: serviceName(call) }).past}`;
  const rows: Array<{ call: DynamicToolUIPart; repeat: number }> = [];
  for (const call of calls) {
    const previous = rows.at(-1);
    if (previous && !isToolPartInFlight(call) && rowLabel(previous.call) === rowLabel(call)) previous.repeat += 1;
    else rows.push({ call, repeat: 1 });
  }

  const groupMarks = [...new Map(calls.map((call) => {
    const identity = resolveConnectorToolIdentity(call, connectors)
      ?? (isOpenWorkSkillCall(call) || isOpenWorkActivity(call) || call.toolName.startsWith("openwork-cloud_") ? OPENWORK_IDENTITY : null);
    return [identity?.id ?? "", identity] as const;
  })).values()];
  const groupMark = groupMarks.length === 1 ? groupMarks[0] ?? null : null;
  const groupReason = codeModeFailureReason(part, failedCalls, running);

  return (
    <Collapsible open={open} onOpenChange={setUserOpen} data-code-mode-call={part.toolCallId}>
      <div className={cn(RAIL_ROW, RAIL_LINE)}>
        <CollapsibleTrigger
          className="group flex min-h-6.5 min-w-0 flex-1 items-center gap-2 text-start text-sm text-muted-foreground hover:text-foreground"
          aria-label={`${label}. ${open ? "Hide steps" : "Show steps"}`}
        >
          <TextSentenceLine {...splitSentence(label)} mark={groupMark ? <ConnectorMark connector={groupMark} /> : null} tone={running && !current ? "running" : "normal"} />
          {waitingOn ? <RailMeta>Waiting on {waitingOn}</RailMeta> : null}
          {failedCalls.length > 0 ? <RailMeta>{failedCalls.length} failed</RailMeta> : null}
          {groupReason ? <span data-code-mode-failure-reason className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{groupReason}</span> : null}
          {blockedCalls.length > 0 ? <RailMeta>{blockedCalls.length} blocked</RailMeta> : null}
          <TrailingChevron open={open} />
        </CollapsibleTrigger>
        <DetailsToggle open={detailsOpen} onToggle={() => setDetailsOpen(!detailsOpen)} label={label} alwaysVisible={failed} />
      </div>
      {detailsOpen ? <TechnicalDetailsPanel part={part} /> : null}
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-180 ease-out data-starting-style:h-0 data-ending-style:h-0 motion-reduce:transition-none [&[hidden]:not([hidden='until-found'])]:hidden">
        <div className="mt-2 flex flex-col gap-2">
          {rows.map(({ call, repeat }) => (
            <CapabilityCallLine
              key={call.toolCallId}
              part={call}
              connector={resolveConnectorToolIdentity(call, connectors)}
              statusUnknown={isToolPartInFlight(call) && (!running || !inFlight)}
              quietFailure
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
