import { useId, useState, type ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import type { AutomationRunEvent } from "@openwork/types/automations"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { MarkdownBlock } from "@/components/markdown/markdown"
import { UntrustedMarkdown } from "@/components/markdown/untrusted-markdown"

import { formatAutomationTime } from "./automation-format"
import { runMarkdownText, runOutcomeWords, runResultData, runSteps, runTextPreview, runToolPreview, runToolSummary } from "./automation-run-summary"

function RunMarkdown({ text }: { text: string }) {
  return <UntrustedMarkdown><MarkdownBlock className="min-w-0 wrap-anywhere" text={runMarkdownText(text)} /></UntrustedMarkdown>
}

function TextPreview({ text, limit, markdown = false }: { text: string; limit: number; markdown?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const preview = runTextPreview(text, limit, expanded)
  return <>
    {markdown ? <RunMarkdown text={preview.text} /> : <p className="mt-1 whitespace-pre-wrap wrap-anywhere text-xs text-muted-foreground">{preview.text}</p>}
    {preview.long && <Button size="xs" variant="link" className="px-0" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      {expanded ? "Show less" : "Show all"}
    </Button>}
  </>
}

export function AutomationRunDetails({ events, pending, result, children, transcript }: {
  events: readonly AutomationRunEvent[]
  pending?: readonly { toolName: string; connectionName?: string }[]
  result: string | null
  children?: ReactNode
  transcript?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const detailEvents = transcript ? events.filter(({ type }) => type === "warning" || type === "usage" || type === "terminal") : events
  const steps = open ? runSteps(detailEvents, pending) : []
  const { visible, remaining } = runToolPreview(transcript ? [] : runToolSummary(events, pending))
  const resultData = runResultData(result)
  return <>
    {transcript}
    {result && <section data-run-result className="min-w-0 space-y-1 text-sm">
      <h3 className="font-medium">Result</h3>
      {resultData !== null ? <p>Finished with structured results.</p> : <TextPreview text={result} limit={1200} markdown />}
    </section>}
    {visible.length > 0 && <section className="space-y-1">
      <h3 className="text-sm font-medium">What it did</h3>
      <ul data-run-did className="space-y-1 text-sm">
        {visible.map(({ tool, connectionName, label, count, outcome }) => (
          <li key={tool ? `${connectionName ?? ""}\0${tool}` : label} data-run-did-item={tool ?? "generic"} className="flex flex-wrap items-baseline justify-between gap-x-3 wrap-anywhere">
            <span className={tool ? undefined : "text-muted-foreground"}>
              {label}{connectionName && <span className="text-muted-foreground"> · {connectionName}</span>}
              {count > 1 && <span className="text-muted-foreground"> ×{count}</span>}
            </span>
            {outcome !== "done" && <span className="text-xs text-muted-foreground">{runOutcomeWords[outcome]}</span>}
          </li>
        ))}
      </ul>
      {remaining > 0 && <Button size="xs" variant="link" className="px-0" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(true)}>
        and {remaining} more
      </Button>}
    </section>}
    {children}
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger render={<Button size="xs" variant="ghost" className="px-0 text-muted-foreground" />}
        data-run-steps-toggle aria-expanded={open} aria-controls={panelId}>
        <ChevronRight aria-hidden="true" className={open ? "size-4 rotate-90" : "size-4"} />
        {open ? "Hide steps" : "Show steps"}
      </CollapsibleTrigger>
      <CollapsibleContent id={panelId} keepMounted>
        {open && <>
          <ol data-run-steps className="mt-2 space-y-3 border-s border-border ps-3">
            {steps.map(({ kind, label, detail, time }, index) => (
              <li key={`${kind}-${time}-${index}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                  <span className="text-xs font-medium">{label}</span>
                  <time className="text-xs text-muted-foreground">{formatAutomationTime(time)}</time>
                </div>
                {detail && (kind === "user" ? <TextPreview text={detail} limit={280} /> : kind === "assistant" ? <RunMarkdown text={detail} /> : (
                  <p className="mt-1 whitespace-pre-wrap wrap-anywhere text-xs text-muted-foreground">{detail}</p>
                ))}
              </li>
            ))}
          </ol>
          {resultData !== null && <section className="mt-3 min-w-0 space-y-1">
            <h3 className="text-xs font-medium">Result data</h3>
            <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs" tabIndex={0} aria-label="Result data">{resultData}</pre>
          </section>}
        </>}
      </CollapsibleContent>
    </Collapsible>
  </>
}
