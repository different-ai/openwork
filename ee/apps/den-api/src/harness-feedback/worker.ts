import { env } from "../env.js"
import { createEvaluationModel, type EvaluationModel } from "../llm/evaluation-model.js"
import { createIssueNamingModel, type IssueNamingModel } from "../llm/issue-naming-model.js"
import { appLogger } from "../observability/logger.js"
import { isHarnessFeedbackOrganization } from "./access.js"
import { classifyHarnessFeedback, type HarnessFeedbackEvidence } from "./classifier.js"
import { matchHarnessFeedback } from "./grouping.js"
import {
  claimDueHarnessFeedback, nameLegacyHarnessFeedbackGroup, readEarliestHarnessFeedbackReport,
  readHarnessFeedbackCandidates, readLegacyHarnessFeedbackGroups, settleHarnessFeedback,
  type ClaimedHarnessFeedback, type HarnessFeedbackDecision,
} from "./repository.js"

const TICK_MS = 15_000
const REPORT_BATCH_SIZE = 4
const MAX_ATTEMPTS = 3
const RETRY_BASE_MS = 60_000

export async function decideHarnessFeedback(report: HarnessFeedbackEvidence & Pick<ClaimedHarnessFeedback, "organizationId">,
  model: EvaluationModel, nameIssue: IssueNamingModel): Promise<HarnessFeedbackDecision> {
  const judgment = await classifyHarnessFeedback(model, report)
  if (judgment.state !== "classified") return judgment
  const { candidates, groupCount } = await readHarnessFeedbackCandidates(report.organizationId, report.tool)
  const match = await matchHarnessFeedback(model, report, candidates)
  return match ? { ...judgment, groupCount, groupId: match.id } : { ...judgment, groupCount, issue: await nameIssue(report) }
}

export async function processHarnessFeedbackReport(report: ClaimedHarnessFeedback, model: EvaluationModel, nameIssue: IssueNamingModel, now = Date.now) {
  if (!(await isHarnessFeedbackOrganization(report.organizationId, { fresh: true })) || !report.leaseExpiresAt || report.leaseExpiresAt.getTime() <= now()) return false
  let decision
  try {
    decision = await decideHarnessFeedback(report, model, nameIssue)
  } catch {
    const attempts = report.attempts + 1
    const state = attempts >= MAX_ATTEMPTS ? "needs_review" : "pending"
    const failedAt = now()
    const nextAttemptAt = new Date(state === "pending" ? failedAt + RETRY_BASE_MS * 2 ** (attempts - 1) : failedAt)
    appLogger.warn("harness_feedback_evaluation_failed", { report_id: report.id, attempts, state })
    return settleHarnessFeedback(report, { state, attempts, nextAttemptAt }, new Date(failedAt))
  }
  return settleHarnessFeedback(report, decision, new Date(now()))
}

export function createHarnessFeedbackTick(model: EvaluationModel, nameIssue: IssueNamingModel, now = Date.now) {
  let legacyCursor: Parameters<typeof readLegacyHarnessFeedbackGroups>[0]
  return async () => {
    const reports = await claimDueHarnessFeedback(REPORT_BATCH_SIZE, new Date(now()))
    const queues = new Map<ClaimedHarnessFeedback["organizationId"], ClaimedHarnessFeedback[]>()
    for (const report of reports) {
      const queue = queues.get(report.organizationId)
      if (queue) queue.push(report)
      else queues.set(report.organizationId, [report])
    }
    await Promise.all([...queues.values()].map(async (queue) => {
      for (const report of queue) {
        try {
          await processHarnessFeedbackReport(report, model, nameIssue, now)
        } catch {
          appLogger.warn("harness_feedback_settlement_failed", { report_id: report.id })
        }
      }
    }))
    const legacy = await readLegacyHarnessFeedbackGroups(legacyCursor)
    legacyCursor = legacy.at(-1)?.id
    await Promise.all(legacy.map(async ({ id, organizationId }) => {
      try {
        const report = await readEarliestHarnessFeedbackReport(organizationId, id)
        if (report) await nameLegacyHarnessFeedbackGroup(organizationId, id, await nameIssue(report))
      } catch {
        appLogger.warn("harness_feedback_legacy_naming_failed", { group_id: id })
      }
    }))
  }
}

export function startHarnessFeedbackWorker(makeModel = createEvaluationModel, makeNamingModel = createIssueNamingModel) {
  const apiKey = env.agentEvaluationApiKey
  if (!apiKey) return async () => {}

  const tick = createHarnessFeedbackTick(makeModel({ apiKey }), makeNamingModel({ apiKey }))
  let inFlight: Promise<void> | undefined
  const timer = setInterval(() => inFlight ??= tick()
    .catch(() => { appLogger.warn("harness_feedback_queue_unavailable", {}) })
    .finally(() => { inFlight = undefined }), TICK_MS)
  timer.unref()
  return async () => {
    clearInterval(timer)
    await inFlight
  }
}
