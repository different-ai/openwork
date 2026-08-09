import { describe, expect, test } from "bun:test"
import {
  externalMcpOAuthConfigurationDefaults,
} from "../src/capability-sources/external-mcp-auth-policy.js"
import {
  EXTERNAL_MCP_PRESETS,
  externalMcpPresetListResponseSchema,
} from "../src/capability-sources/external-mcp-presets.js"

const slackDefaultScopes = [
  "search:read.public",
  "search:read.private",
  "search:read.im",
  "search:read.mpim",
  "search:read.files",
  "chat:write",
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "users:read",
]

describe("External MCP preset OAuth defaults", () => {
  test("Slack pins its issuer and sane default scope subset", () => {
    const slack = EXTERNAL_MCP_PRESETS.find((preset) => preset.presetId === "slack")
    expect(slack?.authorizationServerIssuer).toBe("https://mcp.slack.com")
    expect(slack?.defaultOAuthScopes).toEqual(slackDefaultScopes)
  })

  test("applies preset defaults only when admin values are absent", () => {
    expect(externalMcpOAuthConfigurationDefaults({ url: "https://mcp.slack.com/mcp/" })).toEqual({
      authorizationServerIssuer: "https://mcp.slack.com",
      requestedScopes: slackDefaultScopes,
    })
    expect(externalMcpOAuthConfigurationDefaults({
      url: "https://mcp.slack.com/mcp",
      authorizationServerIssuer: "https://auth.example.com",
      requestedScopes: ["admin:selected"],
    })).toEqual({
      authorizationServerIssuer: "https://auth.example.com",
      requestedScopes: ["admin:selected"],
    })
    expect(externalMcpOAuthConfigurationDefaults({
      url: "https://mcp.slack.com/mcp",
      authorizationServerIssuer: null,
      requestedScopes: [],
    })).toEqual({ authorizationServerIssuer: null, requestedScopes: [] })
  })

  test("presets response schema exposes OAuth defaults", () => {
    const result = externalMcpPresetListResponseSchema.parse({ presets: EXTERNAL_MCP_PRESETS })
    const slack = result.presets.find((preset) => preset.presetId === "slack")
    expect(slack?.authorizationServerIssuer).toBe("https://mcp.slack.com")
    expect(slack?.defaultOAuthScopes).toEqual(slackDefaultScopes)
  })
})
