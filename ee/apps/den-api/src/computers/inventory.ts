import type { RemoteDeviceTable } from "@openwork-ee/den-db/schema"
import type { ComputerInventoryNote, ComputerInventoryRow, ComputerInventoryState, ComputerSessions } from "@openwork/types/den/computer-inventory"
import { REMOTE_DEVICE_ONLINE_WINDOW_MS, type RemoteDeviceAccess } from "@openwork/types/den/remote-devices"

type Device = typeof RemoteDeviceTable.$inferSelect
export type InventorySignIn = Pick<Device, "id" | "organizationId" | "ownerMemberId" | "kind" | "provider" | "label" | "platform" | "machineKey" | "createdAt" | "lastSeenAt" | "removedAt"> & {
  disconnectedAt: Date | null
}

type DeviceKind = Exclude<ComputerInventoryRow["kind"], "instance">
export type SignInGroup<T> = { kind: DeviceKind; newest: T; merged: T[] }

export function deviceInventoryKind(row: Pick<Device, "kind" | "provider">): DeviceKind {
  if (row.provider === "workbot") return "workbot"
  return row.kind === "desktop" && row.provider === "openwork_desktop" ? "desktop" : "cloud"
}

function newestFirst(a: InventorySignIn, b: InventorySignIn): number {
  return (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0)
    || b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)
}

function ownerKey(row: InventorySignIn) {
  return JSON.stringify([row.organizationId, row.ownerMemberId])
}

function nameKey(row: InventorySignIn) {
  return JSON.stringify([row.organizationId, row.ownerMemberId, row.platform, row.label.trim().toLowerCase()])
}

function separateContact(a: InventorySignIn, b: InventorySignIn): boolean {
  if (!a.lastSeenAt || !b.lastSeenAt) return true
  const aEnd = a.lastSeenAt.getTime()
  const bEnd = b.lastSeenAt.getTime()
  const firstContactWithTolerance = (row: InventorySignIn, seen: number) => Math.min(row.createdAt.getTime(), seen) + REMOTE_DEVICE_ONLINE_WINDOW_MS
  return aEnd <= firstContactWithTolerance(b, bEnd) || bEnd <= firstContactWithTolerance(a, aEnd)
}

export function groupComputerSignIns<T extends InventorySignIn>(rows: readonly T[]): SignInGroup<T>[] {
  const groups: SignInGroup<T>[] = []
  const workbots = new Map<string, T>()
  const keyed = new Map<string, T[]>()
  const byName = new Map<string, Set<T[]>>()
  const keyless: T[] = []
  const addByName = (row: T, group: T[]) => {
    const key = nameKey(row)
    const candidates = byName.get(key) ?? new Set<T[]>()
    candidates.add(group)
    byName.set(key, candidates)
  }
  for (const row of rows.filter((row) => !row.removedAt).sort(newestFirst)) {
    const kind = deviceInventoryKind(row)
    if (kind === "cloud" || row.ownerMemberId === null) {
      groups.push({ kind, newest: row, merged: [] })
    } else if (kind === "workbot") {
      const key = ownerKey(row)
      if (!workbots.has(key)) workbots.set(key, row)
    } else if (row.machineKey) {
      const key = JSON.stringify([row.organizationId, row.ownerMemberId, row.machineKey])
      const group = keyed.get(key) ?? []
      group.push(row)
      keyed.set(key, group)
      addByName(row, group)
    } else {
      keyless.push(row)
    }
  }
  const desktopGroups = [...keyed.values()]
  for (const row of keyless) {
    const compatible = [...(byName.get(nameKey(row)) ?? [])].filter((group) => group.every((other) => separateContact(row, other)))
    const [match] = compatible
    if (match && compatible.length === 1) {
      match.push(row)
    } else {
      const group = [row]
      addByName(row, group)
      desktopGroups.push(group)
    }
  }
  for (const signIns of desktopGroups) {
    signIns.sort((a, b) => Number(a.disconnectedAt !== null) - Number(b.disconnectedAt !== null) || newestFirst(a, b))
    const [newest, ...merged] = signIns
    if (newest) groups.push({ kind: "desktop", newest, merged: merged.sort(newestFirst) })
  }
  for (const newest of workbots.values()) groups.push({ kind: "workbot", newest, merged: [] })
  return groups
}

export function inventorySessions(access: RemoteDeviceAccess | null): ComputerSessions {
  return {
    sendTasks: access?.effective === "created" || access?.effective === "all",
    readSessions: access?.effective === "all" ? "all" : access?.effective === "created" ? "started_by_them" : "none",
    access,
  }
}

export function deviceInventoryStatus(row: Pick<Device, "state" | "lastSeenAt" | "platform" | "statusDetail"> & { disconnectedAt: Date | null }, kind: DeviceKind, now: number, access: RemoteDeviceAccess | null) {
  const notes: ComputerInventoryNote[] = []
  const recent = row.lastSeenAt !== null && now - row.lastSeenAt.getTime() <= REMOTE_DEVICE_ONLINE_WINDOW_MS
  let state: ComputerInventoryState
  if (kind === "desktop") {
    state = recent && !row.disconnectedAt ? "online" : "offline"
    if (row.disconnectedAt) notes.push({ code: "disconnected", message: "OpenWork was disconnected from this organization." })
    if (row.state === "setup_required") notes.push({ code: "computer_use_permissions", message: row.platform === "darwin" ? "Computer Use needs permissions on this Mac." : "Computer Use needs setup on this computer." })
  } else {
    const updating = kind === "workbot" && row.statusDetail === "Updating to a newer image"
    state = row.state === "unavailable" ? "has_a_problem"
      : recent && !updating && (row.state === "ready" || (kind === "cloud" && row.state === "setup_required")) ? "ready"
      : "starts_when_needed"
    if (state === "has_a_problem") notes.push({ code: "provider_problem", message: kind === "workbot" ? "Workbot could not reach its computer." : "This cloud computer could not be reached." })
    if (row.state === "setup_required") notes.push(kind === "workbot"
      ? { code: "update_required", message: "Workbot's computer needs to be updated." }
      : { code: "computer_use_permissions", message: "Computer Use needs setup on this cloud computer." })
  }
  if (access?.reason === "update_required") notes.push({ code: "update_required", message: "Update OpenWork on this computer to choose remote access." })
  return { status: { state, lastSeenAt: row.lastSeenAt?.toISOString() ?? null }, notes }
}
