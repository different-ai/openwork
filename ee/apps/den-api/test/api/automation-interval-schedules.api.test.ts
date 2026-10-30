/**
 * Every-few-hours (interval) schedules: generally available (the
 * `automationIntervalSchedules` flag is retired), scheduled by Den's own
 * resolver, and kept away from released desktops that parse only
 * once/daily/weekly schedules.
 */
import {
  AUTOMATION_FREE_MODEL,
  AUTOMATION_MODEL_ATTENTION_CAPABILITY,
  AUTOMATION_MODEL_ATTENTION_CAPABILITY_HEADER,
  AUTOMATION_SCHEDULE_KINDS_HEADER,
  type AutomationIntervalSchedule,
} from "@openwork/types/automations"
import { nextAutomationOccurrence } from "@openwork/types/automation-schedule"
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text } from "./harness.js"

const den = await bootDen({ env: { DEN_AUTOMATIONS_RUNTIME_ENABLED: "true" } })
after(() => den.close())

const { orgId, owner } = await den.createOrg(await den.signUp("Interval Owner"), "Interval schedule org")
const asOwner = den.as(owner, orgId)
const releasedDesktop = { [AUTOMATION_MODEL_ATTENTION_CAPABILITY_HEADER]: AUTOMATION_MODEL_ATTENTION_CAPABILITY }
const updatedDesktop = { ...releasedDesktop, [AUTOMATION_SCHEDULE_KINDS_HEADER]: "once,daily,weekly,interval" }
const interval: AutomationIntervalSchedule = { kind: "interval", timezone: "UTC", everyHours: 3, daysOfWeek: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 }
const definition = (schedule: unknown, name = "Inbox sweep") => ({
  name,
  instructions: "Sweep my inbox for anything urgent.",
  schedule,
  model: { providerId: AUTOMATION_FREE_MODEL.providerId, modelId: AUTOMATION_FREE_MODEL.modelId },
})
let intervalId = ""
let dailyId = ""

test("an interval schedule is accepted without a feature flag and scheduled from the window", async () => {
  const before = Date.now()
  const created = await asOwner("POST", "/v1/automations", definition({ kind: "interval", timezone: "UTC", everyHours: 3, daysOfWeek: [5, 1, 2, 3, 4, 3], startHour: 9, endHour: 18 }))
  assert.equal(created.status, 201, summary(created))
  intervalId = text(field(created.body, "automation", "id"), "interval Automation id")
  assert.deepEqual(field(created.body, "revision", "schedule"), interval)
  const nextDueAt = field(created.body, "automation", "nextDueAt")
  assert.equal(typeof nextDueAt, "number")
  const expected = nextAutomationOccurrence(interval, before)
  const latest = nextAutomationOccurrence(interval, Date.now())
  assert.ok(nextDueAt === expected || nextDueAt === latest, `${String(nextDueAt)} is the next run`)
  assert.ok([9, 12, 15].includes(new Date(Number(nextDueAt)).getUTCHours()))

  const daily = await asOwner("POST", "/v1/automations", definition({ kind: "daily", timezone: "UTC", hour: 8, minute: 0 }, "Morning summary"))
  assert.equal(daily.status, 201, summary(daily))
  dailyId = text(field(daily.body, "automation", "id"), "daily Automation id")
})

test("released desktops never see an interval Automation; updated desktops, Den web and agents do", async () => {
  const ids = async (headers?: Record<string, string>) => {
    const listed = await asOwner("GET", "/v1/automations", undefined, headers)
    assert.equal(listed.status, 200, summary(listed))
    return list(field(listed.body, "items")).map((item) => field(item, "automation", "id"))
  }
  assert.deepEqual(await ids(releasedDesktop), [dailyId])
  assert.deepEqual(new Set(await ids(updatedDesktop)), new Set([dailyId, intervalId]))
  assert.deepEqual(new Set(await ids()), new Set([dailyId, intervalId]))

  assert.equal((await asOwner("GET", `/v1/automations/${intervalId}`, undefined, releasedDesktop)).status, 404)
  assert.equal((await asOwner("PATCH", `/v1/automations/${intervalId}`, { name: "Renamed" }, releasedDesktop)).status, 404)
  assert.equal((await asOwner("GET", `/v1/automations/${intervalId}`, undefined, updatedDesktop)).status, 200)
})

test("the agent index keeps interval Automations out of the array released desktops parse", async () => {
  const token = await den.mintMcpToken(owner, orgId)
  const response = await den.request(token, "POST", "/mcp/agent", {
    headers: { accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "automation://index.json" } },
  })
  const line = response.text.split("\n").find((entry) => entry.startsWith("data:"))
  const envelope: unknown = JSON.parse(line ? line.slice(5) : response.text)
  const contents = list(field(envelope, "result", "contents"))
  const index: unknown = JSON.parse(text(contents[0]?.text, `index (${response.text.slice(0, 300)})`))
  assert.deepEqual(list(field(index, "automations")).map((entry) => field(entry, "id")), [dailyId])
  const more = list(field(index, "moreAutomations"))
  assert.deepEqual(more.map((entry) => field(entry, "id")), [intervalId])
  assert.equal(field(more[0], "summary"), "Every 3 hours · 09:00–18:00 · Mon, Tue, Wed, Thu, Fri · UTC")
})

test("an interval Automation keeps its schedule through edits and can change to a different interval", async () => {
  const kept = await asOwner("PATCH", `/v1/automations/${intervalId}`, { instructions: "Sweep my inbox and my calendar.", schedule: interval })
  assert.equal(kept.status, 200, summary(kept))
  assert.deepEqual(field(kept.body, "revision", "schedule"), interval)

  const changed = await asOwner("PATCH", `/v1/automations/${intervalId}`, { schedule: { ...interval, everyHours: 2 } })
  assert.equal(changed.status, 200, summary(changed))
  assert.equal(field(changed.body, "revision", "schedule", "everyHours"), 2)
  // A daily Automation can also be switched to an interval without a flag.
  const daily = await asOwner("PATCH", `/v1/automations/${dailyId}`, { schedule: interval })
  assert.equal(daily.status, 200, summary(daily))
})
