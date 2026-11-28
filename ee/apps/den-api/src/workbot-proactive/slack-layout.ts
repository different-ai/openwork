import type { SlackPart } from "../slack-assistant/rich-message.js"

function listed(names: readonly string[]) {
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))]
  const shown = unique.slice(0, 4)
  const more = unique.length - shown.length
  if (more > 0) return `${shown.join(", ")} and ${more} more`
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : (shown[0] ?? "")
}

export function agentBriefParts(input: { text: string; sources: readonly string[]; at: number; timeZone: string; first: boolean }): SlackPart[] {
  const findings = input.text.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean)
  if (findings.length === 0) return []
  const clock = new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone, hour: "numeric", minute: "2-digit" }).format(input.at)
  const read = listed(input.sources)
  return [
    ...(input.first && findings.length > 1 ? [{ type: "header" as const, text: "Today's brief" }] : []),
    ...findings.flatMap((text, index): SlackPart[] => [...(index > 0 ? [{ type: "divider" as const }] : []), { type: "mrkdwn", text }]),
    { type: "context", text: read ? `Your agent read ${read} at ${clock}` : `Your agent checked at ${clock}` },
  ]
}

export function agentNoticeParts(input: { text: string; actions: readonly { text: string; url: string }[] }): SlackPart[] {
  const actions = input.actions.slice(0, 5)
  return [{ type: "mrkdwn", text: input.text }, ...(actions.length ? [{ type: "buttons" as const, buttons: actions.map((action) => ({ text: action.text.slice(0, 75), url: action.url })) }] : [])]
}
