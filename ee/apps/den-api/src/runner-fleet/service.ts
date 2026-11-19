import { resolve4 } from "node:dns/promises"
import { and, eq, gte, inArray, isNull, lt, lte } from "@openwork-ee/den-db/drizzle"
import { AdminMetricSnapshotTable, HeadlessSessionIndexTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { RUNNER_FLEET_CELL_LIMIT, type AdminRunnerFleet, type AdminRunnerFleetHistory, type RunnerFleetHistoryRange } from "@openwork/types/den/admin-runner-fleet"
import { dbSnapshotStore, defaultOwner } from "../admin-metrics/snapshots.js"
import { db } from "../db.js"
import { createHeadlessRunnerClient, defaultHeadlessRunnerDeps } from "../headless-runner/client.js"
import { appLogger } from "../observability/logger.js"
import { describeCells, emptyDirectory, knownCellNames, nextSeen, shortCellId, storedSeen, type CellDirectory, type KnownCell } from "./cells.js"
import { runnerFleetConfig } from "./config.js"
import { foldFleet, historyFromHours, historyHourKeys, hourKey, mergeHours, storedHour } from "./history.js"
import { readRunnerFleet } from "./reader.js"
import { notConfiguredFleet } from "./state.js"

/**
 * The live fleet for the admin page, and the background job that records its history.
 *
 * History lives in `admin_metric_snapshot` under its own metric key, one row per UTC hour (`range_key` is the hour),
 * beside the Control Center's snapshots and out of their way: those are read by their own range keys.
 */
const logger = appLogger.child({ component: "runner_fleet" })
const HISTORY_METRIC = "runner_fleet_history"
const SAMPLER_LEASE = "runner_fleet_sampler"
const SAMPLE_INTERVAL_MS = 60_000
/** A sampler that stops renewing is replaced after this long. */
const SAMPLER_LEASE_MS = 150_000
const FIRST_SAMPLE_DELAY_MS = 20_000
const RETENTION_HOURS = 31 * 24
/** Readers within this long of each other share one read of the nodes. */
const SHARE_MS = 4_000

let shared: { at: number; fleet: Promise<AdminRunnerFleet> } | null = null

/** The fleet now. Admins watching at the same time, and the sampler, share one read of the nodes. */
export function currentRunnerFleet(): Promise<AdminRunnerFleet> {
  const config = runnerFleetConfig()
  if (!config) return Promise.resolve(notConfiguredFleet(new Date()))
  const now = Date.now()
  if (shared && now - shared.at < SHARE_MS) return shared.fleet
  const fleet = readRunnerFleet(config, { resolve: resolve4, fetch, now: () => new Date() })
  shared = { at: now, fleet }
  // A failed read is not kept: the next reader tries again.
  fleet.catch(() => { if (shared?.fleet === fleet) shared = null })
  return fleet
}

/**
 * Whose each cell in memory is. Den's conversations are read from its session index (shared for five minutes, and
 * read again sooner when a cell in memory has no name yet: a conversation started since). Each cell name is turned
 * into its id by the runner once, and kept: a name's id never changes.
 */
const RESIDENTS_METRIC = "runner_fleet_residents"
const RESIDENTS_KEY = "current"
const NAMES_SHARE_MS = 5 * 60_000
const NAMES_REFRESH_MS = 60_000
const NAMES_PER_CALL = 2_000
const INDEX_ROWS_LIMIT = 200_000
const SEEN_SHARE_MS = 30_000
const ORGANIZATION_NAMES_LIMIT = 5_000
const ORGANIZATION_CHUNK = 200

let names: { at: number; byName: Promise<Map<string, KnownCell>> } | null = null
/** Cell name to short cell id; an empty id for a name the runner does not take as a cell's. */
const idByName = new Map<string, string>()
let known: { names: Map<string, KnownCell>; ids: number; byId: Map<string, KnownCell> } | null = null
const organizationNames = new Map<string, string>()

function knownNames(now: number, maxAgeMs: number): Promise<Map<string, KnownCell>> {
  if (names && now - names.at < maxAgeMs) return names.byName
  const byName = db.select({
    sessionId: HeadlessSessionIndexTable.sessionId, organizationId: HeadlessSessionIndexTable.organizationId, memberId: HeadlessSessionIndexTable.memberId,
    kind: HeadlessSessionIndexTable.kind, updatedAt: HeadlessSessionIndexTable.updatedAt, activeTurnSince: HeadlessSessionIndexTable.activeTurnSince,
  }).from(HeadlessSessionIndexTable).where(isNull(HeadlessSessionIndexTable.deletedAt)).limit(INDEX_ROWS_LIMIT).then(knownCellNames)
  names = { at: now, byName }
  byName.catch(() => { if (names?.byName === byName) names = null })
  return byName
}

/** The ids of names not asked about yet. Returns why it could not ask, or null. */
async function resolveIds(client: Pick<ReturnType<typeof createHeadlessRunnerClient>, "cellIds">, byName: Map<string, KnownCell>): Promise<string | null> {
  const missing = [...byName.keys()].filter((name) => !idByName.has(name))
  for (let start = 0; start < missing.length; start += NAMES_PER_CALL) {
    const asked = missing.slice(start, start + NAMES_PER_CALL)
    const answer = await client.cellIds(asked)
    if (!answer.ok) return answer.error.slice(0, 40)
    for (const name of asked) idByName.set(name, answer.value[name] ? shortCellId(answer.value[name]) : "")
  }
  return null
}

function byId(byName: Map<string, KnownCell>): Map<string, KnownCell> {
  if (known && known.names === byName && known.ids === idByName.size) return known.byId
  const cells = new Map<string, KnownCell>()
  for (const [name, cell] of byName) {
    const id = idByName.get(name)
    if (id) cells.set(id, cell)
  }
  known = { names: byName, ids: idByName.size, byId: cells }
  return cells
}

async function cellDirectory(inMemory: ReadonlySet<string>, now: number): Promise<CellDirectory> {
  const deps = defaultHeadlessRunnerDeps()
  if (!deps) return emptyDirectory("not_configured")
  const client = createHeadlessRunnerClient(deps)
  let byName = await knownNames(now, NAMES_SHARE_MS)
  let error = await resolveIds(client, byName)
  let cells = byId(byName)
  // A cell with no name may be a conversation started since the index was read: look once more, not every reading.
  if (error === null && [...inMemory].some((id) => !cells.has(id)) && names && now - names.at >= NAMES_REFRESH_MS) {
    byName = await knownNames(now, NAMES_REFRESH_MS)
    error = await resolveIds(client, byName)
    cells = byId(byName)
  }
  const wanted = new Set<string>()
  for (const id of inMemory) {
    const organizationId = cells.get(id)?.organizationId
    if (organizationId && !organizationNames.has(organizationId)) wanted.add(organizationId)
  }
  const ids = [...wanted]
  for (let start = 0; start < ids.length; start += ORGANIZATION_CHUNK) {
    const chunk = ids.slice(start, start + ORGANIZATION_CHUNK)
    const rows = await db.select({ id: OrganizationTable.id, name: OrganizationTable.name }).from(OrganizationTable)
      .where(inArray(OrganizationTable.id, chunk as Array<(typeof OrganizationTable.$inferSelect)["id"]>))
    if (organizationNames.size > ORGANIZATION_NAMES_LIMIT) organizationNames.clear()
    for (const row of rows) organizationNames.set(row.id, row.name)
  }
  return { byId: cells, organizations: organizationNames, error }
}

/** First sightings on this replica, and the ones the sampler keeps for every replica (read at most every 30 seconds). */
let memorySeen: Record<string, number> = {}
let keptSeen: { at: number; seen: Promise<Record<string, number>> } | null = null

function sampledSeen(now: number): Promise<Record<string, number>> {
  if (keptSeen && now - keptSeen.at < SEEN_SHARE_MS) return keptSeen.seen
  const seen = db.select({ payload: AdminMetricSnapshotTable.payload }).from(AdminMetricSnapshotTable)
    .where(and(eq(AdminMetricSnapshotTable.metric_key, RESIDENTS_METRIC), eq(AdminMetricSnapshotTable.range_key, RESIDENTS_KEY))).limit(1)
    .then(([row]) => storedSeen(row?.payload))
  keptSeen = { at: now, seen }
  seen.catch(() => { if (keptSeen?.seen === seen) keptSeen = null })
  return seen
}

let described: { source: Promise<AdminRunnerFleet>; fleet: Promise<AdminRunnerFleet> } | null = null

/**
 * The fleet now with each cell in memory described: the organization and kind of conversation it belongs to, and
 * since when it has been in memory. What Den knows is a help: when it cannot be read the nodes are still shown.
 */
export function describedRunnerFleet(): Promise<AdminRunnerFleet> {
  const source = currentRunnerFleet()
  if (described?.source === source) return described.fleet
  const fleet = source.then(async (reading) => {
    if (reading.nodes.length === 0) return reading
    const now = Date.now()
    const sampled = await sampledSeen(now).catch(() => ({}))
    memorySeen = nextSeen(reading, memorySeen, now, sampled)
    const inMemory = new Set(reading.nodes.flatMap((node) => node.cells.residents.slice(0, RUNNER_FLEET_CELL_LIMIT)))
    const directory = await cellDirectory(inMemory, now).catch((error: unknown) => {
      logger.warn("runner fleet cell names unavailable", { error })
      return emptyDirectory("unavailable")
    })
    return describeCells(reading, directory, memorySeen)
  })
  described = { source, fleet }
  fleet.catch(() => { if (described?.fleet === fleet) described = null })
  return fleet
}

/** Keeps, for every replica, when each cell now in memory was first seen there. One row, replaced each minute. */
async function recordResidents(fleet: AdminRunnerFleet, now: number) {
  const [existing] = await db.$primary.select({ payload: AdminMetricSnapshotTable.payload }).from(AdminMetricSnapshotTable)
    .where(and(eq(AdminMetricSnapshotTable.metric_key, RESIDENTS_METRIC), eq(AdminMetricSnapshotTable.range_key, RESIDENTS_KEY))).limit(1)
  const seen = nextSeen(fleet, storedSeen(existing?.payload), now, memorySeen)
  const values = { payload: { v: 1, seen }, computed_at: new Date(now), duration_ms: 0, error: null, attempted_at: new Date(now) }
  await db.insert(AdminMetricSnapshotTable).values({ metric_key: RESIDENTS_METRIC, range_key: RESIDENTS_KEY, ...values }).onDuplicateKeyUpdate({ set: values })
}

export async function readRunnerFleetHistory(range: RunnerFleetHistoryRange, now = Date.now()): Promise<AdminRunnerFleetHistory> {
  const keys = historyHourKeys(range, now)
  const rows = await db.select({ hour: AdminMetricSnapshotTable.range_key, payload: AdminMetricSnapshotTable.payload }).from(AdminMetricSnapshotTable)
    .where(and(eq(AdminMetricSnapshotTable.metric_key, HISTORY_METRIC), gte(AdminMetricSnapshotTable.range_key, keys.from), lte(AdminMetricSnapshotTable.range_key, keys.to)))
  return historyFromHours(rows, range, now)
}

async function recordFleet(fleet: AdminRunnerFleet, now: number) {
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
 * Records the fleet once a minute so the page's grids have a past. One Den replica samples at a time (a lease);
 * another takes over when it stops. Off when the fleet is not configured.
 */
export function startRunnerFleetSampler() {
  if (!runnerFleetConfig()) return async () => undefined
  const owner = defaultOwner()
  let running: Promise<void> = Promise.resolve()
  let prunedHour = ""
  const sample = async () => {
    const now = Date.now()
    try {
      if (!await dbSnapshotStore.claim(SAMPLER_LEASE, owner, new Date(now + SAMPLER_LEASE_MS), new Date(now), false)) return
      const fleet = await currentRunnerFleet()
      if (fleet.nodes.length === 0) return
      await recordFleet(fleet, now)
      await recordResidents(fleet, now)
      if (prunedHour !== hourKey(now)) {
        prunedHour = hourKey(now)
        await pruneHistory(now)
      }
    } catch (error) {
      logger.warn("runner fleet sample failed", { error })
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
