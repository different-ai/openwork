"use client"

import { useEffect, useState } from "react"
import { ArrowUpRight } from "lucide-react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { useMessageList } from "@/components/chat/message-list-provider"
import { taskChildSessionId, type TaskToolPart } from "@/lib/build-in-tools"
import { isToolPartInFlight } from "@/lib/tool-activity"
import { formatElapsedSeconds, getToolCallStartedAt, trackToolCallDuration } from "@/lib/tool-call-duration"
import { cn } from "@/lib/utils"

type SubagentRunLineProps = {
  part: TaskToolPart
  className?: string
}

function agentName(slug: string): string {
  const words = slug.split(/[-_.\s]+/).filter(Boolean)
  if (words.length === 0) return "Agent"
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

/**
 * Running sub-agent task cards use a quiet text shimmer for activity.
 * Line 1 = task title + agent name; line 2 = live status verb or
 * "Completed". The card is the doorway into the sub-agent's own session:
 * when the engine reports the child session id, clicking it opens that
 * session in the main chat surface. Otherwise the prompt and result live
 * under the collapsed panel.
 */
export function SubagentRunLine({ part, className }: SubagentRunLineProps) {
  const [open, setOpen] = useState(false)
  const { onOpenSubagentSession, syncDegraded } = useMessageList()
  const childSessionId = taskChildSessionId(part)
  const inFlight = isToolPartInFlight(part)
  const isFailed = part.state === "output-error"
  const duration = trackToolCallDuration(part)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  // First-seen-in-flight time lives in a module map, so remounting (like
  // switching sessions and back) resumes the counter instead of restarting.
  const startedAt = getToolCallStartedAt(part)
  useEffect(() => {
    // While run liveness is unconfirmed the counter must not tick; the
    // module-scoped anchor resumes the true elapsed time on recovery.
    if (!inFlight || startedAt === null || syncDegraded) return
    const update = () => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
    }
    update()
    const interval = window.setInterval(update, 1000)
    return () => window.clearInterval(interval)
  }, [inFlight, startedAt, part.toolCallId, syncDegraded])
  const title = part.input?.description?.trim() || "Sub-agent task"
  const agent = agentName(part.input?.subagent_type ?? "")
  const status = inFlight
    ? syncDegraded
      ? "Connection lost — reconnecting…"
      : `Working ${formatElapsedSeconds(elapsedSeconds)}`
    : isFailed
      ? part.errorText?.split("\n")[0]?.trim() || "Failed"
      : "Completed"

  const lines = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <span className={cn("min-w-0 truncate", inFlight && !syncDegraded && "ow-text-shimmer")}>
          {title}
          <span className="text-muted-foreground/70"> · {agent} agent</span>
        </span>
        {childSessionId && onOpenSubagentSession ? (
          <ArrowUpRight
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          />
        ) : null}
      </span>
      <span className="min-w-0 truncate text-xs text-muted-foreground/70">
        {isFailed ? `Failed — ${status}` : status}
        {!inFlight && !isFailed && duration ? ` · ${duration}` : ""}
      </span>
    </>
  )

  if (childSessionId && onOpenSubagentSession) {
    return (
      <div
        data-subagent-run={part.toolCallId}
        data-subagent-session-id={childSessionId}
        data-subagent-activity={inFlight ? (syncDegraded ? "reconnecting" : "shimmer") : isFailed ? "failed" : "completed"}
        className={className}
      >
        <button
          type="button"
          className="group flex min-w-0 max-w-full cursor-pointer flex-col gap-0.5 text-start text-sm text-muted-foreground transition-colors hover:text-foreground"
          aria-label={`${title}. Open sub-agent chat`}
          onClick={() => onOpenSubagentSession(childSessionId)}
        >
          {lines}
        </button>
      </div>
    )
  }

  return (
    <Collapsible
      data-subagent-run={part.toolCallId}
      data-subagent-activity={inFlight ? (syncDegraded ? "reconnecting" : "shimmer") : isFailed ? "failed" : "completed"}
      open={open}
      onOpenChange={setOpen}
      className={className}
    >
      <CollapsibleTrigger
        className="group flex min-w-0 max-w-full cursor-pointer flex-col gap-0.5 text-start text-sm text-muted-foreground transition-colors hover:text-foreground"
        aria-label={open ? `${title}. Hide details` : `${title}. Show details`}
      >
        {lines}
      </CollapsibleTrigger>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-150 ease-out data-starting-style:h-0 data-ending-style:h-0 [&[hidden]:not([hidden='until-found'])]:hidden">
        <div className="mt-2 flex flex-col gap-2 rounded-lg bg-muted p-2 text-xs">
          {part.input?.prompt ? (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap wrap-break-word">
              {part.input.prompt}
            </pre>
          ) : null}
          {part.state === "output-available" ? (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap wrap-break-word opacity-80">
              {part.output}
            </pre>
          ) : null}
          {isFailed && part.errorText ? (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap wrap-break-word opacity-80">
              {part.errorText}
            </pre>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
