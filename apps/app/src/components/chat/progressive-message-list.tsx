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
  renderGroup: (group: T, index: number) => React.ReactNode
  viewport?: MessageListViewport
  className?: string
  header?: React.ReactNode
  children?: React.ReactNode
}

const BATCH_SIZE = 8
const GROUP_GAP = 8
const ESTIMATED_HEIGHT = 240
const MAX_CACHED_VIEWPORTS = 12
const MAX_CACHED_GROUPS = 2048
// Only IDs and geometry, scoped by session and width. Nothing is persisted.
const heightCache = new Map<string, Map<string, number>>()

type MountState = {
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
  for (let distance = 0; distance < keys.length && added < BATCH_SIZE; distance++) {
    for (const index of distance === 0 ? [center] : [center - distance, center + distance]) {
      const key = keys[index]
      if (key !== undefined && !next.has(key)) {
        next.add(key)
        if (++added === BATCH_SIZE) break
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

/** Whole groups mount once, then stay mounted. The key cancels work on a session switch. */
export function ProgressiveMessageList<T>(props: ProgressiveMessageListProps<T>) {
  const { groups, getGroupKey, getMessageIds } = props
  const keys = React.useMemo(() => groups.map(getGroupKey), [groups, getGroupKey])
  const anchorMessageId = props.viewport?.anchorMessageId
  const anchorIndex = React.useMemo(() => anchorMessageId
    ? groups.findIndex((group) => getMessageIds(group).includes(anchorMessageId))
    : -1, [groups, getMessageIds, anchorMessageId])
  return <ProgressiveGroups key={props.viewport?.sessionKey ?? "eager"} {...props} keys={keys} anchorIndex={anchorIndex} />
}

type PreparedGroupsProps<T> = ProgressiveMessageListProps<T> & { keys: string[]; anchorIndex: number }

// Internal mount batches reuse settled output. Parent callback changes must
// invalidate it too: the callback captures streaming, last-step and other props.
class RenderedGroup<T> extends React.PureComponent<{
  group: T
  index: number
  renderGroup: ProgressiveMessageListProps<T>["renderGroup"]
}> {
  render() {
    return this.props.renderGroup(this.props.group, this.props.index)
  }
}

// getSnapshotBeforeUpdate reads the actual pre-mutation DOM, including any scroll
// since a batch was queued. An effect's previous-commit anchor would snap readers back.
class ProgressiveGroups<T> extends React.Component<PreparedGroupsProps<T>, MountState> {
  state: MountState = {
    mounted: new Set(),
    initialized: false,
    anchorPending: Boolean(this.props.viewport?.anchorMessageId),
    width: this.props.viewport?.viewportWidth ?? 0,
  }

  static getDerivedStateFromProps<T>(props: PreparedGroupsProps<T>, state: MountState): MountState | null {
    const { keys, anchorIndex } = props
    if (!keys.length) return null
    const replacements = [...(props.groupKeyReplacements ?? [])]
      .filter(([key, previous]) => state.mounted.has(previous) && !state.mounted.has(key) && keys.includes(key))
      .map(([key]) => key)
    let mounted = replacements.length ? new Set([...state.mounted, ...replacements]) : state.mounted
    const last = keys[keys.length - 1]
    if (!props.viewport || props.viewport.revealAll) {
      if (keys.every((key) => state.mounted.has(key))) return null
      mounted = new Set(keys)
    } else if (!state.initialized || (anchorIndex >= 0 && (state.anchorPending || !mounted.has(keys[anchorIndex])))) {
      // Include the live tail without allowing the first mount to exceed eight groups.
      const estimatedIndex = props.viewport.scrollTop !== undefined && props.viewport.scrollHeight
        ? Math.min(keys.length - 1, Math.floor(keys.length * props.viewport.scrollTop / props.viewport.scrollHeight)) : keys.length - 1
      const nearby = addNearby(keys, mounted, anchorIndex >= 0 ? anchorIndex : estimatedIndex)
      if (!nearby.has(last)) {
        const furthest = [...nearby].at(-1)
        if (furthest && !mounted.has(furthest)) nearby.delete(furthest)
        nearby.add(last)
      }
      mounted = nearby
    } else if (!mounted.has(last)) {
      mounted = new Set([...mounted, last])
    } else if (mounted === state.mounted) return null
    return { ...state, mounted, initialized: true, anchorPending: state.anchorPending && anchorIndex < 0 && !props.viewport?.historyComplete }
  }

  private nodes = new Map<string, HTMLDivElement>()
  private plan: Plan = { keys: [], heights: [], segments: [], complete: false }
  private committed = this.plan
  private container: HTMLDivElement | null = null
  private observer: ResizeObserver | null = null
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
    }
  }

  private connectViewport() {
    const container = this.props.viewport?.scrollRef.current
    if (!container || this.container === container) return
    this.container?.removeEventListener("scroll", this.handleScroll)
    this.observer?.disconnect()
    this.container = container
    container.addEventListener("scroll", this.handleScroll, { passive: true })
    this.observer = new ResizeObserver((entries) => {
      if (!this.active) return
      const width = container.clientWidth
      if (width > 0 && width !== this.state.width) {
        this.setState({ width })
        return
      }
      // Native browser anchoring owns image/markdown reflow. Only remember sizes.
      for (const entry of entries) if (entry.target instanceof HTMLElement) this.measure(entry.target)
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

  private handleScroll = () => {
    if (!this.active || this.committed.complete) return
    const index = this.visibleIndex(this.committed)
    // Jumping into a spacer should not wait behind the history queue.
    const nearby = this.committed.keys.slice(Math.max(0, index - 1), index + BATCH_SIZE - 1)
    if (nearby.some((key) => !this.state.mounted.has(key))) {
      this.setState((state) => ({ mounted: new Set([...state.mounted, ...nearby]) }))
    }
  }

  private schedule() {
    const pending = this.committed.keys.some((key) => !this.state.mounted.has(key))
    if (!pending && this.frame !== null) {
      window.cancelAnimationFrame(this.frame)
      this.frame = null
    }
    if (!this.active || this.frame !== null || !this.props.viewport) return
    if (!pending && this.container) return
    // Two frames guarantee a paint opportunity between expensive group batches.
    this.frame = window.requestAnimationFrame(() => {
      this.frame = window.requestAnimationFrame(() => {
        this.frame = null
        if (!this.active) return
        this.connectViewport()
        const { keys } = this.committed
        const index = this.visibleIndex(this.committed)
        this.setState((state) => {
          const next = addNearby(keys, state.mounted, index)
          return next.size !== state.mounted.size ? { mounted: next } : null
        })
      })
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
    this.container = null
    this.observer?.disconnect()
    this.observer = null
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
    this.plan = { keys, heights, segments, complete: (viewport?.historyComplete ?? true) && segments.every((segment) => !segment.placeholder) }
    return <div className={`flex flex-col gap-2 ${className ?? ""}`} data-thread-history-complete={this.plan.complete}>
      {header}
      {segments.map((segment) => segment.placeholder
        ? <div key={segment.key} ref={this.trackNode} data-thread-placeholder={segment.key} aria-hidden="true"
            style={{ height: segment.height, flexShrink: 0, overflowAnchor: "none" }} />
        : <div key={segment.key} ref={this.trackNode} data-thread-group={keys[segment.start]} className="min-w-0 shrink-0 empty:hidden">
            <RenderedGroup group={groups[segment.start]} index={segment.start} renderGroup={renderGroup} />
          </div>)}
      {children}
    </div>
  }
}
