import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, startFakeHttpServer, summary, text, type Member } from "./harness.js"

const chatScopes = "https://www.googleapis.com/auth/chat.spaces.readonly https://www.googleapis.com/auth/chat.messages.readonly https://www.googleapis.com/auth/chat.messages.create"
const calls: { method: string; path: string; query: URLSearchParams; authorization: string; body: unknown }[] = []
const provider = await startFakeHttpServer(async (request, body, response) => {
  const target = new URL(request.url ?? "/", "http://fixture.test")
  response.setHeader("content-type", "application/json")
  if (target.pathname === "/token") {
    const code = new URLSearchParams(body).get("code") ?? "unknown"
    return void response.end(JSON.stringify({ access_token: code, refresh_token: `refresh_${code}`, expires_in: 3600, token_type: "Bearer", scope: `openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile ${chatScopes}` }))
  }
  if (target.pathname === "/userinfo") return void response.end(JSON.stringify({ sub: request.headers.authorization, email: "connected@example.test", name: "Connected Person" }))
  calls.push({ method: request.method ?? "GET", path: target.pathname, query: target.searchParams, authorization: request.headers.authorization ?? "", body: body ? JSON.parse(body) : null })
  const dm = { name: "spaces/DM1", spaceType: "DIRECT_MESSAGE", spaceUri: "https://chat.google.com/dm/DM1", singleUserBotDm: false }
  if (target.pathname === "/v1/spaces") return void response.end(JSON.stringify({ spaces: [dm], nextPageToken: "page_two" }))
  if (target.pathname === "/v1/spaces:findDirectMessage") {
    if (target.searchParams.get("name") === "users/sam@example.test") return void response.end(JSON.stringify(dm))
    response.statusCode = 404
    return void response.end(JSON.stringify({ error: { code: 404, message: "Direct message not found.", status: "NOT_FOUND" } }))
  }
  if (target.pathname === "/v1/spaces/DM1/messages" && request.method === "GET") {
    return void response.end(JSON.stringify({ messages: [{ name: "spaces/DM1/messages/m1", createTime: "2026-10-27T10:00:00Z", text: "Lunch at noon?", formattedText: "Lunch at noon?", annotations: [], sender: { name: "users/1", type: "HUMAN" }, thread: { name: "spaces/DM1/threads/t1" } }] }))
  }
  if (target.pathname === "/v1/spaces/DM1/messages" && request.method === "POST") {
    return void response.end(JSON.stringify({ name: "spaces/DM1/messages/m2", createTime: "2026-10-27T10:01:00Z", text: field(JSON.parse(body), "text"), thread: { name: "spaces/DM1/threads/t1" } }))
  }
  response.statusCode = 404
  response.end(JSON.stringify({ error: { message: "Not found" } }))
})
const den = await bootDen({ env: {
  DEN_GOOGLE_API_BASE_URL: provider.url,
  DEN_GOOGLE_OAUTH_AUTHORIZE_URL: `${provider.url}/authorize`,
  DEN_GOOGLE_OAUTH_TOKEN_URL: `${provider.url}/token`,
  DEN_GOOGLE_OAUTH_USERINFO_URL: `${provider.url}/userinfo`,
  DEN_AUDIT_SELF_HOSTED_ENABLED: "true",
} })
after(async () => { await den.close(); await provider.close() })

test("a connected member finds a direct message, reads it and replies only after confirming, within the Chat permission", async () => {
  const { owner, orgId } = await den.createOrg(await den.signUp("Alex Example"), "Chat tools")
  const teammate = await den.newMember(owner, orgId, "Taylor Example")
  const call = den.as(owner, orgId)
  const messages = "/v1/capabilities/google-workspace/chat-spaces/DM1/messages"
  const configured = await call("POST", "/v1/oauth-providers/google-workspace/client", { clientId: "fixture_client", clientSecret: "fixture_secret", features: ["chat"] })
  assert.equal(configured.status, 200, summary(configured))
  async function connect(member: Member, code: string) {
    const started = await den.as(member, orgId)("GET", "/v1/oauth-providers/google-workspace/connect/start")
    assert.equal(started.status, 200, summary(started))
    const authorization = new URL(text(field(started.body, "authorizeUrl"), "authorization URL"))
    for (const scope of chatScopes.split(" ")) assert.ok(authorization.searchParams.get("scope")?.includes(scope), scope)
    const callback = new URL(text(authorization.searchParams.get("redirect_uri"), "redirect URI"))
    callback.searchParams.set("state", text(authorization.searchParams.get("state"), "OAuth state"))
    callback.searchParams.set("code", code)
    const connected = await den.request(null, "GET", callback.pathname + callback.search)
    assert.equal(connected.status, 200, summary(connected))
  }
  await connect(owner, "owner_account")

  const mcpToken = await den.mintMcpToken(owner, orgId)
  const discovered = await den.callMcpTool(mcpToken, "search_capabilities", { query: "Google Chat direct message", limit: 20 })
  assert.ok(discovered.raw.includes("findGoogleChatDirectMessage"), discovered.raw.slice(0, 1000))
  const found = await den.callMcpTool(mcpToken, "execute_capability", { name: "native:google-workspace:findGoogleChatDirectMessage", query: { email: "sam@example.test" } })
  assert.equal(found.isError, false, found.text)
  assert.ok(found.text.includes("spaces/DM1"), found.text)
  assert.equal(found.text.includes("singleUserBotDm"), false, "unlisted Google fields are dropped")
  const missing = await call("GET", "/v1/capabilities/google-workspace/chat-direct-message?email=nobody@example.test")
  assert.equal(missing.status, 502, summary(missing))

  const listed = await call("GET", "/v1/capabilities/google-workspace/chat-spaces?spaceType=DIRECT_MESSAGE&pageSize=10")
  assert.equal(listed.status, 200, summary(listed))
  assert.equal(field(listed.body, "nextPageToken"), "page_two")
  assert.equal(calls.at(-1)?.query.get("filter"), 'spaceType = "DIRECT_MESSAGE"')
  assert.equal(calls.at(-1)?.query.get("pageSize"), "10")

  const read = await call("GET", messages)
  assert.equal(read.status, 200, summary(read))
  assert.equal(calls.at(-1)?.query.get("orderBy"), "createTime desc")
  assert.deepEqual(field(read.body, "messages"), [{ name: "spaces/DM1/messages/m1", createTime: "2026-10-27T10:00:00Z", text: "Lunch at noon?", sender: { name: "users/1", type: "HUMAN" }, thread: { name: "spaces/DM1/threads/t1" } }])
  assert.equal((await call("GET", "/v1/capabilities/google-workspace/chat-spaces/..%2Fusers/messages")).status, 400)

  const beforeRefused = calls.length
  assert.equal((await call("POST", messages, { text: "Noon works." })).status, 400, "sending needs explicit confirmation")
  assert.equal((await call("POST", messages, { text: "Noon works.", threadName: "spaces/OTHER/threads/t1", confirm: true })).status, 400)
  assert.equal((await den.as(teammate, orgId)("GET", messages)).status, 409, "an unconnected member cannot use another member's account")
  assert.equal(calls.length, beforeRefused)
  const sent = await call("POST", messages, { text: "Noon works.", threadName: "spaces/DM1/threads/t1", confirm: true })
  assert.equal(sent.status, 200, summary(sent))
  assert.equal(field(sent.body, "name"), "spaces/DM1/messages/m2")
  assert.deepEqual(calls.at(-1)?.body, { text: "Noon works.", thread: { name: "spaces/DM1/threads/t1" } })
  assert.equal(calls.at(-1)?.query.get("messageReplyOption"), "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD")
  assert.equal(calls.at(-1)?.authorization, "Bearer owner_account")

  // The stored account keeps its Chat grants, but an admin turning Chat off stops every call before Google is contacted.
  assert.equal((await call("POST", "/v1/oauth-providers/google-workspace/client", { features: ["calendarRead"] })).status, 200)
  const beforeDisabled = calls.length
  for (const [method, path, body] of [["GET", messages], ["GET", "/v1/capabilities/google-workspace/chat-spaces"], ["POST", messages, { text: "Still there?", confirm: true }]] as const) {
    const refused = await call(method, path, body)
    assert.equal(refused.status, 409, summary(refused))
  }
  assert.equal(calls.length, beforeDisabled)

  const audit = await den.auditStorageText()
  for (const privateValue of ["Lunch at noon?", "Noon works.", "sam@example.test", "owner_account", "fixture_secret"]) assert.equal(audit.includes(privateValue), false, `${privateValue} reached audit storage`)
})
