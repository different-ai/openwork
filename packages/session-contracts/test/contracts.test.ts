import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  OPEN_WORK_COMPATIBILITY_SESSION_EVENT_TYPES,
  validateOpenWorkSession,
  validateOpenWorkSessionList,
  validateOpenWorkSessionMessages,
  validateOpenWorkSessionSnapshot,
  validateOpenWorkSessionStatuses,
  validateOpenWorkSessionStreamFrame,
  validateOpenWorkSessionTodos,
  type OpenWorkSession,
  type OpenWorkSessionMessage,
  type OpenWorkSessionSnapshot,
} from "../src/index.js"

const sessionFixture = {
  id: "ses_1",
  slug: "contract-boundary",
  projectID: "prj_1",
  directory: "/workspace",
  title: "Contract boundary",
  version: "1.17.11",
  time: { created: 100, updated: 200, compacting: 150 },
  revert: { messageID: "msg_1", partID: "prt_1" },
  engineFutureField: { preserved: true },
} satisfies OpenWorkSession & { engineFutureField: { preserved: boolean } }

const messageFixture = {
  info: {
    id: "msg_1",
    sessionID: "ses_1",
    role: "user",
    time: { created: 100 },
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-5" },
    engineFutureInfo: "preserved",
  },
  parts: [
    {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "text",
      text: "hello",
      engineFuturePart: 42,
    },
  ],
  engineFutureEnvelope: true,
} satisfies OpenWorkSessionMessage & {
  info: OpenWorkSessionMessage["info"] & { engineFutureInfo: string }
  parts: Array<OpenWorkSessionMessage["parts"][number] & { engineFuturePart: number }>
  engineFutureEnvelope: boolean
}

const todoFixture = {
  content: "Keep the public response stable",
  status: "in_progress",
  priority: "high",
  engineFutureTodo: true,
}

const snapshotFixture = {
  session: sessionFixture,
  messages: [messageFixture],
  todos: [todoFixture],
  status: { type: "retry", attempt: 2, message: "rate limited", next: 300 },
} satisfies OpenWorkSessionSnapshot

describe("OpenWork session read contracts", () => {
  it("accepts every current read surface from unknown input", () => {
    const list = validateOpenWorkSessionList([sessionFixture])
    const session = validateOpenWorkSession(sessionFixture)
    const messages = validateOpenWorkSessionMessages([messageFixture])
    const todos = validateOpenWorkSessionTodos([todoFixture])
    const statuses = validateOpenWorkSessionStatuses({ ses_1: { type: "busy" } })
    const snapshot = validateOpenWorkSessionSnapshot(snapshotFixture)

    assert.equal(list.ok, true)
    assert.equal(session.ok, true)
    assert.equal(messages.ok, true)
    assert.equal(todos.ok, true)
    assert.equal(statuses.ok, true)
    assert.equal(snapshot.ok, true)
    if (!list.ok || !session.ok || !messages.ok || !todos.ok || !statuses.ok || !snapshot.ok) {
      assert.fail("valid fixtures must pass")
    }

    assert.equal(list.value[0]?.id, "ses_1")
    assert.equal(session.value.id, "ses_1")
    assert.equal(messages.value[0]?.parts[0]?.text, "hello")
    assert.equal(todos.value[0]?.content, "Keep the public response stable")
    assert.deepEqual(statuses.value.ses_1, { type: "busy" })
    assert.equal(snapshot.value.status.type, "retry")
  })

  it("preserves passthrough compatibility without mutating vendor input", () => {
    const input = structuredClone(snapshotFixture)
    const before = structuredClone(input)

    const result = validateOpenWorkSessionSnapshot(input)

    assert.equal(result.ok, true)
    if (!result.ok) assert.fail("fixture must pass")
    assert.deepEqual(input, before)
    assert.notEqual(result.value, input)
    assert.notEqual(result.value.session, input.session)
    assert.deepEqual(result.value.session.engineFutureField, { preserved: true })
    assert.equal(result.value.messages[0]?.info.engineFutureInfo, "preserved")
    assert.equal(result.value.messages[0]?.parts[0]?.engineFuturePart, 42)
    assert.equal(result.value.todos[0]?.engineFutureTodo, true)
  })

  it("keeps the established status normalization behavior", () => {
    const result = validateOpenWorkSessionStatuses({
      ses_idle: { type: "idle", engineExtra: true },
      ses_retry: {
        type: "retry",
        attempt: 1,
        message: "waiting",
        next: 123,
        action: { title: "Upgrade" },
      },
    })

    assert.equal(result.ok, true)
    if (!result.ok) assert.fail("fixture must pass")
    assert.deepEqual(result.value, {
      ses_idle: { type: "idle" },
      ses_retry: { type: "retry", attempt: 1, message: "waiting", next: 123 },
    })
  })

  it("rejects malformed values at each adapter boundary", () => {
    const invalidResults = [
      validateOpenWorkSessionList({ items: [] }),
      validateOpenWorkSession({ title: "missing id" }),
      validateOpenWorkSessionMessages([{ info: { id: "msg" }, parts: [] }]),
      validateOpenWorkSessionTodos([{ content: "missing fields" }]),
      validateOpenWorkSessionStatuses({ ses_1: { type: "paused" } }),
      validateOpenWorkSessionSnapshot({ session: sessionFixture }),
    ]

    for (const result of invalidResults) {
      assert.equal(result.ok, false)
      if (result.ok) assert.fail("malformed input must fail")
      assert.equal(result.error.code, "OPENWORK_SESSION_CONTRACT_INVALID")
      assert.ok(result.error.issues.length > 0)
    }
  })

  it("returns a stable, immutable validation failure shape", () => {
    const result = validateOpenWorkSessionMessages([
      {
        info: { id: "msg_1", sessionID: "ses_1", role: "assistant" },
        parts: [{ id: "prt_1", messageID: 42, sessionID: "ses_1" }],
      },
    ])

    assert.equal(result.ok, false)
    if (result.ok) assert.fail("malformed fixture must fail")
    assert.deepEqual(result.error, {
      code: "OPENWORK_SESSION_CONTRACT_INVALID",
      compatibilityIssues: [
        {
          code: "invalid_type",
          expected: "string",
          message: "Invalid input: expected string, received number",
          path: [0, "parts", 0, "messageID"],
        },
      ],
      contract: "openwork-session-messages-v1",
      issues: [
        {
          code: "invalid_type",
          message: "Invalid input: expected string, received number",
          path: [0, "parts", 0, "messageID"],
        },
      ],
      message: "Invalid openwork-session-messages-v1.",
    })
    assert.equal(Object.isFrozen(result), true)
    assert.equal(Object.isFrozen(result.error), true)
    assert.equal(Object.isFrozen(result.error.compatibilityIssues), true)
    assert.equal(Object.isFrozen(result.error.compatibilityIssues[0]), true)
    assert.equal(Object.isFrozen(result.error.compatibilityIssues[0]?.path), true)
    assert.equal(Object.isFrozen(result.error.issues), true)
    assert.equal(Object.isFrozen(result.error.issues[0]), true)
    assert.equal(Object.isFrozen(result.error.issues[0]?.path), true)
  })
})

describe("OpenWork session stream contracts", () => {
  it("accepts normalized update and failure frames", () => {
    const updated = validateOpenWorkSessionStreamFrame({
      schemaVersion: 1,
      kind: "event",
      workspaceId: "workspace-1",
      source: {
        adapterId: "builtin/opencode",
        eventType: "session.updated",
        eventId: "event-7",
      },
      event: {
        kind: "session.updated",
        sessionId: "ses_1",
        info: sessionFixture,
      },
    })
    const failed = validateOpenWorkSessionStreamFrame({
      schemaVersion: 1,
      kind: "event",
      workspaceId: "workspace-1",
      source: {
        adapterId: "builtin/opencode",
        eventType: "session.error",
      },
      event: {
        kind: "session.failed",
        sessionId: "ses_1",
        failure: {
          code: "upstream_api",
          message: "Rate limited",
          retryable: true,
          statusCode: 429,
          providerId: "openai",
        },
      },
    })

    assert.equal(updated.ok, true)
    assert.equal(failed.ok, true)
    if (!updated.ok || !failed.ok) assert.fail("valid frames must pass")
    if (updated.value.kind !== "event" || failed.value.kind !== "event") {
      assert.fail("fixtures must remain event frames")
    }
    assert.equal(updated.value.source.eventId, "event-7")
    assert.equal(updated.value.event.kind, "session.updated")
    assert.equal(failed.value.event.kind, "session.failed")
  })

  it("freezes the compatibility bridge at exactly eighteen current event types", () => {
    assert.equal(OPEN_WORK_COMPATIBILITY_SESSION_EVENT_TYPES.length, 18)
    assert.deepEqual(OPEN_WORK_COMPATIBILITY_SESSION_EVENT_TYPES, [
      "session.deleted",
      "session.next.compaction.started",
      "session.next.compaction.ended",
      "session.compacted",
      "session.status",
      "todo.updated",
      "permission.asked",
      "permission.v2.asked",
      "permission.replied",
      "permission.v2.replied",
      "question.asked",
      "question.replied",
      "question.rejected",
      "message.updated",
      "message.removed",
      "message.part.updated",
      "message.part.delta",
      "session.idle",
    ])

    for (const sourceType of OPEN_WORK_COMPATIBILITY_SESSION_EVENT_TYPES) {
      const result = validateOpenWorkSessionStreamFrame({
        schemaVersion: 1,
        kind: "event",
        workspaceId: "workspace-1",
        source: { adapterId: "builtin/opencode", eventType: sourceType },
        event: { kind: "compatibility", sourceType, properties: { retained: true } },
      })
      assert.equal(result.ok, true, `${sourceType} must remain in the explicit bridge`)
    }
  })

  it("accepts unknown diagnostics and stable stream failures", () => {
    const unknown = validateOpenWorkSessionStreamFrame({
      schemaVersion: 1,
      kind: "event",
      workspaceId: "workspace-1",
      source: { adapterId: "builtin/opencode", eventType: "future.event" },
      event: { kind: "unknown", sourceType: "future.event", reason: "unsupported_type" },
    })
    const disconnected = validateOpenWorkSessionStreamFrame({
      schemaVersion: 1,
      kind: "stream.error",
      workspaceId: "workspace-1",
      source: { adapterId: "builtin/opencode", eventType: "stream.error" },
      error: {
        code: "OPENWORK_SESSION_STREAM_ENGINE_UNAVAILABLE",
        message: "Session event source disconnected.",
        retryable: true,
        status: 503,
      },
    })

    assert.equal(unknown.ok, true)
    assert.equal(disconnected.ok, true)
  })

  it("returns the stable immutable validation error for malformed frames", () => {
    const result = validateOpenWorkSessionStreamFrame({
      schemaVersion: 2,
      kind: "event",
      workspaceId: "",
      source: { adapterId: "", eventType: "session.updated" },
      event: { kind: "session.updated", sessionId: "ses_1", info: {} },
    })

    assert.equal(result.ok, false)
    if (result.ok) assert.fail("malformed frame must fail")
    assert.equal(result.error.code, "OPENWORK_SESSION_CONTRACT_INVALID")
    assert.equal(result.error.contract, "openwork-session-stream-frame-v1")
    assert.equal(result.error.message, "Invalid openwork-session-stream-frame-v1.")
    assert.ok(result.error.issues.length >= 4)
    assert.equal(Object.isFrozen(result.error), true)
    assert.equal(Object.isFrozen(result.error.issues), true)
  })
})
