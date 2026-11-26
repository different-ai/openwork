import type { AutomationRunEvent } from "@openwork/types/automations"

type RunOutcome = "done" | "failed" | "blocked" | "asked" | "waiting"

const outcomeRank: Record<RunOutcome, number> = { done: 0, failed: 1, blocked: 2, asked: 3, waiting: 4 }

export const runOutcomeWords = {
  done: "",
  failed: "Did not work",
  blocked: "Blocked by your organization",
  asked: "Asked for a yes",
  waiting: "Waiting for your yes",
} satisfies Record<RunOutcome, string>

type RunTool = {
  tool: string | null
  connectionName: string | null
  label: string
  outcome: RunOutcome
}

type PendingTool = { toolName: string; connectionName?: string }

type RunStep = {
  kind: AutomationRunEvent["type"]
  label: string
  detail?: string
  time: number
}

const LOOKUP_LABEL = "Looked for tools"
const CONNECTED_APP_LABEL = "Used a connected app"
const lookupName = /(?:^|[_.:/-])(?:search|list|find|discover|lookup)_(?:capabilities|tools)$/i
const gatewayName = /(?:^|[_.:/-])(?:execute|invoke|call)_capability$/i

function nonEmptyText(value: unknown) {
  return typeof value === "string" ? value.trim() || null : null
}

function splitToolWords(name: string) {
  return name.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z0-9])([A-Z])/g, "$1_$2")
}

export function toolLabel(tool: string, connectionName: string | null): string {
  const prefix = connectionName?.trim().toLowerCase().replace(/[\s-]+/g, "_")
  const name = prefix && tool.toLowerCase().startsWith(`${prefix}_`) ? tool.slice(prefix.length + 1) : tool
  const words = splitToolWords(name).replace(/[_-]+/g, " ").trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function toolOutcome(payload: AutomationRunEvent["payload"], pending: readonly PendingTool[], tool: string | null, connectionName: string | null): RunOutcome {
  const { outcome, status } = payload
  const waiting = tool !== null && pending.some((item) => item.toolName === tool
    && (!connectionName || !item.connectionName || item.connectionName === connectionName))
  if (outcome === "asked") return waiting ? "waiting" : "asked"
  if (outcome === "blocked" || outcome === "failed" || outcome === "done") return outcome
  if (status === "error") return "failed"
  return "done"
}

function runTool(event: AutomationRunEvent, pending: readonly PendingTool[], includeLocal: boolean): RunTool | null {
  if (event.type === "capability_search") return { tool: null, connectionName: null, label: LOOKUP_LABEL, outcome: "done" }
  if (event.type !== "capability_execution") return null
  const { payload } = event
  const tool = nonEmptyText(payload.tool)
  const name = nonEmptyText(payload.name)
  const connectionName = tool ? nonEmptyText(payload.connectionName) : null
  const normalizedName = name ? splitToolWords(name) : ""
  const lookup = !tool && lookupName.test(normalizedName)
  const gateway = !tool && gatewayName.test(normalizedName)
  if (!includeLocal && !tool && !lookup && !gateway) return null
  const label = tool ? toolLabel(tool, connectionName) || CONNECTED_APP_LABEL
    : lookup ? LOOKUP_LABEL : gateway ? CONNECTED_APP_LABEL : name ? toolLabel(name, null) : "Used a tool"
  return { tool, connectionName, label, outcome: toolOutcome(payload, pending, tool ?? (gateway ? name : null), connectionName) }
}

export function runToolSummary(events: readonly AutomationRunEvent[], pending: readonly PendingTool[] = []) {
  const lines = new Map<string, RunTool & { count: number }>()
  for (const event of events) {
    const entry = runTool(event, pending, false)
    if (!entry) continue
    const key = entry.tool ? `${entry.connectionName ?? ""}\0${entry.tool}` : entry.label
    const line = lines.get(key)
    if (!line) lines.set(key, { ...entry, count: 1 })
    else {
      line.count++
      if (outcomeRank[entry.outcome] > outcomeRank[line.outcome]) line.outcome = entry.outcome
    }
  }
  return [...lines.values()]
}

export function runToolPreview(lines: ReturnType<typeof runToolSummary>) {
  return { visible: lines.slice(0, 6), remaining: Math.max(0, lines.length - 6) }
}

export function runTextPreview(text: string, limit: number, expanded: boolean) {
  const long = text.length > limit
  return { long, text: long && !expanded ? `${text.slice(0, limit).trimEnd()}…` : text }
}

export function runResultData(summary: string | null): string | null {
  if (!summary) return null
  try {
    const value: unknown = JSON.parse(summary)
    return JSON.stringify(value, null, 2)
  } catch {
    return null
  }
}

export function runMarkdownText(text: string): string {
  return text.replaceAll('data-openwork-shiki="true"', 'data-openwork-shiki=&quot;true&quot;')
}

export function runUsageLabel({ inputTokens, outputTokens, costMicros }: Record<string, unknown>, compact = false): string | null {
  const parts: string[] = []
  if (typeof inputTokens === "number") parts.push(`${inputTokens.toLocaleString("en-US")} in`)
  if (typeof outputTokens === "number") parts.push(`${outputTokens.toLocaleString("en-US")} out`)
  if (!parts.length) return null
  if (compact) return parts.join(" · ")
  if (typeof costMicros === "number") parts.push(`$${(costMicros / 1_000_000).toFixed(4)}`)
  return `Tokens: ${parts.join(" · ")}`
}

export function runSteps(events: readonly AutomationRunEvent[], pending: readonly PendingTool[] = []): RunStep[] {
  return events.flatMap<RunStep>((event) => {
    const { type: kind, payload, createdAt: time } = event
    const base = { kind, time }
    switch (kind) {
      case "user":
      case "assistant": {
        const detail = payload.text
        return typeof detail === "string" && detail.trim() ? [{ ...base, label: kind === "user" ? "Instructions" : "Reply", detail }] : []
      }
      case "warning":
        return typeof payload.message === "string" ? [{ ...base, label: "Note", detail: payload.message }] : []
      case "capability_search":
        return [{ ...base, label: LOOKUP_LABEL }]
      case "capability_execution": {
        const entry = runTool(event, pending, true)
        if (!entry) return []
        const label = entry.tool && entry.label !== CONNECTED_APP_LABEL
          ? `Used ${entry.label} in ${entry.connectionName ?? "a connected app"}`
          : entry.label
        const detail = runOutcomeWords[entry.outcome]
        return [{ ...base, label, ...(detail ? { detail } : {}) }]
      }
      case "terminal":
        if (payload.status === "succeeded") return [{ ...base, label: "Finished" }]
        if (payload.status === "failed") return [{ ...base, label: "Failed" }]
        if (payload.status === "cancelled") return [{ ...base, label: "Cancelled" }]
        return []
      case "usage": {
        const label = runUsageLabel(payload)
        return label ? [{ ...base, label }] : []
      }
    }
  })
}
