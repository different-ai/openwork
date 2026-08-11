import assert from "node:assert/strict"
import { test } from "node:test"

process.env.OPENWORK_DEV_MODE = "1"
process.env.DATABASE_URL = "mysql://root:password@127.0.0.1:3306/openwork_den"
process.env.DEN_DB_ENCRYPTION_KEY = "local-dev-db-encryption-key-please-change-1234567890"

const { OPENWORK_VOICE_REALTIME_MODEL, parseOpenworkVoiceRealtimeSessionRequest } = await import("../src/voice.js")

test("voice realtime session request accepts only the managed voice model", () => {
  const defaultRequest = parseOpenworkVoiceRealtimeSessionRequest({})
  const allowedRequest = parseOpenworkVoiceRealtimeSessionRequest({ model: OPENWORK_VOICE_REALTIME_MODEL })
  const unsupportedRequest = parseOpenworkVoiceRealtimeSessionRequest({ model: "gpt-4o-realtime-preview" })

  assert.equal(defaultRequest.success, true)
  assert.equal(allowedRequest.success, true)
  assert.equal(unsupportedRequest.success, false)
})

test("voice realtime session request rejects non-object bodies", () => {
  const parsed = parseOpenworkVoiceRealtimeSessionRequest([])

  assert.equal(parsed.success, false)
})
