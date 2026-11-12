import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { RUNNER_SESSION_TIMESTAMP_MAX, runnerSessionReportSchema } from "@openwork/types/automations"
import { sessionTimestampIso } from "../src/remote-sessions/timestamps.js"
import {
  memberSessionComputerSchema,
  memberSessionSchema,
  remoteSessionAttachResponseSchema,
} from "@openwork/types/den/remote-sessions"

test("session report ingestion accepts only timestamps that can serialize as RFC 3339", () => {
  assert.equal(RUNNER_SESSION_TIMESTAMP_MAX, Date.parse("9999-12-31T23:59:59.999Z"))
  const report = (updatedAt: number) => ({ access: "all", sessions: [{ workspaceId: "ws_1", sessionId: "ses_1", title: "Task", engine: "v2", updatedAt }] })
  for (const value of [0, RUNNER_SESSION_TIMESTAMP_MAX - 1, RUNNER_SESSION_TIMESTAMP_MAX]) {
    assert.equal(runnerSessionReportSchema.safeParse(report(value)).success, true, String(value))
  }
  for (const value of [-1, 0.5, RUNNER_SESSION_TIMESTAMP_MAX + 1, Number.MAX_SAFE_INTEGER, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(runnerSessionReportSchema.safeParse(report(value)).success, false, String(value))
  }
})

test("stored session timestamps serialize safely without expanded years", () => {
  assert.equal(sessionTimestampIso(0), "1970-01-01T00:00:00.000Z")
  assert.equal(sessionTimestampIso(RUNNER_SESSION_TIMESTAMP_MAX), "9999-12-31T23:59:59.999Z")
  for (const value of [null, undefined, -1, 0.5, RUNNER_SESSION_TIMESTAMP_MAX + 1, Number.MAX_SAFE_INTEGER, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(sessionTimestampIso(value), null, String(value))
  }
})

const timestamps = {
  "MemberSessionComputer.lastSeenAt": memberSessionComputerSchema.shape.lastSeenAt,
  "MemberSessionComputer.sessionsUpdatedAt": memberSessionComputerSchema.shape.sessionsUpdatedAt,
  "MemberSession.updatedAt": memberSessionSchema.shape.updatedAt,
  "RemoteSessionAttachResponse.expiresAt": remoteSessionAttachResponseSchema.shape.expiresAt,
}

for (const [name, schema] of Object.entries(timestamps)) {
  test(`${name} documents and validates a nullable RFC 3339 timestamp`, () => {
    const jsonSchema = z.toJSONSchema(schema)
    assert.equal(jsonSchema.anyOf?.[0]?.type, "string")
    assert.equal(jsonSchema.anyOf?.[0]?.format, "date-time")
    assert.deepEqual(jsonSchema.anyOf?.[1], { type: "null" })

    for (const value of [null, "1970-01-01T00:00:00.000Z", "2026-11-11T12:34:56.789Z", "2026-11-11T13:34:56.789+01:00"]) {
      assert.equal(schema.safeParse(value).success, true, String(value))
    }
    for (const value of [0, 1_794_400_496_789, -1, "not a timestamp", "2026-11-11", "2026-11-11T12:34:56"]) {
      assert.equal(schema.safeParse(value).success, false, String(value))
    }
  })
}
