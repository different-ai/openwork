import { describe, expect, test } from "bun:test"
import {
  declaredPluginMcpAuthType,
  resolveGithubPluginMcpImportAuthType,
} from "../src/capability-sources/external-mcp-auth-policy.js"

describe("GitHub plugin MCP authentication", () => {
  test("preserves an explicit OAuth declaration from the plugin", () => {
    const declaredAuthType = declaredPluginMcpAuthType({ oauth: { clientId: "public-client" } })

    expect(declaredAuthType).toBe("oauth")
    expect(resolveGithubPluginMcpImportAuthType({
      declaredAuthType,
      requestedAuthType: "none",
      url: "https://unknown.example.test/mcp",
    })).toBe("oauth")
  })

  test("known server presets override a mistaken global no-auth choice", () => {
    expect(resolveGithubPluginMcpImportAuthType({
      declaredAuthType: null,
      requestedAuthType: "none",
      url: "https://mcp.slack.com/mcp/",
    })).toBe("oauth")
    expect(resolveGithubPluginMcpImportAuthType({
      declaredAuthType: null,
      requestedAuthType: "oauth",
      url: "https://mcp.exa.ai/mcp",
    })).toBe("apikey")
    expect(resolveGithubPluginMcpImportAuthType({
      declaredAuthType: null,
      requestedAuthType: "oauth",
      url: "https://mcp.context7.com/mcp",
    })).toBe("none")
  })

  test("uses the requested fallback only when the plugin and presets are silent", () => {
    expect(declaredPluginMcpAuthType({})).toBeNull()
    expect(resolveGithubPluginMcpImportAuthType({
      declaredAuthType: null,
      requestedAuthType: "none",
      url: "https://public.example.test/mcp",
    })).toBe("none")
  })
})
