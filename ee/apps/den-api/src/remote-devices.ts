import { and, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  AutomationRunnerTable,
  HeadlessSessionIndexTable,
  MemberTable,
  OrganizationTable,
  RemoteDeviceEventTable,
  RemoteDeviceTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY } from "@openwork/types/automations"
import {
  ADMIN_REMOTE_DEVICE_PAGE_SIZE,
  REMOTE_DEVICE_DESKTOP_RETENTION_MS,
  REMOTE_DEVICE_EVENT_LIMIT,
  REMOTE_DEVICE_EVENT_RETENTION_MS,
  REMOTE_DEVICE_ONLINE_WINDOW_MS,
  remoteDeviceAvailability,
  type AdminRemoteDevice,
  type AdminRemoteDeviceDetailResponse,
  type AdminRemoteDeviceEvent,
  type AdminRemoteDeviceListResponse,
  type RemoteDevice,
  type RemoteDeviceAvailability,
  type RemoteDeviceDesktopReport,
  type RemoteDeviceDiagnostics,
  type RemoteDeviceEvent,
  type RemoteDeviceEventActor,
  type RemoteDeviceEventLevel,
  type RemoteDeviceEventType,
  type RemoteDeviceKind,
  type RemoteDevicePlatform,
  type RemoteDeviceProvider,
  type RemoteDeviceRegisterRequest,
  type RemoteDeviceReportedComputer,
  type RemoteDeviceState,
  type RemoteDeviceWorkbotReport,
} from "@openwork/types/den/remote-devices"
import { automationRunnerRowId } from "./automations/repository.js"
import { db } from "./db.js"
import { getOrganizationFeatures } from "./features.js"

/**
 * Remote devices (feature `remoteDevices`): Den's registry of the computers a
 * member can reach through OpenWork. See packages/types/src/den/remote-devices.ts
 * for the model and docs/features/remote-devices/README.md for the rollout.
 *
 * Three writers, one table: a signed-in desktop reports itself (and the VMs it
 * is configured to reach), Workbot's server reports what happens to a chat's
 * cloud computer, and members register virtual computers by hand. Desktops
 * that only ever registered a runner are copied in when someone lists devices,
 * so the list is complete from the first read.
 */
type OrganizationId = DenTypeId<"organization">
type MemberId = DenTypeId<"member">
type DeviceId = DenTypeId<"remoteDevice">
type Database = typeof db | typeof db.$primary | Parameters<Parameters<typeof db["transaction"]>[0]>[0]

export type RemoteDeviceActor = { organizationId: OrganizationId; memberId: MemberId }

type DeviceRow = typeof RemoteDeviceTable.$inferSelect
type EventData = Record<string, string | number | boolean | null>

const DESKTOP_PROVIDER: RemoteDeviceProvider = "openwork_desktop"
const WORKBOT_COMPUTER_LABEL = "Workbot's computer"
const SYNC_LIMIT = 500
/** A Workbot viewer renews its connection every 45 seconds; one event per sitting is enough. */
const VIEWER_EVENT_QUIET_MS = 10 * 60_000
const TOUCH_QUIET_MS = 60_000

export class RemoteDeviceError extends Error {
  constructor(readonly code: "remote_device_exists" | "remote_device_not_found" | "remote_device_forbidden", message: string) {
    super(message)
  }
}

const iso = (value: Date | null) => value?.toISOString() ?? null

function platformLabel(platform: RemoteDevicePlatform | null) {
  if (platform === "darwin") return "Mac"
  if (platform === "win32") return "Windows PC"
  if (platform === "linux") return "Linux computer"
  return "Computer"
}

function latest(...values: Array<Date | null | undefined>): Date | null {
  let result: Date | null = null
  for (const value of values) if (value && (!result || value > result)) result = value
  return result
}

type RunnerFacts = { lastSeenAt: Date; capabilities: readonly string[]; appVersion: string }

function availabilityOf(row: Pick<DeviceRow, "kind" | "provider" | "state">, lastSeenAt: Date | null, now: number): RemoteDeviceAvailability {
  return remoteDeviceAvailability({ kind: row.kind, provider: row.provider, state: row.state, lastSeenAt: lastSeenAt?.getTime() ?? null, now })
}

function deviceView(row: DeviceRow, input: { viewer: RemoteDeviceActor; canManageShared: boolean; runner: RunnerFacts | null; title: string | null; now: number }): RemoteDevice {
  const lastSeenAt = latest(row.lastSeenAt, input.runner?.lastSeenAt)
  const mine = row.ownerMemberId === input.viewer.memberId
  const manages = mine || (row.ownerMemberId === null && input.canManageShared)
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    source: row.source,
    platform: row.platform,
    label: labelOf(row, input.title),
    access: mine ? "mine" : "shared",
    availability: availabilityOf(row, lastSeenAt, input.now),
    state: row.state,
    statusDetail: row.statusDetail,
    lastSeenAt: iso(lastSeenAt),
    createdAt: row.createdAt.toISOString(),
    appVersion: input.runner?.appVersion ?? row.appVersion,
    computerId: row.kind === "desktop" && input.runner?.capabilities.includes(REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY) ? row.externalId : null,
    workbotChat: row.workbotChat,
    // Desktops name themselves and Workbot's computers are named after their chat.
    canRename: manages && row.source === "manual",
    canRemove: manages,
  }
}

function labelOf(row: Pick<DeviceRow, "label" | "provider" | "workbotChat">, title: string | null) {
  if (row.provider !== "workbot" || !row.workbotChat || row.workbotChat === "main" || !title) return row.label
  return `${WORKBOT_COMPUTER_LABEL} for “${title.slice(0, 60)}”`
}

function eventView(row: typeof RemoteDeviceEventTable.$inferSelect): RemoteDeviceEvent {
  return { id: row.id, type: row.type, level: row.level, message: row.message, actor: row.actor, createdAt: row.createdAt.toISOString() }
}

function adminEventView(row: typeof RemoteDeviceEventTable.$inferSelect): AdminRemoteDeviceEvent {
  return { ...eventView(row), data: row.data ?? null, actorId: row.actorId }
}

/** Appends one event. Pruning is occasional: the table is small per device and reads are bounded. */
async function recordEvent(database: Database, input: {
  organizationId: OrganizationId
  deviceId: DeviceId
  type: RemoteDeviceEventType
  level?: RemoteDeviceEventLevel
  message: string
  actor: RemoteDeviceEventActor
  actorId?: string | null
  data?: EventData | null
  now: Date
}) {
  await database.insert(RemoteDeviceEventTable).values({
    id: createDenTypeId("remoteDeviceEvent"),
    organizationId: input.organizationId,
    deviceId: input.deviceId,
    type: input.type,
    level: input.level ?? "info",
    message: input.message.slice(0, 300),
    actor: input.actor,
    actorId: input.actorId ?? null,
    data: input.data ?? null,
    createdAt: input.now,
  })
  if (Math.random() < 0.05) await pruneRemoteDeviceEvents(input.deviceId, input.now, database)
}

/** Keeps a device's newest REMOTE_DEVICE_EVENT_LIMIT events from the last REMOTE_DEVICE_EVENT_RETENTION_MS. */
export async function pruneRemoteDeviceEvents(deviceId: DeviceId, now = new Date(), database: Database = db) {
  await database.delete(RemoteDeviceEventTable).where(and(
    eq(RemoteDeviceEventTable.deviceId, deviceId),
    lt(RemoteDeviceEventTable.createdAt, new Date(now.getTime() - REMOTE_DEVICE_EVENT_RETENTION_MS)),
  ))
  const [oldestKept] = await database.select({ createdAt: RemoteDeviceEventTable.createdAt }).from(RemoteDeviceEventTable)
    .where(eq(RemoteDeviceEventTable.deviceId, deviceId))
    .orderBy(desc(RemoteDeviceEventTable.createdAt)).limit(1).offset(REMOTE_DEVICE_EVENT_LIMIT - 1)
  if (!oldestKept) return
  await database.delete(RemoteDeviceEventTable).where(and(
    eq(RemoteDeviceEventTable.deviceId, deviceId),
    lt(RemoteDeviceEventTable.createdAt, oldestKept.createdAt),
  ))
}

/**
 * Copies desktops that registered a runner but never reported as a device, so
 * a desktop on an older app version (or asleep since the feature came on) is
 * still listed. Scoped to one member, one organization or, for platform admins,
 * the whole deployment; bounded per call.
 */
async function syncDesktopsFromRunners(scope: { organizationId?: OrganizationId; memberId?: MemberId }, now: Date) {
  const cutoff = new Date(now.getTime() - REMOTE_DEVICE_DESKTOP_RETENTION_MS)
  const missing = await db.select({
    id: AutomationRunnerTable.id,
    organizationId: AutomationRunnerTable.organization_id,
    ownerMemberId: AutomationRunnerTable.owner_member_id,
    platform: AutomationRunnerTable.platform,
    appVersion: AutomationRunnerTable.app_version,
    lastSeenAt: AutomationRunnerTable.last_seen_at,
    inventory: AutomationRunnerTable.inventory,
  }).from(AutomationRunnerTable)
    .leftJoin(RemoteDeviceTable, and(
      eq(RemoteDeviceTable.organizationId, AutomationRunnerTable.organization_id),
      eq(RemoteDeviceTable.provider, DESKTOP_PROVIDER),
      eq(RemoteDeviceTable.externalId, AutomationRunnerTable.id),
    ))
    .where(and(
      isNull(RemoteDeviceTable.id),
      // Rows from before runner ids were scoped are replaced on the desktop's next registration.
      sql`${AutomationRunnerTable.id} like 'rnr|_%' escape '|'`,
      gte(AutomationRunnerTable.last_seen_at, cutoff),
      scope.organizationId ? eq(AutomationRunnerTable.organization_id, scope.organizationId) : undefined,
      scope.memberId ? eq(AutomationRunnerTable.owner_member_id, scope.memberId) : undefined,
    ))
    .limit(SYNC_LIMIT)
  if (missing.length === 0) return
  await db.insert(RemoteDeviceTable).values(missing.map((runner) => ({
    id: createDenTypeId("remoteDevice"),
    organizationId: runner.organizationId,
    ownerMemberId: runner.ownerMemberId,
    kind: "desktop" as const,
    provider: DESKTOP_PROVIDER,
    source: "desktop_app" as const,
    platform: runner.platform,
    externalId: runner.id,
    label: (runner.inventory?.computer.label ?? platformLabel(runner.platform)).slice(0, 120),
    state: "ready" as const,
    appVersion: runner.appVersion,
    lastSeenAt: runner.lastSeenAt,
    createdAt: now,
    updatedAt: now,
  }))).onDuplicateKeyUpdate({ set: { id: sql`${RemoteDeviceTable.id}` } })
}

async function runnerFacts(ids: readonly string[]): Promise<Map<string, RunnerFacts>> {
  if (ids.length === 0) return new Map()
  const rows = await db.select({
    id: AutomationRunnerTable.id,
    lastSeenAt: AutomationRunnerTable.last_seen_at,
    capabilities: AutomationRunnerTable.capabilities,
    appVersion: AutomationRunnerTable.app_version,
  }).from(AutomationRunnerTable).where(inArray(AutomationRunnerTable.id, [...ids]))
  return new Map(rows.map((row) => [row.id, { lastSeenAt: row.lastSeenAt, capabilities: row.capabilities ?? [], appVersion: row.appVersion }]))
}

async function sessionTitles(sessionIds: readonly string[]): Promise<Map<string, string>> {
  if (sessionIds.length === 0) return new Map()
  const rows = await db.select({ sessionId: HeadlessSessionIndexTable.sessionId, title: HeadlessSessionIndexTable.title })
    .from(HeadlessSessionIndexTable).where(inArray(HeadlessSessionIndexTable.sessionId, [...sessionIds]))
  return new Map(rows.filter((row) => row.title).map((row) => [row.sessionId, row.title]))
}

async function related(rows: readonly DeviceRow[]) {
  const [runners, titles] = await Promise.all([
    runnerFacts(rows.filter((row) => row.kind === "desktop").map((row) => row.externalId)),
    sessionTitles(rows.filter((row) => row.provider === "workbot" && row.workbotChat !== "main").map((row) => row.externalId)),
  ])
  return { runners, titles }
}

function visibleTo(actor: RemoteDeviceActor) {
  return and(
    eq(RemoteDeviceTable.organizationId, actor.organizationId),
    or(eq(RemoteDeviceTable.ownerMemberId, actor.memberId), isNull(RemoteDeviceTable.ownerMemberId)),
    isNull(RemoteDeviceTable.removedAt),
  )
}

const AVAILABILITY_ORDER: Record<RemoteDeviceAvailability, number> = { online: 0, needs_setup: 1, paused: 2, unknown: 3, offline: 4 }

/** The caller's own computers and the ones shared with the organization, online first. */
export async function listMemberRemoteDevices(actor: RemoteDeviceActor, options: { canManageShared: boolean; now?: Date }): Promise<RemoteDevice[]> {
  const now = options.now ?? new Date()
  await syncDesktopsFromRunners({ organizationId: actor.organizationId, memberId: actor.memberId }, now)
  const rows = await db.$primary.select().from(RemoteDeviceTable).where(visibleTo(actor)).limit(500)
  const { runners, titles } = await related(rows)
  const stale = now.getTime() - REMOTE_DEVICE_DESKTOP_RETENTION_MS
  return rows
    .map((row) => deviceView(row, { viewer: actor, canManageShared: options.canManageShared, runner: runners.get(row.externalId) ?? null, title: titles.get(row.externalId) ?? null, now: now.getTime() }))
    // A desktop nobody has heard from in a month is gone, as its runner registration is.
    .filter((device) => device.kind !== "desktop" || (device.lastSeenAt !== null && Date.parse(device.lastSeenAt) >= stale))
    .sort((a, b) => AVAILABILITY_ORDER[a.availability] - AVAILABILITY_ORDER[b.availability]
      || (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "")
      || a.label.localeCompare(b.label))
}

async function visibleRow(actor: RemoteDeviceActor, deviceId: DeviceId, database: Database = db.$primary) {
  const [row] = await database.select().from(RemoteDeviceTable).where(and(visibleTo(actor), eq(RemoteDeviceTable.id, deviceId))).limit(1)
  return row ?? null
}

async function viewOne(row: DeviceRow, actor: RemoteDeviceActor, canManageShared: boolean, now: Date) {
  const { runners, titles } = await related([row])
  return deviceView(row, { viewer: actor, canManageShared, runner: runners.get(row.externalId) ?? null, title: titles.get(row.externalId) ?? null, now: now.getTime() })
}

export async function readMemberRemoteDevice(actor: RemoteDeviceActor, deviceId: DeviceId, options: { canManageShared: boolean; now?: Date }) {
  const row = await visibleRow(actor, deviceId)
  if (!row) return null
  const events = await db.$primary.select().from(RemoteDeviceEventTable)
    .where(eq(RemoteDeviceEventTable.deviceId, row.id)).orderBy(desc(RemoteDeviceEventTable.createdAt)).limit(20)
  return { device: await viewOne(row, actor, options.canManageShared, options.now ?? new Date()), events: events.map(eventView) }
}

/** Registers a virtual computer by hand, for the caller or (with `shared`) for the whole organization. */
export async function registerRemoteDevice(actor: RemoteDeviceActor, input: RemoteDeviceRegisterRequest, options: { canManageShared: boolean; now?: Date }): Promise<RemoteDevice> {
  const now = options.now ?? new Date()
  if (input.shared && !options.canManageShared) throw new RemoteDeviceError("remote_device_forbidden", "Only people who manage desktop policies can share a computer with the whole organization.")
  const identity = and(
    eq(RemoteDeviceTable.organizationId, actor.organizationId),
    eq(RemoteDeviceTable.provider, input.provider),
    eq(RemoteDeviceTable.externalId, input.externalId),
  )
  const row = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(RemoteDeviceTable).where(identity).limit(1).for("update")
    if (existing && !existing.removedAt) throw new RemoteDeviceError("remote_device_exists", "This computer is already registered in your organization.")
    const values = {
      ownerMemberId: input.shared ? null : actor.memberId,
      createdByMemberId: actor.memberId,
      kind: "vm" as const,
      source: "manual" as const,
      platform: input.platform,
      label: input.label,
      state: "unknown" as const,
      statusDetail: null,
      lastSeenAt: null,
      removedAt: null,
      updatedAt: now,
    }
    const id = existing?.id ?? createDenTypeId("remoteDevice")
    if (existing) await tx.update(RemoteDeviceTable).set(values).where(eq(RemoteDeviceTable.id, existing.id))
    else await tx.insert(RemoteDeviceTable).values({ id, organizationId: actor.organizationId, provider: input.provider, externalId: input.externalId, createdAt: now, ...values })
    await recordEvent(tx, {
      organizationId: actor.organizationId, deviceId: id, type: "registered", actor: "member", actorId: actor.memberId, now,
      message: input.shared ? "Registered for everyone in the organization" : "Registered",
      data: { provider: input.provider, shared: input.shared },
    })
    const [created] = await tx.select().from(RemoteDeviceTable).where(eq(RemoteDeviceTable.id, id)).limit(1)
    if (!created) throw new Error("remote_device_missing")
    return created
  })
  return viewOne(row, actor, options.canManageShared, now)
}

async function manageableRow(actor: RemoteDeviceActor, deviceId: DeviceId, canManageShared: boolean, database: Database) {
  const row = await visibleRow(actor, deviceId, database)
  if (!row) throw new RemoteDeviceError("remote_device_not_found", "No such computer.")
  if (row.ownerMemberId === null && !canManageShared) throw new RemoteDeviceError("remote_device_forbidden", "Only people who manage desktop policies can change a computer shared with the whole organization.")
  return row
}

export async function renameRemoteDevice(actor: RemoteDeviceActor, deviceId: DeviceId, label: string, options: { canManageShared: boolean; now?: Date }): Promise<RemoteDevice> {
  const now = options.now ?? new Date()
  const row = await db.transaction(async (tx) => {
    const existing = await manageableRow(actor, deviceId, options.canManageShared, tx)
    if (existing.source !== "manual") throw new RemoteDeviceError("remote_device_forbidden", "This computer names itself.")
    if (existing.label === label) return existing
    await tx.update(RemoteDeviceTable).set({ label, updatedAt: now }).where(eq(RemoteDeviceTable.id, existing.id))
    await recordEvent(tx, { organizationId: actor.organizationId, deviceId: existing.id, type: "renamed", actor: "member", actorId: actor.memberId, message: "Renamed", now })
    return { ...existing, label }
  })
  return viewOne(row, actor, options.canManageShared, now)
}

/** Takes a computer off the list. Nothing is deleted at its provider, and a computer that reports again comes back. */
export async function removeRemoteDevice(actor: RemoteDeviceActor, deviceId: DeviceId, options: { canManageShared: boolean; now?: Date }) {
  const now = options.now ?? new Date()
  await db.transaction(async (tx) => {
    const existing = await manageableRow(actor, deviceId, options.canManageShared, tx)
    await tx.update(RemoteDeviceTable).set({ removedAt: now, updatedAt: now }).where(eq(RemoteDeviceTable.id, existing.id))
    await recordEvent(tx, { organizationId: actor.organizationId, deviceId: existing.id, type: "removed", actor: "member", actorId: actor.memberId, message: "Removed from the list", now })
  })
}

function desktopState(report: RemoteDeviceDesktopReport): { state: RemoteDeviceState; detail: string | null } {
  const computerUse = report.computerUse
  if (!computerUse?.enabled) return { state: "ready", detail: null }
  const selected = computerUse.computers.find((computer) => computer.id === computerUse.selectedId && computer.placement === "local")
    ?? computerUse.computers.find((computer) => computer.placement === "local")
  if (!selected || selected.readiness === null || selected.readiness === "ready") return { state: "ready", detail: null }
  // The desktop itself is running; what needs attention is its computer use.
  return { state: selected.readiness === "setup-required" ? "setup_required" : "ready", detail: selected.detail || null }
}

function diagnosticsOf(report: RemoteDeviceDesktopReport, now: Date): RemoteDeviceDiagnostics {
  return {
    reportedAt: now.toISOString(),
    osVersion: report.osVersion,
    arch: report.arch,
    computerUse: report.computerUse ? {
      enabled: report.computerUse.enabled,
      remoteEnabled: report.computerUse.remoteEnabled,
      selectedId: report.computerUse.selectedId,
      computers: report.computerUse.computers.map((computer) => ({
        id: computer.id, label: computer.label, placement: computer.placement, readiness: computer.readiness,
        detail: computer.detail, provider: computer.provider, externalId: computer.externalId,
      })),
      permissions: report.computerUse.permissions,
    } : null,
  }
}

const STATE_SENTENCE: Record<RemoteDeviceState, string> = {
  ready: "Ready",
  paused: "Paused",
  setup_required: "Needs setup",
  unavailable: "Could not be reached",
  unknown: "Not checked yet",
}

function stateEvent(state: RemoteDeviceState, detail: string | null): { level: RemoteDeviceEventLevel; message: string } {
  const level: RemoteDeviceEventLevel = state === "unavailable" ? "error" : state === "setup_required" ? "warning" : "info"
  return { level, message: detail ? `${STATE_SENTENCE[state]}: ${detail}` : STATE_SENTENCE[state] }
}

/**
 * A signed-in desktop's report about itself: creates or refreshes its row,
 * records what changed, and does the same for the VMs it is configured to
 * reach (never one that belongs to another member).
 */
export async function reportDesktopDevice(actor: RemoteDeviceActor, report: RemoteDeviceDesktopReport, options: { canManageShared: boolean; now?: Date }): Promise<RemoteDevice> {
  const now = options.now ?? new Date()
  const externalId = automationRunnerRowId({ organizationId: actor.organizationId, ownerMemberId: actor.memberId, runnerId: report.installId })
  const { state, detail } = desktopState(report)
  const row = await db.transaction(async (tx) => {
    const identity = and(
      eq(RemoteDeviceTable.organizationId, actor.organizationId),
      eq(RemoteDeviceTable.provider, DESKTOP_PROVIDER),
      eq(RemoteDeviceTable.externalId, externalId),
    )
    const [existing] = await tx.select().from(RemoteDeviceTable).where(identity).limit(1).for("update")
    const values = {
      platform: report.platform,
      label: report.label,
      state,
      statusDetail: detail,
      appVersion: report.appVersion,
      diagnostics: diagnosticsOf(report, now),
      lastSeenAt: now,
      removedAt: null,
      updatedAt: now,
    }
    const id = existing?.id ?? createDenTypeId("remoteDevice")
    const event = (type: RemoteDeviceEventType, message: string, level: RemoteDeviceEventLevel = "info", data: EventData | null = null) =>
      recordEvent(tx, { organizationId: actor.organizationId, deviceId: id, type, level, message, actor: "device", data, now })
    if (!existing) {
      await tx.insert(RemoteDeviceTable).values({
        id, organizationId: actor.organizationId, ownerMemberId: actor.memberId, kind: "desktop", provider: DESKTOP_PROVIDER,
        source: "desktop_app", externalId, createdAt: now, ...values,
      })
      await event("registered", `Signed in on OpenWork ${report.appVersion}`, "info", { appVersion: report.appVersion, platform: report.platform })
      if (state !== "ready") { const change = stateEvent(state, detail); await event("state_changed", change.message, change.level) }
    } else {
      await tx.update(RemoteDeviceTable).set(values).where(eq(RemoteDeviceTable.id, existing.id))
      if (existing.removedAt) await event("restored", "Signed in again")
      if (existing.appVersion && existing.appVersion !== report.appVersion) {
        await event("app_updated", `Updated OpenWork from ${existing.appVersion} to ${report.appVersion}`, "info", { from: existing.appVersion, to: report.appVersion })
      }
      if (existing.state !== state || (existing.statusDetail ?? null) !== detail) {
        const change = stateEvent(state, detail)
        await event("state_changed", change.message, change.level)
      }
      const before = existing.diagnostics?.computerUse?.selectedId ?? null
      const after = report.computerUse?.selectedId ?? null
      if (existing.diagnostics && before !== after && after) {
        const chosen = report.computerUse?.computers.find((computer) => computer.id === after)
        await event("computer_changed", `Agents now use ${chosen?.label ?? "another computer"}`, "info", { selectedId: after })
      }
    }
    for (const computer of report.computerUse?.computers ?? []) await reportReachableVm(tx, actor, computer, now)
    const [stored] = await tx.select().from(RemoteDeviceTable).where(eq(RemoteDeviceTable.id, id)).limit(1)
    if (!stored) throw new Error("remote_device_missing")
    return stored
  })
  return viewOne(row, actor, options.canManageShared, now)
}

const READINESS_STATE = { ready: "ready", "setup-required": "setup_required", unsupported: "unavailable", unavailable: "unavailable" } as const

/** A VM the desktop is configured to reach: registered for its member on first sight, refreshed after that. */
async function reportReachableVm(tx: Database, actor: RemoteDeviceActor, computer: RemoteDeviceReportedComputer, now: Date) {
  if (computer.placement !== "remote" || !computer.provider || !computer.externalId) return
  const [existing] = await tx.select().from(RemoteDeviceTable).where(and(
    eq(RemoteDeviceTable.organizationId, actor.organizationId),
    eq(RemoteDeviceTable.provider, computer.provider),
    eq(RemoteDeviceTable.externalId, computer.externalId),
  )).limit(1).for("update")
  // Someone else's VM: this desktop having its id does not make it this member's.
  if (existing && existing.ownerMemberId !== null && existing.ownerMemberId !== actor.memberId) return
  const state: RemoteDeviceState | null = computer.readiness ? READINESS_STATE[computer.readiness] : null
  const detail = state && state !== "ready" ? computer.detail || null : null
  if (!existing) {
    const id = createDenTypeId("remoteDevice")
    await tx.insert(RemoteDeviceTable).values({
      id, organizationId: actor.organizationId, ownerMemberId: actor.memberId, kind: "vm", provider: computer.provider,
      source: "desktop_app", platform: "linux", externalId: computer.externalId, label: computer.label,
      state: state ?? "unknown", statusDetail: detail, lastSeenAt: state ? now : null, createdAt: now, updatedAt: now,
    })
    await recordEvent(tx, { organizationId: actor.organizationId, deviceId: id, type: "registered", actor: "device", message: "Connected from OpenWork Desktop", data: { provider: computer.provider }, now })
    return
  }
  // No probe this time (the desktop only checks the computer agents use): leave what is known alone.
  if (!state && !existing.removedAt) return
  const next = state ?? existing.state
  await tx.update(RemoteDeviceTable).set({
    state: next, statusDetail: state ? detail : existing.statusDetail, removedAt: null, updatedAt: now,
    ...(state ? { lastSeenAt: now } : {}),
  }).where(eq(RemoteDeviceTable.id, existing.id))
  if (existing.removedAt) await recordEvent(tx, { organizationId: actor.organizationId, deviceId: existing.id, type: "restored", actor: "device", message: "Connected from OpenWork Desktop again", now })
  if (state && (existing.state !== state || (existing.statusDetail ?? null) !== detail)) {
    const change = stateEvent(state, detail)
    await recordEvent(tx, { organizationId: actor.organizationId, deviceId: existing.id, type: "state_changed", level: change.level, message: change.message, actor: "device", now })
  }
}

const VIEW_NAME = { browser: "Browser", computer: "Computer" } as const

/** What a failure code from Workbot's runner means for the computer. */
function workbotFailure(code: string | null): { state: RemoteDeviceState; detail: string; level: RemoteDeviceEventLevel } {
  if (code === "desktop_updating") return { state: "ready", detail: "Updating to a newer image", level: "warning" }
  if (code === "desktop_outdated") return { state: "setup_required", detail: "Needs a rebuild to get the current image", level: "warning" }
  if (code === "desktop_unavailable" || code === "desktop_unresponsive") return { state: "unavailable", detail: "Did not respond", level: "error" }
  return { state: "unavailable", detail: "Could not connect", level: "error" }
}

/**
 * What Workbot's server saw happen to a chat's cloud computer. The row is
 * created on the first report. Returns false when the session's computer
 * belongs to another member (never expected: session ids are derived per member).
 */
export async function reportWorkbotComputer(actor: RemoteDeviceActor, report: RemoteDeviceWorkbotReport, now = new Date()): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(RemoteDeviceTable).where(and(
      eq(RemoteDeviceTable.organizationId, actor.organizationId),
      eq(RemoteDeviceTable.provider, "workbot"),
      eq(RemoteDeviceTable.externalId, report.sessionId),
    )).limit(1).for("update")
    if (existing && existing.ownerMemberId !== actor.memberId) return false
    if (!existing && report.event === "removed") return true
    const id = existing?.id ?? createDenTypeId("remoteDevice")
    const failure = report.event === "failed" ? workbotFailure(report.code) : null
    const state: RemoteDeviceState = failure?.state ?? (report.event === "paused" ? "paused" : "ready")
    const removed = report.event === "removed"
    const values = {
      state: removed ? existing?.state ?? "unknown" : state,
      statusDetail: failure?.detail ?? null,
      workbotChat: report.chat,
      removedAt: removed ? now : null,
      updatedAt: now,
    }
    if (!existing) {
      await tx.insert(RemoteDeviceTable).values({
        id, organizationId: actor.organizationId, ownerMemberId: actor.memberId, kind: "vm", provider: "workbot", source: "workbot",
        platform: "linux", externalId: report.sessionId, label: WORKBOT_COMPUTER_LABEL, lastSeenAt: now, createdAt: now, ...values,
      })
      await recordEvent(tx, { organizationId: actor.organizationId, deviceId: id, type: "registered", actor: "workbot", message: "Workbot started using this computer", data: { chat: report.chat }, now })
    } else {
      const quiet = existing.lastSeenAt !== null && now.getTime() - existing.lastSeenAt.getTime() < TOUCH_QUIET_MS
      const unchanged = existing.state === values.state && (existing.statusDetail ?? null) === values.statusDetail && !existing.removedAt === !removed && existing.workbotChat === report.chat
      // A live viewer reports every renewal; skip the write when nothing would change.
      if (!(quiet && unchanged)) await tx.update(RemoteDeviceTable).set({ ...values, ...(removed ? {} : { lastSeenAt: now }) }).where(eq(RemoteDeviceTable.id, existing.id))
    }
    const message = workbotEventMessage(report, failure?.detail ?? null)
    if (report.event === "viewer_opened" && existing) {
      const [last] = await tx.select({ type: RemoteDeviceEventTable.type, data: RemoteDeviceEventTable.data, createdAt: RemoteDeviceEventTable.createdAt })
        .from(RemoteDeviceEventTable).where(eq(RemoteDeviceEventTable.deviceId, id)).orderBy(desc(RemoteDeviceEventTable.createdAt)).limit(1)
      const same = last?.type === "viewer_opened" && last.data?.view === report.view && last.data?.control === report.control
      if (same && now.getTime() - last.createdAt.getTime() < VIEWER_EVENT_QUIET_MS) return true
    }
    await recordEvent(tx, {
      organizationId: actor.organizationId, deviceId: id, type: report.event, level: failure?.level ?? "info", message,
      actor: report.event === "failed" ? "workbot" : "member", actorId: report.event === "failed" ? null : actor.memberId,
      data: { chat: report.chat, ...(report.code ? { code: report.code } : {}), ...(report.view ? { view: report.view, control: report.control } : {}) },
      now,
    })
    return true
  })
}

function workbotEventMessage(report: RemoteDeviceWorkbotReport, failure: string | null) {
  const view = report.view ? VIEW_NAME[report.view] : "Computer"
  switch (report.event) {
    case "viewer_opened": return report.control ? `Took control in the ${view} view` : `Opened the ${view} view`
    case "paused": return "Paused"
    case "resumed": return "Resumed"
    case "rebuilt": return "Rebuilt from a fresh image"
    case "continued": return "Returned control to Workbot"
    case "removed": return "Removed with its chat"
    case "failed": return failure ?? "Could not connect"
  }
}

/** Every device row and event of an organization, when the organization is deleted. */
export async function deleteOrganizationRemoteDevices(database: Database, organizationId: OrganizationId) {
  await database.delete(RemoteDeviceEventTable).where(eq(RemoteDeviceEventTable.organizationId, organizationId))
  await database.delete(RemoteDeviceTable).where(eq(RemoteDeviceTable.organizationId, organizationId))
}

// Platform admin views (/admin › Devices and the admin MCP tools). Read-only.

export type AdminRemoteDeviceFilters = {
  organizationId?: OrganizationId
  search?: string
  kind?: RemoteDeviceKind
  provider?: RemoteDeviceProvider
  availability?: RemoteDeviceAvailability
  problems?: boolean
  page?: number
  pageSize?: number
}

/** Last contact as readers see it: the device's own report or its runner's presence, whichever is newer. */
const seenSql = sql<Date | null>`greatest(coalesce(${RemoteDeviceTable.lastSeenAt}, '1970-01-01'), coalesce(${AutomationRunnerTable.last_seen_at}, '1970-01-01'))`

/** `remoteDeviceAvailability` in SQL, for filtering and counting; test/api/remote-devices.api.test.ts holds the two together. */
function availabilitySql(now: Date) {
  const cutoff = new Date(now.getTime() - REMOTE_DEVICE_ONLINE_WINDOW_MS)
  const recent = sql`${seenSql} >= ${cutoff}`
  return sql<RemoteDeviceAvailability>`case
    when ${RemoteDeviceTable.kind} = 'desktop' then (case when ${recent} then (case when ${RemoteDeviceTable.state} = 'setup_required' then 'needs_setup' else 'online' end) else 'offline' end)
    when ${RemoteDeviceTable.state} = 'paused' then 'paused'
    when ${RemoteDeviceTable.state} = 'setup_required' then 'needs_setup'
    when ${RemoteDeviceTable.state} = 'unavailable' then 'offline'
    when ${RemoteDeviceTable.state} = 'unknown' then 'unknown'
    when ${RemoteDeviceTable.provider} = 'workbot' then (case when ${recent} then 'online' else 'paused' end)
    else (case when ${recent} then 'online' else 'unknown' end)
  end`
}

function likePattern(search: string) {
  return `%${search.toLowerCase().replace(/[|%_]/g, (char) => `|${char}`)}%`
}

const runnerJoin = and(
  eq(RemoteDeviceTable.kind, "desktop"),
  eq(AutomationRunnerTable.id, RemoteDeviceTable.externalId),
)

function problemsSince(now: Date) {
  return new Date(now.getTime() - 24 * 60 * 60_000)
}

function hasProblemsSql(now: Date) {
  return sql`exists (select 1 from ${RemoteDeviceEventTable} where ${RemoteDeviceEventTable.deviceId} = ${RemoteDeviceTable.id}
    and ${RemoteDeviceEventTable.level} in ('warning', 'error') and ${RemoteDeviceEventTable.createdAt} >= ${problemsSince(now)})`
}

type AdminRow = {
  device: DeviceRow
  runnerSeenAt: Date | null
  runnerCapabilities: readonly string[] | null
  runnerAppVersion: string | null
  organizationName: string | null
  ownerName: string | null
  ownerEmail: string | null
}

const adminColumns = {
  device: RemoteDeviceTable,
  runnerSeenAt: AutomationRunnerTable.last_seen_at,
  runnerCapabilities: AutomationRunnerTable.capabilities,
  runnerAppVersion: AutomationRunnerTable.app_version,
  organizationName: OrganizationTable.name,
  ownerName: AuthUserTable.name,
  ownerEmail: AuthUserTable.email,
}

function adminQuery(where: SQL | undefined) {
  return db.select(adminColumns).from(RemoteDeviceTable)
    .leftJoin(AutomationRunnerTable, runnerJoin)
    .leftJoin(OrganizationTable, eq(OrganizationTable.id, RemoteDeviceTable.organizationId))
    .leftJoin(MemberTable, eq(MemberTable.id, RemoteDeviceTable.ownerMemberId))
    .leftJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(where)
}

async function adminViews(rows: readonly AdminRow[], now: Date): Promise<AdminRemoteDevice[]> {
  const ids = rows.map((row) => row.device.id)
  const since = problemsSince(now)
  const [titles, problems, lastEvents] = await Promise.all([
    sessionTitles(rows.filter((row) => row.device.provider === "workbot" && row.device.workbotChat !== "main").map((row) => row.device.externalId)),
    ids.length === 0 ? [] : db.select({ deviceId: RemoteDeviceEventTable.deviceId, total: sql<number>`count(*)` }).from(RemoteDeviceEventTable)
      .where(and(inArray(RemoteDeviceEventTable.deviceId, ids), inArray(RemoteDeviceEventTable.level, ["warning", "error"]), gte(RemoteDeviceEventTable.createdAt, since)))
      .groupBy(RemoteDeviceEventTable.deviceId),
    // One short indexed read per device on the page; a page is at most ADMIN_REMOTE_DEVICE_PAGE_SIZE.
    Promise.all(ids.map(async (id) => (await db.select().from(RemoteDeviceEventTable).where(eq(RemoteDeviceEventTable.deviceId, id))
      .orderBy(desc(RemoteDeviceEventTable.createdAt)).limit(1))[0] ?? null)),
  ])
  const problemCount = new Map(problems.map((row) => [row.deviceId, Number(row.total)]))
  return rows.map((row, index) => {
    const device = row.device
    const lastSeenAt = latest(device.lastSeenAt, row.runnerSeenAt)
    const lastEvent = lastEvents[index]
    return {
      id: device.id,
      kind: device.kind,
      provider: device.provider,
      source: device.source,
      platform: device.platform,
      label: labelOf(device, titles.get(device.externalId) ?? null),
      availability: availabilityOf(device, lastSeenAt, now.getTime()),
      state: device.state,
      statusDetail: device.statusDetail,
      lastSeenAt: iso(lastSeenAt),
      createdAt: device.createdAt.toISOString(),
      appVersion: row.runnerAppVersion ?? device.appVersion,
      computerId: device.kind === "desktop" && row.runnerCapabilities?.includes(REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY) ? device.externalId : null,
      workbotChat: device.workbotChat,
      organization: { id: device.organizationId, name: row.organizationName ?? "Deleted organization" },
      owner: device.ownerMemberId ? { memberId: device.ownerMemberId, name: row.ownerName, email: row.ownerEmail } : null,
      shared: device.ownerMemberId === null,
      externalId: device.externalId,
      removedAt: iso(device.removedAt),
      recentProblems: problemCount.get(device.id) ?? 0,
      lastEvent: lastEvent ? adminEventView(lastEvent) : null,
    }
  })
}

/** Every device on the deployment for platform admins: filtered, searched and paged on the server. */
export async function listAdminRemoteDevices(filters: AdminRemoteDeviceFilters, now = new Date()): Promise<AdminRemoteDeviceListResponse> {
  await syncDesktopsFromRunners({ organizationId: filters.organizationId }, now)
  const pageSize = Math.max(1, Math.min(ADMIN_REMOTE_DEVICE_PAGE_SIZE, filters.pageSize ?? ADMIN_REMOTE_DEVICE_PAGE_SIZE))
  const page = Math.max(1, Math.min(200, filters.page ?? 1))
  const pattern = filters.search?.trim() ? likePattern(filters.search.trim()) : null
  const live = and(
    isNull(RemoteDeviceTable.removedAt),
    // Desktops unheard from for a month have left the member's list too.
    sql`(${RemoteDeviceTable.kind} <> 'desktop' or ${seenSql} >= ${new Date(now.getTime() - REMOTE_DEVICE_DESKTOP_RETENTION_MS)})`,
  )
  const where = and(
    live,
    filters.organizationId ? eq(RemoteDeviceTable.organizationId, filters.organizationId) : undefined,
    filters.kind ? eq(RemoteDeviceTable.kind, filters.kind) : undefined,
    filters.provider ? eq(RemoteDeviceTable.provider, filters.provider) : undefined,
    filters.availability ? sql`${availabilitySql(now)} = ${filters.availability}` : undefined,
    filters.problems ? hasProblemsSql(now) : undefined,
    pattern ? sql`(lower(${RemoteDeviceTable.label}) like ${pattern} escape '|' or lower(${RemoteDeviceTable.externalId}) like ${pattern} escape '|'
      or lower(${RemoteDeviceTable.id}) like ${pattern} escape '|' or lower(${OrganizationTable.name}) like ${pattern} escape '|'
      or lower(${AuthUserTable.email}) like ${pattern} escape '|' or lower(${AuthUserTable.name}) like ${pattern} escape '|')` : undefined,
  )
  const counted = (condition: SQL | undefined) => db.select({ total: sql<number>`count(*)` }).from(RemoteDeviceTable)
    .leftJoin(AutomationRunnerTable, runnerJoin)
    .leftJoin(OrganizationTable, eq(OrganizationTable.id, RemoteDeviceTable.organizationId))
    .leftJoin(MemberTable, eq(MemberTable.id, RemoteDeviceTable.ownerMemberId))
    .leftJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(condition)
  const [rows, matching, total, online, withProblems] = await Promise.all([
    adminQuery(where).orderBy(desc(seenSql), desc(RemoteDeviceTable.createdAt), desc(RemoteDeviceTable.id)).limit(pageSize).offset((page - 1) * pageSize),
    counted(where),
    counted(live),
    counted(and(live, sql`${availabilitySql(now)} = 'online'`)),
    counted(and(live, hasProblemsSql(now))),
  ])
  return {
    devices: await adminViews(rows, now),
    total: Number(matching[0]?.total ?? 0),
    page,
    pageSize,
    summary: { total: Number(total[0]?.total ?? 0), online: Number(online[0]?.total ?? 0), withProblems: Number(withProblems[0]?.total ?? 0) },
  }
}

/** One device with everything Den knows that explains its state: the last report, its events, runner and session rows, and the owner's features. */
export async function readAdminRemoteDevice(deviceId: DeviceId, now = new Date()): Promise<AdminRemoteDeviceDetailResponse | null> {
  const [row] = await adminQuery(eq(RemoteDeviceTable.id, deviceId)).limit(1)
  if (!row) return null
  const device = row.device
  const [[view], events, runnerRows, sessionRows, ownerRows] = await Promise.all([
    adminViews([row], now),
    db.select().from(RemoteDeviceEventTable).where(eq(RemoteDeviceEventTable.deviceId, device.id)).orderBy(desc(RemoteDeviceEventTable.createdAt)).limit(100),
    device.kind === "desktop"
      ? db.select({
          id: AutomationRunnerTable.id, capabilities: AutomationRunnerTable.capabilities, appVersion: AutomationRunnerTable.app_version,
          lastSeenAt: AutomationRunnerTable.last_seen_at, inventory: AutomationRunnerTable.inventory, inventoryUpdatedAt: AutomationRunnerTable.inventory_updated_at,
        }).from(AutomationRunnerTable).where(eq(AutomationRunnerTable.id, device.externalId)).limit(1)
      : [],
    device.provider === "workbot"
      ? db.select({
          sessionId: HeadlessSessionIndexTable.sessionId, kind: HeadlessSessionIndexTable.kind, title: HeadlessSessionIndexTable.title,
          updatedAt: HeadlessSessionIndexTable.updatedAt, activeTurnSince: HeadlessSessionIndexTable.activeTurnSince, deletedAt: HeadlessSessionIndexTable.deletedAt,
        }).from(HeadlessSessionIndexTable).where(and(eq(HeadlessSessionIndexTable.sessionId, device.externalId), eq(HeadlessSessionIndexTable.organizationId, device.organizationId))).limit(1)
      : [],
    device.ownerMemberId
      ? db.select({ userId: MemberTable.userId }).from(MemberTable).where(eq(MemberTable.id, device.ownerMemberId)).limit(1)
      : [],
  ])
  if (!view) return null
  const ownerUserId = ownerRows[0]?.userId
  const features = await getOrganizationFeatures(device.organizationId, ownerUserId ? { userId: ownerUserId } : {})
  const runner = runnerRows[0]
  const session = sessionRows[0]
  return {
    device: view,
    diagnostics: device.diagnostics ?? null,
    events: events.map(adminEventView),
    runner: runner ? {
      computerId: runner.id,
      capabilities: runner.capabilities ?? [],
      appVersion: runner.appVersion,
      lastSeenAt: runner.lastSeenAt.toISOString(),
      workspaces: runner.inventory ? runner.inventory.workspaces.length : null,
      inventoryUpdatedAt: iso(runner.inventoryUpdatedAt),
    } : null,
    session: session ? {
      sessionId: session.sessionId, kind: session.kind, title: session.title, updatedAt: session.updatedAt.toISOString(),
      activeTurnSince: iso(session.activeTurnSince), deletedAt: iso(session.deletedAt),
    } : null,
    features: {
      remoteDevices: features.remoteDevices,
      computerUse: features.computerUse,
      remoteComputers: features.remoteComputers,
      browserUse: features.browserUse,
      sandboxGateway: features.sandboxGateway,
    },
  }
}
