import type { PersonalAgentRoutineSummary } from "@openwork/types/den/personal-agents"
import { listAgentRoutineItems } from "../automations/repository.js"

export async function personalAgentRoutineSummaries(agentIds: readonly string[], memberId?: string): Promise<Map<string, PersonalAgentRoutineSummary[]>> {
  const summaries = new Map(agentIds.map((id) => [id, new Array<PersonalAgentRoutineSummary>()]))
  for (const { automation, revision, latestRun } of await listAgentRoutineItems(agentIds, memberId)) {
    if (!automation.agentId) continue
    summaries.get(automation.agentId)?.push({
      id: automation.id,
      name: automation.name,
      state: automation.state,
      schedule: revision.schedule,
      nextDueAt: automation.nextDueAt,
      latestRun: latestRun ? { id: latestRun.id, status: latestRun.status, createdAt: latestRun.createdAt, finishedAt: latestRun.finishedAt } : null,
    })
  }
  return summaries
}
