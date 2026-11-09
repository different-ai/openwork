/**
 * Config-blob adapters for connectors, BYOK providers, desktop policies and
 * collections: export without secrets, apply through the existing handlers
 * (keep / replace secrets, preferred ids, team references), round trip.
 *
 * Resources are created through the public API; the adapters are called
 * directly with a ConfigAreaContext, as the engine does.
 */
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, startFakeMcpServer, summary, text } from "./harness.js"

const den = await bootDen()
const mcpServer = await startFakeMcpServer({ tools: [{ name: "ping", description: "Ping", text: "pong" }] })
after(async () => {
  await mcpServer.close()
  await den.close()
})

const { db } = await import("../../src/db.js")
const { getOrganizationFeatures } = await import("../../src/features.js")
const { connectorsOAuthClientsArea } = await import("../../src/config-blobs/areas/connectors-oauth-clients.js")
const { connectorsMcpArea } = await import("../../src/config-blobs/areas/connectors-mcp.js")
const { aiGatewayByokArea } = await import("../../src/config-blobs/areas/ai-gateway-byok.js")
const { desktopPoliciesArea } = await import("../../src/config-blobs/areas/desktop-policies.js")
const { settingsCollectionsArea } = await import("../../src/config-blobs/areas/settings-collections.js")
const { eq } = await import("@openwork-ee/den-db/drizzle")
const { ExternalMcpConnectionTable, LlmProviderModelTable, LlmProviderTable, OrgOAuthClientTable } = await import("@openwork-ee/den-db/schema")

type Area = typeof connectorsMcpArea
type Item = Awaited<ReturnType<Area["exportItems"]>>[number]
type Ctx = Parameters<Area["exportItems"]>[0]
type SecretDecision = { decision: "keep" } | { decision: "unset" } | { decision: "value"; value: string }

const AREAS = [connectorsOAuthClientsArea, connectorsMcpArea, aiGatewayByokArea, desktopPoliciesArea, settingsCollectionsArea]

const SECRETS = {
  oauthClient: "goog-client-SECRET-1",
  mcpApiKey: "sk-mcp-SECRET-1",
  mcpHeader: "hdr-SECRET-value-1",
  mcpOAuthClient: "mcp-oauth-SECRET-1",
  byokKey: "sk-byok-SECRET-1",
  byokInline: "sk-inline-SECRET-1",
  byokHeader: "sk-model-header-SECRET-1",
}

const owner = await den.signUp("Config Owner")
const orgA = await den.createOrg(owner, "Config source")
const orgB = await den.createOrg(owner, "Config target")
const teammate = await den.newMember(owner, orgA.orgId, "Config Teammate")
const apiA = den.as(owner, orgA.orgId)
const teamA = await den.createTeam(owner, orgA.orgId, "Platform", [teammate.memberId])
const teamB = await den.createTeam(owner, orgB.orgId, "Platform B", [])

async function ctxFor(org: { orgId: string; owner: { userId: string; memberId: string } }): Promise<Ctx> {
  return {
    db,
    organizationId: org.orgId,
    actor: { userId: org.owner.userId, memberId: org.owner.memberId },
    deployment: "self_hosted",
    features: await getOrganizationFeatures(org.orgId),
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * What the engine hands an adapter: refs resolved (`id` added, unknown ones
 * dropped) and secret placeholders replaced by decisions.
 */
function resolve(value: unknown, refs: (ref: string) => string | null, secret: (path: string) => SecretDecision): unknown {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (isObject(entry) && typeof entry.$ref === "string") {
        const id = refs(entry.$ref)
        return id ? [{ ...entry, id }] : []
      }
      return [resolve(entry, refs, secret)]
    })
  }
  if (!isObject(value)) return value
  if (typeof value.$secret === "string") return { $secret: value.$secret, ...secret(value.$secret) }
  if (typeof value.$ref === "string") {
    const id = refs(value.$ref)
    return id ? { ...value, id } : null
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolve(entry, refs, secret)]))
}

function resolvedSpec(value: unknown, refs: (ref: string) => string | null, secret: (path: string) => SecretDecision): Record<string, unknown> {
  const spec = resolve(value, refs, secret)
  assert.ok(isObject(spec))
  return spec
}

/** Refs as they resolve in the source org: teams by id, people by email. */
function sameOrgRefs(ref: string): string | null {
  if (ref.startsWith("members.teams/")) return ref.slice("members.teams/".length)
  if (ref === `people/${owner.email.toLowerCase()}`) return orgA.owner.memberId
  if (ref === `people/${teammate.email.toLowerCase()}`) return teammate.memberId
  return null
}

/** Refs as an admin maps them in the second org: Platform → Platform B, the owner → the owner, others dropped. */
function otherOrgRefs(ref: string): string | null {
  if (ref === `members.teams/${teamA}`) return teamB
  if (ref === `people/${owner.email.toLowerCase()}`) return orgB.owner.memberId
  return null
}

const keepAll = (): SecretDecision => ({ decision: "keep" })

async function exportAll(org: typeof orgA) {
  const ctx = await ctxFor(org)
  const out = new Map<string, Item[]>()
  for (const area of AREAS) out.set(area.key, await area.exportItems(ctx))
  return out
}

function only(items: Item[] | undefined, name: string): Item {
  const item = items?.find((entry) => entry.name === name)
  assert.ok(item, `exported item ${name}`)
  return item
}

function placeholder(spec: unknown, ...path: string[]): Record<string, unknown> {
  let current: unknown = spec
  for (const key of path) current = isObject(current) ? current[key] : Array.isArray(current) ? current[Number(key)] : undefined
  assert.ok(isObject(current) && typeof current.$secret === "string", `placeholder at ${path.join(".")}`)
  return current
}

let mcpApiKeyId = ""
let byokId = ""

before(async () => {
  const client = await apiA("POST", "/v1/oauth-providers/google-workspace/client", { clientId: "goog-client-id", clientSecret: SECRETS.oauthClient })
  assert.equal(client.status, 200, summary(client))

  const apiKeyConnection = await apiA("POST", "/v1/mcp-connections", {
    name: "Docs MCP",
    externalKey: "docs-mcp",
    url: `${mcpServer.url}/mcp`,
    authType: "apikey",
    credentialMode: "shared",
    apiKey: SECRETS.mcpApiKey,
    requestHeaders: [{ name: "X-Tenant", value: SECRETS.mcpHeader }],
    access: { orgWide: false, teamIds: [teamA], memberIds: [teammate.memberId] },
  })
  assert.equal(apiKeyConnection.status, 200, summary(apiKeyConnection))
  mcpApiKeyId = text(field(apiKeyConnection.body, "id"), "connection id")

  const oauthConnection = await apiA("POST", "/v1/mcp-connections", {
    name: "Tools MCP",
    url: `${mcpServer.url}/oauth-mcp`,
    authType: "oauth",
    credentialMode: "per_member",
    oauthClient: { clientId: "tools-client", clientSecret: SECRETS.mcpOAuthClient, tokenEndpointAuthMethod: "client_secret_post" },
    manualOAuthEndpoints: { authorizationEndpoint: `${mcpServer.url}/authorize`, tokenEndpoint: `${mcpServer.url}/token` },
    requestedScopes: ["tools.read"],
    access: { orgWide: true },
  })
  assert.equal(oauthConnection.status, 200, summary(oauthConnection))

  const provider = await apiA("POST", "/v1/llm-providers", {
    name: "Acme LLM",
    source: "custom",
    customConfig: {
      id: "acme",
      name: "Acme",
      npm: "@ai-sdk/openai-compatible",
      env: ["ACME_API_KEY"],
      api: "https://llm.example.test/v1",
      options: { baseURL: "https://llm.example.test/v1", apiKey: SECRETS.byokInline },
      models: [{ id: "acme-1", name: "Acme One", limit: { context: 1000, output: 100 }, options: { headers: { Authorization: `Bearer ${SECRETS.byokHeader}` }, reasoningEffort: "low" } }],
    },
    apiKey: SECRETS.byokKey,
    teamIds: [teamA],
  })
  assert.equal(provider.status, 201, summary(provider))
  byokId = text(field(provider.body, "llmProvider", "id"), "provider id")

  const keyless = await apiA("POST", "/v1/llm-providers", {
    name: "Keyless LLM",
    source: "custom",
    customConfig: { id: "keyless", name: "Keyless", npm: "@ai-sdk/openai-compatible", env: ["KEYLESS_API_KEY"], api: "https://keyless.example.test/v1", models: [{ id: "k-1", name: "K One" }] },
    allMembers: true,
  })
  assert.equal(keyless.status, 201, summary(keyless))

  const policy = await apiA("POST", "/v1/desktop-policies", {
    policyName: "Engineering",
    policy: { execution: { commands: "allow", blockedCommands: ["rm -rf /"], blockBrowserUploads: true } },
    priority: 5,
    teamIds: [teamA],
    memberIds: [teammate.memberId],
    roles: ["admin"],
  })
  assert.equal(policy.status, 201, summary(policy))

  const marketplace = await apiA("POST", "/v1/marketplaces", { name: "Engineering tools", description: "Tools for engineers" })
  assert.ok(marketplace.status < 300, summary(marketplace))
  const marketplaceId = text(field(marketplace.body, "item", "id"), "marketplace id")
  const grant = await apiA("POST", `/v1/marketplaces/${marketplaceId}/access`, { teamId: teamA, role: "viewer" })
  assert.equal(grant.status, 201, summary(grant))
})

test("exports carry no secret values, valid specs and placeholders that say whether a value is set", async () => {
  const exported = await exportAll(orgA)
  const json = JSON.stringify([...exported.entries()])
  for (const [label, secret] of Object.entries(SECRETS)) assert.ok(!json.includes(secret), `export leaks ${label}`)
  assert.ok(!json.includes("enc:v1:"), "export contains ciphertext")
  assert.ok(!json.includes("sk-"), "export contains a key-shaped value")

  for (const area of AREAS) {
    for (const item of exported.get(area.key) ?? []) {
      const parsed = area.specSchema.safeParse(item.spec)
      assert.ok(parsed.success, `${area.key} ${item.name}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`)
    }
  }

  const oauthClient = only(exported.get("connectors.oauth-clients"), "Google Workspace")
  assert.equal(oauthClient.spec.clientId, "goog-client-id")
  assert.equal(placeholder(oauthClient.spec, "clientSecret").set, true)

  const docs = only(exported.get("connectors.mcp"), "Docs MCP")
  assert.equal(docs.key, "docs-mcp")
  assert.equal(placeholder(docs.spec, "apiKey").set, true)
  assert.equal(placeholder(docs.spec, "requestHeaders", "0", "value").set, true)
  assert.deepEqual(field(docs.spec, "access", "teams"), [{ $ref: `members.teams/${teamA}`, name: "Platform" }])
  assert.deepEqual(field(docs.spec, "access", "members"), [{ $ref: `people/${teammate.email.toLowerCase()}` }])
  const tools = only(exported.get("connectors.mcp"), "Tools MCP")
  assert.equal(field(tools.spec, "oauth", "client", "clientId"), "tools-client")
  assert.equal(field(tools.spec, "oauth", "client", "tokenEndpointAuthMethod"), "client_secret_post")
  assert.equal(placeholder(tools.spec, "oauth", "client", "clientSecret").set, true)
  assert.equal(field(tools.spec, "apiKey"), null)
  assert.equal(field(tools.spec, "access", "orgWide"), true)

  const acme = only(exported.get("ai-gateway.byok"), "Acme LLM")
  assert.equal(placeholder(acme.spec, "credentials", "apiKey").set, true)
  assert.equal(field(acme.spec, "provider", "options", "apiKey"), undefined, "inline provider credential is not exported")
  assert.deepEqual(field(acme.spec, "models"), [{ id: "acme-1", name: "Acme One", config: { limit: { context: 1000, output: 100 }, options: { reasoningEffort: "low" } } }])
  const keyless = only(exported.get("ai-gateway.byok"), "Keyless LLM")
  assert.equal(placeholder(keyless.spec, "credentials", "apiKey").set, false)
  assert.equal(field(keyless.spec, "access", "allMembers"), true)

  const policies = exported.get("desktop-policies") ?? []
  assert.equal(policies[0]?.spec.isDefault, true, "the default policy is exported first")
  const engineering = only(policies, "Engineering")
  assert.deepEqual(field(engineering.spec, "assignments", "roles"), ["admin"])
  assert.deepEqual(field(engineering.spec, "assignments", "teams"), [{ $ref: `members.teams/${teamA}`, name: "Platform" }])

  const collection = only(exported.get("settings.advanced.collections"), "Engineering tools")
  assert.deepEqual(field(collection.spec, "access", "teams", "viewer"), [{ $ref: `members.teams/${teamA}`, name: "Platform" }])
  assert.deepEqual(field(collection.spec, "access", "members", "manager"), [{ $ref: `people/${owner.email.toLowerCase()}` }])
})

test("re-applying an export into the same org with keep changes nothing and keeps every stored secret", async () => {
  const before = await exportAll(orgA)
  const ctx = await ctxFor(orgA)
  for (const area of AREAS) {
    for (const item of before.get(area.key) ?? []) {
      const spec = resolve(item.spec, sameOrgRefs, keepAll)
      assert.ok(isObject(spec))
      const result = await area.apply(ctx, { kind: "update", targetId: item.id, previous: item, item: { sourceId: item.id, key: item.key, name: item.name, spec } })
      assert.equal(result.localId, item.id, `${area.key} ${item.name}`)
    }
  }
  const afterExport = await exportAll(orgA)
  for (const area of AREAS) assert.deepEqual(afterExport.get(area.key), before.get(area.key), `${area.key} round trip`)

  const [mcp] = await db.select().from(ExternalMcpConnectionTable).where(eq(ExternalMcpConnectionTable.id, mcpApiKeyId))
  assert.equal(mcp?.apiKey, SECRETS.mcpApiKey)
  assert.ok(mcp?.requestHeaders?.includes(SECRETS.mcpHeader), "request header value kept")
  const [provider] = await db.select().from(LlmProviderTable).where(eq(LlmProviderTable.id, byokId))
  assert.equal(provider?.apiKey, SECRETS.byokKey)
  assert.equal(field(provider?.providerConfig, "options", "apiKey"), SECRETS.byokInline, "unexported provider fields are kept")
  const [client] = await db.select().from(OrgOAuthClientTable).where(eq(OrgOAuthClientTable.providerId, "google-workspace"))
  assert.equal(client?.clientSecret, SECRETS.oauthClient)
})

test("a secret given as a value replaces the stored one", async () => {
  const exported = await exportAll(orgA)
  const ctx = await ctxFor(orgA)
  const replace = (value: string) => (): SecretDecision => ({ decision: "value", value })

  const acme = only(exported.get("ai-gateway.byok"), "Acme LLM")
  await aiGatewayByokArea.apply(ctx, { kind: "update", targetId: acme.id, previous: acme, item: { key: acme.key, name: acme.name, spec: resolvedSpec(acme.spec, sameOrgRefs, replace("byok-rotated")) } })
  const [provider] = await db.select().from(LlmProviderTable).where(eq(LlmProviderTable.id, acme.id))
  assert.equal(provider?.apiKey, "byok-rotated")

  const docs = only(exported.get("connectors.mcp"), "Docs MCP")
  await connectorsMcpArea.apply(ctx, { kind: "update", targetId: docs.id, previous: docs, item: { key: docs.key, name: docs.name, spec: resolvedSpec(docs.spec, sameOrgRefs, replace("mcp-rotated")) } })
  const [mcp] = await db.select().from(ExternalMcpConnectionTable).where(eq(ExternalMcpConnectionTable.id, docs.id))
  assert.equal(mcp?.apiKey, "mcp-rotated")
  assert.ok(mcp?.requestHeaders?.includes("mcp-rotated"), "request header value replaced")
  assert.ok(mcpServer.wire.some((entry) => entry.authorization === "Bearer mcp-rotated"), "the new key was checked against the server")

  const client = only(exported.get("connectors.oauth-clients"), "Google Workspace")
  await connectorsOAuthClientsArea.apply(ctx, { kind: "update", targetId: client.id, previous: client, item: { name: client.name, spec: resolvedSpec(client.spec, sameOrgRefs, replace("goog-rotated")) } })
  const [row] = await db.select().from(OrgOAuthClientTable).where(eq(OrgOAuthClientTable.id, client.id))
  assert.equal(row?.clientSecret, "goog-rotated")
})

test("creating in another org reuses a free preferred id, resolves team references and leaves unset secrets empty", async () => {
  const exported = await exportAll(orgA)
  const ctx = await ctxFor(orgB)
  const created = new Map<string, string>()
  const createItem = async (area: Area, item: Item, preferredId: string, secret: (path: string) => SecretDecision = () => ({ decision: "unset" })) => {
    const spec = resolve(item.spec, otherOrgRefs, secret)
    assert.ok(isObject(spec))
    const result = await area.apply(ctx, { kind: "create", preferredId, item: { sourceId: item.id, key: item.key, name: item.name, spec } })
    assert.equal(result.localId, preferredId, `${area.key} ${item.name} reuses the preferred id`)
    created.set(`${area.key}:${item.name}`, result.localId)
    return result
  }

  await createItem(connectorsOAuthClientsArea, only(exported.get("connectors.oauth-clients"), "Google Workspace"), createDenTypeId("orgOAuthClient"))
  const docsResult = await createItem(connectorsMcpArea, only(exported.get("connectors.mcp"), "Docs MCP"), createDenTypeId("externalMcpConnection"),
    (path) => path.endsWith("/apiKey") ? { decision: "value", value: "mcp-in-b" } : { decision: "unset" })
  assert.ok(docsResult.warnings?.some((warning) => warning.includes("X-Tenant")), "a header without a value is reported")
  await createItem(connectorsMcpArea, only(exported.get("connectors.mcp"), "Tools MCP"), createDenTypeId("externalMcpConnection"))
  const acmeResult = await createItem(aiGatewayByokArea, only(exported.get("ai-gateway.byok"), "Acme LLM"), createDenTypeId("llmProvider"))
  assert.ok(acmeResult.warnings?.some((warning) => warning.includes("shared key")), "a provider created without its key is reported")
  await createItem(desktopPoliciesArea, only(exported.get("desktop-policies"), "Engineering"), createDenTypeId("desktopPolicy"))
  await createItem(settingsCollectionsArea, only(exported.get("settings.advanced.collections"), "Engineering tools"), createDenTypeId("marketplace"))

  const inB = await exportAll(orgB)
  const json = JSON.stringify([...inB.entries()])
  assert.ok(!json.includes("mcp-in-b"), "a value entered at import is not exported")

  const docs = only(inB.get("connectors.mcp"), "Docs MCP")
  assert.equal(docs.id, created.get("connectors.mcp:Docs MCP"))
  assert.equal(docs.key, "docs-mcp")
  assert.equal(placeholder(docs.spec, "apiKey").set, true)
  assert.deepEqual(field(docs.spec, "requestHeaders"), [])
  assert.deepEqual(field(docs.spec, "access", "teams"), [{ $ref: `members.teams/${teamB}`, name: "Platform B" }])
  assert.deepEqual(field(docs.spec, "access", "members"), [])
  const tools = only(inB.get("connectors.mcp"), "Tools MCP")
  assert.equal(placeholder(tools.spec, "oauth", "client", "clientSecret").set, false)
  assert.deepEqual(field(tools.spec, "oauth", "manualOAuthEndpoints"), field(only(exported.get("connectors.mcp"), "Tools MCP").spec, "oauth", "manualOAuthEndpoints"))

  const sourceAcme = only(exported.get("ai-gateway.byok"), "Acme LLM")
  const acme = only(inB.get("ai-gateway.byok"), "Acme LLM")
  assert.equal(placeholder(acme.spec, "credentials", "apiKey").set, false)
  assert.deepEqual(acme.spec.provider, sourceAcme.spec.provider)
  assert.deepEqual(acme.spec.models, sourceAcme.spec.models)
  assert.deepEqual(field(acme.spec, "access", "teams"), [{ $ref: `members.teams/${teamB}`, name: "Platform B" }])

  const client = only(inB.get("connectors.oauth-clients"), "Google Workspace")
  assert.equal(client.spec.clientId, "goog-client-id")
  assert.equal(placeholder(client.spec, "clientSecret").set, false)

  const sourcePolicy = only(exported.get("desktop-policies"), "Engineering")
  const policy = only(inB.get("desktop-policies"), "Engineering")
  assert.deepEqual(policy.spec.policy, sourcePolicy.spec.policy)
  assert.deepEqual(field(policy.spec, "assignments", "teams"), [{ $ref: `members.teams/${teamB}`, name: "Platform B" }])
  assert.deepEqual(field(policy.spec, "assignments", "roles"), ["admin"])

  const collection = only(inB.get("settings.advanced.collections"), "Engineering tools")
  assert.equal(collection.spec.description, "Tools for engineers")
  assert.deepEqual(field(collection.spec, "access", "teams", "viewer"), [{ $ref: `members.teams/${teamB}`, name: "Platform B" }])
})

test("the default desktop policy is matched, not duplicated, and deletes go through the handlers", async () => {
  const exported = await exportAll(orgA)
  const ctx = await ctxFor(orgB)
  const sourceDefault = (exported.get("desktop-policies") ?? []).find((item) => item.spec.isDefault === true)
  assert.ok(sourceDefault)
  const targetDefault = (await desktopPoliciesArea.exportItems(ctx)).find((item) => item.spec.isDefault === true)
  assert.ok(targetDefault)
  assert.equal(desktopPoliciesArea.naturalKeys[0]?.get(sourceDefault), desktopPoliciesArea.naturalKeys[0]?.get(targetDefault))
  assert.match(desktopPoliciesArea.protectedFromDelete?.(targetDefault, ctx) ?? "", /default/)

  const policies = await desktopPoliciesArea.exportItems(ctx)
  const engineering = only(policies, "Engineering")
  await desktopPoliciesArea.apply(ctx, { kind: "delete", targetId: engineering.id, previous: engineering })
  assert.equal((await desktopPoliciesArea.exportItems(ctx)).some((item) => item.id === engineering.id), false)

  const providers = await aiGatewayByokArea.exportItems(ctx)
  const acme = only(providers, "Acme LLM")
  await aiGatewayByokArea.apply(ctx, { kind: "delete", targetId: acme.id, previous: acme })
  assert.equal((await aiGatewayByokArea.exportItems(ctx)).some((item) => item.id === acme.id), false)

  const connections = await connectorsMcpArea.exportItems(ctx)
  const tools = only(connections, "Tools MCP")
  await connectorsMcpArea.apply(ctx, { kind: "delete", targetId: tools.id, previous: tools })
  assert.equal((await connectorsMcpArea.exportItems(ctx)).some((item) => item.id === tools.id), false)

  const collections = await settingsCollectionsArea.exportItems(ctx)
  const collection = only(collections, "Engineering tools")
  await settingsCollectionsArea.apply(ctx, { kind: "delete", targetId: collection.id, previous: collection })
  assert.equal((await settingsCollectionsArea.exportItems(ctx)).some((item) => item.id === collection.id), false)
})

test("a BYOK provider moving to another address can't keep its key, and loses its inline credentials (M11)", async () => {
  const ctx = await ctxFor(orgA)
  const acme = only((await exportAll(orgA)).get("ai-gateway.byok"), "Acme LLM")
  const moved = (secret: () => SecretDecision) => {
    const spec = resolvedSpec(acme.spec, sameOrgRefs, secret)
    assert.ok(isObject(spec.provider))
    return { ...spec, provider: { ...spec.provider, api: "https://elsewhere.example.test/v1", options: { baseURL: "https://elsewhere.example.test/v1" } } }
  }
  await assert.rejects(
    aiGatewayByokArea.apply(ctx, { kind: "update", targetId: acme.id, previous: acme, item: { key: acme.key, name: acme.name, spec: moved(keepAll) } }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "needs_input" && /another address/.test(error.message),
  )
  const [unchanged] = await db.select().from(LlmProviderTable).where(eq(LlmProviderTable.id, acme.id))
  assert.equal(field(unchanged?.providerConfig, "api"), "https://llm.example.test/v1", "nothing was written")

  const result = await aiGatewayByokArea.apply(ctx, { kind: "update", targetId: acme.id, previous: acme, item: { key: acme.key, name: acme.name, spec: moved(() => ({ decision: "value", value: "byok-for-elsewhere" })) } })
  assert.ok(result.warnings?.some((warning) => /inline credentials/.test(warning)), JSON.stringify(result.warnings))
  const [provider] = await db.select().from(LlmProviderTable).where(eq(LlmProviderTable.id, acme.id))
  assert.equal(provider?.apiKey, "byok-for-elsewhere")
  assert.equal(field(provider?.providerConfig, "api"), "https://elsewhere.example.test/v1")
  const stored = JSON.stringify(provider?.providerConfig)
  assert.ok(!stored.includes(SECRETS.byokInline) && !stored.includes(SECRETS.byokHeader), "inline credentials don't follow the provider to another host")
  const models = await db.select().from(LlmProviderModelTable).where(eq(LlmProviderModelTable.llmProviderId, acme.id))
  assert.ok(models.length > 0)
  assert.ok(!JSON.stringify(models.map((model) => model.modelConfig)).includes(SECRETS.byokHeader), "model headers dropped too")
})
