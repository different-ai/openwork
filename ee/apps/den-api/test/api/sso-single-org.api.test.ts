import assert from "node:assert/strict"
import { after, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, text, summary } from "./harness.js"

const den = await bootDen({ env: { DEN_ORG_MODE: "single_org", DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: "true" } })
after(() => den.close())

test("single-organization deployments ignore per-organization proof checks even if the flag is set", async () => {
  const owner = await den.signUp("Single Owner")
  const org = await den.request(owner.token, "GET", "/v1/org")
  assert.equal(org.status, 200, summary(org))
  const orgId = text(field(org.body, "organization", "id"), "single org id")
  const { client } = await import("../../src/db.js")
  if (!("getConnection" in client)) throw new Error("needs MySQL")
  await den.setFeature(orgId, "ssoPerOrganization", true)
  const providerId = `sso-${createDenTypeId("ssoProvider")}`
  await client.execute("INSERT INTO sso_provider (id, issuer, domain, user_id, provider_id, organization_id, domain_verified) VALUES (?, ?, ?, ?, ?, ?, 1)", [createDenTypeId("ssoProvider"), "https://synthetic-idp.example", "single.example", owner.userId, providerId, orgId])
  await client.execute("INSERT INTO sso_connection (id, organization_id, provider_id, kind, issuer, domain, status, sign_in_path) VALUES (?, ?, ?, 'oidc', ?, ?, 'enabled', ?)", [createDenTypeId("ssoConnection"), orgId, providerId, "https://synthetic-idp.example", "single.example", "/sso/single-test"])
  const changed = await den.as(owner, orgId)("PATCH", "/v1/org", { requireSso: true })
  assert.equal(changed.status, 200, summary(changed))
})
