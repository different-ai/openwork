import { useId, useState } from "react"
import { ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import type { AutomationRunEvent } from "@openwork/types/automations"

import { formatAutomationTime } from "./automation-format"
import { runOutcomeWords, runSteps, runToolSummary } from "./automation-run-summary"

type RunDetailsProps = {
  events: readonly AutomationRunEvent[]
  pending?: readonly { toolName: string; connectionName?: string }[]
}

export function AutomationRunDid({ events, pending }: RunDetailsProps) {
  const lines = runToolSummary(events, pending)
  if (!lines.length) return null
  return <section className="space-y-1">
    <h3 className="text-sm font-medium">What it did</h3>
    <ul data-run-did className="space-y-1 text-sm">
      {lines.map(({ tool, connectionName, label, count, outcome }) => (
        <li key={tool ? `${connectionName ?? ""}\0${tool}` : label} data-run-did-item={tool ?? "generic"} className="flex flex-wrap items-baseline justify-between gap-x-3 wrap-anywhere">
          <span className={tool ? undefined : "text-muted-foreground"}>
            {label}{connectionName && <span className="text-muted-foreground"> · {connectionName}</span>}
            {count > 1 && <span className="text-muted-foreground"> ×{count}</span>}
          </span>
          {outcome !== "done" && <span className="text-xs text-muted-foreground">{runOutcomeWords[outcome]}</span>}
        </li>
      ))}
    </ul>
  </section>
}

const INSTRUCTION_PREVIEW_LENGTH = 280

function Instructions({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const long = text.length > INSTRUCTION_PREVIEW_LENGTH
  return <>
    <p className="mt-1 whitespace-pre-wrap wrap-anywhere text-xs text-muted-foreground">
      {long && !expanded ? `${text.slice(0, INSTRUCTION_PREVIEW_LENGTH).trimEnd()}…` : text}
    </p>
    {long && <Button size="xs" variant="link" className="px-0" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      {expanded ? "Show less" : "Show all"}
    </Button>}
  </>
}

export function AutomationRunSteps({ events, pending }: RunDetailsProps) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const steps = open ? runSteps(events, pending) : []
  return <Collapsible open={open} onOpenChange={setOpen}>
    <CollapsibleTrigger render={<Button size="xs" variant="ghost" className="px-0 text-muted-foreground" />}
      data-run-steps-toggle aria-expanded={open} aria-controls={panelId}>
      <ChevronRight aria-hidden="true" className={open ? "size-4 rotate-90" : "size-4"} />
      {open ? "Hide steps" : "Show steps"}
    </CollapsibleTrigger>
    <CollapsibleContent id={panelId} keepMounted>
      {open && <ol data-run-steps className="mt-2 space-y-3 border-s border-border ps-3">
        {steps.map(({ kind, label, detail, time }, index) => (
          <li key={`${kind}-${time}-${index}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
              <span className="text-xs font-medium">{label}</span>
              <time className="text-xs text-muted-foreground">{formatAutomationTime(time)}</time>
            </div>
            {detail && (kind === "user" ? <Instructions text={detail} /> : (
              <p className="mt-1 whitespace-pre-wrap wrap-anywhere text-xs text-muted-foreground">{detail}</p>
            ))}
          </li>
        ))}
      </ol>}
    </CollapsibleContent>
  </Collapsible>
}
