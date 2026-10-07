"use client"

import { useWorkbenchDisclosure } from "@/react-app/domains/session/chat/workbench-ui-state"
import { ChevronDown } from "lucide-react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { MessageContent } from "@/components/ui/message"
import { formatToolCallDuration } from "@/lib/tool-call-duration"
import { cn } from "@/lib/utils"

type ReasoningBlockProps = {
  startedAt?: number
  endedAt?: number
  text: string
  isStreaming: boolean
  className?: string
  disclosureKey?: string
}

/**
 * Thinking is collapsed by default — a single "Thinking… / Thought"
 * line with a chevron; the full reasoning renders as markdown only
 * when the user opens it.
 */
export function ReasoningBlock({ text, isStreaming, className, disclosureKey, startedAt, endedAt }: ReasoningBlockProps) {
  const [open, setOpen] = useWorkbenchDisclosure(disclosureKey)
  const label = isStreaming
    ? "Thinking…"
    : startedAt !== undefined && endedAt !== undefined && Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt
      ? `Thought for ${formatToolCallDuration(endedAt - startedAt)}`
      : "Thought"
  // Nothing to disclose yet: a plain line, never an empty disclosure.
  if (!text) {
    return (
      <div data-reasoning-block="" className={cn("text-sm text-muted-foreground", isStreaming && "ow-text-shimmer motion-reduce:animate-none", className)}>
        {label}
      </div>
    )
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn("w-full", className)} data-reasoning-block="">
      <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <span className={cn(isStreaming && "ow-text-shimmer motion-reduce:animate-none")}>
          {label}
        </span>
        <ChevronDown
          aria-hidden="true"
          className="size-3.5 text-muted-foreground/70 transition-transform duration-150 group-data-panel-open:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-150 ease-out data-starting-style:h-0 data-ending-style:h-0 [&[hidden]:not([hidden='until-found'])]:hidden">
        <MessageContent
          markdown
          isStreaming={isStreaming}
          className="text-muted-foreground prose mt-1 w-full min-w-0 rounded-lg bg-transparent p-0 text-sm"
        >
          {text}
        </MessageContent>
      </CollapsibleContent>
    </Collapsible>
  )
}
