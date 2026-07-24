"use client"

import { useState } from "react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { DotMatrixLoader } from "@/components/ui/dot-matrix-loader"
import type { TaskToolPart } from "@/lib/build-in-tools"
import { isToolPartInFlight } from "@/lib/tool-activity"
import { trackToolCallDuration } from "@/lib/tool-call-duration"
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
 * Paper "Sub-agents" rule: dot-matrix while running, gray dot when done.
 * Line 1 = task title + agent name; line 2 = live status verb or
 * "Completed". Prompt and result live under the collapsed panel.
 */
export function SubagentRunLine({ part, className }: SubagentRunLineProps) {
  const [open, setOpen] = useState(false)
  const inFlight = isToolPartInFlight(part)
  const isFailed = part.state === "output-error"
  const duration = trackToolCallDuration(part)
  const title = part.input?.description?.trim() || "Sub-agent task"
  const agent = agentName(part.input?.subagent_type ?? "")
  const status = inFlight
    ? "Working…"
    : isFailed
      ? part.errorText?.split("\n")[0]?.trim() || "Failed"
      : "Completed"

  return (
    <Collapsible data-subagent-run={part.toolCallId} open={open} onOpenChange={setOpen} className={className}>
      <CollapsibleTrigger
        className="group flex min-w-0 max-w-full cursor-pointer flex-col gap-0.5 text-start text-sm text-muted-foreground transition-colors hover:text-foreground"
        aria-label={open ? `${title}. Hide details` : `${title}. Show details`}
      >
        <span className="flex min-w-0 items-center gap-2">
          {inFlight ? (
            <span className="flex size-3.5 shrink-0 items-center justify-center">
              <DotMatrixLoader label={`${title} — ${agent}`} className="text-muted-foreground" />
            </span>
          ) : null}
          <span className="min-w-0 truncate">
            {title}
            <span className="text-muted-foreground/70"> · {agent} agent</span>
          </span>
        </span>
        <span className={cn("min-w-0 truncate text-xs text-muted-foreground/70", inFlight && "ps-5.5")}>
          {isFailed ? `Failed — ${status}` : status}
          {!inFlight && !isFailed && duration ? ` · ${duration}` : ""}
        </span>
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
