import assert from "node:assert/strict"
import { test } from "node:test"
import { FEATURE_KEYS } from "@openwork/features"
import { MICROSOFT_365_FEATURES } from "@openwork/types/den/microsoft-365"
import { MicrosoftGraphClient, MicrosoftGraphPageTokenError, type MicrosoftGraphPageTokens } from "../src/capability-sources/microsoft-graph.js"
import { microsoftGraphResources } from "../src/routes/org/microsoft-graph-resources.js"
import { microsoftGraphResourceSchemas, readMicrosoftGraphResource } from "../src/routes/org/microsoft-graph-resource-reader.js"

const base = "https://graph.example.com/v1.0"
const folderSelect = "id,displayName,parentFolderId,childFolderCount,unreadItemCount,totalItemCount"
const profileSelect = "id,displayName,givenName,surname,mail,userPrincipalName"
const teamSelect = "id,displayName,description"
const folderId = "sample-fold+="
const teamId = "sample-flake%2F="
const fixtures = [
  { name: "listMicrosoft365MailFolders", path: "me/mailFolders", params: {}, query: {}, expected: { $select: folderSelect, $top: "25" } },
  { name: "listMicrosoft365MailFolderChildren", path: "me/mailFolders/sample-fold%2B%3D/childFolders", params: { folderId }, query: { maxResults: "50" }, expected: { $select: folderSelect, $top: "50" } },
  { name: "listMicrosoft365MailFolderMessages", path: "me/mailFolders/drafts/messages", params: { folderId: "drafts" }, query: { unreadOnly: "true" }, expected: {
    $select: "id,conversationId,subject,receivedDateTime,bodyPreview,from,isRead,hasAttachments,webLink", $top: "10", $orderby: "receivedDateTime desc", $filter: "receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false",
  } },
  { name: "getMicrosoft365Profile", path: "me", params: {}, query: {}, expected: { $select: `${profileSelect},jobTitle,officeLocation` } },
  { name: "searchMicrosoft365People", path: "users", params: {}, query: { name: '"Orbit\\ Sample"' }, expected: {
    $select: profileSelect, $top: "10", $count: "true", $orderby: "displayName", $search: '"displayName:Orbit Sample"',
  }, consistency: "eventual" },
  { name: "listMicrosoft365JoinedTeams", path: "me/joinedTeams", params: {}, query: {}, expected: {} },
  { name: "listMicrosoft365TeamChannels", path: "teams/sample-flake%252F%3D/channels", params: { teamId }, query: {}, expected: { $select: `${teamSelect},membershipType,webUrl` } },
]

function findRow(operationId: string) {
  const row = microsoftGraphResources.find((candidate) => candidate.operationId === operationId)
  assert.ok(row, operationId)
  return row
}

test("registry paths, operations, audits, parameters and permissions agree", () => {
  for (const keys of [microsoftGraphResources.map((row) => row.operationId), microsoftGraphResources.map((row) => row.route), microsoftGraphResources.map((row) => row.audit.action)]) {
    assert.equal(new Set(keys).size, keys.length)
  }
  assert.deepEqual(microsoftGraphResources.map((row) => row.operationId).sort(), fixtures.map(({ name }) => name).sort())
  for (const row of microsoftGraphResources) {
    const names = Object.keys(row.params).sort()
    assert.deepEqual(Array.from(row.graph.path.matchAll(/\{(\w+)\}/g), (match) => match[1]).sort(), names)
    assert.deepEqual(Array.from(row.route.matchAll(/:(\w+)/g), (match) => match[1]).sort(), names)
    assert.ok(FEATURE_KEYS.includes(row.flag))
    if (row.permission !== "connection") {
      assert.ok(row.permission.label)
      for (const feature of row.permission.features) assert.ok(MICROSOFT_365_FEATURES.includes(feature))
    }
  }
})

const sender = { name: "Orbit Sample", address: "orbit.sample@example.com" }
const raw = {
  id: "sample-flake-item", displayName: "Paper Flake Samples", totalItemCount: 4, subject: "Prism fold checklist",
  bodyPreview: "Fold the paper prism.", from: { emailAddress: { ...sender, extra: "not returned" } }, isRead: false,
  hasAttachments: true, membershipType: "standard", webUrl: "https://teams.example.com/sample-flake", ignored: "not returned",
}

for (const fixture of fixtures) {
  test(`${fixture.name} sends only declared Graph parameters and maps its projection`, async () => {
    const row = findRow(fixture.name)
    const schemas = microsoftGraphResourceSchemas(row)
    const params = schemas.params.parse(fixture.params)
    const query = schemas.query.parse({ ...fixture.query, $select: "ignored", $filter: "ignored", path: "ignored" })
    const calls: URL[] = []
    const graph = new MicrosoftGraphClient({ baseUrl: base, accessToken: "sample-flake-access", fetch: async (url, init) => {
      calls.push(new URL(String(url)))
      const headers = new Headers(init?.headers)
      assert.equal(headers.get("authorization"), "Bearer sample-flake-access")
      assert.equal(headers.get("ConsistencyLevel"), fixture.consistency ?? null)
      assert.equal(init?.redirect, "error")
      return Response.json(row.output.kind === "item" ? raw : { value: [raw, null, 17, [raw]] })
    } })
    const result = await readMicrosoftGraphResource(graph, row, params, query)
    const [url] = calls
    assert.equal(calls.length, 1)
    assert.equal(`${url.origin}${url.pathname}`, `${base}/${fixture.path}`)
    const expected = Object.fromEntries(Object.entries(fixture.expected).filter((entry) => entry[1] !== undefined))
    assert.deepEqual(Object.fromEntries(url.searchParams), expected)
    if (row.graph.select) assert.deepEqual(url.searchParams.get("$select")?.split(","), [...new Set(Object.values(row.fields).map(({ from }) => from))])
    if (!Object.keys(expected).length) assert.equal(url.href, `${base}/${fixture.path}`)
    assert.ok(schemas.response.safeParse(result).success)
    const projected = result[row.output.key]
    const item: unknown = Array.isArray(projected) ? projected[0] : projected
    assert.ok(item && typeof item === "object")
    assert.deepEqual(Object.keys(item).sort(), Object.keys(row.fields).sort())
    assert.equal("ignored" in item, false)
    assert.equal("id" in item && item.id, raw.id)
    if (row.output.kind === "list") {
      assert.ok(Array.isArray(projected))
      assert.equal(projected.length, 1)
    }
    if (row.output.key === "folders") assert.deepEqual(item, { id: raw.id, name: raw.displayName, parentFolderId: null, childFolderCount: null, unreadItemCount: null, totalItemCount: 4 })
    if (row.output.key === "messages") assert.deepEqual(item, {
      id: raw.id, conversationId: null, subject: raw.subject, receivedDateTime: null, preview: raw.bodyPreview,
      from: sender, isRead: false, hasAttachments: true, webLink: null,
    })
  })
}

test("false unreadOnly omits the filter and missing emailAddress is null", async () => {
  const row = findRow("listMicrosoft365MailFolderMessages")
  const graph = new MicrosoftGraphClient({ baseUrl: base, accessToken: "sample-flake-access", fetch: async (input) => {
    assert.equal(new URL(String(input)).searchParams.has("$filter"), false)
    return Response.json({ value: [{ from: {}, isRead: "false" }] })
  } })
  const result = await readMicrosoftGraphResource(graph, row, { folderId: "inbox" }, { unreadOnly: "false" })
  assert.deepEqual(result.messages, [{ id: null, subject: null, conversationId: null, receivedDateTime: null, preview: null, from: null, isRead: null, hasAttachments: null, webLink: null }])
})

test("directory paging follows the opaque continuation without losing its fixed header", async () => {
  const row = findRow("searchMicrosoft365People")
  const continuation = `${base}/users?$skiptoken=sample-flake%2Bcursor`
  const pages = new Map<string, Parameters<MicrosoftGraphPageTokens["seal"]>[0]>()
  const calls: string[] = []
  const graph = new MicrosoftGraphClient({ baseUrl: base, accessToken: "sample-flake-access", pageTokens: {
    seal(page) {
      const token = "sample-flake-page"
      pages.set(token, page)
      return token
    },
    open: (token) => pages.get(token) ?? null,
  }, fetch: async (input, init) => {
    calls.push(String(input))
    assert.equal(new Headers(init?.headers).get("ConsistencyLevel"), "eventual")
    return calls.length === 1 ? Response.json({ value: [raw], "@odata.nextLink": continuation }) : Response.json({ value: [] })
  } })
  const first = await readMicrosoftGraphResource(graph, row, {}, { name: "Orbit Sample" })
  assert.equal(first.hasMore, true)
  assert.equal(first.nextPageToken, "sample-flake-page")
  assert.equal(pages.get("sample-flake-page")?.list, row.operationId)
  await assert.rejects(readMicrosoftGraphResource(graph, findRow("listMicrosoft365JoinedTeams"), {}, { pageToken: first.nextPageToken }), MicrosoftGraphPageTokenError)
  const second = await readMicrosoftGraphResource(graph, row, {}, { name: "Orbit Sample", pageToken: first.nextPageToken })
  assert.deepEqual(second, { ok: true, people: [], hasMore: false, nextPageToken: null })
  assert.equal(calls.length, 2)
  assert.equal(calls[1], continuation)
})
