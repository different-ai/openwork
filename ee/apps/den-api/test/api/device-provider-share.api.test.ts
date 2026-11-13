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


test("an owner learns which keys on their device one confirmation can share, and a member learns who can", { timeout: 60_000 }, async () => {

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
    name: "OpenAI", providerId: "openai", credential: { kind: "api_key", secret: DEVICE_KEY }, allMembers: true, shareFromDevice: true,
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

test("parallel device shares and retries never duplicate a provider; ordinary creation is unchanged", { timeout: 60_000 }, async () => {
  const workspace = await den.createOrg(await den.signUp("Taylor Owner"), "Concurrent share workspace");
  const call = den.as(workspace.owner, workspace.orgId);
  const input = { name: "OpenAI", providerId: "openai", credential: { kind: "api_key", secret: DEVICE_KEY }, allMembers: true, shareFromDevice: true };
  const parallel = await Promise.all([call("POST", "/v1/inference-providers", input), call("POST", "/v1/inference-providers", input)]);
  assert.deepEqual(parallel.map((result) => result.status).sort(), [201, 409], parallel.map(summary).join("\n"));
  const retried = await call("POST", "/v1/inference-providers", input);
  assert.equal(retried.status, 409, summary(retried));
  assert.equal(field(retried.body, "error"), "already_shared");
  const catalog = await call("GET", "/v1/inference-providers?scope=manageable");
  assert.equal(list(field(catalog.body, "inferenceProviders")).length, 1);
  const ordinary = await call("POST", "/v1/inference-providers", { name: "Separate configuration", providerId: "openai" });
  assert.equal(ordinary.status, 201, summary(ordinary));

});

test("an admin who is not the owner can share; demoting them to member locks it again", { timeout: 60_000 }, async () => {
  const workspace = await den.createOrg(await den.signUp("Casey Owner"), "Role workspace");

  const admin = await den.newMember(workspace.owner, workspace.orgId, "Drew Admin", "admin");
  const adminCall = den.as(admin, workspace.orgId);
  const adminOptions = await adminCall("GET", `${OPTIONS}?providerIds=anthropic`);
  assert.equal(adminOptions.status, 200, summary(adminOptions));
  assert.equal(field(adminOptions.body, "canShare"), true);
  assert.deepEqual(list(field(adminOptions.body, "providers")), [{ providerId: "anthropic", name: "Anthropic", status: "shareable" }]);
  const shared = await adminCall("POST", "/v1/inference-providers", { name: "Anthropic", providerId: "anthropic", credential: { kind: "api_key", secret: DEVICE_KEY }, allMembers: true, shareFromDevice: true });
  assert.equal(shared.status, 201, summary(shared));
  const demoted = await den.as(workspace.owner, workspace.orgId)("POST", `/v1/members/${admin.memberId}/role`, { role: "member" });
  assert.equal(demoted.status, 200, summary(demoted));
  // A role change ends the person's sessions; they sign in again as a member.
  assert.equal((await adminCall("GET", `${OPTIONS}?providerIds=openai`)).status, 401);
  const again = await den.signIn(admin.email);
  assert.equal(again.status, 200, summary(again));
  const token = field(again.body, "token");
  assert.equal(typeof token, "string");
  if (typeof token !== "string") throw new Error("expected a session token");
  const memberCall = den.as({ ...admin, token }, workspace.orgId);
  const after = await memberCall("GET", `${OPTIONS}?providerIds=openai`);
  assert.deepEqual(after.body, { canShare: false, blocker: "no_permission", managerName: "Casey Owner", verificationRequired: false, providers: [] });
  const refused = await memberCall("POST", "/v1/inference-providers", { name: "OpenAI", providerId: "openai", credential: { kind: "api_key", secret: DEVICE_KEY }, allMembers: true, shareFromDevice: true });
  assert.equal(refused.status, 403, summary(refused));
  // The demoted person still receives what the organization shares with Everyone.
  const usable = await memberCall("GET", "/v1/inference-providers?scope=usable");
  assert.deepEqual(list(field(usable.body, "inferenceProviders")).map((provider) => provider.providerId), ["anthropic"]);
  assert.ok(!JSON.stringify(usable.body).includes(DEVICE_KEY));
});
