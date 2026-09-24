/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act, createContext, StrictMode, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import type { MessageListViewport } from "../src/components/chat/progressive-message-list"

const ownedDom = typeof window === "undefined"
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" })
const tanstack = await import("@tanstack/react-virtual")
const { ProgressiveMessageList } = await import("../src/components/chat/progressive-message-list")
const { useSessionScrollController } = await import("../src/react-app/domains/session/surface/scroll-controller")
const { useSessionScrollStore, flushSessionScrollState, getSessionScrollState } = await import("../src/react-app/domains/session/surface/scroll-store")
const originalObserver = globalThis.ResizeObserver
const originalRect = HTMLElement.prototype.getBoundingClientRect
const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
const frames = new Map<number, FrameRequestCallback>()
const observers = new Set<(filter?: (target: Element) => boolean) => void>()
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
    private emit: (filter?: (target: Element) => boolean) => void
    private frame: number | undefined
    constructor(callback: ResizeObserverCallback) {
      this.emit = (filter = () => true) => {
        const targets = [...this.targets].filter(filter)
        if (targets.length) callback(targets.map((target) => ({
          target, contentRect: target.getBoundingClientRect(), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [],
        })), this)
      }
      observers.add(this.emit)
    }
    observe(target: Element) {
      if (this.targets.has(target)) return
      this.targets.add(target)
      observers.add(this.emit)
      if (this.frame === undefined) this.frame = window.requestAnimationFrame(() => { this.frame = undefined; this.emit() })
    }
    unobserve(target: Element) { this.targets.delete(target); if (!this.targets.size) this.disconnect() }
    disconnect() {
      if (this.frame !== undefined) window.cancelAnimationFrame(this.frame)
      this.frame = undefined
      this.targets.clear()
      observers.delete(this.emit)
    }
  })
  window.ResizeObserver = globalThis.ResizeObserver
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  useSessionScrollStore.setState({ sessions: {} })
  flushSessionScrollState()
  frames.clear()
  observers.clear()
  Reflect.set(globalThis, "ResizeObserver", originalObserver)
  window.ResizeObserver = originalObserver
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

function fixture(initial = groups(), options: Partial<MessageListViewport> = {}, strict = false, fixedGeometry = false, viewportHeight = 200, listOffset = 0, controller?: "immediate" | "delayed", geometry: { heightAtWidth?: (height: number, width: number) => number; headerHeight?: number; bottomPadding?: number; scrollOptions?: Pick<Parameters<typeof useSessionScrollController>[0], "geometryOwner" | "historyPages" | "windowReady" | "pageForAnchor"> } = {}) {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  let data = initial
  let messages = new Map(data.flatMap((group) => group.messages.map((message) => [message.id, message] as const)))
  let top = 0
  let width = options.viewportWidth ?? 600
  let viewportHidden = false
  let sticky = false
  let unmounted = false
  let initializedSession: string | undefined
  const writes: number[] = []
  const ready = mock(() => {})
  const rendered: number[] = []
  const key = mock((group: Group) => group.id)
  const ids = mock((group: Group) => group.messages.map((message) => message.id))
  let viewport: MessageListViewport = {
    sessionKey: `progressive-${++sessionId}`, scrollRef: { current: controller === "delayed" ? null : container }, viewportWidth: width,
    historyComplete: true, stickyBottom: () => sticky, onReady: ready, ...options,
  }
  const messageHeight = (node: Element) => {
    const id = node.getAttribute("data-message-id")
    const height = id ? messages.get(id)?.height ?? 0 : 0
    return geometry.heightAtWidth?.(height, width) ?? height
  }
  const hidden = (node: Element) => node.hasAttribute("data-thread-group") && !node.hasChildNodes()
  const height = (node: Element): number => {
    if (viewportHidden) return 0
    if (fixedGeometry) return node === container ? data.length * 248 : 240
    if (node instanceof HTMLElement && (node.hasAttribute("data-thread-placeholder") || node.hasAttribute("data-thread-loading") || node.hasAttribute("data-thread-test-header"))) return Number.parseFloat(node.style.height) || 0
    if (node.hasAttribute("data-message-id")) return messageHeight(node)
    if (node.hasAttribute("data-thread-group")) return [...node.children].reduce((sum, child) => sum + height(child), 0)
    const children = [...node.children].filter((child) => !hidden(child))
    return children.reduce((sum, child) => sum + height(child), 0) + Math.max(0, children.length - 1) * 8 + (node === container ? listOffset + (geometry.bottomPadding ?? 0) : 0)
  }
  const contentTop = (node: Element): number => {
    if (node === container) return 0
    if (node.parentElement === container) return listOffset
    let offset = node.parentElement ? contentTop(node.parentElement) : 0
    let sibling = node.previousElementSibling
    while (sibling) {
      if (!hidden(sibling)) offset += height(sibling) + (node.parentElement?.hasAttribute("data-thread-history-complete") ? 8 : 0)
      sibling = sibling.previousElementSibling
    }
    return offset
  }
  spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (viewportHidden && container.contains(this)) return new DOMRect()
    if (this === container) return new DOMRect(0, 40, width, viewportHeight)
    if (container.contains(this) && hidden(this)) return new DOMRect()
    if (fixedGeometry && container.contains(this)) return new DOMRect(0, 40, width, 240)
    if (container.contains(this)) return new DOMRect(0, 40 + contentTop(this) - container.scrollTop, width, height(this))
    return originalRect.call(this)
  })
  let scrollFrame: number | undefined
  const notifyScroll = () => {
    if (scrollFrame !== undefined) return
    scrollFrame = window.requestAnimationFrame(() => {
      scrollFrame = undefined
      container.dispatchEvent(new Event("scroll"))
    })
  }
  Object.defineProperties(container, {
    offsetWidth: { get: () => viewportHidden ? 0 : width },
    offsetHeight: { get: () => viewportHidden ? 0 : viewportHeight },
    scrollTo: { value: (options: ScrollToOptions) => { container.scrollTop = options.top ?? container.scrollTop } },
    clientWidth: { get: () => viewportHidden ? 0 : width },
    clientHeight: { get: () => viewportHidden ? 0 : viewportHeight },
    scrollHeight: { get: () => height(container) },
    scrollTop: { get: () => {
      if (viewportHidden) return 0
      const clamped = Math.max(0, Math.min(top, height(container) - viewportHeight))
      if (clamped !== top) { top = clamped; notifyScroll() }
      return top
    }, set: (value: number) => {
      writes.push(value)
      if (viewportHidden) return
      const next = Math.max(0, Math.min(value, height(container) - viewportHeight))
      if (next !== top) { top = next; notifyScroll() }
    } },
  })
  const unmount = async () => {
    if (unmounted) return
    await act(async () => root.unmount())
    unmounted = true
    if (scrollFrame !== undefined) window.cancelAnimationFrame(scrollFrame)
    container.remove()
  }
  cleanups.push(unmount)
  function ControlledList({ loading, renderList }: { loading: boolean; renderList: (viewport: MessageListViewport) => ReactNode }) {
    const contentRef = useRef<HTMLDivElement>(null)
    useLayoutEffect(() => { viewport.scrollRef.current = container }, [])
    const scroll = useSessionScrollController({
      selectedSessionId: viewport.sessionKey,
      submittedMessageId: null,
      historyReady: !loading,
      historyComplete: viewport.historyComplete,
      renderedMessages: data,
      containerRef: viewport.scrollRef,
      contentRef,
      ...geometry.scrollOptions,
    })
    useLayoutEffect(() => {
      if (!geometry.scrollOptions) return
      const onScroll = () => Reflect.apply(scroll.handleScroll, undefined, [])
      const onWheel = (event: WheelEvent) => scroll.markScrollGesture(event.target)
      container.addEventListener("scroll", onScroll)
      container.addEventListener("wheel", onWheel)
      return () => {
        container.removeEventListener("scroll", onScroll)
        container.removeEventListener("wheel", onWheel)
      }
    }, [scroll.handleScroll, scroll.markScrollGesture])
    return <div ref={contentRef}>
      {loading ? <div data-thread-loading style={{ height: viewport.scrollHeight ?? 40_000 }} />
        : renderList({ ...viewport, onReady: scroll.refresh,
          stickyBottom: () => getSessionScrollState(useSessionScrollStore.getState().sessions, viewport.sessionKey, geometry.scrollOptions?.geometryOwner).mode === "stickyBottom" })}
    </div>
  }
  return {
    container, ready, writes, rendered, key, ids, unmount,
    async render(next = data, update: Partial<MessageListViewport> = {}, renderer?: (group: Group, index: number) => ReactNode, groupKeyReplacements?: ReadonlyMap<string, string>, priorityMessageId?: string, loading = false) {
      data = next
      messages = new Map([...messages, ...data.flatMap((group) => group.messages.map((message) => [message.id, message] as const))])
      viewport = { ...viewport, ...update }
      const initializePosition = () => {
        if (initializedSession !== viewport.sessionKey && data.length) {
          initializedSession = viewport.sessionKey
          const group = data.find((group) => group.messages.some((message) => message.id === viewport.anchorMessageId)) ?? data[Math.max(0, data.length - 4)]
          const node = [...container.querySelectorAll<HTMLElement>("[data-thread-group]")].find((node) => node.dataset.threadGroup === group.id)
          if (node) container.scrollTop = viewport.scrollTop ?? contentTop(node)
        }
        viewport.onReady?.()
      }
      const renderList = (listViewport: MessageListViewport) => <ProgressiveMessageList
        groups={data} viewport={controller ? listViewport : { ...listViewport, onReady: initializePosition }} getGroupKey={key} getMessageIds={ids}
        header={geometry.headerHeight ? <div data-thread-test-header style={{ height: geometry.headerHeight }} /> : undefined}
        groupKeyReplacements={groupKeyReplacements}
        priorityMessageId={priorityMessageId}
        renderGroup={(group, index) => {
          rendered.push(index)
          if (renderer) return renderer(group, index)
          return group.messages.map((message) => <div key={message.id} data-message-id={message.id}>{message.id}</div>)
        }}
      />
      const list = controller ? <ControlledList loading={loading} renderList={renderList} /> : renderList(viewport)
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
      notifyScroll()
    },
    scroll(value: number) { top = value; container.dispatchEvent(new Event("scroll")) },
    setSticky(value: boolean) { sticky = value },
    setHidden(value: boolean) { viewportHidden = value; for (const emit of [...observers]) emit() },
    resize(nextWidth = width, nextHeight = viewportHeight) { width = nextWidth; viewportHeight = nextHeight; for (const emit of observers) emit() },
    resizeItemsFirst(nextWidth: number) { width = nextWidth; for (const emit of [...observers]) emit((target) => target.hasAttribute("data-thread-group")) },
    resizeViewport() { for (const emit of [...observers]) emit((target) => target === container) },
  }
}

describe("progressive whole-group rendering", () => {
  test("reopening a newest page of aggregated tools fills the viewport without a scroll gesture", async () => {
    const tail: Group = { id: "tool-turn", messages: Array.from({ length: 24 }, (_, index) => ({ id: `tool-${index}`, height: index === 0 ? 48 : 0 })) }
    const render = (group: Group) => <div data-message-id={group.messages[0].id}>{group.id === tail.id ? "Running synthetic commands" : "Earlier synthetic answer"}</div>
    for (let visit = 0; visit < 3; visit++) {
      let finish = () => {}
      const load = mock(() => new Promise<void>((resolve) => { finish = resolve }))
      const pages = { version: {}, hasOlder: true, hasNewer: false, loading: false, failed: false, load }
      const view = fixture([tail], { sessionKey: "aggregated-tool-return", historyComplete: false, leadingHeight: 0, trailingHeight: 0 }, false, false, 612, 16, "immediate", {
        scrollOptions: { historyPages: pages, windowReady: true },
      })
      await view.render(undefined, {}, render)
      for (let index = 0; index < 12 && frames.size; index++) await batch()
      expect(view.position("tool-0")).toBe(16)
      expect(load.mock.calls).toEqual([["older"]])
      await act(async () => view.resize())
      expect(load).toHaveBeenCalledTimes(1)
      pages.version = {}
      const earlier = groups(24)
      await view.render([...earlier, tail], {}, render)
      await act(async () => finish())
      for (let index = 0; index < 12 && frames.size; index++) await batch()
      const bounds = view.container.getBoundingClientRect()
      expect(view.message("m23").getBoundingClientRect().bottom).toBeGreaterThan(bounds.top)
      expect(view.message("tool-0").getBoundingClientRect().bottom).toBe(bounds.bottom)
      expect(load).toHaveBeenCalledTimes(1)
      expect(view.mounted.length).toBeLessThan(earlier.length)
      expect(view.placeholders.some((node) => {
        const rect = node.getBoundingClientRect()
        return rect.bottom > bounds.top && rect.top < bounds.bottom
      })).toBe(false)
      await view.unmount()
    }
  })

  test("viewport fill serializes short pages and stops when the cursor is exhausted", async () => {
    let finish = () => {}
    const load = mock(() => new Promise<void>((resolve) => { finish = resolve }))
    const pages = { version: {}, hasOlder: true, hasNewer: false, loading: false, failed: false, load }
    const data = [{ id: "tools", messages: [{ id: "tools", height: 48 }] }]
    const view = fixture(data, { historyComplete: false, leadingHeight: 0, trailingHeight: 0 }, false, false, 612, 16, "immediate", {
      scrollOptions: { historyPages: pages, windowReady: true },
    })
    await view.render()
    await batch()
    expect(load).toHaveBeenCalledTimes(1)
    for (let page = 0; page < 2; page++) {
      pages.version = {}
      await view.render([...data])
      expect(load).toHaveBeenCalledTimes(page + 1)
      await act(async () => finish())
      await batch()
      expect(load).toHaveBeenCalledTimes(page + 2)
    }
    pages.hasOlder = false
    pages.version = {}
    await view.render(data, { historyComplete: true })
    await act(async () => finish())
    await batch()
    expect(load.mock.calls).toEqual([["older"], ["older"], ["older"]])
    await act(async () => view.resize())
    await batch()
    expect(load).toHaveBeenCalledTimes(3)
  })

  test.each(["manual", "newer", "loading", "failed", "not-ready", "hidden", "complete"])("underfilled history does not auto-page when %s", async (boundary) => {
    const sessionKey = `fill-boundary-${++sessionId}`
    if (boundary === "manual") useSessionScrollStore.getState().setManualScroll(sessionKey, 0, null, { messageId: "tools", offset: 16 })
    const load = mock(async () => {})
    const pages = { version: {}, hasOlder: boundary !== "complete", hasNewer: boundary === "newer", loading: boundary === "loading", failed: boundary === "failed", load }
    const view = fixture([{ id: "tools", messages: [{ id: "tools", height: 48 }] }], {
      sessionKey, historyComplete: boundary === "complete", leadingHeight: 0, trailingHeight: 0,
    }, false, false, boundary === "hidden" ? 0 : 612, 16, "immediate", {
      scrollOptions: { historyPages: pages, windowReady: boundary !== "not-ready" },
    })
    await view.render()
    for (let index = 0; index < 12 && frames.size; index++) await batch()
    await act(async () => view.resize())
    await batch()
    expect(load).not.toHaveBeenCalled()
  })

  test("an unchanged short page is not repeatedly requested and unmount cancels its pending fill", async () => {
    let finish = () => {}
    const load = mock(() => new Promise<void>((resolve) => { finish = resolve }))
    const pages = { version: {}, hasOlder: true, hasNewer: false, loading: false, failed: false, load }
    const view = fixture([{ id: "tools", messages: [{ id: "tools", height: 48 }] }], {
      historyComplete: false, leadingHeight: 0, trailingHeight: 0,
    }, false, false, 612, 16, "immediate", { scrollOptions: { historyPages: pages, windowReady: true } })
    await view.render()
    await act(async () => finish())
    for (let index = 0; index < 12 && frames.size; index++) await batch()
    expect(load).toHaveBeenCalledTimes(1)
    pages.version = {}
    await view.render()
    expect(load).toHaveBeenCalledTimes(2)
    await view.unmount()
    await act(async () => finish())
    expect(frames.size).toBe(0)
    expect(load).toHaveBeenCalledTimes(2)
  })

  test("Home paging preserves the padded newest-page boundary through measured prepend and the next PageUp selects older history", async () => {
    const data = Array.from({ length: 150 }, (_, index) => ({ id: `g${index + 1}`, messages: [{ id: `m${index + 1}`, height: 84 }] }))
    const newest = { before: null, limit: 24, lineage: [null] }
    const older = { before: "older-page", limit: 24, lineage: [null, "older-page"] }
    let finish = () => {}
    const load = mock(() => new Promise<void>((resolve) => { finish = resolve }))
    const pages = { version: {}, hasOlder: true, hasNewer: false, loading: false, failed: false, load }
    const sessionKey = `padded-page-${++sessionId}`
    const owner = "padded-page-owner"
    const view = fixture(data.slice(-24), { sessionKey, historyComplete: false, leadingHeight: 0, trailingHeight: 0 }, false, false, 612, 16, "immediate", {
      bottomPadding: 16,
      scrollOptions: { geometryOwner: owner, historyPages: pages, windowReady: true,
        pageForAnchor: (id) => Number(id.slice(1)) >= 127 ? newest : older },
    })
    const saved = () => getSessionScrollState(useSessionScrollStore.getState().sessions, sessionKey, owner)
    await view.render()
    for (let index = 0; index < 12 && frames.size; index++) await batch()
    expect(load).not.toHaveBeenCalled()
    await act(async () => {
      view.container.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }))
      view.scroll(0)
    })
    for (let index = 0; index < 12 && frames.size; index++) await batch()
    expect(load.mock.calls).toEqual([["older"]])
    expect(saved()).toMatchObject({ anchor: { messageId: "m127", offset: 16 }, geometry: { page: newest } })
    pages.version = {}
    await view.render(data.slice(-48))
    await batch()
    await act(async () => finish())
    pages.version = {}
    await view.render(data.slice(-48))
    for (let index = 0; index < 20 && frames.size; index++) await batch()
    expect(view.position("m127")).toBe(16)
    expect(view.position("m126")).toBe(-76)
    expect(saved()).toMatchObject({ mode: "manual", anchor: { messageId: "m127", offset: 16 }, geometry: { page: newest } })
    expect(view.mounted.length).toBeLessThan(48)
    const bounds = view.container.getBoundingClientRect()
    expect(view.placeholders.some((node) => {
      const rect = node.getBoundingClientRect()
      return rect.bottom > bounds.top && rect.top < bounds.bottom
    })).toBe(false)
    await act(async () => {
      view.container.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }))
      view.scroll(view.container.scrollTop - 276)
    })
    for (let index = 0; index < 12 && frames.size; index++) await batch()
    const firstVisible = [...view.container.querySelectorAll<HTMLElement>("[data-message-id]")].find((node) => {
      const rect = node.getBoundingClientRect()
      return rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom
    })
    expect(firstVisible?.dataset.messageId).toBeDefined()
    expect(firstVisible?.dataset.messageId).not.toBe("m127")
    expect(saved()).toMatchObject({ anchor: { messageId: firstVisible?.dataset.messageId }, geometry: { page: older } })
    expect(load).toHaveBeenCalledTimes(1)
  })

  test("ignores a queued TanStack scroll reset after the viewport disconnects", async () => {
    const observe = tanstack.observeElementOffset
    let notify: (() => void) | undefined
    let readOffset: (() => number | null) | undefined
    spyOn(tanstack, "observeElementOffset").mockImplementation((instance, callback) => {
      notify = () => callback(125, false)
      readOffset = () => instance.scrollOffset
      return observe(instance, callback)
    })
    const view = fixture(groups())
    await view.render()
    await act(async () => view.scroll(40 * 248 + 25))
    await batch()
    expect(readOffset?.()).toBe(40 * 248 + 25)
    await view.unmount()
    const offset = readOffset?.()
    await act(async () => notify?.())
    expect(readOffset?.()).toBe(offset)
    expect(frames.size).toBe(0)
    expect(observers.size).toBe(0)
  })

  test.each([0, 100])("a hidden first group does not move the list origin (header height: %s)", async (headerHeight) => {
    const view = fixture(groups(1600), { anchorMessageId: "m0" }, false, false, 200, 1500, undefined, { headerHeight })
    await view.render(undefined, {}, (group) => group.id === "g0" ? null : <div data-message-id={group.messages[0].id}>{group.id}</div>, undefined, "m0")
    const first = view.container.querySelector<HTMLElement>('[data-thread-group="g0"]')
    expect(first?.getBoundingClientRect().toJSON()).toEqual(new DOMRect().toJSON())
    const origin = 1500 + (headerHeight ? headerHeight + 8 : 0)
    for (const index of [20, 800, 40]) {
      await act(async () => view.scroll(origin + (index - 1) * 248 + 25))
      expect(view.mounted).toContain(`g${index}`)
      for (let frame = 0; frame < 12 && frames.size; frame++) await batch()
      expect(view.position(`m${index}`)).toBeLessThanOrEqual(0)
      expect(view.position(`m${index}`)).toBeGreaterThan(-240)
      const bounds = view.container.getBoundingClientRect()
      expect(view.placeholders.some((node) => {
        const rect = node.getBoundingClientRect()
        return rect.bottom > bounds.top && rect.top < bounds.bottom
      })).toBe(false)
      expect(view.mounted.length).toBeLessThanOrEqual(8)
      expect(frames.size).toBe(0)
    }
  })

  test.each(["stickyBottom", "manual"])("restores a thread after its viewport becomes measurable without a scroll gesture (%s)", async (mode) => {
    const sessionKey = `revealed-${++sessionId}`
    const anchor = { messageId: "m40", offset: -75 }
    if (mode === "manual") useSessionScrollStore.getState().setManualScroll(sessionKey, 125, null, anchor)
    const view = fixture(groups(), { sessionKey, ...(mode === "manual" ? { anchorMessageId: anchor.messageId, scrollTop: 125 } : {}) }, false, false, 0, 16, "immediate")
    await view.render()
    for (let index = 0; index < 12 && frames.size; index++) await batch()
    expect(frames.size).toBe(0)
    await act(async () => view.resize(600, 612))
    for (let index = 0; index < 12 && frames.size; index++) await batch()
    if (mode === "manual") expect(view.position("m40")).toBe(-75)
    else expect(view.message("m79").getBoundingClientRect().bottom).toBe(view.container.getBoundingClientRect().bottom)
    const bounds = view.container.getBoundingClientRect()
    expect(view.placeholders.some((node) => {
      const rect = node.getBoundingClientRect()
      return rect.bottom > bounds.top && rect.top < bounds.bottom
    })).toBe(false)
    expect(getSessionScrollState(useSessionScrollStore.getState().sessions, sessionKey).mode).toBe(mode)
    expect(view.mounted.length).toBeLessThanOrEqual(10)
    expect(frames.size).toBe(0)
  })

  test.each(["stickyBottom", "manual"])("retains measurements across a hidden thread reveal without a scroll gesture (%s)", async (mode) => {
    const sessionKey = `hidden-${++sessionId}`
    const anchor = { messageId: "m40", offset: -75 }
    if (mode === "manual") useSessionScrollStore.getState().setManualScroll(sessionKey, 125, null, anchor)
    const view = fixture(groups(), { sessionKey, ...(mode === "manual" ? { anchorMessageId: anchor.messageId, scrollTop: 125 } : {}) }, false, false, 612, 16, "immediate", { scrollOptions: {} })
    await view.render()
    for (let index = 0; index < 12 && frames.size; index++) await batch()
    await act(async () => view.setHidden(true))
    for (let index = 0; index < 12 && frames.size; index++) await batch()
    expect(frames.size).toBe(0)
    await act(async () => view.setHidden(false))
    for (let index = 0; index < 12 && frames.size; index++) await batch()
    if (mode === "manual") expect(view.position("m40")).toBe(-75)
    else expect(view.message("m79").getBoundingClientRect().bottom).toBe(view.container.getBoundingClientRect().bottom)
    const bounds = view.container.getBoundingClientRect()
    expect(view.placeholders.some((node) => {
      const rect = node.getBoundingClientRect()
      return rect.bottom > bounds.top && rect.top < bounds.bottom
    })).toBe(false)
    expect(getSessionScrollState(useSessionScrollStore.getState().sessions, sessionKey).mode).toBe(mode)
    expect(view.mounted.length).toBeLessThanOrEqual(10)
    expect(frames.size).toBe(0)
  })

  test("item resize callbacks cannot cache new-width heights in the previous width scope", async () => {
    const data = groups(20)
    for (const group of data) group.messages[0].height = 100
    const sessionKey = `width-order-${++sessionId}`
    const geometry = { heightAtWidth: (height: number, width: number) => width === 900 ? height * 2 : height }
    const first = fixture(data, { sessionKey, revealAll: true }, false, false, 200, 0, undefined, geometry)
    await first.render()
    await batch()
    expect(first.container.scrollHeight).toBe(20 * 100 + 19 * 8)
    await act(async () => first.resizeItemsFirst(900))
    expect(first.message("m0").getBoundingClientRect().height).toBe(200)
    await act(async () => first.resizeViewport())
    await batch()
    await first.unmount()
    const returning = fixture(data, { sessionKey, viewportWidth: 600 }, false, false, 200, 0, undefined, geometry)
    await returning.render()
    await batch()
    expect(returning.mounted).not.toContain("g0")
    expect(returning.container.scrollHeight).toBe(20 * 100 + 19 * 8)
    expect(returning.mounted.length).toBeLessThanOrEqual(8)
  })

  for (const controller of ["immediate", "delayed"] as const) {
    for (const loading of [false, true]) {
      test(`the real scroll controller owns anchor restoration (${controller} ref, loading boundary: ${loading})`, async () => {
        const sessionKey = `controller-${++sessionId}`
        const anchor = { messageId: "m40", offset: -75 }
        useSessionScrollStore.getState().setManualScroll(sessionKey, 125, null, anchor)
        const view = fixture(groups(), { sessionKey, anchorMessageId: anchor.messageId, scrollTop: 125 }, false, false, 200, 0, controller)
        if (loading) await view.render(undefined, {}, undefined, undefined, undefined, true)
        await view.render()
        for (let index = 0; index < 12 && frames.size; index++) await batch()
        expect(view.position("m40")).toBe(-75)
        expect(view.container.scrollTop).toBe(40 * 248 + 75)
        expect(view.container.scrollTop).not.toBe(125)
        expect(view.mounted.length).toBeLessThanOrEqual(8)
        expect(useSessionScrollStore.getState().sessions[sessionKey]).toMatchObject({ mode: "manual", anchor })
        const tail = [...groups(), { id: "appended", messages: [{ id: "appended", height: 400 }] }]
        await view.render(tail)
        await batch()
        expect(view.position("m40")).toBe(-75)
        expect(view.container.scrollTop).toBe(40 * 248 + 75)
      })
    }
  }

  test("maps the virtual range to a list below other scroll-container content", async () => {
    const view = fixture(groups(1600), {}, false, false, 200, 1500)
    await view.render()
    await act(async () => view.scroll(1500 + 800 * 248 + 25))
    await batch()
    expect(view.position("m800")).toBe(-25)
    expect(view.mounted.length).toBeLessThanOrEqual(8)
    expect(view.container.scrollHeight).toBe(1500 + 1600 * 248 - 8)
    await act(async () => view.scroll(1500))
    await batch()
    expect(view.position("m0")).toBe(0)
    expect(view.mounted.length).toBeLessThanOrEqual(8)
  })

  test.each([false, true])("connects a parent viewport ref attached after the child layout commit (strict: %s)", async (strict) => {
    const scrollRef: MessageListViewport["scrollRef"] = { current: null }
    const view = fixture(groups(), { scrollRef, anchorMessageId: "m40" }, strict)
    await view.render(undefined, {}, (group) => <button data-message-id={group.messages[0].id}>Message</button>)
    scrollRef.current = view.container
    await batch()
    const retained = view.message("m40")
    await act(async () => { retained.focus(); view.scroll(0) })
    await batch()
    expect(view.message("m40")).toBe(retained)
    expect(view.position("m0")).toBe(0)
    await act(async () => retained.blur())
    await batch()
    expect(retained.isConnected).toBe(false)
    await view.unmount()
    expect(observers.size).toBe(0)
    expect(frames.size).toBe(0)
  })

  test.each([false, true])("admits an empty history then bounds a 1600-group history (strict: %s)", async (strict) => {
    const view = fixture([], {}, strict)
    await view.render()
    expect(view.mounted).toEqual([])
    await view.render(groups(1600))
    expect(view.message("m1599")).toBeDefined()
    expect(view.mounted.length).toBeLessThanOrEqual(10)
    await act(async () => view.scroll(800 * 248 + 25))
    await batch()
    expect(view.position("m800")).toBe(-25)
    expect(view.mounted.length).toBeLessThanOrEqual(10)
    await view.unmount()
    expect(observers.size).toBe(0)
    expect(frames.size).toBe(0)
  })

  test("follows appended groups only at the sticky end, retaining a manual reading offset", async () => {
    let data = groups()
    const view = fixture(data)
    await view.render()
    view.setSticky(true)
    await act(async () => view.scroll(view.container.scrollHeight - view.container.clientHeight))
    await batch()
    data = [...data, { id: "append", messages: [{ id: "append", height: 650 }] }]
    await view.render(data)
    await batch()
    expect(view.container.scrollTop).toBe(view.container.scrollHeight - view.container.clientHeight)
    view.setSticky(false)
    await act(async () => view.scroll(40 * 248 + 80))
    await batch()
    const reading = view.message("m40")
    data = [...data, { id: "next", messages: [{ id: "next", height: 80 }] }]
    await view.render(data)
    await batch()
    expect(view.message("m40")).toBe(reading)
    expect(view.position("m40")).toBe(-80)
    expect(view.container.scrollTop).toBeLessThan(view.container.scrollHeight - view.container.clientHeight)
    expect(view.mounted.length).toBeLessThanOrEqual(10)
  })

  test("measures varied and oversized groups through ResizeObserver without blank viewport gaps", async () => {
    const data = groups(1600)
    for (let index = 0; index < data.length; index++) data[index].messages[0].height = [20, 90, 1600, 420][index % 4]
    const view = fixture(data, {}, false, false, 900)
    await view.render()
    for (const destination of [0, 80_000, 200_000, 100]) {
      await act(async () => view.scroll(destination))
      for (let index = 0; index < 20 && frames.size; index++) await batch()
      const bounds = view.container.getBoundingClientRect()
      expect(view.placeholders.some((node) => {
        const rect = node.getBoundingClientRect()
        return rect.bottom > bounds.top && rect.top < bounds.bottom
      })).toBe(false)
      expect(view.mounted.length).toBeLessThan(60)
      expect(frames.size).toBe(0)
    }
  })

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
    tail.tabIndex = 0
    await act(async () => tail.focus())
    view.read("m16", -50)
    await view.render([prefix, ...data], { scrollHeight: 12 * 240 + 8 * 100 + 500 + 20 * 8 })
    expect(heightReads()).toBeGreaterThan(previousReads)
    expect(view.placeholders[0].getBoundingClientRect().height).toBeGreaterThan(0)
    expect(view.mounted.length).toBeLessThanOrEqual(10)
    expect(view.position("m16")).toBeCloseTo(-50, 1)
    previousReads = heightReads()
    await view.render([data[19], ...data.slice(0, 12), prefix, ...data.slice(12, 19)])
    expect(heightReads()).toBeGreaterThan(previousReads)
    expect(view.position("m16")).toBeCloseTo(-50, 1)
    expect(view.mounted).not.toContain("g0")
    expect(view.message("m19")).toBe(tail)
    previousReads = heightReads()
    await view.render(data)
    expect(heightReads()).toBeGreaterThan(previousReads)
    expect(view.position("m16")).toBeCloseTo(-50, 1)
    expect(view.mounted.length).toBeLessThanOrEqual(10)
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
    expect(view.container.scrollHeight).toBe(20 * 100 + 19 * 8)
    view.read("m16", -50)
    let previousReads = heightReads()
    await act(async () => view.resize(900))
    expect(view.container.scrollHeight).toBeGreaterThan(20 * 100 + 19 * 8)
    expect(heightReads()).toBeGreaterThan(previousReads)
    expect(view.position("m16")).toBeCloseTo(-50, 1)
    await batch()
    expect(view.mounted.length).toBeLessThanOrEqual(10)
    expect(view.position("m16")).toBeCloseTo(-50, 1)
    await act(async () => view.resize())
    previousReads = heightReads()
    await view.render(data, { historyComplete: false, scrollHeight: 8_000 })
    expect(heightReads()).toBeGreaterThan(previousReads)
    expect(view.placeholders.some((node) => node.dataset.threadPlaceholder === "history-prefix")).toBe(true)
    expect(view.position("m16")).toBeCloseTo(-50, 1)
    await batch()
    expect(view.container.scrollHeight).toBe(8000)
    expect(view.mounted.length).toBeLessThanOrEqual(10)
    expect(view.position("m16")).toBeCloseTo(-50, 1)
    previousReads = heightReads()
    await view.render(data, { historyComplete: true })
    expect(heightReads()).toBeGreaterThan(previousReads)
    expect(view.placeholders.some((node) => node.dataset.threadPlaceholder === "history-prefix")).toBe(false)
    expect(view.mounted.length).toBeLessThanOrEqual(10)
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
    view.read("m16", -50)
    await view.render(data, { scrollHeight: 9_000 })
    expect(heightReads()).toBeGreaterThan(previousReads)
    expect(view.placeholders.find((node) => node.dataset.threadPlaceholder === "history-prefix")?.style.height).toBe("4040px")
    expect(view.container.scrollHeight).toBe(9000)
    expect(view.position("m16")).toBeCloseTo(-50, 1)
    const geometryReads = heightReads()
    await view.render(data, { leadingHeight: 1_000, trailingHeight: 500 })
    expect(heightReads()).toBeGreaterThanOrEqual(geometryReads)
    expect(view.placeholders.find((node) => node.dataset.threadPlaceholder === "history-prefix")?.style.height).toBe("1000px")
    expect(view.placeholders.find((node) => node.dataset.threadPlaceholder === "history-suffix")?.style.height).toBe("500px")
    expect(view.container.scrollHeight).toBe(20 * 248 + 1500 + 8)
    expect(view.position("m16")).toBeCloseTo(-50, 1)
  })

  for (const count of [80, 800, 1600]) {
    test(`bounds initial and deep-scroll DOM for ${count} groups and removes old nodes`, async () => {
      const data = groups(count)
      const view = fixture(data, { anchorMessageId: `m${count - 1}` })
      await view.render()
      expect(view.rendered.length).toBeLessThanOrEqual(8)
      const old = view.message(`m${count - 2}`)
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

  test("retains a custom data-state disclosure without pinning default-open groups", async () => {
    function Tool({ group }: { group: Group }) {
      const [open, setOpen] = useState(group.id !== "g40")
      return <button data-message-id={group.messages[0].id} data-state={open ? "open" : "closed"} onClick={() => setOpen(!open)}>{String(open)}</button>
    }
    const view = fixture(groups(), { anchorMessageId: "m40" })
    await view.render(undefined, {}, (group) => <Tool group={group} />)
    const retained = view.message("m40")
    const defaultOpen = view.message("m41")
    await act(async () => { retained.click(); view.scroll(0) })
    await batch()
    expect(view.message("m40")).toBe(retained)
    expect(retained.dataset.state).toBe("open")
    expect(defaultOpen.isConnected).toBe(false)
    expect(view.mounted.length).toBeLessThanOrEqual(9)
    await act(async () => retained.click())
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

  test("mounts a bounded latest window immediately then retains only the viewport and tail", async () => {
    const view = fixture()
    await view.render()
    expect(view.mounted.length).toBeLessThanOrEqual(8)
    expect(view.mounted).toContain("g76")
    expect(view.mounted).toContain("g79")
    expect(view.rendered.every((index) => index >= 72)).toBe(true)
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
    expect(view.mounted.length).toBeLessThanOrEqual(8)
    expect(view.message("m40")).toBeDefined()
    expect(view.message("m79")).toBeDefined()
    expect(view.message("m78")).toBeDefined()
    await batch()
    expect(view.message("m78")).toBeDefined()
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
    expect(view.mounted.length).toBeLessThanOrEqual(9)
  })

  test("prioritizes an anchor inside a whole group and renders live additions without waiting", async () => {
    const data = groups()
    data[40].messages.push({ id: "answer-40", height: 200 })
    const view = fixture(data, { anchorMessageId: "answer-40" })
    await view.render()
    expect(view.mounted.length).toBeLessThanOrEqual(8)
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
    expect(view.mounted.length).toBeLessThanOrEqual(8)
    await view.render(next)
    expect(view.mounted).toContain("native-g40")
    await view.render(next, { sessionKey: `replacement-${++sessionId}` }, undefined, replacements)
    expect(view.mounted).not.toContain("native-g40")
    expect(view.mounted).not.toContain("native-g0")
    expect(view.mounted.length).toBeLessThanOrEqual(8)
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
    expect(view.container.scrollTop).toBeLessThanOrEqual(before)
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
    await batch()
    const placeholderHeights = view.placeholders.map((node) => node.style.height)
    data[39].messages[0].height += 130
    // Model the browser's own anchor adjustment after an image expands.
    view.read("m40", -80)
    view.writes.length = 0
    await act(async () => view.resize())
    await view.render([...data])
    expect(view.writes).toEqual([])
    expect(view.position("m40")).toBe(-80)
    expect(view.placeholders.reduce((sum, node) => sum + Number.parseFloat(node.style.height), 0))
      .toBe(placeholderHeights.reduce((sum, height) => sum + Number.parseFloat(height), 0))
  })

  test("Find reveals every message and closing it restores a bounded window at the found result", async () => {
    const view = fixture()
    await view.render()
    view.read("m76", -50)
    await view.render(undefined, { revealAll: true })
    expect(view.position("m76")).toBe(-50)
    expect(view.mounted.length).toBe(80)
    expect(view.complete).toBe("true")
    await batch()
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

  test("keeps a partial tail's saved extent while its estimates become measured heights", async () => {
    const data = groups(100).slice(90)
    for (const group of data) group.messages[0].height = 70
    const view = fixture(data, { historyComplete: false, scrollHeight: 40_000, anchorMessageId: "m96" })
    await view.render()
    view.read("m96", -25)
    for (let index = 0; index < 10 && frames.size; index++) await batch()
    expect(view.container.scrollHeight).toBe(40_000)
    expect(view.position("m96")).toBe(-25)
    expect(view.mounted.length).toBeLessThanOrEqual(10)
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
    expect(returning.container.scrollHeight).toBe(20 * 100 + 19 * 8)
    await returning.unmount()
    const resized = fixture(data, { sessionKey: key, viewportWidth: 900 })
    await resized.render()
    expect(resized.container.scrollHeight).toBeGreaterThan(20 * 100 + 19 * 8)
    expect(resized.container.scrollHeight).toBeLessThanOrEqual(20 * 240 + 19 * 8)
    await resized.unmount()
    for (let index = 0; index < 12; index++) {
      const other = fixture(groups(1))
      await other.render()
      await other.unmount()
    }
    const evicted = fixture(data, { sessionKey: key })
    await evicted.render()
    expect(evicted.container.scrollHeight).toBeGreaterThan(20 * 100 + 19 * 8)
    expect(evicted.container.scrollHeight).toBeLessThanOrEqual(20 * 240 + 19 * 8)
  })

  test("cancels pending work on a same-instance session switch and on unmount", async () => {
    const view = fixture()
    await view.render()
    await act(async () => runFrame())
    const pending = [...frames.keys()]
    const newReady = mock(() => {})
    await view.render(undefined, { sessionKey: `switch-${++sessionId}`, onReady: newReady })
    expect(view.mounted.length).toBeLessThanOrEqual(8)
    expect(pending.every((id) => !frames.has(id))).toBe(true)
    const oldCalls = view.ready.mock.calls.length
    await batch()
    expect(view.ready.mock.calls.length).toBe(oldCalls)
    expect(newReady).toHaveBeenCalled()
    await view.unmount()
    expect(frames.size).toBe(0)
    expect(observers.size).toBe(0)
  })

  test("resumes background work and viewport listeners after Strict Mode's mount replay", async () => {
    const view = fixture(groups(), {}, true)
    await view.render()
    expect(view.mounted.length).toBeLessThanOrEqual(8)
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
