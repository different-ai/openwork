import { workbotPersonKey } from "@openwork-ee/headless-protocol/workbot-routing"
import { RUNNER_FLEET_CELL_LIMIT, type AdminRunnerFleet, type RunnerFleetCell } from "@openwork/types/den/admin-runner-fleet"

export type IndexedConversation = {
  sessionId: string
  organizationId: string
  memberId: string | null
  kind: "workbot" | "slack" | "automation"
  updatedAt: Date
  activeTurnSince: Date | null
}

export type KnownCell = {
  kind: "conversation" | "person" | "service"
  product: "workbot" | "slack" | "automation" | null
  organizationId: string | null
  lastActiveAt: number | null
  turnRunning: boolean
}

const SESSION_ID = /^hs_[A-Za-z0-9_-]{8,96}$/
const MAIN_CHAT = "hs_wb_"
export const SERVICE_CELL = "service"

export const shortCellId = (id: string) => id.replace(/[^A-Za-z0-9]/g, "").slice(0, 12)

export function knownCellNames(rows: readonly IndexedConversation[]): Map<string, KnownCell> {
  const names = new Map<string, KnownCell>([[SERVICE_CELL, { kind: "service", product: null, organizationId: null, lastActiveAt: null, turnRunning: false }]])
  for (const row of rows) {
    if (!SESSION_ID.test(row.sessionId)) continue
    const lastActiveAt = row.updatedAt.getTime()
    const turnRunning = row.activeTurnSince !== null
    names.set(`session:${row.sessionId}`, { kind: "conversation", product: row.kind, organizationId: row.organizationId, lastActiveAt, turnRunning })
    if (row.kind !== "workbot") continue
    const person = row.sessionId.startsWith(MAIN_CHAT) ? row.sessionId.slice(MAIN_CHAT.length) : row.memberId ? workbotPersonKey(row.organizationId, row.memberId) : null
    if (!person) continue
    const name = `owner:wb:${person}`
    const known = names.get(name)
    names.set(name, {
      kind: "person", product: "workbot", organizationId: row.organizationId,
      lastActiveAt: Math.max(known?.lastActiveAt ?? 0, lastActiveAt),
      turnRunning: (known?.turnRunning ?? false) || turnRunning,
    })
  }
  return names
}

export const residentKey = (nodeId: string, cellId: string) => `${nodeId}|${cellId}`
export const RESIDENT_SEEN_LIMIT = 5_000

export function nextSeen(fleet: Pick<AdminRunnerFleet, "nodes">, previous: Readonly<Record<string, number>>, now: number, also: Readonly<Record<string, number>> = {}): Record<string, number> {
  const seen: Record<string, number> = {}
  let kept = 0
  for (const node of fleet.nodes) {
    for (const cell of node.cells.residents) {
      if (kept >= RESIDENT_SEEN_LIMIT) return seen
      const key = residentKey(node.id, cell)
      const earlier = [previous[key], also[key]].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value <= now)
      seen[key] = earlier.length > 0 ? Math.min(...earlier) : now
      kept += 1
    }
  }
  return seen
}

export function storedSeen(payload: unknown): Record<string, number> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return {}
  const record = payload as { v?: unknown; seen?: unknown }
  if (record.v !== 1 || typeof record.seen !== "object" || record.seen === null || Array.isArray(record.seen)) return {}
  const seen: Record<string, number> = {}
  for (const [key, value] of Object.entries(record.seen)) if (typeof value === "number" && Number.isFinite(value) && value > 0) seen[key] = value
  return seen
}

export type CellDirectory = {
  byId: ReadonlyMap<string, KnownCell>
  organizations: ReadonlyMap<string, string>
  error: string | null
}

export const emptyDirectory = (error: string | null): CellDirectory => ({ byId: new Map(), organizations: new Map(), error })

export function describeCells(fleet: AdminRunnerFleet, directory: CellDirectory, seen: Readonly<Record<string, number>>): AdminRunnerFleet {
  const iso = (value: number | null | undefined) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null)
  return {
    ...fleet,
    cellNamesError: directory.error,
    nodes: fleet.nodes.map((node) => ({
      ...node,
      cells: {
        ...node.cells,
        inMemory: node.cells.residents.slice(0, RUNNER_FLEET_CELL_LIMIT).map((id): RunnerFleetCell => {
          const known = directory.byId.get(id)
          const organization = known?.organizationId ? { id: known.organizationId, name: (directory.organizations.get(known.organizationId) ?? "").slice(0, 200) } : null
          return {
            id,
            since: iso(seen[residentKey(node.id, id)]),
            kind: known?.kind ?? "unknown",
            product: known?.product ?? null,
            organization,
            lastActiveAt: iso(known?.lastActiveAt),
            turnRunning: known?.turnRunning ?? false,
          }
        }),
      },
    })),
  }
}
