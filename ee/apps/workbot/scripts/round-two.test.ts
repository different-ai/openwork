import assert from "node:assert/strict"
import { test } from "node:test"
import { firstReply } from "../../../packages/workbot-ui/src/first-reply.js"
import { frameKey, keepFrame, lastFrame } from "../../../packages/workbot-ui/src/frame-cache.js"
import { TASK_QUIET_MS, workbotActivity } from "../../../packages/workbot-ui/src/activity.js"
import type { WorkbotTask, WorkbotTurn } from "../../../packages/workbot-ui/src/data.js"
import { FEATURES } from "../../../../packages/features/src/registry.js"
import { resolveFeature } from "../../../../packages/features/src/resolve.js"

test("each new behavior has an independent default-off, organization-overridable and killable flag", () => {
  for (const key of ["workbotCenteredProfile", "workbotBrowserPreview", "workbotQuickReply", "workbotRemoteTasks"] as const) {
    assert.equal(FEATURES[key].default, false)
    const base = { deployment: "cloud" as const, locks: {}, rollouts: {}, overrides: {} }
    assert.equal(resolveFeature(key, base).enabled, false)
    assert.equal(resolveFeature(key, { ...base, overrides: { [key]: true } }).enabled, true)
    assert.equal(resolveFeature(key, { ...base, overrides: { [key]: true }, rollouts: { [key]: { enabled: true, killed: true } } }).enabled, false)
  }
})

const task = (id: string, startedAt: number, status: WorkbotTask["status"] = "working"): WorkbotTask => ({ id, title: id, status, startedAt, finishedAt: status === "stopped" || status === "done" ? startedAt + 1 : null, update: null, updates: [], steps: [], stepsDone: 0, note: null })
const turn = (tasks: WorkbotTask[], status: WorkbotTurn["status"] = "done"): WorkbotTurn => ({ id: "m1", text: "Use the browser to open YouTube", status, tasks, sentAt: 100, finishedAt: null, parts: [], modelSteps: 0, attachments: [], outputs: [], reaction: null, error: null, retryable: false, greeting: false, suggestions: [], navigation: [] })

test("accepted long requests get plain words, never an invented result or ETA", () => {
  assert.match(firstReply(turn([], "working"))!, /I'll take a look in my browser/)
  assert.match(firstReply({ ...turn([], "working"), text: "Build a room planner" })!, /reply here with the result/)
  assert.match(firstReply({ ...turn([], "working"), text: "Use your computer" })!, /my computer/)
  assert.match(firstReply(turn([], "queued"))!, /pick it up next/)
  for (const text of ["Don't use the browser", "Use the browser only for the plan; don’t open it yet.", "Use the browser but donʼt open it yet", "Use the browser for a plan, not to open anything", "Use the browser but wait for my approval", "Use the computer without opening a browser", "Why does the browser fail?", "[OpenWork browser teaching v2] Use a browser"]) assert.equal(firstReply({ ...turn([], "working"), text }), null)
  for (const status of ["done", "stopped", "failed"] as const) assert.equal(firstReply(turn([], status)), null)
  assert.equal(firstReply({ ...turn([], "working"), greeting: true }), null)
  assert.equal(firstReply({ ...turn([], "working"), text: "Thanks!" }), null)
})

test("stopped and finished tasks never hold the header; newest active task wins", () => {
  const activity = workbotActivity([turn([task("old", 100), task("new", 200), task("stopped", 300, "stopped"), task("done", 400, "done")])], {}, 500)
  assert.equal(activity.label, "new")
  assert.equal(activity.tasks.find(entry => entry.id === "stopped")?.current, null)
  assert.equal(workbotActivity([turn([task("stopped", 100, "stopped")])], {}, 500).working, false)
})

test("quiet tasks stay inspectable, but cannot advertise hours-old work as running", () => {
  const activity = workbotActivity([turn([task("old room planner", 100)])], {}, TASK_QUIET_MS + 101)
  assert.equal(activity.working, false)
  assert.equal(activity.label, "")
  assert.equal(activity.tasks[0]?.quiet, true)
  const alive = task("long job", 100)
  alive.steps = [{ label: "Checking result", done: false, at: TASK_QUIET_MS }]
  assert.equal(workbotActivity([turn([alive])], {}, TASK_QUIET_MS + 101).working, true)
})

test("a foreground answer takes precedence over an older task", () => {
  assert.equal(workbotActivity([turn([task("other", 50)], "working")], {}, 500).label, "Thinking")
})

test("last frames are scoped to identity, chat and view, expire, and reject arbitrary URLs", () => {
  const key = frameKey("org", "member", null, "browser")
  const image = "data:image/jpeg;base64,Zm9v"
  keepFrame(key, image, 100)
  assert.equal(lastFrame(key, 101), image)
  assert.equal(lastFrame(frameKey("other", "member", null, "browser"), 101), null)
  assert.equal(lastFrame(frameKey("org", "other", null, "browser"), 101), null)
  assert.equal(lastFrame(frameKey("org", "member", "side", "browser"), 101), null)
  assert.equal(lastFrame(frameKey("org", "member", null, "computer"), 101), null)
  keepFrame(key, "https://example.test/tracking.png", 101)
  assert.equal(lastFrame(key, 102), image)
  assert.equal(lastFrame(key, 5 * 60_000 + 100), null)
})
