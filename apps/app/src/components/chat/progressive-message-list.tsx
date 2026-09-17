import * as React from "react"

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
  /** Called after initial/structural commits, not after ordinary content reflow. */
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

const INITIAL_GROUPS = 8
const OVERSCAN_PX = 480
const GROUP_GAP = 8
const ESTIMATED_HEIGHT = 240
const MAX_CACHED_VIEWPORTS = 12
const MAX_CACHED_GROUPS = 2048
// Only IDs and geometry, scoped by session and width. Nothing is persisted.
const heightCache = new Map<string, Map<string, number>>()

type MountState = {
  identities: ReadonlyMap<string, string>
  mounted: ReadonlySet<string>
  initialized: boolean
  anchorPending: boolean
  width: number
}

type Segment = { key: string; start: number; end: number; height: number; placeholder: boolean }
type Plan = { keys: string[]; heights: number[]; segments: Segment[]; complete: boolean }
type HeightPlan = { keys: string[]; scrollHeight: number | undefined; heights: number[]; totalHeight: number }
type ReadingPosition = {
  reservedTop?: number
  element: HTMLElement | null
  messageId?: string
  key: string | undefined
  offset: number
  fraction: number
  sticky: boolean
}

function addNearby(keys: readonly string[], mounted: ReadonlySet<string>, center: number) {
  const next = new Set(mounted)
  let added = 0
  for (let distance = 0; distance < keys.length && added < INITIAL_GROUPS; distance++) {
    for (const index of distance === 0 ? [center] : [center - distance, center + distance]) {
      const key = keys[index]
      if (key !== undefined && !next.has(key)) {
        next.add(key)
        if (++added === INITIAL_GROUPS) break
      }
    }
  }
  return next
}

function sameStructure(a: Plan, b: Plan) {
  return a.segments.length === b.segments.length
    && a.segments.every((segment, index) => {
      const other = b.segments[index]
      return segment.key === other.key && (!segment.placeholder || segment.height === other.height)
    })
}

function sameKeys(a: readonly string[], b: readonly string[]) {
  return a === b || (a.length === b.length && a.every((key, index) => key === b[index]))
}

export function ProgressiveMessageList<T>(props: ProgressiveMessageListProps<T>) {
  const { groups, getGroupKey, getMessageIds, priorityMessageId } = props
  const keys = React.useMemo(() => groups.map(getGroupKey), [groups, getGroupKey])
  const anchorMessageId = props.viewport?.anchorMessageId
  const anchorIndex = React.useMemo(() => anchorMessageId
    ? groups.findIndex((group) => getMessageIds(group).includes(anchorMessageId))
    : -1, [groups, getMessageIds, anchorMessageId])
  const priorityIndex = React.useMemo(() => priorityMessageId
    ? groups.findIndex((group) => getMessageIds(group).includes(priorityMessageId))
    : -1, [groups, getMessageIds, priorityMessageId])
  return <ProgressiveGroups key={props.viewport?.sessionKey ?? "eager"} {...props} keys={keys} anchorIndex={anchorIndex} priorityIndex={priorityIndex} />
}

type PreparedGroupsProps<T> = ProgressiveMessageListProps<T> & { keys: string[]; anchorIndex: number; priorityIndex: number }

// Internal mount batches reuse settled output. Parent callback changes must
// invalidate it too: the callback captures streaming, last-step and other props.
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

// getSnapshotBeforeUpdate reads the actual pre-mutation DOM, including any scroll
// since a batch was queued. An effect's previous-commit anchor would snap readers back.
class ProgressiveGroups<T> extends React.Component<PreparedGroupsProps<T>, MountState> {
  state: MountState = {
    identities: new Map(),
    mounted: new Set(),
    initialized: false,
    anchorPending: Boolean(this.props.viewport?.anchorMessageId),
    width: this.props.viewport?.viewportWidth ?? 0,
  }

  static getDerivedStateFromProps<T>(props: PreparedGroupsProps<T>, state: MountState): MountState | null {
    const { keys, anchorIndex, priorityIndex } = props
    if (!keys.length) return null
    let identities = state.identities
    const replacements = [...(props.groupKeyReplacements ?? [])]
      .filter(([key, previous]) => state.mounted.has(previous) && !state.mounted.has(key) && keys.includes(key))
    if (replacements.length) {
      const next = new Map(identities)
      for (const [key, previous] of replacements) {
        next.set(`group:${key}`, next.get(`group:${previous}`) ?? previous)
        next.delete(`group:${previous}`)
      }
      identities = next
    }
    let mounted = replacements.length ? new Set([...state.mounted, ...replacements.map(([key]) => key)]) : state.mounted
    const last = keys[keys.length - 1]
    const immediate = priorityIndex >= 0 ? [keys[priorityIndex], last] : [last]
    if (!props.viewport || props.viewport.revealAll) {
      if (keys.every((key) => state.mounted.has(key))) return null
      mounted = new Set(keys)
    } else if (!state.initialized || (anchorIndex >= 0 && (state.anchorPending
      || !mounted.has(keys[anchorIndex]) && [...mounted].some((key) => !keys.includes(key))))) {
      const estimatedIndex = props.viewport.scrollTop !== undefined && props.viewport.scrollHeight
        ? Math.min(keys.length - 1, Math.floor(keys.length * props.viewport.scrollTop / props.viewport.scrollHeight)) : keys.length - 1
      const nearby = addNearby(keys, mounted, anchorIndex >= 0 ? anchorIndex : estimatedIndex)
      for (const key of immediate) {
        if (nearby.has(key)) continue
        const furthest = [...nearby].findLast((candidate) => !mounted.has(candidate)
          && candidate !== keys[anchorIndex] && !immediate.includes(candidate))
        if (furthest !== undefined) nearby.delete(furthest)
        nearby.add(key)
      }
      mounted = nearby
    } else if (immediate.some((key) => !mounted.has(key))) {
      mounted = new Set([...mounted, ...immediate])
    } else if (mounted === state.mounted) return null
    return { ...state, identities, mounted, initialized: true, anchorPending: state.anchorPending && anchorIndex < 0 && !props.viewport?.historyComplete }
  }

  private nodes = new Map<string, HTMLDivElement>()
  private nodeRefs = new Map<string, React.RefCallback<HTMLDivElement>>()

  private groupRef(key: string) {
    let ref = this.nodeRefs.get(key)
    if (!ref) {
      ref = (node) => this.trackNode(node)
      this.nodeRefs.set(key, ref)
    }
    return ref
  }
  private plan: Plan = { keys: [], heights: [], segments: [], complete: false }
  private committed = this.plan
  private container: HTMLDivElement | null = null
  private observer: ResizeObserver | null = null
  private interactions: MutationObserver | null = null
  private interacted = new WeakMap<HTMLElement, Map<Element, string>>()
  private frame: number | null = null
  private active = false
  private estimates = new Map<string, number>()
  private estimateScope = ""
  private heightPlan: HeightPlan | null = null

  private cacheKey(width = this.state.width) {
    return JSON.stringify([this.props.viewport?.sessionKey, width])
  }

  private measure = (node: HTMLElement) => {
    const key = node.getAttribute("data-thread-group")
    const height = node.getBoundingClientRect().height
    const width = this.container?.clientWidth || this.state.width
    if (key === null || height <= 0 || !this.props.viewport || width <= 0) return
    const cacheKey = this.cacheKey(width)
    const cache = heightCache.get(cacheKey) ?? new Map<string, number>()
    heightCache.delete(cacheKey)
    heightCache.set(cacheKey, cache)
    cache.delete(key)
    cache.set(key, height)
    if (width === this.state.width && this.estimates.get(key) !== height) {
      this.estimates.set(key, height)
      const index = this.heightPlan?.keys.indexOf(key) ?? -1
      if (this.heightPlan && index >= 0) {
        this.heightPlan.totalHeight += height - this.heightPlan.heights[index]
        this.heightPlan.heights[index] = height
      }
    }
    if (cache.size > MAX_CACHED_GROUPS) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    if (heightCache.size > MAX_CACHED_VIEWPORTS) {
      const oldest = heightCache.keys().next().value
      if (oldest !== undefined) heightCache.delete(oldest)
    }
  }

  private trackNode = (node: HTMLDivElement | null) => {
    if (!node) return
    const group = node.getAttribute("data-thread-group")
    const key = group === null ? node.getAttribute("data-thread-placeholder") : `group:${group}`
    if (key === null) return
    this.nodes.set(key, node)
    if (group !== null && this.observer) {
      this.observer.observe(node)
      this.measure(node)
    }
    return () => {
      this.observer?.unobserve(node)
      this.nodes.delete(key)
      if (group !== null) this.nodeRefs.delete(key)
    }
  }

  private connectViewport() {
    const container = this.props.viewport?.scrollRef.current
    if (!container || this.container === container) return
    this.container?.removeEventListener("scroll", this.handleScroll)
    this.container?.removeEventListener("click", this.handleInteraction, true)
    this.container?.removeEventListener("keydown", this.handleInteraction, true)
    this.observer?.disconnect()
    this.interactions?.disconnect()
    this.container = container
    container.addEventListener("scroll", this.handleScroll, { passive: true })
    container.addEventListener("click", this.handleInteraction, true)
    container.addEventListener("keydown", this.handleInteraction, true)
    document.addEventListener("selectionchange", this.handleScroll)
    document.addEventListener("focusin", this.handleScroll)
    document.addEventListener("focusout", this.handleScroll)
    this.interactions = new MutationObserver(this.handleScroll)
    this.interactions.observe(container, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ["aria-expanded", "aria-controls", "data-state", "open"],
    })
    this.observer = new ResizeObserver((entries) => {
      if (!this.active) return
      const width = container.clientWidth
      if (width > 0 && width !== this.state.width) {
        this.setState({ width })
        return
      }
      for (const entry of entries) if (entry.target instanceof HTMLElement) this.measure(entry.target)
      this.schedule()
    })
    this.observer.observe(container)
    for (const node of this.nodes.values()) {
      if (node.hasAttribute("data-thread-group")) this.observer.observe(node)
    }
    if (container.clientWidth > 0 && container.clientWidth !== this.state.width) this.setState({ width: container.clientWidth })
  }

  private position(plan: Plan, index: number) {
    const segment = plan.segments.find((part) => part.start <= index && part.end > index)
    if (!segment) return null
    const node = this.nodes.get(segment.key)
    if (!node) return null
    let top = node.getBoundingClientRect().top
    if (segment.placeholder) {
      for (let i = segment.start; i < index; i++) top += plan.heights[i] + GROUP_GAP
    }
    return { top, height: segment.placeholder ? plan.heights[index] : node.getBoundingClientRect().height }
  }

  private visibleIndex(plan: Plan) {
    const top = this.container?.getBoundingClientRect().top ?? 0
    for (const segment of plan.segments) {
      const node = this.nodes.get(segment.key)
      if (!node || segment.end <= segment.start) continue
      const rect = node.getBoundingClientRect()
      if (rect.bottom <= top) continue
      let offset = rect.top
      for (let i = segment.start; i < segment.end; i++) {
        if (!segment.placeholder || offset + plan.heights[i] + GROUP_GAP > top) return i
        offset += plan.heights[i] + GROUP_GAP
      }
    }
    return Math.max(0, plan.keys.length - 1)
  }

  private disclosureState(node: Element) {
    return node.getAttribute("aria-expanded") ?? node.getAttribute("data-state") ?? String(node.hasAttribute("open"))
  }

  private interactive(node: HTMLElement) {
    const focused = document.activeElement
    if (focused && node.contains(focused)) return true
    const initial = this.interacted.get(node)
    if (initial) {
      for (const control of node.querySelectorAll('[aria-expanded], [data-state="open"], [data-state="closed"], details, dialog')) {
        const state = this.disclosureState(control)
        if (initial.has(control) ? initial.get(control) !== state : state === "true" || state === "open") return true
      }
    }
    if (focused && [...node.querySelectorAll("[aria-controls]")].some((trigger) =>
      trigger.getAttribute("aria-controls")?.split(/\s+/).some((id) => document.getElementById(id)?.contains(focused)))) return true
    const selection = document.getSelection()
    if (!selection || selection.isCollapsed) return false
    for (let index = 0; index < selection.rangeCount; index++) {
      if (selection.getRangeAt(index).intersectsNode(node)) return true
    }
    return false
  }

  private windowKeys() {
    const next = new Set<string>()
    const bounds = this.container?.getBoundingClientRect()
    if (!bounds) return next
    const { keys, heights, segments } = this.committed
    for (const segment of segments) {
      const node = this.nodes.get(segment.key)
      if (!node || segment.end <= segment.start) continue
      const rect = node.getBoundingClientRect()
      if (!segment.placeholder && this.interactive(node)) next.add(keys[segment.start])
      if (rect.bottom < bounds.top - OVERSCAN_PX || rect.top > bounds.bottom + OVERSCAN_PX) continue
      let top = rect.top
      for (let index = segment.start; index < segment.end; index++) {
        const height = segment.placeholder ? heights[index] : rect.height
        if (top + height >= bounds.top - OVERSCAN_PX && top <= bounds.bottom + OVERSCAN_PX) next.add(keys[index])
        top += height + GROUP_GAP
        if (top > bounds.bottom + OVERSCAN_PX) break
      }
    }
    const last = keys.at(-1)
    if (last !== undefined) next.add(last)
    const priority = keys[this.props.priorityIndex]
    if (priority !== undefined) next.add(priority)
    return next
  }

  private handleInteraction = (event: Event) => {
    const group = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-thread-group]") : null
    if (group && !this.interacted.has(group)) {
      this.interacted.set(group, new Map([...group.querySelectorAll('[aria-expanded], [data-state="open"], [data-state="closed"], details, dialog')]
        .map((control) => [control, this.disclosureState(control)])))
    }
  }

  private handleScroll = () => { this.schedule() }

  private schedule() {
    if (this.props.viewport?.revealAll && this.frame !== null) {
      window.cancelAnimationFrame(this.frame)
      this.frame = null
    }
    if (!this.active || this.frame !== null || !this.props.viewport || this.props.viewport.revealAll) return
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null
      if (!this.active) return
      this.connectViewport()
      if (!this.container) return
      for (const node of this.nodes.values()) this.measure(node)
      const mounted = this.windowKeys()
      if (mounted.size !== this.state.mounted.size || [...mounted].some((key) => !this.state.mounted.has(key))) {
        this.setState({ mounted })
      }
    })
  }

  componentDidMount() {
    this.active = true
    this.committed = this.plan
    this.connectViewport()
    for (const node of this.nodes.values()) this.measure(node)
    this.props.viewport?.onReady?.()
    this.schedule()
  }

  getSnapshotBeforeUpdate(): ReadingPosition | null {
    const container = this.container
    if (!container || sameStructure(this.committed, this.plan)) return null
    const viewport = container.getBoundingClientRect()
    const sticky = Boolean(this.props.viewport?.stickyBottom())
      && container.scrollHeight - container.scrollTop - container.clientHeight <= 1
    // A reserved region has no message anchor yet. Do not anchor to an offscreen
    // preview row: full history moving that row would undo Home/top navigation.
    const reserved = this.committed.segments.some((segment) => {
      if (segment.end !== segment.start) return false
      const rect = this.nodes.get(segment.key)?.getBoundingClientRect()
      return rect && rect.top <= viewport.top && rect.bottom > viewport.top
    })
    if (container.scrollTop === 0 || reserved) {
      return { reservedTop: container.scrollTop, element: null, key: undefined, offset: 0, fraction: 0, sticky }
    }
    for (const node of this.nodes.values()) {
      if (!node.hasAttribute("data-thread-group")) continue
      const rect = node.getBoundingClientRect()
      if (rect.height <= 0 || rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue
      const element = [...node.querySelectorAll<HTMLElement>("[data-message-id]")].find((message) => {
        const bounds = message.getBoundingClientRect()
        return bounds.height > 0 && bounds.bottom > viewport.top && bounds.top < viewport.bottom
      }) ?? node
      return { element, messageId: element.getAttribute("data-message-id") ?? undefined, key: node.getAttribute("data-thread-group") ?? undefined,
        offset: element.getBoundingClientRect().top - viewport.top, fraction: 0, sticky }
    }
    const index = this.visibleIndex(this.committed)
    const position = this.position(this.committed, index)
    return { element: null, key: this.committed.keys[index], offset: (position?.top ?? viewport.top) - viewport.top,
      fraction: position && position.height > 0 ? Math.max(0, (viewport.top - position.top) / position.height) : 0, sticky }
  }

  componentDidUpdate(_props: ProgressiveMessageListProps<T>, _state: MountState, snapshot: ReadingPosition | null) {
    const changed = !sameStructure(this.committed, this.plan) || this.committed.complete !== this.plan.complete
    this.committed = this.plan
    this.connectViewport()
    const container = this.container
    if (container && snapshot) {
      const element = snapshot.element?.isConnected ? snapshot.element
        : snapshot.messageId ? [...container.querySelectorAll<HTMLElement>("[data-message-id]")]
          .find((message) => message.getAttribute("data-message-id") === snapshot.messageId) : null
      if (snapshot.sticky && this.props.viewport?.stickyBottom()) {
        container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
      } else if (snapshot.reservedTop !== undefined) {
        container.scrollTop = snapshot.reservedTop
        // The destination's groups only became available in this commit.
        this.handleScroll()
      } else if (element) {
        const delta = element.getBoundingClientRect().top - container.getBoundingClientRect().top - snapshot.offset
        if (Math.abs(delta) > 0.5) container.scrollTop += delta
      } else if (snapshot.key) {
        const position = this.position(this.plan, this.plan.keys.indexOf(snapshot.key))
        if (position) {
          const offset = snapshot.fraction > 0 ? -snapshot.fraction * position.height : snapshot.offset
          const delta = position.top - container.getBoundingClientRect().top - offset
          if (Math.abs(delta) > 0.5) container.scrollTop += delta
        }
      }
    }
    if (changed) this.props.viewport?.onReady?.()
    this.schedule()
  }

  componentWillUnmount() {
    this.active = false
    if (this.frame !== null) window.cancelAnimationFrame(this.frame)
    this.frame = null
    this.container?.removeEventListener("scroll", this.handleScroll)
    this.container?.removeEventListener("click", this.handleInteraction, true)
    this.container?.removeEventListener("keydown", this.handleInteraction, true)
    document.removeEventListener("selectionchange", this.handleScroll)
    document.removeEventListener("focusin", this.handleScroll)
    document.removeEventListener("focusout", this.handleScroll)
    this.container = null
    this.observer?.disconnect()
    this.observer = null
    this.interactions?.disconnect()
    this.interactions = null
  }

  render() {
    const { groups, keys, renderGroup, viewport, header, children, className } = this.props
    const estimateScope = JSON.stringify([this.state.width, viewport?.historyComplete])
    if (estimateScope !== this.estimateScope) {
      this.estimateScope = estimateScope
      this.estimates = new Map()
      this.heightPlan = null
    }
    let heightPlan = this.heightPlan
    // Mount batches keep the same keys. Content-only parent updates may supply
    // a new array with the same order, including after every group is mounted.
    if (!heightPlan || heightPlan.scrollHeight !== viewport?.scrollHeight || !sameKeys(heightPlan.keys, keys)) {
      const cache = heightCache.get(this.cacheKey())
      const known = keys.reduce((sum, key) => sum + (this.estimates.get(key) ?? cache?.get(key) ?? 0), 0)
      const unknown = keys.filter((key) => !this.estimates.has(key) && !cache?.has(key)).length
      const estimate = viewport?.historyComplete && viewport.scrollHeight && unknown > 0
        ? Math.max(32, (viewport.scrollHeight - known - GROUP_GAP * Math.max(0, keys.length - 1)) / unknown)
        : ESTIMATED_HEIGHT
      // Freeze skipped geometry for this data/width scope. Learning a mounted
      // group's size must not redistribute every other spacer during live reflow.
      let totalHeight = 0
      const heights = keys.map((key) => {
        const height = this.estimates.get(key) ?? cache?.get(key) ?? estimate
        this.estimates.set(key, height)
        totalHeight = totalHeight + height + GROUP_GAP
        return height
      })
      heightPlan = { keys, scrollHeight: viewport?.scrollHeight, heights, totalHeight }
      this.heightPlan = heightPlan
    } else heightPlan.keys = keys
    const { heights, totalHeight } = heightPlan
    const segments: Segment[] = []
    const reserved = viewport && !viewport.historyComplete
      ? Math.max(0, (viewport.scrollHeight ?? 0) - totalHeight) : 0
    const leading = !viewport?.historyComplete ? viewport?.leadingHeight ?? reserved : 0
    const trailing = !viewport?.historyComplete ? viewport?.trailingHeight ?? 0 : 0
    if (leading > 0) segments.push({ key: "history-prefix", start: 0, end: 0, height: leading, placeholder: true })
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]
      if (this.state.mounted.has(key)) {
        segments.push({ key: `group:${key}`, start: index, end: index + 1, height: heights[index], placeholder: false })
      } else {
        const previous = segments.at(-1)
        if (previous?.placeholder && previous.end > previous.start) {
          previous.end = index + 1
          previous.height += heights[index] + GROUP_GAP
        } else segments.push({ key: `placeholder:${key}`, start: index, end: index + 1, height: heights[index], placeholder: true })
      }
    }
    if (trailing > 0) segments.push({ key: "history-suffix", start: keys.length, end: keys.length, height: trailing, placeholder: true })
    this.plan = { keys, heights, segments, complete: viewport?.historyComplete ?? true }
    return <div className={`flex flex-col gap-2 ${className ?? ""}`} data-thread-history-complete={this.plan.complete} data-thread-virtualized={Boolean(viewport)}>
      {header}
      {segments.map((segment) => segment.placeholder
        ? <div key={segment.key} ref={this.trackNode} data-thread-placeholder={segment.key} aria-hidden="true"
            style={{ height: segment.height, flexShrink: 0, overflowAnchor: "none" }} />
        : <div key={`group:${this.state.identities.get(segment.key) ?? keys[segment.start]}`} ref={this.groupRef(segment.key)} data-thread-group={keys[segment.start]} className="min-w-0 shrink-0 empty:hidden">
            <RenderedGroup group={groups[segment.start]} index={segment.start} renderGroup={renderGroup} />
          </div>)}
      {children}
    </div>
  }
}
