import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"
import { Hono } from "hono"
import { createAuth, type AppEnv } from "../src/server/auth.js"
import { createDen, denSessionSchema } from "../src/server/den.js"
import { loadConfig } from "../src/server/config.js"
import { registerWorkbotRoutes } from "../src/server/routes.js"

test("a media player's range reaches Den and Den's ranged answer comes back unchanged", async () => {
  const asked: Array<{ url: string; range: string | undefined; authorization: string | undefined }> = []
  const server = createServer((req, res) => {
    asked.push({ url: req.url ?? "", range: req.headers.range, authorization: req.headers.authorization })
    // Den answers a player with one part of the file, sent in two pieces a moment apart.
    res.writeHead(206, { "content-type": "video/mp4", "content-length": "8", "content-range": "bytes 100-107/5000", "accept-ranges": "bytes" })
    res.write("abcd")
    setTimeout(() => res.end("efgh"), 20)
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No Den address")
  try {
    const config = loadConfig({ WORKBOT_PUBLIC_URL: "http://localhost:3090", WORKBOT_DEN_API_URL: `http://127.0.0.1:${address.port}`, WORKBOT_RUNNER_URL: "http://127.0.0.1:1", WORKBOT_RUNNER_TOKEN: "x".repeat(32), WORKBOT_SESSION_SECRET: "s".repeat(32) })
    const den = createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl })
    const auth = createAuth({ config, den })
    const app = new Hono<AppEnv>()
    registerWorkbotRoutes(app, { config, den, sameOrigin: auth.sameOrigin, member: async (c, next) => {
      const who = denSessionSchema.parse({ user: { id: "member_a", name: "Alex", email: "alex@example.test" }, organization: { id: "org_example", name: "Example", brandAppName: null }, memberId: "member_a", enabled: true, canSchedule: false, documents: c.req.header("x-test-documents") !== "off" })
      c.set("member", { session: { id: "member_a", userId: "member_a", organizationId: who.organization.id, tokens: { accessToken: "test", expiresAt: Date.now() + 60000 }, createdAt: Date.now() }, accessToken: "test", den: who })
      await next()
    } })
    const path = "/v1/workbot/documents/v1/documents/google-drive/files/clip_1/content?connectionId=google-workspace"
    const response = await app.request(`http://localhost:3090${path}`, { headers: { range: "bytes=100-" } })
    assert.equal(response.status, 206)
    assert.equal(await response.text(), "abcdefgh")
    assert.deepEqual(Object.fromEntries(["content-type", "content-length", "content-range", "accept-ranges", "x-content-type-options", "content-security-policy", "cache-control"].map(name => [name, response.headers.get(name)])), {
      "content-type": "video/mp4", "content-length": "8", "content-range": "bytes 100-107/5000", "accept-ranges": "bytes",
      "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cache-control": "no-store",
    })
    assert.deepEqual(asked, [{ url: path, range: "bytes=100-", authorization: "Bearer test" }])
    assert.equal((await app.request(`http://localhost:3090${path}`, { headers: { range: "bytes=100-", "x-test-documents": "off" } })).status, 403)
    assert.equal(asked.length, 1, "with Documents off nothing is asked of Den")
  } finally { await new Promise(resolve => server.close(resolve)) }
})
