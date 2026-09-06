import { useState } from "react";
import type { DynamicToolUIPart } from "ai";
import { ChevronRight } from "lucide-react";
import { CapabilityCallLine, TechnicalDetailsPanel } from "./capability-call-line";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { CurrentToolLifecycle } from "@/lib/current-tool-lifecycle";
import { isToolPartInFlight } from "@/lib/tool-activity";
import { cn } from "@/lib/utils";
import { resolveConnectorToolIdentity, type ConnectorToolIdentity } from "@/react-app/domains/connections/connector-tool-identity";

export function CodeModeTool({ part, calls, lifecycle, connectors }: {
  part: DynamicToolUIPart;
  calls: DynamicToolUIPart[];
  lifecycle: CurrentToolLifecycle | null;
  connectors: ConnectorToolIdentity[];
}) {
  const [open, setOpen] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const inFlight = isToolPartInFlight(part);
  const failed = part.state === "output-error" || calls.some(call => call.state === "output-error");
  const status = inFlight
    ? lifecycle === "waiting" ? "Waiting for your action" : lifecycle === "running" ? "Running" : "Status unavailable"
    : failed ? "Completed with errors" : "Completed";
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-code-mode-call={part.toolCallId}>
      <CollapsibleTrigger className="flex items-center gap-2 text-sm text-muted-foreground">
        <ChevronRight aria-hidden="true" className={cn("size-3 transition-transform", open && "rotate-90")} />
        <span>{calls.length ? "Tool activity" : "Task step"}</span>
        <span className={cn("text-xs", failed && "text-destructive")}>{status}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 space-y-2 border-l border-border pl-3">
        {calls.map(call => (
          <CapabilityCallLine
            key={call.toolCallId}
            part={call}
            connector={resolveConnectorToolIdentity(call, connectors)}
            resultUnavailable={call.state === "output-available"}
            statusUnknown={isToolPartInFlight(call) && (!inFlight || lifecycle !== "running")}
          />
        ))}
        <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
          <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground">
            <ChevronRight aria-hidden="true" className={cn("size-3 transition-transform", detailsOpen && "rotate-90")} />
            Execution details
          </CollapsibleTrigger>
          <CollapsibleContent><TechnicalDetailsPanel part={part} /></CollapsibleContent>
        </Collapsible>
      </CollapsibleContent>
    </Collapsible>
  );
}
