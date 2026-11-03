import { afterAll, afterEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { DynamicToolUIPart, UIMessage } from "ai"
import { collectComputerSessionHistory, showsLiveComputerView, withoutComputerHistory } from "../src/lib/computer-session-history"
import { parseDynamicToolUIPart, withToolAttachmentOwner } from "../src/react-app/domains/session/sync/parse-tool-parts"
import { browserHistoryMessages, computerHistoryMessages } from "../test-fixtures/computer-session-history-data"

GlobalRegistrator.register({ url: "https://web.example/" })
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
const { ComputerSessionHistory } = await import("../src/components/chat/computer-session-history")
const { TooltipProvider } = await import("../src/components/ui/tooltip")
const { useComputerSessionHistoryStore } = await import("../src/components/chat/computer-session-history-store")
const images = ["first", "second", "third"].map(value => `data:image/png;base64,${btoa(value)}`)
let mounted: { root: Root; container: HTMLElement } | null = null
afterEach(async () => {
  if (mounted) { await act(async () => mounted!.root.unmount()); mounted.container.remove(); mounted = null }
})
afterAll(() => { Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); GlobalRegistrator.unregister() })

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

test("browser steps share the card, while a sign-in handoff and a failed step stay in the conversation", () => {
  const messages = browserHistoryMessages(images)
  const handoff: DynamicToolUIPart = { type: "dynamic-tool", toolName: "browser_handoff", toolCallId: "handoff", state: "output-available", input: {}, output: '{"ok":true}' }
  const failed: DynamicToolUIPart = { ...handoff, toolName: "browser_act", toolCallId: "failed", output: '{"ok":false,"code":"stale_observation"}' }
  messages[1]!.parts.push(handoff, failed)
  const history = collectComputerSessionHistory(messages)!
  expect(history.parts.map(part => part.toolName)).toEqual(["browser_open", "browser_observe", "browser_act", "browser_observe", "browser_act", "browser_observe"])
  expect(history.frames.map(frame => frame.label)).toEqual(["Checked the page", "Checked the page", "Checked the page"])
  const remaining = messages.flatMap(message => withoutComputerHistory(message.parts, history))
  expect(remaining.filter(part => part.type === "dynamic-tool")).toEqual([handoff, failed])
  expect(remaining.filter(part => part.type === "file")).toHaveLength(0)
  expect(remaining.filter(part => part.type === "text")).toHaveLength(3)
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
  const browser = parseDynamicToolUIPart({ type: "tool", id: "part", sessionID: "session", messageID: "message", callID: "call", tool: "browser_observe",
    state: { status: "completed", input: {}, output: "{}", title: "Browser observation", metadata: {}, time: { start: 100, end: 150 } } })!
  expect(browser.callProviderMetadata?.openwork).toMatchObject({ toolStartedAt: 100, toolCompletedAt: 150 })
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

test("the card says browser only while the whole turn stayed in the browser", async () => {
  const messages = browserHistoryMessages(images)
  const { container, render, click } = await mount(messages)
  expect(container.textContent).toContain("Used browser")
  expect(container.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Browser session history")
  await click("View browser session history")
  expect(container.querySelector('[data-computer-view-count]')?.textContent).toBe("3 / 3")
  await click("View browser actions")
  expect(container.textContent).toContain("third-look")
  await render(collectComputerSessionHistory([...messages, ...computerHistoryMessages(images)])!)
  expect(container.textContent).toContain("Used computer")
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
  await render(collectComputerSessionHistory(browserHistoryMessages(images))!, { watching: false, onWatch: () => {} })
  expect(button()).toBeUndefined()
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
