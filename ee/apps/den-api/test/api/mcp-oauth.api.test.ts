/**
 * Den as an OAuth client of MCP servers: a sign-in reply naming the wrong
 * issuer or carrying a forged state is refused before Den asks for a token, a
 * genuine reply works only once, a reply is exchanged only for the person who
 * started the connection (another signed-in account is refused, a browser with
 * no OpenWork session must confirm the account first), a server declaring its
 * protected resource on another site is refused, and a member cannot replace an
 * admin-provisioned connector by its key. Ported from evals/core/den-manage-connectors*.e2e.test.ts
 * and evals/specs/mcp-oauth-response-issuer.test.ts, mcp-oauth-declared-resource.test.ts.
 */
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { bootDen, field, list, startFakeHttpServer, startFakeMcpServer, startFakeOAuthMcpServer, summary, text, type Member } from "./harness.js"

/** Stands in for a native provider's token and identity endpoints, counting code exchanges. */
let nativeTokenRequests = 0
const nativeProvider = await startFakeHttpServer((request, _raw, response) => {
  if (request.url === "/token" && request.method === "POST") {
    nativeTokenRequests += 1
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "fake-native-access", token_type: "Bearer", expires_in: 3600, refresh_token: "fake-native-refresh" }))
    return
  }
  if (request.url === "/userinfo") {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sub: "fake-native-account", email: "olivia@provider.example.test" }))
    return
  }
  response.writeHead(404).end()
})
const den = await bootDen({ env: { DEN_GOOGLE_OAUTH_TOKEN_URL: `${nativeProvider.url}/token`, DEN_GOOGLE_OAUTH_USERINFO_URL: `${nativeProvider.url}/userinfo` } })
const issuer = await startFakeOAuthMcpServer({ responseIssuer: true })
const foreign = await startFakeOAuthMcpServer({ protectedResource: "https://mcp.example.com/mcp" })
const plain = await startFakeMcpServer({ tools: [{ name: "read_notes", description: "Read notes", text: "notes" }] })
after(async () => {
  await Promise.all([issuer.close(), foreign.close(), plain.close(), nativeProvider.close()])
  await den.close()
})

let orgId = ""
let owner: Member
let sam: Member

before(async () => {
  const created = await den.createOrg(await den.signUp("Olivia Owner"), "Connectors org")
  orgId = created.orgId
  owner = created.owner
  sam = await den.newMember(owner, orgId, "Sam Member")
})

async function saveOAuthConnection(name: string, url: string, credentialMode: "shared" | "per_member"): Promise<string> {
  const created = await den.as(owner, orgId)("POST", "/v1/mcp-connections", { name, url, authType: "oauth", credentialMode, access: { orgWide: true } })
  assert.equal(created.status, 200, summary(created))
  return text(field(created.body, "id"), "connection id")
}

async function connected(connectionId: string): Promise<boolean> {
  const listed = await den.as(owner, orgId)("GET", "/v1/mcp-connections?scope=manageable")
  return field(list(field(listed.body, "connections")).find((row) => row.id === connectionId), "connected") === true
}

/** Owner clicks Sign in; the browser follows the provider's authorize redirect back toward Den. */
async function providerReply(connectionId: string): Promise<URL> {
  const started = await den.as(owner, orgId)("GET", `/v1/mcp-connections/${connectionId}/connect/start`)
  assert.equal(started.status, 200, summary(started))
  const authorizeUrl = text(field(started.body, "authorizeUrl"), "authorize URL")
  const redirect = await fetch(authorizeUrl, { redirect: "manual" })
  assert.equal(redirect.status, 302)
  return new URL(text(redirect.headers.get("location"), "provider redirect"))
}

/**
 * The browser lands on Den's callback with whatever the reply carries.
 * `browser` is who is signed in to OpenWork there: the owner who started the
 * connection unless a test says otherwise, or null for a browser with no session.
 */
async function visit(callback: URL, browser: Member | null = owner): Promise<{ status: number; tokenRequests: number; page: string; headers: Headers }> {
  const before = issuer.tokenRequests() + nativeTokenRequests
  const reply = await den.request(null, "GET", `${callback.pathname}${callback.search}`, browser ? { headers: { cookie: browser.cookie } } : {})
  return { status: reply.status, tokenRequests: issuer.tokenRequests() + nativeTokenRequests - before, page: reply.text, headers: reply.headers }
}

/** The reply again, carrying the confirmation the page's Continue button submits. */
function confirmedReply(callback: URL, page: string): URL {
  const confirmed = new URL(callback)
  confirmed.searchParams.set("confirm", text(page.match(/name="confirm" value="([^"]+)"/)?.[1], "confirmation"))
  return confirmed
}

test("a sign-in reply with the wrong issuer or a forged state is refused before Den asks for a token; the genuine reply works once", async () => {
  const id = await saveOAuthConnection("Issuer Notes", issuer.mcpUrl, "per_member")

  const wrong = await providerReply(id)
  assert.equal(wrong.searchParams.get("iss"), issuer.url, "the provider names itself")
  wrong.searchParams.set("iss", "https://other-issuer.example.test")
  const wrongIssuer = await visit(wrong)
  assert.equal(wrongIssuer.status, 400)
  assert.equal(wrongIssuer.tokenRequests, 0)
  assert.equal(await connected(id), false)

  const forged = await providerReply(id)
  forged.searchParams.set("state", "forged-state")
  const forgedState = await visit(forged)
  assert.equal(forgedState.status, 400)
  assert.equal(forgedState.tokenRequests, 0)
  assert.equal(await connected(id), false)

  const real = await providerReply(id)
  const genuine = await visit(real)
  assert.equal(genuine.status, 200)
  assert.equal(genuine.tokenRequests, 1)
  assert.equal(await connected(id), true)

  const replay = await visit(real)
  assert.equal(replay.status, 400)
  assert.equal(replay.tokenRequests, 0)
})

test("a sign-in reply is exchanged only for the person who started the connection", async () => {
  const id = await saveOAuthConnection("Starter Notes", issuer.mcpUrl, "per_member")

  // The reply reaches a browser signed in to OpenWork as someone else.
  const other = await visit(await providerReply(id), sam)
  assert.equal(other.status, 403)
  assert.equal(other.tokenRequests, 0)
  assert.equal(await connected(id), false)

  // The reply reaches a browser with no OpenWork session: Den names the account and waits.
  const earlier = await providerReply(id)
  const earlierAsked = await visit(earlier, null)
  const reply = await providerReply(id)
  const asked = await visit(reply, null)
  assert.equal(asked.status, 200)
  assert.equal(asked.tokenRequests, 0)
  assert.match(asked.page, /Confirm this connection/)
  assert.ok(asked.page.includes(owner.email), "the page names the account")
  assert.ok(asked.page.includes("Connectors org"), "the page names the organization")
  assert.equal(asked.headers.get("content-security-policy"), "frame-ancestors 'none'", "the page with the Continue button cannot be framed")
  assert.equal(await connected(id), false)

  // A confirmation issued for another reply does not continue this one.
  const borrowed = new URL(reply)
  borrowed.searchParams.set("confirm", text(confirmedReply(earlier, earlierAsked.page).searchParams.get("confirm"), "earlier confirmation"))
  const stillAsked = await visit(borrowed, null)
  assert.equal(stillAsked.status, 200)
  assert.equal(stillAsked.tokenRequests, 0)
  assert.match(stillAsked.page, /Confirm this connection/)
  assert.equal(await connected(id), false)

  const finished = await visit(confirmedReply(reply, asked.page), null)
  assert.equal(finished.status, 200)
  assert.equal(finished.tokenRequests, 1)
  assert.equal(await connected(id), true)
})

test("a native provider reply is exchanged only for the person who started the connection", async () => {
  const saved = await den.as(owner, orgId)("POST", "/v1/oauth-providers/google-workspace/client", { clientId: "fake-native-client", clientSecret: "fake-native-secret" })
  assert.equal(saved.status, 200, summary(saved))
  const nativeConnected = async (): Promise<boolean> => field((await den.as(owner, orgId)("GET", "/v1/oauth-providers/google-workspace/status")).body, "connected") === true
  /** Owner clicks Connect; the provider approves and redirects back toward Den. */
  const nativeReply = async (): Promise<URL> => {
    const started = await den.as(owner, orgId)("GET", "/v1/oauth-providers/google-workspace/connect/start")
    assert.equal(started.status, 200, summary(started))
    const authorize = new URL(text(field(started.body, "authorizeUrl"), "authorize URL"))
    const callback = new URL(text(authorize.searchParams.get("redirect_uri"), "redirect URI"))
    callback.searchParams.set("code", "fake-native-code")
    callback.searchParams.set("state", text(authorize.searchParams.get("state"), "state"))
    return callback
  }

  const other = await visit(await nativeReply(), sam)
  assert.equal(other.status, 403)
  assert.equal(other.tokenRequests, 0)
  assert.equal(await nativeConnected(), false)

  const reply = await nativeReply()
  const asked = await visit(reply, null)
  assert.equal(asked.status, 200)
  assert.equal(asked.tokenRequests, 0)
  assert.match(asked.page, /Confirm this connection/)
  assert.ok(asked.page.includes(owner.email), "the page names the account")
  assert.equal(await nativeConnected(), false)

  const finished = await visit(confirmedReply(reply, asked.page), null)
  assert.equal(finished.tokenRequests, 1)
  assert.equal(await nativeConnected(), true)

  // The person who started it, signed in to OpenWork in the same browser, is not asked.
  const direct = await visit(await nativeReply(), owner)
  assert.equal(direct.tokenRequests, 1)
})

test("Den refuses to sign in to a server that declares its protected resource on another site", async () => {
  const id = await saveOAuthConnection("Lookalike Notes", foreign.mcpUrl, "shared")
  // The same fake without the foreign resource signs in fine (previous test), so the resource is the only difference.
  const started = await den.as(owner, orgId)("GET", `/v1/mcp-connections/${id}/connect/start`)
  assert.equal(started.status, 424, summary(started))
  assert.equal(field(started.body, "error"), "oauth_handshake_failed")
  assert.equal(field(started.body, "authorizeUrl"), undefined)
  assert.deepEqual(foreign.requests.filter((entry) => entry.path === "/authorize" || entry.path === "/token" || entry.path === "/register"), [])
  assert.equal(await connected(id), false)
})

test("a member cannot replace a connector an admin provisioned by its key, and it stays as the admin left it", async () => {
  const externalKey = `provisioned-notes-${den.stamp}`
  const input = { name: "Provisioned Notes", url: `${plain.url}/mcp`, authType: "none", credentialMode: "shared", access: { orgWide: true } }
  const created = await den.as(owner, orgId)("PUT", `/v1/mcp-connections/by-key/${externalKey}`, input)
  assert.equal(created.status, 201, summary(created))

  const denied = await den.as(sam, orgId)("PUT", `/v1/mcp-connections/by-key/${externalKey}`, { ...input, name: "Sam's Notes", url: "http://127.0.0.1:9/mcp" })
  assert.equal(denied.status, 403, summary(denied))

  const listed = await den.as(owner, orgId)("GET", "/v1/mcp-connections?scope=manageable")
  const rows = list(field(listed.body, "connections")).filter((row) => row.externalKey === externalKey)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.name, "Provisioned Notes")
  assert.equal(rows[0]?.url, `${plain.url}/mcp`)
})
