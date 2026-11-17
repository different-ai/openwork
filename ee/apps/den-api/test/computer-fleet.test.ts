import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { adminComputerDetailSchema, adminComputerFleetHistorySchema, adminComputerFleetSchema, COMPUTER_FLEET_LIST_LIMIT } from "@openwork/types/den/admin-computer-fleet"
import { runnerComputerFleetSchema, type RunnerComputer, type RunnerComputerDetail, type RunnerComputerFleet, type RunnerComputerSource } from "../src/headless-runner/client.js"
import { BUCKET_MS, emptyHour, foldFleet, historyFromHours, hourKey, mergeHours, storedHour } from "../src/computer-fleet/history.js"
import { readComputerDetail, readComputerFleet } from "../src/computer-fleet/reader.js"
import { computerDetailFrom, computerFleetFrom, computerKey, type ComputerConversation, type ComputerOwner, type ComputerReports } from "../src/computer-fleet/state.js"

/** The admin Computer fleet page's data: the runner's list of its computers, read into one fleet and its history. */

const NOW = new Date("2026-11-17T22:00:00.000Z")
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString()

/** A computer as the runner lists it (`GET /v1/computers`), in the provider's own words. */
const computer = (id: string, extra: Partial<RunnerComputer> = {}): RunnerComputer => ({
  id, key: `hc-${id}`, source: "gateway", provider: "differently", status: "running", statusReason: null, pool: "opensandbox-microvm", backend: "opensandbox", region: "eastus",
  cpu: 2, memoryMb: 4096, diskGb: 8, createdAt: ago(600), updatedAt: ago(30), startedAt: ago(599), pausedAt: null, lastActivityAt: ago(1), expiresAt: null, endedAt: null, attempts: 1,
  image: "workbot-computer", imageCurrent: true, idleTimeoutSeconds: null, idledAt: null, resumeRequestedAt: null, slotReleased: null, trust: "private",
  ...extra,
})
/** The runner pauses a computer five minutes after its last use, and keeps it two weeks. */
const settings = { image: "workbot-computer", idlePauseSeconds: 300, keepDays: 14, persistent: false }
const gateway = (extra: Partial<RunnerComputerSource> = {}): RunnerComputerSource => ({
  source: "gateway", provider: "differently", status: "ok", error: null, truncated: false,
  pools: [{ name: "opensandbox-microvm", backend: "opensandbox", region: "eastus", enabled: true, health: "healthy" }], settings, ...extra,
})
const direct = (extra: Partial<RunnerComputerSource> = {}): RunnerComputerSource => ({ source: "direct", provider: "freestyle", status: "ok", error: null, truncated: false, pools: [], settings: { ...settings, image: "workbot-desktop-freestyle-aaaa-bbbb" }, ...extra })
const listed = (sandboxes: RunnerComputer[], sources: RunnerComputerSource[] = [gateway(), direct()]): RunnerComputerFleet => ({ version: 1, generatedAt: NOW.toISOString(), sources, sandboxes })
const noOwners = new Map<string, ComputerOwner>()

test("every provider's words become one set of states, with totals", () => {
  const fleet = computerFleetFrom(listed([
    computer("a", { status: "running" }),
    computer("b", { status: "paused", pausedAt: ago(90), lastActivityAt: ago(120) }),
    computer("c", { status: "provisioning", updatedAt: ago(2), lastActivityAt: ago(2) }),
    computer("d", { status: "stopped" }),
    computer("e", { source: "direct", provider: "freestyle", status: "starting", pool: null, backend: null, region: null, updatedAt: ago(1) }),
    computer("f", { source: "direct", provider: "freestyle", status: "pausing", pool: null, backend: null, region: null, updatedAt: ago(3) }),
    computer("g", { status: "something-new" }),
  ]), noOwners, NOW)
  assert.equal(adminComputerFleetSchema.safeParse(fleet).success, true)
  assert.equal(fleet.status, "healthy")
  assert.deepEqual(fleet.totals, { total: 7, running: 1, starting: 2, pausing: 1, paused: 1, stopped: 1, stopping: 0, failed: 0, attention: 0 })
  assert.deepEqual(Object.fromEntries(fleet.sandboxes.map((sandbox) => [sandbox.id, sandbox.state])), { a: "running", b: "paused", c: "starting", d: "stopped", e: "starting", f: "pausing", g: "unknown" })
  // The busiest states first, then the idle ones; within a state, the most recently active.
  assert.deepEqual(fleet.sandboxes.map((sandbox) => sandbox.id), ["e", "c", "f", "a", "g", "b", "d"])
  assert.deepEqual(fleet.sources.map((source) => [source.source, source.counts]), [["gateway", { total: 5, running: 1, paused: 1, attention: 0 }], ["direct", { total: 2, running: 0, paused: 0, attention: 0 }]])
  // Provider times of any precision come out as plain ISO moments.
  const precise = computerFleetFrom(listed([computer("p", { createdAt: "2026-10-29T22:36:41.964991831Z", expiresAt: "not a time" })]), noOwners, NOW).sandboxes[0]
  assert.equal(precise?.createdAt, "2026-10-29T22:36:41.964Z")
  assert.equal(precise?.expiresAt, null)
})

test("a computer stuck in a step, failed in the last day or past its expiry needs a look, and is listed first", () => {
  const fleet = computerFleetFrom(listed([
    computer("fine"),
    computer("starting-long", { status: "queued", updatedAt: ago(11), lastActivityAt: ago(11) }),
    computer("pausing-long", { status: "pausing", updatedAt: ago(16), lastActivityAt: ago(40) }),
    // A pause that began a minute ago on a computer idle for an hour is not stuck: the step is timed from its start.
    computer("pausing-now", { status: "pausing", updatedAt: ago(1), lastActivityAt: ago(60) }),
    computer("stopping-long", { status: "terminating", updatedAt: ago(20) }),
    computer("failed-today", { status: "failed", statusReason: "backend rejected the sandbox", startedAt: null, endedAt: ago(30) }),
    computer("failed-last-month", { status: "failed", statusReason: "old news", startedAt: null, endedAt: ago(60 * 24 * 19) }),
    computer("expired", { status: "paused", expiresAt: ago(30) }),
  ]), noOwners, NOW)
  const attention = Object.fromEntries(fleet.sandboxes.map((sandbox) => [sandbox.id, sandbox.attention]))
  assert.deepEqual(attention, {
    "failed-today": "failed", "starting-long": "stuck_starting", "pausing-long": "stuck_pausing", "stopping-long": "stuck_stopping", expired: "expired", "pausing-now": null, fine: null,
  })
  assert.equal("failed-last-month" in attention, false, "a failure older than a day is history, not shown or counted")
  assert.deepEqual(fleet.sandboxes.slice(0, 5).map((sandbox) => sandbox.attention !== null), [true, true, true, true, true])
  assert.equal(fleet.totals.attention, 5)
  assert.equal(fleet.totals.failed, 1)
  assert.equal(fleet.status, "alert", "a stuck computer is an alert")
  assert.equal(fleet.sandboxes.find((sandbox) => sandbox.id === "failed-today")?.statusReason, "backend rejected the sandbox")
  // Failures alone are a warning: they are over, nothing is stuck.
  assert.equal(computerFleetFrom(listed([computer("fine"), computer("failed-today", { status: "failed", endedAt: ago(30) })]), noOwners, NOW).status, "warning")
})

test("the overall status follows the providers and their pools", () => {
  const one = [computer("a")]
  assert.equal(computerFleetFrom(listed(one, [gateway({ status: "unreachable", error: "http_503" }), direct()]), noOwners, NOW).status, "alert", "one provider down")
  assert.equal(computerFleetFrom(listed([], [gateway({ status: "unreachable", error: "timeout" }), direct({ status: "unreachable", error: "http_401" })]), noOwners, NOW).status, "unreachable", "every provider down")
  assert.equal(computerFleetFrom(listed(one, [gateway({ pools: [{ name: "microvm", backend: "opensandbox", region: null, enabled: true, health: "degraded" }] })]), noOwners, NOW).status, "alert", "an enabled pool is not healthy")
  assert.equal(computerFleetFrom(listed(one, [gateway({ pools: [{ name: "spare", backend: "e2b", region: null, enabled: false, health: "unhealthy" }] })]), noOwners, NOW).status, "healthy", "a pool that is switched off does not count")
  assert.equal(computerFleetFrom(listed(one, [gateway({ truncated: true })]), noOwners, NOW).status, "warning")
  assert.equal(computerFleetFrom(listed([], []), noOwners, NOW).status, "not_configured", "a runner with no computers")
  assert.equal(computerFleetFrom(listed([], [direct({ provider: "daytona", status: "unsupported" })]), noOwners, NOW).status, "healthy")
})

test("a long fleet is cut to the list limit, keeping what needs a look, and the totals still count everything", () => {
  const many = [
    ...Array.from({ length: COMPUTER_FLEET_LIST_LIMIT + 40 }, (_, index) => computer(`paused-${index}`, { status: "paused" })),
    computer("failed", { status: "failed", endedAt: ago(5) }),
  ]
  const fleet = computerFleetFrom(listed(many), noOwners, NOW)
  assert.equal(fleet.sandboxes.length, COMPUTER_FLEET_LIST_LIMIT)
  assert.equal(fleet.listTruncated, true)
  assert.equal(fleet.sandboxes[0]?.id, "failed")
  assert.equal(fleet.totals.total, COMPUTER_FLEET_LIST_LIMIT + 41)
  assert.equal(adminComputerFleetSchema.safeParse(fleet).success, true)
})

test("a computer is tied to its organization by the key its conversation's session id gives", async () => {
  const session = "hs_c_0123456789abcdef0123456789abcdef"
  assert.match(computerKey(session), /^hc-[0-9a-f]{40}$/)
  // The same key the runner gives the sandbox (Computers.slug): `hc-` and the first 40 hex digits of the id's SHA-256.
  assert.equal(computerKey(session), `hc-${createHash("sha256").update(session).digest("hex").slice(0, 40)}`)
  const owners = new Map([[computerKey(session), { id: "org_1", name: "Acme" }]])
  const asked: string[][] = []
  const fleet = await readComputerFleet({
    client: { listComputers: async () => ({ ok: true, value: listed([computer("mine", { key: computerKey(session) }), computer("unknown", { key: "hc-nobody" }), computer("keyless", { key: null })]) }) },
    owners: async (keys) => { asked.push([...keys]); return owners },
    now: () => NOW,
  })
  assert.deepEqual(asked, [[computerKey(session), "hc-nobody"]])
  assert.deepEqual(Object.fromEntries(fleet.sandboxes.map((sandbox) => [sandbox.id, sandbox.organization])), { mine: { id: "org_1", name: "Acme" }, unknown: null, keyless: null })
})

test("without a runner, with an old runner, or without names, the page still gets an answer", async () => {
  const none = await readComputerFleet({ client: null, owners: async () => noOwners, now: () => NOW })
  assert.equal(none.status, "not_configured")
  assert.equal(adminComputerFleetSchema.safeParse(none).success, true)
  // A runner from before it could list computers answers 404.
  const old = await readComputerFleet({ client: { listComputers: async () => ({ ok: false, status: 404, error: "http_404" }) }, owners: async () => noOwners, now: () => NOW })
  assert.deepEqual([old.status, old.runnerError, old.sandboxes.length], ["unreachable", "http_404", 0])
  assert.equal(adminComputerFleetSchema.safeParse(old).success, true)
  // The tables that name organizations failing leaves the computers listed, unnamed.
  const unnamed = await readComputerFleet({ client: { listComputers: async () => ({ ok: true, value: listed([computer("a")]) }) }, owners: async () => { throw new Error("database down") }, now: () => NOW })
  assert.deepEqual([unnamed.status, unnamed.sandboxes.length, unnamed.sandboxes[0]?.organization], ["healthy", 1, null])
})

test("history keeps the highest counts of each 10 minutes, and merges what two replicas wrote", () => {
  const at = Date.parse("2026-11-17T15:04:00.000Z")
  const quiet = computerFleetFrom(listed([computer("a"), computer("b", { status: "paused" })]), noOwners, NOW)
  const busy = computerFleetFrom(listed([computer("a"), computer("b"), computer("c"), computer("d", { status: "failed", endedAt: ago(5) })], [gateway({ status: "unreachable", error: "timeout" }), direct()]), noOwners, NOW)
  assert.equal(hourKey(at), "2026-11-17T15")
  let hour = foldFleet(emptyHour(), quiet, at)
  hour = foldFleet(hour, busy, at + 3 * 60_000)
  hour = foldFleet(hour, quiet, at + BUCKET_MS)
  assert.deepEqual(hour.buckets, {
    "0": { t: 4, r: 3, p: 1, s: 0, f: 1, a: 1, d: 1 },
    "1": { t: 2, r: 1, p: 1, s: 0, f: 0, a: 0, d: 0 },
  })
  const other = foldFleet(emptyHour(), busy, at + BUCKET_MS)
  assert.deepEqual(mergeHours(hour, other).buckets["1"], { t: 4, r: 3, p: 1, s: 0, f: 1, a: 1, d: 1 })
  assert.deepEqual(storedHour(JSON.stringify(hour)), hour, "what is stored reads back")
  assert.deepEqual(storedHour({ nodes: {} }), emptyHour(), "another metric's document is not this one's")
  assert.deepEqual(storedHour("{broken"), emptyHour())

  const now = Date.parse("2026-11-17T15:30:00.000Z")
  const day = historyFromHours([{ hour: "2026-11-17T15", payload: hour }, { hour: "2026-11-10T15", payload: hour }], "24h", now)
  assert.equal(adminComputerFleetHistorySchema.safeParse(day).success, true)
  assert.deepEqual(day.buckets.map((bucket) => [new Date(bucket.at).toISOString().slice(11, 16), bucket.total, bucket.running, bucket.sourceDown]), [["15:00", 4, 3, true], ["15:10", 2, 1, false]])
  const week = historyFromHours([{ hour: "2026-11-17T15", payload: hour }, { hour: "2026-11-10T15", payload: hour }, { hour: "2026-11-11T09", payload: hour }], "7d", now)
  assert.equal(week.bucketMinutes, 60)
  assert.deepEqual(week.buckets.map((bucket) => [new Date(bucket.at).toISOString().slice(0, 13), bucket.total, bucket.failed]), [["2026-11-11T09", 4, 1], ["2026-11-17T15", 4, 1]], "one square an hour, the range's hours only")
})

test("a computer left running with nothing using it is flagged, once the runner and its provider have had their time", () => {
  const vm = { source: "direct" as const, provider: "freestyle", pool: null, backend: null, region: null }
  const fleet = computerFleetFrom(listed([
    computer("used", { lastActivityAt: ago(4) }),
    // The runner pauses after 5 minutes: 31 minutes unused is held by something.
    computer("left", { lastActivityAt: ago(31), updatedAt: ago(400) }),
    // Resumed a minute ago; the activity it reports is from before it slept.
    computer("woken", { lastActivityAt: ago(300), updatedAt: ago(1) }),
    // This provider stops idle computers itself after an hour: it gets that hour, and a quarter more.
    computer("waiting", { ...vm, idleTimeoutSeconds: 3600, lastActivityAt: ago(70), updatedAt: ago(400) }),
    computer("overdue", { ...vm, idleTimeoutSeconds: 3600, lastActivityAt: ago(80), updatedAt: ago(400) }),
    // A provider that reports no activity is never guessed at, and a paused computer is where it should be.
    computer("silent", { ...vm, lastActivityAt: null, updatedAt: ago(400) }),
    computer("asleep", { status: "paused", lastActivityAt: ago(900), updatedAt: ago(890) }),
  ]), noOwners, NOW)
  assert.deepEqual(Object.fromEntries(fleet.sandboxes.map((sandbox) => [sandbox.id, sandbox.attention])), { left: "idle_running", overdue: "idle_running", used: null, woken: null, waiting: null, silent: null, asleep: null })
  // Worth a look, not an outage.
  assert.deepEqual([fleet.status, fleet.totals.attention, fleet.attentionCounts], ["warning", 2, { failed: 0, stuck_starting: 0, stuck_pausing: 0, stuck_stopping: 0, expired: 0, idle_running: 2 }])
  // A slower runner (20 minutes before it pauses) gives a computer three of its waits.
  const slow = computerFleetFrom(listed([computer("a", { lastActivityAt: ago(45), updatedAt: ago(400) }), computer("b", { lastActivityAt: ago(61), updatedAt: ago(400) })], [gateway({ settings: { ...settings, idlePauseSeconds: 1200 } })]), noOwners, NOW)
  assert.deepEqual(slow.sandboxes.map((sandbox) => [sandbox.id, sandbox.attention]), [["b", "idle_running"], ["a", null]])
})

test("the list can be narrowed to one organization, and the page is told which organizations have computers", () => {
  const owners = new Map<string, ComputerOwner>([["hc-a", { id: "org_acme", name: "Acme" }], ["hc-b", { id: "org_acme", name: "Acme" }], ["hc-c", { id: "org_north", name: "Northwind" }]])
  const list = listed([computer("a"), computer("b", { status: "paused" }), computer("c", { status: "failed", updatedAt: ago(5), endedAt: ago(5) }), computer("d"), computer("e", { key: null })])
  const all = computerFleetFrom(list, owners, NOW)
  assert.deepEqual(all.organizations, [{ id: "org_acme", name: "Acme", computers: 2 }, { id: "org_north", name: "Northwind", computers: 1 }])
  assert.deepEqual([all.unknownOrganization, all.sandboxes.length], [2, 5])
  const acme = computerFleetFrom(list, owners, NOW, "org_acme")
  assert.deepEqual(acme.sandboxes.map((sandbox) => sandbox.id).sort(), ["a", "b"])
  // What is wrong with the fleet does not depend on which organization is being looked at.
  assert.deepEqual([acme.status, acme.totals, acme.attentionCounts, acme.organizations, acme.sources.map((source) => source.counts.total)], [all.status, all.totals, all.attentionCounts, all.organizations, all.sources.map((source) => source.counts.total)])
  assert.equal(all.attentionCounts?.failed, 1)
  assert.deepEqual(computerFleetFrom(list, owners, NOW, "unknown").sandboxes.map((sandbox) => sandbox.id).sort(), ["d", "e"])
  assert.deepEqual(computerFleetFrom(list, owners, NOW, "org_gone").sandboxes, [])
  assert.equal(adminComputerFleetSchema.safeParse(acme).success, true)
})

test("each computer says what it was built from, and a runner from before that still reads", () => {
  const fleet = computerFleetFrom(listed([computer("a"), computer("b", { image: "workbot-computer-old", imageCurrent: false }), computer("c", { image: null, imageCurrent: null })]), noOwners, NOW)
  assert.deepEqual(fleet.sandboxes.map((sandbox) => [sandbox.id, sandbox.image, sandbox.imageCurrent]).sort(), [["a", "workbot-computer", true], ["b", "workbot-computer-old", false], ["c", null, null]])
  assert.deepEqual(fleet.sources.map((source) => source.settings?.idlePauseSeconds), [300, 300])
  // What the first runner with a list sent: no image, no settings. It parses, and reads as "not known".
  const { image: _image, imageCurrent: _current, idleTimeoutSeconds: _idle, idledAt: _idled, resumeRequestedAt: _resume, slotReleased: _slot, trust: _trust, ...older } = computer("a")
  const { settings: _settings, ...olderSource } = gateway()
  const parsed = runnerComputerFleetSchema.parse({ version: 1, generatedAt: NOW.toISOString(), sources: [olderSource], sandboxes: [older] })
  const read = computerFleetFrom(parsed, noOwners, NOW)
  assert.deepEqual([read.sandboxes[0]?.image, read.sandboxes[0]?.imageCurrent, read.sources[0]?.settings], [null, null, null])
  assert.equal(adminComputerFleetSchema.safeParse(read).success, true)
})

const runnerDetail = (extra: Partial<RunnerComputerDetail> = {}): RunnerComputerDetail => ({
  version: 1, generatedAt: NOW.toISOString(),
  computer: computer("sbx_1", { idleTimeoutSeconds: null, lastActivityAt: ago(2) }),
  limits: { profile: "desktop", classification: "internal", capabilities: ["exec", "pause"], preemptible: false, ttlSeconds: 1_209_600, maxRunSeconds: null, maxPausedSeconds: null, autoDeleteSeconds: null, totalRunSeconds: null },
  settings,
  placement: { pool: "opensandbox-microvm", strategy: "private-first", outcome: "placed", reason: "selected opensandbox-microvm by private-first strategy", evaluatedAt: ago(600), policies: ["global"], candidates: [{ pool: "opensandbox-microvm", trust: "private", eligible: true, hasCapacity: true, rank: 1, reasons: [] }, { pool: "freestyle", trust: "external", eligible: false, hasCapacity: true, rank: null, reasons: ["policy keeps this classification on private pools"] }] },
  events: [{ at: ago(3), action: "woke", outcome: "success", details: { pool: "opensandbox-microvm", after: "exec" } }, { at: ago(50), action: "idled", outcome: "success", details: { action: "pause", pool: "opensandbox-microvm" } }, { at: ago(599), action: "provision_retry", outcome: "failure", details: { error: "no host with room" } }],
  eventsError: null,
  ...extra,
})
const conversation: ComputerConversation = { sessionId: "hs_workbot_member_1", chat: "main", member: { id: "mem_1", name: "Dana Reyes", email: "dana@acme.test" }, createdAt: new Date(ago(6000)), lastActiveAt: new Date(ago(2)), activeTurnSince: new Date(ago(2)) }
const reports: ComputerReports = {
  reported: { state: "ready", detail: null, at: new Date(ago(3)) },
  events: [{ at: new Date(ago(4)), type: "viewer_opened", level: "info", message: "Opened the Computer view" }, { at: new Date(ago(49)), type: "paused", level: "info", message: "Paused" }],
}

test("one computer in full: its provider's record, whose it is, and one timeline of what happened to it", () => {
  const detail = computerDetailFrom(runnerDetail(), { id: "org_acme", name: "Acme" }, conversation, reports, NOW)
  assert.equal(adminComputerDetailSchema.safeParse(detail).success, true)
  assert.deepEqual([detail.computer.id, detail.computer.state, detail.computer.organization, detail.key, detail.trust, detail.attempts], ["sbx_1", "running", { id: "org_acme", name: "Acme" }, "hc-sbx_1", "private", 1])
  assert.deepEqual(detail.limits, { idleTimeoutSeconds: null, ttlSeconds: 1_209_600, maxRunSeconds: null, maxPausedSeconds: null, autoDeleteSeconds: null, totalRunSeconds: null })
  assert.deepEqual([detail.settings?.idlePauseSeconds, detail.placement?.pool, detail.placement?.candidates.length, detail.providerEventsError], [300, "opensandbox-microvm", 2, null])
  assert.deepEqual(detail.conversation, { sessionId: "hs_workbot_member_1", chat: "main", member: { id: "mem_1", name: "Dana Reyes", email: "dana@acme.test" }, createdAt: ago(6000), lastActiveAt: ago(2), activeTurnSince: ago(2) })
  assert.deepEqual(detail.reported, { state: "ready", detail: null, at: ago(3) })
  // The gateway's record and what Workbot's server told Den, newest first in one list.
  assert.deepEqual(detail.events.map((event) => [event.origin, event.type, event.level, event.message]), [
    ["provider", "woke", "info", "after: exec, pool: opensandbox-microvm"],
    ["den", "viewer_opened", "info", "Opened the Computer view"],
    ["den", "paused", "info", "Paused"],
    ["provider", "idled", "info", "action: pause, pool: opensandbox-microvm"],
    ["provider", "provision_retry", "warning", "error: no host with room"],
  ])
})

test("a computer nobody at Den knows, with events the runner's key may not read, is still shown", async () => {
  const bare = computerDetailFrom(runnerDetail({ events: null, eventsError: "http_403", placement: null }), null, null, { reported: null, events: [] }, NOW)
  assert.equal(adminComputerDetailSchema.safeParse(bare).success, true)
  assert.deepEqual([bare.computer.organization, bare.conversation, bare.reported, bare.events, bare.providerEventsError, bare.placement], [null, null, null, [], "http_403", null])
  // A failure from last week is not on the list any more, but its page still opens.
  const old = computerDetailFrom(runnerDetail({ computer: computer("sbx_old", { status: "failed", statusReason: "backend rejected the sandbox", updatedAt: ago(9000), endedAt: ago(9000) }) }), null, null, { reported: null, events: [] }, NOW)
  assert.deepEqual([old.computer.state, old.computer.attention, old.computer.statusReason], ["failed", "failed", "backend rejected the sandbox"])

  const read = (client: Parameters<typeof readComputerDetail>[0]["client"], known: Parameters<typeof readComputerDetail>[0]["known"] = async () => null) => readComputerDetail({ client, known, now: () => NOW }, "gateway", "sbx_1")
  const asked: string[] = []
  const found = await read({ readComputer: async () => ({ ok: true, value: runnerDetail() }) }, async (key) => { asked.push(key); return { owner: { id: "org_acme", name: "Acme" }, conversation, reports } })
  assert.deepEqual([found.status, found.status === "ok" && found.detail.conversation?.member?.name, asked], ["ok", "Dana Reyes", ["hc-sbx_1"]])
  // Den's own tables failing leaves the provider's record on the page.
  const unnamed = await read({ readComputer: async () => ({ ok: true, value: runnerDetail() }) }, async () => { throw new Error("database down") })
  assert.deepEqual([unnamed.status, unnamed.status === "ok" && unnamed.detail.conversation], ["ok", null])
  assert.deepEqual(await read({ readComputer: async () => ({ ok: false, status: 404, error: "unknown_computer" }) }), { status: "unknown" })
  assert.deepEqual(await read({ readComputer: async () => ({ ok: false, status: 502, error: "provider_http_503" }) }), { status: "unavailable", code: "provider_http_503" })
  assert.deepEqual(await read({ readComputer: async () => ({ ok: false, status: 404, error: "http_404" }) }), { status: "unavailable", code: "http_404" }, "a runner from before it could read one computer")
  assert.deepEqual(await read(null), { status: "unavailable", code: "not_configured" })
})
