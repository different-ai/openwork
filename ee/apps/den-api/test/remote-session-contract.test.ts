import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import {
  memberSessionComputerSchema,
  memberSessionSchema,
  remoteSessionAttachResponseSchema,
} from "@openwork/types/den/remote-sessions"

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
