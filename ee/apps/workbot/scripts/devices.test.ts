import assert from "node:assert/strict"
import { test } from "node:test"
import type { WorkbotRemoteJob } from "@openwork/types/workbot-remote-jobs"
import { deviceTaskLine, deviceWork } from "../../../packages/workbot-ui/src/device-work.js"

/** What a Devices row says Workbot is doing on its computer. */

const MAC = "rnr_mac"
const mac = { kind: "desktop", provider: "openwork_desktop", computerId: MAC, workingSince: null } as const

function job(key: string, state: "starting" | "running" | "waiting" | "idle" | "error", extra: { computerId?: string | null; waitingFor?: "permission" | "question"; latestStep?: string; startedAt?: number } = {}): WorkbotRemoteJob {
  return {
    key, ref: { commandId: key }, title: `Task ${key}`, target: "desktop", toolCallId: `call-${key}`, turnId: null, startedAt: extra.startedAt ?? 1, watcherTaskIds: [], stale: false,
    status: {
      ref: key, changed: true, version: "1", target: "desktop", state, waitingFor: extra.waitingFor ?? null, title: null,
      computerId: extra.computerId === undefined ? MAC : extra.computerId, computerLabel: "Mac mini", sessionId: null, workspaceId: null, messageCount: null,
      preview: null, latestStep: extra.latestStep ?? null, error: null, observedAt: null,
    },
  }
}

test("a desktop row names the task Workbot runs on that computer", () => {
  assert.equal(deviceWork(mac, []), null)
  assert.deepEqual(deviceWork(mac, [job("a", "running", { latestStep: "Reading the report" })]), { label: "Workbot is working here", detail: "Reading the report", needsYou: false })
  assert.deepEqual(deviceWork(mac, [job("a", "running")]), { label: "Workbot is working here", detail: "Task a", needsYou: false })
  assert.deepEqual(deviceWork(mac, [job("a", "starting")]), { label: "Workbot's task is waiting to start here", detail: "Task a", needsYou: false })
  assert.deepEqual(deviceWork(mac, [job("a", "waiting", { waitingFor: "permission" })]), { label: "Workbot needs your approval here", detail: "Task a", needsYou: true })
  assert.deepEqual(deviceWork(mac, [job("a", "waiting", { waitingFor: "question" })]), { label: "Workbot needs your answer here", detail: "Task a", needsYou: true })
})

test("only a task on that computer counts, and one waiting on the person comes first", () => {
  assert.equal(deviceWork(mac, [job("a", "running", { computerId: "rnr_other" }), job("b", "running", { computerId: null })]), null)
  assert.equal(deviceWork(mac, [job("a", "idle"), job("b", "error")]), null, "finished work is not work in progress")
  assert.equal(deviceWork({ ...mac, computerId: null }, [job("a", "running", { computerId: null })]), null, "a desktop that takes no tasks never matches")
  assert.equal(deviceWork({ kind: "vm", provider: "freestyle", computerId: null, workingSince: null }, [job("a", "running")]), null)
  const several = [job("old", "running", { startedAt: 1 }), job("new", "running", { startedAt: 5, latestStep: "Newest" }), job("ask", "waiting", { startedAt: 2, waitingFor: "question" })]
  assert.equal(deviceWork(mac, several)?.label, "Workbot needs your answer here")
  assert.equal(deviceWork(mac, several.slice(0, 2))?.detail, "Newest")
})

test("Workbot's own computer follows Den's word about its chat, not this chat's remote tasks", () => {
  const own = { kind: "vm", provider: "workbot", computerId: null } as const
  assert.equal(deviceWork({ ...own, workingSince: null }, [job("a", "running")]), null)
  assert.deepEqual(deviceWork({ ...own, workingSince: "2026-11-13T10:00:00.000Z" }, []), { label: "Workbot is working in its chat", detail: null, needsYou: false })
})

test("a desktop row promises tasks only while other devices may start them there", () => {
  const desktop = { kind: "desktop", computerId: MAC } as const
  const access = (effective: "off" | "created" | "all", reason: "organization" | "not_chosen" | "update_required" | null, chosen = reason === null) => ({ effective, chosen, reason })
  assert.equal(deviceTaskLine({ ...desktop, remoteAccess: access("created", null) }), "Takes tasks from Workbot")
  assert.equal(deviceTaskLine({ ...desktop, remoteAccess: access("all", null) }), "Takes tasks from Workbot")
  assert.equal(deviceTaskLine({ ...desktop, remoteAccess: access("created", "organization", true) }), "Takes tasks from Workbot", "a narrower organization limit still takes tasks")
  assert.equal(deviceTaskLine({ ...desktop, remoteAccess: null }), "Takes tasks from Workbot", "a server from before the owner's choice says nothing about it")
  assert.equal(deviceTaskLine({ ...desktop, remoteAccess: access("off", "not_chosen") }), "Takes no tasks until you allow it in Settings › Devices on that computer")
  assert.equal(deviceTaskLine({ ...desktop, remoteAccess: access("off", "update_required") }), "Takes no tasks until OpenWork is updated on that computer")
  assert.equal(deviceTaskLine({ ...desktop, remoteAccess: access("off", "organization") }), "Takes no tasks while your organization has them turned off")
  assert.equal(deviceTaskLine({ ...desktop, remoteAccess: access("off", null) }), "Takes no tasks while they are turned off in Settings › Devices on that computer")
  assert.equal(deviceTaskLine({ ...desktop, computerId: null, remoteAccess: null }), null, "a desktop that never takes tasks says nothing")
  assert.equal(deviceTaskLine({ kind: "vm", computerId: null, remoteAccess: null }), null)
})
