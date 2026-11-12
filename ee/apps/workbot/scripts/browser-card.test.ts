import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import type { RunnerSnapshot } from "@openwork-ee/headless-protocol"
import { buildWorkbotTurns, toWorkbotPageEvent } from "@openwork-ee/workbot-server"
import { browserTask, computerWork, finishedSummary, keepsCard, nextWorking, taskHeader } from "../../../packages/workbot-ui/src/computer-work.js"
import { workbotActivity } from "../../../packages/workbot-ui/src/activity.js"
import { threadSchema, type LiveText, type WorkbotTurn } from "../../../packages/workbot-ui/src/data.js"

/**
 * Ben, Nov 8: "Could you go on google.com with browser". The card showed "Computer", then "Browser", and was gone
 * from the chat once Workbot was done. These follow that request from the runner's first live event to a reload.
 */

const ask = "Could you go on google.com with browser"
const open = { view: "browser", operation: "open", args: { url: "https://www.google.com/" }, description: "Opening google.com" }

/** The runner's live events for that call, in the order a streamed call writes them (view first, as the schema lists it). */
const runnerEvents = [
  { type: "tool", messageId: "wb_g1", step: 0, tool: "desktop" },
  { type: "tool", messageId: "wb_g1", step: 0, tool: "desktop", view: "browser" },
  { type: "tool", messageId: "wb_g1", step: 0, tool: "desktop", view: "browser", description: "Opening google.com" },
]

const working = (parts: WorkbotTurn["parts"] = [], modelSteps = 0): WorkbotTurn => ({
  id: "g1", text: ask, status: "working", sentAt: 100, finishedAt: null, parts, modelSteps, attachments: [], outputs: [], reaction: null,
  error: null, retryable: false, greeting: false, suggestions: [], tasks: [], navigation: [],
})

/** The surfaces of the cards the reply shows, and their titles' kind, after each live event. */
function cardsAfterEachEvent(events: unknown[]) {
  let live: LiveText | undefined
  return events.map((raw) => {
    const event = toWorkbotPageEvent(raw)
    assert.ok(event && event.type === "working")
    live = { step: event.step, text: "", working: nextWorking(live?.working, event) }
    const work = computerWork([], { working: true, starting: live.working!, lastIsLive: false })
    return [...work.cards.entries()].map(([surface, card]) => [surface, card.steps[0]?.label, card.steps[0]?.surface ?? null])
  })
}

test("a browser action is the Browser card from its first frame, never Computer first", () => {
  const frames = cardsAfterEachEvent(runnerEvents)
  // Before the call says where it works, there is no card to guess with; from then on, only the browser's.
  assert.deepEqual(frames, [
    [],
    [["browser", "Using the browser", "browser"]],
    [["browser", "Using the browser", "browser"]],
  ])
  assert.ok(frames.flat().every(([surface]) => surface !== "computer"), "never a Computer card for browser work")
})

test("once it knows it is the browser, a later event without the view keeps it", () => {
  const known = nextWorking(undefined, { on: "computer", surface: "browser" }, 1)
  assert.deepEqual(nextWorking(known, { on: "computer", update: "Opening google.com" }, 2), { on: "computer", since: 2, surface: "browser", update: "Opening google.com" })
  // A different kind of work starts over.
  assert.deepEqual(nextWorking(known, { on: "computer", background: true }, 3), { on: "computer", since: 3, background: true })
})

test("the status line names the browser from the first frame too, and says nothing before it knows", () => {
  const turns = [working()]
  const at = (working: LiveText["working"]) => workbotActivity(turns, { g1: { step: 0, text: "", working } })
  const unknown = at({ on: "computer", since: 1 })
  assert.deepEqual([unknown.label, unknown.icon, unknown.watch], ["Thinking", "thinking", null])
  const browser = at({ on: "computer", since: 1, surface: "browser" })
  assert.deepEqual([browser.label, browser.icon, browser.watch], ["Using the browser", "browser", "browser"])
  const described = at({ on: "computer", since: 1, surface: "browser", update: "Opening google.com" })
  assert.deepEqual([described.label, described.icon], ["Opening google.com", "browser"])
})

test("the stored step keeps the same Browser card the live one started", () => {
  const [turn] = buildWorkbotTurns({
    status: "busy", finalAssistantText: "", hasEarlier: false,
    turns: [{ messageId: "wb_g1", status: "running", createdAt: 100, error: null }],
    messages: [
      { messageId: "wb_g1", role: "user", text: ask },
      { messageId: "wb_g1", role: "assistant", text: "", createdAt: 110, toolCalls: [{ id: "d1", name: "desktop", input: open }] },
    ],
  } satisfies RunnerSnapshot) as WorkbotTurn[]
  const work = computerWork(turn!.parts, { working: true, starting: null, lastIsLive: true })
  assert.deepEqual([...work.cards.keys()], ["browser"])
  assert.deepEqual([...work.live], ["browser"])
})

/** The finished conversation, as the runner stores it. */
const finished = {
  status: "idle", finalAssistantText: "", hasEarlier: false,
  turns: [{ messageId: "wb_g1", status: "completed", createdAt: 100, updatedAt: 200, error: null }],
  messages: [
    { messageId: "wb_g1", role: "user", text: ask },
    { messageId: "wb_g1", role: "assistant", text: "", createdAt: 110, toolCalls: [{ id: "d1", name: "desktop", input: open }] },
    { messageId: "wb_g1", role: "tool", callId: "d1", name: "desktop", isError: false, createdAt: 120 },
    { messageId: "wb_g1", role: "assistant", text: "Done: google.com is open in my browser.", createdAt: 130, toolCalls: [] },
  ],
} satisfies RunnerSnapshot

/** What the chat keeps of a finished reply: the cards it shows, with and without the flags. */
function shownCards(turn: WorkbotTurn, flags: { quiet: boolean; preview: boolean }) {
  const work = computerWork(turn.parts, { working: false, starting: null, lastIsLive: false })
  return [...work.cards.entries()]
    .map(([surface, card]) => ({ surface, live: work.live.has(surface), showing: work.shown === surface, steps: card.steps }))
    .filter((card) => keepsCard(card, flags))
}

test("the finished browser card stays in the transcript, as a record of what it opened", () => {
  const [turn] = buildWorkbotTurns(finished) as WorkbotTurn[]
  assert.equal(turn!.status, "done")
  for (const flags of [{ quiet: false, preview: false }, { quiet: true, preview: false }, { quiet: true, preview: true }, { quiet: false, preview: true }]) {
    const cards = shownCards(turn!, flags)
    assert.deepEqual(cards.map((card) => [card.surface, card.live]), [["browser", false]], `kept with ${JSON.stringify(flags)}`)
    assert.equal(finishedSummary("browser", cards[0]!.steps), "Opened google.com")
  }
})

test("the finished card survives a reload: it is read back from the stored conversation, not live state", () => {
  // A reload reads the thread again (GET /v1/workbot) and the page parses it; nothing live is left.
  const thread = { available: true, name: "Workbot", organizationName: "Example", status: "idle", hasEarlier: false, filesEnabled: true, turns: buildWorkbotTurns(finished) }
  const reread = threadSchema.parse(JSON.parse(JSON.stringify(thread)))
  assert.equal(reread.available, true)
  const [turn] = reread.available ? reread.turns : []
  const cards = shownCards(turn!, { quiet: true, preview: true })
  assert.equal(cards.length, 1)
  assert.equal(cards[0]!.surface, "browser")
  assert.deepEqual(cards[0]!.steps.flatMap((step) => step.pages ?? []).map((page) => page.url), ["https://www.google.com/"])
  assert.equal(finishedSummary("browser", cards[0]!.steps), "Opened google.com")
})

test("which cards a quiet chat keeps: live screens only when shown or previewed, finished screens always, background never", () => {
  const quiet = { quiet: true, preview: false }
  assert.equal(keepsCard({ surface: "browser", live: true, showing: false }, quiet), false, "live work stays under Workbot's name, not pushed into the chat")
  assert.equal(keepsCard({ surface: "browser", live: true, showing: false }, { quiet: true, preview: true }), true)
  assert.equal(keepsCard({ surface: "browser", live: true, showing: true }, quiet), true)
  assert.equal(keepsCard({ surface: "browser", live: false, showing: false }, quiet), true)
  assert.equal(keepsCard({ surface: "computer", live: false, showing: false }, quiet), true)
  assert.equal(keepsCard({ surface: "background", live: false, showing: false }, quiet), false)
  assert.equal(keepsCard({ surface: "background", live: true, showing: false }, { quiet: true, preview: true }), false)
  assert.equal(keepsCard({ surface: "background", live: false, showing: false }, { quiet: false, preview: false }), true)
})

test("a finished card says what it came to", () => {
  const step = (extra: Record<string, unknown>) => ({ label: "Using the browser", icon: "computer" as const, status: "done" as const, app: null, startedAt: 1, finishedAt: 2, updates: [], ...extra })
  const page = (id: string, title: string) => ({ id, url: `https://${title}/`, title })
  assert.equal(finishedSummary("browser", [step({ pages: [page("a", "google.com"), page("b", "maps.google.com"), page("a", "google.com")] })]), "Opened maps.google.com and 1 more")
  assert.equal(finishedSummary("browser", [step({ updates: ["Reading the page"] })]), "Reading the page")
  assert.equal(finishedSummary("browser", [step({})]), "Used the browser")
  assert.equal(finishedSummary("computer", [step({})]), "Used my computer")
})

test("one browser task stays anchored at its first action through narration, later actions and completion", () => {
  const [turn] = buildWorkbotTurns(finished)
  assert.ok(turn)
  const initial = turn.parts.find(part => part.kind === "steps")
  assert.ok(initial?.kind === "steps")
  const parts = [
    { kind: "text" as const, text: "Checking the page." }, initial,
    { kind: "text" as const, text: "Reading more." }, initial,
    { kind: "text" as const, text: "Finished." },
  ]
  for (const working of [true, false]) {
    const work = computerWork(parts, { working, starting: working ? { on: "computer", since: 200, surface: "browser" } : null, lastIsLive: false })
    assert.equal(work.cards.size, 1)
    assert.equal(work.cards.get("browser")?.steps.length, 2)
    assert.deepEqual([...work.placed], [[1, ["browser"]]])
    assert.deepEqual(work.trailing, [])
  }
})

/** Mirrors screen.tsx: the browser task object first, followed by its acknowledgment and narration. */
function assembledKeys(parts: WorkbotTurn["parts"], working: boolean, starting: LiveText["working"] | null, liveText = "") {
  const work = computerWork(parts, { working, starting, lastIsLive: false })
  const keys: string[] = work.cards.has("browser") ? ["card-browser"] : []
  parts.forEach((part, index) => {
    if (part.kind === "text") { keys.push(`text-${part.step ?? `part-${index}`}`); return }
    for (const surface of work.placed.get(index) ?? []) if (surface !== "browser") keys.push(`card-${surface}`)
  })
  if (liveText) keys.push("text-live")
  for (const surface of work.trailing) keys.push(`card-${surface}`)
  return keys
}

test("screen assembly keeps the same browser card above its acknowledgment from streamed words through storage", () => {
  const [turn] = buildWorkbotTurns(finished)
  assert.ok(turn)
  const first = turn.parts.find(part => part.kind === "steps")
  assert.ok(first?.kind === "steps")
  const starting: LiveText["working"] = { on: "computer", since: 100, surface: "browser" }
  assert.deepEqual(assembledKeys([], true, starting), ["card-browser"])
  assert.deepEqual(assembledKeys([], true, starting, "Checking the page"), ["card-browser", "text-live"])
  assert.deepEqual(assembledKeys([first], true, null), ["card-browser"])
  const preamble = { kind: "text" as const, text: "I'll check.", step: 0 }
  assert.deepEqual(assembledKeys([preamble], true, starting, "Checking the page"), ["card-browser", "text-0", "text-live"])
  assert.deepEqual(assembledKeys([preamble, first], true, null, "Reading more"), ["card-browser", "text-0", "text-live"])
  const narrated = [preamble, first, { kind: "text" as const, text: "Reading more.", step: 1 }, first]
  assert.deepEqual(assembledKeys(narrated, true, null), ["card-browser", "text-0", "text-1"])
  assert.deepEqual(assembledKeys(narrated, false, null), ["card-browser", "text-0", "text-1"])
})

test("browser task has one title through Working, Completed and Failed, without claiming interrupted work completed", () => {
  const title = "Check the page"
  assert.deepEqual(browserTask([], { title, working: true }), { title, status: "working" })
  assert.deepEqual(browserTask([{ status: "done" }], { title, working: false, status: "done" }), { title, status: "completed" })
  assert.deepEqual(browserTask([{ status: "done", reason: "The browser action couldn't finish." }], { title, working: false }), { title, status: "failed", reason: "The browser action couldn't finish." })
  assert.equal(browserTask([{ status: "failed" }], { title, working: false }).status, "failed", "the helper also tolerates an older experimental failed status")
  for (const status of ["failed", "stopped"] as const) assert.equal(browserTask([{ status: "done" }], { title, working: false, status }).status, "failed")
  assert.equal(browserTask([{ status: "running" }], { title, working: false }).status, "failed")
})

test("a task the person rebuilt the computer under reads as stopped, not as a failure the rebuild didn't fix", () => {
  const failed = { status: "failed" as const, reason: "The computer action couldn't finish." }
  assert.deepEqual(taskHeader(failed, false), { status: "Failed", failed: true, reason: failed.reason })
  for (const task of [failed, { status: "working" as const }]) {
    const header = taskHeader(task, true)
    assert.deepEqual([header?.status, header?.failed], ["Stopped", false])
    assert.match(header?.reason ?? "", /rebuilt.*Ask again/)
  }
  assert.deepEqual(taskHeader({ status: "completed" }, true), { status: "Completed", failed: false }, "finished work stays finished")
  assert.equal(taskHeader({ status: "working" }, false), null, "a running task shows the live computer's state")
  assert.equal(taskHeader(undefined, true), null)
})

test("browser tool failures and cut-off calls survive server storage without leaking raw errors or becoming Computer", () => {
  for (const status of ["completed", "failed", "aborted"] as const) {
    for (const returned of [true, false]) {
      const [turn] = buildWorkbotTurns({
        ...finished,
        turns: [{ messageId: "wb_g1", status, createdAt: 100, updatedAt: 200, error: null }],
        messages: [
          ...finished.messages.slice(0, 2),
          ...(returned ? [{ messageId: "wb_g1", role: "tool" as const, callId: "d1", name: "desktop", isError: true, createdAt: 120, text: "secret provider error" }] : []),
        ],
      })
      assert.ok(turn)
      const steps = turn.parts.flatMap(part => part.kind === "steps" ? part.steps : [])
      assert.equal(steps[0]?.surface, "browser")
      assert.equal(steps[0]?.status, "done", "old clients must still parse the step's running|done enum")
      assert.ok(steps[0]?.reason)
      const oldStepSchema = z.object({ status: z.enum(["running", "done"]) })
      assert.deepEqual(oldStepSchema.parse(steps[0]), { status: "done" }, "already-open clients ignore the additive reason instead of rejecting the whole thread")
      assert.equal(JSON.stringify(turn).includes("secret provider error"), false)
      const task = browserTask(steps, { title: "Check the page", working: false, status: turn.status })
      assert.equal(task.status, "failed")
    }
  }
})
