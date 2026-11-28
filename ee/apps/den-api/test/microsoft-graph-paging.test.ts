import assert from "node:assert/strict"
import { test } from "node:test"
import { MicrosoftGraphClient, MicrosoftGraphPageTokenError, type MicrosoftGraphPageTokens } from "../src/capability-sources/microsoft-graph.js"

const baseUrl = "https://graph.example.com/v1.0"
const maxResults = 1
const query = "paper moons"
const cases = [
  { name: "plain mail", path: "me/messages", skip: "$skip=17", run: (client: MicrosoftGraphClient, pageToken?: string) => client.listMailMessages({ maxResults, pageToken }) },
  { name: "mail search", path: "me/messages", skip: "$skiptoken=sample%2Bcursor", run: (client: MicrosoftGraphClient, pageToken?: string) => client.listMailMessages({ search: query, maxResults, pageToken }) },
  { name: "calendar", path: "me/calendarView", run: (client: MicrosoftGraphClient, pageToken?: string) => client.listCalendarEvents({ start: "2031-04-01T00:00:00Z", end: "2031-04-02T00:00:00Z", maxResults, pageToken }) },
  { name: "Teams chats", path: "me/chats", run: (client: MicrosoftGraphClient, pageToken?: string) => client.listTeamsChats(maxResults, pageToken) },
  { name: "Teams messages", path: "chats/sample-chat/messages", run: (client: MicrosoftGraphClient, pageToken?: string) => client.listTeamsMessages("sample-chat", maxResults, pageToken) },
  { name: "sites", path: "sites", run: (client: MicrosoftGraphClient, pageToken?: string) => client.searchSites({ query, maxResults, pageToken }) },
  { name: "OneDrive search", path: "me/drive/root/search(q='paper%20moons')", run: (client: MicrosoftGraphClient, pageToken?: string) => client.searchDriveItems({ query, maxResults, pageToken }) },
  { name: "drive children", path: "me/drive/root/children", run: (client: MicrosoftGraphClient, pageToken?: string) => client.listDriveChildren({ maxResults, pageToken }) },
]

function setup(nextLink: string, configureCodec = true) {
  const pages = new Map<string, Parameters<MicrosoftGraphPageTokens["seal"]>[0]>()
  const pageTokens: MicrosoftGraphPageTokens = {
    seal(page) {
      const token = `sample-page-${pages.size}`
      pages.set(token, page)
      return token
    },
    open: (token) => pages.get(token) ?? null,
  }
  const calls: { url: string; headers: Headers }[] = []
  const client = new MicrosoftGraphClient({
    baseUrl, accessToken: "sample-access", pageTokens: configureCodec ? pageTokens : undefined,
    fetch: async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) })
      return calls.length === 1
        ? Response.json({ value: [{ id: "first-sample" }], "@odata.nextLink": nextLink })
        : Response.json({ value: [{ id: "second-sample" }] })
    },
  })
  return { client, calls, pageTokens }
}

for (const { name, path, skip = "$skiptoken=sample%2Fcursor", run } of cases) {
  test(`${name} follows the exact next link and reports the end of the list`, async () => {
    const search = name === "mail search" ? "&%24search=%22paper%20moons%22" : ""
    const nextLink = `${baseUrl}/${path}?$top=1&${skip}&original=keep%20this&original=twice${search}`
    const { client, calls } = setup(nextLink)
    const first = await run(client)
    assert.deepEqual(first.items.map((item) => item.id), ["first-sample"])
    assert.equal(first.hasMore, true)
    assert.ok(first.nextPageToken)
    assert.notEqual(first.nextPageToken, nextLink)
    assert.equal(calls.length, 1)
    const second = name === "mail search"
      ? await client.listMailMessages({ maxResults, pageToken: first.nextPageToken })
      : await run(client, first.nextPageToken)
    assert.deepEqual(second.items.map((item) => item.id), ["second-sample"])
    assert.equal(second.nextPageToken, null)
    assert.equal(second.hasMore, false)
    assert.equal(calls.length, 2)
    assert.equal(calls[1]?.url, nextLink)
    assert.deepEqual(calls[1]?.headers, calls[0]?.headers)
    if (name === "mail search") assert.equal(calls[1]?.headers.get("ConsistencyLevel"), "eventual")
  })

  test(`${name} reports an unreachable next link as partial without requesting it`, async () => {
    for (const nextLink of [`https://other.example.com/v1.0/${path}`, `https://graph.example.com/v1.0-other/${path}`]) {
      const { client, calls } = setup(nextLink)
      const first = await run(client)
      assert.equal(first.hasMore, true)
      assert.equal(first.nextPageToken, null)
      assert.equal(calls.length, 1)
      assert.notEqual(calls[0]?.url, nextLink)
    }
  })
}

test("invalid, tampered, wrong-list, and out-of-bound tokens never reach Graph", async () => {
  const nextLink = `${baseUrl}/me/messages?$skip=17`
  const { client, calls, pageTokens } = setup(nextLink)
  const first = await client.listMailMessages({ maxResults })
  assert.ok(first.nextPageToken)
  await assert.rejects(client.listTeamsChats(maxResults, first.nextPageToken), MicrosoftGraphPageTokenError)
  for (const pageToken of ["garbage", `${first.nextPageToken}-modified`, nextLink, pageTokens.seal({ list: "mail-messages", url: "https://graph.example.com/beta/me/messages" })]) {
    await assert.rejects(client.listMailMessages({ maxResults, pageToken }), MicrosoftGraphPageTokenError)
  }
  assert.equal(calls.length, 1)
})

test("a folder page token for another drive is refused once the member may only read their own drive", async () => {
  const otherDrive = `${baseUrl}/drives/sample-other-drive/items/root/children?$skiptoken=sample-next`
  const ownDrive = `${baseUrl}/drives/sample-own-drive/items/root/children?$skiptoken=sample-next`
  for (const [nextLink, allowed] of [[otherDrive, false], [ownDrive, true]] as const) {
    const pageTokens: MicrosoftGraphPageTokens = { seal: () => "sample-page", open: () => ({ list: "drive-children", url: nextLink }) }
    const calls: string[] = []
    const client = new MicrosoftGraphClient({
      baseUrl, accessToken: "sample-access", pageTokens, ownDriveOnly: true,
      fetch: async (url) => {
        calls.push(String(url))
        return String(url).startsWith(`${baseUrl}/me/drive?`) ? Response.json({ id: "sample-own-drive" }) : Response.json({ value: [{ id: "second-sample" }] })
      },
    })
    const page = client.listDriveChildren({ maxResults, pageToken: "sample-page" })
    if (allowed) {
      assert.equal((await page).items[0]?.id, "second-sample")
      assert.equal(calls.at(-1), nextLink)
    } else {
      await assert.rejects(page, { name: "MicrosoftGraphScopeError" })
      assert.equal(calls.includes(nextLink), false)
    }
  }
})

test("a client without a codec still reports a partial list", async () => {
  const { client, calls } = setup(`${baseUrl}/me/messages?$skip=17`, false)
  const first = await client.listMailMessages({ maxResults })
  assert.equal(first.hasMore, true)
  assert.equal(first.nextPageToken, null)
  assert.equal(calls.length, 1)
})
