/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act, createContext, StrictMode, useContext, useEffect, useState, type ReactNode } from "react"
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

function fixture(initial = groups(), options: Partial<MessageListViewport> = {}, strict = false, fixedGeometry = false) {
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
  const key = mock((group: Group) => group.id)
  const ids = mock((group: Group) => group.messages.map((message) => message.id))
  let viewport: MessageListViewport = {
    sessionKey: `progressive-${++sessionId}`, scrollRef: { current: container }, viewportWidth: width,
    historyComplete: true, stickyBottom: () => sticky, onReady: ready, ...options,
  }
  const messageHeight = (node: Element) => {
    const id = node.getAttribute("data-message-id")
    return data.flatMap((group) => group.messages).find((message) => message.id === id)?.height ?? 0
  }
  const height = (node: Element): number => {
    if (fixedGeometry) return node === container ? data.length * 248 : 240
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
    if (fixedGeometry && container.contains(this)) return new DOMRect(0, 40, width, 240)
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
    container, ready, writes, rendered, key, ids, unmount,
    async render(next = data, update: Partial<MessageListViewport> = {}, renderer?: (group: Group, index: number) => ReactNode) {
      data = next
      viewport = { ...viewport, ...update }
      const list = <ProgressiveMessageList
        groups={data} viewport={viewport} getGroupKey={key} getMessageIds={ids}
        renderGroup={(group, index) => {
          rendered.push(index)
          if (renderer) return renderer(group, index)
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
  for (const count of [80, 800, 1600]) {
    test(`invokes renderGroup only ${count} times while backfilling ${count} groups`, async () => {
      const data = groups(count)
      const view = fixture(data, { anchorMessageId: `m${count - 1}` }, false, true)
      await view.render()
      expect(view.rendered).toHaveLength(8)
      for (let index = 8; index < count; index += 8) await batch()
      expect(view.mounted).toHaveLength(count)
      expect(view.rendered).toHaveLength(count)
      expect(view.key).toHaveBeenCalledTimes(count)
      expect(view.ids).toHaveBeenCalledTimes(count)
      expect(frames.size).toBe(0)
    })
  }

  test("invalidates parent render captures and preserves state across batches, live updates, index shifts and Find", async () => {
    let mounts = 0
    let unmounts = 0
    function StatefulTool({ group, index, phase, last }: { group: Group; index: number; phase: string; last: boolean }) {
      const [expanded, setExpanded] = useState(false)
      useEffect(() => { mounts++; return () => { unmounts++ } }, [])
      return <button data-message-id={group.messages[0].id} onClick={() => setExpanded(!expanded)}>
        {`${group.messages.length}:${index}:${phase}:${last}:${expanded}`}
      </button>
    }
    let data = groups()
    const view = fixture(data)
    const render = (phase: string) => view.render(data, {}, (group, index) =>
      <StatefulTool group={group} index={index} phase={phase} last={index === data.length - 1} />)
    await render("streaming")
    const tail = view.message("m79")
    await act(async () => tail.click())
    await batch()
    expect(view.rendered).toHaveLength(16)
    expect(tail.textContent).toBe("1:79:streaming:true:true")
    view.rendered.length = 0
    await render("settled")
    expect(view.rendered).toHaveLength(16)
    expect(tail.textContent).toBe("1:79:settled:true:true")
    data = data.map((group) => group.id === "g79" ? { ...group, messages: [...group.messages, { id: "delta", height: 40 }] } : group)
    await render("streaming")
    expect(tail.textContent).toBe("2:79:streaming:true:true")
    data = [{ id: "prefix", messages: [{ id: "prefix", height: 40 }] }, ...data,
      { id: "suffix", messages: [{ id: "suffix", height: 40 }] }]
    await render("streaming")
    expect(tail.textContent).toBe("2:80:streaming:false:true")
    const renderer = (group: Group, index: number) => <StatefulTool group={group} index={index} phase="settled" last={index === data.length - 1} />
    await view.render(data, { revealAll: true }, renderer)
    expect(view.mounted).toHaveLength(82)
    await view.render(data, { revealAll: false }, renderer)
    expect(view.message("m79")).toBe(tail)
    expect(tail.textContent).toBe("2:80:settled:false:true")
    expect(mounts).toBe(82)
    expect(unmounts).toBe(0)
  })

  test("stable callbacks still update changed groups and indexes, and descendants receive context without remounting", async () => {
    const context = createContext("initial")
    function Content({ group, index }: { group: Group; index: number }) {
      const value = useContext(context)
      return <div data-message-id={group.id}>{`${group.messages.length}:${index}:${value}`}</div>
    }
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    cleanups.push(async () => { await act(async () => root.unmount()); container.remove() })
    const renderGroup = mock((group: Group, index: number) => <Content group={group} index={index} />)
    const getGroupKey = (group: Group) => group.id
    const getMessageIds = (group: Group) => group.messages.map((message) => message.id)
    let data = groups(2)
    const render = async (value: string) => { await act(async () => root.render(<context.Provider value={value}>
      <ProgressiveMessageList groups={data} getGroupKey={getGroupKey} getMessageIds={getMessageIds} renderGroup={renderGroup} />
    </context.Provider>)) }
    await render("initial")
    const first = container.querySelector('[data-message-id="g0"]')
    await render("updated")
    expect(renderGroup).toHaveBeenCalledTimes(2)
    expect(first?.textContent).toBe("1:0:updated")
    data = [{ ...data[0], messages: [...data[0].messages, { id: "new", height: 40 }] }, data[1]]
    await render("updated")
    expect(renderGroup).toHaveBeenCalledTimes(3)
    expect(first?.textContent).toBe("2:0:updated")
    data = [data[1], data[0]]
    await render("updated")
    expect(renderGroup).toHaveBeenCalledTimes(5)
    expect(first?.textContent).toBe("2:1:updated")
    expect(container.querySelector('[data-message-id="g0"]')).toBe(first)
  })

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
    expect(view.rendered).toHaveLength(80)
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
