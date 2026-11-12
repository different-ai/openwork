import assert from "node:assert/strict"
import { test } from "node:test"
import type { RunnerSnapshot } from "@openwork-ee/headless-protocol"
import { buildWorkbotTurns, interruptedTurnIds, threadBusy, toWorkbotPageEvent, workbotInstructions } from "@openwork-ee/workbot-server"
import { liveStatus, nextTaskQuietAt, TASK_QUIET_MS, workbotActivity } from "../../../packages/workbot-ui/src/activity.js"
import type { LiveText, WorkbotTurn } from "../../../packages/workbot-ui/src/data.js"

const base = { name: "Workbot", organizationName: "Example", firstName: "Alex", timeZone: "UTC", canSchedule: false }

/** "Code me an app": Workbot answers, starts a task, and the task works through apps and its computer. */
const snapshot = {
  status: "idle", finalAssistantText: "", hasEarlier: false,
  turns: [
    { messageId: "wb_m1", status: "completed", createdAt: 100, updatedAt: 200, error: null },
    { messageId: "wb_m1.t1", kind: "task", parent: "wb_m1", title: "3D room planner", status: "running", createdAt: 150, updatedAt: 400, error: null },
  ],
  messages: [
    { messageId: "wb_m1", role: "user", text: "Code me an app that organizes my space in 3D" },
    { messageId: "wb_m1", role: "assistant", text: "I'll build a 3D room planner. About 5 minutes.", createdAt: 120, toolCalls: [{ id: "s1", name: "start_task", input: { title: "3D room planner", brief: "Build it" } }] },
    { messageId: "wb_m1", role: "tool", callId: "s1", name: "start_task", isError: false, createdAt: 130 },
    { messageId: "wb_m1.t1", role: "user", text: "Build it" },
    { messageId: "wb_m1.t1", role: "assistant", text: "Planning the  layout\nfirst.", createdAt: 160, toolCalls: [{ id: "c1", name: "execute_capability", input: { name: "google-drive:searchFiles" } }] },
    { messageId: "wb_m1.t1", role: "tool", callId: "c1", name: "execute_capability", isError: false, createdAt: 170 },
    { messageId: "wb_m1.t1", role: "assistant", text: "", createdAt: 180, toolCalls: [{ id: "c2", name: "bash", input: { command: "npm create vite", description: "Setting up the project" } }, { id: "c3", name: "memory_search", input: {} }] },
    { messageId: "wb_m1.t1", role: "tool", callId: "c2", name: "bash", isError: false, createdAt: 190 },
    { messageId: "wb_m1.t1", role: "assistant", text: "", createdAt: 200, toolCalls: [{ id: "c4", name: "bash", input: { command: "npm run build", description: "Building the planner" } }] },
  ],
} satisfies RunnerSnapshot

test("a background task carries its steps, how many are done and its latest note", () => {
  const [turn] = buildWorkbotTurns(snapshot)
  const [task] = turn?.tasks ?? []
  assert.ok(task)
  assert.deepEqual(task.steps.map((step) => [step.label, step.done]), [["Searching Google Drive", true], ["Setting up the project", true], ["Building the planner", false]])
  assert.equal(task.stepsDone, 2)
  assert.equal(task.note, "Planning the layout first.")
})

test("the status line and sheet follow the task; nothing is in the chat for it", () => {
  const turns = buildWorkbotTurns(snapshot) as WorkbotTurn[]
  const activity = workbotActivity(turns, {}, 400)
  assert.equal(activity.working, true)
  assert.equal(activity.label, "3D room planner")
  assert.equal(activity.icon, "task")
  assert.equal(activity.main, null)
  assert.equal(activity.tasks[0]?.current, "Building the planner")
  assert.equal(activity.watch, null)
})

test("while Workbot answers, the line says the step running now and the sheet lists its steps", () => {
  const turns = buildWorkbotTurns({
    status: "busy", finalAssistantText: "", hasEarlier: false,
    turns: [{ messageId: "wb_m2", status: "running", createdAt: 100, error: null }],
    messages: [
      { messageId: "wb_m2", role: "user", text: "Find Chris Young's salmon tips" },
      { messageId: "wb_m2", role: "assistant", text: "", createdAt: 110, toolCalls: [{ id: "a1", name: "execute_capability", input: { name: "slack:searchMessages" } }] },
      { messageId: "wb_m2", role: "tool", callId: "a1", name: "execute_capability", isError: false, createdAt: 120 },
      { messageId: "wb_m2", role: "assistant", text: "", createdAt: 130, toolCalls: [{ id: "a2", name: "desktop", input: { view: "browser", operation: "open", args: { url: "https://www.youtube.com/results?q=salmon" }, description: "Searching YouTube" } }] },
    ],
  }) as WorkbotTurn[]
  const activity = workbotActivity(turns, {})
  assert.equal(activity.label, "Searching YouTube")
  assert.equal(activity.icon, "browser")
  assert.equal(activity.watch, "browser")
  assert.deepEqual(activity.main?.steps.map((step) => [step.label, step.done]), [["Searching Slack", true], ["Searching YouTube", false]])
  // A step the model started that isn't stored yet shows at once.
  const thinking = workbotActivity([{ ...turns[0]!, parts: [] }], { m2: { step: 0, text: "", working: { on: "other", since: 0 } } })
  assert.equal(thinking.label, "Thinking")
})

test("a task's steps reach the page as a throttled re-read, never its words", () => {
  const first = toWorkbotPageEvent({ type: "tool", messageId: "wb_m9.t1", step: 2, tool: "bash", description: "Building" })
  assert.deepEqual(first, { type: "changed", messageId: "m9.t1" })
  assert.equal(toWorkbotPageEvent({ type: "tool", messageId: "wb_m9.t1", step: 3, tool: "bash" }), null)
  assert.equal(toWorkbotPageEvent({ type: "text", messageId: "wb_m9.t1", step: 3, delta: "private draft" }), null)
  assert.deepEqual(toWorkbotPageEvent({ type: "changed", messageId: "wb_m9.t1", status: "completed" }), { type: "changed", messageId: "m9.t1", status: "completed" })
})

test("the human acknowledgment precedes discovery, reactions and browser work, with or without workingStatus", () => {
  for (const workingStatus of [false, true]) {
    const prompt = workbotInstructions({ ...base, workingStatus, browser: true, quickReply: true })
    assert.ok(prompt.includes("before any tool call, including search_capabilities, react, browser or computer operations"))
    assert.ok(prompt.includes("one or two short sentences"))
    assert.ok(prompt.includes("not a typing indicator or an emoji"))
    assert.ok(prompt.includes("Never invent an ETA"))
    assert.ok(prompt.includes("after your acknowledgment when the request needs work"))
    assert.equal(prompt.includes("About 5 minutes"), false)
    assert.equal(prompt.includes("before you reply"), false)
  }
  assert.ok(workbotInstructions({ ...base, workingStatus: true }).includes("Never answer with only \"still working\""))
})

test("quickReply defaults off and retains the original first-reply and reaction rules", () => {
  for (const workingStatus of [false, true]) {
    const original = workbotInstructions({ ...base, workingStatus })
    assert.equal(original, workbotInstructions({ ...base, workingStatus, quickReply: false }))
    assert.ok(original.includes("before you reply: 👍"))
    assert.equal(original.includes("before any tool call, including search_capabilities"), false)
    assert.equal(original.includes("not a typing indicator or an emoji"), false)
    assert.ok(original.includes(workingStatus ? "About 5 minutes" : "Sure, give me a sec."))
  }
})

test("terminal and abandoned task lifecycles never project as active or keep a stale session busy", () => {
  for (const [status, error, expected] of [
    ["completed", null, "done"], ["failed", null, "failed"], ["aborted", null, "stopped"],
    ["stopped", null, "stopped"], ["cancelled", null, "stopped"], ["canceled", null, "stopped"],
    ["abandoned", null, "stopped"], ["future_unknown_status", null, "failed"],
    ["running", "runner_restart", "stopped"], ["interrupted", "runner_restart", "stopped"],
    ["interrupted", "abandoned", "stopped"],
  ] as const) {
    const stale: RunnerSnapshot = { ...snapshot, status: "busy", turns: [snapshot.turns[0], { ...snapshot.turns[1], status, error }] }
    const [turn] = buildWorkbotTurns(stale)
    const [task] = turn!.tasks
    assert.equal(task!.status, expected, `${status}/${error}`)
    assert.equal(task!.finishedAt, 400)
    assert.equal(task!.update, null)
    assert.equal(task!.note, null)
    assert.equal(threadBusy(stale), false)
    assert.deepEqual(interruptedTurnIds(stale), [])
    assert.equal(workbotActivity([turn!] as WorkbotTurn[], {}).working, false)
  }
})

test("old foreground interruptions are stopped; genuine latest and task pauses remain resumable", () => {
  const paused: RunnerSnapshot = {
    ...snapshot, status: "busy",
    turns: [
      { ...snapshot.turns[0], status: "interrupted", error: "runner_restarted" },
      { ...snapshot.turns[1], status: "interrupted", error: "token_expired" },
      { messageId: "wb_m2", status: "interrupted", error: "runner_restarted", createdAt: 500, updatedAt: 600, prompt: "Latest request" },
    ],
  }
  assert.deepEqual(interruptedTurnIds(paused), ["wb_m2", "wb_m1.t1"])
  const turns = buildWorkbotTurns(paused)
  assert.equal(turns[0]!.status, "stopped")
  assert.equal(turns[0]!.tasks[0]!.status, "paused")
  assert.equal(turns[1]!.status, "working")
  assert.equal(threadBusy(paused), true)
})

test("abandoned foreground calls lose their running steps and Stop eligibility", () => {
  const stopped: RunnerSnapshot = {
    status: "busy", finalAssistantText: "", hasEarlier: false,
    turns: [{ messageId: "wb_stop", status: "running", error: "runner_restart", createdAt: 100, updatedAt: 200 }],
    messages: [
      { messageId: "wb_stop", role: "user", text: "Open YouTube" },
      { messageId: "wb_stop", role: "assistant", text: "I'll open YouTube now.", createdAt: 120, toolCalls: [{ id: "browser", name: "desktop", input: { view: "browser", operation: "open", args: { url: "https://youtube.com" } } }] },
    ],
  }
  const [turn] = buildWorkbotTurns(stopped)
  assert.equal(turn!.status, "stopped")
  assert.equal(turn!.finishedAt, 200)
  assert.deepEqual(turn!.parts.filter(part => part.kind === "steps").flatMap(part => part.steps.map(step => [step.status, step.finishedAt, step.reason])), [["done", 200, "Stopped before the action finished."]])
  assert.equal(threadBusy(stopped), false)
  assert.deepEqual(interruptedTurnIds(stopped), [])
  assert.equal(workbotActivity([turn!] as WorkbotTurn[], {}).working, false)
})

test("the status line reads the stream without its words, so a streamed word never moves it", () => {
  const answering = buildWorkbotTurns({
    status: "busy", finalAssistantText: "", hasEarlier: false,
    turns: [{ messageId: "wb_m3", status: "running", createdAt: 100, error: null }],
    messages: [
      { messageId: "wb_m3", role: "user", text: "What did I miss?" },
      { messageId: "wb_m3", role: "assistant", text: "", createdAt: 110, toolCalls: [{ id: "a1", name: "execute_capability", input: { name: "slack:searchMessages" } }] },
      { messageId: "wb_m3", role: "tool", callId: "a1", name: "execute_capability", isError: false, createdAt: 120 },
    ],
  }) as WorkbotTurn[]
  const plain: WorkbotTurn[] = [{ ...answering[0]!, parts: [], modelSteps: 0 }]
  const streams: Array<Record<string, LiveText>> = [
    {},
    { m3: { step: 1, text: "" } },
    { m3: { step: 1, text: " \n" } },
    { m3: { step: 1, text: "Here is what" } },
    { m3: { step: 1, text: "Here is what you missed", earlier: [{ step: 0, text: "On it." }] } },
    { m3: { step: 1, text: "", working: { on: "computer", since: 5, surface: "browser", update: "Opening the page" } } },
    { m3: { step: 1, text: "Checking", working: { on: "other", since: 5 } } },
    { m3: { step: 0, text: "An earlier call's words" } },
  ]
  for (const turns of [answering, plain]) {
    for (const live of streams) assert.deepEqual(workbotActivity(turns, liveStatus(live), 1_000), workbotActivity(turns, live, 1_000))
  }
  // More words of the same reply read the same, so the page around the reply has nothing to re-render.
  assert.deepEqual(liveStatus(streams[3]!), liveStatus(streams[4]!))
  assert.notDeepEqual(liveStatus(streams[1]!), liveStatus(streams[3]!))
})

test("the page ages tasks at the moment one goes quiet, not on a ticking clock", () => {
  const [turn] = buildWorkbotTurns(snapshot) as WorkbotTurn[]
  const [task] = turn!.tasks
  const stepped = { ...task!, id: "stepped", startedAt: 1_000, steps: [{ label: "Building", done: false, at: 5_000 }] }
  const started = { ...task!, id: "started", startedAt: 2_000, steps: [] }
  const ended = { ...task!, id: "ended", status: "done" as const, startedAt: 3_000, finishedAt: 4_000, steps: [] }
  const turns = [{ ...turn!, tasks: [stepped, started, ended] }]
  const quiet = (now: number) => workbotActivity(turns, {}, now).tasks.filter((entry) => entry.quiet).map((entry) => entry.id).sort()
  // The first task to go quiet sets the next time worth looking; until then the clock changes nothing.
  assert.equal(nextTaskQuietAt(turns, 10_000), 2_000 + TASK_QUIET_MS)
  assert.deepEqual(quiet(10_000), quiet(2_000 + TASK_QUIET_MS - 1))
  assert.deepEqual(quiet(2_000 + TASK_QUIET_MS), ["started"])
  assert.equal(nextTaskQuietAt(turns, 2_000 + TASK_QUIET_MS), 5_000 + TASK_QUIET_MS)
  assert.deepEqual(quiet(5_000 + TASK_QUIET_MS), ["started", "stepped"])
  // Nothing left to wait for: unfinished tasks are all quiet already, and finished ones never go quiet.
  assert.equal(nextTaskQuietAt(turns, 5_000 + TASK_QUIET_MS), null)
  assert.equal(nextTaskQuietAt([{ ...turn!, tasks: [ended] }], 0), null)
})
