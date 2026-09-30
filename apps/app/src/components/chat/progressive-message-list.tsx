import * as React from "react"
import { defaultRangeExtractor, observeElementOffset, observeElementRect, useVirtualizer, type Range, type Rect, type Virtualizer } from "@tanstack/react-virtual"

export interface MessageListViewport {
  sessionKey: string
  scrollRef: React.RefObject<HTMLDivElement | null>
  anchorMessageId?: string
  scrollTop?: number
  scrollHeight?: number
  viewportWidth?: number
  leadingHeight?: number
  trailingHeight?: number
  historyComplete: boolean
  revealAll?: boolean
  stickyBottom: () => boolean
  onReady?: () => void
}

interface ProgressiveMessageListProps<T> {
  groups: readonly T[]
  getGroupKey: (group: T) => string
  getMessageIds: (group: T) => readonly string[]
  groupKeyReplacements?: ReadonlyMap<string, string>
  priorityMessageId?: string
  renderGroup: (group: T, index: number) => React.ReactNode
  viewport?: MessageListViewport
  className?: string
  header?: React.ReactNode
  children?: React.ReactNode
}

const GROUP_GAP = 8
const ESTIMATED_HEIGHT = 240
const MAX_CACHED_VIEWPORTS = 12
const MAX_CACHED_GROUPS = 2048
const heightCache = new Map<string, Map<string, number>>()
// Existing reading-anchor and session controllers own scroll writes. TanStack
// observes their actual offset; its initial connection must not restore it again.
const observeOnlyScroll = () => {}
type ThreadVirtualizer = Virtualizer<HTMLDivElement, HTMLDivElement>
type Segment = { key: string; index: number; height: number; placeholder: boolean }
type ReadingPosition = { element: HTMLElement | null; messageId?: string; offset: number; top: number; sticky: boolean }

function sameKeys(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((key, index) => key === b[index])
}

function sameStructure(a: readonly Segment[], b: readonly Segment[]) {
  return a.length === b.length && a.every((segment, index) => {
    const other = b[index]
    return segment.key === other.key && (!segment.placeholder || segment.height === other.height)
  })
}

export function ProgressiveMessageList<T>(props: ProgressiveMessageListProps<T>) {
  return <VirtualGroups key={props.viewport?.sessionKey ?? "eager"} {...props} />
}

function VirtualGroups<T>(props: ProgressiveMessageListProps<T>) {
  const { groups, getGroupKey, getMessageIds, viewport } = props
  const nextKeys = React.useMemo(() => groups.map(getGroupKey), [groups, getGroupKey])
  const [keys, setKeys] = React.useState(nextKeys)
  if (!sameKeys(keys, nextKeys)) setKeys(nextKeys)
  const currentKeys = sameKeys(keys, nextKeys) ? keys : nextKeys
  const identities = React.useRef(new Map<string, string>())
  for (const [key, previous] of props.groupKeyReplacements ?? []) {
    if (!identities.current.has(key)) identities.current.set(key, identities.current.get(previous) ?? previous)
  }
  const identityKeys = React.useMemo(() => currentKeys.map((key) => identities.current.get(key) ?? key), [currentKeys])
  const getItemKey = React.useCallback((index: number) => identityKeys[index], [identityKeys])
  const anchorIndex = React.useMemo(() => viewport?.anchorMessageId
    ? groups.findIndex((group) => getMessageIds(group).includes(viewport.anchorMessageId!)) : -1,
  [groups, getMessageIds, viewport?.anchorMessageId])
  const priorityIndex = React.useMemo(() => props.priorityMessageId
    ? groups.findIndex((group) => getMessageIds(group).includes(props.priorityMessageId!)) : -1,
  [groups, getMessageIds, props.priorityMessageId])
  const bridge = React.useRef<MeasuredGroups<T>>(null)
  const [revision, refresh] = React.useReducer((value: number) => value + 1, 0)
  const [width, setWidth] = React.useState(viewport?.viewportWidth ?? 0)
  const [scrollMargin, setScrollMargin] = React.useState(0)
  const syncOffset = React.useRef<(() => void) | null>(null)
  const observeOffset = React.useCallback((instance: ThreadVirtualizer, callback: (offset: number, isScrolling: boolean) => void) => {
    const element = instance.scrollElement
    let active = true
    const sync = () => {
      if (active && element && element.clientHeight > 0 && element.clientWidth > 0 && element.scrollTop !== instance.scrollOffset) callback(element.scrollTop, false)
    }
    syncOffset.current = sync
    sync()
    const unsubscribe = observeElementOffset(instance, (offset, isScrolling) => {
      if (active && element && element.clientHeight > 0 && element.clientWidth > 0) callback(element.scrollTop ?? offset, isScrolling)
    })
    return () => {
      active = false
      unsubscribe?.()
      if (syncOffset.current === sync) syncOffset.current = null
    }
  }, [])
  const observeViewport = React.useCallback((instance: ThreadVirtualizer, callback: (rect: Rect) => void) => {
    let previous: Rect | undefined
    return observeElementRect(instance, (rect) => {
      const width = instance.scrollElement?.clientWidth ?? rect.width
      const changed = previous?.width !== width || previous?.height !== rect.height
      previous = { width, height: rect.height }
      // A transient zero-size layout is not an empty transcript. Keep the last
      // window and refresh its origin/offset on reveal, even at the same width.
      if (width <= 0 || rect.height <= 0) return
      setWidth(width)
      callback(rect)
      if (changed) refresh()
    })
  }, [])
  const cacheKey = JSON.stringify([viewport?.sessionKey, width])
  const estimates = React.useMemo(() => {
    const cached = heightCache.get(cacheKey)
    const known = currentKeys.reduce((sum, key) => sum + (cached?.get(key) ?? 0), 0)
    const unknown = currentKeys.filter((key) => !cached?.has(key)).length
    const estimate = viewport?.historyComplete && viewport.scrollHeight && unknown
      ? Math.max(32, (viewport.scrollHeight - known - GROUP_GAP * Math.max(0, currentKeys.length - 1)) / unknown)
      : ESTIMATED_HEIGHT
    return { cached: new Map(cached), estimate }
  }, [cacheKey, viewport?.historyComplete])
  const estimateSize = React.useCallback((index: number) => estimates.cached.get(currentKeys[index]) ?? estimates.estimate,
    [estimates, currentKeys])
  const estimatedTotal = React.useMemo(() => currentKeys.reduce((sum, _, index) => sum + estimateSize(index) + GROUP_GAP, 0), [currentKeys, estimateSize])
  const [measuredExtent, setMeasuredExtent] = React.useState<{ keys: readonly string[]; estimates: typeof estimates; size: number } | null>(null)
  const onChange = React.useCallback((instance: ThreadVirtualizer) => {
    if (!viewport || viewport.historyComplete || viewport.leadingHeight !== undefined) return
    const size = instance.getTotalSize() - instance.options.paddingStart - instance.options.paddingEnd + (currentKeys.length ? GROUP_GAP : 0)
    setMeasuredExtent((previous) => previous?.keys === currentKeys && previous.estimates === estimates && previous.size === size
      ? previous : { keys: currentKeys, estimates, size })
  }, [currentKeys, estimates, viewport?.historyComplete, viewport?.leadingHeight, Boolean(viewport)])
  const contentExtent = measuredExtent?.keys === currentKeys && measuredExtent.estimates === estimates ? measuredExtent.size : estimatedTotal
  const initialOffset = () => viewport?.scrollTop ?? (leading + currentKeys.slice(0, Math.max(0, anchorIndex >= 0 ? anchorIndex : currentKeys.length - 4))
    .reduce((sum, _, index) => sum + estimateSize(index) + GROUP_GAP, 0))
  const leading = viewport && !viewport.historyComplete
    ? viewport.leadingHeight ?? Math.max(0, (viewport.scrollHeight ?? 0) - contentExtent) : 0
  const trailing = viewport && !viewport.historyComplete ? viewport.trailingHeight ?? 0 : 0
  const getScrollElement = React.useCallback(() => viewport?.scrollRef.current ?? null, [viewport?.scrollRef])
  const rangeExtractor = React.useCallback((range: Range) => {
    if (!viewport || viewport.revealAll) return Array.from({ length: range.count }, (_, index) => index)
    const indexes = new Set(defaultRangeExtractor(range))
    const retained = bridge.current && bridge.current.props.keys !== currentKeys
      ? bridge.current.mountedKeys() : bridge.current?.retainedKeys() ?? []
    for (const key of retained) {
      const index = identityKeys.indexOf(key)
      if (index >= 0) indexes.add(index)
    }
    if (range.count) indexes.add(range.count - 1)
    if (priorityIndex >= 0) indexes.add(priorityIndex)
    if (anchorIndex >= 0 && (!bridge.current || bridge.current.waitingForAnchor)) indexes.add(anchorIndex)
    return [...indexes].sort((a, b) => a - b)
  }, [identityKeys, priorityIndex, anchorIndex, viewport?.revealAll, Boolean(viewport), revision])
  const measureElement = React.useCallback((node: HTMLDivElement, entry: ResizeObserverEntry | undefined, instance: ThreadVirtualizer) => {
    const index = instance.indexFromElement(node)
    if (!viewport?.scrollRef.current?.clientHeight || !viewport.scrollRef.current.clientWidth) {
      return instance.measurementsCache[index]?.size ?? estimateSize(index)
    }
    const height = entry?.borderBoxSize[0]?.blockSize ?? node.getBoundingClientRect().height
    const key = node.dataset.threadGroup
    const measuredWidth = viewport?.scrollRef.current?.clientWidth ?? 0
    if (key && height > 0 && viewport && measuredWidth > 0) {
      const measuredCacheKey = JSON.stringify([viewport.sessionKey, measuredWidth])
      const cache = heightCache.get(measuredCacheKey) ?? new Map<string, number>()
      heightCache.delete(measuredCacheKey)
      heightCache.set(measuredCacheKey, cache)
      cache.delete(key)
      cache.set(key, height)
      if (cache.size > MAX_CACHED_GROUPS) cache.delete(cache.keys().next().value!)
      if (heightCache.size > MAX_CACHED_VIEWPORTS) heightCache.delete(heightCache.keys().next().value!)
    }
    return height
  }, [viewport?.sessionKey, viewport?.scrollRef, estimateSize])
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: currentKeys.length,
    getScrollElement,
    observeElementRect: observeViewport,
    observeElementOffset: observeOffset,
    scrollToFn: observeOnlyScroll,
    getItemKey,
    estimateSize,
    measureElement,
    rangeExtractor,
    onChange,
    overscan: 2,
    gap: GROUP_GAP,
    scrollMargin,
    paddingStart: leading > 0 ? leading + GROUP_GAP : 0,
    paddingEnd: trailing > 0 ? trailing + GROUP_GAP : 0,
    initialRect: { width, height: viewport?.scrollRef.current?.clientHeight || 600 },
    initialOffset,
    useFlushSync: false,
  })
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false
  React.useLayoutEffect(() => {
    const offset = bridge.current?.contentOffset()
    if (offset !== undefined && offset !== scrollMargin) setScrollMargin(offset)
  })
  React.useLayoutEffect(() => {
    virtualizer.measure()
    bridge.current?.measureMounted()
  }, [virtualizer, estimates])
  React.useLayoutEffect(() => { syncOffset.current?.() })
  const items = virtualizer.getVirtualItems()
  const segments: Segment[] = []
  if (leading > 0) segments.push({ key: "history-prefix", index: -1, height: leading, placeholder: true })
  let end = scrollMargin + (leading > 0 ? leading + GROUP_GAP : 0)
  for (const item of items) {
    if (item.start > end) segments.push({ key: `placeholder:${currentKeys[item.index - 1]}`, index: -1,
      height: Math.max(0, item.start - end - GROUP_GAP), placeholder: true })
    segments.push({ key: `group:${item.key}`, index: item.index, height: item.size, placeholder: false })
    end = item.end + GROUP_GAP
  }
  if (trailing > 0) segments.push({ key: "history-suffix", index: -1, height: trailing, placeholder: true })
  if (!viewport) {
    segments.length = 0
    currentKeys.forEach((key, index) => segments.push({ key: `group:${key}`, index, height: 0, placeholder: false }))
  }
  return <MeasuredGroups ref={bridge} {...props} keys={currentKeys} segments={segments}
    virtualizer={virtualizer} refresh={refresh} anchorIndex={anchorIndex} />
}

class RenderedGroup<T> extends React.PureComponent<{
  group: T
  index: number
  renderGroup: ProgressiveMessageListProps<T>["renderGroup"]
}> {
  render() {
    const content = this.props.renderGroup(this.props.group, this.props.index)
    return React.isValidElement(content) ? React.cloneElement(content, { key: "content" }) : content
  }
}

type MeasuredGroupsProps<T> = ProgressiveMessageListProps<T> & {
  keys: readonly string[]
  segments: Segment[]
  virtualizer: ThreadVirtualizer
  refresh: () => void
  anchorIndex: number
}

class MeasuredGroups<T> extends React.Component<MeasuredGroupsProps<T>> {
  private container: HTMLDivElement | null = null
  private list = React.createRef<HTMLDivElement>()

  contentOffset() {
    const list = this.list.current
    if (!list || !this.container?.clientHeight || !this.container.clientWidth) return undefined
    const style = window.getComputedStyle(list)
    let top = list.getBoundingClientRect().top + (Number.parseFloat(style.borderTopWidth) || 0) + (Number.parseFloat(style.paddingTop) || 0)
    if (this.props.header) {
      const gap = Number.parseFloat(style.rowGap) || GROUP_GAP
      for (const child of list.children) {
        if (child.hasAttribute("data-thread-placeholder") || child.hasAttribute("data-thread-group")) break
        if (window.getComputedStyle(child).display !== "none") top = Math.max(top, child.getBoundingClientRect().bottom + gap)
      }
    }
    return top - this.container.getBoundingClientRect().top + this.container.scrollTop
  }
  private nodes = new Map<string, HTMLDivElement>()
  private nodeRefs = new Map<string, React.RefCallback<HTMLDivElement>>()
  private interacted = new WeakMap<HTMLElement, Map<Element, string>>()
  private interactions: MutationObserver | null = null
  private frame: number | null = null
  private committed: Segment[] = []
  private pendingInteraction = new Set<HTMLElement>()
  private active = false
  waitingForAnchor = Boolean(this.props.viewport?.anchorMessageId)

  private groupRef(key: string) {
    let ref = this.nodeRefs.get(key)
    if (!ref) {
      ref = (node) => {
        if (!node) return
        this.nodes.set(key, node)
        if (node.hasAttribute("data-thread-group")) this.props.virtualizer.measureElement(node)
        return () => {
          this.nodes.delete(key)
          this.nodeRefs.delete(key)
          this.props.virtualizer.measureElement(null)
        }
      }
      this.nodeRefs.set(key, ref)
    }
    return ref
  }

  measureMounted() {
    for (const node of this.nodes.values()) {
      if (node.hasAttribute("data-thread-group")) this.props.virtualizer.measureElement(node)
    }
  }

  private disclosureState(node: Element) {
    return node.getAttribute("aria-expanded") ?? node.getAttribute("data-state") ?? String(node.hasAttribute("open"))
  }

  mountedKeys() {
    return [...this.nodes].filter(([, node]) => node.hasAttribute("data-thread-group")).map(([key]) => key.slice("group:".length))
  }

  retainedKeys() {
    const retained: string[] = []
    const focused = document.activeElement
    const selection = document.getSelection()
    for (const [key, node] of this.nodes) {
      if (!node.hasAttribute("data-thread-group")) continue
      const rect = node.getBoundingClientRect()
      const bounds = this.container?.getBoundingClientRect()
      let keep = this.pendingInteraction.has(node) || Boolean(focused && node.contains(focused))
        || Boolean(bounds && rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom)
      const initial = this.interacted.get(node)
      if (initial) {
        for (const control of node.querySelectorAll('[aria-expanded], [data-state="open"], [data-state="closed"], details, dialog')) {
          const state = this.disclosureState(control)
          if (initial.has(control) ? initial.get(control) !== state : state === "true" || state === "open") keep = true
        }
      }
      if (focused && [...node.querySelectorAll("[aria-controls]")].some((trigger) =>
        trigger.getAttribute("aria-controls")?.split(/\s+/).some((id) => document.getElementById(id)?.contains(focused)))) keep = true
      if (selection && !selection.isCollapsed) {
        for (let index = 0; index < selection.rangeCount; index++) {
          if (selection.getRangeAt(index).intersectsNode(node)) keep = true
        }
      }
      if (keep) retained.push(key.slice("group:".length))
    }
    return retained
  }

  private handleInteraction = (event: Event) => {
    const group = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-thread-group]") : null
    if (group) this.pendingInteraction.add(group)
    if (group && !this.interacted.has(group)) {
      this.interacted.set(group, new Map([...group.querySelectorAll('[aria-expanded], [data-state="open"], [data-state="closed"], details, dialog')]
        .map((control) => [control, this.disclosureState(control)])))
    }
    this.schedule()
  }

  private schedule = () => {
    if (this.frame !== null || !this.active || !this.props.viewport) return
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null
      if (!this.active) return
      this.connectViewport()
      if (this.container && (!this.container.clientHeight || !this.container.clientWidth)) return
      this.pendingInteraction.clear()
      if (this.props.anchorIndex >= 0 || this.props.viewport?.historyComplete) this.waitingForAnchor = false
      this.props.refresh()
    })
  }

  private connectViewport() {
    const container = this.props.viewport?.scrollRef.current ?? null
    if (container === this.container) return
    this.container?.removeEventListener("click", this.handleInteraction, true)
    this.container?.removeEventListener("keydown", this.handleInteraction, true)
    this.interactions?.disconnect()
    this.container = container
    container?.addEventListener("click", this.handleInteraction, true)
    container?.addEventListener("keydown", this.handleInteraction, true)
    this.interactions = new MutationObserver(this.schedule)
    if (container) this.interactions.observe(container, {
      subtree: true, attributes: true, attributeFilter: ["aria-expanded", "aria-controls", "data-state", "open"],
    })
  }

  componentDidMount() {
    this.active = true
    this.committed = this.props.segments
    this.connectViewport()
    document.addEventListener("selectionchange", this.schedule)
    document.addEventListener("focusin", this.schedule)
    document.addEventListener("focusout", this.schedule)
    this.measureMounted()
    this.props.viewport?.onReady?.()
    if (!this.container) this.schedule()
  }

  getSnapshotBeforeUpdate(): ReadingPosition | null {
    const container = this.container
    if (!container || sameStructure(this.committed, this.props.segments)) return null
    const bounds = container.getBoundingClientRect()
    const sticky = Boolean(this.props.viewport?.stickyBottom()) && container.scrollHeight - container.scrollTop - container.clientHeight <= 1
    const reserved = [...this.nodes.values()].some((node) => {
      if (!['history-prefix', 'history-suffix'].includes(node.dataset.threadPlaceholder ?? "")) return false
      const rect = node.getBoundingClientRect()
      return rect.top <= bounds.top && rect.bottom > bounds.top
    })
    const top = container.scrollTop
    if (top === 0 || reserved) return { element: null, offset: 0, top, sticky }
    for (const node of container.querySelectorAll<HTMLElement>("[data-message-id]")) {
      const rect = node.getBoundingClientRect()
      if (rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom) {
        return { element: node, messageId: node.dataset.messageId, offset: rect.top - bounds.top, top, sticky }
      }
    }
    return { element: null, offset: 0, top, sticky }
  }

  componentDidUpdate(previous: MeasuredGroupsProps<T>, _state: unknown, snapshot: ReadingPosition | null) {
    this.connectViewport()
    const changed = !sameStructure(this.committed, this.props.segments) || previous.viewport?.historyComplete !== this.props.viewport?.historyComplete
    this.committed = this.props.segments
    if (previous.keys !== this.props.keys || this.waitingForAnchor && (this.props.anchorIndex >= 0 || this.props.viewport?.historyComplete)) this.schedule()
    const container = this.container
    if (container && snapshot) {
      const element = snapshot.element?.isConnected ? snapshot.element
        : [...container.querySelectorAll<HTMLElement>("[data-message-id]")].find((node) => node.dataset.messageId === snapshot.messageId)
      const top = snapshot.sticky && this.props.viewport?.stickyBottom()
        ? Math.max(0, container.scrollHeight - container.clientHeight)
        : element ? container.scrollTop + element.getBoundingClientRect().top - container.getBoundingClientRect().top - snapshot.offset
        : snapshot.top
      if (Math.abs(container.scrollTop - top) > 0.5) container.scrollTop = top
    }
    this.measureMounted()
    if (changed) this.props.viewport?.onReady?.()
  }

  componentWillUnmount() {
    this.active = false
    if (this.frame !== null) window.cancelAnimationFrame(this.frame)
    this.frame = null
    this.container?.removeEventListener("click", this.handleInteraction, true)
    this.container?.removeEventListener("keydown", this.handleInteraction, true)
    document.removeEventListener("selectionchange", this.schedule)
    document.removeEventListener("focusin", this.schedule)
    document.removeEventListener("focusout", this.schedule)
    this.container = null
    this.interactions?.disconnect()
  }

  render() {
    const { groups, keys, segments, renderGroup, viewport, header, children, className } = this.props
    return <div ref={this.list} className={`flex flex-col gap-2 ${className ?? ""}`} data-thread-history-complete={viewport?.historyComplete ?? true} data-thread-virtualized={Boolean(viewport)}>
      {header}
      {segments.map((segment) => segment.placeholder
        ? <div key={segment.key} ref={this.groupRef(segment.key)} data-thread-placeholder={segment.key} aria-hidden="true"
            style={{ height: segment.height, flexShrink: 0, overflowAnchor: "none" }} />
        : <div key={segment.key} ref={this.groupRef(segment.key)} data-index={segment.index} data-thread-group={keys[segment.index]} className="min-w-0 shrink-0 empty:hidden">
            <RenderedGroup group={groups[segment.index]} index={segment.index} renderGroup={renderGroup} />
          </div>)}
      {children}
    </div>
  }
}
