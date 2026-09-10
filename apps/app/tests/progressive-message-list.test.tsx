/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act, StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { ProgressiveMessageList, type MessageListViewport } from "../src/components/chat/progressive-message-list"

const ownedDom = typeof window === "undefined"
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" })
const originalObserver = globalThis.ResizeObserver
const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
const frames = new Map<number, FrameRequestCallback>()
const observers = new Set<() => void>()
const cleanups: (() => Promise<void>)[] = []
let frameId = 0
let sessionId = 0

beforeEach(() => {
  spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++frameId, callback)
    return frameId
  })
  spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id) })
  Reflect.set(globalThis, "ResizeObserver", class {
    private targets = new Set<Element>()
    private emit: () => void
    constructor(callback: ResizeObserverCallback) {
      this.emit = () => callback([...this.targets].map((target) => ({
        target, contentRect: target.getBoundingClientRect(), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [],
      })), this)
      observers.add(this.emit)
    }
    observe(target: Element) { this.targets.add(target) }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() { this.targets.clear(); observers.delete(this.emit) }
  })
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  frames.clear()
  observers.clear()
  Reflect.set(globalThis, "ResizeObserver", originalObserver)
  mock.restore()
})

afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment)
  if (ownedDom) await GlobalRegistrator.unregister()
})

function runFrame() {
  const pending = [...frames.values()]
  frames.clear()
  for (const callback of pending) callback(0)
}

async function batch() {
  await act(async () => runFrame())
  await act(async () => runFrame())
}

type Group = { id: string; messages: { id: string; height: number }[] }
function groups(count = 80): Group[] {
  return Array.from({ length: count }, (_, index) => ({ id: `g${index}`, messages: [{ id: `m${index}`, height: 240 }] }))
}

function fixture(initial = groups(), options: Partial<MessageListViewport> = {}, strict = false) {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  let data = initial
  let top = 0
  let width = options.viewportWidth ?? 600
  let sticky = false
  let unmounted = false
  const writes: number[] = []
  const ready = mock(() => {})
  const rendered: number[] = []
  let viewport: MessageListViewport = {
    sessionKey: `progressive-${++sessionId}`, scrollRef: { current: container }, viewportWidth: width,
    historyComplete: true, stickyBottom: () => sticky, onReady: ready, ...options,
  }
  const messageHeight = (node: Element) => {
    const id = node.getAttribute("data-message-id")
    return data.flatMap((group) => group.messages).find((message) => message.id === id)?.height ?? 0
  }
  const height = (node: Element): number => {
    if (node instanceof HTMLElement && node.hasAttribute("data-thread-placeholder")) return Number.parseFloat(node.style.height) || 0
    if (node.hasAttribute("data-message-id")) return messageHeight(node)
    if (node.hasAttribute("data-thread-group")) return [...node.children].reduce((sum, child) => sum + height(child), 0)
    const children = [...node.children]
    return children.reduce((sum, child) => sum + height(child), 0) + Math.max(0, children.length - 1) * 8
  }
  const contentTop = (node: Element): number => {
    if (node === container || node.parentElement === container) return 0
    let offset = node.parentElement ? contentTop(node.parentElement) : 0
    let sibling = node.previousElementSibling
    while (sibling) {
      offset += height(sibling) + (node.parentElement?.hasAttribute("data-thread-history-complete") ? 8 : 0)
      sibling = sibling.previousElementSibling
    }
    return offset
  }
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this === container) return new DOMRect(0, 40, width, 200)
    if (container.contains(this)) return new DOMRect(0, 40 + contentTop(this) - container.scrollTop, width, height(this))
    return originalRect.call(this)
  })
  Object.defineProperties(container, {
    clientWidth: { get: () => width },
    clientHeight: { get: () => 200 },
    scrollHeight: { get: () => height(container) },
    scrollTop: { get: () => Math.max(0, Math.min(top, height(container) - 200)), set: (value: number) => {
      writes.push(value)
      top = Math.max(0, Math.min(value, height(container) - 200))
    } },
  })
  const unmount = async () => {
    if (unmounted) return
    await act(async () => root.unmount())
    unmounted = true
    container.remove()
  }
  cleanups.push(unmount)
  return {
    container, ready, writes, rendered, unmount,
    async render(next = data, update: Partial<MessageListViewport> = {}) {
      data = next
      viewport = { ...viewport, ...update }
      const list = <ProgressiveMessageList
        groups={data} viewport={viewport} getGroupKey={(group) => group.id} getMessageIds={(group) => group.messages.map((message) => message.id)}
        renderGroup={(group, index) => {
          rendered.push(index)
          return group.messages.map((message) => <div key={message.id} data-message-id={message.id}>{message.id}</div>)
        }}
      />
      await act(async () => root.render(strict ? <StrictMode>{list}</StrictMode> : list))
    },
    get mounted() { return [...container.querySelectorAll<HTMLElement>("[data-thread-group]")].map((node) => node.dataset.threadGroup) },
    get placeholders() { return [...container.querySelectorAll<HTMLElement>("[data-thread-placeholder]")] },
    get complete() { return container.firstElementChild?.getAttribute("data-thread-history-complete") },
    message(id: string) {
      const node = [...container.querySelectorAll<HTMLElement>("[data-message-id]")].find((message) => message.dataset.messageId === id)
      if (!node) throw new Error(`Message ${id} is not mounted`)
      return node
    },
    position(id: string) { return this.message(id).getBoundingClientRect().top - 40 },
    read(id: string, offset = -25) {
      top = contentTop(this.message(id)) - offset
    },
    scroll(value: number) { top = value; container.dispatchEvent(new Event("scroll")) },
    setSticky(value: boolean) { sticky = value },
    resize(nextWidth = width) { width = nextWidth; for (const emit of observers) emit() },
  }
}

describe("progressive whole-group rendering", () => {
  test("reserves both sides of a saved middle preview and keeps its anchor mounted when the full assistant group arrives", async () => {
    const full = groups(80);
    const reading = full[40];
    const preview = [{ ...reading, id: "partial-assistant-group" }];
    const view = fixture(preview, { anchorMessageId: "m40", historyComplete: false, scrollHeight: 19_832, leadingHeight: 9_920, trailingHeight: 9_664 });
    await view.render();
    expect(view.placeholders.map((node) => node.style.height)).toEqual(["9920px", "9664px"]);
    view.read("m40");
    const offset = view.position("m40");
    await view.render(full, { historyComplete: true });
    expect(view.mounted).toContain("g40");
    expect(view.position("m40")).toBeCloseTo(offset, 1);
  });

  test("mounts eight latest groups, yields a paint between bounded batches, then keeps the entire DOM", async () => {
    const view = fixture()
    await view.render()
    expect(view.mounted).toEqual(["g72", "g73", "g74", "g75", "g76", "g77", "g78", "g79"])
    expect(view.rendered).toEqual([72, 73, 74, 75, 76, 77, 78, 79])
    expect(view.complete).toBe("false")
    expect(view.container.scrollHeight).toBe(80 * 240 + 79 * 8)
    expect(view.placeholders.every((node) => node.getAttribute("aria-hidden") === "true")).toBe(true)
    const tail = view.message("m79")
    await act(async () => runFrame())
    expect(view.mounted.length).toBe(8)
    await act(async () => runFrame())
    expect(view.mounted.length).toBe(16)
    for (let i = 0; i < 8; i++) {
      const before = view.mounted.length
      await batch()
      expect(view.mounted.length - before).toBeLessThanOrEqual(8)
    }
    expect(view.mounted.length).toBe(80)
    expect(view.complete).toBe("true")
    expect(view.placeholders.length).toBe(0)
    expect(view.message("m79")).toBe(tail)
    expect(frames.size).toBe(0)
  })

  test("prioritizes an anchor inside a whole group and renders live additions without waiting", async () => {
    const data = groups()
    data[40].messages.push({ id: "answer-40", height: 200 })
    const view = fixture(data, { anchorMessageId: "answer-40" })
    await view.render()
    expect(view.mounted.length).toBe(8)
    expect(view.mounted).toContain("g40")
    expect(view.message("m40")).toBeDefined()
    expect(view.message("answer-40")).toBeDefined()
    const tail = view.message("m79")
    const next = data.map((group) => group.id === "g79" ? { ...group, messages: [...group.messages, { id: "live-answer", height: 60 }] } : group)
    await view.render(next)
    expect(view.message("live-answer")).toBeDefined()
    expect(view.message("m79")).toBe(tail)
    await view.render([...next, { id: "new-user", messages: [{ id: "new-user", height: 60 }] }])
    expect(view.message("new-user")).toBeDefined()
    expect(view.message("m79")).toBe(tail)
  })

  test("keeps the exact visible message offset while estimates above it are replaced", async () => {
    const data = groups()
    for (const group of data) group.messages[0].height = 70
    data[40].messages.push({ id: "reading-answer", height: 500 })
    const view = fixture(data, { anchorMessageId: "reading-answer" })
    await view.render()
    view.read("reading-answer", -125)
    const before = view.container.scrollTop
    await batch()
    expect(view.position("reading-answer")).toBe(-125)
    expect(view.container.scrollTop).toBeLessThan(before)
    await batch()
    expect(view.position("reading-answer")).toBe(-125)
  })

  test("captures a user's latest position at commit, not when the background batch was queued", async () => {
    const data = groups()
    for (const group of data) group.messages[0].height = 400
    const view = fixture(data, { anchorMessageId: "m40" })
    await view.render()
    view.read("m40")
    await act(async () => runFrame())
    await act(async () => {
      runFrame()
      view.read("m42", -90)
    })
    expect(view.position("m42")).toBe(-90)
    expect(view.position("m40")).not.toBe(-25)
  })

  test("jump-to-top and scrolling into an unloaded range mount that range promptly", async () => {
    const view = fixture()
    await view.render()
    await act(async () => view.scroll(20 * 248 + 25))
    expect(view.mounted).toContain("g20")
    expect(view.position("m20")).toBe(-25)
    await act(async () => view.scroll(0))
    expect(view.mounted).toContain("g0")
    expect(view.position("m0")).toBe(0)
  })

  test.each([0, 1250, 30_050])("preserves navigation to reserved history at %s when full history arrives", async (top) => {
    const full = groups(100)
    for (const group of full) group.messages[0].height = 392
    const view = fixture(full.slice(40, 44), {
      anchorMessageId: "m40", historyComplete: false, scrollHeight: 39_992,
      leadingHeight: 16_000, trailingHeight: 22_384,
    })
    await view.render()
    view.read("m40")
    // Home/scroll_top reaches a prefix with no message to anchor. Scrolling
    // into either reserved side must not select an offscreen preview message.
    await act(async () => view.scroll(top))
    await view.render(full, { historyComplete: true })
    expect(view.container.scrollTop).toBeCloseTo(top, 1)
    const destination = view.mounted.find((id) => {
      if (!id) return false
      const position = view.position(`m${id.slice(1)}`)
      return position <= 0 && position > -392
    })
    expect(destination).toBeDefined()
    if (!destination) throw new Error("Reserved destination did not mount")
    const messageId = `m${destination.slice(1)}`
    const offset = view.position(messageId)
    for (let i = 0; i < 20; i++) await batch()
    expect(view.complete).toBe("true")
    expect(view.position(messageId)).toBeCloseTo(offset, 1)
    if (top === 0) expect(view.container.scrollTop).toBe(0)
  })

  test("a queued background batch cannot discard groups requested by a simultaneous scroll", async () => {
    const view = fixture()
    await view.render()
    await act(async () => runFrame())
    await act(async () => {
      view.scroll(20 * 248)
      runFrame()
    })
    for (let index = 19; index < 27; index++) expect(view.mounted).toContain(`g${index}`)
  })

  test("fills at sticky bottom, but does not snap back after the user reads earlier content", async () => {
    const data = groups()
    for (const group of data) group.messages[0].height = 400
    const view = fixture(data)
    await view.render()
    view.setSticky(true)
    view.container.scrollTop = view.container.scrollHeight - 200
    await batch()
    expect(view.container.scrollTop).toBe(view.container.scrollHeight - 200)
    view.setSticky(false)
    view.read("m75", -100)
    await batch()
    expect(view.position("m75")).toBe(-100)
    expect(view.container.scrollTop).toBeLessThan(view.container.scrollHeight - 200)
  })

  test("does not compensate native content reflow or redistribute spacers during a content-only commit", async () => {
    const data = groups()
    const view = fixture(data, { anchorMessageId: "m40" })
    await view.render()
    view.read("m40", -80)
    const placeholderHeights = view.placeholders.map((node) => node.style.height)
    data[39].messages[0].height += 130
    // Model the browser's own anchor adjustment after an image expands.
    view.read("m40", -80)
    view.writes.length = 0
    await act(async () => view.resize())
    await view.render([...data])
    expect(view.writes).toEqual([])
    expect(view.position("m40")).toBe(-80)
    expect(view.placeholders.map((node) => node.style.height)).toEqual(placeholderHeights)
  })

  test("Find mounts everything immediately and closing Find never removes it", async () => {
    const view = fixture()
    await view.render()
    await view.render(undefined, { revealAll: true })
    expect(view.mounted.length).toBe(80)
    expect(view.complete).toBe("true")
    expect(frames.size).toBe(0)
    await view.render(undefined, { revealAll: false })
    expect(view.mounted.length).toBe(80)
  })

  test("reserves the saved full extent for a partial tail and prioritizes its missing anchor when history arrives", async () => {
    const data = groups(100)
    const view = fixture(data.slice(90), { historyComplete: false, scrollHeight: 40_000, anchorMessageId: "m40" })
    await view.render()
    expect(view.container.scrollHeight).toBeCloseTo(40_000)
    expect(view.complete).toBe("false")
    expect(view.placeholders.some((node) => node.dataset.threadPlaceholder === "history-prefix")).toBe(true)
    view.read("m95", -50)
    await view.render(data, { historyComplete: true })
    expect(view.message("m40")).toBeDefined()
    expect(view.position("m95")).toBe(-50)
    expect(view.placeholders.some((node) => node.dataset.threadPlaceholder === "history-prefix")).toBe(false)
  })

  test("preserves a reading message when a partial assistant group acquires its earlier messages", async () => {
    const view = fixture([{ id: "tail", messages: [{ id: "reading", height: 500 }] }], { historyComplete: false, scrollHeight: 20_000 })
    await view.render()
    view.read("reading", -125)
    await view.render([{ id: "start", messages: [{ id: "earlier", height: 300 }, { id: "reading", height: 500 }] }], { historyComplete: true })
    expect(view.position("reading")).toBe(-125)
  })

  test("reuses measured geometry only for the same session and width, with bounded viewport retention", async () => {
    const data = groups(20)
    for (const group of data) group.messages[0].height = 100
    const key = `cache-${++sessionId}`
    const first = fixture(data, { sessionKey: key, revealAll: true })
    await first.render()
    await first.unmount()
    const returning = fixture(data, { sessionKey: key })
    await returning.render()
    expect(returning.placeholders[0].style.height).toBe(`${12 * 100 + 11 * 8}px`)
    await returning.unmount()
    const resized = fixture(data, { sessionKey: key, viewportWidth: 900 })
    await resized.render()
    expect(resized.placeholders[0].style.height).toBe(`${12 * 240 + 11 * 8}px`)
    await resized.unmount()
    for (let index = 0; index < 12; index++) {
      const other = fixture(groups(1))
      await other.render()
      await other.unmount()
    }
    const evicted = fixture(data, { sessionKey: key })
    await evicted.render()
    expect(evicted.placeholders[0].style.height).toBe(`${12 * 240 + 11 * 8}px`)
  })

  test("cancels pending work on a same-instance session switch and on unmount", async () => {
    const view = fixture()
    await view.render()
    await act(async () => runFrame())
    const pending = [...frames.keys()]
    const newReady = mock(() => {})
    await view.render(undefined, { sessionKey: `switch-${++sessionId}`, onReady: newReady })
    expect(view.mounted.length).toBe(8)
    expect(pending.every((id) => !frames.has(id))).toBe(true)
    const oldCalls = view.ready.mock.calls.length
    await batch()
    expect(view.ready.mock.calls.length).toBe(oldCalls)
    expect(newReady).toHaveBeenCalledTimes(2)
    await view.unmount()
    expect(frames.size).toBe(0)
    expect(observers.size).toBe(0)
  })

  test("resumes background work and viewport listeners after Strict Mode's mount replay", async () => {
    const view = fixture(groups(), {}, true)
    await view.render()
    expect(view.mounted.length).toBe(8)
    await batch()
    expect(view.mounted.length).toBe(16)
    await act(async () => view.scroll(20 * 248))
    expect(view.mounted).toContain("g20")
    await view.unmount()
    expect(frames.size).toBe(0)
    expect(observers.size).toBe(0)
  })
})
