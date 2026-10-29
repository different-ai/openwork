import assert from "node:assert/strict"
import { test } from "node:test"
import type { RunnerSnapshot } from "@openwork-ee/headless-protocol"
import { buildWorkbotTurns, workbotInstructions, workbotPageId } from "@openwork-ee/workbot-server"

const desktop = (id: string, view: "browser" | "computer", operation: string, args: Record<string, unknown>, description?: string) =>
  ({ id, name: "desktop", input: { view, operation, args, ...(description ? { description } : {}) } })

test("browser work is its own step that narrates what it does and links the pages it opened", () => {
  const snapshot = {
    status: "busy", finalAssistantText: "", hasEarlier: false,
    turns: [{ messageId: "wb_listings", status: "running", createdAt: 100, error: null }],
    messages: [
      { messageId: "wb_listings", role: "user", text: "Find me 2-bedroom flats" },
      { messageId: "wb_listings", role: "assistant", text: "Sure, I'll check live listings.", createdAt: 110, toolCalls: [
        desktop("c1", "browser", "open", { url: "https://www.example-homes.test/search/2-bed" }),
        desktop("c2", "browser", "act", { tabId: "tab", observationId: "o1", actions: [{ type: "fill", ref: "e1", text: "private value" }] }),
        desktop("c3", "browser", "navigate", { tabId: "tab", url: "javascript:alert(1)" }),
        desktop("c4", "browser", "extract", { tabId: "tab", question: "prices" }, "Comparing prices on Example Homes"),
      ] },
      { messageId: "wb_listings", role: "tool", callId: "c1", name: "desktop", isError: false, createdAt: 120 },
      { messageId: "wb_listings", role: "tool", callId: "c2", name: "desktop", isError: false, createdAt: 130 },
      { messageId: "wb_listings", role: "tool", callId: "c3", name: "desktop", isError: true, createdAt: 140 },
      { messageId: "wb_listings", role: "assistant", text: "", createdAt: 150, toolCalls: [desktop("c5", "computer", "computer_launch", { app: "calc" })] },
    ],
  } satisfies RunnerSnapshot
  const [turn] = buildWorkbotTurns(snapshot)
  const steps = turn?.parts.flatMap((part) => (part.kind === "steps" ? part.steps : [])) ?? []
  assert.deepEqual(steps.map((step) => [step.label, step.surface ?? null, step.status]), [["Using the browser", "browser", "running"], ["Using my computer", null, "running"]])
  const [browser, computer] = steps
  // Plain words for each call, its own description first; never the typed value or a non-web address.
  assert.deepEqual(browser?.updates, ["Opening example-homes.test/search/2-bed", "Filling in the form", "Working in the browser", "Comparing prices on Example Homes"])
  assert.equal(JSON.stringify(turn).includes("private value"), false)
  assert.deepEqual(browser?.pages, [{ id: workbotPageId("https://www.example-homes.test/search/2-bed"), url: "https://www.example-homes.test/search/2-bed", title: "example-homes.test/search/2-bed" }])
  assert.match(browser?.pages?.[0]?.id ?? "", /^[a-z0-9]{1,16}$/)
  assert.deepEqual(computer?.updates, ["Opening Calc"])
})

test("commands run in the background are their own step, apart from work on the screen", () => {
  const bash = (id: string, description: string) => ({ id, name: "bash", input: { command: "blender -b scene.blend -a", description } })
  const snapshot = {
    status: "busy", finalAssistantText: "", hasEarlier: false,
    turns: [{ messageId: "wb_render", status: "running", createdAt: 100, error: null }],
    messages: [
      { messageId: "wb_render", role: "user", text: "Render my scene, then open it" },
      { messageId: "wb_render", role: "assistant", text: "", createdAt: 110, toolCalls: [bash("c1", "Rendering the scene with Blender"), bash("c2", "Checking the frames")] },
      { messageId: "wb_render", role: "tool", callId: "c1", name: "bash", isError: false, createdAt: 120 },
      { messageId: "wb_render", role: "tool", callId: "c2", name: "bash", isError: false, createdAt: 130 },
      { messageId: "wb_render", role: "assistant", text: "", createdAt: 140, toolCalls: [desktop("c3", "computer", "computer_launch", { app: "blender" })] },
    ],
  } satisfies RunnerSnapshot
  const [turn] = buildWorkbotTurns(snapshot)
  const steps = turn?.parts.flatMap((part) => (part.kind === "steps" ? part.steps : [])) ?? []
  assert.deepEqual(steps.map((step) => [step.label, step.background ?? false, step.status]), [["Working on my computer", true, "done"], ["Using my computer", false, "running"]])
  assert.deepEqual(steps[0]?.updates, ["Rendering the scene with Blender", "Checking the frames"])
})

test("a screen step keeps the last show Workbot gave, and background work has none", () => {
  const shown = (id: string, show?: boolean) => ({ id, name: "desktop", input: { view: "computer", operation: "computer_observe", args: {}, ...(show === undefined ? {} : { show }) } })
  const snapshot = {
    status: "busy", finalAssistantText: "", hasEarlier: false,
    turns: [{ messageId: "wb_show", status: "running", createdAt: 100, error: null }],
    messages: [
      { messageId: "wb_show", role: "user", text: "Show me the scene" },
      { messageId: "wb_show", role: "assistant", text: "", createdAt: 110, toolCalls: [shown("c1"), shown("c2", true), shown("c3")] },
      { messageId: "wb_show", role: "tool", callId: "c1", name: "desktop", isError: false, createdAt: 120 },
      { messageId: "wb_show", role: "tool", callId: "c2", name: "desktop", isError: false, createdAt: 130 },
      { messageId: "wb_show", role: "tool", callId: "c3", name: "desktop", isError: false, createdAt: 140 },
      { messageId: "wb_show", role: "assistant", text: "", createdAt: 150, toolCalls: [{ id: "c4", name: "bash", input: { command: "ls", show: true } }, shown("c5", false)] },
    ],
  } satisfies RunnerSnapshot
  const [turn] = buildWorkbotTurns(snapshot)
  const steps = turn?.parts.flatMap((part) => (part.kind === "steps" ? part.steps : [])) ?? []
  assert.deepEqual(steps.map((step) => [step.label, step.shown ?? null]), [["Using my computer", true], ["Working on my computer", null], ["Using my computer", false]])
})

test("the browser and background-then-screen nudges are only given when the computer is on", () => {
  const base = { name: "Workbot", organizationName: "Example", firstName: "Alex", timeZone: "UTC", canSchedule: false }
  assert.equal(workbotInstructions(base).includes("check it in your browser"), false)
  assert.ok(workbotInstructions({ ...base, browser: true }).includes("check it in your browser"))
  // Getting it done in the background, and the screen only when it helps, are taught only when there is a screen.
  for (const rule of ["get it done in the background", "only when it helps", "keep work they want to watch"]) {
    assert.equal(workbotInstructions(base).includes(rule), false)
    assert.ok(workbotInstructions({ ...base, browser: true }).includes(rule))
  }
})
