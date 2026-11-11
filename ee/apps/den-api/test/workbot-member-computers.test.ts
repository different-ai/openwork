import assert from "node:assert/strict"
import { test } from "node:test"
import { HEADLESS_OWNER_HEADER, type HeadlessRunnerDeps } from "@openwork-ee/headless-protocol"
import { workbotOwner, workbotSessionId, workbotSideChatSessionId } from "@openwork-ee/headless-protocol/workbot-routing"
import { removeMemberWorkbotComputers } from "../src/workbot/member-computers.js"

const member = { organizationId: "org_example", memberId: "member_example" }
const owner = workbotOwner(member.organizationId, member.memberId)
const main = workbotSessionId(member.organizationId, member.memberId)
const side = workbotSideChatSessionId(member.organizationId, member.memberId, "sidechat0000000001")

/** A runner that records what it is asked and answers each path with `answer`. */
function runner(answer: (method: string, path: string) => Response) {
  const calls: Array<{ method: string; path: string; owner: string | null }> = []
  const deps: HeadlessRunnerDeps = {
    config: { url: "http://runner", token: "local-fixture-token" }, maxTokenTtlMs: 1000,
    mintToken: async () => ({ token: "local-member-token" }),
    fetch: async (url, init) => {
      const { pathname, search } = new URL(String(url))
      const method = init?.method ?? "GET"
      calls.push({ method, path: `${pathname}${search}`, owner: new Headers(init?.headers).get(HEADLESS_OWNER_HEADER) })
      return answer(method, pathname)
    },
  }
  return { deps, calls }
}

test("a former member's Workbot computers are deleted, chat by chat, and their chats are kept", async () => {
  const summary = (id: string) => ({ id, ref: null, title: "Chat", createdAt: 1, updatedAt: 2 })
  const { deps, calls } = runner((method, path) => {
    if (method === "GET") return Response.json({ sessions: [summary(main), summary(side)] })
    // The side chat is answering right now: its computer is left for the provider's own keep window.
    return path === `/v1/sessions/${side}/computer` ? Response.json({ error: "session_busy" }, { status: 409 }) : new Response(null, { status: 204 })
  })

  assert.deepEqual(await removeMemberWorkbotComputers(member, deps), { checked: 1, failed: 1 })
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    `GET /v1/sessions?owner=${encodeURIComponent(owner)}&limit=200`,
    `DELETE /v1/sessions/${main}/computer`,
    `DELETE /v1/sessions/${side}/computer`,
  ])
  assert.ok(calls.every((call) => call.owner === owner), "every call is routed to that person's chats only")
})

test("the main chat's computer is tried even when the runner lists no chats, and a missing chat is not a failure", async () => {
  const { deps, calls } = runner((method) => method === "GET" ? Response.json({ sessions: [] }) : Response.json({ error: "unknown_session" }, { status: 404 }))
  assert.deepEqual(await removeMemberWorkbotComputers(member, deps), { checked: 0, failed: 0 })
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`).slice(1), [`DELETE /v1/sessions/${main}/computer`])
})

test("a runner that can't delete a computer on its own yet counts as a failure", async () => {
  const { deps } = runner((method) => method === "GET" ? Response.json({ sessions: [] }) : new Response("404 Not Found", { status: 404 }))
  assert.deepEqual(await removeMemberWorkbotComputers(member, deps), { checked: 0, failed: 1 })
})

test("an unreachable runner is reported, and no runner means nothing to do", async () => {
  const { deps } = runner(() => { throw new Error("connection refused") })
  assert.deepEqual(await removeMemberWorkbotComputers(member, deps), { checked: 0, failed: 2 })
  assert.deepEqual(await removeMemberWorkbotComputers(member, null), { checked: 0, failed: 0 })
})
