"use client"

import { useId, useState } from "react"
import { ChevronDown, GitBranch, CircleAlert } from "lucide-react"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { SubagentRunLineView } from "@/components/chat/subagent-run-line"
import { taskChildSessionId, type TaskToolPart } from "@/lib/build-in-tools"
import { cn } from "@/lib/utils"
import { useSessionActivityStore } from "@/react-app/domains/session/status/session-activity-store"

type SubagentOverviewProps = {
  tasks: TaskToolPart[]
  workspaceId: string
  parentActive: boolean
  syncDegraded?: boolean
  onOpenSubagentSession?: (sessionId: string) => void
}

/** A doorway to pending delegations, not a second copy of the transcript. */
export function SubagentOverview({ tasks, workspaceId, parentActive, syncDegraded, onOpenSubagentSession }: SubagentOverviewProps) {
  const [open, setOpen] = useState(false)
  const noticeId = useId()
  const children = useSessionActivityStore((state) => state.recordsByWorkspaceId[workspaceId])
  let needsInput = 0
  let errors = 0
  for (const task of tasks) {
    const childId = taskChildSessionId(task)
    const child = childId ? children?.[childId] : undefined
    if (child?.waitingPermissionIds.length || child?.waitingQuestionIds.length) needsInput++
    else if (child?.errorActive) errors++
  }
  const notice = needsInput
    ? `${needsInput} ${needsInput === 1 ? "needs" : "need"} input`
    : errors ? `${errors} ${errors === 1 ? "needs" : "need"} attention`
    : syncDegraded ? "Reconnecting…" : null

  // Only the delegating tool settling removes an entry. Idle children may still
  // be returning a result, so the count must not claim they are all working.
  if (!tasks.length) return null

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-testid="subagent-overview"
      className={cn("min-w-0", open
        ? "rounded-xl border border-border bg-muted/20"
        : "w-fit max-w-full")}
    >
      <CollapsibleTrigger
        data-testid="subagent-overview-toggle"
        aria-label={`${open ? "Hide" : "Show"} ${tasks.length} ${tasks.length === 1 ? "subagent" : "subagents"}`}
        aria-describedby={notice ? noticeId : undefined}
        className={cn("flex w-full min-w-0 cursor-pointer items-center gap-2 px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", open
          ? "rounded-t-xl hover:bg-muted/50"
          : "rounded-full border border-border bg-muted/30 hover:bg-muted/60")}
      >
        <GitBranch aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="font-medium text-foreground">Subagents</span>
        <span className="shrink-0 tabular-nums">{tasks.length}</span>
        {notice ? (
          <span id={noticeId} role="status" className={cn("flex min-w-0 items-center gap-1.5", (needsInput > 0 || errors > 0) && "text-amber-11")}>
            <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">{notice}</span>
          </span>
        ) : null}
        <ChevronDown aria-hidden="true" className={cn("ml-auto size-3.5 shrink-0 transition-transform", open && "rotate-180")} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul aria-label="Subagent tasks" className="max-h-[min(16rem,30vh)] space-y-0.5 overflow-y-auto overscroll-contain border-t border-border p-1">
          {tasks.map((part) => (
            <li key={part.toolCallId}>
              <SubagentRunLineView
                part={part}
                workspaceId={workspaceId}
                parentActive={parentActive}
                syncDegraded={syncDegraded}
                onOpenSubagentSession={onOpenSubagentSession}
                compact
              />
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}
