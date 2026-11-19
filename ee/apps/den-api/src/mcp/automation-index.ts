import type { McpServer } from "@modelcontextprotocol/server"
import { formatAutomationSchedule } from "@openwork/types/automation-schedule"
import { AUTOMATION_LEGACY_SCHEDULE_KINDS, type AutomationList } from "@openwork/types/automations"

export const AGENT_AUTOMATION_INDEX_URI = "automation://index.json"
export const AGENT_AUTOMATION_INDEX_SCHEMA = "https://schemas.openworklabs.com/automations/discovery/0.3.0/schema.json"

/**
 * How many Automations the discovery index carries. The index rides in every
 * system prompt, so it is bounded on purpose; the count of what was left out
 * travels with it so a caller can tell "you have none" from "there are more".
 */
export const AGENT_AUTOMATION_INDEX_LIMIT = 25

export type AgentAutomationIndexEntry = {
  id: string
  name: string
  state: string
  schedule: AutomationList["items"][number]["revision"]["schedule"]
  /** The schedule in words, e.g. "Every 3 hours · 09:00–18:00 · UTC". */
  summary: string
  nextDueAt: number | null
  executionTarget: "desktop" | "cloud"
  latestRun: { status: string; trigger: string; finishedAt: number | null } | null
}

/**
 * Discovery metadata for the Automations this member owns.
 *
 * Unlike the skill index this describes live, mutable state: a schedule can be
 * edited and a run can finish a second after the index is built. `fetchedAt`
 * travels with it so consumers can say how old the snapshot is, and callers are
 * expected to re-read through a capability before acting on anything timely.
 */
export function buildAgentAutomationIndex(input: {
  items: AutomationList["items"]
  fetchedAt: number
  totalKnown?: number
}) {
  const included = input.items.slice(0, AGENT_AUTOMATION_INDEX_LIMIT)
  const total = input.totalKnown ?? input.items.length
  const entries = included.map((item): AgentAutomationIndexEntry => ({
    id: item.automation.id,
    name: item.automation.name,
    state: item.automation.state,
    schedule: item.revision.schedule,
    summary: formatAutomationSchedule(item.revision.schedule, "en-US"),
    nextDueAt: item.automation.nextDueAt,
    executionTarget: item.revision.executionTarget ?? "desktop",
    latestRun: item.latestRun
      ? {
        status: item.latestRun.status,
        trigger: item.latestRun.trigger,
        finishedAt: item.latestRun.finishedAt,
      }
      : null,
  }))
  const legacy = new Set<string>(AUTOMATION_LEGACY_SCHEDULE_KINDS)
  return {
    $schema: AGENT_AUTOMATION_INDEX_SCHEMA,
    fetchedAt: input.fetchedAt,
    total,
    omitted: Math.max(0, total - included.length),
    /**
     * Released desktops parse every entry here with a schedule schema that
     * knows only once, daily and weekly, and drop the whole index on any other
     * kind. Entries with newer kinds travel in `moreAutomations`, which they
     * ignore; readers should list both.
     */
    automations: entries.filter((entry) => legacy.has(entry.schedule.kind)),
    moreAutomations: entries.filter((entry) => !legacy.has(entry.schedule.kind)),
  }
}

export function registerAgentAutomationResources(input: {
  server: McpServer
  items: AutomationList["items"]
  fetchedAt: number
  totalKnown?: number
}) {
  input.server.registerResource("agent-automations-index", AGENT_AUTOMATION_INDEX_URI, {
    title: "Your Automations",
    description: "Discovery index of the Automations this OpenWork member owns, with live schedule and run state.",
    mimeType: "application/json",
  }, async () => ({
    contents: [{
      uri: AGENT_AUTOMATION_INDEX_URI,
      mimeType: "application/json",
      text: JSON.stringify(buildAgentAutomationIndex(input)),
    }],
  }))
}
