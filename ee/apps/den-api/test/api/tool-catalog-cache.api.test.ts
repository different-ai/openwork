import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, startFakeMcpServer, summary, text } from "./harness.js"

const den = await bootDen()
let failDiscovery = false
const service = await startFakeMcpServer({
  tools: [{ name: "read_report", description: "Read the current report", text: "The report is unchanged." }],
  decide: ({ path, rpcMethod }) => path.startsWith("/unavailable") && rpcMethod === "tools/list" && failDiscovery
    ? { reply: false, status: 503 }
    : { reply: true },
})
after(async () => {
  await service.close()
  await den.close()
})

test("catalog reuse preserves provider results, shares in-flight discovery and keeps member and access boundaries", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Report owner"), "Tool cache regression")
  const teammate = await den.newMember(owner, orgId, "Report teammate")
  const ownerToken = await den.mintMcpToken(owner, orgId)
  const teammateToken = await den.mintMcpToken(teammate, orgId)
  const connection = async (path: string, orgWide: boolean) => {
    const result = await den.as(owner, orgId)("POST", "/v1/mcp-connections", {
      name: `Report ${path}`, url: `${service.url}${path}/mcp`, authType: "none", credentialMode: "shared",
      access: { orgWide, ...(!orgWide ? { memberIds: [owner.memberId] } : {}) },
    })
    assert.equal(result.status, 200, summary(result))
    return text(field(result.body, "id"), "connection id")
  }
  const calls = (path: string, rpcMethod: string) => service.wire.filter(entry => entry.path.startsWith(path) && entry.rpcMethod === rpcMethod).length
  const call = (token: string, connectionId: string, tool = "read_report") => den.callMcpTool(token, "execute_capability", { name: `mcp:${connectionId}:${tool}`, body: {} })
  const succeeds = (result: Awaited<ReturnType<typeof call>>) => {
    assert.equal(result.status, 200)
    assert.equal(result.isError, false, result.raw.slice(0, 300))
    assert.equal(result.rpcError, null)
    assert.ok(result.raw.includes("The report is unchanged."))
  }

  const shared = await connection("/shared", true)
  const before = calls("/shared", "tools/list")
  const concurrent = await Promise.all([call(ownerToken, shared), call(ownerToken, shared), call(ownerToken, shared)])
  concurrent.forEach(succeeds)
  assert.equal(calls("/shared", "tools/list") - before, 1, "concurrent calls share one discovery")
  assert.equal(calls("/shared", "tools/call"), 3, "all three calls still reach the provider")
  succeeds(await call(ownerToken, shared))
  assert.equal(calls("/shared", "tools/list") - before, 1, "the successful catalog is reused")
  succeeds(await call(teammateToken, shared))
  assert.equal(calls("/shared", "tools/list") - before, 2, "another member gets their own catalog")

  const providerCalls = calls("/shared", "tools/call")
  const unknown = await call(ownerToken, shared, "missing_report")
  assert.equal(unknown.isError, true)
  assert.equal(calls("/shared", "tools/call"), providerCalls, "an unknown tool is never forwarded")
  assert.ok(calls("/shared", "tools/list") - before >= 3, "an unknown cached tool refreshes discovery")

  const unavailable = await connection("/unavailable", true)
  failDiscovery = true
  const failed = await call(ownerToken, unavailable)
  assert.equal(failed.isError, true, "a failed discovery cannot manufacture a successful tool call")
  failDiscovery = false
  succeeds(await call(ownerToken, unavailable))

  const privateConnection = await connection("/private", false)
  succeeds(await call(ownerToken, privateConnection))
  const beforeDenied = calls("/private", "tools/list") + calls("/private", "tools/call")
  assert.equal((await call(teammateToken, privateConnection)).isError, true)
  assert.equal(calls("/private", "tools/list") + calls("/private", "tools/call"), beforeDenied, "another member cannot use the owner's cached catalog to reach a private provider")

  const outsider = await den.createOrg(await den.signUp("Other owner"), "Other organization")
  const outsiderToken = await den.mintMcpToken(outsider.owner, outsider.orgId)
  assert.equal((await call(outsiderToken, privateConnection)).isError, true)
  assert.equal(calls("/private", "tools/list") + calls("/private", "tools/call"), beforeDenied, "another organization cannot reuse a cached catalog")
})
