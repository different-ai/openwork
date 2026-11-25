import { SUPPORT_TRIAGE_ACTION_CATEGORIES } from "@openwork-ee/den-db/schema"
import { env } from "../env.js"
import { createEvaluationModel, type EvaluationModel } from "../llm/evaluation-model.js"
import { appLogger } from "../observability/logger.js"
import { classifySupportTriage } from "./classifier.js"
import { createPlainClient, type PlainClient } from "./plain.js"
import { claimTriageThreads, enqueueTriagePage, MAX_ATTEMPTS, updateTriageThread, type ClaimedTriageThread } from "./repository.js"
import { advanceTriagePoll, currentTriageSettings, readTriageSettings, type TriageSettings } from "./settings.js"
import { postsToSlack, sendTriagedThread } from "./slack.js"

const POLL_MS = 60_000
const RETRY_BASE_MS = 60_000
const POLL_OVERLAP_MS = 2 * POLL_MS
const CONCURRENCY = 4

type ActiveSettings = TriageSettings & { enabledAt: Date; plainApiKey: string }
type RunOptions = { now?: () => number; slackFetch?: typeof fetch; canContinue?: () => boolean }

export async function pollSupportTriage(plain: PlainClient, workspaceId: string, settings: ActiveSettings, through: Date, canContinue: () => boolean) {
  const lower = Math.max(settings.enabledAt.getTime(), (settings.polledThrough?.getTime() ?? 0) - POLL_OVERLAP_MS)
  if (lower > through.getTime()) return
  const seenCursors = new Set<string>()
  let after: string | null = null
  while (canContinue()) {
    const page = await plain.threads(new Date(lower - 1), new Date(through.getTime() + 1), after)
    if (!canContinue() || !await enqueueTriagePage(workspaceId, settings.revision, new Date(lower), through, page.edges.map(({ node }) => node), through)) return
    if (!page.pageInfo.hasNextPage) {
      await advanceTriagePoll(settings.revision, through)
      return
    }
    const next = page.pageInfo.endCursor
    if (!next || seenCursors.has(next)) throw new Error("Plain pagination unavailable")
    seenCursors.add(next)
    after = next
  }
}

export async function processTriageThread(row: ClaimedTriageThread, plain: PlainClient, settings: ActiveSettings, model: EvaluationModel,
  { now = Date.now, slackFetch, canContinue = () => true }: RunOptions = {}) {
  const current = async () => canContinue() && await currentTriageSettings(settings.revision) && row.leaseExpiresAt.getTime() - now() > 5_000
  const save = (update: Parameters<typeof updateTriageThread>[1]) => updateTriageThread(row, update, new Date(now()))
  const complete = (status: "completed" | "failed", extra: Parameters<typeof updateTriageThread>[1] = {}) =>
    save({ ...extra, status, leaseOwner: null, leaseExpiresAt: null })
  let slackState = row.slackState
  try {
    if (!await current()) return
    let category = row.category
    let senderDomain: string | null | undefined
    if (category === null) {
      const evidence = await plain.evidence(row.plainThreadId)
      if (!await current()) return
      const judgment = await classifySupportTriage(model, evidence)
      if (!await save(judgment)) return
      category = judgment.category
      senderDomain = evidence.senderDomain
    }
    if (category === "other" || category === "needs_review") return await complete("completed")

    const threadId = row.plainThreadId
    if (!row.labelApplied || !row.dispositionApplied) {
      if (!await current()) return
      const state = await plain.threadState(threadId)
      if (!row.labelApplied) {
        if (!await current()) return
        const labelId = await plain.labelId(category)
        if (!state.labels.some(({ labelType }) => labelType.id === labelId)) {
          if (!await current()) return
          await plain.addLabel(threadId, labelId)
        }
        if (!await save({ labelApplied: true })) return
      }
      if (!row.dispositionApplied) {
        if (!await current()) return
        if (category === "bug" || category === "enterprise") {
          const priority = category === "enterprise" ? 0 : 1
          if (state.priority !== priority) await plain.setPriority(threadId, priority)
        } else if (state.status !== "DONE") {
          await plain.markDone(threadId)
        }
        if (!await save({ dispositionApplied: true })) return
      }
    }
    if (!postsToSlack(category) || slackState === "delivered") return await complete("completed")
    if (slackState === "sending" || slackState === "failed") return await complete("failed", { slackState: "failed" })
    if (!settings.slackWebhookUrl) return await complete("completed")
    if (senderDomain === undefined) senderDomain = await plain.senderDomain(threadId)
    if (!await current() || !await save({ slackState: "sending" })) return
    slackState = "sending"
    const outcome = await sendTriagedThread({ webhookUrl: settings.slackWebhookUrl, webUrl: env.webUrl, fetch: slackFetch }, category, { ...row, senderDomain })
    if (outcome === "delivered") return await complete("completed", { slackState: "delivered" })
    if (outcome !== "transient") return await complete("failed", { slackState: "failed" })
    slackState = "pending"
    throw new Error("Support triage Slack delivery unavailable")
  } catch {
    const terminal = row.attempts >= MAX_ATTEMPTS || slackState === "sending"
    appLogger.warn("support_triage_thread_failed", { thread_id: row.id })
    return await save({ status: terminal ? "failed" : "pending", leaseOwner: null, leaseExpiresAt: null,
      slackState: slackState === "sending" ? "failed" : slackState,
      nextAttemptAt: new Date(now() + RETRY_BASE_MS * 2 ** (row.attempts - 1)) })
  }
}

export function createSupportTriageTick(model: EvaluationModel, { now = Date.now, slackFetch, canContinue = () => true, plainFetch }:
  RunOptions & { plainFetch?: typeof fetch } = {}) {
  let connection: { apiKey: string; client: PlainClient } | undefined
  return async () => {
    const settings = await readTriageSettings()
    if (!settings?.enabledAt || !settings.plainApiKey) { connection = undefined; return }
    const active = { ...settings, enabledAt: settings.enabledAt, plainApiKey: settings.plainApiKey }
    if (connection?.apiKey !== active.plainApiKey) {
      connection = { apiKey: active.plainApiKey, client: createPlainClient({ apiKey: active.plainApiKey, fetch: plainFetch }) }
    }
    const plain = connection.client
    const workspaceId = await plain.workspaceId()
    try {
      await pollSupportTriage(plain, workspaceId, active, new Date(now()), canContinue)
    } catch {
      appLogger.warn("support_triage_poll_failed", { workspace_id: workspaceId })
    }
    if (!canContinue() || !await currentTriageSettings(active.revision)) return
    const provisioned = await Promise.allSettled(SUPPORT_TRIAGE_ACTION_CATEGORIES.map((category) => plain.labelId(category)))
    if (provisioned.some((result) => result.status === "rejected")) appLogger.warn("support_triage_labels_unavailable", { workspace_id: workspaceId })
    if (!canContinue()) return
    const rows = await claimTriageThreads(workspaceId, active.revision, active.enabledAt, new Date(now()), CONCURRENCY)
    await Promise.all(rows.map(async (row) => {
      try {
        await processTriageThread(row, plain, active, model, { now, slackFetch, canContinue })
      } catch {
        appLogger.warn("support_triage_settlement_failed", { thread_id: row.id })
      }
    }))
  }
}

export function startSupportTriageWorker(makeModel = createEvaluationModel) {
  const apiKey = env.agentEvaluationApiKey
  if (!apiKey) return async () => {}
  let stopped = false
  let inFlight: Promise<void> | undefined
  const tick = createSupportTriageTick(makeModel({ apiKey }), { canContinue: () => !stopped })
  const timer = setInterval(() => inFlight ??= tick()
    .catch(() => { appLogger.warn("support_triage_worker_unavailable", {}) })
    .finally(() => { inFlight = undefined }), POLL_MS)
  timer.unref()
  return async () => {
    stopped = true
    clearInterval(timer)
    await inFlight
  }
}
