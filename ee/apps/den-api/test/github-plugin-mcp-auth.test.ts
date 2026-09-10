import { describe, expect, test } from "bun:test"
import {
  declaredPluginMcpAuthType,
  existingPluginMcpAuthTypeCompatible,
  pluginMcpAuthTypeCompatible,
  pluginMcpRequiresPreRegisteredOAuthClient,
  requiredPluginMcpAuthType,
  resolveGithubPluginMcpImportAuthType,
} from "../src/capability-sources/external-mcp-auth-policy.js"

describe("GitHub plugin MCP authentication", () => {
  const githubUrl = "https://api.githubcopilot.com/mcp/"

  test("HTTP lookalikes do not inherit preset authentication policy", () => {
    for (const url of ["http://api.githubcopilot.com/mcp/", "http://mcp.slack.com/mcp/"]) {
      expect(requiredPluginMcpAuthType({ declaredAuthType: null, url })).toBeNull()
      expect(pluginMcpRequiresPreRegisteredOAuthClient(url)).toBe(false)
      expect(resolveGithubPluginMcpImportAuthType({ declaredAuthType: null, requestedAuthType: "none", url })).toBe("none")
      expect(requiredPluginMcpAuthType({ declaredAuthType: "oauth", url })).toBe("oauth")
    }
  })

  test("GitHub defaults new imports to OAuth without making it the only supported authentication", () => {
    expect(resolveGithubPluginMcpImportAuthType({
      declaredAuthType: null,
      requestedAuthType: "none",
      url: githubUrl,
    })).toBe("oauth")
    expect(requiredPluginMcpAuthType({ declaredAuthType: null, url: githubUrl })).toBeNull()
    expect(pluginMcpRequiresPreRegisteredOAuthClient(githubUrl)).toBe(true)
    for (const authType of ["oauth", "apikey", "none"] as const) {
      expect(pluginMcpAuthTypeCompatible({ authType, requiredAuthType: null, url: githubUrl })).toBe(authType !== "none")
    }
  })

  test("existing PAT and legacy no-auth imports are preserved, but never override explicit OAuth", () => {
    expect(resolveGithubPluginMcpImportAuthType({
      declaredAuthType: null,
      existingAuthType: "apikey",
      requestedAuthType: "oauth",
      url: githubUrl,
    })).toBe("apikey")
    expect(resolveGithubPluginMcpImportAuthType({
      declaredAuthType: "oauth",
      existingAuthType: "apikey",
      requestedAuthType: "none",
      url: githubUrl,
    })).toBe("oauth")
    for (const requestedAuthType of ["none", "oauth"] as const) {
      expect(resolveGithubPluginMcpImportAuthType({
        declaredAuthType: null,
        existingAuthType: "none",
        requestedAuthType,
        url: githubUrl,
      })).toBe("none")
    }
    expect(resolveGithubPluginMcpImportAuthType({
      declaredAuthType: "oauth",
      existingAuthType: "none",
      requestedAuthType: "none",
      url: githubUrl,
    })).toBe("oauth")
    const requiredAuthType = requiredPluginMcpAuthType({ declaredAuthType: "oauth", url: githubUrl })
    expect(requiredAuthType).toBe("oauth")
    expect(pluginMcpAuthTypeCompatible({ authType: "apikey", requiredAuthType, url: githubUrl })).toBe(false)
    expect(pluginMcpAuthTypeCompatible({ authType: "oauth", requiredAuthType, url: githubUrl })).toBe(true)
  })

  test("stored GitHub none remains compatible without permitting a new anonymous setup", () => {
    for (const requiredAuthType of [null, "none"] as const) {
      expect(existingPluginMcpAuthTypeCompatible({ authType: "none", requiredAuthType })).toBe(true)
      expect(pluginMcpAuthTypeCompatible({ authType: "none", requiredAuthType, url: githubUrl })).toBe(false)
    }
    expect(existingPluginMcpAuthTypeCompatible({ authType: "none", requiredAuthType: "oauth" })).toBe(false)
    expect(existingPluginMcpAuthTypeCompatible({ authType: "apikey", requiredAuthType: "oauth" })).toBe(false)
  })

  test("single-auth presets still reject unsupported and anonymous connections", () => {
    for (const [url, authType] of [
      ["https://mcp.slack.com/mcp/", "oauth"],
      ["https://mcp.exa.ai/mcp", "apikey"],
      ["https://mcp.context7.com/mcp", "none"],
    ] as const) {
      const requiredAuthType = requiredPluginMcpAuthType({ declaredAuthType: null, url })
      expect(requiredAuthType).toBe(authType)
      expect(pluginMcpAuthTypeCompatible({ authType, requiredAuthType, url })).toBe(true)
      expect(pluginMcpAuthTypeCompatible({ authType: authType === "none" ? "apikey" : "none", requiredAuthType, url })).toBe(false)
      expect(existingPluginMcpAuthTypeCompatible({ authType, requiredAuthType })).toBe(true)
      expect(existingPluginMcpAuthTypeCompatible({ authType: authType === "none" ? "apikey" : "none", requiredAuthType })).toBe(false)
    }
  })

  test("preset defaults cannot downgrade explicit OAuth even when the preset defaults to API key or no auth", () => {
    for (const url of ["https://mcp.exa.ai/mcp", "https://mcp.context7.com/mcp"]) {
      expect(requiredPluginMcpAuthType({ declaredAuthType: "oauth", url })).toBe("oauth")
      expect(resolveGithubPluginMcpImportAuthType({ declaredAuthType: "oauth", requestedAuthType: "none", url })).toBe("oauth")
      expect(pluginMcpAuthTypeCompatible({ authType: "none", requiredAuthType: "oauth", url })).toBe(false)
    }
  })

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
