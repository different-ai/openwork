import assert from "node:assert/strict"
import { after, test } from "node:test"
import { createServer } from "node:http"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { once } from "node:events"
import { bootDen, field, list, summary } from "./harness.js"

const den = await bootDen({ env: { DEN_WORKBOT_URL: "http://localhost:4200" } })
after(() => den.close())

test("saving connector choices with a cold tool cache makes no provider requests and persists each batch", async () => {
  let calls = 0
  const provider = createServer((_request, response) => {
    calls++
    response.writeHead(503).end()
  })
  provider.listen(0, "127.0.0.1")
  await once(provider, "listening")
  try {
    const address = provider.address()
    assert.ok(address && typeof address !== "string")
    const { owner, orgId } = await den.createOrg(await den.signUp("Workspace Owner"), "Connector choices")
    const call = den.as(owner, orgId)
    const { createExternalMcpConnection } = await import("../../src/capability-sources/external-mcp-connections.js")
    const { listMemberConnections } = await import("../../src/workbot-proactive/sources-repository.js")
    const { countDbQueries } = await import("../../src/observability/db-query-count.js")
    const organizationId = normalizeDenTypeId("organization", orgId)
    const memberId = normalizeDenTypeId("member", owner.memberId)
    const inventoryQueries = async () => {
      const queries = { count: 0 }
      await countDbQueries(queries, () => listMemberConnections({ organizationId, memberId }))
      return queries.count
    }
    const ids: string[] = []
    let oneConnectorQueries = 0
    for (let i = 0; i < 23; i++) {
      const row = await createExternalMcpConnection({
        organizationId, createdByOrgMembershipId: memberId,
        name: `Notes ${i + 1}`, url: `http://127.0.0.1:${address.port}/${i}`,
        authType: "none", credentialMode: "shared", access: { orgWide: true, memberIds: [], teamIds: [] },
      })
      ids.push(row.id)
      if (i === 0) oneConnectorQueries = await inventoryQueries()
    }
    assert.ok(oneConnectorQueries > 0)
    assert.ok(await inventoryQueries() <= oneConnectorQueries, "adding connectors must not add inventory queries")
    const before = calls
    const initial = await call("GET", "/v1/me/agent?toolCounts=cached")
    assert.equal(initial.status, 200, summary(initial))
    assert.equal(list(field(initial.body, "sources")).filter((row) => row.kind === "other").length, ids.length)
    assert.equal(calls, before)
    const save = async (selected: string[], on: boolean) => {
      const reply = await call("PUT", "/v1/me/agent", { sources: selected.map((source) => ({ source, on })) })
      assert.equal(reply.status, 200, summary(reply))
      return list(field(reply.body, "sources")).filter((row) => row.kind === "other" && row.on).map((row) => row.id).sort()
    }
    assert.deepEqual(await save(ids.slice(0, 20), true), ids.slice(0, 20).sort())
    assert.deepEqual(await save(ids.slice(20), true), [...ids].sort())
    assert.deepEqual(await save([ids[0]], false), ids.slice(1).sort())
    // Set DEN_BENCH_CONNECTOR_SAVES=1 to compare Den's request duration and db_queries logs.
    if (process.env.DEN_BENCH_CONNECTOR_SAVES === "1") {
      for (let round = 0; round < 30; round++) {
        if (round === 10) console.info("begin measured connector saves")
        for (const [method, on] of [["PUT", true], ["PATCH", false], ["PATCH", true], ["PUT", false]] as const) {
          const path = method === "PUT" ? "/v1/me/agent" : "/v1/me/agent/connectors"
          const response = await call(method, path, { sources: [{ source: ids[0], on }] })
          assert.equal(response.status, 200, summary(response))
          assert.equal(list(field(response.body, "sources")).find((source) => source.id === ids[0])?.on, on)
        }
      }
      console.info("end measured connector saves")
    }
    const compact = await call("PATCH", "/v1/me/agent/connectors", { sources: [{ source: ids[0], on: true }] })
    assert.equal(compact.status, 200, summary(compact))
    assert.deepEqual(list(field(compact.body, "sources")).map((row) => [row.id, row.on]), [[ids[0], true]])
    assert.equal(field(compact.body, "todayChecks"), undefined)
    const undoId = list(field(compact.body, "changes"))[0]?.id
    assert.equal(typeof undoId, "string")
    const repeated = await call("PATCH", "/v1/me/agent/connectors", { sources: [{ source: ids[0], on: true }] })
    assert.equal(repeated.status, 200, summary(repeated))
    assert.deepEqual(field(repeated.body, "changes"), [])
    const undone = await call("PUT", "/v1/me/agent", { undo: undoId })
    assert.equal(undone.status, 200, summary(undone))
    assert.equal(list(field(undone.body, "sources")).find((row) => row.id === ids[0])?.on, false)
    assert.equal(calls, before)
    const reloaded = await call("GET", "/v1/me/agent")
    assert.equal(reloaded.status, 200, summary(reloaded))
    assert.deepEqual(list(field(reloaded.body, "sources")).filter((row) => row.kind === "other" && row.on).map((row) => row.id).sort(), ids.slice(1).sort())
    const policy = await call("PUT", "/v1/org/workbot-settings/proactive", {
      sources: { connections: { [ids[0]]: "off", [ids[1]]: "everyone" } },
    })
    assert.equal(policy.status, 200, summary(policy))
    for (const [source, on, error] of [[ids[0], true, "source_not_allowed"], [ids[1], false, "source_locked"]] as const) {
      const refused = await call("PATCH", "/v1/me/agent/connectors", { sources: [{ source, on }] })
      assert.equal(refused.status, 400, summary(refused))
      assert.equal(field(refused.body, "error"), error)
    }
  } finally {
    provider.closeAllConnections()
    await new Promise<void>((resolve) => provider.close(() => resolve()))
  }
})

test("the batched inventory keeps grants and connected accounts scoped to each member", async () => {
  const { owner, orgId } = await den.createOrg(await den.signUp("Source Owner"), "Source access")
  const colleague = await den.newMember(owner, orgId, "Workspace Member")
  const organizationId = normalizeDenTypeId("organization", orgId)
  const ownerId = normalizeDenTypeId("member", owner.memberId)
  const { createExternalMcpConnection } = await import("../../src/capability-sources/external-mcp-connections.js")
  const { upsertConnectedAccount } = await import("../../src/capability-sources/oauth-credentials.js")
  const { listMemberConnections } = await import("../../src/workbot-proactive/sources-repository.js")
  const row = await createExternalMcpConnection({
    organizationId, createdByOrgMembershipId: ownerId, name: "Shared notes", url: "https://notes.example.test",
    authType: "oauth", credentialMode: "per_member", access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  const personal = await createExternalMcpConnection({
    organizationId, createdByOrgMembershipId: ownerId, name: "Personal notes", url: "https://personal.example.test",
    authType: "none", credentialMode: "shared", access: { orgWide: false, memberIds: [ownerId], teamIds: [] },
  })
  await upsertConnectedAccount({ organizationId, orgMembershipId: ownerId, providerId: row.id, accessToken: "fixture-notes-token" })
  const mine = await listMemberConnections({ organizationId, memberId: ownerId })
  const theirs = await listMemberConnections({ organizationId, memberId: normalizeDenTypeId("member", colleague.memberId) })
  assert.equal(mine.find((item) => item.id === row.id)?.state, "connected")
  assert.equal(theirs.find((item) => item.id === row.id)?.state, "needs_connection")
  assert.ok(mine.some((item) => item.id === personal.id))
  assert.ok(!theirs.some((item) => item.id === personal.id))
  const call = den.as(colleague, orgId)
  const refused = await call("PATCH", "/v1/me/agent/connectors", { sources: [
    { source: row.id, on: true }, { source: personal.id, on: true },
  ] })
  assert.equal(refused.status, 400, summary(refused))
  assert.equal(field(refused.body, "error"), "source_not_allowed")
  const reloaded = await call("GET", "/v1/me/agent?toolCounts=cached")
  assert.equal(reloaded.status, 200, summary(reloaded))
  assert.equal(list(field(reloaded.body, "sources")).find((source) => source.id === row.id)?.on, false)
})
