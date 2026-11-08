import assert from "node:assert/strict"
import { test } from "node:test"
import type { RunnerSnapshot } from "@openwork-ee/headless-protocol"
import { buildWorkbotTurns, toWorkbotPageEvent, workbotInstructions } from "@openwork-ee/workbot-server"
import { workbotActivity } from "../../../packages/workbot-ui/src/activity.js"
import type { WorkbotTurn } from "../../../packages/workbot-ui/src/data.js"

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
  const activity = workbotActivity(turns, {})
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

test("with workingStatus, the first reply stands on its own and task progress is explained", () => {
  const off = workbotInstructions(base)
  const on = workbotInstructions({ ...base, workingStatus: true })
  assert.ok(off.includes("Sure, give me a sec."))
  assert.ok(on.includes("Never send a bare \"Sure, give me a sec.\""))
  assert.ok(on.includes("Never answer with only \"still working\""))
  assert.equal(off.includes("still working"), false)
})
