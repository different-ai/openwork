import assert from "node:assert/strict"
import { test } from "node:test"
import { buildSlackEnvelope, isInvocation, slackEventSchema } from "../src/slack-assistant/protocol.js"

const dm = { type: "message", channel_type: "im", user: "U1", channel: "D1", ts: "1793975906.868179", thread_ts: "1793973726.896699" }
const image = { id: "F1", name: "image.png" }

test("a DM with text and an attached image (subtype file_share) is a request, and its files reach the prompt", () => {
  // Slack's shape for a message sent with an attachment; extra file fields are dropped by the schema.
  const event = slackEventSchema.parse({ ...dm, subtype: "file_share", text: "map it based on this", files: [{ ...image, mimetype: "image/png" }] })
  assert.equal(isInvocation(event), true)
  const envelope = JSON.parse(buildSlackEnvelope({ event, teamId: "T1", botUserId: "UBOT", context: {}, privateReply: true }))
  assert.equal(envelope.invocation.text, "map it based on this")
  assert.deepEqual(envelope.files, [image])
})

test("a DM with only an attached file is a request", () => {
  assert.equal(isInvocation({ ...dm, subtype: "file_share", text: "", files: [image] }), true)
})

test("a mention with an attached file is a request", () => {
  assert.equal(isInvocation({ type: "app_mention", user: "U1", channel: "C1", ts: "1.1", subtype: "file_share", text: "<@UBOT> look", files: [image] }), true)
})

test("plain DMs and mentions are still requests", () => {
  assert.equal(isInvocation({ ...dm, text: "?" }), true)
  assert.equal(isInvocation({ type: "app_mention", user: "U1", channel: "C1", ts: "1.1", text: "<@UBOT> hi" }), true)
})

test("edits, deletions, bot posts, empty messages and channel chatter are not requests", () => {
  for (const subtype of ["message_changed", "message_deleted", "bot_message", "channel_join", "thread_broadcast"])
    assert.equal(isInvocation({ ...dm, subtype, text: "hi" }), false, subtype)
  assert.equal(isInvocation({ ...dm, subtype: "file_share", text: "hi", files: [image], bot_id: "B1" }), false)
  assert.equal(isInvocation({ ...dm, subtype: "file_share", text: "hi", files: [image], app_id: "A1" }), false)
  assert.equal(isInvocation({ ...dm, text: "  " }), false)
  assert.equal(isInvocation({ ...dm, subtype: "file_share", text: "", files: [] }), false)
  assert.equal(isInvocation({ ...dm, channel_type: "channel", text: "hi" }), false)
})
