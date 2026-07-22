export const OBSERVABILITY_LEVELS = ["debug", "info", "warn", "error"] as const
export type ObservabilityLevel = (typeof OBSERVABILITY_LEVELS)[number]

export const OBSERVABILITY_SCOPES = [
  "lifecycle",
  "prompt",
  "config",
  "mcp",
  "tool",
  "event",
  "process",
  "renderer",
] as const
export type ObservabilityScope = (typeof OBSERVABILITY_SCOPES)[number]

export const OBSERVABILITY_CONTENT_MODES = ["metadata", "hash", "full"] as const
export type ObservabilityContentMode = (typeof OBSERVABILITY_CONTENT_MODES)[number]

export interface ObservabilityConfig {
  enabled: boolean
  level: ObservabilityLevel
  scopes: ObservabilityScope[]
  console: boolean
  content: ObservabilityContentMode
  maxEvents: number
}

export interface ObservabilitySource {
  runtime: "openwork-server" | "opencode" | "renderer"
  component: string
  instanceId?: string
  operation?: string
}

export interface ObservabilityContent {
  kind?: string
  length?: number
  hash?: string
  rawHash?: string
  capturedHash?: string
  complete?: boolean
  truncated?: boolean
  redactionCount?: number
  value?: unknown
}

export interface ObservabilityEventInput {
  level: ObservabilityLevel
  scope: ObservabilityScope
  action: string
  source: ObservabilitySource
  observedAt?: string
  context?: unknown
  cause?: unknown
  data?: unknown
  content?: ObservabilityContent
}

export interface ObservabilityEvent extends ObservabilityEventInput {
  id: string
  sequence: number
  timestamp: string
}

export interface ObservabilitySnapshot {
  config: ObservabilityConfig
  events: ObservabilityEvent[]
  lastSequence: number
  droppedCount: number
  retainedBytes: number
  maxBytes: number
}

export interface ObservabilityStats {
  lastSequence: number
  droppedCount: number
  retainedCount: number
  retainedBytes: number
  maxBytes: number
}

export interface ObservabilityListOptions {
  /** Return only events whose sequence is greater than this value. */
  after?: number
  /** Return at most this many events, starting with the oldest matching event. */
  limit?: number
}

export type ObservabilitySubscriber = (event: ObservabilityEvent) => void

export interface ObservabilityJournal {
  configure(input: unknown): ObservabilityConfig
  getConfig(): ObservabilityConfig
  record(input: ObservabilityEventInput): ObservabilityEvent | undefined
  list(options?: ObservabilityListOptions): ObservabilityEvent[]
  clear(): void
  stats(): ObservabilityStats
  snapshot(): ObservabilitySnapshot
  subscribe(subscriber: ObservabilitySubscriber): () => void
}

export interface ObservabilityRedactionOptions {
  maxDepth: number
  maxArrayLength: number
  maxObjectKeys: number
  maxStringLength: number
  maxTotalStringLength: number
  maxNodes: number
}

export const MIN_OBSERVABILITY_EVENTS = 100
export const MAX_OBSERVABILITY_EVENTS = 5_000
export const MAX_OBSERVABILITY_CONTENT_CHARS = 1_000_000
export const MAX_OBSERVABILITY_JOURNAL_BYTES = 16 * 1024 * 1024

export const DEFAULT_OBSERVABILITY_CONFIG: ObservabilityConfig = Object.freeze({
  enabled: false,
  level: "info",
  scopes: Object.freeze([
    "lifecycle",
    "prompt",
    "config",
    "mcp",
    "tool",
    "event",
    "process",
    "renderer",
  ]) as unknown as ObservabilityScope[],
  console: true,
  content: "metadata",
  maxEvents: 1_000,
})

const DEFAULT_REDACTION_OPTIONS: ObservabilityRedactionOptions = {
  maxDepth: 10,
  maxArrayLength: 250,
  maxObjectKeys: 250,
  maxStringLength: 64_000,
  maxTotalStringLength: 256_000,
  maxNodes: 5_000,
}

const LEVEL_PRIORITY: Record<ObservabilityLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

const OBSERVABILITY_SOURCE_RUNTIMES = ["openwork-server", "opencode", "renderer"] as const

const REDACTED = "[REDACTED]"
const CIRCULAR = "[Circular]"
const MAX_DEPTH = "[MaxDepth]"
const MAX_SIZE = "[MaxSize]"

function isArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value)
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !isArray(value)
}

function isAllowedValue<const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): value is Values[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value)
}

function cloneConfig(config: ObservabilityConfig): ObservabilityConfig {
  return { ...config, scopes: [...config.scopes] }
}

function applyConfig(
  input: unknown,
  fallback: ObservabilityConfig,
): ObservabilityConfig {
  if (!isRecord(input)) return cloneConfig(fallback)

  const scopesInput = safeProperty(input, "scopes")
  let scopes = [...fallback.scopes]
  if (isArray(scopesInput)) {
    try {
      scopes = [...new Set(scopesInput.filter((scope): scope is ObservabilityScope => (
        isAllowedValue(OBSERVABILITY_SCOPES, scope)
      )))]
    } catch {
      scopes = [...fallback.scopes]
    }
  }

  const maxEventsInput = safeProperty(input, "maxEvents")
  const maxEvents = typeof maxEventsInput === "number" && Number.isFinite(maxEventsInput)
    ? Math.min(
        MAX_OBSERVABILITY_EVENTS,
        Math.max(MIN_OBSERVABILITY_EVENTS, Math.trunc(maxEventsInput)),
      )
    : fallback.maxEvents

  const enabled = safeProperty(input, "enabled")
  const level = safeProperty(input, "level")
  const consoleEnabled = safeProperty(input, "console")
  const content = safeProperty(input, "content")

  return {
    enabled: typeof enabled === "boolean" ? enabled : fallback.enabled,
    level: isAllowedValue(OBSERVABILITY_LEVELS, level) ? level : fallback.level,
    scopes,
    console: typeof consoleEnabled === "boolean" ? consoleEnabled : fallback.console,
    content: isAllowedValue(OBSERVABILITY_CONTENT_MODES, content)
      ? content
      : fallback.content,
    maxEvents,
  }
}

/**
 * Normalizes untrusted configuration while preserving valid values from an
 * optional base. The returned object and its scopes array are always fresh.
 */
export function normalizeObservabilityConfig(
  input: unknown,
  base?: unknown,
): ObservabilityConfig {
  const normalizedBase = base === undefined
    ? cloneConfig(DEFAULT_OBSERVABILITY_CONFIG)
    : applyConfig(base, DEFAULT_OBSERVABILITY_CONFIG)
  return applyConfig(input, normalizedBase)
}

function isSecretKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase()
  return normalized === "token"
    || normalized === "authorization"
    || normalized === "cookie"
    || normalized === "setcookie"
    || normalized === "password"
    || normalized === "passwd"
    || normalized === "apikey"
    || normalized === "privatekey"
    || normalized === "clientsecret"
    || normalized === "credential"
    || normalized === "credentials"
    || normalized === "bearer"
    || normalized.endsWith("accesstoken")
    || normalized.endsWith("refreshtoken")
    || normalized.endsWith("idtoken")
    || normalized.endsWith("password")
    || normalized.endsWith("secret")
    || normalized.endsWith("token")
    || normalized.endsWith("apikey")
    || normalized.endsWith("privatekey")
}

const SENSITIVE_STRING_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[^\s,;]+/giu, "$1 [REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[REDACTED_JWT]"],
  [/\b(?:owt_|ow_mcp_at_|sk-|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]+\b/giu, "[REDACTED_TOKEN]"],
  [/([?&](?:access_token|refresh_token|id_token|token|api[_-]?key|secret|password)=)[^&#\s]+/giu, "$1[REDACTED]"],
  [/\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*[^\r\n,;]+/giu, "$1: [REDACTED]"],
  [
    /\b((?:password|passwd|pwd|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|private[_-]?key|[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
    "$1[REDACTED]",
  ],
]

function redactSensitiveString(value: string): string {
  let result = value
  for (const [pattern, replacement] of SENSITIVE_STRING_PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  return result
}

function normalizedRedactionOptions(
  input?: Partial<ObservabilityRedactionOptions>,
): ObservabilityRedactionOptions {
  const positiveInteger = (value: unknown, fallback: number) => (
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.trunc(value)
      : fallback
  )
  return {
    maxDepth: positiveInteger(input?.maxDepth, DEFAULT_REDACTION_OPTIONS.maxDepth),
    maxArrayLength: positiveInteger(
      input?.maxArrayLength,
      DEFAULT_REDACTION_OPTIONS.maxArrayLength,
    ),
    maxObjectKeys: positiveInteger(input?.maxObjectKeys, DEFAULT_REDACTION_OPTIONS.maxObjectKeys),
    maxStringLength: positiveInteger(
      input?.maxStringLength,
      DEFAULT_REDACTION_OPTIONS.maxStringLength,
    ),
    maxTotalStringLength: positiveInteger(
      input?.maxTotalStringLength,
      DEFAULT_REDACTION_OPTIONS.maxTotalStringLength,
    ),
    maxNodes: positiveInteger(input?.maxNodes, DEFAULT_REDACTION_OPTIONS.maxNodes),
  }
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const omitted = value.length - maxLength
  return `${value.slice(0, maxLength)}…[${omitted} chars omitted]`
}

function defineEnumerable(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

/**
 * Produces a bounded, JSON-friendly copy of arbitrary input. Secret-like keys
 * are always replaced, getters cannot make redaction throw, and cycles or
 * oversized values are represented by explicit markers.
 */
type CloneObservabilityValueResult = {
  value: unknown
  truncated: boolean
  redactionCount: number
}

function cloneObservabilityValue(
  value: unknown,
  inputOptions: Partial<ObservabilityRedactionOptions> | undefined,
  redactStrings: boolean,
): CloneObservabilityValueResult {
  const options = normalizedRedactionOptions(inputOptions)
  const seen = new WeakSet<object>()
  let nodes = 0
  let stringChars = 0
  let truncated = false
  let redactionCount = 0

  const boundedString = (value: string): string => {
    const remaining = Math.max(0, options.maxTotalStringLength - stringChars)
    const limit = Math.min(options.maxStringLength, remaining)
    stringChars += Math.min(value.length, limit)
    if (value.length <= limit) return value
    truncated = true
    return truncateString(value, limit)
  }

  const visit = (current: unknown, depth: number): unknown => {
    nodes += 1
    if (nodes > options.maxNodes) {
      truncated = true
      return MAX_SIZE
    }

    if (typeof current === "string") {
      const safe = redactStrings ? redactSensitiveString(current) : current
      if (safe !== current) redactionCount += 1
      return boundedString(safe)
    }
    if (typeof current === "number") return Number.isFinite(current) ? current : String(current)
    if (typeof current === "bigint") return `${current}n`
    if (typeof current === "symbol") return String(current)
    if (typeof current === "function") return `[Function${current.name ? `: ${current.name}` : ""}]`
    if (current === null || typeof current === "boolean" || current === undefined) return current
    if (depth >= options.maxDepth) {
      truncated = true
      return MAX_DEPTH
    }

    try {
      if (seen.has(current)) return CIRCULAR
      seen.add(current)

      if (current instanceof Date) {
        return Number.isNaN(current.getTime()) ? "Invalid Date" : current.toISOString()
      }
      if (current instanceof RegExp) return String(current)
      if (current instanceof Error) {
        const result: Record<string, unknown> = {
          name: visit(current.name, depth + 1),
          message: visit(current.message, depth + 1),
        }
        if (current.stack) result.stack = visit(current.stack, depth + 1)
        if ("cause" in current) result.cause = visit(current.cause, depth + 1)
        return result
      }
      if (current instanceof Map) {
        const result: Record<string, unknown> = {}
        let count = 0
        for (const [rawKey, entryValue] of current) {
          if (count >= options.maxObjectKeys) break
          const key = String(rawKey)
          if (isSecretKey(key) && entryValue !== REDACTED) redactionCount += 1
          defineEnumerable(result, key, isSecretKey(key) ? REDACTED : visit(entryValue, depth + 1))
          count += 1
        }
        if (current.size > count) {
          truncated = true
          defineEnumerable(result, "$truncated", `${current.size - count} entries omitted`)
        }
        return result
      }
      if (current instanceof Set) {
        const result: unknown[] = []
        let count = 0
        for (const entry of current) {
          if (count >= options.maxArrayLength) break
          result.push(visit(entry, depth + 1))
          count += 1
        }
        if (current.size > count) {
          truncated = true
          result.push(`[${current.size - count} items omitted]`)
        }
        return result
      }
      if (Array.isArray(current)) {
        const values = current.slice(0, options.maxArrayLength)
        const result = values.map((entry) => visit(entry, depth + 1))
        if (current.length > values.length) {
          truncated = true
          result.push(`[${current.length - values.length} items omitted]`)
        }
        return result
      }

      const allKeys = Object.keys(current)
      const keys = allKeys.slice(0, options.maxObjectKeys)
      const result: Record<string, unknown> = {}
      for (const key of keys) {
        if (isSecretKey(key)) {
          redactionCount += 1
          defineEnumerable(result, key, REDACTED)
          continue
        }
        try {
          defineEnumerable(result, key, visit(current[key as keyof typeof current], depth + 1))
        } catch {
          defineEnumerable(result, key, "[Unreadable]")
        }
      }
      if (allKeys.length > keys.length) {
        truncated = true
        defineEnumerable(result, "$truncated", `${allKeys.length - keys.length} keys omitted`)
      }
      return result
    } catch {
      truncated = true
      return "[Unreadable]"
    }
  }

  try {
    return { value: visit(value, 0), truncated, redactionCount }
  } catch {
    return { value: "[Unreadable]", truncated: true, redactionCount }
  }
}

export function redactObservabilityValue(
  value: unknown,
  inputOptions?: Partial<ObservabilityRedactionOptions>,
): unknown {
  return cloneObservabilityValue(value, inputOptions, true).value
}

function sanitizeSource(source: ObservabilitySource): ObservabilitySource {
  return redactObservabilityValue(source) as ObservabilitySource
}

function readProperty(
  value: Record<string, unknown>,
  key: string,
): { ok: true; value: unknown } | { ok: false; value: undefined } {
  try {
    return { ok: true, value: value[key] }
  } catch {
    return { ok: false, value: undefined }
  }
}

function safeProperty(value: Record<string, unknown>, key: string): unknown {
  return readProperty(value, key).value
}

function fingerprintValue(value: unknown): string {
  let serialized: string
  try {
    serialized = JSON.stringify(value) ?? String(value)
  } catch {
    serialized = "[Unserializable]"
  }
  let hash = 0x811c9dc5
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`
}

export function applyObservabilityContentPolicy(
  input: unknown,
  mode: ObservabilityContentMode,
): ObservabilityContent {
  if (!isRecord(input)) return {}
  const content = input
  // Strict allowlist: metadata/hash modes must not even read `value` or any
  // alternate producer-defined property that could smuggle raw content.
  const sanitized: ObservabilityContent = {}
  const kind = safeProperty(content, "kind")
  const length = safeProperty(content, "length")
  const complete = safeProperty(content, "complete")
  const producerTruncated = safeProperty(content, "truncated")
  const producerRedactionCount = safeProperty(content, "redactionCount")
  if (typeof kind === "string") sanitized.kind = truncateString(kind, 128)
  if (typeof length === "number" && Number.isFinite(length) && length >= 0) {
    sanitized.length = Math.trunc(length)
  }
  if (typeof complete === "boolean") sanitized.complete = complete
  if (typeof producerTruncated === "boolean") sanitized.truncated = producerTruncated
  if (typeof producerRedactionCount === "number" && Number.isFinite(producerRedactionCount)) {
    sanitized.redactionCount = Math.max(0, Math.trunc(producerRedactionCount))
  }
  if (mode !== "metadata") {
    const hash = safeProperty(content, "hash")
    const rawHash = safeProperty(content, "rawHash")
    const capturedHash = safeProperty(content, "capturedHash")
    if (typeof hash === "string") sanitized.hash = truncateString(hash, 256)
    if (typeof rawHash === "string") sanitized.rawHash = truncateString(rawHash, 256)
    if (typeof capturedHash === "string") {
      sanitized.capturedHash = truncateString(capturedHash, 256)
    }
  }
  if (mode === "full") {
    const valueRead = readProperty(content, "value")
    if (!valueRead.ok) {
      sanitized.value = "[Unreadable]"
      sanitized.complete = false
      sanitized.truncated = true
      sanitized.capturedHash = fingerprintValue(sanitized.value)
      return sanitized
    }
    try {
      const cloned = cloneObservabilityValue(valueRead.value, {
        maxDepth: 50,
        maxArrayLength: 10_000,
        maxObjectKeys: 10_000,
        maxStringLength: MAX_OBSERVABILITY_CONTENT_CHARS,
        maxTotalStringLength: MAX_OBSERVABILITY_CONTENT_CHARS,
        maxNodes: 100_000,
      }, false)
      sanitized.value = cloned.value
      if (cloned.redactionCount > 0) {
        sanitized.redactionCount = (sanitized.redactionCount ?? 0) + cloned.redactionCount
        sanitized.complete = false
      }
      if (cloned.truncated) {
        sanitized.complete = false
        sanitized.truncated = true
        if (!sanitized.rawHash && sanitized.hash) sanitized.rawHash = sanitized.hash
        sanitized.capturedHash = fingerprintValue(cloned.value)
      }
    } catch {
      sanitized.value = "[Unreadable]"
      sanitized.complete = false
      sanitized.truncated = true
    }
  }
  return sanitized
}

function copyEvent(event: ObservabilityEvent): ObservabilityEvent {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(event)
    } catch {
      // Fall through to the bounded JSON-friendly clone below.
    }
  }
  return cloneObservabilityValue(event, {
    maxDepth: 60,
    maxArrayLength: 10_000,
    maxObjectKeys: 10_000,
    maxStringLength: MAX_OBSERVABILITY_CONTENT_CHARS,
    maxTotalStringLength: MAX_OBSERVABILITY_CONTENT_CHARS,
    maxNodes: 100_000,
  }, false).value as ObservabilityEvent
}

function snapshotEventInput(input: unknown): ObservabilityEventInput | undefined {
  if (!isRecord(input)) return undefined
  const sourceInput = safeProperty(input, "source")
  if (!isRecord(sourceInput)) return undefined

  const level = safeProperty(input, "level")
  const scope = safeProperty(input, "scope")
  const action = safeProperty(input, "action")
  const runtime = safeProperty(sourceInput, "runtime")
  const component = safeProperty(sourceInput, "component")
  if (
    !isAllowedValue(OBSERVABILITY_LEVELS, level)
    || !isAllowedValue(OBSERVABILITY_SCOPES, scope)
    || typeof action !== "string"
    || action.trim().length === 0
    || !isAllowedValue(OBSERVABILITY_SOURCE_RUNTIMES, runtime)
    || typeof component !== "string"
    || component.trim().length === 0
  ) return undefined

  const instanceId = safeProperty(sourceInput, "instanceId")
  const operation = safeProperty(sourceInput, "operation")
  const observedAt = safeProperty(input, "observedAt")
  const context = safeProperty(input, "context")
  const cause = safeProperty(input, "cause")
  const data = safeProperty(input, "data")
  const content = safeProperty(input, "content")
  return {
    level,
    scope,
    action,
    source: {
      runtime,
      component,
      ...(typeof instanceId === "string" ? { instanceId } : {}),
      ...(typeof operation === "string" ? { operation } : {}),
    },
    ...(typeof observedAt === "string" ? { observedAt } : {}),
    ...(context !== undefined ? { context } : {}),
    ...(cause !== undefined ? { cause } : {}),
    ...(data !== undefined ? { data } : {}),
    ...(content !== undefined ? { content: content as ObservabilityContent } : {}),
  }
}

/** Creates an in-memory, bounded journal with no runtime-specific dependencies. */
export function createObservabilityJournal(initialConfig?: unknown): ObservabilityJournal {
  let config = normalizeObservabilityConfig(initialConfig)
  let events: ObservabilityEvent[] = []
  let sequence = 0
  let droppedCount = 0
  let eventSizes: number[] = []
  let retainedBytes = 0
  const subscribers = new Set<ObservabilitySubscriber>()
  const journalId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

  const enforceBound = () => {
    while (
      events.length > 0
      && (events.length > config.maxEvents || retainedBytes > MAX_OBSERVABILITY_JOURNAL_BYTES)
    ) {
      events.shift()
      retainedBytes -= eventSizes.shift() ?? 0
      droppedCount += 1
    }
  }

  const resetRetained = () => {
    events = []
    eventSizes = []
    retainedBytes = 0
    droppedCount = 0
  }

  const eventSize = (event: ObservabilityEvent): number => {
    try {
      return (JSON.stringify(event)?.length ?? 0) * 2
    } catch {
      return MAX_OBSERVABILITY_JOURNAL_BYTES
    }
  }

  const journal: ObservabilityJournal = {
    configure(input) {
      const previous = config
      config = normalizeObservabilityConfig(input, config)
      if (!config.enabled) {
        // Turning observability off is also a privacy boundary: no previously
        // captured full content remains readable through a later re-enable.
        resetRetained()
      } else if (previous.content !== config.content) {
        events = events.map((event) => ({
          ...event,
          ...(event.content ? { content: applyObservabilityContentPolicy(event.content, config.content) } : {}),
        }))
        eventSizes = events.map(eventSize)
        retainedBytes = eventSizes.reduce((total, size) => total + size, 0)
      }
      enforceBound()
      return cloneConfig(config)
    },

    getConfig() {
      return cloneConfig(config)
    },

    record(input) {
      if (!config.enabled) return undefined
      const candidate = snapshotEventInput(input)
      if (!candidate) return undefined
      if (LEVEL_PRIORITY[candidate.level] < LEVEL_PRIORITY[config.level]) return undefined
      if (!config.scopes.includes(candidate.scope)) return undefined

      sequence += 1
      let event: ObservabilityEvent
      try {
        event = {
          id: `owobs-${journalId}-${String(sequence).padStart(10, "0")}`,
          sequence,
          timestamp: new Date().toISOString(),
          level: candidate.level,
          scope: candidate.scope,
          action: truncateString(candidate.action.trim(), 512),
          source: sanitizeSource(candidate.source),
          ...(typeof candidate.observedAt === "string" && Number.isFinite(Date.parse(candidate.observedAt))
            ? { observedAt: new Date(candidate.observedAt).toISOString() }
            : {}),
          ...(candidate.context !== undefined
            ? { context: redactObservabilityValue(candidate.context) }
            : {}),
          ...(candidate.cause !== undefined
            ? { cause: redactObservabilityValue(candidate.cause) }
            : {}),
          ...(candidate.data !== undefined
            ? { data: redactObservabilityValue(candidate.data) }
            : {}),
          ...(candidate.content !== undefined
            ? { content: applyObservabilityContentPolicy(candidate.content, config.content) }
            : {}),
        }
      } catch {
        return undefined
      }

      events.push(event)
      const size = eventSize(event)
      eventSizes.push(size)
      retainedBytes += size
      enforceBound()
      for (const subscriber of subscribers) {
        try {
          subscriber(copyEvent(event))
        } catch {
          // Observability must never break the operation it is observing.
        }
      }
      return copyEvent(event)
    },

    list(options = {}) {
      const after = typeof options.after === "number" && Number.isFinite(options.after)
        ? options.after
        : Number.NEGATIVE_INFINITY
      const matching = events.filter((event) => event.sequence > after)
      if (options.limit === undefined) return matching.map(copyEvent)
      if (typeof options.limit !== "number" || !Number.isFinite(options.limit)) {
        return matching.map(copyEvent)
      }
      const limit = Math.max(0, Math.trunc(options.limit))
      return matching.slice(0, limit).map(copyEvent)
    },

    clear() {
      resetRetained()
    },

    stats() {
      return {
        lastSequence: sequence,
        droppedCount,
        retainedCount: events.length,
        retainedBytes,
        maxBytes: MAX_OBSERVABILITY_JOURNAL_BYTES,
      }
    },

    snapshot() {
      return {
        config: cloneConfig(config),
        events: events.map(copyEvent),
        lastSequence: sequence,
        droppedCount,
        retainedBytes,
        maxBytes: MAX_OBSERVABILITY_JOURNAL_BYTES,
      }
    },

    subscribe(subscriber) {
      subscribers.add(subscriber)
      return () => subscribers.delete(subscriber)
    },
  }

  return journal
}

function stringifyForConsole(value: unknown): string {
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? String(value) : serialized
  } catch {
    return "[Unserializable]"
  }
}

/** Formats one event as a compact, grep-friendly developer-console line. */
export function formatObservabilityEvent(event: ObservabilityEvent): string {
  const source = [
    event.source.runtime,
    event.source.component,
    event.source.instanceId,
    event.source.operation,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("/")
  const fields: string[] = []
  if (event.context !== undefined) fields.push(`context=${stringifyForConsole(event.context)}`)
  if (event.cause !== undefined) fields.push(`cause=${stringifyForConsole(event.cause)}`)
  if (event.data !== undefined) fields.push(`data=${stringifyForConsole(event.data)}`)
  if (event.content !== undefined) fields.push(`content=${stringifyForConsole(event.content)}`)
  const suffix = fields.length > 0 ? ` ${fields.join(" ")}` : ""
  const observedAt = event.observedAt ?? event.timestamp
  return `[OpenWork obs #${event.sequence}] observed=${observedAt} ingested=${event.timestamp} ${event.level.toUpperCase()} ${event.scope}.${event.action} @ ${source}${suffix}`
}
