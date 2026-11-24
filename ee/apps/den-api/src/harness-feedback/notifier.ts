import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"
import { harnessFeedbackOrganizationIds, isHarnessFeedbackOrganization } from "./access.js"
import { claimDueHarnessFeedbackGroups, settleHarnessFeedbackGroup } from "./repository.js"
import { readHarnessFeedbackWebhook } from "./settings.js"
import { createHarnessFeedbackSlackSender, type HarnessFeedbackSender } from "./slack.js"

const TICK_MS = 15_000
const BATCH_SIZE = 4
const MAX_ATTEMPTS = 3
const RETRY_BASE_MS = 60_000

export async function notifyHarnessFeedbackTick(now = Date.now, makeSender = createHarnessFeedbackSlackSender) {
  const organizationIds = await harnessFeedbackOrganizationIds()
  if (!organizationIds.length) return
  const webhookUrl = await readHarnessFeedbackWebhook()
  if (!webhookUrl) return
  const send: HarnessFeedbackSender = makeSender({ webhookUrl, webUrl: env.webUrl })
  const groups = await claimDueHarnessFeedbackGroups(BATCH_SIZE, new Date(now()), organizationIds)
  await Promise.all(groups.map(async (group) => {
    try {
      if (!(await isHarnessFeedbackOrganization(group.organizationId, { fresh: true })) || group.expiresAt <= now()) return
      const outcome = group.expiredInFlight ? "uncertain" : await send(group).catch(() => "uncertain" satisfies Awaited<ReturnType<HarnessFeedbackSender>>)
      const attempts = group.notifyAttempts + 1
      const finishedAt = now()
      const state = outcome === "delivered" ? "delivered" : outcome === "transient" && attempts < MAX_ATTEMPTS ? "pending" : "failed"
      const settled = await settleHarnessFeedbackGroup(group, state === "pending"
        ? { state, retryAt: finishedAt + RETRY_BASE_MS * 2 ** (attempts - 1) }
        : { state }, new Date(finishedAt))
      if (!settled || outcome !== "delivered") {
        appLogger.warn("harness_feedback_notification_not_delivered", { group_id: group.id, outcome, attempts, settled })
      }
    } catch {
      appLogger.warn("harness_feedback_notification_settlement_failed", { group_id: group.id })
    }
  }))
}

export function startHarnessFeedbackNotifier(makeSender = createHarnessFeedbackSlackSender) {
  let inFlight: Promise<void> | undefined
  const timer = setInterval(() => inFlight ??= notifyHarnessFeedbackTick(Date.now, makeSender)
      .catch(() => { appLogger.warn("harness_feedback_notification_queue_unavailable", {}) })
      .finally(() => { inFlight = undefined }), TICK_MS)
  timer.unref()
  return async () => {
    clearInterval(timer)
    await inFlight
  }
}
