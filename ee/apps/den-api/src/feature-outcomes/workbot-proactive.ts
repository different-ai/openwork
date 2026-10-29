import {
  MEMBER_CHECK_RETENTION_MS,
  readAgentCheckFailuresByDay,
  readAgentCheckTotalsByDay,
  readAgentDailyLimitMembers,
} from "../workbot-proactive/repository.js"
import type { FeatureOutcomeReader, FeatureOutcomeRow } from "./outcomes.js"

/**
 * Your agent (`workbotProactive`). A check is one responsibility asked about in one pass, as Manage › Workbot's
 * health view counts them: the daily counters (agent_check) hold every member's checks and the messages they sent.
 * A pass that could not run or send never reaches those counters; the members' check records (agent_member_check)
 * say why, as a reason code, and that it hit the daily limit. Those exist only for members with My agent and are kept
 * about two weeks, so failures before then are not known.
 */
export const readAgentOutcomes: FeatureOutcomeReader = async (range) => {
  const retained = new Date(range.to.getTime() - MEMBER_CHECK_RETENTION_MS)
  const since = retained > range.from ? retained : range.from
  const [totals, failures, limited] = await Promise.all([
    readAgentCheckTotalsByDay(range.days[0] ?? "", range.days.at(-1) ?? ""),
    readAgentCheckFailuresByDay(since, range.to),
    readAgentDailyLimitMembers(since, range.to),
  ])
  const rows: FeatureOutcomeRow[] = [
    ...totals.flatMap((row): FeatureOutcomeRow[] => row.lastAt ? [{
      organizationId: row.organizationId, day: row.day, status: "succeeded", reason: null, count: row.checks, delivered: row.sent, lastAt: row.lastAt,
    }] : []),
    ...failures.flatMap((row): FeatureOutcomeRow[] => row.lastAt ? [{
      organizationId: row.organizationId, day: row.day, status: "failed", reason: row.reason, count: row.checks, delivered: null, lastAt: row.lastAt,
    }] : []),
  ]
  return { unit: "check", rows, limited, coverage: since > range.from ? { from: since, counts: "failed" } : null }
}
