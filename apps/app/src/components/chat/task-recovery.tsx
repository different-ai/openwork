import { useEffect, useState, type ReactNode } from "react";
import { CodeXml, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * One presentation for task failures, interruptions and engine-owned retries:
 * a single line (what happened, the current state, the next action). The raw
 * error stays one quiet click away behind a code icon that appears on hover
 * or focus, so people who know what to look for can always copy it.
 */
export function TaskRecovery(props: {
  title: string;
  state?: "failed" | "paused" | "retrying";
  description?: ReactNode;
  actions?: ReactNode;
  technicalDetails?: string | null;
  testId?: string;
  onRetry?: () => void;
  retryDisabled?: boolean;
  retryTestId?: string;
  retryLabel?: string;
  compact?: boolean;
}) {
  const state = props.state ?? "failed";
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const details = props.technicalDetails?.trim();
  const hasDetails = details && details.replace(/^Message:\s*/, "") !== props.title.trim();

  return (
    <Collapsible open={open} onOpenChange={setOpen}
      className={props.compact ? "group/recovery not-prose min-w-0 py-1" : "group/recovery not-prose mx-auto w-full max-w-3xl px-2 py-2 md:px-10"}
      data-testid={props.testId}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {state === "retrying" ? (
          <LoaderCircle aria-hidden="true" className="size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
        ) : null}
        <p role={state === "failed" ? "alert" : "status"}
          className={cn("min-w-0 text-sm leading-6", state === "failed" ? "font-medium text-foreground" : "text-dls-secondary")}>
          {props.title}
        </p>
        {props.description ? <span className="min-w-0 text-xs leading-6 text-muted-foreground">{props.description}</span> : null}
        <div className="flex shrink-0 items-center gap-1 text-foreground">
          {props.onRetry ? (
            <Button variant="ghost" size="xs" aria-label={props.retryLabel ?? "Retry task"} title={props.retryLabel ?? "Retry task"}
              data-testid={props.retryTestId} disabled={props.retryDisabled} onClick={props.onRetry}>
              Retry
            </Button>
          ) : null}
          {props.actions}
          {hasDetails ? (
            <CollapsibleTrigger data-testid="session-error-details-toggle"
              className={cn(
                "text-muted-foreground transition-opacity duration-150 motion-reduce:transition-none",
                open ? "opacity-100" : "opacity-0 group-hover/recovery:opacity-100 group-focus-within/recovery:opacity-100 pointer-coarse:opacity-100",
              )}
              render={<Button variant={open ? "secondary" : "ghost"} size="icon-xs" aria-label="Technical details" title="Technical details" />}>
              <CodeXml aria-hidden="true" />
            </CollapsibleTrigger>
          ) : null}
        </div>
      </div>
      {hasDetails ? <CollapsibleContent data-testid="session-error-details"
        className="overflow-hidden data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 duration-150 motion-reduce:animate-none">
        <div className="mt-2 flex min-w-0 items-start justify-between gap-3 rounded-md bg-muted px-3 py-2 text-muted-foreground">
          <pre className="max-h-60 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5">{details}</pre>
          <Button size="xs" variant="ghost" className="shrink-0" onClick={() => {
            void navigator.clipboard.writeText(details).then(() => setCopied(true)).catch(() => {});
          }}>{copied ? "Copied" : "Copy"}</Button>
        </div>
      </CollapsibleContent> : null}
    </Collapsible>
  );
}
