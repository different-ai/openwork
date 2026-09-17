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

function trackHeightReads(data: readonly Group[]) {
  const keys = new Set(data.map((group) => group.id))
  const reads = spyOn(Map.prototype, "get")
  // Height maps use raw group IDs; node tracking uses group:/placeholder: keys.
  return () => reads.mock.calls.filter(([key]) => keys.has(key)).length
}

function fixture(initial = groups(), options: Partial<MessageListViewport> = {}, strict = false, fixedGeometry = false, viewportHeight = 200) {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  let data = initial
  let messages = new Map(data.flatMap((group) => group.messages.map((message) => [message.id, message] as const)))
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
    return id ? messages.get(id)?.height ?? 0 : 0
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
    if (this === container) return new DOMRect(0, 40, width, viewportHeight)
    if (fixedGeometry && container.contains(this)) return new DOMRect(0, 40, width, 240)
    if (container.contains(this)) return new DOMRect(0, 40 + contentTop(this) - container.scrollTop, width, height(this))
    return originalRect.call(this)
  })
  Object.defineProperties(container, {
    clientWidth: { get: () => width },
    clientHeight: { get: () => viewportHeight },
    scrollHeight: { get: () => height(container) },
    scrollTop: { get: () => Math.max(0, Math.min(top, height(container) - viewportHeight)), set: (value: number) => {
      writes.push(value)
      top = Math.max(0, Math.min(value, height(container) - viewportHeight))
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
    async render(next = data, update: Partial<MessageListViewport> = {}, renderer?: (group: Group, index: number) => ReactNode, groupKeyReplacements?: ReadonlyMap<string, string>, priorityMessageId?: string) {
      data = next
      messages = new Map([...messages, ...data.flatMap((group) => group.messages.map((message) => [message.id, message] as const))])
      viewport = { ...viewport, ...update }
      const list = <ProgressiveMessageList
        groups={data} viewport={viewport} getGroupKey={key} getMessageIds={ids}
        groupKeyReplacements={groupKeyReplacements}
        priorityMessageId={priorityMessageId}
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
  test.each([false, true])("keeps a bounded settled window and frozen offscreen estimates (history complete: %s)", async (historyComplete) => {
    const data = groups()
    const view = fixture(data, { anchorMessageId: "m40", historyComplete, scrollHeight: 40_000 })
    await view.render()
    const tail = view.message("m79")
    const anchor = view.message("m40")
    const prefix = view.placeholders.find((node) => node.dataset.threadPlaceholder === "history-prefix")?.style.height
    view.read("m40", -80)
    await act(async () => view.resize())
    await batch()
    const mounted = view.mounted
    const placeholders = view.placeholders.map((node) => node.style.height)
    for (let index = 0; index < 10; index++) await batch()
    expect(view.mounted).toEqual(mounted)
    expect(mounted.length).toBeLessThanOrEqual(8)
    expect(view.position("m40")).toBe(-80)
    expect(view.message("m40")).toBe(anchor)
    expect(view.message("m79")).toBe(tail)
    expect(view.complete).toBe(String(historyComplete))
    expect(frames.size).toBe(0)
    expect(view.placeholders.find((node) => node.dataset.threadPlaceholder === "history-prefix")?.style.height).toBe(prefix)
    const next = data.map((group) => ({ ...group }))
    next[79] = { ...next[79], messages: [...next[79].messages, { id: "live", height: 60 }] }
    view.writes.length = 0
    await view.render(next)
    expect(view.writes).toEqual([])
    expect(view.placeholders.map((node) => node.style.height)).toEqual(placeholders)
    expect(view.message("m79")).toBe(tail)
    expect(view.message("live")).toBeDefined()
  })

  test("rebuilds heights for added, reordered and removed keys without thawing existing estimates", async () => {
    const data = groups(20)
    for (const group of data) group.messages[0].height = 100
    const prefix: Group = { id: "prefix", messages: [{ id: "prefix", height: 500 }] }
    const view = fixture(data, { scrollHeight: 20 * 240 + 19 * 8 })
    const heightReads = trackHeightReads([...data, prefix])
    await view.render()
    let previousReads = heightReads()
    const tail = view.message("m19")
    view.read("m16", -50)
    await view.render([prefix, ...data], { scrollHeight: 12 * 240 + 8 * 100 + 500 + 20 * 8 })
    expect(heightReads()).toBeGreaterThan(previousReads)
    expect(view.placeholders[0].style.height).toBe(`${500 + 12 * 240 + 12 * 8}px`)
    expect(view.position("m16")).toBeCloseTo(-50, 1)
    previousReads = heightReads()
    await view.render([data[19], ...data.slice(0, 12), prefix, ...data.slice(12, 19)])
    expect(heightReads()).toBeGreaterThan(previousReads)
    expect(view.placeholders[0].dataset.threadPlaceholder).toBe("placeholder:g0")
    expect(view.placeholders[0].style.height).toBe(`${12 * 240 + 500 + 12 * 8}px`)
    expect(view.message("m19")).toBe(tail)
    previousReads = heightReads()
    await view.render(data)
    expect(heightReads()).toBeGreaterThan(previousReads)
    expect(view.placeholders[0].style.height).toBe(`${12 * 240 + 11 * 8}px`)
    expect(view.message("m19")).toBe(tail)
    await batch()
    previousReads = heightReads()
    await batch()
    expect(heightReads()).toBe(previousReads)
  })

  test("invalidates width and history scopes while preserving measured geometry and the reading anchor", async () => {
    const data = groups(20)
    for (const group of data) group.messages[0].height = 100
    const sessionKey = `planning-${++sessionId}`
    const first = fixture(data, { sessionKey, revealAll: true })
    await first.render()
    await first.unmount()
    const view = fixture(data, { sessionKey })
    const heightReads = trackHeightReads(data)
    await view.render()
    expect(view.placeholders[0].style.height).toBe(`${12 * 100 + 11 * 8}px`)
    view.read("m16", -50)
    let previousReads = heightReads()
    await act(async () => view.resize(900))
    expect(heightReads()).toBeGreaterThan(previousReads)
    expect(view.placeholders[0].style.height).toBe(`${12 * 240 + 11 * 8}px`)
    expect(view.position("m16")).toBeCloseTo(-50, 1)
    await act(async () => view.resize())
    previousReads = heightReads()
    await view.render(data, { historyComplete: false, scrollHeight: 8_000 })
    expect(heightReads()).toBeGreaterThan(previousReads)
    expect(view.placeholders.map((node) => node.style.height)).toEqual(["4160px", "2968px"])
    expect(view.position("m16")).toBeCloseTo(-50, 1)
    previousReads = heightReads()
    await view.render(data, { historyComplete: true })
    expect(heightReads()).toBeGreaterThan(previousReads)
    expect(view.placeholders).toHaveLength(1)
    expect(Number.parseFloat(view.placeholders[0].style.height)).toBeCloseTo(7_136, 1)
    expect(view.position("m16")).toBeCloseTo(-50, 1)
    await batch()
    previousReads = heightReads()
    await batch()
    expect(heightReads()).toBe(previousReads)
  })

  test("updates saved extent and explicit reserved regions without redistributing frozen group heights", async () => {
    const data = groups(20)
    const view = fixture(data, { historyComplete: false, scrollHeight: 8_000 })
    const heightReads = trackHeightReads(data)
    await view.render()
    const previousReads = heightReads()
    const skipped = view.placeholders[1].style.height
    view.read("m16", -50)
    await view.render(data, { scrollHeight: 9_000 })
    expect(heightReads()).toBeGreaterThan(previousReads)
    expect(view.placeholders.map((node) => node.style.height)).toEqual(["4040px", skipped])
    expect(view.position("m16")).toBeCloseTo(-50, 1)
    const geometryReads = heightReads()
    await view.render(data, { leadingHeight: 1_000, trailingHeight: 500 })
    expect(heightReads()).toBe(geometryReads)
    expect(view.placeholders.map((node) => node.style.height)).toEqual(["1000px", skipped, "500px"])
    expect(view.position("m16")).toBeCloseTo(-50, 1)
  })

  for (const count of [80, 800, 1600]) {
    test(`bounds initial and deep-scroll DOM for ${count} groups and removes old nodes`, async () => {
      const data = groups(count)
      const view = fixture(data, { anchorMessageId: `m${count - 1}` })
      await view.render()
      expect(view.rendered).toHaveLength(8)
      const old = view.message(`m${count - 4}`)
      const tail = view.message(`m${count - 1}`)
      const middle = Math.floor(count / 2)
      await act(async () => view.scroll(middle * 248 + 25))
      await batch()
      expect(view.mounted.length).toBeLessThanOrEqual(8)
      expect(view.position(`m${middle}`)).toBe(-25)
      expect(old.isConnected).toBe(false)
      expect(view.message(`m${count - 1}`)).toBe(tail)
      const settledRenders = view.rendered.length
      for (let index = 0; index < 10; index++) await batch()
      expect(view.rendered).toHaveLength(settledRenders)
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
      return <button data-message-id={group.messages[0].id} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
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
    view.read("m79", 0)
    await batch()
    expect(view.rendered.length).toBeLessThanOrEqual(8)
    expect(tail.textContent).toBe("1:79:streaming:true:true")
    view.rendered.length = 0
    await render("settled")
    expect(view.rendered).toHaveLength(view.mounted.length)
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
    await batch()
    expect(view.mounted.length).toBeLessThanOrEqual(10)
    expect(mounts - unmounts).toBe(view.mounted.length)
    expect(unmounts).toBeGreaterThan(0)
    expect(view.message("m79")).toBe(tail)
  })

  test("fills a tall viewport with short groups without retaining previously visited windows", async () => {
    const data = groups(1600)
    for (const group of data) group.messages[0].height = 20
    const view = fixture(data, {}, false, false, 1200)
    await view.render()
    for (const destination of [0, 80_000, 160_000, 240_000, 0]) {
      await act(async () => view.scroll(destination))
      for (let index = 0; index < 16 && frames.size; index++) await batch()
      const bounds = view.container.getBoundingClientRect()
      expect(view.mounted.length).toBeLessThan(90)
      expect(view.placeholders.some((node) => {
        const rect = node.getBoundingClientRect()
        return rect.bottom > bounds.top && rect.top < bounds.bottom
      })).toBe(false)
      expect(frames.size).toBe(0)
    }
  })

  test("default-open content does not pin every visited group", async () => {
    const view = fixture(groups(1600), { anchorMessageId: "m800" })
    await view.render(undefined, {}, (group) => <button data-message-id={group.messages[0].id} aria-expanded="true">Open by default</button>)
    const previous = view.message("m800")
    await act(async () => view.scroll(0))
    await batch()
    expect(view.mounted.length).toBeLessThanOrEqual(8)
    expect(previous.isConnected).toBe(false)
  })

  test.each(["focus", "selection", "expanded", "collapsed", "portal"])("retains %s interaction offscreen and releases it when the interaction ends", async (interaction) => {
    function Tool({ group }: { group: Group }) {
      const [open, setOpen] = useState(interaction === "collapsed")
      return <button data-message-id={group.messages[0].id} aria-expanded={open}
        aria-controls={group.id === "g40" ? "tool-popup" : undefined} onClick={() => setOpen(!open)}>{String(open)}</button>
    }
    const view = fixture(groups(), { anchorMessageId: "m40" })
    await view.render(undefined, {}, (group) => <Tool group={group} />)
    const retained = view.message("m40")
    const popup = document.createElement("button")
    popup.id = "tool-popup"
    document.body.append(popup)
    cleanups.push(async () => { popup.remove(); document.getSelection()?.removeAllRanges() })
    await act(async () => {
      if (interaction === "focus") retained.focus()
      if (interaction === "expanded" || interaction === "collapsed") retained.click()
      if (interaction === "portal") popup.focus()
      if (interaction === "selection") {
        const range = document.createRange()
        range.selectNodeContents(retained)
        document.getSelection()?.addRange(range)
        document.dispatchEvent(new Event("selectionchange"))
      }
      view.scroll(0)
    })
    await batch()
    expect(view.message("m40")).toBe(retained)
    expect(view.mounted.length).toBeLessThanOrEqual(9)
    expect(view.mounted).not.toContain("g41")
    if (interaction === "focus") expect(document.activeElement).toBe(retained)
    if (interaction === "expanded") expect(retained.textContent).toBe("true")
    if (interaction === "collapsed") expect(retained.textContent).toBe("false")
    await act(async () => {
      retained.blur()
      popup.blur()
      if (interaction === "expanded" || interaction === "collapsed") retained.click()
      document.getSelection()?.removeAllRanges()
      document.dispatchEvent(new Event("selectionchange"))
    })
    await batch()
    expect(retained.isConnected).toBe(false)
  })

  test("replacement group identities preserve the wrapper and keyed interaction state", async () => {
    function Tool({ group }: { group: Group }) {
      const [open, setOpen] = useState(false)
      return <button data-message-id={group.messages[0].id} aria-expanded={open} onClick={() => setOpen(!open)}>{String(open)}</button>
    }
    const data = groups()
    const view = fixture(data, { anchorMessageId: "m40" })
    const renderer = (group: Group) => <Tool key={group.id} group={group} />
    await view.render(data, {}, renderer)
    const retained = view.message("m40")
    await act(async () => retained.click())
    const next = data.map((group) => group.id === "g40" ? { ...group, id: "native", messages: [{ id: "native", height: 240 }] } : group)
    view.read("m40", -80)
    await view.render(next, {}, renderer, new Map([["native", "g40"]]))
    expect(view.message("native")).toBe(retained)
    expect(retained.textContent).toBe("true")
    expect(view.position("native")).toBe(-80)
    await batch()
    expect(view.message("native")).toBe(retained)
    await view.render(next, {}, renderer)
    expect(view.message("native")).toBe(retained)
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

  test("mounts eight latest groups immediately then retains only the viewport and tail", async () => {
    const view = fixture()
    await view.render()
    expect(view.mounted).toEqual(["g72", "g73", "g74", "g75", "g76", "g77", "g78", "g79"])
    expect(view.rendered).toEqual([72, 73, 74, 75, 76, 77, 78, 79])
    expect(view.complete).toBe("true")
    expect(view.container.scrollHeight).toBe(80 * 240 + 79 * 8)
    expect(view.placeholders.every((node) => node.getAttribute("aria-hidden") === "true")).toBe(true)
    const tail = view.message("m79")
    view.read("m79")
    await batch()
    expect(view.mounted.length).toBeLessThanOrEqual(8)
    expect(view.complete).toBe("true")
    expect(view.placeholders.length).toBeGreaterThan(0)
    expect(view.message("m79")).toBe(tail)
    expect(frames.size).toBe(0)
  })

  test("mounts the latest prompt and tail alongside a middle anchor before the first frame within eight groups", async () => {
    const view = fixture(groups(), { anchorMessageId: "m40" })
    await view.render(undefined, {}, undefined, undefined, "m78")
    expect(view.mounted).toHaveLength(8)
    expect(view.message("m40")).toBeDefined()
    expect(view.message("m79")).toBeDefined()
    expect(view.message("m78")).toBeDefined()
    expect(frames.size).toBe(1)
  })

  test.each([false, true])("admits the latest prompt during middle-preview hydration and preserves the anchor (tail present: %s)", async (tailPresent) => {
    const full = groups()
    const preview = tailPresent ? [full[40], full[79]] : [full[40]]
    const view = fixture(preview, {
      anchorMessageId: "m40", historyComplete: false, scrollHeight: 19_832,
      leadingHeight: 9_920, trailingHeight: tailPresent ? 9_416 : 9_664,
    })
    await view.render(undefined, {}, undefined, undefined, "m78")
    const retained = preview.map((group) => view.message(group.messages[0].id))
    view.read("m40", -80)
    await view.render(full, { historyComplete: true }, undefined, undefined, "m78")
    expect(view.position("m40")).toBeCloseTo(-80, 1)
    for (const node of retained) expect(node.isConnected).toBe(true)
    expect(view.message("m79")).toBeDefined()
    expect(view.message("m78")).toBeDefined()
  })

  test("admits a changed priority inside a group with a stable tail without replacing mounted nodes", async () => {
    const data = groups()
    data[20].messages.push({ id: "latest-prompt", height: 60 })
    const view = fixture(data, { anchorMessageId: "m40" })
    await view.render(undefined, {}, undefined, undefined, "m40")
    const retained = view.mounted.map((id) => view.message(`m${id?.slice(1)}`))
    view.read("m40", -80)
    await view.render(undefined, {}, undefined, undefined, "latest-prompt")
    expect(view.position("m40")).toBeCloseTo(-80, 1)
    for (const node of retained) expect(node.isConnected).toBe(true)
    expect(view.message("m79")).toBeDefined()
    expect(view.message("latest-prompt")).toBeDefined()
    expect(view.mounted).toHaveLength(9)
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

  test.each([false, true])("keeps submitted text mounted when its native ID arrives with assistant already present: %s", async (assistantAlreadyPresent) => {
    const history = groups()
    const pending = { id: "pending-user", messages: [{ id: "pending-user", height: 60 }] }
    const native = { id: "native-user", messages: [{ id: "native-user", height: 60 }] }
    const assistant = { id: "assistant", messages: [{ id: "assistant", height: 60 }] }
    const text = "Keep this submitted message visible."
    const render = (group: Group) => group.messages.map((message) =>
      <div key={message.id} data-message-id={message.id}>{group === pending || group === native ? text : message.id}</div>)
    const view = fixture([...history, pending])
    await view.render(undefined, {}, render)
    const expectOneSubmission = () => expect(view.container.textContent?.split(text).length).toBe(2)
    expectOneSubmission()
    view.read("pending-user")
    if (assistantAlreadyPresent) {
      await view.render([...history, pending, assistant], {}, render)
      expectOneSubmission()
    }
    await view.render([...history, native, assistant], {}, render, new Map([[native.id, pending.id]]))
    expectOneSubmission()
    expect(view.message("native-user")).toBeDefined()
    expect(view.mounted).not.toContain("pending-user")
    expect(view.mounted).not.toContain("g0")
    await act(async () => runFrame())
    expectOneSubmission()
    await act(async () => runFrame())
    expectOneSubmission()
    await view.render([...history, native, assistant], {}, render)
    expectOneSubmission()
  })

  test("replacement admission stays scoped to mounted groups in the same session, not new history", async () => {
    const data = groups()
    const view = fixture(data, { anchorMessageId: "m40" })
    await view.render()
    view.read("m40")
    const next = data.map((group) => group.id === "g0" || group.id === "g40" ? { ...group, id: `native-${group.id}` } : group)
    next.unshift({ id: "older-history", messages: [{ id: "older-history", height: 240 }] })
    const replacements = new Map([["native-g0", "g0"], ["native-g40", "g40"]])
    await view.render(next, { anchorMessageId: undefined }, undefined, replacements)
    expect(view.mounted).toContain("native-g40")
    expect(view.mounted).not.toContain("native-g0")
    expect(view.mounted).not.toContain("older-history")
    expect(view.mounted).toHaveLength(8)
    await view.render(next)
    expect(view.mounted).toContain("native-g40")
    await view.render(next, { sessionKey: `replacement-${++sessionId}` }, undefined, replacements)
    expect(view.mounted).not.toContain("native-g40")
    expect(view.mounted).not.toContain("native-g0")
    expect(view.mounted).toHaveLength(8)
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
      view.read("m41", -90)
    })
    expect(view.position("m41")).toBe(-90)
    expect(view.position("m40")).not.toBe(-25)
  })

  test("jump-to-top and scrolling into an unloaded range mount that range promptly", async () => {
    const view = fixture()
    await view.render()
    await act(async () => view.scroll(20 * 248 + 25))
    await batch()
    expect(view.mounted).toContain("g20")
    expect(view.position("m20")).toBe(-25)
    await act(async () => view.scroll(0))
    await batch()
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
    await batch()
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
    for (let index = 19; index < 23; index++) expect(view.mounted).toContain(`g${index}`)
    expect(view.mounted.length).toBeLessThanOrEqual(8)
    expect(view.position("m20")).toBe(0)
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
    await act(async () => view.scroll(view.container.scrollTop - 1_500))
    await batch()
    const reading = view.mounted.find((id) => id !== "g79" && view.position(`m${id?.slice(1)}`) <= 0)
    if (!reading) throw new Error("Earlier window did not mount")
    const messageId = `m${reading.slice(1)}`
    view.read(messageId, -100)
    await batch()
    expect(view.position(messageId)).toBe(-100)
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

  test("Find reveals every message and closing it restores a bounded window at the found result", async () => {
    const view = fixture()
    await view.render()
    view.read("m76", -50)
    await view.render(undefined, { revealAll: true })
    expect(view.position("m76")).toBe(-50)
    expect(view.mounted.length).toBe(80)
    expect(view.complete).toBe("true")
    expect(frames.size).toBe(0)
    const found = view.message("m20")
    view.read("m20", -30)
    await view.render(undefined, { revealAll: false })
    await batch()
    expect(view.mounted.length).toBeLessThanOrEqual(8)
    expect(view.position("m20")).toBe(-30)
    expect(view.message("m20")).toBe(found)
    expect(view.mounted).not.toContain("g76")
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
    expect(view.mounted.length).toBeLessThanOrEqual(8)
    await act(async () => view.scroll(20 * 248))
    await batch()
    expect(view.mounted).toContain("g20")
    await view.unmount()
    expect(frames.size).toBe(0)
    expect(observers.size).toBe(0)
  })
})
