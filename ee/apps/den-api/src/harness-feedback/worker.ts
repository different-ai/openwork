import { env } from "../env.js"
import { createEvaluationModel, type EvaluationModel } from "../llm/evaluation-model.js"
import { appLogger } from "../observability/logger.js"
import { isHarnessFeedbackOrganization } from "./access.js"
import { classifyHarnessFeedback } from "./classifier.js"
import { claimDueHarnessFeedback, settleHarnessFeedback, type ClaimedHarnessFeedback } from "./repository.js"

const TICK_MS = 15_000
const MAX_CONCURRENT_REPORTS = 4
const MAX_ATTEMPTS = 3
const RETRY_BASE_MS = 60_000

export async function processHarnessFeedbackReport(report: ClaimedHarnessFeedback, model: EvaluationModel, now = Date.now) {
  if (!(await isHarnessFeedbackOrganization(report.organizationId, { fresh: true })) || !report.leaseExpiresAt || report.leaseExpiresAt.getTime() <= now()) return false
  let judgment
  try {
    judgment = await classifyHarnessFeedback(model, report)
  } catch {
    const attempts = report.attempts + 1
    const state = attempts >= MAX_ATTEMPTS ? "needs_review" : "pending"
    const failedAt = now()
    const nextAttemptAt = new Date(state === "pending" ? failedAt + RETRY_BASE_MS * 2 ** (attempts - 1) : failedAt)
    appLogger.warn("harness_feedback_evaluation_failed", { report_id: report.id, attempts, state })
    return settleHarnessFeedback(report, { state, attempts, nextAttemptAt }, new Date(failedAt))
  }
  return settleHarnessFeedback(report, judgment, new Date(now()))
}

export function startHarnessFeedbackWorker(makeModel = createEvaluationModel) {
  const apiKey = env.agentEvaluationApiKey
  if (!apiKey) return async () => {}

  const model = makeModel({ apiKey })
  let inFlight: Promise<void> | undefined
  const tick = async () => {
    try {
      const reports = await claimDueHarnessFeedback(MAX_CONCURRENT_REPORTS, new Date())
      await Promise.all(reports.map(async (report) => {
        try {
          await processHarnessFeedbackReport(report, model)
        } catch {
          appLogger.warn("harness_feedback_settlement_failed", { report_id: report.id })
        }
      }))
    } catch {
      appLogger.warn("harness_feedback_queue_unavailable", {})
    }
  }
  const timer = setInterval(() => inFlight ??= tick().finally(() => { inFlight = undefined }), TICK_MS)
  timer.unref()
  return async () => {
    clearInterval(timer)
    await inFlight
  }
}
