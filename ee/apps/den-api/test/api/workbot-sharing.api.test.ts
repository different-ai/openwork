import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable } from "@openwork-ee/den-db/schema"
import { sessionTokenDigest } from "../../src/session-token.js"
import { bootDen, field, list, summary } from "./harness.js"

const den = await bootDen()
after(() => den.close())

test("Workbot has no link-only sharing while real invitations keep their access checks", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Invitation Owner"), "Invitation workspace")
  const member = await den.newMember(owner, orgId, "Workspace Member")
  const token = await den.mintMcpToken(member, orgId)
  // Old rollout settings are accepted and ignored, not repurposed as invitation permission.
  assert.equal((await den.setFeature(orgId, "workbotSharing", true)).status, 200)
  const session = await den.request(token, "GET", "/v1/workbot/session")
  assert.equal(session.status, 200, summary(session))
  assert.equal(field(session.body, "shareWorkbot"), undefined)

  const email = `coworker+${den.stamp}@example.test`
  const body = { email, role: "member" }
  const tokenInvite = await den.request(token, "POST", "/v1/invitations", { orgId, body })
  assert.equal(tokenInvite.status, 401, summary(tokenInvite))
  const noEndpoint = await den.request(token, "POST", "/v1/workbot/invitations", { orgId, body })
  assert.ok(noEndpoint.status >= 400, summary(noEndpoint))
  const noPermission = await den.as(member, orgId)("POST", "/v1/invitations", body)
  assert.equal(noPermission.status, 403, summary(noPermission))
  assert.equal(field(noPermission.body, "requiredPermission"), "invitations.manage")

  const invited = await den.as(owner, orgId)("POST", "/v1/invitations", body)
  assert.equal(invited.status, 201, summary(invited))
  assert.equal(typeof field(invited.body, "invitationId"), "string")
  assert.equal(typeof field(invited.body, "inviteToken"), "string")
  const outbox = await den.request(owner.token, "GET", "/v1/dev/emails?template=organizationInvite")
  assert.equal(outbox.status, 200, summary(outbox))
  assert.equal(list(field(outbox.body, "emails")).filter(message => message.to === email).length, 1)

  // Arrangement changes only this throwaway database's real session timestamp; tokens are hashed at rest.
  const { db } = await import("../../src/db.js")
  const [aged] = await db.update(AuthSessionTable).set({ createdAt: new Date(Date.now() - 3 * 60 * 60_000) }).where(eq(AuthSessionTable.token, sessionTokenDigest(owner.token)))
  assert.equal(aged.affectedRows, 1, "the owner's actual session must be stale before testing fresh-auth denial")
  const stale = await den.as(owner, orgId)("POST", "/v1/invitations", { email: `other+${den.stamp}@example.test`, role: "member" })
  assert.equal(stale.status, 403, summary(stale))
  assert.equal(field(stale.body, "reason"), "fresh_auth_required")
  const stillAvailable = await den.request(token, "GET", "/v1/workbot/session")
  assert.equal(stillAvailable.status, 200, summary(stillAvailable))
  assert.equal(field(stillAvailable.body, "shareWorkbot"), undefined)
})
