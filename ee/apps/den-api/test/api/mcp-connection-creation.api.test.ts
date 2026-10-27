import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const { client } = await import("../../src/db.js")
if (!("getConnection" in client)) throw new Error("connection creation tests need MySQL")
const { orgId, owner } = await den.createOrg(await den.signUp("Connection Owner"), "Connection creation")
const teammate = await den.newMember(owner, orgId, "Connection Teammate")
const ownerApi = den.as(owner, orgId)
const memberApi = den.as(teammate, orgId)

function connection(name: string) {
  return { name, url: "https://mcp.example.test/mcp", authType: "oauth", credentialMode: "per_member", access: { orgWide: true } }
}

test("concurrent connection creations each save exactly one connection and its intended access", async () => {
  // Widen the overlapping write window on real MySQL, including when the
  // database is empty. The former DELETE-before-INSERT path deadlocks here.
  await client.query("CREATE TRIGGER slow_mcp_grant BEFORE INSERT ON external_mcp_connection_access_grant FOR EACH ROW DO SLEEP(0.05)")
  try {
    const inputs = Array.from({ length: 12 }, (_, index) => ({
      ...connection(`Concurrent connection ${index}`),
      externalKey: `concurrent-${index}`,
      access: index % 2 === 0 ? { orgWide: true } : { orgWide: false, memberIds: [owner.memberId] },
    }))
    const results = await Promise.all(inputs.map((input) => ownerApi("POST", "/v1/mcp-connections", input)))
    for (const result of results) assert.equal(result.status, 200, summary(result))
    const ids = results.map((result) => text(field(result.body, "id"), "connection id"))
    assert.equal(new Set(ids).size, inputs.length)

    const ownerList = await ownerApi("GET", "/v1/mcp-connections?scope=manageable")
    assert.equal(ownerList.status, 200, summary(ownerList))
    const saved = list(field(ownerList.body, "connections"))
    const memberList = await memberApi("GET", "/v1/mcp-connections")
    assert.equal(memberList.status, 200, summary(memberList))
    const visible = list(field(memberList.body, "connections"))
    const [grantRows] = await client.query("SELECT external_mcp_connection_id AS connection_id, COUNT(*) AS grant_count FROM external_mcp_connection_access_grant WHERE organization_id = ? GROUP BY external_mcp_connection_id", [orgId])
    for (const [index, input] of inputs.entries()) {
      assert.equal(saved.filter((row) => row.externalKey === input.externalKey).length, 1)
      const savedConnection = saved.find((row) => row.id === ids[index])
      assert.equal(field(savedConnection, "access", "orgWide"), input.access.orgWide)
      assert.deepEqual(field(savedConnection, "access", "memberIds"), input.access.orgWide ? [] : [owner.memberId])
      assert.deepEqual(field(savedConnection, "access", "teamIds"), [])
      assert.equal(Number(list(grantRows).find((row) => row.connection_id === ids[index])?.grant_count), 1)
      assert.equal(visible.some((row) => row.id === ids[index]), input.access.orgWide)
    }
  } finally {
    await client.query("DROP TRIGGER slow_mcp_grant")
  }
})

test("a rejected initial grant leaves no saved connection or reserved external key", async () => {
  const input = { ...connection("Rejected grant"), externalKey: "retry-after-rejected-grant" }
  await client.query("CREATE TRIGGER reject_mcp_grant BEFORE INSERT ON external_mcp_connection_access_grant FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'test grant rejected'")
  try {
    const rejected = await ownerApi("POST", "/v1/mcp-connections", input)
    assert.equal(rejected.status, 500, summary(rejected))
    const listed = await ownerApi("GET", "/v1/mcp-connections?scope=manageable")
    assert.equal(listed.status, 200, summary(listed))
    assert.equal(list(field(listed.body, "connections")).some((row) => row.externalKey === input.externalKey), false)
  } finally {
    await client.query("DROP TRIGGER reject_mcp_grant")
  }
  const retry = await ownerApi("POST", "/v1/mcp-connections", input)
  assert.equal(retry.status, 200, summary(retry))
})
