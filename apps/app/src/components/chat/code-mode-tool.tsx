import { useState } from "react";
import type { DynamicToolUIPart } from "ai";
import { ChevronRight } from "lucide-react";
import { CapabilityCallLine, TechnicalDetailsPanel } from "./capability-call-line";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { getCapabilityCallSentence } from "@/lib/capability-call";
import { codeModeSummary } from "@/lib/code-mode-summary";
import type { CurrentToolLifecycle } from "@/lib/current-tool-lifecycle";
import { trackToolCallDuration } from "@/lib/tool-call-duration";
import { isToolPartInFlight } from "@/lib/tool-activity";
import { cn } from "@/lib/utils";
import { resolveConnectorToolIdentity, type ConnectorToolIdentity } from "@/react-app/domains/connections/connector-tool-identity";

/** Keep the script's activity on the same rail as the rest of the turn. */
export function CodeModeTool({ part, calls, lifecycle, connectors }: {
  part: DynamicToolUIPart;
  calls: DynamicToolUIPart[];
  lifecycle: CurrentToolLifecycle | null;
  connectors: ConnectorToolIdentity[];
}) {
  // A finished group folds unless the person explicitly chose otherwise.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const inFlight = isToolPartInFlight(part);
  const waiting = inFlight && lifecycle === "waiting";
  const running = inFlight && lifecycle === "running";
  const statusUnknown = inFlight && !running && !waiting;
  const open = userOpen ?? inFlight;
  const failedCalls = calls.filter(call => call.state === "output-error");
  const failed = part.state === "output-error";
  const duration = statusUnknown ? null : trackToolCallDuration(part);
  const serviceName = (call: DynamicToolUIPart) => {
    const connector = resolveConnectorToolIdentity(call, connectors);
    return connector?.name ?? getCapabilityCallSentence(call, { includeQuery: false }).service;
  };
  const summary = codeModeSummary(calls, { running, failed, serviceName });
  const current = [...calls].reverse().find(call => isToolPartInFlight(call));
  const currentSentence = current && !statusUnknown && !waiting
    ? getCapabilityCallSentence(current, { connectionName: serviceName(current), includeQuery: false }).present
    : null;
  const label = statusUnknown ? `${summary} — Status unavailable`
    : waiting ? "Waiting for your action"
      : !open && currentSentence && currentSentence !== summary ? `${summary} · ${currentSentence}` : summary;

  return (
    <Collapsible open={open} onOpenChange={setUserOpen} data-code-mode-call={part.toolCallId}>
      <CollapsibleTrigger
        className="group flex min-w-0 max-w-full items-center gap-2 text-start text-sm text-muted-foreground hover:text-foreground"
        aria-label={`${label}. ${open ? "Hide steps" : "Show steps"}`}
      >
        <ChevronRight aria-hidden="true" className={cn("size-4 shrink-0 transition-transform duration-150 ease-out motion-reduce:transition-none", open && "rotate-90")} />
        <span className={cn("min-w-0 truncate", running && !current && "ow-text-shimmer")}>{label}</span>
        {calls.length > 0 ? <span className="shrink-0 text-xs">{calls.length} {calls.length === 1 ? "step" : "steps"}</span> : null}
        {failedCalls.length > 0 ? <span className="shrink-0 text-xs">{failedCalls.length} {failedCalls.length === 1 ? "failed call" : "failed calls"}</span> : null}
        {duration ? <span className="ms-auto shrink-0 text-xs tabular-nums text-muted-foreground/70">{duration}</span> : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-180 ease-out data-starting-style:h-0 data-ending-style:h-0 motion-reduce:transition-none [&[hidden]:not([hidden='until-found'])]:hidden">
        <div className="mt-2 flex flex-col gap-2 border-s border-border ps-3">
          {calls.map(call => (
            <CapabilityCallLine
              key={call.toolCallId}
              part={call}
              connector={resolveConnectorToolIdentity(call, connectors)}
              resultUnavailable={call.state === "output-available"}
              statusUnknown={isToolPartInFlight(call) && (!running || !inFlight)}
              quietFailure
              shimmer={running && call.toolCallId === current?.toolCallId}
            />
          ))}
          {calls.length === 0 && running ? <span className="text-xs text-muted-foreground">Starting…</span> : null}
          <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ChevronRight aria-hidden="true" className={cn("size-3 transition-transform duration-150 ease-out motion-reduce:transition-none", detailsOpen && "rotate-90")} />
              Technical details
            </CollapsibleTrigger>
            <CollapsibleContent><TechnicalDetailsPanel part={part} /></CollapsibleContent>
          </Collapsible>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
