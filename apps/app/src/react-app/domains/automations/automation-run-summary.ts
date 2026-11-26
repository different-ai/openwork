import type { AutomationRunEvent } from "@openwork/types/automations"

type RunOutcome = "done" | "failed" | "blocked" | "asked"

const outcomeRank: Record<RunOutcome, number> = { done: 0, failed: 1, blocked: 2, asked: 3 }

export const runOutcomeWords = {
  done: "",
  failed: "Did not work",
  blocked: "Blocked by your organization",
  asked: "Waiting for your yes",
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
const lookupName = /(?:^|[_.:/-])(?:search|list|find|discover|lookup)[_-](?:capabilities|tools)$/i

function nonEmptyText(value: unknown) {
  return typeof value === "string" ? value.trim() || null : null
}

export function toolLabel(tool: string, connectionName: string | null): string {
  const prefix = connectionName?.trim().toLowerCase().replace(/[\s-]+/g, "_")
  const words = (prefix && tool.toLowerCase().startsWith(`${prefix}_`) ? tool.slice(prefix.length + 1) : tool)
    .replace(/_+/g, " ").trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function runTool(event: AutomationRunEvent, pending: readonly PendingTool[]): RunTool | null {
  if (event.type === "capability_search") return { tool: null, connectionName: null, label: LOOKUP_LABEL, outcome: "done" }
  if (event.type !== "capability_execution") return null
  const { payload } = event
  const tool = nonEmptyText(payload.tool)
  const name = nonEmptyText(payload.name)
  const connectionName = tool ? nonEmptyText(payload.connectionName) : null
  const lookup = !tool && name !== null && lookupName.test(name)
  const label = tool ? toolLabel(tool, connectionName) || CONNECTED_APP_LABEL : lookup ? LOOKUP_LABEL : CONNECTED_APP_LABEL
  const outcome = payload.outcome
  if (outcome === "asked" || outcome === "blocked" || outcome === "failed" || outcome === "done") {
    return { tool, connectionName, label, outcome }
  }
  const waiting = !lookup && pending.some((item) => item.toolName === (tool ?? name)
    && (!item.connectionName || !connectionName || item.connectionName === connectionName))
  return { tool, connectionName, label, outcome: waiting ? "asked" : "done" }
}

export function runToolSummary(events: readonly AutomationRunEvent[], pending: readonly PendingTool[] = []) {
  const lines = new Map<string, RunTool & { count: number }>()
  for (const event of events) {
    const entry = runTool(event, pending)
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

export function runUsageLabel({ inputTokens, outputTokens, costMicros }: Record<string, unknown>): string | null {
  const parts: string[] = []
  if (typeof inputTokens === "number") parts.push(`${inputTokens.toLocaleString("en-US")} in`)
  if (typeof outputTokens === "number") parts.push(`${outputTokens.toLocaleString("en-US")} out`)
  if (!parts.length) return null
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
        const entry = runTool(event, pending)
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
