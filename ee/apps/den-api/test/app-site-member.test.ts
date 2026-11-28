import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate } from "node:timers/promises"
import { runInNewContext } from "node:vm"

process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/app_site_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-app-site-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-app-site-unit-test-encryption-key"
process.env.OPENWORK_DEV_MODE ??= "1"
process.env.DEN_APP_MCP_SERVERS_ENABLED = "true"

const { appSiteResponse } = await import("../src/mcp/app-site.js")
const appId = "cob_01arzg3ndektsv4rrffq69g5fa"
const orgId = "org_01arzg3ndektsv4rrffq69g5fa"
const page = await appSiteResponse({ appIdOrName: appId, publicOnly: false })
assert.ok(page)
const html = await page.text()
const script = html.match(/<script>([\s\S]*?)<\/script>/u)?.[1]
assert.ok(script)

test("the opening preview includes the inline OpenWork mark and a live status", () => {
  assert.match(html, /<main id="preview"><svg role="img" aria-label="OpenWork"[\s\S]+?viewBox="0 0 834 649"[\s\S]+?<path[\s\S]+?<\/svg><p id="status" role="status">Opening…<\/p><\/main>/u)
  assert.doesNotMatch(html, /<(?:img|link)\b/u)
})

type Link = { href: string; textContent: string }

async function mount(search: string, minted: Response, rpcResponse?: Response) {
  const links: Link[] = []
  const requests: { path: string; headers: Headers }[] = []
  const status = { textContent: "Opening…", append: (link: Link) => links.push(link) }
  runInNewContext(script ?? "", {
    document: {
      documentElement: { dataset: { mode: "member", signIn: "https://den.example.test" } },
      getElementById: (id: string) => id === "status" ? status : {},
      createElement: (tag: string) => {
        assert.equal(tag, "a")
        return { href: "", textContent: "" }
      },
    },
    location: { pathname: `/mcp/agent/connections/${appId}`, search },
    URL,
    URLSearchParams,
    matchMedia: () => ({ addEventListener() {} }),
    addEventListener() {},
    fetch: async (path: string, init: RequestInit) => {
      requests.push({ path, headers: new Headers(init.headers) })
      if (path === "/v1/mcp/token") return minted
      assert.ok(rpcResponse)
      return rpcResponse
    },
  })
  await setImmediate()
  return { status, links, requests }
}

test("a valid organization scopes the mint and survives the sign-in hop", async () => {
  const { status, links, requests } = await mount(`?org=${orgId}`, new Response(null, { status: 401 }))
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.path, "/v1/mcp/token")
  assert.equal(requests[0]?.headers.get("x-openwork-org-id"), orgId)
  assert.equal(status.textContent.trim(), "Sign in to OpenWork to open this artifact.")
  assert.deepEqual(links, [{ href: `https://den.example.test/artifact?id=${appId}&org=${orgId}`, textContent: "Sign in" }])
})

test("an invalid or missing organization is omitted from the mint and sign-in link", async () => {
  for (const search of ["", "?org=invalid", `?org=org_8${orgId.slice(5)}`, `?org=${orgId}%0A`, `?org=${orgId.toUpperCase()}`]) {
    const { links, requests } = await mount(search, new Response(null, { status: 401 }))
    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.headers.has("x-openwork-org-id"), false)
    assert.deepEqual(links, [{ href: `https://den.example.test/artifact?id=${appId}`, textContent: "Sign in" }])
  }
})

test("a refused organization tells the visitor to ask for an invitation", async () => {
  const { status, links } = await mount(`?org=${orgId}`, Response.json({ error: "organization_not_found" }, { status: 404 }))
  assert.equal(status.textContent, "You are signed in, but you are not a member of the organization this artifact belongs to. Ask the person who sent the link to invite you.")
  assert.deepEqual(links, [])
})

test("an unexpected mint failure asks the visitor to try again", async () => {
  const { status, links } = await mount(`?org=${orgId}`, new Response("Unavailable", { status: 503 }))
  assert.equal(status.textContent, "This artifact could not be opened. Try again in a moment.")
  assert.deepEqual(links, [])
})

test("an unavailable artifact tells the visitor to ask for access", async () => {
  const { status, links } = await mount(`?org=${orgId}`, Response.json({ token: "unit-test-token" }), Response.json({
    error: { message: "Artifact unavailable", data: { reason: "not_found" } },
  }))
  assert.equal(status.textContent, "You don't have access to this artifact. Ask the person who sent you the link to share it with you.")
  assert.deepEqual(links, [])
})

test("other RPC refusals keep the server's message", async () => {
  const message = "This artifact belongs to a different organization."
  const { status } = await mount(`?org=${orgId}`, Response.json({ token: "unit-test-token" }), Response.json({
    error: { message, data: { reason: "other_organization" } },
  }))
  assert.equal(status.textContent, message)
})
