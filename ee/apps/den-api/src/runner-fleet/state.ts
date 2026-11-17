import {
  RUNNER_FLEET_CLOSE_RATIO,
  RUNNER_FLEET_REOPEN_RATIO,
  RUNNER_FLEET_RESIDENT_LIMIT,
  type AdminRunnerFleet,
  type RunnerFleetNode,
  type RunnerFleetNodeState,
  type RunnerFleetStatus,
} from "@openwork/types/den/admin-runner-fleet"

/**
 * Reads what a celld node reports about itself (`GET /state`, celld v0.6.x) into the page's node. Every field is
 * optional here: celld adds and renames fields between releases, and a field this does not find reads as absent, never
 * as a failure of the whole node.
 *
 * The fields used: `occupied`, `owned_cells`, `capacity_waiting`, `activating`, `activation_waiting`, `shedding`,
 * `rss_bytes`, `in_use_bytes`, `cgroup_working_set_bytes`, `handed_off`, `rebalanced`, `allocator.retained_bytes`,
 * `residents`, `node_load` (the node's lease load block: `pressured`, `memory_headroom`, `draining`,
 * `host_websockets`, `cpu_percent_x100`, `shed_cells`) and `deployment` (`version`, `isolates`).
 */

type Fields = Record<string, unknown>
const fields = (value: unknown): Fields | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : null)
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER) : null)
const text = (value: unknown, max: number): string | null => (typeof value === "string" && value.length > 0 ? value.slice(0, max) : null)

/** `HeadlessCell:<64 hex>` to the first 12 characters of its id: enough to tell cells apart, and opaque. */
function shortCell(value: unknown): string | null {
  if (typeof value !== "string") return null
  const id = value.slice(value.lastIndexOf(":") + 1).replace(/[^A-Za-z0-9]/g, "")
  return id ? id.slice(0, 12) : null
}

/** Adds up a counter across celld's isolate pools (`cells`, `stateless`, `services`), whatever pools there are. */
function acrossPools(isolates: Fields | null, key: string): number | null {
  if (!isolates) return null
  const direct = count(isolates[key])
  if (direct !== null) return direct
  let total: number | null = null
  for (const pool of Object.values(isolates)) {
    const value = count(fields(pool)?.[key])
    if (value !== null) total = (total ?? 0) + value
  }
  return total
}

export function unreachableNode(id: string, error: string, limitBytes: number | null): RunnerFleetNode {
  return {
    id, state: "unreachable", error: error.slice(0, 40), shedReason: null,
    memory: { usedBytes: 0, limitBytes, ratio: null, residentBytes: 0, inUseBytes: 0, workingSetBytes: null, retainedBytes: null, heapBytes: null, externalBytes: null },
    cells: { resident: 0, owned: null, waitingForRoom: 0, starting: 0, residents: [], residentsTruncated: false },
    sockets: 0, cpuPercent: null, moved: { handedOff: 0, rebalanced: 0, shed: 0 }, isolates: null, version: null,
  }
}

export function nodeFromState(id: string, raw: unknown, limitBytes: number | null): RunnerFleetNode {
  const state = fields(raw)
  // celld answers `{"error":"actor_stopped"}` while it is going down.
  if (!state || typeof state.error === "string") return unreachableNode(id, "invalid_state", limitBytes)
  const load = fields(state.node_load)
  const deployment = fields(state.deployment)
  const isolates = fields(deployment?.isolates)

  const residentBytes = count(state.rss_bytes) ?? count(load?.rss_bytes) ?? 0
  const inUseBytes = count(state.in_use_bytes) ?? count(load?.in_use_bytes) ?? residentBytes
  const workingSetBytes = count(state.cgroup_working_set_bytes) ?? count(load?.cgroup_working_set_bytes)
  const usedBytes = Math.max(inUseBytes, workingSetBytes ?? 0)
  const ratio = limitBytes ? Math.round((usedBytes / limitBytes) * 10_000) / 10_000 : null

  const listed = Array.isArray(state.residents) ? state.residents : []
  const residents = listed.slice(0, RUNNER_FLEET_RESIDENT_LIMIT).flatMap((cell) => shortCell(cell) ?? [])
  const resident = count(state.occupied) ?? count(load?.resident_cells) ?? listed.length

  const shedReason = text(state.shedding, 40)
  const closed = shedReason !== null || load?.pressured === true
  // celld's own flags decide. Only a node that reports none of them (no lease load) is judged by its memory.
  const flagged = load !== null && (typeof load.pressured === "boolean" || typeof load.memory_headroom === "boolean")
  const nodeState: RunnerFleetNodeState = load?.draining === true ? "draining"
    : closed ? "closed"
    : load?.memory_headroom === false ? "no_headroom"
    : !flagged && ratio !== null && ratio >= RUNNER_FLEET_CLOSE_RATIO ? "closed"
    : !flagged && ratio !== null && ratio >= RUNNER_FLEET_REOPEN_RATIO ? "no_headroom"
    : "open"

  const cpu = count(load?.cpu_percent_x100)
  const live = acrossPools(isolates, "live")
  const retiring = acrossPools(isolates, "retiring")
  return {
    id, state: nodeState, error: null, shedReason,
    memory: {
      usedBytes, limitBytes, ratio, residentBytes, inUseBytes, workingSetBytes,
      retainedBytes: count(fields(state.allocator)?.retained_bytes),
      heapBytes: acrossPools(isolates, "heap_bytes"),
      externalBytes: acrossPools(isolates, "external_bytes"),
    },
    cells: {
      resident,
      owned: count(state.owned_cells) ?? count(load?.owned_cells),
      waitingForRoom: count(state.capacity_waiting) ?? 0,
      starting: (count(state.activating) ?? 0) + (count(state.activation_waiting) ?? 0),
      residents,
      residentsTruncated: listed.length > residents.length || resident > residents.length,
    },
    sockets: count(load?.host_websockets) ?? 0,
    cpuPercent: cpu === null ? null : cpu / 100,
    moved: { handedOff: count(state.handed_off) ?? 0, rebalanced: count(state.rebalanced) ?? 0, shed: count(load?.shed_cells) ?? 0 },
    isolates: live === null && retiring === null ? null : { live: live ?? 0, retiring: retiring ?? 0 },
    version: text(deployment?.version, 80),
  }
}

/** The fleet's state from its nodes: the worst thing any node reports. */
export function fleetStatus(nodes: readonly RunnerFleetNode[]): RunnerFleetStatus {
  const reachable = nodes.filter((node) => node.state !== "unreachable")
  if (reachable.length === 0) return "unreachable"
  if (reachable.some((node) => node.state === "closed" || node.cells.waitingForRoom > 0)) return "alert"
  // One node is a warning, not an alert: small deployments run that way on purpose.
  if (reachable.length < nodes.length || reachable.length === 1 || reachable.some((node) => node.state === "no_headroom")) return "warning"
  return "healthy"
}

export function fleetFromNodes(nodes: RunnerFleetNode[], now: Date, discoveryError: string | null): AdminRunnerFleet {
  // Fullest first: the node to look at is the one nearest its ceiling.
  const sorted = [...nodes].sort((a, b) => Number(a.state === "unreachable") - Number(b.state === "unreachable") || b.memory.usedBytes - a.memory.usedBytes || a.id.localeCompare(b.id))
  const reachable = sorted.filter((node) => node.state !== "unreachable")
  const owned = reachable.map((node) => node.cells.owned)
  return {
    status: sorted.length === 0 ? "unreachable" : fleetStatus(sorted),
    generatedAt: now.toISOString(),
    nodes: sorted,
    totals: {
      nodes: sorted.length,
      reachable: reachable.length,
      closed: reachable.filter((node) => node.state === "closed").length,
      residentCells: reachable.reduce((sum, node) => sum + node.cells.resident, 0),
      ownedCells: owned.length > 0 && owned.every((value): value is number => value !== null) ? owned.reduce((sum, value) => sum + value, 0) : null,
      waitingForRoom: reachable.reduce((sum, node) => sum + node.cells.waitingForRoom, 0),
      usedBytes: reachable.reduce((sum, node) => sum + node.memory.usedBytes, 0),
    },
    discoveryError,
  }
}

export function notConfiguredFleet(now: Date): AdminRunnerFleet {
  return {
    status: "not_configured", generatedAt: now.toISOString(), nodes: [],
    totals: { nodes: 0, reachable: 0, closed: 0, residentCells: 0, ownedCells: null, waitingForRoom: 0, usedBytes: 0 },
    discoveryError: null,
  }
}
