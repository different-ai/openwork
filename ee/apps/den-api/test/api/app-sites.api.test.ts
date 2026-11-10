import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, text } from "./harness.js"

// Apps built in OpenWork are on by default in den-api; the eval harness turns them off.
const den = await bootDen({ env: { DEN_APP_MCP_SERVERS_ENABLED: "true" } })
after(() => den.close())

const org = await den.createOrg(await den.signUp("App Site Owner"), "App site workspace")
const mcp = await den.mintMcpToken(org.owner, org.orgId)
const setFeature = async (key: "appSites" | "publicApps", on: boolean) => assert.equal((await den.setFeature(org.orgId, key, on)).status, 200)
await setFeature("appSites", true)
await setFeature("publicApps", true)

async function createApp(title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await den.callMcpTool(mcp, "create_app", {
    title,
    description: `${title} as a page.`,
    reactSource: `export default function App() { return <main><h1>${title}</h1></main> }`,
    textFallback: `${title}.`,
    tools: [],
    ...extra,
  })
  assert.equal(created.isError, false, created.raw)
  return text(field(created.structured, "app", "appId"), "app id")
}

const memberPath = (appId: string) => `/mcp/agent/connections/${appId}`
const publicPath = (appId: string) => `/mcp/public/apps/${appId}`
/** A browser opening the URL: a GET for HTML with no credentials. */
const browse = (path: string) => den.request(null, "GET", path, { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" } })

async function isPage(path: string, mode: "public" | "member", why: string) {
  const page = await browse(path)
  assert.equal(page.status, 200, `${why}: ${page.text.slice(0, 200)}`)
  assert.match(page.headers.get("content-type") ?? "", /text\/html/)
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/)
  assert.ok(page.text.includes(`data-mode="${mode}"`), why)
  return page
}

test("a browser gets a page at an App made a site, and the page holds nothing about the App", async () => {
  const appId = await createApp("Quarterly numbers", { site: true })
  const page = await isPage(memberPath(appId), "member", "signed-in URL")
  assert.ok(!page.text.includes("Quarterly numbers") && !page.text.includes(appId), "the page is the same for every App")

  // Not public, so the public URL has no page for it.
  assert.equal((await browse(publicPath(appId))).status, 405)
})

test("a public site opens at the public URL too", async () => {
  const appId = await createApp("Coffee with the team", { site: true, public: true, publicName: "coffee-site" })
  await isPage(publicPath(appId), "public", "public URL")
  await isPage(publicPath("coffee-site"), "public", "friendly public URL")
  await isPage(memberPath(appId), "member", "signed-in URL")

  await setFeature("appSites", false)
  try {
    assert.equal((await browse(publicPath(appId))).status, 405, "feature off")
    const off = await den.callMcpTool(mcp, "create_app", {
      title: "Off", reactSource: "export default function App() { return <p>Off</p> }", textFallback: "Off.", tools: [], site: true,
    })
    assert.equal(off.isError, true, off.raw)
    assert.match(off.raw, /app_sites_off/)
  } finally {
    await setFeature("appSites", true)
  }
})

/** What the site page sends once the visitor has signed in. */
async function asSitePage(appId: string) {
  const call = await den.request(mcp, "POST", memberPath(appId), {
    headers: { accept: "application/json, text/event-stream", "x-openwork-app-site": "1" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  })
  const line = call.text.split("\n").find((entry) => entry.startsWith("data:"))
  const envelope: unknown = line ? JSON.parse(line.slice(5)) : call.body
  return { call, tools: field(envelope, "result", "tools"), error: field(envelope, "error", "message") }
}

test("before sign-in, the signed-in URL says nothing about whether an App exists or is a site", async () => {
  const plain = await createApp("Plain App")
  const site = await createApp("Site App", { site: true })
  const pages = await Promise.all([site, plain, "cob_00000000000000000000000000"].map((id) => browse(memberPath(id))))
  for (const page of pages) assert.equal(page.status, 200)
  assert.equal(pages[1]?.text, pages[0]?.text, "an App that is not a site gets the same page")
  assert.equal(pages[2]?.text, pages[0]?.text, "an App id that does not exist gets the same page")

  // After sign-in the App's server decides: only the App made a site opens for the page.
  assert.notEqual((await asSitePage(site)).tools, undefined)
  const refused = await asSitePage(plain)
  assert.equal(refused.error, "The App is not available.", refused.call.text)
  await setFeature("appSites", false)
  try {
    assert.equal((await asSitePage(site)).error, "The App is not available.", "feature off")
  } finally {
    await setFeature("appSites", true)
  }
})

test("MCP clients get the answers they got before", async () => {
  const site = await createApp("Client App", { site: true })
  // An MCP client opening an event stream, or one with no Accept header, never gets the page.
  for (const accept of ["text/event-stream", undefined]) {
    const client = await den.request(null, "GET", memberPath(site), { headers: accept ? { accept } : {} })
    assert.equal(client.status, 401, `accept ${accept}`)
    assert.notEqual(client.headers.get("www-authenticate"), null)
  }
  const withToken = await den.request(null, "GET", memberPath(site), { headers: { accept: "text/html", authorization: "Bearer not-a-token" } })
  assert.equal(withToken.status, 401, "a request with credentials is an MCP request")
  // Without the page's header, a member's MCP client opens any App it may use, site or not.
  const plain = await createApp("Client plain App")
  const listed = await den.request(mcp, "POST", memberPath(plain), {
    headers: { accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  })
  assert.ok(listed.text.includes("open_app"), listed.text)
})

test("App pages and public App URLs ask search engines not to list them", async () => {
  const noIndex = "noindex, nofollow, noarchive"
  const appId = await createApp("Unlisted", { site: true, public: true })
  for (const path of [publicPath(appId), memberPath(appId)]) {
    const page = await browse(path)
    assert.equal(page.headers.get("x-robots-tag"), noIndex, path)
    assert.ok(page.text.includes(`<meta name="robots" content="${noIndex}">`), path)
  }
  // Answers that are not the page carry it too: a crawler's plain GET, an unknown name, an MCP reply.
  const plainGet = await den.request(null, "GET", publicPath(appId))
  assert.equal(plainGet.status, 405)
  assert.equal(plainGet.headers.get("x-robots-tag"), noIndex)
  assert.equal((await browse(publicPath("no-such-app"))).headers.get("x-robots-tag"), noIndex)
  const mcpReply = await den.request(null, "POST", publicPath(appId), {
    headers: { accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  })
  assert.equal(mcpReply.status, 200)
  assert.equal(mcpReply.headers.get("x-robots-tag"), noIndex)
})
