/**
 * Usage analytics per day: the response includes 30 UTC days ending today,
 * today's events land in the last day, and the project filter narrows them.
 * The weekly trend remains available.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, summary } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const org = await den.createOrg(await den.signUp("Daily Owner"), "Daily analytics workspace")
const owner = den.as(org.owner, org.orgId)

function event(sessionId: string, type: "session.active" | "task.completed" | "task.failed", project: string, timestamp = new Date()) {
  return { type, timestamp: timestamp.toISOString(), source: "app", sessionId, dimensions: [{ type: "project", value: project, label: project }] }
}

const DAY_MS = 24 * 60 * 60 * 1000
const today = new Date().toISOString().slice(0, 10)
const threeDaysAgo = new Date(Date.now() - 3 * DAY_MS)

const sent = await owner("POST", "/v1/telemetry/ingest", {
  events: [
    event("s-today", "session.active", "alpha"),
    event("s-today", "task.completed", "alpha"),
    event("s-today-b", "task.failed", "beta"),
    event("s-earlier", "session.active", "alpha", threeDaysAgo),
  ],
})
assert.equal(sent.status, 204, summary(sent))

type Day = { day: string; activeMembers: number; sessions: number; tasksCompleted: number; tasksFailed: number }

function days(body: unknown): Day[] {
  const value = field(body, "daily")
  assert.ok(Array.isArray(value), "daily is an array")
  return value.map((entry): Day => ({
    day: String(field(entry, "day")),
    activeMembers: Number(field(entry, "activeMembers")),
    sessions: Number(field(entry, "sessions")),
    tasksCompleted: Number(field(entry, "tasksCompleted")),
    tasksFailed: Number(field(entry, "tasksFailed")),
  }))
}

test("on: 30 UTC days ending today, with each event on its own day", async () => {
  const result = await owner("GET", "/v1/telemetry/analytics")
  assert.equal(result.status, 200, summary(result))
  const daily = days(result.body)
  assert.equal(daily.length, 30)
  assert.equal(daily[29]?.day, today)
  assert.deepEqual(daily[29], { day: today, activeMembers: 1, sessions: 2, tasksCompleted: 1, tasksFailed: 1 })
  const earlier = daily.find((d) => d.day === threeDaysAgo.toISOString().slice(0, 10))
  assert.deepEqual(earlier, { day: threeDaysAgo.toISOString().slice(0, 10), activeMembers: 1, sessions: 1, tasksCompleted: 0, tasksFailed: 0 })
  assert.equal(daily.reduce((sum, d) => sum + d.sessions, 0), 3)
})

test("on: the project filter narrows the daily trend", async () => {
  const result = await owner("GET", "/v1/telemetry/analytics?dimensionType=project&dimensionValue=beta")
  assert.equal(result.status, 200, summary(result))
  const daily = days(result.body)
  assert.deepEqual(daily[29], { day: today, activeMembers: 1, sessions: 1, tasksCompleted: 0, tasksFailed: 1 })
  assert.equal(daily.slice(0, 29).every((d) => d.sessions === 0), true)
})
