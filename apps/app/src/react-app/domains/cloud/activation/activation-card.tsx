import { useState } from "react";
import { useNavigate } from "react-router";
import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import { Check, Lock, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { ProgressIndicator, ProgressTrack } from "@/components/ui/progress";
import { denDashboardUrl } from "@/app/lib/den-dashboard-links";
import { readDenSettings } from "@/app/lib/den";
import { cn } from "@/lib/utils";
import { usePlatform } from "../../../kernel/platform";
import { activationCardModel, type ActivationRow, type ActivationRowAction } from "./activation-model";
import { reportActivationEvent, useActivation } from "./use-activation";

/**
 * "Get set up" in the sidebar, above the account. Nothing before the first answer,
 * signed out, when unavailable, or once all six steps are done; one quiet "Next" line after the person hides
 * it. Opens a popover with the six steps, each with at most one action (DESIGN S2, S7).
 */
export function ActivationCard(props: { onOpenExtensions: () => void }) {
  const { state } = useActivation();
  const model = activationCardModel(state);
  const navigate = useNavigate();
  const platform = usePlatform();
  const [open, setOpen] = useState(false);
  if (model.presentation === "hidden") return null;

  const act = (action: ActivationRowAction) => {
    setOpen(false);
    const denBaseUrl = readDenSettings().baseUrl;
    if (action === "invite") platform.openLink(denDashboardUrl(denBaseUrl, "members"));
    else if (action === "gateway") platform.openLink(denDashboardUrl(denBaseUrl, "gatewayProviders"));
    else if (action === "provider") navigate("/settings/ai");
    else props.onOpenExtensions();
  };

  const label = model.presentation === "next" && model.next ? `Get set up, next: ${model.next}` : `Get set up, ${model.done} of ${model.total}`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        data-testid="activation-card"
        aria-label={label}
        className={cn(
          "mb-1 flex w-full min-w-0 flex-col gap-1.5 rounded-lg px-2.5 text-start text-sidebar-foreground transition-colors duration-150 hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-data-[collapsible=icon]:hidden",
          model.presentation === "full" ? "bg-sidebar-accent/60 py-2" : "py-1.5",
        )}
      >
        {model.presentation === "full" ? (
          <>
            <span className="flex items-center gap-2 text-[13px] font-medium leading-4">
              <span className="flex-1 truncate">Get set up</span>
              <span className="text-xs font-normal tabular-nums text-muted-foreground">{model.done} of {model.total}</span>
            </span>
            <ProgressPrimitive.Root value={model.done} max={model.total} aria-label="Setup progress">
              <ProgressTrack className="h-1 bg-sidebar-border">
                <ProgressIndicator className="rounded-full" />
              </ProgressTrack>
            </ProgressPrimitive.Root>
            {model.next ? <span className="truncate text-xs leading-4 text-muted-foreground">Next: {model.next}</span> : null}
          </>
        ) : (
          <span className="truncate text-xs leading-4 text-muted-foreground">Next: {model.next}</span>
        )}
      </PopoverTrigger>
      <PopoverContent side="right" align="end" sideOffset={8} collisionPadding={12} className="w-80 gap-0 rounded-2xl p-1.5" data-testid="activation-popover">
        <div className="flex items-center gap-2 px-2 pb-1.5 pt-1">
          <PopoverTitle className="flex-1 text-sm font-semibold">Get set up</PopoverTitle>
          <span className="text-xs tabular-nums text-muted-foreground">{model.done} of {model.total}</span>
          {!model.dismissed ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Hide checklist"
              onClick={() => { setOpen(false); void reportActivationEvent("dismiss"); }}
            >
              <X className="size-4" />
            </Button>
          ) : null}
        </div>
        <ol className="flex flex-col">
          {model.rows.map((row) => <ActivationStepRow key={row.id} row={row} onAction={act} />)}
        </ol>
      </PopoverContent>
    </Popover>
  );
}

function ActivationStepRow({ row, onAction }: { row: ActivationRow; onAction: (action: ActivationRowAction) => void }) {
  const { action } = row;
  return (
    <li
      data-testid={`activation-step-${row.id}`}
      data-state={row.state}
      className="flex min-h-11 items-center gap-2.5 border-t border-border px-2 py-1.5 first:border-t-0"
    >
      {row.state === "done" ? (
        <span className="grid size-4 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground" aria-label="Done"><Check className="size-3" strokeWidth={2.5} /></span>
      ) : row.state === "locked" ? (
        <Lock className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} aria-label="Locked" />
      ) : (
        <span className="size-4 shrink-0 rounded-full border-[1.5px] border-muted-foreground/60" aria-label="Not done" />
      )}
      <div className="min-w-0 flex-1">
        <p className={cn("truncate text-[13px] leading-[18px]", row.state === "done" ? "text-muted-foreground" : "font-medium text-foreground")}>{row.title}</p>
        {row.line ? <p className="truncate text-xs leading-4 text-muted-foreground">{row.line}</p> : null}
      </div>
      {action ? (
        <Button variant="outline" size="xs" onClick={() => onAction(action.kind)}>{action.label}</Button>
      ) : null}
    </li>
  );
}
