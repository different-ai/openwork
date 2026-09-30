import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { AutomationRunTable, AutomationTable, MemberTable, WorkerTable } from "@openwork-ee/den-db/schema"
import { db } from "../db.js"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"
import { fetchWithConnectRetry, previewFetch, type FetchLike } from "./preview-fetch.js"

type WorkerId = typeof WorkerTable.$inferSelect.id

export type CloudWorkerActivityVerdict = "idle" | "busy" | "unknown"

export type CloudWorkerActivityReason =
  | "idle"
  | "busy_sessions"
  | "waiting_requests"
  | "probe_failed"
  /** The instance answered, but predates the activity route. */
  | "route_unsupported"

/**
 * What a running instance said when asked whether it may be interrupted.
 * `alive` is true whenever the instance itself answered, even without a
 * usable verdict; it is the liveness evidence the resolver uses to keep a
 * slow-but-working sandbox out of the restart path.
 */
export type CloudWorkerActivity = {
  verdict: CloudWorkerActivityVerdict
  reason: CloudWorkerActivityReason
  alive: boolean
  busySessions: number
  waitingRequests: number
  connectedClients: number
}

export type CloudWorkerInterruptTrigger = "update" | "idle_stop"

export type CloudWorkerInterruptibility = {
  verdict: "interruptible" | "busy" | "unknown"
  reason: CloudWorkerActivityReason | "automation_run" | "no_instance" | "legacy_instance"
  activity: CloudWorkerActivity | null
}

export type ProbeCloudWorkerActivity = (input: {
  instanceUrl: string
  hostToken: string
}) => Promise<CloudWorkerActivity>

const logger = appLogger.child({ component: "cloud_activity" })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0
}

function activityUrl(instanceUrl: string) {
  return `${instanceUrl.replace(/\/+$/, "")}/runtime/activity`
}

function unknownActivity(reason: CloudWorkerActivityReason, alive: boolean): CloudWorkerActivity {
  return { verdict: "unknown", reason, alive, busySessions: 0, waitingRequests: 0, connectedClients: 0 }
}

/**
 * Ask the instance's own server (`GET /runtime/activity`, host token) whether
 * any session is running or waiting on a person. Instances older than that
 * route answer with their SPA or a 404; both prove the server is alive without
 * giving a verdict.
 */
export async function probeCloudWorkerActivity(input: {
  instanceUrl: string
  hostToken: string
  fetchImpl?: FetchLike
  timeoutMs?: number
}): Promise<CloudWorkerActivity> {
  let response: Response
  try {
    response = await fetchWithConnectRetry({
      fetchImpl: input.fetchImpl ?? previewFetch(),
      url: activityUrl(input.instanceUrl),
      init: {
        method: "GET",
        redirect: "error",
        headers: { Accept: "application/json", "X-OpenWork-Host-Token": input.hostToken },
        signal: AbortSignal.timeout(input.timeoutMs ?? env.cloudActivityProbeTimeoutMs),
      },
    })
  } catch {
    return unknownActivity("probe_failed", false)
  }
  if (response.status === 404) return unknownActivity("route_unsupported", true)
  if (!response.ok) return unknownActivity("probe_failed", false)

  let payload: unknown
  try {
    payload = JSON.parse(await response.text())
  } catch {
    // The web root is the catch-all on older instances: an unknown route
    // answers 200 with index.html.
    return unknownActivity("route_unsupported", true)
  }
  if (!isRecord(payload) || payload.ok !== true) return unknownActivity("route_unsupported", true)
  const busySessions = nonNegativeInteger(payload.busySessions)
  const waitingRequests = nonNegativeInteger(payload.waitingRequests)
  const connectedClients = nonNegativeInteger(payload.connectedClients)
  const counts = { alive: true, busySessions, waitingRequests, connectedClients }
  if (payload.verdict === "busy" || busySessions > 0 || waitingRequests > 0) {
    return { verdict: "busy", reason: waitingRequests > 0 && busySessions === 0 ? "waiting_requests" : "busy_sessions", ...counts }
  }
  if (payload.verdict === "idle") return { verdict: "idle", reason: "idle", ...counts }
  return { verdict: "unknown", reason: "probe_failed", ...counts }
}

/** A scheduled Cloud run claimed or running on this worker's owner. */
export async function hasActiveCloudAutomationRun(workerId: WorkerId): Promise<boolean> {
  const rows = await db
    .select({ id: AutomationRunTable.id })
    .from(AutomationRunTable)
    .innerJoin(AutomationTable, eq(AutomationTable.id, AutomationRunTable.automation_id))
    .innerJoin(MemberTable, eq(MemberTable.id, AutomationTable.owner_member_id))
    .innerJoin(WorkerTable, and(
      eq(WorkerTable.org_id, AutomationTable.organization_id),
      eq(WorkerTable.created_by_user_id, MemberTable.userId),
    ))
    .where(and(
      eq(WorkerTable.id, workerId),
      eq(AutomationRunTable.execution_target, "cloud"),
      inArray(AutomationRunTable.status, ["claimed", "running"]),
    ))
    .limit(1)
  return rows.length > 0
}

/**
 * The one decision every Den-initiated stop of a running instance goes
 * through. Fails closed: an instance that cannot be asked is not idle. An
 * instance older than the activity route keeps today's behavior, because it
 * cannot report busy and is exactly the instance that needs an update.
 */
export async function resolveCloudWorkerInterruptibility(input: {
  workerId: WorkerId
  trigger: CloudWorkerInterruptTrigger
  hasActiveAutomationRun: (workerId: WorkerId) => Promise<boolean>
  instance: () => Promise<{ url: string; hostToken: string } | null>
  probeActivity?: ProbeCloudWorkerActivity
}): Promise<CloudWorkerInterruptibility> {
  const decision = await decide(input)
  logger.info("cloud interrupt decision", {
    worker_id: input.workerId,
    trigger: input.trigger,
    verdict: decision.verdict,
    reason: decision.reason,
    busy_sessions: decision.activity?.busySessions ?? null,
    waiting_requests: decision.activity?.waitingRequests ?? null,
    connected_clients: decision.activity?.connectedClients ?? null,
  })
  return decision
}

async function decide(input: Parameters<typeof resolveCloudWorkerInterruptibility>[0]): Promise<CloudWorkerInterruptibility> {
  if (await input.hasActiveAutomationRun(input.workerId)) {
    return { verdict: "busy", reason: "automation_run", activity: null }
  }
  const instance = await input.instance()
  if (!instance) return { verdict: "unknown", reason: "no_instance", activity: null }
  const activity = await (input.probeActivity ?? probeCloudWorkerActivity)({ instanceUrl: instance.url, hostToken: instance.hostToken })
  if (activity.verdict === "busy") return { verdict: "busy", reason: activity.reason, activity }
  if (activity.verdict === "idle") return { verdict: "interruptible", reason: "idle", activity }
  if (activity.reason === "route_unsupported") return { verdict: "interruptible", reason: "legacy_instance", activity }
  return { verdict: "unknown", reason: activity.reason, activity }
}
