import { afterEach, beforeEach, expect, test } from "bun:test"
import type { UIMessage } from "ai"
import { createV2EventTranslationState, translateV2Event } from "../src/app/lib/opencode-v2-adapter"
import { getReactQueryClient } from "../src/react-app/infra/query-client"
import {
  __applySessionSyncEventForTest,
  __createWorkspaceSessionSyncForTest,
  trackWorkspaceSessionSync,
  transcriptKey,
} from "../src/react-app/domains/session/sync/session-sync"

const SESSION = "ses_reply_order"
const sync = { workspaceId: "ws_reply_order", baseUrl: "http://127.0.0.1:9/w/ws_reply_order/opencode2", openworkToken: "token" }
const location = { directory: "/tmp/reply-order" }
const originalFetch = globalThis.fetch
let cleanup: () => void = () => {}

beforeEach(() => {
  // Retaining the session may read history; this test drives the live stream only.
  globalThis.fetch = (async () => Response.json({ location, data: [] })) as unknown as typeof fetch
  const dispose = __createWorkspaceSessionSyncForTest(sync)
  const release = trackWorkspaceSessionSync(sync, SESSION)
  cleanup = () => { release(); dispose() }
})
afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  getReactQueryClient().removeQueries({ queryKey: transcriptKey(sync.workspaceId, SESSION) })
})

function prompt(inboxID: string, text: string, created: number) {
  return { type: "session.inbox.enqueued", created, location, data: { sessionID: SESSION, inboxID, item: { type: "user", payload: { text } } } }
}

function replyStream(ordinal: number, timestamp: number) {
  return { type: "session.text.started", created: timestamp, location, data: { sessionID: SESSION, messageID: "msg_reply", ordinal, timestamp } }
}

function replyToolCall(timestamp: number) {
  return { type: "session.tool.input.started", created: timestamp, location, data: { sessionID: SESSION, messageID: "msg_reply", callID: "call_list", name: "shell", timestamp } }
}

function transcript() {
  return (getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(sync.workspaceId, SESSION)) ?? []).map((message) => message.id)
}

function engine() {
  const state = createV2EventTranslationState()
  return (event: unknown) => {
    for (const translated of translateV2Event(event, state) ?? []) __applySessionSyncEventForTest(sync, translated)
  }
}

test("a reply keeps its place when it starts a new stream after a follow-up", () => {
  const apply = engine()
  apply(prompt("msg_first", "Sort the photos", 1_000))
  apply(replyStream(0, 1_100))
  // Sent while the reply was still being written.
  apply(prompt("msg_follow_up", "Only the ones from June", 3_000))
  expect(transcript()).toEqual(["msg_first", "msg_reply", "msg_follow_up"])
  // The reply goes on to its next text block (or a tool call) after the follow-up arrived.
  apply(replyStream(1, 5_000))
  expect(transcript()).toEqual(["msg_first", "msg_reply", "msg_follow_up"])
})

test("a reply keeps its place when it starts a tool call after a follow-up", () => {
  const apply = engine()
  apply(prompt("msg_first", "Sort the photos", 1_000))
  apply(replyStream(0, 1_100))
  apply(prompt("msg_follow_up", "Only the ones from June", 3_000))
  apply(replyToolCall(5_000))
  expect(transcript()).toEqual(["msg_first", "msg_reply", "msg_follow_up"])
})

test("the answer to the follow-up still comes after it", () => {
  const apply = engine()
  apply(prompt("msg_first", "Sort the photos", 1_000))
  apply(replyStream(0, 1_100))
  apply(prompt("msg_follow_up", "Only the ones from June", 3_000))
  apply({ type: "session.text.started", created: 6_000, location, data: { sessionID: SESSION, messageID: "msg_answer", timestamp: 6_000 } })
  expect(transcript()).toEqual(["msg_first", "msg_reply", "msg_follow_up", "msg_answer"])
})
