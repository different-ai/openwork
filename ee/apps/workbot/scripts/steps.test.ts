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
  assert.equal(browser?.reason, "The browser action couldn't finish.", "a later call still running must not erase the earlier failure")
  assert.equal(computer?.reason, undefined)
  // Once a later browser call works, Workbot got past the failed one: the step no longer reads as failed.
  const [recovered] = buildWorkbotTurns({ ...snapshot, messages: [...snapshot.messages, { messageId: "wb_listings", role: "tool", callId: "c4", name: "desktop", isError: false, createdAt: 160 }] })
  assert.equal(recovered?.parts.flatMap((part) => (part.kind === "steps" ? part.steps : [])).find((step) => step.surface === "browser")?.reason, undefined)
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

test("an App built in OpenWork shows among a reply's outputs, once, and only with workbotApps", () => {
  const app = { id: "cob_01kq8z0000000000000000000a", title: "Hello World Wave" }
  const call = (id: string, name: string) => ({ id, name, input: {} })
  const snapshot = {
    status: "idle", finalAssistantText: "", hasEarlier: false,
    turns: [{ messageId: "wb_app", status: "completed", createdAt: 100, updatedAt: 200, error: null }],
    messages: [
      { messageId: "wb_app", role: "user", text: "Make a hello world app" },
      { messageId: "wb_app", role: "assistant", text: "", createdAt: 110, toolCalls: [call("c1", "create_app"), call("c2", "update_app"), call("c3", "create_app")] },
      { messageId: "wb_app", role: "tool", callId: "c1", name: "create_app", isError: false, createdAt: 120, app },
      { messageId: "wb_app", role: "tool", callId: "c2", name: "update_app", isError: false, createdAt: 130, app: { ...app, title: "Hello World Wave 2.0" } },
      { messageId: "wb_app", role: "tool", callId: "c3", name: "create_app", isError: true, createdAt: 140, app: { id: "cob_01kq8z0000000000000000000b", title: "Failed" } },
      { messageId: "wb_app", role: "assistant", text: "Your app is ready.", createdAt: 150, toolCalls: [] },
    ],
  } satisfies RunnerSnapshot
  const [off] = buildWorkbotTurns(snapshot)
  assert.deepEqual(off?.outputs, [], "off: the reply is as before")
  const [on] = buildWorkbotTurns(snapshot, new Map(), new Map(), { apps: true })
  assert.deepEqual(on?.outputs, [{ id: `app:${app.id}`, name: "Hello World Wave 2.0", mediaType: "application/vnd.openwork.app", size: 0, updatedAt: 130 }])
})

test("Drive PDFs and Office files are pulled onto the computer only when there is one, and only with workbotDriveFiles", () => {
  const base = { name: "Workbot", organizationName: "Example", firstName: "Alex", timeZone: "UTC", canSchedule: false }
  const pull = "createGoogleDriveDownloadLink"
  const ask = "ask them to send it to you in this chat"
  // Off: Workbot's instructions are exactly as before, with or without a computer.
  assert.equal(workbotInstructions({ ...base, computer: true }), workbotInstructions(base))
  for (const phrase of [pull, ask]) assert.equal(workbotInstructions({ ...base, computer: true }).includes(phrase), false)

  const withComputer = workbotInstructions({ ...base, computer: true, driveFiles: true })
  for (const phrase of [pull, "createMicrosoft365DriveDownloadLink", "/workspace", "pdftotext", "never show or share it"]) assert.ok(withComputer.includes(phrase), phrase)
  // Read-only turns run without the computer even in a conversation that has one, so that case is covered too.
  assert.ok(withComputer.includes("read-only and have no computer"))
  assert.ok(withComputer.includes(ask))

  const withoutComputer = workbotInstructions({ ...base, driveFiles: true })
  assert.equal(withoutComputer.includes(pull), false, "no download path is offered without a computer")
  assert.equal(withoutComputer.includes("/workspace"), false)
  assert.equal(withoutComputer.includes("open it on your computer"), false, "a conversation without a computer is never pointed at one")
  assert.ok(withoutComputer.includes("too large or has no readable text"))
  assert.ok(withoutComputer.includes(ask))
  assert.ok(withoutComputer.includes("Never say you can't do anything with it."))
})
