import type { DynamicToolUIPart, UIMessage } from "ai"
import type { AutomationRunEvent, AutomationRunReceipt } from "@openwork/types/automations"

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

type AssistantMessage = UIMessage & { role: "assistant" }

function automationRunTextMessage(id: string, text: string, created: number): UIMessage {
  return { id, role: "assistant", metadata: { opencode: { created } }, parts: [{ type: "text", text: runMarkdownText(text) }] }
}

function eventText(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null
}

function executionPart(event: AutomationRunEvent, active: boolean): DynamicToolUIPart | null {
  const { payload } = event
  const name = eventText(payload.name)
  const tool = eventText(payload.tool)
  const connection = eventText(payload.connectionName)
  const toolName = tool && connection ? `${connection}.${tool}` : tool ?? name
  if (!toolName || /(?:^|[_.:/-])(?:search|list|find|discover|lookup)_(?:capabilities|tools)$/i.test(toolName)) return null

  const base: Pick<DynamicToolUIPart, "type" | "toolName" | "toolCallId"> = {
    type: "dynamic-tool",
    toolName,
    toolCallId: `${event.attempt}:${eventText(payload.callId) ?? eventText(payload.partId) ?? event.id}`,
  }
  if (payload.outcome === "blocked") return { ...base, state: "output-error", input: {}, errorText: "Blocked by your organization." }
  if (payload.outcome === "asked") return { ...base, state: "output-error", input: {}, errorText: "Asked for your approval." }
  if (payload.outcome === "failed" || payload.status === "error") return { ...base, state: "output-error", input: {}, errorText: "This step failed." }
  if (payload.outcome !== "done" && (payload.status === "pending" || payload.status === "running")) {
    if (active) return { ...base, state: "input-available", input: {} }
    return { ...base, state: "output-error", input: {}, errorText: "This step did not finish." }
  }
  return { ...base, state: "output-available", input: {}, output: "" }
}

export function automationRunMessages({ events, run, revision }: {
  events: readonly AutomationRunEvent[]
  revision?: Pick<AutomationRunReceipt["revision"], "instructions">
  run: Pick<AutomationRunReceipt["run"], "id" | "status" | "attemptCount" | "resultSummary" | "finishedAt" | "updatedAt">
}): UIMessage[] {
  const messages: UIMessage[] = []
  const assistant = new Map<string, AssistantMessage>()
  const active = run.status === "running"
  const ordered = [...events].sort((a, b) => a.attempt - b.attempt || a.sequence - b.sequence)
  for (const event of ordered) {
    const { type, payload, createdAt, attempt } = event
    const text = eventText(payload.text)
    if (type === "user") {
      const instructions = revision?.instructions.trim()
      if (instructions) messages.push({ id: event.id, role: "user", metadata: { opencode: { created: createdAt } }, parts: [{ type: "text", text: instructions }] })
      continue
    }
    if (type !== "assistant" && type !== "capability_execution") continue
    const part = type === "capability_execution" ? executionPart(event, active && attempt === run.attemptCount) : null
    if (type === "capability_execution" && !part) continue
    const messageId = eventText(payload.messageId)
    const key = `${attempt}:${messageId ?? event.id}`
    let message = assistant.get(key)
    if (!message) {
      message = { id: key, role: "assistant", metadata: { opencode: { created: createdAt } }, parts: [] }
      assistant.set(key, message)
      messages.push(message)
    }
    if (part) {
      const answerIndex = message.parts.findIndex((candidate) => candidate.type === "text")
      message.parts.splice(answerIndex === -1 ? message.parts.length : answerIndex, 0, part)
    } else if (text) {
      message.parts.push({ type: "text", text: runMarkdownText(text) })
    }
  }
  const visible = messages.filter((message) => message.parts.length > 0)
  const summary = run.status === "succeeded" ? run.resultSummary?.trim() : null
  const end = visible.at(-1)
  if (summary && runResultData(summary) === null && !(end?.role === "assistant" && end.parts.some((part) => part.type === "text" && part.text.trim() === runMarkdownText(summary)))) {
    visible.push(automationRunTextMessage(`result:${run.id}`, summary, run.finishedAt ?? run.updatedAt))
  }
  return visible
}

export function showsAutomationExecutionTranscript(enabled: boolean, input: {
  actionKind?: NonNullable<AutomationRunReceipt["revision"]["action"]>["kind"]
  hasExecutionThread: boolean
  agentId?: string | null
}) {
  return enabled && input.actionKind !== "saved_script"
    && (input.actionKind === "agent" || input.hasExecutionThread || Boolean(input.agentId))
}
