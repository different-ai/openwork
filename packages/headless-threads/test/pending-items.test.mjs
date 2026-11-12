import assert from "node:assert/strict"
import test from "node:test"

// The package's default export is its build: run `pnpm --filter @openwork/headless-threads build` first.
import { createHeadlessThreadClient, HEADLESS_THREAD_PENDING_ITEMS_MAX } from "../dist/index.js"

const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
const v1Permission = (id, sessionID = "ses_v1") => ({ id, sessionID, permission: "edit", patterns: [`${id}.md`] })
const v1Question = (id, sessionID = "ses_v1") => ({ id, sessionID, questions: [{ header: id, question: "Which one?", options: [{ label: "A" }, { label: "B" }], custom: false }] })

/** A v1 engine holding the given open requests; a reply or a rejection closes the one it names. */
function v1Fixture(open) {
  const calls = []
  const client = createHeadlessThreadClient({
    baseUrl: "http://localhost:8787", token: "fixture-token", workspaceId: "workspace_fixture", engine: "v1",
    fetch: async (input, init = {}) => {
      const path = new URL(String(input)).pathname.replace("/workspace/workspace_fixture/opencode", "")
      const method = init.method ?? "GET"
      if (method !== "GET") calls.push([method, path, init.body === undefined ? undefined : JSON.parse(init.body)])
      if (path === "/permission") return response(open.permissions)
      if (path === "/question") return response(open.questions)
      if (path === "/session/ses_other") return response({ id: "ses_other" })
      const settled = /^\/(permission|question)\/([^/]+)\/(reply|reject)$/.exec(path)
      if (settled && method === "POST") {
        const list = settled[1] === "permission" ? "permissions" : "questions"
        if (!open[list].some((row) => row.id === settled[2])) return response({ message: "not pending" }, 404)
        open[list] = open[list].filter((row) => row.id !== settled[2])
        return response(true)
      }
      return response({ message: "unexpected" }, 404)
    },
  })
  return { client, calls }
}

test("every open request of a thread is listed, permissions first, and the first is the one getThreadPending returns", async () => {
  const open = {
    permissions: [v1Permission("per_foreign", "ses_other"), v1Permission("per_a"), v1Permission("per_b")],
    questions: [v1Question("que_a"), v1Question("que_foreign", "ses_other"), v1Question("que_b")],
  }
  const { client } = v1Fixture(open)
  const items = await client.getThreadPendingItems("ses_v1")
  assert.deepEqual(items.map((item) => [item.kind, item.requestId]),
    [["permission", "per_a"], ["permission", "per_b"], ["question", "que_a"], ["question", "que_b"]])
  assert.deepEqual(items[0], await client.getThreadPending("ses_v1"))
  assert.deepEqual(items[0], { kind: "permission", requestId: "per_a", title: "Edit files", detail: "per_a.md" })
  open.permissions = []
  assert.deepEqual((await client.getThreadPendingItems("ses_v1"))[0], await client.getThreadPending("ses_v1"))
  open.questions = []
  assert.deepEqual(await client.getThreadPendingItems("ses_v1"), [])
  assert.equal(await client.getThreadPending("ses_v1"), null)
})

test("the list stops at five; a request beyond it can still be answered by its id", async () => {
  assert.equal(HEADLESS_THREAD_PENDING_ITEMS_MAX, 5)
  const open = {
    permissions: ["per_1", "per_2", "per_3", "per_4"].map((id) => v1Permission(id)),
    questions: ["que_1", "que_2", "que_3"].map((id) => v1Question(id)),
  }
  const { client, calls } = v1Fixture(open)
  assert.deepEqual((await client.getThreadPendingItems("ses_v1")).map((item) => item.requestId), ["per_1", "per_2", "per_3", "per_4", "que_1"])
  await client.answerThread("ses_v1", { kind: "question", requestId: "que_3", answers: [["B"]] })
  assert.deepEqual(calls, [["POST", "/question/que_3/reply", { answers: [["B"]] }]])
})

test("any open request is answered by its id; an id that is not open, or of the other kind, is stale", async () => {
  const open = { permissions: [v1Permission("per_a"), v1Permission("per_b")], questions: [v1Question("que_a"), v1Question("que_b")] }
  const { client, calls } = v1Fixture(open)
  await client.answerThread("ses_v1", { kind: "question", requestId: "que_b", answers: [["A"]] })
  await client.answerThread("ses_v1", { kind: "permission", requestId: "per_b", decision: "once" })
  assert.deepEqual(calls, [
    ["POST", "/question/que_b/reply", { answers: [["A"]] }],
    ["POST", "/permission/per_b/reply", { reply: "once" }],
  ])
  await assert.rejects(client.answerThread("ses_v1", { kind: "question", requestId: "que_b", answers: [["A"]] }), { code: "stale_request" })
  await assert.rejects(client.answerThread("ses_v1", { kind: "permission", requestId: "que_a", decision: "once" }), { code: "stale_request" })
  await assert.rejects(client.answerThread("ses_v1", { kind: "question", requestId: "per_a", answers: [["A"]] }), { code: "stale_request" })
  await assert.rejects(client.answerThread("ses_v1", { kind: "question", requestId: "que_a", answers: [["C"]] }), { code: "invalid_answer" })
  assert.equal(calls.length, 2, "a refused answer sends nothing")
  assert.deepEqual((await client.getThreadPendingItems("ses_v1")).map((item) => item.requestId), ["per_a", "que_a"])
})

test("a v1 question is dismissed through the engine's reject route; a permission cannot be dismissed", async () => {
  const open = { permissions: [v1Permission("per_a")], questions: [v1Question("que_a"), v1Question("que_b")] }
  const { client, calls } = v1Fixture(open)
  await assert.rejects(client.answerThread("ses_v1", { kind: "dismiss", requestId: "per_a" }), { code: "invalid_answer" })
  await assert.rejects(client.answerThread("ses_v1", { kind: "dismiss", requestId: "que_gone" }), { code: "stale_request" })
  assert.deepEqual(calls, [])
  await client.answerThread("ses_v1", { kind: "dismiss", requestId: "que_b" })
  assert.deepEqual(calls, [["POST", "/question/que_b/reject", undefined]])
  assert.deepEqual((await client.getThreadPendingItems("ses_v1")).map((item) => item.requestId), ["per_a", "que_a"])
  await assert.rejects(client.answerThread("ses_v1", { kind: "dismiss", requestId: "que_b" }), { code: "stale_request" })
})

test("a v2 form is dismissed by deleting it, including a link step that takes no answer and a helper's form", async () => {
  const calls = []
  const forms = {
    ses_task: [
      { id: "frm_link", title: "Sign in", fields: [{ key: "open", type: "external", url: "https://example.com/authorize", title: "Sign in to Example" }] },
      { id: "frm_branch", fields: [{ key: "branch", type: "string", title: "Branch", options: [{ label: "Development", value: "dev" }], custom: false }] },
    ],
    ses_helper: [{ id: "frm_helper", fields: [{ key: "file", type: "string", title: "File" }] }],
  }
  const permissions = { ses_task: [{ id: "per_task", action: "bash", resources: ["pnpm build"] }], ses_helper: [] }
  const client = createHeadlessThreadClient({
    baseUrl: "http://localhost:8787", token: "fixture-token", workspaceId: "workspace_fixture", engine: "v2",
    fetch: async (input, init = {}) => {
      const url = new URL(String(input))
      const path = url.pathname.replace("/workspace/workspace_fixture/opencode2/api", "")
      const method = init.method ?? "GET"
      if (method !== "GET") calls.push([method, path, init.body === undefined ? undefined : JSON.parse(init.body)])
      if (path === "/session") return response({ data: url.searchParams.get("parentID") === "ses_task" ? [{ id: "ses_helper", parentID: "ses_task" }] : [] })
      if (path === "/session/active") return response({ data: { ses_task: { type: "running" }, ses_helper: { type: "running" } } })
      const [, session, list, id, action] = /^\/session\/([^/]+)\/(permission|form)(?:\/([^/]+))?(?:\/(reply))?$/.exec(path) ?? []
      const rows = list === "form" ? forms : permissions
      if (!session || !rows[session]) return response({ message: "unexpected" }, 404)
      if (id === undefined) return response({ data: rows[session] })
      const settles = action === "reply" ? method === "POST" : list === "form" && method === "DELETE"
      if (!settles || !rows[session].some((row) => row.id === id)) return response({ message: "not pending" }, 404)
      rows[session] = rows[session].filter((row) => row.id !== id)
      return response({})
    },
  })
  assert.deepEqual((await client.getThreadPendingItems("ses_task")).map((item) => [item.kind, item.requestId]),
    [["permission", "per_task"], ["question", "frm_link"], ["question", "frm_branch"]])
  await assert.rejects(client.answerThread("ses_task", { kind: "dismiss", requestId: "per_task" }), { code: "invalid_answer" })
  await assert.rejects(client.answerThread("ses_task", { kind: "question", requestId: "frm_link", answers: [["done"]] }), { code: "invalid_answer" })
  assert.deepEqual(calls, [])
  // The second form is answered while the first is still open, then the link step is cleared.
  await client.answerThread("ses_task", { kind: "question", requestId: "frm_branch", answers: [["Development"]] })
  await client.answerThread("ses_task", { kind: "dismiss", requestId: "frm_link" })
  await client.answerThread("ses_task", { kind: "permission", requestId: "per_task", decision: "reject" })
  assert.deepEqual(calls, [
    ["POST", "/session/ses_task/form/frm_branch/reply", { answer: { branch: "dev" } }],
    ["DELETE", "/session/ses_task/form/frm_link", undefined],
    ["POST", "/session/ses_task/permission/per_task/reply", { decision: "reject", reply: "reject" }],
  ])
  // With nothing of its own left, the thread is held by its helper: the dismissal goes to the helper that asked.
  assert.deepEqual((await client.getThreadPendingItems("ses_task")).map((item) => item.requestId), ["frm_helper"])
  await client.answerThread("ses_task", { kind: "dismiss", requestId: "frm_helper" })
  assert.deepEqual(calls.at(-1), ["DELETE", "/session/ses_helper/form/frm_helper", undefined])
  assert.deepEqual(await client.getThreadPendingItems("ses_task"), [])
})
