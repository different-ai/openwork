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
  const appId = await createApp("Coffee with the team", { site: true, public: true })
  await isPage(publicPath(appId), "public", "public URL")
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

test("an App that was not made a site, and every MCP client, get the answers they got before", async () => {
  const plain = await createApp("Plain App")
  const site = await createApp("Site App", { site: true })

  const browser = await browse(memberPath(plain))
  assert.equal(browser.status, 401, "a browser at an App without a site is asked to authorize, as before")
  assert.notEqual(browser.headers.get("www-authenticate"), null)

  // An MCP client opening an event stream, or one with no Accept header, never gets the page.
  for (const accept of ["text/event-stream", undefined]) {
    const client = await den.request(null, "GET", memberPath(site), { headers: accept ? { accept } : {} })
    assert.equal(client.status, 401, `accept ${accept}`)
  }
  const withToken = await den.request(null, "GET", memberPath(site), { headers: { accept: "text/html", authorization: "Bearer not-a-token" } })
  assert.equal(withToken.status, 401, "a request with credentials is an MCP request")

  const unknown = await browse(memberPath("cob_00000000000000000000000000"))
  assert.equal(unknown.status, 401, "an unknown App id reads like any App without a site")
})
