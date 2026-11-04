import { afterAll, afterEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { DynamicToolUIPart, UIMessage } from "ai"
import { computerHandedBackFiles, collectComputerSessionHistory, computerActionMarks, showsLiveComputerView, withoutComputerHistory } from "../src/lib/computer-session-history"
import { parseDynamicToolUIPart, withToolAttachmentOwner } from "../src/react-app/domains/session/sync/parse-tool-parts"
import { browserHistoryMessages, computerHistoryMessages } from "../test-fixtures/computer-session-history-data"

GlobalRegistrator.register({ url: "https://web.example/" })
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
const { ComputerSessionHistory, attachFileToComposer } = await import("../src/components/chat/computer-session-history")
const { useComposerStateStore } = await import("../src/react-app/domains/session/surface/composer-state-store")
const { TooltipProvider } = await import("../src/components/ui/tooltip")
const { useComputerSessionHistoryStore } = await import("../src/components/chat/computer-session-history-store")
const images = ["first", "second", "third"].map(value => `data:image/png;base64,${btoa(value)}`)
let mounted: { root: Root; container: HTMLElement } | null = null
afterEach(async () => {
  if (mounted) { await act(async () => mounted!.root.unmount()); mounted.container.remove(); mounted = null }
})
afterAll(() => { Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); GlobalRegistrator.unregister() })

test("each captured view shows where its own clicks landed and the paths its drags took", () => {
  const act = (id: string, input: Record<string, unknown>): DynamicToolUIPart => ({ type: "dynamic-tool", toolName: "computer_act", toolCallId: id, state: "output-available", input, output: '{"ok":true}' })
  const stroke = act("stroke", { observation_id: "o1", action: { type: "drag", path: [{ x: 10, y: 20 }, { x: 30, y: 40 }], smooth: true } })
  const batch = act("batch", { observation_id: "o2", actions: [{ type: "click", x: 5, y: 6 }, { type: "press", ref: "e1" }, { type: "scroll", x: 7, y: 8, delta_x: 0, delta_y: -3 }] })
  const same = act("same", { observation_id: "o3", action: { type: "double_click", x: 9, y: 9 } })
  const view = (image: string, id: string) => withToolAttachmentOwner([{ type: "file", mediaType: "image/png", url: image }], id)
  const history = collectComputerSessionHistory([{ id: "a", role: "assistant", parts: [
    stroke, ...view(images[0]!, "stroke"), batch, ...view(images[1]!, "batch"), ...view(images[2]!, "batch"), same, ...view(images[2]!, "same"),
  ] }])!
  expect(history.frames.map(frame => frame.marks)).toEqual([
    [{ kind: "path", points: [{ x: 10, y: 20 }, { x: 30, y: 40 }] }],
    [{ kind: "point", x: 5, y: 6 }, { kind: "point", x: 7, y: 8 }],
    // A second capture of the same act carries no marks; an unchanged view keeps the next act's.
    [{ kind: "point", x: 9, y: 9 }],
  ])
  expect(computerActionMarks({ ...batch, toolName: "browser_act" })).toEqual([])
})

test("refusals that only ask the agent to look again join the card, with each step's thinking, purpose and latest intent", () => {
  const call = (id: string, name: string, input: Record<string, unknown>, output: string, failure = false): DynamicToolUIPart => ({
    type: "dynamic-tool", toolName: name, toolCallId: id, state: "output-available", input, output,
    ...(failure ? { callProviderMetadata: { openwork: { computerFailure: true } } } : {}),
  })
  const view = (image: string, id: string) => withToolAttachmentOwner([{ type: "file", mediaType: "image/png", url: image }], id)
  const opened = call("open", "computer_open", { app_id: "photocraft", purpose: "Draw a neon skyline" }, '{"ok":true}')
  const refused = call("refused", "computer_act", { observation_id: "o1", intent: "Type the title" },
    '{"ok":false,"code":"focus_required","next":"observe"}\n{"post_observation":{"ok":true}}', true)
  const blocked = call("blocked", "computer_act", { observation_id: "o2", intent: "Sign in" }, '{"ok":false,"code":"credential_declined","next":"human_takeover"}', true)
  const drew = call("drew", "computer_act", { observation_id: "o3", intent: "Draw the towers" }, '{"ok":true}')
  const messages: UIMessage[] = [{ id: "a", role: "assistant", parts: [
    opened, { type: "reasoning", text: "The title field needs focus first." }, refused, ...view(images[0]!, "refused"),
    blocked, { type: "reasoning", text: "Towers next, left to right." }, drew, ...view(images[1]!, "drew"),
  ] }]
  const history = collectComputerSessionHistory(messages, { thinking: true })!
  expect(history.parts.map(part => part.toolCallId)).toEqual(["open", "refused", "drew"])
  expect(withoutComputerHistory(messages[0]!.parts, history)).toContain(blocked)
  expect(history.frames.map(frame => [frame.label, frame.thinking])).toEqual([
    ["Type the title", "The title field needs focus first."],
    ["Draw the towers", "Towers next, left to right."],
  ])
  expect(history.purpose).toBe("Draw a neon skyline")
  expect(history.latest).toBe("Draw the towers")
  expect(collectComputerSessionHistory(messages)!.frames.every(frame => frame.thinking === undefined)).toBe(true)
})

test("one history spans narration and message boundaries, retaining only its own raster attachments", () => {
  const messages = computerHistoryMessages(images)
  const unrelated: UIMessage["parts"][number] = { type: "file", url: images[0]!, mediaType: "image/png" }
  messages[2]!.parts.push(unrelated)
  const history = collectComputerSessionHistory(messages)!
  expect(history.parts).toHaveLength(4)
  expect(history.frames).toHaveLength(3)
  expect(history.durationMs).toBe(4000)
  const remaining = messages.flatMap(message => withoutComputerHistory(message.parts, history))
  expect(remaining).toContain(unrelated)
  expect(remaining.filter(part => part.type === "text")).toHaveLength(4)
  expect(remaining.filter(part => part.type === "dynamic-tool")).toHaveLength(0)
  expect(withoutComputerHistory(messages[2]!.parts, null)).toBe(messages[2]!.parts)
})

test("failed, denied, waiting and native error results stay out of the card", () => {
  const base: DynamicToolUIPart = { type: "dynamic-tool", toolName: "computer_act", toolCallId: "failed", state: "output-available", input: {}, output: '{"ok":false,"message":"Observe again"}' }
  const parts: UIMessage["parts"] = [base,
    { ...base, toolCallId: "error", state: "output-error", errorText: "Stopped" },
    { ...base, toolCallId: "native", output: "failure", callProviderMetadata: { openwork: { computerFailure: true } } },
    { type: "dynamic-tool", toolName: "computer_act", toolCallId: "approval", state: "approval-requested", input: {}, approval: { id: "approval" } },
    { type: "dynamic-tool", toolName: "computer_act", toolCallId: "denied", state: "output-denied", input: {}, approval: { id: "denied", approved: false } },
  ]
  expect(collectComputerSessionHistory([{ id: "failures", role: "assistant", parts }])).toBeNull()
})

test("browser steps keep their own chat rows and never join the computer card", () => {
  expect(collectComputerSessionHistory(browserHistoryMessages(images))).toBeNull()
  // The fixtures share call ids; give the browser turn its own so only the tool name differs.
  const browser = browserHistoryMessages(images).map(message => ({ ...message, id: `browser-${message.id}`, parts: message.parts.map(part =>
    part.type === "dynamic-tool" ? { ...part, toolCallId: `browser-${part.toolCallId}` }
      : part.type === "file" ? { ...part, providerMetadata: { openwork: { toolCallId: `browser-${part.providerMetadata?.openwork?.toolCallId}` } } } : part) }))
  const mixed = [...browser, ...computerHistoryMessages(images)]
  const history = collectComputerSessionHistory(mixed)!
  expect(history.parts.every(part => part.toolName.startsWith("computer_"))).toBe(true)
  expect(history.frames).toHaveLength(3)
  const remaining = mixed.flatMap(message => withoutComputerHistory(message.parts, history))
  expect(remaining.filter(part => part.type === "dynamic-tool").map(part => part.type === "dynamic-tool" && part.toolName))
    .toEqual(["browser_open", "browser_observe", "browser_act", "browser_observe", "browser_act", "browser_observe"])
  expect(remaining.filter(part => part.type === "file")).toHaveLength(3)
})

test("duplicate observations share a view, while returning to an earlier screen remains chronological", () => {
  const messages = computerHistoryMessages([images[0]!, images[0]!, images[1]!])
  messages[3]!.parts.push(...withToolAttachmentOwner([{ type: "file", mediaType: "image/png", url: images[0]! }], "clouds"))
  expect(collectComputerSessionHistory(messages)!.frames.map(frame => frame.file.url)).toEqual([images[0], images[1], images[0]])
})

test("native timing and failure metadata survive hydration", () => {
  const part = parseDynamicToolUIPart({ type: "tool", id: "part", sessionID: "session", messageID: "message", callID: "call", tool: "computer_observe",
    state: { status: "completed", input: {}, output: "unavailable", title: "Computer", metadata: { isError: true }, time: { start: 100, end: 150 } } })!
  expect(part.callProviderMetadata?.openwork).toMatchObject({ toolStartedAt: 100, toolCompletedAt: 150, computerFailure: true })
})

async function mount(messages = computerHistoryMessages(images), active = false) {
  const history = collectComputerSessionHistory(messages)!
  const container = document.createElement("div"); document.body.append(container)
  const root = createRoot(container); mounted = { root, container }
  const render = async (next = history) => { await act(async () => root.render(createElement(TooltipProvider, { children: createElement(ComputerSessionHistory, { history: next, active, renderAction: part => createElement("p", {}, part.toolCallId) }) }))) }
  await render()
  const click = async (label: string) => {
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    expect(button).not.toBeNull(); await act(async () => button!.click())
  }
  return { container, render, click }
}

test("the card starts collapsed, plays only on request, scrubs and exposes the original actions", async () => {
  const { container, click } = await mount()
  expect(container.querySelector('[aria-label="Play captured views"]')).toBeNull()
  await click("View computer session history")
  expect(container.querySelector('[data-computer-view-count]')?.textContent).toBe("3 / 3")
  await click("Play captured views")
  expect(container.querySelector('[data-computer-view-count]')?.textContent).toBe("1 / 3")
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1650)) })
  expect(container.querySelector('[data-computer-view-count]')?.textContent).toBe("2 / 3")
  await click("Pause captured views")
  expect(container.querySelector('[aria-label="Play captured views"]')).not.toBeNull()
  const slider = container.querySelector<HTMLInputElement>('input[type="range"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "2"); slider.dispatchEvent(new Event("input", { bubbles: true })) })
  expect(container.querySelector('[data-computer-view-count]')?.textContent).toBe("3 / 3")
  await click("View computer actions")
  expect(container.textContent).toContain("landscape")
  expect(container.textContent).toContain("clouds")
})

test("browsing pins a capture while live work gains frames; missing screenshots remain inspectable", async () => {
  const messages = computerHistoryMessages(images)
  const { container, render, click } = await mount(messages, true)
  await click("View computer session history")
  const slider = container.querySelector<HTMLInputElement>('input[type="range"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "1"); slider.dispatchEvent(new Event("input", { bubbles: true })) })
  messages[3]!.parts.push(...withToolAttachmentOwner([{ type: "file", mediaType: "image/png", url: `${images[2]}extra` }], "clouds"))
  await render(collectComputerSessionHistory(messages)!)
  expect(container.querySelector('[data-computer-view-count]')?.textContent).toBe("2 / 4")
  const noViews = collectComputerSessionHistory([{ id: "no-views", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "computer_observe", toolCallId: "observe", state: "input-available", input: {} }] }])!
  await render(noViews)
  expect(container.textContent).toContain("Using computer")
  expect(container.textContent).toContain("No captured views")
})

test("streaming transcript updates do not keep restarting playback", async () => {
  const { container, render, click } = await mount(computerHistoryMessages(images), true)
  await click("View computer session history"); await click("Play captured views")
  for (let update = 0; update < 3; update++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 390)) })
    await render(collectComputerSessionHistory(computerHistoryMessages(images))!)
  }
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)) })
  expect(container.querySelector('[data-computer-view-count]')?.textContent).toBe("2 / 3")
})

test("with two apps in one session, each step names the app it ran in", async () => {
  const call = (id: string, name: string, input: Record<string, unknown>, output: unknown): DynamicToolUIPart =>
    ({ type: "dynamic-tool", toolName: name, toolCallId: id, state: "output-available", input, output: JSON.stringify(output) })
  const view = (image: string, id: string) => withToolAttachmentOwner([{ type: "file", mediaType: "image/png", url: image }], id)
  const history = collectComputerSessionHistory([{ id: "a", role: "assistant", parts: [
    call("ps", "computer_open", { app_id: "com.adobe.Photoshop", purpose: "Turn the image into a PDF" }, { ok: true, session_id: "s-ps", app_name: "Photoshop" }), ...view(images[0]!, "ps"),
    call("pv", "computer_open", { app_id: "com.apple.Preview", purpose: "Export the PDF" }, { ok: true, session_id: "s-pv", app_name: "Preview" }),
    call("export", "computer_act", { observation_id: "o1", intent: "Export as PDF", action: { type: "menu", path: ["File", "Export as PDF…"] } }, { ok: true }), ...view(images[1]!, "export"),
    call("back", "computer_act", { session_id: "s-ps", observation_id: "o2", intent: "Check the image", action: { type: "press", ref: "e1" } }, { ok: true }), ...view(images[2]!, "back"),
  ] }])!
  expect(history.apps).toEqual(["Photoshop", "Preview"])
  expect(history.frames.map(frame => [frame.app, frame.label])).toEqual([["Photoshop", "Opened Photoshop"], ["Preview", "Export as PDF"], ["Photoshop", "Check the image"]])
  const container = document.createElement("div"); document.body.append(container)
  const root = createRoot(container); mounted = { root, container }
  await act(async () => root.render(createElement(TooltipProvider, { children: createElement(ComputerSessionHistory, { history, active: false, renderAction: part => createElement("p", {}, part.toolCallId) }) })))
  expect(container.querySelector("[data-computer-session-apps]")?.textContent).toBe("Photoshop, Preview")
  await act(async () => container.querySelector<HTMLElement>('[aria-label="View computer session history"]')!.click())
  expect(container.querySelector("[data-computer-view-step]")?.textContent).toContain("Photoshop · Check the image")
  // One app: no names, as before.
  const single = collectComputerSessionHistory([{ id: "b", role: "assistant", parts: [call("one", "computer_open", { app_id: "notes", purpose: "Write" }, { ok: true, session_id: "s", app_name: "Notes" }), ...view(images[0]!, "one")] }])!
  await act(async () => root.render(createElement(TooltipProvider, { children: createElement(ComputerSessionHistory, { history: single, active: false, renderAction: () => null }) })))
  expect(container.querySelector("[data-computer-session-apps]")).toBeNull()
  expect(container.querySelector("[data-computer-view-app]")).toBeNull()
})

test("with the card on, the live computer view opens from the card or when the person is needed", () => {
  const working = { state: "active" }
  expect(showsLiveComputerView({ historyEnabled: false, watching: false, session: working })).toBe(true)
  expect(showsLiveComputerView({ historyEnabled: true, watching: false, session: working })).toBe(false)
  expect(showsLiveComputerView({ historyEnabled: true, watching: true, session: working })).toBe(true)
  expect(showsLiveComputerView({ historyEnabled: true, watching: false, session: { state: "paused" } })).toBe(true)
})

test("the card offers the live view only for a working computer, and toggles it", async () => {
  const history = collectComputerSessionHistory(computerHistoryMessages(images))!
  const container = document.createElement("div"); document.body.append(container)
  const root = createRoot(container); mounted = { root, container }
  const chosen: boolean[] = []
  const render = async (next = history, live?: { watching: boolean; onWatch: (watching: boolean) => void }) => {
    await act(async () => root.render(createElement(TooltipProvider, { children: createElement(ComputerSessionHistory, { history: next, active: true, renderAction: part => createElement("p", {}, part.toolCallId), live }) })))
  }
  const button = () => Array.from(container.querySelectorAll("button")).find(item => /live/i.test(item.textContent ?? ""))
  await render()
  expect(button()).toBeUndefined()
  await render(history, { watching: false, onWatch: watching => chosen.push(watching) })
  expect(button()?.textContent).toBe("Watch live")
  await act(async () => button()!.click())
  expect(chosen).toEqual([true])
  expect(container.querySelector('[data-computer-view-count]')).toBeNull()
  await render(history, { watching: true, onWatch: watching => chosen.push(watching) })
  expect(button()?.textContent).toBe("Hide live view")
})

test("the live view choice is per chat and clears without touching other chats", () => {
  const store = useComputerSessionHistoryStore.getState()
  store.setWatching("chat", true); store.setWatching("other", true)
  const before = useComputerSessionHistoryStore.getState().watching
  store.setWatching("chat", true)
  expect(useComputerSessionHistoryStore.getState().watching).toBe(before)
  store.setWatching("chat", false)
  expect(useComputerSessionHistoryStore.getState().watching).toEqual({ other: true })
  store.setWorking("chat", true)
  expect(useComputerSessionHistoryStore.getState().working).toEqual({ chat: true })
  store.setWorking("chat", false); store.setWatching("other", false)
})

test("the card lists the files its session saved, each once, with Open, Show in Finder and Attach to chat", async () => {
  const step = (id: string, output: unknown, toolName = "computer_act"): DynamicToolUIPart =>
    ({ type: "dynamic-tool", toolName, toolCallId: id, state: "output-available", input: { observation_id: id, action: { type: "save_as", path: "/x" } }, output })
  const saved = (path: string, bytes: number) => ({ ok: true, status: "dispatched", path: "file_saved", saved_file: { path, bytes } })
  const history = collectComputerSessionHistory([{ id: "a", role: "assistant", parts: [
    step("first", `${JSON.stringify(saved("/Users/me/Desktop/report.pdf", 2048))}\n{"post_observation":{"ok":true}}`),
    step("chart", saved("/Users/me/Desktop/chart.png", 10)),
    // Pressed Save but never found on disk, refused, or from the browser: not handed back.
    step("unconfirmed", { ok: true, path: "file_save_unconfirmed", saved_file: { path: "/Users/me/ghost.pdf", bytes: 1 } }),
    step("refused", { ok: false, code: "file_exists", next: "correct_request", saved_file: { path: "/Users/me/old.pdf", bytes: 1 } }),
    step("browser", saved("/Users/me/page.pdf", 1), "browser_act"),
    step("again", saved("/Users/me/Desktop/report.pdf", 4096)),
  ] }])!
  expect(history.savedFiles).toEqual([
    { path: "/Users/me/Desktop/report.pdf", name: "report.pdf", bytes: 4096 },
    { path: "/Users/me/Desktop/chart.png", name: "chart.png", bytes: 10 },
  ])

  const container = document.createElement("div"); document.body.append(container)
  const root = createRoot(container); mounted = { root, container }
  const calls: string[] = []
  const fileActions = { open: (path: string) => calls.push(`open ${path}`), reveal: (path: string) => calls.push(`reveal ${path}`), attach: (path: string) => calls.push(`attach ${path}`) }
  const render = async (next: typeof history, actions?: typeof fileActions) => {
    await act(async () => root.render(createElement(TooltipProvider, { children: createElement(ComputerSessionHistory, { history: next, active: false, renderAction: part => createElement("p", {}, part.toolCallId), fileActions: actions }) })))
  }
  const press = async (label: string) => act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click())
  await render(history, fileActions)
  // Shown without opening the card.
  expect(container.querySelector('[data-computer-view-count]')).toBeNull()
  const rows = [...container.querySelectorAll("[data-computer-saved-file]")]
  expect(rows.map(row => row.querySelector("[title]")?.getAttribute("title"))).toEqual(["/Users/me/Desktop/report.pdf", "/Users/me/Desktop/chart.png"])
  expect(rows[0]!.textContent).toContain("4 KB")
  await press("Open report.pdf"); await press("Show report.pdf in Finder"); await press("Attach chart.png to chat")
  expect(calls).toEqual(["open /Users/me/Desktop/report.pdf", "reveal /Users/me/Desktop/report.pdf", "attach /Users/me/Desktop/chart.png"])

  // Off the desktop the files are still named, with nothing to press.
  await render(history)
  expect(container.querySelectorAll("[data-computer-saved-file]")).toHaveLength(2)
  expect(container.querySelector('[aria-label="Open report.pdf"]')).toBeNull()
  await render(collectComputerSessionHistory(computerHistoryMessages(images))!, fileActions)
  expect(container.querySelector("[data-computer-saved-files]")).toBeNull()
})

test("the card also lists what scripts and shell commands wrote to the chat's output folder during its turn", async () => {
  const folder = "/Users/me/Downloads/OpenWork/chat"
  const step = (id: string, toolName: string, at: number, output: unknown = { ok: true }): DynamicToolUIPart =>
    ({ type: "dynamic-tool", toolName, toolCallId: id, state: "output-available", input: {}, output,
      callProviderMetadata: { openwork: { toolStartedAt: at, toolCompletedAt: at + 100 } } })
  const history = collectComputerSessionHistory([{ id: "a", role: "assistant", parts: [
    step("open", "computer_open", 10_000),
    step("script", "computer_script", 20_000),
    // A save elsewhere is listed from its receipt; an image saved into the folder is listed once, not twice.
    step("save", "computer_act", 30_000, { ok: true, path: "file_saved", saved_file: { path: "/Users/me/Desktop/map.png", bytes: 5 } }),
    step("shot", "computer_act", 40_000, { ok: true, path: "file_saved", saved_file: { path: `${folder}/flyer.png`, bytes: 7, width: 800, height: 600 } }),
  ] }])!
  const listed = [
    { path: `${folder}/deck.pptx`, bytes: 300, modifiedAt: 60_000 }, // copied in by a shell command after the session
    { path: `${folder}/flyer.png`, bytes: 900, modifiedAt: 50_000 }, // the save_image file, edited again by a script
    { path: `${folder}/old.txt`, bytes: 1, modifiedAt: 5_000 }, // from before this session
    { path: `${folder}/next-turn.png`, bytes: 1, modifiedAt: 200_000 }, // a later turn's
  ]
  expect(computerHandedBackFiles(history, listed, 100_000)).toEqual([
    { path: `${folder}/deck.pptx`, name: "deck.pptx", bytes: 300 },
    { path: `${folder}/flyer.png`, name: "flyer.png", bytes: 900 },
    { path: "/Users/me/Desktop/map.png", name: "map.png", bytes: 5 },
  ])
  // While the turn runs everything since the first step counts; with no folder, only receipts.
  expect(computerHandedBackFiles(history, listed, null).map(file => file.name)).toEqual(["next-turn.png", "deck.pptx", "flyer.png", "map.png"])
  expect(computerHandedBackFiles(history, [], null)).toEqual(history.savedFiles)
  // From the turn's start: what a subagent saved in the chat's folder before the chat's own first step.
  const subagent = { path: `${folder}/place.png`, bytes: 2, modifiedAt: 8_000 }
  expect(computerHandedBackFiles(history, [...listed, subagent], 100_000, 7_500).map(file => file.name)).toEqual(["deck.pptx", "flyer.png", "map.png", "place.png"])

  const container = document.createElement("div"); document.body.append(container)
  const root = createRoot(container); mounted = { root, container }
  let reads = 0
  const fileActions = { open: () => {}, reveal: () => {}, attach: () => {}, list: async () => { reads++; return listed } }
  const render = async (turnEndedAt: number | null) => act(async () => root.render(createElement(TooltipProvider, { children: createElement(ComputerSessionHistory,
    { history, active: false, renderAction: part => createElement("p", {}, part.toolCallId), fileActions, turnEndedAt }) })))
  await render(100_000)
  const names = () => [...container.querySelectorAll("[data-computer-saved-file] [title]")].map(item => item.getAttribute("title"))
  expect(names()).toEqual([`${folder}/deck.pptx`, `${folder}/flyer.png`, "/Users/me/Desktop/map.png"])
  expect(container.querySelector('[aria-label="Open deck.pptx"]')).not.toBeNull()
  // Rendering again with nothing new does not read the folder again.
  await render(100_000)
  expect(reads).toBe(1)
})

test("attaching a saved file puts it in that chat's composer once, as a file mention", () => {
  const store = useComposerStateStore.getState()
  store.setDraft("chat", "Summarize")
  attachFileToComposer("chat", "/Users/me/My Report.pdf")
  attachFileToComposer("chat", "/Users/me/My Report.pdf")
  const state = useComposerStateStore.getState()
  expect(state.sessions.chat?.draft).toBe("Summarize @/Users/me/My%20Report.pdf ")
  expect(state.sessions.chat?.mentions).toEqual({ "/Users/me/My Report.pdf": "file" })
  expect(state.pendingFocusSessionId).toBe("chat")
  expect(state.sessions.other).toBeUndefined()
  store.clearSession("chat"); useComposerStateStore.setState({ pendingFocusSessionId: null })
})
