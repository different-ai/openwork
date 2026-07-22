import { describe, expect, test } from "bun:test"
import {
  DEFAULT_OBSERVABILITY_CONFIG,
  MAX_OBSERVABILITY_CONTENT_CHARS,
  MAX_OBSERVABILITY_EVENTS,
  MAX_OBSERVABILITY_JOURNAL_BYTES,
  MIN_OBSERVABILITY_EVENTS,
  createObservabilityJournal,
  formatObservabilityEvent,
  normalizeObservabilityConfig,
  redactObservabilityValue,
  type ObservabilityEventInput,
} from "../src/index"

const lifecycleEvent = (overrides: Partial<ObservabilityEventInput> = {}): ObservabilityEventInput => ({
  level: "info",
  scope: "lifecycle",
  action: "runtime.started",
  source: { runtime: "openwork-server", component: "managed-opencode" },
  ...overrides,
})

describe("observability config", () => {
  test("defaults to disabled, bounded, metadata-only collection", () => {
    expect(normalizeObservabilityConfig(undefined)).toEqual(DEFAULT_OBSERVABILITY_CONFIG)
    expect(DEFAULT_OBSERVABILITY_CONFIG.enabled).toBe(false)
    expect(DEFAULT_OBSERVABILITY_CONFIG.content).toBe("metadata")
    expect(DEFAULT_OBSERVABILITY_CONFIG.maxEvents).toBeGreaterThanOrEqual(MIN_OBSERVABILITY_EVENTS)
    expect(Object.isFrozen(DEFAULT_OBSERVABILITY_CONFIG)).toBe(true)
    expect(Object.isFrozen(DEFAULT_OBSERVABILITY_CONFIG.scopes)).toBe(true)
  })

  test("normalizes input over a base without returning shared arrays", () => {
    const base = normalizeObservabilityConfig({ enabled: true, level: "debug", scopes: ["event"] })
    const result = normalizeObservabilityConfig({ console: false, scopes: ["mcp", "mcp", "invalid"] }, base)
    expect(result).toEqual({
      enabled: true,
      level: "debug",
      scopes: ["mcp"],
      console: false,
      content: "metadata",
      maxEvents: 1_000,
    })
    expect(result.scopes).not.toBe(base.scopes)
    expect(normalizeObservabilityConfig({ scopes: [] }, base).scopes).toEqual([])
  })

  test("falls back for invalid values and clamps event bounds", () => {
    expect(normalizeObservabilityConfig({
      enabled: "yes",
      level: "verbose",
      content: "raw",
      maxEvents: 1,
    })).toEqual({ ...DEFAULT_OBSERVABILITY_CONFIG, maxEvents: MIN_OBSERVABILITY_EVENTS })
    expect(normalizeObservabilityConfig({ maxEvents: 99_999 }).maxEvents)
      .toBe(MAX_OBSERVABILITY_EVENTS)
    expect(normalizeObservabilityConfig({ maxEvents: Number.NaN }).maxEvents)
      .toBe(DEFAULT_OBSERVABILITY_CONFIG.maxEvents)
  })

  test("isolates hostile configuration getters", () => {
    const hostile = {
      level: "debug",
      console: false,
      get scopes() { throw new Error("no scopes") },
    }
    expect(() => normalizeObservabilityConfig(hostile)).not.toThrow()
    expect(normalizeObservabilityConfig(hostile)).toMatchObject({
      level: "debug",
      console: false,
      scopes: DEFAULT_OBSERVABILITY_CONFIG.scopes,
    })

    const journal = createObservabilityJournal({ enabled: true })
    expect(() => journal.configure(hostile)).not.toThrow()
  })

  test("isolates revoked proxies at public entry points", () => {
    const revokedConfig = Proxy.revocable({}, {})
    revokedConfig.revoke()

    expect(() => normalizeObservabilityConfig(revokedConfig.proxy)).not.toThrow()

    const revokedScopes = Proxy.revocable([], {})
    revokedScopes.revoke()
    expect(() => normalizeObservabilityConfig({ scopes: revokedScopes.proxy })).not.toThrow()

    const journal = createObservabilityJournal({ enabled: true })
    expect(() => journal.configure(revokedConfig.proxy)).not.toThrow()

    const revokedEvent = Proxy.revocable({}, {})
    revokedEvent.revoke()
    expect(() => journal.record(
      revokedEvent.proxy as unknown as ObservabilityEventInput,
    )).not.toThrow()
  })
})

describe("observability journal", () => {
  test("stays inert while disabled and filters by level and scope", () => {
    const journal = createObservabilityJournal()
    expect(journal.record(lifecycleEvent())).toBeUndefined()
    expect(journal.snapshot().lastSequence).toBe(0)

    journal.configure({ enabled: true, level: "warn", scopes: ["mcp"] })
    expect(journal.record(lifecycleEvent({ level: "error", scope: "lifecycle" }))).toBeUndefined()
    expect(journal.record(lifecycleEvent({ level: "info", scope: "mcp" }))).toBeUndefined()
    expect(journal.record(lifecycleEvent({ level: "warn", scope: "mcp", action: "connection.failed" })))
      .toMatchObject({ sequence: 1, scope: "mcp", level: "warn" })
  })

  test("keeps monotonic identities, enforces bounds, and counts dropped events", () => {
    const journal = createObservabilityJournal({ enabled: true, maxEvents: 100 })
    for (let index = 0; index < 105; index += 1) {
      journal.record(lifecycleEvent({ action: `tick.${index}` }))
    }

    const snapshot = journal.snapshot()
    expect(snapshot.events).toHaveLength(100)
    expect(snapshot.events[0]?.sequence).toBe(6)
    expect(snapshot.events.at(-1)?.sequence).toBe(105)
    expect(snapshot.droppedCount).toBe(5)
    expect(snapshot.lastSequence).toBe(105)
    expect(snapshot.events[1]!.timestamp >= snapshot.events[0]!.timestamp).toBe(true)
    expect(journal.list({ after: 100, limit: 2 }).map((event) => event.sequence)).toEqual([101, 102])
    expect(journal.list({ limit: 0 })).toEqual([])

    journal.clear()
    expect(journal.snapshot()).toMatchObject({ events: [], droppedCount: 0, lastSequence: 105 })
    expect(journal.record(lifecycleEvent())?.sequence).toBe(106)
  })

  test("applies metadata, hash, and explicitly enabled full-content policies", () => {
    const journal = createObservabilityJournal({
      enabled: true,
      scopes: ["prompt"],
      content: "metadata",
    })
    const prompt = lifecycleEvent({
      scope: "prompt",
      action: "system.changed",
      content: {
        kind: "system-prompt",
        length: 13,
        hash: "sha256:abc",
        value: ["base", "injected"],
      },
    })

    expect(journal.record(prompt)?.content).toEqual({ kind: "system-prompt", length: 13 })
    journal.configure({ content: "hash" })
    expect(journal.record(prompt)?.content).toEqual({
      kind: "system-prompt",
      length: 13,
      hash: "sha256:abc",
    })
    journal.configure({ content: "full" })
    expect(journal.record({
      ...prompt,
      content: { ...prompt.content, value: { text: "full prompt", apiKey: "not-for-logs" } },
    })?.content).toEqual({
      kind: "system-prompt",
      length: 13,
      hash: "sha256:abc",
      complete: false,
      redactionCount: 1,
      value: { text: "full prompt", apiKey: "[REDACTED]" },
    })
  })

  test("never traverses raw content outside full mode and scrubs retained content on downgrade", () => {
    const journal = createObservabilityJournal({ enabled: true, scopes: ["prompt"], content: "metadata" })
    let reads = 0
    const content = {
      kind: "system-prompt",
      hash: "sha256:raw",
      blocks: ["RAW_PROMPT_IN_ALTERNATE_FIELD"],
      get value() {
        reads += 1
        return "RAW_PROMPT_IN_VALUE"
      },
    }
    expect(journal.record(lifecycleEvent({ scope: "prompt", content }))?.content)
      .toEqual({ kind: "system-prompt" })
    expect(reads).toBe(0)

    journal.configure({ content: "full" })
    journal.record(lifecycleEvent({ scope: "prompt", content: {
      kind: "system-prompt",
      hash: "sha256:raw",
      value: "RAW_PROMPT_IN_VALUE",
    } }))
    expect(JSON.stringify(journal.snapshot())).toContain("RAW_PROMPT_IN_VALUE")
    journal.configure({ content: "hash" })
    expect(JSON.stringify(journal.snapshot())).not.toContain("RAW_PROMPT_IN_VALUE")
    journal.configure({ enabled: false })
    expect(journal.snapshot().events).toEqual([])
  })

  test("redacts ordinary event fields regardless of content mode", () => {
    const journal = createObservabilityJournal({ enabled: true, content: "full" })
    const event = journal.record(lifecycleEvent({
      context: { sessionId: "ses_123", accessToken: "secret" },
      cause: { authorization: "Bearer secret", eventId: "parent" },
      data: { password: "secret", tokenCount: 42 },
    }))
    expect(event).toMatchObject({
      context: { sessionId: "ses_123", accessToken: "[REDACTED]" },
      cause: { authorization: "[REDACTED]", eventId: "parent" },
      data: { password: "[REDACTED]", tokenCount: 42 },
    })
  })

  test("notifies subscribers only for accepted events and isolates subscriber failures", () => {
    const journal = createObservabilityJournal({ enabled: true })
    const seen: number[] = []
    journal.subscribe(() => { throw new Error("observer failed") })
    const unsubscribe = journal.subscribe((event) => seen.push(event.sequence))

    expect(journal.record(lifecycleEvent())?.sequence).toBe(1)
    unsubscribe()
    expect(journal.record(lifecycleEvent())?.sequence).toBe(2)
    expect(seen).toEqual([1])
  })

  test("returns copies of configuration, lists, and subscriber events", () => {
    const journal = createObservabilityJournal({ enabled: true })
    const config = journal.getConfig()
    config.scopes.length = 0
    expect(journal.getConfig().scopes.length).toBeGreaterThan(0)

    const input = lifecycleEvent({ data: { state: "original" } })
    const event = journal.record(input)!
    event.source.component = "mutated"
    const returnedData = event.data as { state: string }
    returnedData.state = "mutated"
    expect(journal.list()[0]?.source.component).toBe("managed-opencode")
    expect(journal.list()[0]?.data).toEqual({ state: "original" })
  })

  test("reports full-content truncation honestly and bounds retained bytes", () => {
    const journal = createObservabilityJournal({
      enabled: true,
      scopes: ["prompt"],
      content: "full",
      maxEvents: MAX_OBSERVABILITY_EVENTS,
    })
    const raw = "x".repeat(MAX_OBSERVABILITY_CONTENT_CHARS + 1)
    const event = journal.record(lifecycleEvent({
      scope: "prompt",
      content: {
        kind: "system-prompt",
        hash: "sha256:raw",
        complete: true,
        truncated: false,
        value: raw,
      },
    }))
    expect(event?.content).toMatchObject({
      complete: false,
      truncated: true,
      rawHash: "sha256:raw",
    })
    expect(event?.content?.capturedHash).toMatch(/^fnv1a32:/)

    for (let index = 0; index < 30; index += 1) {
      journal.record(lifecycleEvent({
        scope: "prompt",
        action: `large.${index}`,
        content: { kind: "text", value: "y".repeat(MAX_OBSERVABILITY_CONTENT_CHARS) },
      }))
    }
    expect(journal.stats().retainedBytes).toBeLessThanOrEqual(MAX_OBSERVABILITY_JOURNAL_BYTES)
    expect(journal.stats().droppedCount).toBeGreaterThan(0)
  })

  test("malformed content and hostile allowed-field getters never escape record", () => {
    const journal = createObservabilityJournal({ enabled: true, content: "full" })
    expect(() => journal.record({
      ...lifecycleEvent(),
      content: null as never,
    })).not.toThrow()
    const hostile = {
      get kind() { throw new Error("no kind") },
      get value() { throw new Error("no value") },
    }
    expect(() => journal.record(lifecycleEvent({ content: hostile }))).not.toThrow()
  })

  test("reads hostile event envelopes once and marks unreadable full content incomplete", () => {
    const journal = createObservabilityJournal({ enabled: true, content: "full" })
    let levelReads = 0
    const envelope = {
      get level() {
        levelReads += 1
        if (levelReads > 1) throw new Error("level read twice")
        return "info" as const
      },
      scope: "lifecycle" as const,
      action: "hostile.envelope",
      source: { runtime: "openwork-server" as const, component: "test" },
      content: {
        complete: true,
        truncated: false,
        get value() { throw new Error("unreadable content") },
      },
    }
    expect(() => journal.record(envelope)).not.toThrow()
    expect(levelReads).toBe(1)
    expect(journal.list().at(-1)?.content).toMatchObject({
      value: "[Unreadable]",
      complete: false,
      truncated: true,
      capturedHash: expect.stringMatching(/^fnv1a32:/),
    })
  })
})

describe("observability redaction", () => {
  test("redacts nested secrets, cycles, and unsafe primitive values", () => {
    const value: Record<string, unknown> = {
      password: "one",
      nested: { client_secret: "two", tokenCount: 3 },
      infinity: Number.POSITIVE_INFINITY,
      bigint: 10n,
    }
    value.self = value
    expect(redactObservabilityValue(value)).toEqual({
      password: "[REDACTED]",
      nested: { client_secret: "[REDACTED]", tokenCount: 3 },
      infinity: "Infinity",
      bigint: "10n",
      self: "[Circular]",
    })
  })

  test("redacts secrets embedded in strings and token-suffixed keys", () => {
    expect(redactObservabilityValue({
      serverToken: "owt_supersecret",
      message: "Authorization: Bearer abc.def and https://example.test/?access_token=secret",
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
    })).toEqual({
      serverToken: "[REDACTED]",
      message: "Authorization: [REDACTED]",
      jwt: "[REDACTED_JWT]",
    })
  })

  test("redacts password, client-secret, and cloud-key assignments in strings", () => {
    expect(redactObservabilityValue(
      "password=hunter2 client_secret=abc AWS_SECRET_ACCESS_KEY=xyz",
    )).toBe(
      "password=[REDACTED] client_secret=[REDACTED] AWS_SECRET_ACCESS_KEY=[REDACTED]",
    )
  })

  test("never throws for hostile proxies", () => {
    const hostile = new Proxy({}, {
      ownKeys() { throw new Error("no keys") },
      getPrototypeOf() { throw new Error("no prototype") },
    })
    expect(() => redactObservabilityValue(hostile)).not.toThrow()
    expect(redactObservabilityValue(hostile)).toBe("[Unreadable]")
  })

  test("bounds depth, strings, arrays, objects, and total work", () => {
    expect(redactObservabilityValue("abcdef", { maxStringLength: 3 }))
      .toBe("abc…[3 chars omitted]")
    expect(redactObservabilityValue([1, 2, 3], { maxArrayLength: 2 }))
      .toEqual([1, 2, "[1 items omitted]"])
    expect(redactObservabilityValue({ a: { b: true } }, { maxDepth: 1 }))
      .toEqual({ a: "[MaxDepth]" })
    expect(redactObservabilityValue({ a: 1, b: 2 }, { maxObjectKeys: 1 }))
      .toEqual({ a: 1, $truncated: "1 keys omitted" })
    expect(redactObservabilityValue({ a: 1, b: 2 }, { maxNodes: 1 }))
      .toEqual({ a: "[MaxSize]", b: "[MaxSize]" })
  })
})

test("formatObservabilityEvent emits a compact, attributable console line", () => {
  const journal = createObservabilityJournal({ enabled: true })
  const observedAt = "2026-07-22T12:00:00.000Z"
  const event = journal.record(lifecycleEvent({ observedAt, data: { pid: 42 } }))!
  expect(formatObservabilityEvent(event)).toBe(
    `[OpenWork obs #1] observed=${observedAt} ingested=${event.timestamp} INFO lifecycle.runtime.started @ openwork-server/managed-opencode data={"pid":42}`,
  )
})
