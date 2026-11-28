import { and, asc, desc, eq, gt, inArray, isNull, or } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, AutomationRunnerTable, ComputerAccessTable, ComputerDisconnectionTable, ComputerGrantTable, MemberTable, OrganizationTable, RemoteDeviceEventTable, RemoteDeviceTable, WorkerTable } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { ownerWholeVmScope } from "@openwork/computers"
import {
  COMPUTER_INVENTORY_PAGE_SIZE, COMPUTER_INVENTORY_RECENT_MS, readOrganizationComputerRules,
  type ComputerInventoryDetailResponse, type ComputerInventoryOwner, type ComputerInventoryRow, type ComputerMergedSignIn,
  type ComputerRunCode, type MyComputerInventoryResponse, type OrganizationComputerInventoryResponse,
  type OrganizationComputerInventoryTab, type OrganizationComputerRules,
} from "@openwork/types/den/computer-inventory"
import { COMPUTER_OWNER_WHOLE_VM_SOURCE_KEY, COMPUTER_SHELL_RUNNER_CAPABILITY, type ComputerOwnerChoice } from "@openwork/types/den/computers"
import { REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY } from "@openwork/types/automations"
import { remoteDeviceTypeLabel } from "@openwork/types/den/remote-devices"
import { deviceDisconnectionJoin } from "../computer-disconnect.js"
import { db } from "../db.js"
import { getOrganizationFeaturesByMember } from "../features.js"
import {
  eventView, latestDeviceContact, memberRemoteDeviceActions, organizationRemoteDeviceActions, remoteAccessOf,
  remoteDeviceRunnerJoin, syncDesktopsFromRunners, WORKBOT_COMPUTER_LABEL, type RemoteDeviceActor,
} from "../remote-devices.js"
import { remoteSessionAccessPolicy } from "../remote-sessions/access.js"
import { sourceViews } from "./grants.js"
import { deviceInventoryStatus, groupComputerSignIns, inventorySessions, type SignInGroup } from "./inventory.js"

const BATCH_SIZE = 500

type DeviceId = DenTypeId<"remoteDevice">
type WorkerId = DenTypeId<"worker">
type Viewer = { actor: RemoteDeviceActor } & ({ kind: "member"; canManageShared: boolean } | { kind: "organization"; canDisconnect: boolean })

type OwnerColumns = { ownerId: string | null; ownerName: string | null; ownerEmail: string | null; ownerRemovedAt: Date | null; ownerUserId: string | null }
const ownerColumns = {
  ownerId: MemberTable.id, ownerName: AuthUserTable.name, ownerEmail: AuthUserTable.email,
  ownerRemovedAt: MemberTable.removedAt, ownerUserId: AuthUserTable.id,
}

function ownerView(memberId: string | null, row: OwnerColumns): ComputerInventoryOwner | null {
  return memberId === null ? null : {
    memberId, name: row.ownerName, email: row.ownerEmail,
    former: !row.ownerId || !row.ownerUserId || row.ownerRemovedAt !== null,
  }
}

async function readDevices(viewer: Viewer, after: DeviceId | undefined) {
  const d = RemoteDeviceTable
  const r = AutomationRunnerTable
  const rows = await db.$primary.select({
    id: d.id, organizationId: d.organizationId, ownerMemberId: d.ownerMemberId, kind: d.kind, provider: d.provider,
    source: d.source, label: d.label, platform: d.platform, machineKey: d.machineKey, state: d.state, statusDetail: d.statusDetail,
    removedAt: d.removedAt, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, appVersion: d.appVersion,
    disconnectedAt: ComputerDisconnectionTable.disconnectedAt,
    runnerSeenAt: r.last_seen_at, runnerAppVersion: r.app_version, runnerCapabilities: r.capabilities, runnerSessionAccess: r.session_access,
    choice: ComputerAccessTable.ownerChoice, ...ownerColumns,
  }).from(d)
    .leftJoin(r, remoteDeviceRunnerJoin)
    .leftJoin(ComputerDisconnectionTable, deviceDisconnectionJoin)
    .leftJoin(ComputerAccessTable, and(eq(ComputerAccessTable.deviceId, d.id), eq(ComputerAccessTable.organizationId, d.organizationId)))
    .leftJoin(MemberTable, and(eq(MemberTable.id, d.ownerMemberId), eq(MemberTable.organizationId, d.organizationId)))
    .leftJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(and(
      eq(d.organizationId, viewer.actor.organizationId), isNull(d.removedAt), after ? gt(d.id, after) : undefined,
      viewer.kind === "member" ? or(eq(d.ownerMemberId, viewer.actor.memberId), isNull(d.ownerMemberId)) : undefined,
    )).orderBy(asc(d.id)).limit(BATCH_SIZE)
  return rows.map((row) => ({
    ...row, lastSeenAt: latestDeviceContact(row.lastSeenAt, row.runnerSeenAt), appVersion: row.runnerAppVersion ?? row.appVersion,
    owner: ownerView(row.ownerMemberId, row),
  }))
}

type Device = Awaited<ReturnType<typeof readDevices>>[number]

async function readInstances(organizationId: RemoteDeviceActor["organizationId"], after: WorkerId | undefined, id?: WorkerId) {
  const w = WorkerTable
  return db.$primary.select({
    id: w.id, label: w.name, state: w.status, appVersion: w.image_version, lastSeenAt: w.last_heartbeat_at,
    createdAt: w.created_at, ...ownerColumns,
  }).from(w)
    .leftJoin(MemberTable, and(eq(MemberTable.organizationId, w.org_id), eq(MemberTable.userId, w.created_by_user_id)))
    .leftJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(and(eq(w.org_id, organizationId), after ? gt(w.id, after) : undefined, id ? eq(w.id, id) : undefined))
    .orderBy(asc(w.id)).limit(id ? 1 : BATCH_SIZE)
}

type Instance = Awaited<ReturnType<typeof readInstances>>[number]

async function readBatches<T extends { id: string }, I extends T["id"]>(read: (after: I | undefined) => Promise<(T & { id: I })[]>) {
  const rows: T[] = []
  let after: I | undefined
  for (;;) {
    const batch = await read(after)
    rows.push(...batch)
    const last = batch.at(-1)
    if (!last || batch.length < BATCH_SIZE) return rows
    after = last.id
  }
}

async function readGrants(organizationId: RemoteDeviceActor["organizationId"], ids: DeviceId[]) {
  const g = ComputerGrantTable
  return db.$primary.select({
    targetId: g.targetDeviceId, sourceKey: g.sourceKey, folders: g.folders, revokedAt: g.revokedAt, revokedByMemberId: g.revokedByMemberId,
  }).from(g).where(and(eq(g.organizationId, organizationId), inArray(g.targetDeviceId, ids))).orderBy(asc(g.sourceKey))
}

type Grant = Awaited<ReturnType<typeof readGrants>>[number]

async function grantsByDevice(organizationId: RemoteDeviceActor["organizationId"], ids: DeviceId[]) {
  const grants = new Map<DeviceId, Grant[]>()
  for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
    for (const grant of await readGrants(organizationId, ids.slice(offset, offset + BATCH_SIZE))) {
      const list = grants.get(grant.targetId) ?? []
      list.push(grant)
      grants.set(grant.targetId, list)
    }
  }
  return grants
}

function isDaytona(device: Device) {
  return device.kind === "vm" && device.provider === "daytona" && device.source === "manual"
}

function canRunCode(device: Device, kind: SignInGroup<Device>["kind"]) {
  return isDaytona(device) || (kind === "desktop" && device.runnerCapabilities?.includes(COMPUTER_SHELL_RUNNER_CAPABILITY) === true)
}

function runCode(group: SignInGroup<Device>, rules: OrganizationComputerRules, grants: Grant[]): ComputerRunCode {
  const { newest: device, kind } = group
  if (!canRunCode(device, kind)) return { value: "not_available" }
  if (!rules.runCode) return { value: "no", reason: "organization" }
  if (device.choice === null) return { value: "no", reason: "not_chosen" }
  if (device.choice !== "allow") return { value: "no", reason: "owner" }
  const active = grants.filter((grant) => !grant.revokedAt)
  if (kind === "desktop") {
    const folders = new Set(active.filter((grant) => grant.sourceKey !== COMPUTER_OWNER_WHOLE_VM_SOURCE_KEY).flatMap((grant) => grant.folders))
    return { value: "sandbox", folders: folders.size }
  }
  const whole = active.find((grant) => grant.sourceKey === COMPUTER_OWNER_WHOLE_VM_SOURCE_KEY)
  const scope = ownerWholeVmScope(device.id, {
    organization: { allowed: rules.runCode, requireSandboxOnPersonal: rules.requireSandboxOnPersonal }, owner: { choice: device.choice },
    grants: whole ? [{ source: { kind: "owner" }, targetId: device.id, scope: { surface: "whole_vm", folders: whole.folders } }] : [],
  })
  return scope ? { value: "whole_computer" } : { value: "no", reason: "owner" }
}

function actions(device: Device, viewer: Viewer, now: number) {
  const facts = { disconnected: device.disconnectedAt !== null, lastSeenAt: device.lastSeenAt, now }
  return viewer.kind === "member"
    ? memberRemoteDeviceActions(device, { ...facts, viewer: viewer.actor, canManageShared: viewer.canManageShared })
    : { canRename: false, ...organizationRemoteDeviceActions(device, { ...facts, canDisconnect: viewer.canDisconnect, former: device.owner?.former === true }) }
}

async function loadInventory(viewer: Viewer, now: Date) {
  const { actor } = viewer
  await syncDesktopsFromRunners({ organizationId: actor.organizationId, memberId: viewer.kind === "member" ? actor.memberId : undefined, includeStale: true }, now)
  const [devices, [organization]] = await Promise.all([
    readBatches((after: DeviceId | undefined) => readDevices(viewer, after)),
    db.$primary.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, actor.organizationId)).limit(1),
  ])
  return { groups: groupComputerSignIns(devices), metadata: organization?.metadata ?? null }
}

type Loaded = Awaited<ReturnType<typeof loadInventory>>

async function deviceRows({ groups, metadata }: Loaded, viewer: Viewer, now: number, includeAllGrants: boolean) {
  const rules = readOrganizationComputerRules(metadata).rules
  const taskGroups = groups.filter(({ kind, newest }) => kind === "desktop" && newest.ownerMemberId && !newest.owner?.former && !newest.disconnectedAt
    && newest.runnerCapabilities?.includes(REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY))
  const [features, grants] = await Promise.all([
    taskGroups.length ? getOrganizationFeaturesByMember(viewer.actor.organizationId) : null,
    grantsByDevice(viewer.actor.organizationId, groups.filter((group) => includeAllGrants || (group.newest.choice === "allow" && rules.runCode && canRunCode(group.newest, group.kind))).map(({ newest }) => newest.id)),
  ])
  const rows = groups.map((group) => {
    const { kind, newest, merged } = group
    const policy = features && newest.ownerMemberId && !newest.owner?.former
      ? remoteSessionAccessPolicy({ features: features.forMember(newest.ownerMemberId), metadata }) : null
    const runner = newest.runnerCapabilities && { capabilities: newest.runnerCapabilities, sessionAccess: newest.runnerSessionAccess }
    const access = remoteAccessOf(newest, runner, newest.disconnectedAt !== null, policy)
    const ownGrants = grants.get(newest.id) ?? []
    const kindLabel = kind === "cloud" && newest.provider === "daytona" ? "Daytona computer"
      : kind === "cloud" && newest.provider === "freestyle" ? "Freestyle computer" : remoteDeviceTypeLabel(newest)
    const computer: ComputerInventoryRow = {
      id: newest.id, kind, kindLabel, label: kind === "workbot" ? WORKBOT_COMPUTER_LABEL : newest.label,
      owner: newest.owner, shared: newest.ownerMemberId === null,
      ...deviceInventoryStatus(newest, kind, now, access), runCode: runCode(group, rules, ownGrants),
      sessions: inventorySessions(access), mergedSignIns: merged.length, ...actions(newest, viewer, now),
    }
    const mergedSignIns = merged.map((row): ComputerMergedSignIn => ({
      id: row.id, computerId: newest.id, label: row.label, appVersion: row.appVersion, addedAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null, canRemove: actions(row, viewer, now).canRemove,
    }))
    return { computer, mergedSignIns, addedAt: newest.createdAt.toISOString(), grants: ownGrants }
  })
  return { rows, rules }
}

function instanceRow(instance: Instance) {
  const failed = instance.state === "failed"
  const computer: ComputerInventoryRow = {
    id: instance.id, kind: "instance", kindLabel: "OpenWork instance", label: instance.label,
    owner: ownerView(instance.ownerId, instance), shared: instance.ownerId === null,
    status: { state: failed ? "has_a_problem" : instance.state === "healthy" ? "ready" : "starts_when_needed", lastSeenAt: instance.lastSeenAt?.toISOString() ?? null },
    notes: failed ? [{ code: "provider_problem", message: "This OpenWork instance could not be reached." }] : [],
    runCode: { value: "not_available" }, sessions: inventorySessions(null), mergedSignIns: 0,
    canRename: false, canDisconnect: false, canRemove: false,
  }
  return { computer, addedAt: instance.createdAt.toISOString(), mergedSignIns: [] }
}

type InventoryEntry = { computer: ComputerInventoryRow; addedAt: string; mergedSignIns: ComputerMergedSignIn[] }
const contactAt = ({ computer, addedAt }: InventoryEntry) => computer.status.lastSeenAt ?? (computer.kind === "desktop" ? null : addedAt)
const reachable = ({ computer }: InventoryEntry) => computer.status.state === "online" || computer.status.state === "ready"
const sorted = (a: InventoryEntry, b: InventoryEntry) => Number(reachable(b)) - Number(reachable(a))
  || (contactAt(b) ?? "").localeCompare(contactAt(a) ?? "") || b.addedAt.localeCompare(a.addedAt) || b.computer.id.localeCompare(a.computer.id)
const viewRows = (rows: InventoryEntry[]) => ({ computers: rows.map(({ computer }) => computer), mergedSignIns: rows.flatMap(({ mergedSignIns }) => mergedSignIns) })

export async function listMyComputerInventory(viewer: Extract<Viewer, { kind: "member" }>, now = new Date()): Promise<MyComputerInventoryResponse> {
  const { rows } = await deviceRows(await loadInventory(viewer, now), viewer, now.getTime(), false)
  return viewRows(rows.sort(sorted))
}

function matchingTabs({ computer }: InventoryEntry): OrganizationComputerInventoryTab[] {
  if (computer.kind === "instance") return computer.owner?.former ? [] : ["cloud"]
  if (computer.owner?.former) return ["former"]
  const primary = computer.kind === "desktop" ? "desktops" : "cloud"
  return computer.status.state === "has_a_problem" || computer.notes.length > 0 ? [primary, "attention"] : [primary]
}

export async function listOrganizationComputerInventory(viewer: Extract<Viewer, { kind: "organization" }>, input: {
  tab: OrganizationComputerInventoryTab; search?: string; older?: "include"; page: number
}, now = new Date()): Promise<OrganizationComputerInventoryResponse> {
  const [loaded, instances] = await Promise.all([
    loadInventory(viewer, now), readBatches((after: WorkerId | undefined) => readInstances(viewer.actor.organizationId, after)),
  ])
  const { rows, rules } = await deviceRows(loaded, viewer, now.getTime(), false)
  const search = input.search?.trim().toLowerCase()
  const counts = { desktops: 0, cloud: 0, attention: 0, former: 0 }
  const matched: InventoryEntry[] = []
  let olderHidden = 0
  for (const entry of [...rows, ...instances.map(instanceRow)]) {
    const { computer } = entry
    if (search && ![computer.label, computer.owner?.name, computer.owner?.email].some((value) => value?.toLowerCase().includes(search))) continue
    const tabs = matchingTabs(entry)
    for (const tab of tabs) counts[tab]++
    if (!tabs.includes(input.tab)) continue
    const latest = contactAt(entry)
    if (input.older !== "include" && (!latest || Date.parse(latest) < now.getTime() - COMPUTER_INVENTORY_RECENT_MS)) olderHidden++
    else matched.push(entry)
  }
  const pageSize = COMPUTER_INVENTORY_PAGE_SIZE
  const start = (input.page - 1) * pageSize
  return {
    tab: input.tab, counts, rules, olderHidden, total: matched.length, page: input.page, pageSize,
    ...viewRows(matched.sort(sorted).slice(start, start + pageSize)),
  }
}

const platformNames = { darwin: "macOS", win32: "Windows", linux: "Linux" }

export async function readComputerInventoryDetail(viewer: Viewer, id: DeviceId, now = new Date()): Promise<ComputerInventoryDetailResponse | null> {
  const loaded = await loadInventory(viewer, now)
  const group = loaded.groups.find(({ newest }) => newest.id === id)
  if (!group) return null
  const { newest } = group
  const callerIsOwner = newest.ownerMemberId === viewer.actor.memberId && newest.owner?.former !== true
  const canReadGrants = callerIsOwner || viewer.kind === "organization"
  const [{ rows: [entry], rules }, events] = await Promise.all([
    deviceRows({ ...loaded, groups: [group] }, viewer, now.getTime(), canReadGrants),
    db.$primary.select().from(RemoteDeviceEventTable)
      .where(and(eq(RemoteDeviceEventTable.organizationId, viewer.actor.organizationId), eq(RemoteDeviceEventTable.deviceId, id)))
      .orderBy(desc(RemoteDeviceEventTable.createdAt), desc(RemoteDeviceEventTable.id)).limit(20),
  ])
  if (!entry) return null
  const { computer, mergedSignIns, addedAt, grants } = entry
  return {
    computer, callerIsOwner, rules, sessions: computer.sessions, activity: events.map(eventView),
    installed: { appVersion: newest.appVersion, platform: newest.platform && platformNames[newest.platform], signedInAs: signedInAs(computer.owner), addedAt, lastSeenAt: computer.status.lastSeenAt, mergedSignIns },
    runCode: {
      value: computer.runCode, sources: canReadGrants ? await sourceViews(db.$primary, viewer, computer.owner?.name ?? computer.owner?.email ?? null, grants) : [],
      canChange: callerIsOwner && isDaytona(newest), canRevoke: viewer.kind === "member" ? callerIsOwner : viewer.canDisconnect, canRestore: callerIsOwner,
    },
  }
}

function signedInAs(owner: ComputerInventoryOwner | null) {
  return owner ? { name: owner.name, email: owner.email } : null
}

export async function readInventoryInstanceDetail(viewer: Extract<Viewer, { kind: "organization" }>, id: WorkerId): Promise<ComputerInventoryDetailResponse | null> {
  const organizationId = viewer.actor.organizationId
  const [[instance], [organization]] = await Promise.all([
    readInstances(organizationId, undefined, id),
    db.$primary.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, organizationId)).limit(1),
  ])
  if (!instance) return null
  const { computer, addedAt } = instanceRow(instance)
  if (computer.owner?.former) return null
  return {
    computer, rules: readOrganizationComputerRules(organization?.metadata).rules, activity: [], sessions: computer.sessions,
    callerIsOwner: computer.owner?.memberId === viewer.actor.memberId,
    installed: { appVersion: instance.appVersion, platform: null, signedInAs: signedInAs(computer.owner), addedAt, lastSeenAt: computer.status.lastSeenAt, mergedSignIns: [] },
    runCode: { value: computer.runCode, sources: [], canChange: false, canRevoke: false, canRestore: false },
  }
}
