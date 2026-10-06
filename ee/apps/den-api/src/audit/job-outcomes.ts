import type { AuditOrigin } from "@openwork-ee/den-db/audit-log"

// Outcomes of asynchronous work that den-api endpoints (or its schedulers)
// start. Each event is appended by src/audit/job-capture.ts:recordAuditJobOutcome
// under a job-scoped operation (AuditContext.jobRunId → binding ["job", id],
// requestId null), category "execution". The starting request keeps its own
// request-bound operation (.requested/.accepted); the job operation carries the
// background start (scheduler only) and the single terminal outcome.
// scripts/check-audit-route-coverage.ts renders this list into COVERAGE.md and
// coverage.ts adds the event types to the supported catalog.

export type AuditJobOutcomeDeclaration = Readonly<{
  /** Full event type (not a stem). */
  eventType: string
  kind: string
  /** Target resource type; its id is also the jobRunId. */
  target: string
  parents: readonly string[]
  actor: string
  origins: readonly AuditOrigin[]
  idempotencyKey: string
  /** `file:function` of each emitter call site. */
  emitters: readonly string[]
  /** Routes whose tenant_job jobOutcome points here. */
  startedBy: readonly string[]
  evidence: string
  limitations: string
}>

export const AUTOMATION_RUN_JOB_KIND = "automation.run"
export const CONNECTOR_SYNC_JOB_KIND = "connector.sync"

export const auditJobOutcomeDeclarations = [
  {
    eventType: "automation_run.started", kind: AUTOMATION_RUN_JOB_KIND, target: "automation_run", parents: ["automation", "organization"],
    actor: "system den-api.automation-scheduler; initiating actor = the Automation owner's user/member", origins: ["scheduler"],
    idempotencyKey: "automation_run:<runId>:started",
    emitters: ["src/automations/service.ts:AutomationService.tick → src/automations/audit.ts:recordAutomationRunStarted"],
    startedBy: ["scheduler tick (no HTTP route)"],
    evidence: "Outcome unknown at start; reasonCode scheduled. No instructions, prompt or results.",
    limitations: "Only scheduler-created occurrences; manual runs are started by POST /v1/automations/:id/run, whose request operation names the run id.",
  },
  {
    eventType: "automation_run.completed", kind: AUTOMATION_RUN_JOB_KIND, target: "automation_run", parents: ["automation", "organization"],
    actor: "system den-api.automation-executor (cloud, scheduler, skips, lease expiry); service automation-runner:<runnerId> with the owner member (desktop completion callback); the owner user (cancelling a queued run). Initiating actor = the Automation owner's user/member",
    origins: ["scheduler", "api"],
    idempotencyKey: "automation_run:<runId>:completed",
    emitters: [
      "src/automations/service.ts:AutomationService.executeCloudRun / executeCloudAgentRun (completeCloud, skipRun)",
      "src/automations/service.ts:AutomationService.completeDesktopRunner (POST /v1/automation-runs/:id/complete)",
      "src/automations/service.ts:AutomationService.claimDesktopRunner (skip at claim)",
      "src/automations/service.ts:AutomationService.tick (overlap/model-access skips, expired leases, unclaimed desktop runs)",
      "src/automations/service.ts:AutomationService.runNow (blocked or overlapping manual runs)",
      "src/automations/service.ts:AutomationService.cancelRun (queued run cancelled immediately)",
    ],
    startedBy: ["POST /v1/automations/:id/run", "scheduler tick"],
    evidence: "Outcome succeeded | failed (failed, cancelled, skipped); reasonCode = terminal status, the run's error code for failures, or <status>.<code>. Never run output, instructions, prompt, results or usage.",
    limitations: "Recorded only when this call performed the terminal transition (finished_at equals the transition time), so a retried completion callback appends nothing; the idempotency key also deduplicates within the 300 s attachment window. Retries queued for a later attempt are not terminal and record nothing. Origin is scheduler for scheduled runs and api for manual runs (including MCP-initiated manual runs, which are not distinguished on the run row).",
  },
  {
    eventType: "connector_sync.completed", kind: CONNECTOR_SYNC_JOB_KIND, target: "connector_sync_event", parents: ["connector_instance", "organization"],
    actor: "system den-api.github-sync (no initiator is persisted on connector_sync_event)", origins: ["webhook", "api", "scheduler"],
    idempotencyKey: "connector_sync:<eventId>:completed:<completedAt ms>",
    emitters: ["src/workers/github-sync.ts:processDueGithubSyncEvents → recordConnectorSyncCompleted"],
    startedBy: [
      "POST /v1/connector-instances/:connectorInstanceId/sync-now", "POST /v1/connector-targets/:connectorTargetId/resync",
      "POST /v1/connector-sync-events/:connectorSyncEventId/retry", "POST /v1/webhooks/connectors/github", "reconcile loop",
    ],
    evidence: "Outcome succeeded (completed, partial, ignored) | failed; reasonCode = terminal status; change snapshot status running → terminal with attemptCount and discovered/created plugin and materialized object counts only. Never repository names, paths, file contents, plugin names or error messages.",
    limitations: "GitHub connector events only. Transient failures re-queued for another attempt record nothing until the event is terminal. Origin from the event: reconcile → scheduler, manual_resync → api, otherwise webhook.",
  },
] as const satisfies readonly AuditJobOutcomeDeclaration[]

export type AuditJobOutcomeEventType = typeof auditJobOutcomeDeclarations[number]["eventType"]

export const auditJobOutcomeEventTypes: readonly string[] = auditJobOutcomeDeclarations.map(({ eventType }) => eventType).sort()

export function auditJobOutcomeDeclaration(eventType: AuditJobOutcomeEventType): AuditJobOutcomeDeclaration {
  const declaration = auditJobOutcomeDeclarations.find((entry) => entry.eventType === eventType)
  if (!declaration) throw new Error(`undeclared audit job outcome ${eventType}`)
  return declaration
}
