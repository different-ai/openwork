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
import { replyModelLabel } from "../src/react-app/domains/session/sync/reply-model"

const SESSION = "ses_live_reply_model"
const sync = { workspaceId: "ws_live_reply_model", baseUrl: "http://127.0.0.1:9/w/ws_live_reply_model/opencode2", openworkToken: "token" }
const location = { directory: "/tmp/live-reply-model" }
const originalFetch = globalThis.fetch
let cleanup: () => void = () => {}

beforeEach(() => {
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

function reply() {
  return (getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(sync.workspaceId, SESSION)) ?? []).find((message) => message.id === "msg_reply")
}

// OpenCode v2 names the model on session.step.started only; text and tool events that follow carry none.
test("a v2 reply names its model while it is still being written", () => {
  const state = createV2EventTranslationState()
  const apply = (event: unknown) => { for (const translated of translateV2Event(event, state) ?? []) __applySessionSyncEventForTest(sync, translated) }
  apply({ type: "session.step.started", created: 1_000, location, data: {
    sessionID: SESSION, assistantMessageID: "msg_reply", agent: "build", started: 1_000,
    model: { providerID: "example-provider", id: "example-model" },
  } })
  apply({ type: "session.text.started", created: 1_100, location, data: { sessionID: SESSION, assistantMessageID: "msg_reply", timestamp: 1_100 } })
  apply({ type: "session.text.delta", created: 1_200, location, data: { sessionID: SESSION, assistantMessageID: "msg_reply", delta: "Here is the update" } })
  const message = reply()
  expect(message).toBeDefined()
  if (!message) return
  const label = replyModelLabel(message, ({ providerID, modelID }) => providerID === "example-provider" && modelID === "example-model" ? "Example Model" : undefined)
  expect(label).toBe("Example Model")
})

test("a step without a model adds no reply metadata", () => {
  const translated = translateV2Event({ type: "session.step.started", created: 1, location, data: { sessionID: SESSION, assistantMessageID: "msg_reply", started: 1 } }, createV2EventTranslationState())
  expect(translated?.map((event) => event.type)).toEqual(["session.execution.progress"])
})
