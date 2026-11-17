import assert from "node:assert/strict"
import { test } from "node:test"
import { adminRunnerFleetHistorySchema, adminRunnerFleetSchema } from "@openwork/types/den/admin-runner-fleet"
import { runnerFleetConfig } from "../src/runner-fleet/config.js"
import { runnerFleetEvents } from "../src/runner-fleet/events.js"
import { BUCKET_MS, emptyHour, foldFleet, historyFromHours, hourKey, mergeHours, storedHour } from "../src/runner-fleet/history.js"
import { readRunnerFleet } from "../src/runner-fleet/reader.js"
import { fleetFromNodes, nodeFromState } from "../src/runner-fleet/state.js"

/** The admin Runner fleet page's data: what a celld node reports about itself, read into nodes, a fleet and history. */

const MB = 1024 * 1024
const LIMIT = 4096 * MB
const cell = (index: number) => `HeadlessCell:${index.toString(16).padStart(4, "0")}${"ab".repeat(30)}`

/** A node's `GET /state` as celld v0.6.x writes it (crates/celld/actor.rs `state_json` and `snapshot`). */
function celldState(overrides: Record<string, unknown> = {}, load: Record<string, unknown> = {}) {
  return {
    ownership: "bucket", owned_cells: 2100, occupied: 3, quiescing: 0, evicting: 0, releasing: 0, adopting: 0, restoring: 0,
    activating: 1, activation_waiting: 2, capacity_waiting: 0, phases: { Resident: 3 }, handed_off: 40, handoff_failed: 0,
    rebalanced: 32, rebalance_failed: 0, remote_route_refreshes: 9, shedding: null,
    rss_bytes: 900 * MB, in_use_bytes: 700 * MB,
    allocator: { allocated_bytes: 500 * MB, resident_bytes: 800 * MB, mapped_bytes: 1000 * MB, retained_bytes: 120 * MB },
    libc_malloc: { in_use_bytes: 90 * MB, free_bytes: 10 * MB },
    cgroup_working_set_bytes: 820 * MB, cgroup_current_bytes: 1000 * MB,
    node_load: {
      sampled_ms: 1, owned_cells: 2100, resident_cells: 3, host_websockets: 5, rss_bytes: 900 * MB, in_use_bytes: 700 * MB,
      cpu_percent_x100: 1250, open_fds: 300, fd_limit: 65_536, pressured: false, memory_headroom: true, shed_cells: 7, restoring: 0, ...load,
    },
    residents: [cell(1), cell(2), cell(3)], published: [cell(1)], publishes: 12, stops: 4,
    deployment: {
      version: "v-2f9c1e", prefix: "fleet", generation: 3, draining: [],
      isolates: { cells: { live: 2, live_empty: 0, retiring: 1, freed: 40, heap_bytes: 300 * MB, external_bytes: 20 * MB }, stateless: { live: 1, live_empty: 0, retiring: 0, freed: 2, heap_bytes: 30 * MB, external_bytes: 1 * MB } },
      swapping: 0, cells: {},
    },
    ...overrides,
  }
}

test("a node's own report becomes the page's node", () => {
  const node = nodeFromState("10.0.0.7", celldState(), LIMIT)
  assert.equal(node.state, "open")
  // What celld weighs against its ceiling: the greater of memory in use and the cgroup working set.
  assert.equal(node.memory.usedBytes, 820 * MB)
  assert.equal(node.memory.ratio, 0.2002)
  assert.deepEqual({ retained: node.memory.retainedBytes, heap: node.memory.heapBytes, external: node.memory.externalBytes }, { retained: 120 * MB, heap: 330 * MB, external: 21 * MB })
  assert.deepEqual(node.cells, { resident: 3, owned: 2100, waitingForRoom: 0, starting: 3, residents: ["0001abababab", "0002abababab", "0003abababab"], residentsTruncated: false })
  assert.deepEqual({ sockets: node.sockets, cpu: node.cpuPercent, moved: node.moved, isolates: node.isolates, version: node.version },
    { sockets: 5, cpu: 12.5, moved: { handedOff: 40, rebalanced: 32, shed: 7 }, isolates: { live: 3, retiring: 1 }, version: "v-2f9c1e" })
})

test("celld's own flags decide whether a node is closed, whatever the memory says", () => {
  const closed = nodeFromState("a", celldState({ shedding: "memory", capacity_waiting: 4, in_use_bytes: 3500 * MB, cgroup_working_set_bytes: 3540 * MB }, { pressured: true, memory_headroom: false }), LIMIT)
  assert.deepEqual({ state: closed.state, reason: closed.shedReason, waiting: closed.cells.waitingForRoom, ratio: closed.memory.ratio }, { state: "closed", reason: "memory", waiting: 4, ratio: 0.8643 })
  assert.equal(nodeFromState("b", celldState({}, { memory_headroom: false }), LIMIT).state, "no_headroom")
  assert.equal(nodeFromState("c", celldState({}, { draining: true, pressured: true }), LIMIT).state, "draining")
  // A full-looking node that celld still calls open is open: celld knows its own ceiling.
  assert.equal(nodeFromState("d", celldState({ in_use_bytes: 3700 * MB }), LIMIT).state, "open")
  // Without a lease load (a single node without a fleet), memory against the default lines decides.
  assert.equal(nodeFromState("e", celldState({ node_load: null, in_use_bytes: 3400 * MB }), LIMIT).state, "closed")
  assert.equal(nodeFromState("f", celldState({ node_load: null, in_use_bytes: 2700 * MB, cgroup_working_set_bytes: null }), LIMIT).state, "no_headroom")
})

test("a report this does not understand is a node that did not answer, not a crash", () => {
  for (const raw of [null, "nope", [], { error: "actor_stopped" }]) assert.equal(nodeFromState("a", raw, null).state, "unreachable")
  const sparse = nodeFromState("a", {}, null)
  assert.deepEqual({ state: sparse.state, used: sparse.memory.usedBytes, ratio: sparse.memory.ratio, owned: sparse.cells.owned }, { state: "open", used: 0, ratio: null, owned: null })
  const many = nodeFromState("a", celldState({ occupied: 900, residents: Array.from({ length: 900 }, (_, index) => cell(index)) }), LIMIT)
  assert.deepEqual({ listed: many.cells.residents.length, truncated: many.cells.residentsTruncated, resident: many.cells.resident }, { listed: 600, truncated: true, resident: 900 })
})

test("the fleet takes the worst thing any node reports, fullest node first", () => {
  const open = nodeFromState("10.0.0.1", celldState(), LIMIT)
  const full = nodeFromState("10.0.0.2", celldState({ shedding: "memory", in_use_bytes: 3540 * MB }, { pressured: true }), LIMIT)
  const fleet = fleetFromNodes([open, full], new Date("2026-11-17T15:30:00.000Z"), null)
  assert.equal(fleet.status, "alert")
  assert.deepEqual(fleet.nodes.map((node) => node.id), ["10.0.0.2", "10.0.0.1"])
  assert.deepEqual(fleet.totals, { nodes: 2, reachable: 2, closed: 1, residentCells: 6, ownedCells: 4200, waitingForRoom: 0, usedBytes: (3540 + 820) * MB })
  assert.equal(adminRunnerFleetSchema.safeParse(fleet).success, true)
  assert.equal(fleetFromNodes([open, { ...open, id: "10.0.0.3" }], new Date(), null).status, "healthy")
  assert.equal(fleetFromNodes([open], new Date(), null).status, "warning")
  assert.equal(fleetFromNodes([], new Date(), "dns_failed").status, "unreachable")
})

test("every node behind the configured name is asked for its state, and only for its state", async () => {
  const asked: string[] = []
  const fleet = await readRunnerFleet({ targets: [{ host: "runner-discovery", port: 8081 }], nodeMemoryBytes: LIMIT }, {
    resolve: async (host) => (host === "runner-discovery" ? ["10.0.0.2", "10.0.0.1", "10.0.0.3", "10.0.0.4"] : []),
    now: () => new Date("2026-11-17T15:30:00.000Z"),
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      asked.push(String(url))
      assert.equal(init?.redirect, "error")
      if (String(url).includes("10.0.0.3")) throw Object.assign(new Error("timed out"), { name: "TimeoutError" })
      if (String(url).includes("10.0.0.4")) return new Response("no", { status: 503 })
      return Response.json(celldState())
    }) as typeof fetch,
  })
  assert.deepEqual(asked.sort(), ["http://10.0.0.1:8081/state", "http://10.0.0.2:8081/state", "http://10.0.0.3:8081/state", "http://10.0.0.4:8081/state"])
  assert.deepEqual(fleet.nodes.map((node) => [node.id, node.state, node.error]), [["10.0.0.1", "open", null], ["10.0.0.2", "open", null], ["10.0.0.3", "unreachable", "timeout"], ["10.0.0.4", "unreachable", "http_503"]])
  assert.equal(fleet.status, "warning")
  const none = await readRunnerFleet({ targets: [{ host: "gone", port: 8081 }], nodeMemoryBytes: null }, { resolve: async () => { throw new Error("ENOTFOUND") }, now: () => new Date(), fetch })
  assert.deepEqual({ status: none.status, error: none.discoveryError }, { status: "unreachable", error: "dns_failed" })
})

test("the setting names hosts and ports and nothing else", () => {
  assert.equal(runnerFleetConfig({}), null)
  assert.deepEqual(runnerFleetConfig({ DEN_HEADLESS_FLEET_STATE_HOST: "headless-cells-discovery" }), { targets: [{ host: "headless-cells-discovery", port: 8081 }], nodeMemoryBytes: null })
  assert.deepEqual(runnerFleetConfig({ DEN_HEADLESS_FLEET_STATE_HOST: " a.internal:9000, 127.0.0.1 ", DEN_HEADLESS_FLEET_STATE_PORT: "8082", DEN_HEADLESS_FLEET_NODE_MEMORY_MB: "4096" }),
    { targets: [{ host: "a.internal", port: 9000 }, { host: "127.0.0.1", port: 8082 }], nodeMemoryBytes: LIMIT })
  for (const host of ["http://runner", "runner/state", "user@runner", "runner:80:90", "runner:99999", "runner:port", "-runner", "run ner"]) {
    assert.equal(runnerFleetConfig({ DEN_HEADLESS_FLEET_STATE_HOST: host }), null, host)
  }
  assert.equal(runnerFleetConfig({ DEN_HEADLESS_FLEET_STATE_HOST: "runner", DEN_HEADLESS_FLEET_STATE_PORT: "0" }), null)
})

test("history keeps the worst reading of each node in each ten minutes", () => {
  const at = Date.parse("2026-11-17T15:32:10.000Z")
  const fleetAt = (megabytes: number, closed: boolean) => fleetFromNodes([
    nodeFromState("10.0.0.1", celldState({ in_use_bytes: megabytes * MB, cgroup_working_set_bytes: null, shedding: closed ? "memory" : null }, { pressured: closed }), LIMIT),
  ], new Date(at), null)
  let hour = foldFleet(emptyHour(), fleetAt(3300, true), at)
  hour = foldFleet(hour, fleetAt(1200, false), at + 60_000)
  hour = foldFleet(hour, fleetAt(900, false), at + BUCKET_MS)
  assert.equal(hourKey(at), "2026-11-17T15")
  assert.deepEqual(Object.keys(hour.nodes["10.0.0.1"] ?? {}), ["3", "4"])
  assert.deepEqual(hour.nodes["10.0.0.1"]?.["3"], { u: 3300 * MB, r: 0.8057, c: 3, o: 2100, w: 0, x: 1, d: 0 })
  // What another replica wrote for the same hour is merged, not replaced.
  const merged = mergeHours(storedHour(JSON.stringify({ v: 1, nodes: { "10.0.0.1": { "3": { u: 10, r: 0.1, c: 9, o: null, w: 2, x: 0, d: 1 } }, "10.0.0.9": { "0": { u: 5, c: 1 } } } })), hour)
  assert.deepEqual(merged.nodes["10.0.0.1"]?.["3"], { u: 3300 * MB, r: 0.8057, c: 9, o: 2100, w: 2, x: 1, d: 1 })
  assert.deepEqual(merged.nodes["10.0.0.9"]?.["0"], { u: 5, r: null, c: 1, o: null, w: 0, x: 0, d: 0 })
  assert.deepEqual(storedHour("not json"), emptyHour())
  assert.deepEqual(storedHour({ nodes: { a: { "9": { u: 1, c: 1 } } } }), emptyHour())
})

test("a day reads as ten-minute squares and longer ranges as one square an hour", () => {
  const now = Date.parse("2026-11-17T15:45:00.000Z")
  const rows = [
    { hour: "2026-11-17T15", payload: { v: 1, nodes: { a: { "3": { u: 300, r: 0.3, c: 3, o: 9, w: 0, x: 0, d: 0 }, "4": { u: 900, r: 0.9, c: 4, o: 9, w: 5, x: 1, d: 0 } } } } },
    { hour: "2026-11-17T14", payload: JSON.stringify({ v: 1, nodes: { a: { "0": { u: 100, r: 0.1, c: 1, o: 9, w: 0, x: 0, d: 0 } }, b: { "5": { u: 50, r: null, c: 2, o: null, w: 0, x: 0, d: 1 } } } }) },
    { hour: "2026-11-01T00", payload: { v: 1, nodes: { old: { "0": { u: 1, c: 1 } } } } },
  ]
  const day = historyFromHours(rows, "24h", now)
  assert.equal(adminRunnerFleetHistorySchema.safeParse(day).success, true)
  assert.deepEqual({ bucketMinutes: day.bucketMinutes, from: day.from, nodes: day.nodes.map((node) => node.id) }, { bucketMinutes: 10, from: "2026-11-16T16:00:00.000Z", nodes: ["a", "b"] })
  assert.deepEqual(day.nodes[0]?.buckets.map((bucket) => [new Date(bucket.at).toISOString().slice(11, 16), bucket.usedBytes, bucket.closed]), [["14:00", 100, false], ["15:30", 300, false], ["15:40", 900, true]])
  const week = historyFromHours(rows, "7d", now)
  assert.equal(week.bucketMinutes, 60)
  assert.deepEqual(week.nodes[0]?.buckets.map((bucket) => [new Date(bucket.at).toISOString().slice(11, 16), bucket.usedBytes, bucket.waitingForRoom, bucket.closed]), [["14:00", 100, 0, false], ["15:00", 900, 5, true]])
  assert.deepEqual(historyFromHours(rows, "30d", now).nodes.map((node) => node.id), ["a", "b", "old"])
})

test("the live stream sends the fleet on connect and again each interval, then ends itself", async () => {
  const timers: Array<() => void> = []
  let now = 0
  let reads = 0
  let closed = 0
  const fleet = fleetFromNodes([nodeFromState("10.0.0.1", celldState(), LIMIT)], new Date(0), null)
  const response = runnerFleetEvents({
    request: new Request("http://den.test/v1/admin/runner-fleet/events"),
    read: async () => { reads += 1; if (reads === 2) throw new Error("nodes unreachable"); return fleet },
    intervalMs: 5_000, maxAgeMs: 12_000,
    clock: { now: () => now, schedule: (callback) => { timers.push(callback); return () => undefined } },
    onClose: () => { closed += 1 },
  })
  assert.equal(response.headers.get("content-type"), "text/event-stream")
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const next = async () => decoder.decode((await reader.read()).value)
  assert.equal(await next(), "retry: 3000\n\n")
  const first = await next()
  assert.match(first, /^event: fleet\ndata: \{"status":"warning"/)
  assert.deepEqual(JSON.parse(first.slice(first.indexOf("data: ") + 6)), fleet)
  now = 5_000
  timers.shift()?.()
  assert.equal(await next(), "event: unavailable\ndata: {}\n\n")
  now = 12_000
  timers.shift()?.()
  assert.match(await next(), /^event: fleet/)
  assert.equal(await next(), "event: end\ndata: {}\n\n")
  assert.equal((await reader.read()).done, true)
  assert.deepEqual({ reads, closed }, { reads: 3, closed: 1 })
})
