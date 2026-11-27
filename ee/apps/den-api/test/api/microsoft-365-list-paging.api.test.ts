import assert from "node:assert/strict"
import { after, test } from "node:test"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, list, startFakeHttpServer, summary } from "./harness.js"

const base = "/v1/capabilities/microsoft-365"
const sampleSubject = "Cardboard comet inventory"
const sampleFile = "felt-satellite.txt"
const driveItem = { name: sampleFile, file: { mimeType: "text/plain" }, parentReference: { driveId: "sample-drive" } }
const cases = [
  { route: "mail-messages", graphPath: "/me/messages", query: { search: "cardboard" }, field: "messages", item: { subject: sampleSubject }, oldFields: { subject: sampleSubject } },
  { route: "calendar-events", graphPath: "/me/calendarView", query: { timeMin: "2031-04-01T00:00:00Z", timeMax: "2031-04-02T00:00:00Z" }, field: "events", item: { subject: sampleSubject }, oldFields: { subject: sampleSubject } },
  { route: "teams-chats", graphPath: "/me/chats", field: "chats", item: { topic: sampleSubject }, oldFields: { topic: sampleSubject } },
  { route: "teams-chats/sample-comet-chat/messages", graphPath: "/chats/sample-comet-chat/messages", field: "messages", item: { body: { content: sampleSubject, contentType: "text" } }, oldFields: { content: sampleSubject } },
  { route: "sites", graphPath: "/sites", query: { query: "cardboard" }, field: "sites", item: { displayName: sampleSubject }, oldFields: { name: sampleSubject } },
  { route: "drive-files", graphPath: "/me/drive/root/search(q='cardboard')", query: { query: "cardboard" }, field: "files", item: driveItem, oldFields: { name: sampleFile, driveId: "sample-drive" }, scope: "myDrive" },
  { route: "drive-children", graphPath: "/me/drive/root/children", field: "files", item: driveItem, oldFields: { name: sampleFile, driveId: "sample-drive" } },
]
const graphCalls: string[] = []
const graph = await startFakeHttpServer((request, body, response) => {
  const path = request.url ?? "/"
  graphCalls.push(path)
  const reply = (status: number, payload: object) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload))
  const url = new URL(path, `http://${request.headers.host}`)
  if (request.method === "POST" && url.pathname === "/v1.0/search/query") {
    const input: unknown = JSON.parse(body)
    const from = field(list(field(input, "requests"))[0], "from")
    if (from !== 0 && from !== 1) return reply(400, { error: "unexpected from" })
    return reply(200, { value: [{ hitsContainers: [{ moreResultsAvailable: from === 0, hits: [{ resource: { ...driveItem, id: `sample-${from + 1}` } }] }] }] })
  }
  const scenario = cases.find((entry) => `/v1.0${entry.graphPath}` === url.pathname)
  if (request.method !== "GET" || !scenario) return reply(404, { error: "unavailable" })
  const cursor = url.searchParams.get("$skiptoken")
  if (cursor === "sample+cursor/2") return reply(200, { value: [{ ...scenario.item, id: "sample-2" }] })
  if (cursor !== null) return reply(400, { error: "unexpected cursor" })
  const query = url.search.slice(1)
  return reply(200, {
    value: [{ ...scenario.item, id: "sample-1" }],
    "@odata.nextLink": `${url.origin}${url.pathname}?${query}&$skiptoken=sample%2Bcursor%2F2`,
  })
})
after(() => graph.close())
const den = await bootDen({ env: { DEN_MICROSOFT_GRAPH_BASE_URL: `${graph.url}/v1.0` } })
after(() => den.close())
const { upsertOrgOAuthClient, upsertConnectedAccount } = await import("../../src/capability-sources/oauth-credentials.js")
const { orgId, owner } = await den.createOrg(await den.signUp("Riley Sample", "riley.sample@example.com"), "Cardboard Orbit Sample")
const api = den.as(owner, orgId)
const key = {
  organizationId: normalizeDenTypeId("organization", orgId),
  orgMembershipId: normalizeDenTypeId("member", owner.memberId),
  providerId: "microsoft-365",
}
await upsertOrgOAuthClient({
  ...key,
  clientId: "sample-graph-client",
  createdByOrgMembershipId: key.orgMembershipId,
  extra: { features: ["mailRead", "calendarRead", "teamsChatRead", "sitesRead", "filesRead", "filesReadAll"], tenantId: "deadcafe-5501-4f3e-8000-000000000019" },
})
function connect(additionalScopes: string[] = []) {
  return upsertConnectedAccount({
    ...key, accessToken: "sample-graph-access", tokenType: "Bearer", expiresAt: new Date(Date.now() + 3_600_000),
    scopes: ["Mail.Read", "Calendars.Read", "Chat.Read", "Sites.Read.All", "Files.Read", ...additionalScopes],
  })
}
await connect()

function routePath(route: string, query: Record<string, string> = {}, pageToken?: string) {
  const params = new URLSearchParams({ ...query, maxResults: "1" })
  if (pageToken !== undefined) params.set("pageToken", pageToken)
  return `${base}/${route}?${params}`
}

function assertPage(body: unknown, key: string, id: string, oldFields: Record<string, unknown>, hasMore: boolean, scope?: string) {
  assert.equal(field(body, "ok"), true)
  const items = list(field(body, key))
  assert.deepEqual(items.map((item) => item.id), [id])
  for (const [name, value] of Object.entries(oldFields)) assert.equal(field(items[0], name), value)
  assert.equal(field(body, "hasMore"), hasMore)
  if (scope) assert.equal(field(body, "scope"), scope)
  const token = field(body, "nextPageToken")
  if (!hasMore) {
    assert.equal(token, null)
    return null
  }
  assert.equal(typeof token, "string")
  assert.ok(typeof token === "string" && token.length > 0)
  return token
}

const invalidResponse = { error: "invalid_request", message: "This page token is not valid any more. Start the list again." }
async function assertInvalid(path: string) {
  const before = graphCalls.length
  const response = await api("GET", path)
  assert.equal(response.status, 400, summary(response))
  assert.deepEqual(response.body, invalidResponse)
  assert.equal(graphCalls.length, before)
}

for (const scenario of cases) {
  test(`${scenario.route} follows a sealed Graph continuation`, async () => {
    const { route, query, oldFields, scope } = scenario
    const path = routePath(route, query)
    const first = await api("GET", path)
    assert.equal(first.status, 200, summary(first))
    const token = assertPage(first.body, scenario.field, "sample-1", oldFields, true, scope)
    assert.ok(token)
    assert.match(token, /^[A-Za-z0-9_-]+$/)
    const second = await api("GET", routePath(route, query, token))
    assert.equal(second.status, 200, summary(second))
    assertPage(second.body, scenario.field, "sample-2", oldFields, false, scope)
    await assertInvalid(routePath(route, query, "garbage"))
    await assertInvalid(routePath(route, query, `${token[0] === "A" ? "B" : "A"}${token.slice(1)}`))
    await assertInvalid(routePath(route === "teams-chats" ? "mail-messages" : "teams-chats", {}, token))
    if (route === "drive-children") await assertInvalid(routePath(route, query, "sample+cursor/2"))
  })
}

test("execute_capability can fetch both pages of Outlook mail", async () => {
  const mcpToken = await den.mintMcpToken(owner, orgId)
  const name = "native:microsoft-365:getCapabilitiesMicrosoft365MailMessages"
  const first = await den.callMcpTool(mcpToken, "execute_capability", { name, query: { maxResults: 1 } })
  assert.equal(first.status, 200)
  assert.equal(first.isError, false, first.text)
  const pageToken = assertPage(first.body, "messages", "sample-1", { subject: sampleSubject }, true)
  assert.ok(pageToken)
  const second = await den.callMcpTool(mcpToken, "execute_capability", { name, query: { maxResults: 1, pageToken } })
  assert.equal(second.status, 200)
  assert.equal(second.isError, false, second.text)
  assertPage(second.body, "messages", "sample-2", { subject: sampleSubject }, false)
})

test("all-files search keeps numeric continuations", async () => {
  await connect(["Files.Read.All"])
  const query = { query: "cardboard" }
  const first = await api("GET", routePath("drive-files", query))
  assert.equal(first.status, 200, summary(first))
  assert.equal(assertPage(first.body, "files", "sample-1", { name: sampleFile }, true, "all"), "1")
  const second = await api("GET", routePath("drive-files", query, "1"))
  assert.equal(second.status, 200, summary(second))
  assertPage(second.body, "files", "sample-2", { name: sampleFile }, false, "all")
  await assertInvalid(routePath("drive-files", query, "garbage"))
})
