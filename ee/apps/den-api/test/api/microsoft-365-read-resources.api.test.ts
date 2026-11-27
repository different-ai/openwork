import assert from "node:assert/strict"
import { after, test } from "node:test"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, list, startFakeHttpServer, summary } from "./harness.js"

const base = "/v1/capabilities/microsoft-365"
const cases = [
  { route: "/mail-folders", graphPath: "/me/mailFolders", key: "folders", name: "listMicrosoft365MailFolders", action: "capability.outlook_mail.folder.list", feature: "mailRead", scopes: ["Mail.Read"] },
  { route: "/mail-folders/sample-pinhole/children", graphPath: "/me/mailFolders/sample-pinhole/childFolders", key: "folders", name: "listMicrosoft365MailFolderChildren", action: "capability.outlook_mail.folder.children.list", feature: "mailRead", scopes: ["Mail.Read"] },
  { route: "/mail-folders/inbox/messages?unreadOnly=true", graphPath: "/me/mailFolders/inbox/messages", key: "messages", name: "listMicrosoft365MailFolderMessages", action: "capability.outlook_mail.folder.messages.list", feature: "mailRead", scopes: ["Mail.Read"] },
  { route: "/profile", graphPath: "/me", key: "profile", name: "getMicrosoft365Profile", action: "capability.microsoft_365.profile.read", feature: null, scopes: ["User.Read"] },
  { route: "/people?name=Echo%20Sample", graphPath: "/users", key: "people", name: "searchMicrosoft365People", action: "capability.microsoft_365.people.search", feature: "directoryRead", scopes: ["User.ReadBasic.All"] },
  { route: "/teams", graphPath: "/me/joinedTeams", key: "teams", name: "listMicrosoft365JoinedTeams", action: "capability.teams.team.list", feature: "teamsChannelList", scopes: ["Team.ReadBasic.All", "Channel.ReadBasic.All"] },
  { route: "/teams/sample-prism/channels", graphPath: "/teams/sample-prism/channels", key: "channels", name: "listMicrosoft365TeamChannels", action: "capability.teams.channel.list", feature: "teamsChannelList", scopes: ["Team.ReadBasic.All", "Channel.ReadBasic.All"] },
]
const calls: string[] = []
let failGraph = false
const graph = await startFakeHttpServer((request, _, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`)
  calls.push(url.pathname)
  const reply = (status: number, payload: object) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload))
  if (failGraph) return reply(503, { error: "sample upstream error" })
  if (request.method !== "GET") return reply(405, {})
  if (url.pathname === "/v1.0/me/messages") return reply(200, { value: [{ id: "sample-legacy-mail", subject: "Paper prism inventory" }] })
  if (url.pathname === "/v1.0/me") return reply(200, { id: "sample-profile", displayName: "Echo Sample" })
  if (!cases.some(({ graphPath }) => url.pathname === `/v1.0${graphPath}`)) return reply(404, {})
  if (url.searchParams.get("$skiptoken") === "sample+prism/2") return reply(200, { value: [{ id: "sample-prism-2" }] })
  url.searchParams.set("$skiptoken", "sample+prism/2")
  return reply(200, { value: [{ id: "sample-prism-1" }], "@odata.nextLink": url.href })
})
after(() => graph.close())
const den = await bootDen({ env: { DEN_MICROSOFT_GRAPH_BASE_URL: `${graph.url}/v1.0`, DEN_AUDIT_SELF_HOSTED_ENABLED: "true" } })
after(() => den.close())
const { upsertConnectedAccount, upsertOrgOAuthClient } = await import("../../src/capability-sources/oauth-credentials.js")
const { orgId, owner } = await den.createOrg(await den.signUp("Echo Sample", "echo.sample@example.com"), "Paper Prism Sample")
const api = den.as(owner, orgId)
const connection = {
  organizationId: normalizeDenTypeId("organization", orgId),
  orgMembershipId: normalizeDenTypeId("member", owner.memberId),
  providerId: "microsoft-365",
}

async function configure(features: string[], scopes: string[]) {
  await upsertOrgOAuthClient({
    ...connection, clientId: "sample-prism-client", createdByOrgMembershipId: connection.orgMembershipId,
    extra: { features, tenantId: "b0b0cafe-3141-4bee-8000-000000000051" },
  })
  await upsertConnectedAccount({
    ...connection, accessToken: "sample-prism-access", tokenType: "Bearer", scopes, expiresAt: new Date(Date.now() + 3_600_000),
  })
}

async function legacyTools(token: string) {
  const result = await den.request(token, "POST", "/mcp", {
    headers: { accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  })
  assert.equal(result.status, 200, summary(result))
  const line = result.text.split("\n").find((entry) => entry.startsWith("data:"))
  const body: unknown = line ? JSON.parse(line.slice(5)) : result.body
  const tools = list(field(body, "result", "tools"))
  assert.ok(tools.some(({ name }) => name === "getCapabilitiesMicrosoft365MailMessages"), result.text)
  return tools.map(({ name }) => name)
}

async function search(token: string, name: string) {
  const result = await den.callMcpTool(token, "search_capabilities", { query: name, type: "api", limit: 20 })
  assert.equal(result.status, 200)
  assert.equal(result.isError, false, result.text)
  return list(field(result.structured ?? result.body, "matches")).some((match) => match.name === `native:microsoft-365:${name}`)
}

test("the flag defaults off for every route and both MCP catalogs without blocking existing mail", async () => {
  await configure(["mailRead", "directoryRead", "teamsChannelList"], ["User.Read", ...cases.flatMap(({ scopes }) => scopes)])
  const token = await den.mintMcpToken(owner, orgId)
  const legacy = await legacyTools(token)
  for (const { route, name } of cases) {
    const result = await api("GET", `${base}${route}`)
    assert.equal(result.status, 404, summary(result))
    assert.deepEqual(result.body, { error: "feature_disabled", feature: "microsoft365ReadResources" })
    assert.equal(await search(token, name), false, name)
    assert.equal(legacy.includes(name), false, name)
  }
  assert.deepEqual(calls, [])
  const existing = await api("GET", `${base}/mail-messages`)
  assert.equal(existing.status, 200, summary(existing))
  assert.equal(list(field(existing.body, "messages"))[0]?.id, "sample-legacy-mail")
  const enabled = await den.setFeature(orgId, "microsoft365ReadResources", true)
  assert.equal(enabled.status, 200, summary(enabled))
})

test("every enabled resource requires a signed-in member", async () => {
  for (const { route } of cases) {
    const result = await den.request(null, "GET", `${base}${route}`, { orgId })
    assert.equal(result.status, 401, summary(result))
  }
})

test("a connected profile needs no optional permission; other resources need both selection and scopes", async () => {
  await configure([], cases.flatMap(({ scopes }) => scopes))
  const before = calls.length
  for (const { route, feature } of cases) {
    if (!feature) continue
    const denied = await api("GET", `${base}${route}`)
    assert.equal(denied.status, 409, summary(denied))
    assert.equal(field(denied.body, "error"), "needs_connection")
    assert.match(String(field(denied.body, "message")), /disabled/)
  }
  await configure(["mailRead", "directoryRead", "teamsChannelList"], ["User.Read", "Team.ReadBasic.All"])
  for (const { route, feature } of cases) {
    if (!feature) continue
    const denied = await api("GET", `${base}${route}`)
    assert.equal(denied.status, 409, summary(denied))
    assert.equal(field(denied.body, "error"), "needs_connection")
    assert.match(String(field(denied.body, "message")), /missing/)
  }
  assert.equal(calls.length, before)
  await configure([], ["User.Read"])
  const profile = await api("GET", `${base}/profile`)
  assert.equal(profile.status, 200, summary(profile))
  assert.equal(field(profile.body, "profile", "displayName"), "Echo Sample")
  await configure(["mailRead", "directoryRead", "teamsChannelList"], cases.flatMap(({ scopes }) => scopes))
})

for (const { route, key, feature } of cases) {
  if (!feature) continue
  test(`${route} follows the sealed continuation and rejects invalid page tokens`, async () => {
    const first = await api("GET", `${base}${route}`)
    assert.equal(first.status, 200, summary(first))
    assert.equal(field(first.body, "hasMore"), true)
    assert.equal(list(field(first.body, key))[0]?.id, "sample-prism-1")
    const pageToken = field(first.body, "nextPageToken")
    assert.ok(typeof pageToken === "string" && pageToken.length > 0)
    const continuation = `${base}${route}${route.includes("?") ? "&" : "?"}pageToken=`
    const second = await api("GET", continuation + encodeURIComponent(pageToken))
    assert.equal(second.status, 200, summary(second))
    assert.equal(field(second.body, "hasMore"), false)
    assert.equal(field(second.body, "nextPageToken"), null)
    assert.equal(list(field(second.body, key))[0]?.id, "sample-prism-2")
    const before = calls.length
    const invalid = await api("GET", continuation + "garbage")
    assert.equal(invalid.status, 400, summary(invalid))
    assert.equal(field(invalid.body, "error"), "invalid_request")
    assert.equal(calls.length, before)
  })
}

test("path-like IDs and invalid queries are rejected, and Graph failures map to 502", async () => {
  const before = calls.length
  for (const route of ["/mail-folders/other%2Fsample/children", "/teams/other%2Fsample/channels", "/people", "/people?name=", "/mail-folders?maxResults=51", "/mail-folders/inbox/messages?unreadOnly=yes"]) {
    const result = await api("GET", `${base}${route}`)
    assert.equal(result.status, 400, summary(result))
    assert.equal(field(result.body, "error"), "invalid_request")
  }
  assert.equal(calls.length, before)
  failGraph = true
  try {
    const failed = await api("GET", `${base}/profile`)
    assert.equal(failed.status, 502, summary(failed))
    assert.equal(field(failed.body, "error"), "microsoft_graph_error")
  } finally {
    failGraph = false
  }
})

test("enabled resources are discoverable and executable through MCP", async () => {
  const token = await den.mintMcpToken(owner, orgId)
  const legacy = await legacyTools(token)
  for (const { name } of cases) {
    assert.equal(await search(token, name), true, name)
    assert.ok(legacy.includes(name), name)
  }
  const result = await den.callMcpTool(token, "execute_capability", { name: "native:microsoft-365:listMicrosoft365MailFolders" })
  assert.equal(result.status, 200)
  assert.equal(result.isError, false, result.text)
  assert.equal(list(field(result.body, "folders"))[0]?.id, "sample-prism-1")
})

test("audit storage records each resource action without the Graph content", async () => {
  const storage = await den.auditStorageText()
  for (const { action } of cases) assert.ok(storage.includes(action), action)
  assert.equal(storage.includes("Paper prism inventory"), false)
})
