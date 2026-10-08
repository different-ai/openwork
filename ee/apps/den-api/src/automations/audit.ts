import type { AuditActor, AuditEventInput } from "@openwork-ee/den-db/audit-log"
import { eq } from "@openwork-ee/den-db/drizzle"
import { AutomationRunTable, AutomationTable, MemberTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { auditJobReasonCode, recordAuditJobOutcome } from "../audit/job-capture.js"
import { AUTOMATION_RUN_JOB_KIND } from "../audit/job-outcomes.js"
import { auditServiceAttribution } from "../audit/request-capture.js"
import { db } from "../db.js"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"

// One job operation per Automation run (jobRunId = run id): the scheduler's
// start (scheduled occurrences only) and exactly one terminal outcome, whoever
// performed the transition (cloud executor, desktop runner callback, scheduler
// recovery, a skip or an immediate cancel). Never instructions, prompts,
// results, summaries or usage.

const PRINCIPAL_KEY = "system:den-api.automations"
const EXECUTOR_ACTOR: AuditActor = { type: "system", id: "den-api.automation-executor" }
const SCHEDULER_ACTOR: AuditActor = { type: "system", id: "den-api.automation-scheduler" }
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "skipped"])
const logger = appLogger.child({ component: "automation_audit" })

/** Who reported the terminal state; defaults to the den-api executor. */
export type AutomationRunOutcomeActor =
  | Readonly<{ kind: "executor" }>
  | Readonly<{ kind: "runner"; runnerId: string; ownerMemberId: string }>
  | Readonly<{ kind: "owner" }>

async function loadRun(runId: string) {
  const [row] = await db.select({
    runId: AutomationRunTable.id,
    automationId: AutomationRunTable.automation_id,
    trigger: AutomationRunTable.trigger,
    status: AutomationRunTable.status,
    finishedAt: AutomationRunTable.finished_at,
    error: AutomationRunTable.error,
    organizationId: AutomationTable.organization_id,
    ownerMemberId: AutomationTable.owner_member_id,
    ownerUserId: MemberTable.userId,
  }).from(AutomationRunTable)
    .innerJoin(AutomationTable, eq(AutomationTable.id, AutomationRunTable.automation_id))
    .leftJoin(MemberTable, eq(MemberTable.id, AutomationTable.owner_member_id))
    .where(eq(AutomationRunTable.id, normalizeDenTypeId("automationRun", runId))).limit(1)
  return row ?? null
}

type RunRow = NonNullable<Awaited<ReturnType<typeof loadRun>>>

function ownerActor(run: RunRow): AuditActor | undefined {
  return run.ownerUserId ? { type: "user", id: run.ownerUserId, memberId: run.ownerMemberId } : undefined
}

function jobContext(run: RunRow) {
  const initiatingActor = ownerActor(run)
  const resources: AuditEventInput["resources"] = [
    { type: "automation_run", id: run.runId, relationship: "target" },
    { type: "automation", id: run.automationId, relationship: "parent" },
    { type: "organization", id: run.organizationId, relationship: "parent" },
  ]
  return {
    organizationId: run.organizationId, jobRunId: run.runId, kind: AUTOMATION_RUN_JOB_KIND, principalKey: PRINCIPAL_KEY,
    ...(initiatingActor ? { initiatingActor } : {}),
    origin: run.trigger === "scheduled" ? "scheduler" as const : "api" as const,
    resources,
  }
}

/** succeeded → succeeded; failed/cancelled/skipped → failed. reasonCode never carries a message. */
export function automationRunAuditOutcome(status: string, errorCode: string | null | undefined): { outcome: AuditEventInput["outcome"]; reasonCode: string } {
  const outcome = status === "succeeded" ? "succeeded" : TERMINAL.has(status) ? "failed" : "unknown"
  const code = auditJobReasonCode(errorCode, "")
  const reasonCode = !code || code === status ? status : status === "failed" ? code : `${status}.${code}`
  return { outcome, reasonCode: auditJobReasonCode(reasonCode, "run_terminal") }
}

/**
 * Appends `automation_run.completed` when the run is terminal AND this caller
 * performed the transition at `terminalAt` (finished_at matches): a retried
 * completion or a no-op skip finds an older finished_at and appends nothing.
 */
export async function recordAutomationRunCompleted(input: { runId: string; terminalAt: number; actor?: AutomationRunOutcomeActor }): Promise<void> {
  if (!env.auditCaptureEnabled) return
  try {
    const run = await loadRun(input.runId)
    if (!run || !TERMINAL.has(run.status) || run.finishedAt?.getTime() !== input.terminalAt) return
    const reporter = input.actor ?? { kind: "executor" }
    const actor = reporter.kind === "runner"
      ? auditServiceAttribution("automation-runner", reporter.runnerId, { memberId: reporter.ownerMemberId }).actor
      : reporter.kind === "owner" ? ownerActor(run) ?? EXECUTOR_ACTOR : EXECUTOR_ACTOR
    await recordAuditJobOutcome({
      ...jobContext(run), action: "automation_run.completed", actor,
      ...automationRunAuditOutcome(run.status, run.error?.code),
      idempotencyKey: `automation_run:${run.runId}:completed`,
    })
  } catch (error) {
    logger.warn("automation run outcome audit skipped", { run_id: input.runId, error_name: error instanceof Error ? error.name : typeof error })
  }
}

/** Scheduler-created occurrence (no HTTP request): `automation_run.started`, origin scheduler. */
export async function recordAutomationRunStarted(runId: string): Promise<void> {
  if (!env.auditCaptureEnabled) return
  try {
    const run = await loadRun(runId)
    if (!run || run.trigger !== "scheduled") return
    await recordAuditJobOutcome({
      ...jobContext(run), action: "automation_run.started", actor: SCHEDULER_ACTOR,
      outcome: "unknown", reasonCode: "scheduled", idempotencyKey: `automation_run:${run.runId}:started`,
    })
  } catch (error) {
    logger.warn("automation run start audit skipped", { run_id: runId, error_name: error instanceof Error ? error.name : typeof error })
  }
}
