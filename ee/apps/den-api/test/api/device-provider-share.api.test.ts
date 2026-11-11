/**
 * Sharing a key saved on a person's device with their organization (feature shareDeviceProvider):
 * Den says what the caller may share, and the existing create route makes the provider everyone can use.
 * The public model catalog is synthetic; no key is ever read back.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable } from "@openwork-ee/den-db/schema"
import { gatewayFixtureEnv } from "./gateway-fixture.js"
import { bootDen, field, list, summary } from "./harness.js"

const DEVICE_KEY = "sk-device-fixture-key-0001"

const den = await bootDen({ env: gatewayFixtureEnv })
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url !== "https://models.openworklabs.com/api.json") return realFetch(input, init)
  const model = { id: "fixture-model", name: "Fixture model", limit: { context: 100000, output: 1000 } }
  return Response.json({
    openai: { id: "openai", name: "OpenAI", npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"], api: "https://api.openai.com/v1", models: { "fixture-model": model } },
    anthropic: { id: "anthropic", name: "Anthropic", npm: "@ai-sdk/anthropic", env: ["ANTHROPIC_API_KEY"], models: { "fixture-model": model } },
    // Needs a resource name a person chooses, so one key is not enough.
    azure: { id: "azure", name: "Azure", npm: "@ai-sdk/azure", env: ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"], models: { "fixture-model": model } },
    // No AI Gateway adapter.
    groq: { id: "groq", name: "Groq", npm: "@ai-sdk/groq", env: ["GROQ_API_KEY"], models: { "fixture-model": model } },
  })
}
after(async () => { globalThis.fetch = realFetch; await den.close() })
const { db } = await import("../../src/db.js")

const OPTIONS = "/v1/inference-providers/device-share-options"
const org = await den.createOrg(await den.signUp("Avery Owner"), "Acme")
const owner = den.as(org.owner, org.orgId)
const member = await den.newMember(org.owner, org.orgId, "Riley Member")
const memberCall = den.as(member, org.orgId)

test("with the feature off the options route answers 404 feature_disabled", { timeout: 60_000 }, async () => {
  const response = await owner("GET", `${OPTIONS}?providerIds=openai`)
  assert.equal(response.status, 404, summary(response))
  assert.equal(field(response.body, "error"), "feature_disabled")
})

test("an owner learns which keys on their device one confirmation can share, and a member learns who can", { timeout: 60_000 }, async () => {
  const enabled = await den.setFeature(org.orgId, "shareDeviceProvider", true)
  assert.equal(enabled.status, 200, summary(enabled))

  const options = await owner("GET", `${OPTIONS}?providerIds=openai,anthropic,azure,groq,not-a-provider,openai`)
  assert.equal(options.status, 200, summary(options))
  assert.equal(field(options.body, "canShare"), true)
  assert.equal(field(options.body, "blocker"), null)
  assert.equal(field(options.body, "verificationRequired"), false, "the owner just signed in")
  assert.deepEqual(list(field(options.body, "providers")), [
    { providerId: "openai", name: "OpenAI", status: "shareable" },
    { providerId: "anthropic", name: "Anthropic", status: "shareable" },
    { providerId: "azure", name: "Azure", status: "unsupported" },
    { providerId: "groq", name: "Groq", status: "unsupported" },
    { providerId: "not-a-provider", name: "not-a-provider", status: "unsupported" },
  ], "one answer per provider, in order, repeats dropped")

  // A member cannot share: no provider detail, and the owner's name so the app can say who can.
  const memberOptions = await memberCall("GET", `${OPTIONS}?providerIds=openai`)
  assert.equal(memberOptions.status, 200, summary(memberOptions))
  assert.deepEqual(memberOptions.body, { canShare: false, blocker: "no_permission", managerName: "Avery Owner", verificationRequired: false, providers: [] })

  // Before sharing, the member has no organization provider.
  const before = await memberCall("GET", "/v1/inference-providers?scope=usable")
  assert.deepEqual(list(field(before.body, "inferenceProviders")), [])

  // What the desktop's own server sends after the person confirms: the provider, the key and everyone.
  const shared = await owner("POST", "/v1/inference-providers", {
    name: "OpenAI", providerId: "openai", credential: { kind: "api_key", secret: DEVICE_KEY }, allMembers: true,
  })
  assert.equal(shared.status, 201, summary(shared))
  assert.ok(!JSON.stringify(shared.body).includes(DEVICE_KEY), "the key never comes back")

  // The member now has it, through AI Gateway, without the upstream key.
  const after = await memberCall("GET", "/v1/inference-providers?scope=usable")
  assert.equal(after.status, 200, summary(after))
  const usable = list(field(after.body, "inferenceProviders"))
  assert.deepEqual(usable.map((provider) => [provider.providerId, provider.name, provider.credentialStatus]), [["openai", "OpenAI", "ready"]])
  assert.ok(!JSON.stringify(after.body).includes(DEVICE_KEY))

  // Asking again reports it shared, so the app never offers a duplicate.
  const again = await owner("GET", `${OPTIONS}?providerIds=openai,anthropic`)
  assert.deepEqual(list(field(again.body, "providers")), [
    { providerId: "openai", name: "OpenAI", status: "shared", sharedAs: "OpenAI" },
    { providerId: "anthropic", name: "Anthropic", status: "shareable" },
  ])
})

test("an older sign-in is told verification comes first", { timeout: 60_000 }, async () => {
  const other = await den.createOrg(await den.signUp("Jordan Owner"), "Borealis")
  const enabled = await den.setFeature(other.orgId, "shareDeviceProvider", true)
  assert.equal(enabled.status, 200, summary(enabled))
  await db.update(AuthSessionTable).set({ createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) }).where(eq(AuthSessionTable.userId, other.owner.userId))
  const call = den.as(other.owner, other.orgId)
  const options = await call("GET", `${OPTIONS}?providerIds=openai`)
  assert.equal(options.status, 200, summary(options))
  assert.equal(field(options.body, "canShare"), true)
  assert.equal(field(options.body, "verificationRequired"), true)
  const refused = await call("POST", "/v1/inference-providers", { name: "OpenAI", providerId: "openai", credential: { kind: "api_key", secret: DEVICE_KEY }, allMembers: true })
  assert.equal(refused.status, 403, summary(refused))
  assert.equal(field(refused.body, "error"), "reauth")
})

test("sharing grants never cross organizations and a member cannot upload a device key", { timeout: 60_000 }, async () => {
  const denied = await memberCall("POST", "/v1/inference-providers", {
    name: "Not mine to share", providerId: "anthropic", credential: { kind: "api_key", secret: DEVICE_KEY }, allMembers: true,
  });
  assert.equal(denied.status, 403, summary(denied));
  const other = await den.createOrg(await den.signUp("Morgan Owner"), "Other workspace");
  assert.equal((await den.setFeature(other.orgId, "shareDeviceProvider", true)).status, 200);
  const otherCall = den.as(other.owner, other.orgId);
  const options = await otherCall("GET", `${OPTIONS}?providerIds=openai`);
  assert.equal(options.status, 200, summary(options));
  assert.deepEqual(list(field(options.body, "providers")), [{ providerId: "openai", name: "OpenAI", status: "shareable" }], "the first organization's existing OpenAI provider cannot leak into this one");
  const catalog = await otherCall("GET", "/v1/inference-providers?scope=usable");
  assert.deepEqual(list(field(catalog.body, "inferenceProviders")), []);
  const foreign = await den.request(member.token, "GET", `${OPTIONS}?providerIds=openai`, { orgId: other.orgId });
  assert.ok(foreign.status === 403 || foreign.status === 404, summary(foreign));
  assert.ok(!JSON.stringify(foreign.body).includes(DEVICE_KEY));
});
