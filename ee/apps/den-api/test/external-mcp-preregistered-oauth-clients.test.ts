import { describe, expect, test } from "bun:test"
import type { EnterpriseMcpConnectionRequirements } from "@openwork/enterprise-mcp-client"
import { pluginMcpRequiresPreRegisteredOAuthClient } from "../src/capability-sources/external-mcp-auth-policy.js"
import {
  applyPreRegisteredOAuthClientDefaults,
  applyPreRegisteredOAuthClientToRequirements,
  EMPTY_EXTERNAL_MCP_PREREGISTERED_OAUTH_CLIENTS,
  parseExternalMcpPreRegisteredOAuthClients,
  preRegisteredOAuthClientForUrl,
} from "../src/capability-sources/external-mcp-preregistered-oauth-clients.js"
import { EXTERNAL_MCP_PRESETS } from "../src/capability-sources/external-mcp-presets.js"

const RENDER_URL = "https://mcp.render.com/mcp"

function renderClients(raw = `{"${RENDER_URL}":{"clientId":"openwork"}}`) {
  return parseExternalMcpPreRegisteredOAuthClients(raw)
}

function oauthRequirements(overrides: Partial<EnterpriseMcpConnectionRequirements> = {}): EnterpriseMcpConnectionRequirements {
  return {
    status: "manual_action_required",
    server: { url: RENDER_URL, initialize: "authentication_required" },
    authentication: {
      kind: "oauth",
      authorizationServers: [{ issuer: "https://api.render.com", clientIdMetadataDocumentSupported: false }],
      requiredScopes: [],
      recommendedScopes: [],
      refreshSupport: "unknown",
      availableRegistrationMethods: ["pre_registered"],
      recommendedRegistrationMethod: "pre_registered",
    },
    tools: { visibility: "requires_auth" },
    manualRequirements: [
      {
        code: "oauth_client_registration",
        label: "Register an OAuth client",
        reason: "The authorization server does not advertise client metadata documents or dynamic registration.",
        required: true,
      },
      { code: "provider_access", label: "Provider access", reason: "Not described by metadata.", required: false },
      { code: "network_trust", label: "Network trust", reason: "Confirm in the deployment.", required: false },
    ],
    warnings: [],
    ...overrides,
  }
}

describe("DEN_EXTERNAL_MCP_PREREGISTERED_OAUTH_CLIENTS parsing", () => {
  test("an unset or blank value configures no clients", () => {
    expect(parseExternalMcpPreRegisteredOAuthClients(undefined).size).toBe(0)
    expect(parseExternalMcpPreRegisteredOAuthClients("   ").size).toBe(0)
  })

  test("parses a public client keyed by normalized server URL", () => {
    const clients = renderClients(`{"https://MCP.render.com:443/mcp/":{"clientId":"openwork"}}`)
    expect([...clients.keys()]).toEqual([RENDER_URL])
    expect(preRegisteredOAuthClientForUrl("https://mcp.render.com/mcp/", clients)).toEqual({ clientId: "openwork" })
    expect(preRegisteredOAuthClientForUrl("https://mcp.render.com/other", clients)).toBeNull()
    expect(preRegisteredOAuthClientForUrl("http://mcp.render.com/mcp", clients)).toBeNull()
    expect(preRegisteredOAuthClientForUrl("not a url", clients)).toBeNull()
    expect(preRegisteredOAuthClientForUrl(RENDER_URL, EMPTY_EXTERNAL_MCP_PREREGISTERED_OAUTH_CLIENTS)).toBeNull()
  })

  test("keeps a confidential client's secret and token endpoint auth method", () => {
    const clients = renderClients(JSON.stringify({
      [RENDER_URL]: { clientId: "openwork", clientSecret: "s3cret", tokenEndpointAuthMethod: "client_secret_post" },
    }))
    expect(preRegisteredOAuthClientForUrl(RENDER_URL, clients)).toEqual({
      clientId: "openwork",
      clientSecret: "s3cret",
      tokenEndpointAuthMethod: "client_secret_post",
    })
  })

  test("rejects malformed configuration at startup", () => {
    expect(() => parseExternalMcpPreRegisteredOAuthClients("{not json")).toThrow(/JSON object/)
    expect(() => parseExternalMcpPreRegisteredOAuthClients(`["https://mcp.render.com/mcp"]`)).toThrow(/is invalid/)
    expect(() => parseExternalMcpPreRegisteredOAuthClients(`{"${RENDER_URL}":{"clientId":""}}`)).toThrow(/is invalid at/)
    expect(() => parseExternalMcpPreRegisteredOAuthClients(`{"${RENDER_URL}":{"clientId":"x","extra":1}}`)).toThrow(/is invalid/)
    expect(() => parseExternalMcpPreRegisteredOAuthClients(`{"http://mcp.render.com/mcp":{"clientId":"x"}}`)).toThrow(/absolute https/)
    expect(() => parseExternalMcpPreRegisteredOAuthClients(`{"${RENDER_URL}?x=1":{"clientId":"x"}}`)).toThrow(/absolute https/)
    expect(() => parseExternalMcpPreRegisteredOAuthClients(
      `{"${RENDER_URL}":{"clientId":"a"},"${RENDER_URL}/":{"clientId":"b"}}`,
    )).toThrow(/more than once/)
    expect(() => parseExternalMcpPreRegisteredOAuthClients(
      `{"${RENDER_URL}":{"clientId":"x","tokenEndpointAuthMethod":"client_secret_basic"}}`,
    )).toThrow(/without a clientSecret/)
  })
})

describe("deployment-supplied OAuth clients and presets", () => {
  test("a preset stops demanding an admin OAuth app when the deployment supplies one", () => {
    const render = EXTERNAL_MCP_PRESETS.find((preset) => preset.presetId === "render")
    expect(render).toMatchObject({ authType: "oauth", supportedAuthTypes: ["oauth", "apikey"], requiresOAuthClient: true })
    expect(pluginMcpRequiresPreRegisteredOAuthClient(RENDER_URL)).toBe(true)

    const presets = applyPreRegisteredOAuthClientDefaults(EXTERNAL_MCP_PRESETS, renderClients())
    const renderForDeployment = presets.find((preset) => preset.presetId === "render")
    expect(renderForDeployment?.requiresOAuthClient).toBeUndefined()
    expect(renderForDeployment).toMatchObject({ authType: "oauth", supportedAuthTypes: ["oauth", "apikey"], url: RENDER_URL })
    expect(pluginMcpRequiresPreRegisteredOAuthClient(RENDER_URL, presets)).toBe(false)

    // Other presets that need an admin-supplied app are untouched.
    expect(presets.find((preset) => preset.presetId === "slack")?.requiresOAuthClient).toBe(true)
    expect(presets.find((preset) => preset.presetId === "github")?.requiresOAuthClient).toBe(true)
    expect(pluginMcpRequiresPreRegisteredOAuthClient("https://mcp.slack.com/mcp", presets)).toBe(true)
  })

  test("without configured clients presets are returned unchanged", () => {
    const presets = applyPreRegisteredOAuthClientDefaults(EXTERNAL_MCP_PRESETS, EMPTY_EXTERNAL_MCP_PREREGISTERED_OAUTH_CLIENTS)
    expect(presets).toEqual(EXTERNAL_MCP_PRESETS)
  })
})

describe("deployment-supplied OAuth clients and requirements discovery", () => {
  test("downgrades the registration blocker and reads as ready", () => {
    const result = applyPreRegisteredOAuthClientToRequirements(oauthRequirements(), { clientId: "openwork" })
    expect(result.status).toBe("ready")
    const registration = result.manualRequirements.find((requirement) => requirement.code === "oauth_client_registration")
    expect(registration?.required).toBe(false)
    expect(registration?.reason).toContain("pre-registered OAuth client")
    expect(result.manualRequirements.map((requirement) => requirement.code)).toEqual([
      "oauth_client_registration",
      "provider_access",
      "network_trust",
    ])
  })

  test("leaves other blockers and non-OAuth results alone", () => {
    const requirements = oauthRequirements()
    expect(applyPreRegisteredOAuthClientToRequirements(requirements, null)).toBe(requirements)

    const withIssuerChoice = oauthRequirements({
      manualRequirements: [
        { code: "authorization_server_selection", label: "Choose an authorization server", reason: "Several issuers.", required: true },
        ...oauthRequirements().manualRequirements,
      ],
    })
    const result = applyPreRegisteredOAuthClientToRequirements(withIssuerChoice, { clientId: "openwork" })
    expect(result.status).toBe("manual_action_required")
    expect(result.manualRequirements.find((requirement) => requirement.code === "authorization_server_selection")?.required).toBe(true)

    const alreadyReady = oauthRequirements({
      status: "ready",
      manualRequirements: oauthRequirements().manualRequirements.filter((requirement) => requirement.code !== "oauth_client_registration"),
    })
    expect(applyPreRegisteredOAuthClientToRequirements(alreadyReady, { clientId: "openwork" })).toBe(alreadyReady)
  })
})
