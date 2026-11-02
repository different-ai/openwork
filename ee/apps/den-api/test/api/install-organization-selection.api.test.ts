import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, summary } from "./harness.js"

const den = await bootDen({ env: { DEN_DESKTOP_RELEASES_MODE: "static" } })
after(() => den.close())

test("install organization selection supports bearer-only and cookie-only sessions for single and multiple memberships", async () => {
  const person = await den.signUp("Install Recipient")
  const first = await den.createOrg(person, "First install organization")
  const second = await den.createOrg(person, "Second install organization")
  const single = await den.createOrg(await den.signUp("Single Install Recipient"), "Only install organization")
  for (const { account, organizations } of [{ account: person, organizations: [first, second] }, { account: single.owner, organizations: [single] }]) {
    for (const organization of organizations) {
      for (const bearer of [true, false]) {
        const token = bearer ? account.token : null
        const headers = bearer ? {} : { cookie: account.cookie }
        const chosen = await den.request(token, "POST", "/v1/me/active-organization", { headers, body: { organizationId: organization.orgId } })
        assert.equal(chosen.status, 200, `${bearer ? "bearer-only" : "cookie-only"}: ${summary(chosen)}`)
        assert.equal(field(chosen.body, "activeOrgId"), organization.orgId)
        const configuration = await den.request(token, "GET", "/v1/me/install-config", { headers })
        assert.equal(configuration.status, 200, summary(configuration))
        assert.equal(field(configuration.body, "clientName"), organization === first ? "First install organization" : organization === second ? "Second install organization" : "Only install organization")
      }
    }
  }
  const refused = await den.request(person.token, "POST", "/v1/me/active-organization", { body: { organizationId: single.orgId } })
  assert.equal(refused.status, 403, summary(refused))
  const obsolete = await den.request(null, "GET", "/v1/me/install-config?token=obsolete-fixture-token")
  assert.equal(obsolete.status, 401, summary(obsolete))
})
