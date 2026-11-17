import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { adminComputerFleetHistorySchema, adminComputerFleetSchema, COMPUTER_FLEET_LIST_LIMIT } from "@openwork/types/den/admin-computer-fleet"
import type { RunnerComputer, RunnerComputerFleet, RunnerComputerSource } from "../src/headless-runner/client.js"
import { BUCKET_MS, emptyHour, foldFleet, historyFromHours, hourKey, mergeHours, storedHour } from "../src/computer-fleet/history.js"
import { readComputerFleet } from "../src/computer-fleet/reader.js"
import { computerFleetFrom, computerKey, type ComputerOwner } from "../src/computer-fleet/state.js"

/** The admin Computer fleet page's data: the runner's list of its computers, read into one fleet and its history. */

const NOW = new Date("2026-11-17T22:00:00.000Z")
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString()

/** A computer as the runner lists it (`GET /v1/computers`), in the provider's own words. */
const computer = (id: string, extra: Partial<RunnerComputer> = {}): RunnerComputer => ({
  id, key: `hc-${id}`, source: "gateway", provider: "differently", status: "running", statusReason: null, pool: "opensandbox-microvm", backend: "opensandbox", region: "eastus",
  cpu: 2, memoryMb: 4096, diskGb: 8, createdAt: ago(600), updatedAt: ago(30), startedAt: ago(599), pausedAt: null, lastActivityAt: ago(1), expiresAt: null, endedAt: null, attempts: 1,
  ...extra,
})
const gateway = (extra: Partial<RunnerComputerSource> = {}): RunnerComputerSource => ({
  source: "gateway", provider: "differently", status: "ok", error: null, truncated: false,
  pools: [{ name: "opensandbox-microvm", backend: "opensandbox", region: "eastus", enabled: true, health: "healthy" }], ...extra,
})
const direct = (extra: Partial<RunnerComputerSource> = {}): RunnerComputerSource => ({ source: "direct", provider: "freestyle", status: "ok", error: null, truncated: false, pools: [], ...extra })
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
