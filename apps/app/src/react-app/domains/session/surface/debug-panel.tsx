/** @jsxImportSource react */
import { X } from "lucide-react";
import { useState } from "react";
import type { OpenworkSessionHistory } from "../../../../app/lib/openwork-server";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { SessionRenderModel } from "../sync/transition-controller";

export function SessionDebugPanel(props: {
  model: SessionRenderModel;
  snapshot: OpenworkSessionHistory | null;
}) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) {
    return null;
  }
  return (
    <div
      data-openwork-debug-panel=""
      className="fixed bottom-20 right-4 z-30 w-[280px] rounded-2xl border border-dls-border bg-dls-surface/95 p-3 text-xs text-dls-secondary shadow-[var(--dls-card-shadow)] backdrop-blur-md"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-[11px] uppercase tracking-[0.18em] text-dls-text">React Session Debug</div>
        <Tooltip>
          <TooltipTrigger
            render={(
              <Button variant="ghost" size="icon-sm" onClick={() => setDismissed(true)} aria-label="Close debug panel">
                <X />
              </Button>
            )}
          />
          <TooltipContent>Close debug panel</TooltipContent>
        </Tooltip>
      </div>
      <div className="space-y-1.5">
        <div>intendedSessionId: <span className="text-dls-text">{props.model.intendedSessionId || "-"}</span></div>
        <div>renderedSessionId: <span className="text-dls-text">{props.model.renderedSessionId || "-"}</span></div>
        <div>transitionState: <span className="text-dls-text">{props.model.transitionState}</span></div>
        <div>renderSource: <span className="text-dls-text">{props.model.renderSource}</span></div>
        <div>status: <span className="text-dls-text">{props.snapshot?.status?.type ?? "-"}</span></div>
        <div>messages: <span className="text-dls-text">{props.snapshot?.messages.length ?? 0}</span></div>
        <div>todos: <span className="text-dls-text">{props.snapshot?.todos?.length ?? 0}</span></div>
      </div>
    </div>
  );
}