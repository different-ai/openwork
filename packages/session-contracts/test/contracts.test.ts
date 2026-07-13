import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  validateOpenWorkSession,
  validateOpenWorkSessionList,
  validateOpenWorkSessionMessages,
  validateOpenWorkSessionSnapshot,
  validateOpenWorkSessionStatuses,
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
