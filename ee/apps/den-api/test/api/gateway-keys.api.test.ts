/**
 * Gateway keys: every member of an organization gets exactly one active key, even when several people join the
 * organization at the same moment and their keys are issued concurrently.
 */
import assert from "node:assert/strict"
import diagnosticsChannel from "node:diagnostics_channel"
import { after, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const { client } = await import("../../src/db.js")
const { ensureMemberGatewayKey } = await import("../../src/gateway-keys.js")

test("people joining one organization at the same moment each get exactly one key", async () => {
  const owner = await den.signUp("Key Owner")
  const { orgId } = await den.createOrg(owner, "Concurrent keys")
  // ARRANGE ONLY: membership rows as a join commits them, before any key exists. Deleting issued keys would
  // not do: InnoDB keeps the deleted index entries until purge, and those mask the shared gap a new key takes.
  const memberIds: string[] = []
  for (const name of ["Key Ana", "Key Ben", "Key Cy", "Key Dee", "Key Eve", "Key Fay", "Key Gus", "Key Hal"]) {
    const memberId = createDenTypeId("member")
    await client.execute("INSERT INTO member (id, organization_id, user_id, role, joined_at) VALUES (?, ?, ?, 'member', NOW(3))", [memberId, orgId, (await den.signUp(name)).userId])
    memberIds.push(memberId)
  }

  const keys = await Promise.all(memberIds.map((memberId) => ensureMemberGatewayKey({ organizationId: orgId as never, memberId: memberId as never })))
  assert.equal(new Set(keys).size, memberIds.length, "every member gets a distinct key")
  const [rows] = await client.execute(
    `SELECT org_membership_id, COUNT(*) AS total FROM gateway_keys WHERE status = 'active' AND revoked_at IS NULL AND org_membership_id IN (${memberIds.map(() => "?").join(", ")}) GROUP BY org_membership_id`,
    memberIds,
  ) as unknown as [Array<{ org_membership_id: string; total: number }>]
  assert.deepEqual(rows.map((row) => [row.org_membership_id, Number(row.total)]).sort(), memberIds.map((id) => [id, 1]).sort())
  // Asking again returns the same key rather than issuing another.
  assert.equal(await ensureMemberGatewayKey({ organizationId: orgId as never, memberId: memberIds[0] as never }), keys[0])
})

/** Every statement sent to MySQL while `run` executes. */
async function statementsDuring(run: () => Promise<unknown>) {
  const statements: string[] = []
  const record = (message: unknown) => { statements.push(String((message as { query?: unknown }).query ?? "")) }
  const channels = [diagnosticsChannel.tracingChannel("mysql2:query"), diagnosticsChannel.tracingChannel("mysql2:execute")]
  for (const channel of channels) channel.subscribe({ start: record })
  try {
    await run()
  } finally {
    for (const channel of channels) channel.unsubscribe({ start: record })
  }
  return statements
}

test("an existing key is returned from one read, without locking the member", async () => {
  const owner = await den.signUp("Key Reader")
  const { orgId } = await den.createOrg(owner, "Key reads")
  const memberId = createDenTypeId("member")
  await client.execute("INSERT INTO member (id, organization_id, user_id, role, joined_at) VALUES (?, ?, ?, 'member', NOW(3))", [memberId, orgId, (await den.signUp("Key Ida")).userId])
  const input = { organizationId: orgId as never, memberId: memberId as never }
  const key = await ensureMemberGatewayKey(input)

  let again = ""
  const statements = await statementsDuring(async () => { again = await ensureMemberGatewayKey(input) })
  assert.equal(again, key)
  assert.equal(statements.length, 1, statements.join("\n"))
  assert.doesNotMatch(statements[0], /for update/i)
})

test("a revoked key or a removed member still goes through the member lock", async () => {
  const owner = await den.signUp("Key Fence")
  const { orgId } = await den.createOrg(owner, "Key fence")
  const memberId = createDenTypeId("member")
  await client.execute("INSERT INTO member (id, organization_id, user_id, role, joined_at) VALUES (?, ?, ?, 'member', NOW(3))", [memberId, orgId, (await den.signUp("Key Jo")).userId])
  const input = { organizationId: orgId as never, memberId: memberId as never }
  const key = await ensureMemberGatewayKey(input)

  await client.execute("UPDATE gateway_keys SET status = 'revoked', revoked_at = NOW(3) WHERE org_membership_id = ?", [memberId])
  let rotated = ""
  const statements = await statementsDuring(async () => { rotated = await ensureMemberGatewayKey(input) })
  assert.notEqual(rotated, key, "a revoked key is replaced")
  assert.ok(statements.some((statement) => /for update/i.test(statement)), "replacing a key takes the member lock")

  await client.execute("UPDATE member SET removed_at = NOW(3) WHERE id = ?", [memberId])
  await assert.rejects(ensureMemberGatewayKey(input), /member_not_found/, "a removed member's active key is never handed out")
})
