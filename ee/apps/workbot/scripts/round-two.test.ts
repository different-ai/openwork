import assert from "node:assert/strict"
import { test } from "node:test"
import { firstReply } from "../../../packages/workbot-ui/src/first-reply.js"
import { createFrameCache, frameKey, keepFrame, lastFrame } from "../../../packages/workbot-ui/src/frame-cache.js"
import { TASK_QUIET_MS, workbotActivity } from "../../../packages/workbot-ui/src/activity.js"
import type { WorkbotTask, WorkbotTurn } from "../../../packages/workbot-ui/src/data.js"

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

test("task pictures survive reload, stay isolated by identity/chat/task, and remain bounded", () => {
  const entries = new Map<string, string>()
  const storage = {
    get length() { return entries.size },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value) },
    removeItem: (key: string) => { entries.delete(key) },
  }
  const before = createFrameCache(() => storage)
  const key = frameKey("org", "member", null, "browser", "turn-one")
  const first = "data:image/jpeg;base64,Zm9v"
  let notifications = 0
  const unsubscribe = before.subscribeFrame(key, () => { notifications += 1 })
  before.keepFrame(key, first, 100)
  assert.equal(notifications, 1, "the historic glimpse sees a frame captured as the live glimpse unmounts")
  before.keepFrame(frameKey("org", "member", null, "browser", "unrelated"), first, 100)
  assert.equal(notifications, 1)
  unsubscribe()
  before.keepFrame(key, first, 100)
  assert.equal(notifications, 1)
  const reload = createFrameCache(() => storage)
  assert.equal(reload.lastFrame(key, 6 * 60_000), first, "a completed task is not lost after the live preview's five-minute window")
  for (const other of [
    frameKey("other", "member", null, "browser", "turn-one"),
    frameKey("org", "other", null, "browser", "turn-one"),
    frameKey("org", "member", "side", "browser", "turn-one"),
    frameKey("org", "member", null, "browser", "turn-two"),
    frameKey("org", "member", null, "browser"),
  ]) assert.equal(reload.lastFrame(other, 101), null)
  const second = frameKey("org", "member", null, "browser", "turn-two")
  reload.keepFrame(second, "data:image/jpeg;base64,YmFy", 200)
  assert.equal(reload.lastFrame(key, 201), first, "a later task cannot replace an older task's picture")
  assert.equal(createFrameCache(() => storage).lastFrame(key, 24 * 60 * 60_000 + 100), null)
  for (let index = 0; index < 6; index += 1) reload.keepFrame(frameKey("org", "member", null, "browser", `turn-${index}`), first, 1_000 + index)
  assert.equal(entries.size, 4)
  assert.equal(createFrameCache(() => storage).lastFrame(frameKey("org", "member", null, "browser", "turn-0"), 2_000), null)
  const newest = frameKey("org", "member", null, "browser", "turn-5")
  reload.forgetFrame(newest)
  assert.equal(createFrameCache(() => storage).lastFrame(newest, 2_000), null)
})

test("authorization denial clears the entire view including task frames, not unrelated scopes", () => {
  const image = "data:image/jpeg;base64,Zm9v"
  const scope = frameKey("org", "member", null, "browser")
  const first = frameKey("org", "member", null, "browser", "turn-one")
  const second = frameKey("org", "member", null, "browser", "turn-two")
  for (const unrelated of [
    frameKey("other", "member", null, "browser", "turn-one"),
    frameKey("org", "other", null, "browser", "turn-one"),
    frameKey("org", "member", "side", "browser", "turn-one"),
    frameKey("org", "member", null, "computer", "turn-one"),
  ]) for (const reloadBeforeDenial of [false, true]) {
    const entries = new Map<string, string>()
    const storage = {
      get length() { return entries.size },
      key: (index: number) => [...entries.keys()][index] ?? null,
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value) },
      removeItem: (key: string) => { entries.delete(key) },
    }
    const original = createFrameCache(() => storage)
    for (const key of [scope, first, second, unrelated]) original.keepFrame(key, image, 100)
    const cache = reloadBeforeDenial ? createFrameCache(() => storage) : original
    let cleared = 0
    let unrelatedNotifications = 0
    const absent = frameKey("org", "member", null, "browser", "mounted-no-frame")
    for (const key of [scope, first, second, absent]) cache.subscribeFrame(key, () => {
      assert.equal(cache.lastFrame(key, 101), null)
      cleared += 1
    })
    cache.subscribeFrame(unrelated, () => { unrelatedNotifications += 1 })
    cache.forgetViewFrames(first)
    assert.equal(cleared, 4, "mounted live and historic views are all notified, including those without a cached frame")
    for (const key of [scope, first, second]) {
      assert.equal(cache.lastFrame(key, 101), null)
      assert.equal(createFrameCache(() => storage).lastFrame(key, 101), null, "denied pixels cannot survive reload")
      cache.keepFrame(key, image, 102)
      assert.equal(cache.lastFrame(key, 103), null, "an old viewer's interval or cleanup cannot repopulate denied frames")
    }
    assert.equal(cache.lastFrame(unrelated, 103), image)
    assert.equal(createFrameCache(() => storage).lastFrame(unrelated, 103), image)
    assert.equal(unrelatedNotifications, 0)
    cache.forgetViewFrames("not-a-valid-scope")
    assert.equal(cache.lastFrame(unrelated, 103), image)
    cache.allowViewFrames(scope)
    // No old pixels are restored by authorization; only a newly drawn frame can be retained.
    assert.equal(cache.lastFrame(first, 103), null)
  }
})

test("denial invalidates memory and notifies subscribers even when session storage is unavailable", () => {
  const cache = createFrameCache(() => { throw new Error("Storage disabled") })
  const key = frameKey("org", "member", "chat", "browser", "task")
  cache.keepFrame(key, "data:image/jpeg;base64,Zm9v", 100)
  let notifications = 0
  cache.subscribeFrame(key, () => { notifications += 1 })
  cache.forgetViewFrames(frameKey("org", "member", "chat", "browser"))
  assert.equal(cache.lastFrame(key, 101), null)
  assert.equal(notifications, 1)
})

test("disabled picture persistence falls back to bounded memory without breaking work", () => {
  const cache = createFrameCache(() => { throw new Error("Storage disabled") })
  const image = "data:image/jpeg;base64,Zm9v"
  cache.keepFrame("key", image, 100)
  cache.keepFrame("key", "https://example.test/not-a-frame", 101)
  assert.equal(cache.lastFrame("key", 102), image)
  for (let index = 0; index < 4; index += 1) cache.keepFrame(`key-${index}`, image, 200 + index)
  assert.equal(cache.lastFrame("key", 300), null)
})
