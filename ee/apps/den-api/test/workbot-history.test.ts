import assert from "node:assert/strict"
import { test } from "node:test"
import { createHeadlessRunnerClient } from "../../../packages/headless-protocol/src/client.ts"
import { readWorkbotThread, type WorkbotActor } from "../../../packages/workbot-server/src/service.ts"

const actor: WorkbotActor = { organizationId: "org_example", organizationName: "Example", organizationMetadata: {}, memberId: "member_example", userId: "user_example", firstName: "Alex" }

test("a 200-record runner window can contain only 100 visible conversation messages", async () => {
  const turns = Array.from({ length: 200 }, (_, index) => ({
    messageId: `wb_message${index}`, status: "completed", error: null, createdAt: index + 1,
    ...(index % 2 ? { kind: "task", parent: `wb_message${index - 1}`, title: "Background work" } : {}),
  }))
  const messages = turns.filter((_turn, index) => index % 2 === 0).map(turn => ({ role: "user", messageId: turn.messageId, text: "Earlier question" }))
  const client = createHeadlessRunnerClient({
    config: { url: "http://runner", token: "local-fixture-token" }, maxTokenTtlMs: 1000,
    mintToken: async () => ({ token: "local-member-token" }),
    fetch: async url => String(url).endsWith("/v1/files/status")
      ? Response.json({ enabled: false })
      : Response.json({ turns, messages, hasEarlier: true, finalAssistantText: "Earlier answer" }),
  })
  const thread = await readWorkbotThread(actor, { turns: 200 }, { client, canSchedule: async () => false })
  assert.equal(turns.length, 200)
  assert.equal(thread.turns.length, 100)
  assert.equal(thread.hasEarlier, true)
})
