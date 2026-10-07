import { automationOccurrenceIdentity, automationRevisionDigest } from "@openwork/automations"
// Schedule expansion comes straight from @openwork/types: prepared Dens run this seed against
// @openwork/automations' built dist, which can predate the range API.
import { automationOccurrencesInRange, nextAutomationOccurrence } from "@openwork/types/automation-schedule"
import {
  AUTOMATION_CLOUD_DEFAULT_MODEL,
  AUTOMATION_DEFAULT_MAXIMUM_RUNTIME_MS,
  type AutomationAction,
  type AutomationError,
  type AutomationNeedsAttentionReason,
  type AutomationSchedule,
} from "@openwork/types/automations"
import { eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  AutomationRevisionTable,
  AutomationRunEventTable,
  AutomationRunTable,
  AutomationTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../src/db.js"

/**
 * The owner's Automations for the Acme demo, with two weeks of run receipts,
 * so the desktop Calendar has Workbot-style work to show next to meetings.
 * Opt-in (DEN_DEMO_SEED_AUTOMATIONS=1 or --automations) because seeded active
 * Automations are scheduled for real by any Den that boots on this database.
 *
 * Times follow the demo time zone (America/Los_Angeles unless
 * DEMO_TIME_ZONE says otherwise), relative to now, like the demo calendar.
 */

type OrganizationId = typeof AutomationTable.$inferSelect.organization_id
type MemberId = typeof AutomationTable.$inferSelect.owner_member_id

const DAY_MS = 24 * 60 * 60 * 1_000
const HISTORY_DAYS = 14

type DemoRunOutcome =
  | { status: "succeeded"; seconds: number; summary: string }
  | { status: "failed"; seconds: number; error: AutomationError }
  | { status: "skipped"; error: AutomationError }

type DemoAutomation = {
  name: string
  instructions: string
  schedule: (timezone: string) => AutomationSchedule
  executionTarget: "cloud" | "desktop"
  needsAttention?: Omit<AutomationNeedsAttentionReason, "occurredAt">
  /** Outcome of the nth most recent past occurrence (0 = latest); missing entries succeed. */
  outcomes?: Partial<Record<number, DemoRunOutcome>>
  summary: string
}

const slackExpired: AutomationError = {
  code: "connect_access_unavailable",
  message: "Slack sign-in expired. Reconnect Slack in Your Connections.",
  retryable: false,
}

const DEMO_AUTOMATIONS: DemoAutomation[] = [
  {
    name: "What you missed in #launch",
    instructions: "Every Monday morning, read #launch-fleet-2 since Friday evening and draft a short catch-up: decisions, open questions for me, and anything waiting on my reply.",
    schedule: (timezone) => ({ kind: "weekly", timezone, daysOfWeek: [1], hour: 8, minute: 0 }),
    executionTarget: "cloud",
    summary: "Drafted a catch-up: 3 decisions, 2 questions waiting on you.",
  },
  {
    name: "What's waiting on me",
    instructions: "Each weekday at 9, check Slack, Gmail and Linear for messages and issues waiting on me and list them by urgency.",
    schedule: (timezone) => ({ kind: "weekly", timezone, daysOfWeek: [1, 2, 3, 4, 5], hour: 9, minute: 0 }),
    executionTarget: "cloud",
    outcomes: { 3: { status: "failed", seconds: 41, error: slackExpired } },
    summary: "4 things are waiting on you; the Blue Harbor reply is the most urgent.",
  },
  {
    name: "Check press kit comments",
    instructions: "On Wednesdays at 2 PM, read new comments on the Fleet 2.0 press kit page in Notion and summarize what needs a decision.",
    schedule: (timezone) => ({ kind: "weekly", timezone, daysOfWeek: [3], hour: 14, minute: 0 }),
    executionTarget: "desktop",
    outcomes: { 1: { status: "skipped", error: { code: "runner_unavailable", message: "No signed-in desktop was available at the scheduled time.", retryable: false } } },
    summary: "6 new comments; 2 need your decision (quote approval, embargo time).",
  },
  {
    name: "Weekly launch update",
    instructions: "Every Friday at 3 PM, draft the weekly launch update from #launch-fleet-2 and the Fleet 2.0 Notion tracker. Leave it as a draft in this chat for me to post.",
    schedule: (timezone) => ({ kind: "weekly", timezone, daysOfWeek: [5], hour: 15, minute: 0 }),
    executionTarget: "cloud",
    outcomes: { 1: { status: "failed", seconds: 12, error: slackExpired } },
    summary: "Drafted the weekly launch update (5 sections).",
  },
  {
    name: "Update launch deals",
    instructions: "Thursdays at 4 PM, update the Fleet 2.0 launch deals in HubSpot from this week's sales notes.",
    schedule: (timezone) => ({ kind: "weekly", timezone, daysOfWeek: [4], hour: 16, minute: 0 }),
    executionTarget: "cloud",
    needsAttention: { code: "connect_access_unavailable", message: "Needs HubSpot access. Connect HubSpot so this Automation can update deals." },
    summary: "Updated 3 deals.",
  },
]

export async function resetDemoAutomations(organizationId: OrganizationId): Promise<void> {
  const automations = await db.select({ id: AutomationTable.id }).from(AutomationTable).where(eq(AutomationTable.organization_id, organizationId))
  const automationIds = automations.map((row) => row.id)
  if (automationIds.length === 0) return
  const runs = await db.select({ id: AutomationRunTable.id }).from(AutomationRunTable).where(inArray(AutomationRunTable.automation_id, automationIds))
  const runIds = runs.map((row) => row.id)
  if (runIds.length > 0) {
    await db.delete(AutomationRunEventTable).where(inArray(AutomationRunEventTable.run_id, runIds))
    await db.delete(AutomationRunTable).where(inArray(AutomationRunTable.id, runIds))
  }
  await db.delete(AutomationRevisionTable).where(inArray(AutomationRevisionTable.automation_id, automationIds))
  await db.delete(AutomationTable).where(inArray(AutomationTable.id, automationIds))
}

export async function seedDemoAutomations(input: {
  organizationId: OrganizationId
  ownerMemberId: MemberId
  now?: number
  timezone?: string
}): Promise<{ automations: number; runs: number }> {
  const now = input.now ?? Date.now()
  const timezone = input.timezone ?? process.env.DEMO_TIME_ZONE?.trim() ?? "America/Los_Angeles"
  await resetDemoAutomations(input.organizationId)
  const createdAt = new Date(now - (HISTORY_DAYS + 7) * DAY_MS)
  let runCount = 0
  for (const demo of DEMO_AUTOMATIONS) {
    const automationId = createDenTypeId("automation")
    const revisionId = createDenTypeId("automationRevision")
    const schedule = demo.schedule(timezone)
    const model = { providerId: AUTOMATION_CLOUD_DEFAULT_MODEL.providerId, modelId: AUTOMATION_CLOUD_DEFAULT_MODEL.modelId, variant: null }
    const action: AutomationAction = { kind: "agent", instructions: demo.instructions, model }
    const digest = automationRevisionDigest({
      instructions: demo.instructions, schedule, model, action, executionTarget: demo.executionTarget,
      maximumRuntimeMs: AUTOMATION_DEFAULT_MAXIMUM_RUNTIME_MS,
    })
    const past = automationOccurrencesInRange(schedule, { from: now - HISTORY_DAYS * DAY_MS, to: now }).occurrences
    const blocked = demo.needsAttention !== undefined
    const ran = past
    const latest = ran.at(-1) ?? null
    await db.transaction(async (tx) => {
      await tx.insert(AutomationRevisionTable).values({
        id: revisionId, automation_id: automationId, version: 1, instructions: demo.instructions,
        schedule_kind: schedule.kind, schedule_config: schedule, timezone: schedule.timezone,
        provider_id: model.providerId, model_id: model.modelId, model_variant: null, action,
        execution_target: demo.executionTarget, workspace_id: null,
        maximum_runtime_ms: AUTOMATION_DEFAULT_MAXIMUM_RUNTIME_MS, digest, created_at: createdAt,
      })
      let latestSuccessfulRunId: typeof AutomationRunTable.$inferSelect.id | null = null
      for (const [index, scheduledFor] of ran.entries()) {
        const fromLatest = ran.length - 1 - index
        // A blocked Automation was stopped by its latest occurrence, which recorded why.
        const outcome: DemoRunOutcome = blocked && fromLatest === 0 && demo.needsAttention
          ? { status: "skipped", error: { code: demo.needsAttention.code, message: demo.needsAttention.message, retryable: false } }
          : demo.outcomes?.[fromLatest] ?? { status: "succeeded", seconds: 60 + ((index * 37) % 90), summary: demo.summary }
        const runId = createDenTypeId("automationRun")
        const startedAt = outcome.status === "skipped" ? null : new Date(scheduledFor + 4_000)
        const finishedAt = outcome.status === "skipped" ? new Date(scheduledFor + 15 * 60_000) : new Date(scheduledFor + 4_000 + outcome.seconds * 1_000)
        await tx.insert(AutomationRunTable).values({
          id: runId, automation_id: automationId, revision_id: revisionId, trigger: "scheduled",
          scheduled_for: new Date(scheduledFor),
          idempotency_key: automationOccurrenceIdentity({ automationId, scheduledFor }).idempotencyKey,
          status: outcome.status, execution_target: demo.executionTarget, claim_deadline_at: null,
          lease_owner: null, lease_expires_at: null, heartbeat_at: null,
          attempt_count: outcome.status === "skipped" ? 0 : 1,
          cloud_thread_id: createDenTypeId("automationThread"),
          engine_kind: null, engine_receipt: null, engine_sequence: 0, engine_admitted_at: null,
          provider_id: model.providerId, model_id: model.modelId, model_variant: null,
          started_at: startedAt, finished_at: finishedAt,
          error: outcome.status === "succeeded" ? null : outcome.error,
          result_summary: outcome.status === "succeeded" ? outcome.summary : null,
          usage: { inputTokens: null, outputTokens: null, costMicros: null },
          created_at: new Date(scheduledFor), updated_at: finishedAt,
        })
        if (outcome.status === "succeeded") latestSuccessfulRunId = runId
        runCount += 1
      }
      await tx.insert(AutomationTable).values({
        id: automationId, organization_id: input.organizationId, owner_member_id: input.ownerMemberId,
        name: demo.name, state: blocked ? "needs_attention" : "active", current_revision_id: revisionId,
        next_due_at: blocked ? null : new Date(nextAutomationOccurrence(schedule, now) ?? now),
        latest_run_at: latest === null ? null : new Date(latest),
        needs_attention_reason: demo.needsAttention ? { ...demo.needsAttention, occurredAt: past.at(-1) ?? now } : null,
        latest_successful_run_id: latestSuccessfulRunId,
        archived_at: null, created_at: createdAt, updated_at: new Date(now),
      })
    })
  }
  return { automations: DEMO_AUTOMATIONS.length, runs: runCount }
}
