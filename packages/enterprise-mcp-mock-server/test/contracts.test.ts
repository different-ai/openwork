import assert from "node:assert/strict"
import test from "node:test"
import {
  createDefaultScenario,
  createFaultScenario,
  getProviderProfile,
  isSafeOAuthRedirectUri,
  listFaultDefinitions,
  listProviderProfiles,
  scenarioSchema,
  toolInputSchemaSchema,
  validateToolArguments,
  type EnterpriseMcpScenario,
  type FaultDefinition,
  type MockTool,
  type ProviderProfile,
} from "../src/index.js"

function compileTimeScenarioReadonly(scenario: EnterpriseMcpScenario): void {
  // @ts-expect-error Runtime-frozen scenario fields must also be readonly in the public declaration.
  scenario.revision = 2
  // @ts-expect-error Nested scenario arrays must also be readonly in the public declaration.
  scenario.oauth.authorizationScopes.push("unexpected")
}
void compileTimeScenarioReadonly

function compileTimeCatalogReadonly(profile: ProviderProfile, fault: FaultDefinition): void {
  // @ts-expect-error Runtime-frozen provider profiles must also be readonly in the public declaration.
  profile.displayName = "changed"
  // @ts-expect-error Nested profile tools must also be readonly in the public declaration.
  profile.tools.push(profile.tools[0])
  // @ts-expect-error Runtime-frozen fault definitions must also be readonly in the public declaration.
  fault.category = "changed"
}
void compileTimeCatalogReadonly

test("provider profiles are declarative, unique, and provenance-labelled", () => {
  const profiles = listProviderProfiles()
  assert.equal(Object.isFrozen(profiles), true)
  assert.equal(profiles.length, 5)
  assert.equal(new Set(profiles.map((profile) => profile.id)).size, profiles.length)
  for (const profile of profiles) {
    assert.equal(getProviderProfile(profile.id), profile)
    assert.equal(Object.isFrozen(profile), true)
    assert.equal(Object.isFrozen(profile.provenance), true)
    assert.equal(Object.isFrozen(profile.tools), true)
    assert.equal(Object.isFrozen(profile.tools[0]?.inputSchema), true)
    assert.equal(profile.fixtureVersion, "2026-07-12.1")
    assert.ok(profile.provenance.documentationUrls.length > 0)
    assert.ok(profile.provenance.limitations.length > 0)
    assert.ok(profile.oauth.requiredResourceScopes.every((scope) => profile.oauth.authorizationScopes.includes(scope)))
    assert.equal(new Set(profile.tools.map((tool) => tool.name)).size, profile.tools.length)
    assert.equal(profile.provenance.aspectFidelity.providerResults === "provider-documented", false)
    if (profile.provider !== "synthetic") assert.equal(profile.provenance.aspectFidelity.authorization, "synthetic")
  }

  const serviceNow = profiles.find((profile) => profile.id === "servicenow-inbound-quickstart")
  assert.ok(serviceNow)
  assert.deepEqual(serviceNow.oauth.registrationModes, ["manual"])
  assert.deepEqual(serviceNow.oauth.authorizationScopes, ["mcp_server"])
  assert.equal(serviceNow.oauth.authorizationPath, "/oauth_auth.do")
  assert.equal(serviceNow.oauth.tokenPath, "/oauth_token.do")
  assert.equal(serviceNow.oauth.revocationPath, "/oauth_revoke.do")
  assert.equal(serviceNow.provenance.aspectFidelity.catalog, "synthetic")

  const workIq = profiles.find((profile) => profile.id === "microsoft-work-iq")
  assert.ok(workIq)
  assert.equal(workIq.canonicalEndpoint, "https://workiq.svc.cloud.microsoft/mcp")
  assert.ok(workIq.oauth.authorizationScopes.includes("api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask"))
  assert.ok(!workIq.oauth.requiredResourceScopes.includes("offline_access"))
  assert.equal(workIq.provenance.aspectFidelity.toolSchemas, "synthetic")
  assert.equal(workIq.provenance.aspectFidelity.providerResults, "synthetic")

  const documentedWorkIqInputs: Readonly<Record<string, readonly string[]>> = {
    fetch: ["agentId", "entityUrls"],
    create_entity: ["agentId", "approved", "idempotency_key", "jsonBody", "parentUrl"],
    update_entity: ["agentId", "approved", "entityUrl", "idempotency_key", "jsonBody"],
    delete_entity: ["agentId", "approved", "entityUrl", "idempotency_key"],
    do_action: ["actionUrl", "agentId", "approved", "idempotency_key", "jsonBody"],
    call_function: ["agentId", "functionUrl"],
    ask: ["agentId", "conversationId", "fileUrls", "question", "timeZone"],
    list_agents: [],
    get_schema: ["agentId", "backend", "format", "operationIds", "operationType", "path"],
    search_paths: ["agentId", "backend", "filter"],
  }
  for (const [toolName, propertyNames] of Object.entries(documentedWorkIqInputs)) {
    const matchingTool: MockTool | undefined = workIq.tools.find((candidate) => candidate.name === toolName)
    assert.ok(matchingTool, `Missing Work IQ tool ${toolName}`)
    assert.deepEqual(Object.keys(matchingTool.inputSchema.properties).sort(), [...propertyNames].sort())
  }
  assert.deepEqual(workIq.tools.find((tool) => tool.name === "fetch")?.inputSchema.required, ["entityUrls"])
  assert.deepEqual(workIq.tools.find((tool) => tool.name === "list_agents")?.inputSchema.required, [])
  assert.deepEqual(workIq.tools.find((tool) => tool.name === "get_schema")?.inputSchema.required, ["path", "operationType"])
  assert.deepEqual(workIq.tools.find((tool) => tool.name === "search_paths")?.inputSchema.required, ["filter"])

  const enterprise = profiles.find((profile) => profile.id === "microsoft-enterprise")
  assert.ok(enterprise)
  assert.equal(enterprise.canonicalEndpoint, "https://mcp.svc.cloud.microsoft/enterprise")
  assert.equal(enterprise.endpointPath, "/enterprise")
  assert.equal(enterprise.oauth.resource, "api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4")
  assert.equal(enterprise.oauth.audience, "api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4")
  assert.deepEqual(enterprise.oauth.authorizationScopes, ["api://e8c77dc2-69b3-43f4-bc51-3213c9d915b4/.default"])
  assert.equal(enterprise.oauth.authorizationPath, "/organizations/oauth2/v2.0/authorize")
  assert.equal(enterprise.oauth.tokenPath, "/organizations/oauth2/v2.0/token")
  assert.equal(enterprise.oauth.defaultClientAuthenticationMethod, "client_secret_post")
  assert.equal(enterprise.provenance.aspectFidelity.toolSchemas, "synthetic")

  const mail = profiles.find((profile) => profile.id === "agent-365-mail-v1-2026-07")
  assert.ok(mail)
  assert.equal(mail.tools.length, 10)
  assert.equal(mail.tools[0]?.name, "mcp_MailTools_graph_mail_createMessage")
  assert.equal(mail.provenance.aspectFidelity.catalog, "provider-documented")
  assert.equal(mail.provenance.aspectFidelity.toolSchemas, "synthetic")
})

test("Work IQ schemas accept current documented inputs and reject the old generic path mapper", () => {
  const profile = getProviderProfile("microsoft-work-iq")
  const schema = (toolName: string): MockTool["inputSchema"] => {
    const tool: MockTool | undefined = profile.tools.find((candidate) => candidate.name === toolName)
    assert.ok(tool, `Missing Work IQ tool ${toolName}`)
    return tool.inputSchema
  }

  assert.equal(validateToolArguments(schema("fetch"), { entityUrls: ["/me/messages"] }).success, true)
  assert.equal(validateToolArguments(schema("fetch"), { path: "/me/messages" }).success, false)
  assert.equal(
    validateToolArguments(schema("create_entity"), {
      parentUrl: "/me/messages",
      jsonBody: "{\"subject\":\"Synthetic\"}",
      approved: true,
      idempotency_key: "work-iq-create-1",
    }).success,
    true,
  )
  assert.equal(validateToolArguments(schema("call_function"), { functionUrl: "/me/calendarView" }).success, true)
  assert.equal(validateToolArguments(schema("list_agents"), {}).success, true)
  assert.equal(validateToolArguments(schema("list_agents"), { query: "old invented input" }).success, false)
  assert.equal(
    validateToolArguments(schema("get_schema"), { path: "/me/messages", operationType: "fetch", format: "jsonschema" }).success,
    true,
  )
  assert.equal(validateToolArguments(schema("get_schema"), { operationType: "fetch" }).success, false)
  assert.equal(validateToolArguments(schema("get_schema"), { path: "/me/messages", operationType: "delete" }).success, false)
  assert.equal(validateToolArguments(schema("search_paths"), { filter: ".*calendar.*" }).success, true)
})

test("fault definitions are named, phase-specific, applicable, and scenario-bound", () => {
  const faults = listFaultDefinitions()
  assert.equal(faults.length, 24)
  assert.equal(new Set(faults.map((fault) => fault.id)).size, faults.length)
  for (const fault of faults) {
    assert.ok(fault.phase)
    assert.ok(fault.category)
    assert.ok(fault.operatorAction)
    const scenario = createFaultScenario(fault.applicableProfiles[0] ?? "synthetic-enterprise-oauth-mcp", fault.id)
    assert.equal(scenario.expected.firstFailedPhase, fault.phase)
    assert.equal(scenario.expected.category, fault.category)
  }
  const dcrFault = faults.find((fault) => fault.id === "oauth-dynamic-registration-unsupported")
  assert.deepEqual(dcrFault?.applicableProfiles, ["synthetic-enterprise-oauth-mcp"])
})

test("redirect URI policy accepts HTTPS plus Azure-compatible localhost and literal loopback HTTP", () => {
  assert.equal(isSafeOAuthRedirectUri("https://app.example.com/oauth/callback"), true)
  assert.equal(isSafeOAuthRedirectUri("http://127.0.0.1:19876/mcp/oauth/callback"), true)
  assert.equal(isSafeOAuthRedirectUri("http://[::1]:19876/mcp/oauth/callback"), true)
  assert.equal(isSafeOAuthRedirectUri("http://localhost:19876/callback"), true)
  assert.equal(isSafeOAuthRedirectUri("http://localhost.example.com:19876/callback"), false)
  assert.equal(isSafeOAuthRedirectUri("http://127.0.0.1.example.com/callback"), false)
  assert.equal(isSafeOAuthRedirectUri("javascript:alert(1)"), false)
  assert.equal(isSafeOAuthRedirectUri("https://user:password@app.example.com/callback"), false)
  assert.equal(isSafeOAuthRedirectUri("https://app.example.com/callback#token"), false)

  const base = createDefaultScenario()
  assert.equal(
    scenarioSchema.safeParse({ ...base, oauth: { ...base.oauth, redirectUris: ["http://localhost:19876/callback"] } }).success,
    true,
  )
})

test("scenario pins provider fixture, required resource scopes, and supported session behavior", () => {
  const base = createDefaultScenario("microsoft-work-iq")
  assert.equal(scenarioSchema.safeParse({ ...base, profileFixtureVersion: "2026-07-12.999" }).success, false)
  assert.equal(
    scenarioSchema.safeParse({ ...base, oauth: { ...base.oauth, requiredResourceScopes: ["offline_access"] } }).success,
    false,
  )
  assert.equal(scenarioSchema.safeParse({ ...base, protocol: { ...base.protocol, requireSession: false } }).success, false)
})

test("bounded tool schemas support nested enterprise payloads and reject hostile schema keys", () => {
  const schema = toolInputSchemaSchema.parse({
    type: "object",
    properties: {
      message: {
        type: "object",
        properties: {
          recipients: {
            type: "array",
            items: {
              type: "object",
              properties: { address: { type: "string", minLength: 3, maxLength: 320 } },
              required: ["address"],
              additionalProperties: false,
            },
            minItems: 1,
            maxItems: 20,
          },
          body: { oneOf: [{ type: "string", maxLength: 10_000 }, { type: "null" }] },
        },
        required: ["recipients", "body"],
        additionalProperties: false,
      },
    },
    required: ["message"],
    additionalProperties: false,
  })
  assert.equal(validateToolArguments(schema, {
    message: { recipients: [{ address: "person@example.invalid" }], body: "hello" },
  }).success, true)
  assert.equal(validateToolArguments(schema, {
    message: { recipients: [{ address: "x" }], body: 42 },
  }).success, false)
  assert.equal(toolInputSchemaSchema.safeParse({
    type: "object",
    properties: { constructor: { type: "__proto__" } },
    required: ["constructor"],
    additionalProperties: false,
  }).success, false)
})
