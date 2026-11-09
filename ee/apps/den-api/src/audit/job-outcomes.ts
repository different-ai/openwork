import type { AuditOrigin } from "@openwork-ee/den-db/audit-log"

// Outcomes of asynchronous work that den-api endpoints (or its schedulers)
// start. Each event is appended by src/audit/job-capture.ts:recordAuditJobOutcome
// under a job-scoped operation (AuditContext.jobRunId → binding ["job", id],
// requestId null), category "execution". The starting request keeps its own
// request-bound operation (.requested/.accepted); the job operation carries the
// background start (scheduler only) and the single terminal outcome.
// scripts/check-audit-route-coverage.ts validates this list and
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
export const CONFIG_BLOB_APPLY_JOB_KIND = "config_blobs.apply"

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
    emitters: [
      "src/workers/github-sync.ts:processDueGithubSyncEvents → recordConnectorSyncCompleted",
      "src/workers/github-sync.ts:reclaimStaleGithubSyncEvents → recordConnectorSyncCompleted",
      "src/workers/github-sync.ts:supersedeQueuedGithubSyncEvents → recordConnectorSyncCompleted",
    ],
    startedBy: [
      "POST /v1/connector-instances/:connectorInstanceId/sync-now", "POST /v1/connector-targets/:connectorTargetId/resync",
      "POST /v1/connector-sync-events/:connectorSyncEventId/retry", "POST /v1/webhooks/connectors/github", "reconcile loop",
    ],
    evidence: "Outcome succeeded (completed, partial, ignored) | failed; reasonCode = terminal status; change snapshot status running → terminal with attemptCount and discovered/created plugin and materialized object counts only. Never repository names, paths, file contents, plugin names or error messages.",
    limitations: "GitHub connector events only. Transient failures re-queued for another attempt record nothing until the event is terminal. An abandoned running event put back for another attempt records nothing; one out of attempts records failed. A queued event closed because a sync claimed for its target covers it records ignored (summary outcome superseded). Origin from the event: reconcile → scheduler, manual_resync → api, otherwise webhook.",
  },
  {
    eventType: "config_change_request.apply_started", kind: CONFIG_BLOB_APPLY_JOB_KIND, target: "config_change_request", parents: ["organization"],
    actor: "the applying member: the last approver, or a config token's issuing member (credentialId = the API key id)", origins: ["api"],
    idempotencyKey: "config_change_request:<id>:apply:<attempt>:started",
    emitters: ["src/config-blobs/service.ts:applyClaimedChangeRequest"],
    startedBy: ["POST /v1/config-blobs/change-requests/:changeRequestId/apply", "POST /v1/config-blobs/change-requests/:changeRequestId/approve (auto-apply)"],
    evidence: "Outcome unknown at start; reasonCode applying. The per-item changes the domain services make during the apply (teams, members, invitations, permission sets, providers, connectors…) are appended to the same job operation by their own emitters (src/audit/request-capture.ts:runWithAuditJobChangeCapture). Never blob content, secret inputs or values.",
    limitations: "Recorded only once the request passed the approval, permission and stale checks and its before-snapshot was written. A request that went stale (re-analyzed) or was refused before writing anything (approver no longer a member or without the permission, token revoked, secret value missing) records no job events; its status and errors stay on the change request.",
  },
  {
    eventType: "config_change_request.apply_completed", kind: CONFIG_BLOB_APPLY_JOB_KIND, target: "config_change_request", parents: ["organization"],
    actor: "the applying member: the last approver, or a config token's issuing member (credentialId = the API key id)", origins: ["api"],
    idempotencyKey: "config_change_request:<id>:apply:<attempt>:completed",
    emitters: ["src/config-blobs/service.ts:applyClaimedChangeRequest"],
    startedBy: ["POST /v1/config-blobs/change-requests/:changeRequestId/apply", "POST /v1/config-blobs/change-requests/:changeRequestId/approve (auto-apply)"],
    evidence: "Outcome succeeded | failed; reasonCode applied | failed; change snapshot status applying → applied/failed with created/updated/deleted/failed item counts only. Never item names, specs, secrets or error messages (the apply report on the change request keeps those for admins).",
    limitations: "Domain services that write without an emitter (provider and connector writers that only record request evidence) leave per-item evidence on the apply report and the before-snapshot only.",
  },
] as const satisfies readonly AuditJobOutcomeDeclaration[]

export type AuditJobOutcomeEventType = typeof auditJobOutcomeDeclarations[number]["eventType"]

export const auditJobOutcomeEventTypes: readonly string[] = auditJobOutcomeDeclarations.map(({ eventType }) => eventType).sort()

export function auditJobOutcomeDeclaration(eventType: AuditJobOutcomeEventType): AuditJobOutcomeDeclaration {
  const declaration = auditJobOutcomeDeclarations.find((entry) => entry.eventType === eventType)
  if (!declaration) throw new Error(`undeclared audit job outcome ${eventType}`)
  return declaration
}
