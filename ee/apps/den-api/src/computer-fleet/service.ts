import { and, desc, eq, gte, inArray, isNull, lt, lte } from "@openwork-ee/den-db/drizzle"
import { AdminMetricSnapshotTable, AuthUserTable, HeadlessSessionIndexTable, MemberTable, OrganizationTable, RemoteDeviceEventTable, RemoteDeviceTable } from "@openwork-ee/den-db/schema"
import type { AdminComputerFleet, AdminComputerFleetHistory, ComputerFleetHistoryRange, ComputerFleetSourceKind } from "@openwork/types/den/admin-computer-fleet"
import { dbSnapshotStore, defaultOwner } from "../admin-metrics/snapshots.js"
import { db } from "../db.js"
import { createHeadlessRunnerClient, defaultHeadlessRunnerDeps, type RunnerComputerFleet, type RunnerResult } from "../headless-runner/client.js"
import { appLogger } from "../observability/logger.js"
import { foldFleet, historyFromHours, historyHourKeys, hourKey, mergeHours, storedHour } from "./history.js"
import { readComputerDetail, readComputerFleet, type ComputerDetailRead, type ComputerFleetClient } from "./reader.js"
import { computerKey, notConfiguredComputerFleet, type ComputerConversation, type ComputerOwner, type ComputerReports } from "./state.js"

/**
 * The computer fleet for the admin page, and the background job that records its history.
 *
 * Den holds no provider key and keeps no list of computers: the runner asks its providers (`GET /v1/computers`,
 * with the runner's own keys) and Den reads that, so the page works with the sandbox gateway, without it, or with
 * both, and needs no setting of its own. Den adds whose each computer is, from the conversations it knows.
 *
 * History lives in `admin_metric_snapshot` under its own metric key, one row per UTC hour, like the runner fleet's.
 */
const logger = appLogger.child({ component: "computer_fleet" })
const HISTORY_METRIC = "computer_fleet_history"
const SAMPLER_LEASE = "computer_fleet_sampler"
/** The providers are other people's APIs: the past is recorded every five minutes, into ten-minute squares. */
const SAMPLE_INTERVAL_MS = 5 * 60_000
/** A sampler that stops renewing is replaced after this long. */
const SAMPLER_LEASE_MS = 12 * 60_000
const FIRST_SAMPLE_DELAY_MS = 45_000
const RETENTION_HOURS = 31 * 24
/** Readers within this long of each other share one read of the runner's list. */
const SHARE_MS = 15_000
/** Which organization each conversation belongs to changes slowly, and reading it scans two tables. */
const OWNERS_SHARE_MS = 5 * 60_000
const OWNER_ROWS_LIMIT = 100_000
const ORGANIZATION_CHUNK = 200
/** A computer's page shows this many of the events Den was told about. */
const DETAIL_EVENTS = 60
/** A conversation newer than the shared index is looked for again, but not more often than this. */
const OWNERS_REFRESH_MS = 30_000

type OrganizationId = (typeof OrganizationTable.$inferSelect)["id"]
type Conversation = { organizationId: OrganizationId; sessionId: string }
let ownerIndex: { at: number; byKey: Promise<Map<string, Conversation>> } | null = null

/** Every conversation that can have a computer, as its computer's key, with its organization. Workbot alone gives one. */
function conversationByKey(now: number, maxAgeMs = OWNERS_SHARE_MS): Promise<Map<string, Conversation>> {
  if (ownerIndex && now - ownerIndex.at < maxAgeMs) return ownerIndex.byKey
  const byKey = (async () => {
    const [sessions, devices] = await Promise.all([
      db.select({ sessionId: HeadlessSessionIndexTable.sessionId, organizationId: HeadlessSessionIndexTable.organizationId }).from(HeadlessSessionIndexTable)
        .where(and(eq(HeadlessSessionIndexTable.kind, "workbot"), isNull(HeadlessSessionIndexTable.deletedAt))).limit(OWNER_ROWS_LIMIT),
      // A computer someone opened in Workbot is recorded here under its conversation's id.
      db.select({ sessionId: RemoteDeviceTable.externalId, organizationId: RemoteDeviceTable.organizationId }).from(RemoteDeviceTable)
        .where(and(eq(RemoteDeviceTable.provider, "workbot"), isNull(RemoteDeviceTable.removedAt))).limit(OWNER_ROWS_LIMIT),
    ])
    const keys = new Map<string, Conversation>()
    for (const row of [...sessions, ...devices]) keys.set(computerKey(row.sessionId), { organizationId: row.organizationId, sessionId: row.sessionId })
    return keys
  })()
  ownerIndex = { at: now, byKey }
  byKey.catch(() => { if (ownerIndex?.byKey === byKey) ownerIndex = null })
  return byKey
}

async function loadComputerOwners(keys: readonly string[]): Promise<ReadonlyMap<string, ComputerOwner>> {
  const owners = new Map<string, ComputerOwner>()
  if (keys.length === 0) return owners
  const byKey = await conversationByKey(Date.now())
  const wanted = new Map<string, OrganizationId>()
  for (const key of keys) {
    const organizationId = byKey.get(key)?.organizationId
    if (organizationId) wanted.set(key, organizationId)
  }
  const ids = [...new Set(wanted.values())]
  const names = new Map<OrganizationId, string>()
  for (let start = 0; start < ids.length; start += ORGANIZATION_CHUNK) {
    const rows = await db.select({ id: OrganizationTable.id, name: OrganizationTable.name }).from(OrganizationTable).where(inArray(OrganizationTable.id, ids.slice(start, start + ORGANIZATION_CHUNK)))
    for (const row of rows) names.set(row.id, row.name)
  }
  for (const [key, organizationId] of wanted) owners.set(key, { id: organizationId, name: (names.get(organizationId) ?? "").slice(0, 200) })
  return owners
}

/**
 * What Den knows of the computer with this key, read now: whose it is, its conversation's member and activity, what
 * Workbot's server last reported about it and what it saw happen to it. Never the conversation's name or content.
 */
async function loadKnownComputer(key: string): Promise<{ owner: ComputerOwner | null; conversation: ComputerConversation | null; reports: ComputerReports } | null> {
  const now = Date.now()
  // A conversation started since the shared index was read is not in it yet: look once more before giving up.
  const found = (await conversationByKey(now)).get(key) ?? (await conversationByKey(now, OWNERS_REFRESH_MS)).get(key)
  if (!found) return null
  const [[organization], [session], [device]] = await Promise.all([
    db.select({ name: OrganizationTable.name }).from(OrganizationTable).where(eq(OrganizationTable.id, found.organizationId)).limit(1),
    db.select({ memberId: HeadlessSessionIndexTable.memberId, createdAt: HeadlessSessionIndexTable.createdAt, updatedAt: HeadlessSessionIndexTable.updatedAt, activeTurnSince: HeadlessSessionIndexTable.activeTurnSince })
      .from(HeadlessSessionIndexTable).where(and(eq(HeadlessSessionIndexTable.sessionId, found.sessionId), eq(HeadlessSessionIndexTable.organizationId, found.organizationId), isNull(HeadlessSessionIndexTable.deletedAt))).limit(1),
    db.select({ id: RemoteDeviceTable.id, ownerMemberId: RemoteDeviceTable.ownerMemberId, state: RemoteDeviceTable.state, statusDetail: RemoteDeviceTable.statusDetail, lastSeenAt: RemoteDeviceTable.lastSeenAt, workbotChat: RemoteDeviceTable.workbotChat })
      .from(RemoteDeviceTable).where(and(eq(RemoteDeviceTable.organizationId, found.organizationId), eq(RemoteDeviceTable.provider, "workbot"), eq(RemoteDeviceTable.externalId, found.sessionId))).limit(1),
  ])
  const memberId = session?.memberId ?? device?.ownerMemberId ?? null
  const [[member], events] = await Promise.all([
    memberId
      ? db.select({ id: MemberTable.id, name: AuthUserTable.name, email: AuthUserTable.email }).from(MemberTable).innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId)).where(and(eq(MemberTable.id, memberId), eq(MemberTable.organizationId, found.organizationId))).limit(1)
      : Promise.resolve([]),
    device
      ? db.select({ at: RemoteDeviceEventTable.createdAt, type: RemoteDeviceEventTable.type, level: RemoteDeviceEventTable.level, message: RemoteDeviceEventTable.message }).from(RemoteDeviceEventTable)
        .where(eq(RemoteDeviceEventTable.deviceId, device.id)).orderBy(desc(RemoteDeviceEventTable.createdAt), desc(RemoteDeviceEventTable.id)).limit(DETAIL_EVENTS)
      : Promise.resolve([]),
  ])
  return {
    owner: { id: found.organizationId, name: (organization?.name ?? "").slice(0, 200) },
    conversation: {
      sessionId: found.sessionId,
      chat: device?.workbotChat ? (device.workbotChat === "main" ? "main" : "side") : null,
      member: member ? { id: member.id, name: member.name.slice(0, 255), email: member.email.slice(0, 320) } : null,
      createdAt: session?.createdAt ?? null,
      lastActiveAt: session?.updatedAt ?? null,
      activeTurnSince: session?.activeTurnSince ?? null,
    },
    reports: {
      reported: device ? { state: device.state, detail: device.statusDetail, at: device.lastSeenAt } : null,
      events,
    },
  }
}

function defaultClient(): (ComputerFleetClient & Pick<ReturnType<typeof createHeadlessRunnerClient>, "readComputer">) | null {
  const deps = defaultHeadlessRunnerDeps()
  return deps ? createHeadlessRunnerClient(deps) : null
}

let shared: { at: number; list: Promise<RunnerResult<RunnerComputerFleet>> } | null = null

/** One read of the runner's list, shared by admins watching at the same time and by the sampler. */
function sharedList(client: ComputerFleetClient, now: number) {
  if (shared && now - shared.at < SHARE_MS) return shared.list
  const list = client.listComputers()
  shared = { at: now, list }
  return list
}

/** The fleet now, with whose each computer is; `organization` lists one organization's computers, or `unknown`. */
export async function currentComputerFleet(organization: string | null = null): Promise<AdminComputerFleet> {
  const client = defaultClient()
  const now = () => new Date()
  if (!client) return notConfiguredComputerFleet(now())
  const owners = (keys: readonly string[]) => loadComputerOwners(keys).catch((error: unknown) => {
    logger.warn("computer fleet owners unavailable", { error })
    return new Map<string, ComputerOwner>()
  })
  return readComputerFleet({ client, owners, now }, await sharedList(client, Date.now()), organization)
}

/** One computer in full, read now from its provider through the runner, with what Den knows about it. */
export async function currentComputer(source: ComputerFleetSourceKind, id: string): Promise<ComputerDetailRead> {
  const known = (key: string) => loadKnownComputer(key).catch((error: unknown) => {
    logger.warn("computer fleet conversation unavailable", { error })
    return null
  })
  return readComputerDetail({ client: defaultClient(), known, now: () => new Date() }, source, id)
}

export async function readComputerFleetHistory(range: ComputerFleetHistoryRange, now = Date.now()): Promise<AdminComputerFleetHistory> {
  const keys = historyHourKeys(range, now)
  const rows = await db.select({ hour: AdminMetricSnapshotTable.range_key, payload: AdminMetricSnapshotTable.payload }).from(AdminMetricSnapshotTable)
    .where(and(eq(AdminMetricSnapshotTable.metric_key, HISTORY_METRIC), gte(AdminMetricSnapshotTable.range_key, keys.from), lte(AdminMetricSnapshotTable.range_key, keys.to)))
  return historyFromHours(rows, range, now)
}

async function recordFleet(fleet: AdminComputerFleet, now: number) {
  const key = hourKey(now)
  // Primary: the hour's row as last written, by this replica or the one that sampled before it.
  const [existing] = await db.$primary.select({ payload: AdminMetricSnapshotTable.payload }).from(AdminMetricSnapshotTable)
    .where(and(eq(AdminMetricSnapshotTable.metric_key, HISTORY_METRIC), eq(AdminMetricSnapshotTable.range_key, key))).limit(1)
  const payload = mergeHours(storedHour(existing?.payload), foldFleet(storedHour(null), fleet, now))
  const values = { payload, computed_at: new Date(now), duration_ms: 0, error: null, attempted_at: new Date(now) }
  await db.insert(AdminMetricSnapshotTable).values({ metric_key: HISTORY_METRIC, range_key: key, ...values }).onDuplicateKeyUpdate({ set: values })
}

async function pruneHistory(now: number) {
  await db.delete(AdminMetricSnapshotTable)
    .where(and(eq(AdminMetricSnapshotTable.metric_key, HISTORY_METRIC), lt(AdminMetricSnapshotTable.range_key, hourKey(now - RETENTION_HOURS * 60 * 60_000))))
}

/**
 * Records the fleet's counts every five minutes so the page's grid has a past. One Den replica samples at a time
 * (a lease); another takes over when it stops. Off when the deployment has no headless runner, and nothing is
 * recorded while the runner has no computers configured.
 */
export function startComputerFleetSampler() {
  const client = defaultClient()
  if (!client) return async () => undefined
  const owner = defaultOwner()
  let running: Promise<void> = Promise.resolve()
  let prunedHour = ""
  const sample = async () => {
    const now = Date.now()
    try {
      if (!await dbSnapshotStore.claim(SAMPLER_LEASE, owner, new Date(now + SAMPLER_LEASE_MS), new Date(now), false)) return
      // Counts only: whose each computer is isn't recorded, so the tables that say so aren't read here.
      const fleet = await readComputerFleet({ client, owners: async () => new Map(), now: () => new Date(now) }, await sharedList(client, now))
      // Nothing to record without computers, or from a runner that predates its list (it answers 404).
      if (fleet.status === "not_configured" || fleet.runnerError === "http_404") return
      await recordFleet(fleet, now)
      if (prunedHour !== hourKey(now)) {
        prunedHour = hourKey(now)
        await pruneHistory(now)
      }
    } catch (error) {
      logger.warn("computer fleet sample failed", { error })
    }
  }
  const tick = () => { running = running.then(sample) }
  const timer = setInterval(tick, SAMPLE_INTERVAL_MS)
  const first = setTimeout(tick, FIRST_SAMPLE_DELAY_MS)
  timer.unref()
  first.unref()
  return async () => {
    clearInterval(timer)
    clearTimeout(first)
    await running
    // Hand the lease back so another replica samples at once.
    await dbSnapshotStore.release(SAMPLER_LEASE, owner, new Date()).catch(() => undefined)
  }
}
