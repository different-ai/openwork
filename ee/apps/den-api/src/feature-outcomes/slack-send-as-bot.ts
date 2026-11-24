import { readSlackSendAsBotWindows, SLACK_SEND_AS_BOT_LIMITS } from "../mcp/slack-send-as-bot.js"
import { utcDay, type FeatureOutcomeReader, type FeatureOutcomeRow } from "./outcomes.js"

const DAY_MS = 86_400_000

export const readSlackSendAsBotOutcomes: FeatureOutcomeReader = async (range) => {
  const lastDay = range.to.getTime() - DAY_MS
  const since = Math.max(range.from.getTime(), lastDay)
  const rows: FeatureOutcomeRow[] = []
  const limited = new Map<string, number>()
  for (const window of await readSlackSendAsBotWindows(since)) {
    const day = utcDay(window.start)
    const lastAt = new Date(window.lastDeliveredAt ?? window.start)
    if (window.delivered > 0) {
      rows.push({ organizationId: window.organizationId, day, status: "succeeded", reason: null, count: window.delivered, delivered: window.delivered, lastAt })
    }
    const refused = window.admitted - window.delivered
    if (refused > 0) rows.push({ organizationId: window.organizationId, day, status: "failed", reason: "slack_refused", count: refused, delivered: 0, lastAt })
    if (window.admitted >= SLACK_SEND_AS_BOT_LIMITS.perDay) limited.set(window.organizationId, (limited.get(window.organizationId) ?? 0) + 1)
  }
  return { unit: "message", rows, limited, coverage: since > range.from.getTime() ? { from: new Date(since), counts: "all" } : null }
}
