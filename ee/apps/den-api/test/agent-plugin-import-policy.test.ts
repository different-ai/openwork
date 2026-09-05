import { describe, expect, mock, test } from "bun:test"
import type { GithubDiscoveredPlugin } from "../src/routes/org/plugin-system/github-discovery.js"

process.env.DEN_DB_ENCRYPTION_KEY = "test-den-db-encryption-key-please-change-1234567890"
process.env.BETTER_AUTH_SECRET = "test-better-auth-secret-please-change-1234567890"
process.env.BETTER_AUTH_URL = "http://localhost:3005"
process.env.CORS_ORIGINS = "http://localhost:3005"
process.env.DATABASE_URL = "mysql://root:password@127.0.0.1:3306/openwork_test"

// The functions under test are pure parsers, but importing the store module
// pulls the app graph, and constructing the real auth module seeds the OAuth
// resource registry against a live database this unit lane does not provide.
// Stub the auth module the same way bearer-session.test.ts does.
mock.module("../src/auth.js", () => ({
  auth: {
    api: {
      getSession: () => Promise.resolve(null),
      verifyApiKey: () => Promise.resolve({
        valid: false,
        error: { message: "INVALID_API_KEY", code: "KEY_NOT_FOUND" },
        key: null,
      }),
    },
    handler: () => Promise.resolve(new Response(JSON.stringify({ keys: [] }), { status: 200 })),
  },
  DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX: "ow_mcp_at_",
  DEN_MCP_FIRST_PARTY_CLIENT_ID: "openwork-desktop",
  DEN_MCP_FIRST_PARTY_RESOURCES: ["http://127.0.0.1:8790/mcp"],
  DEN_MCP_GRANT_ID_CLAIM: "https://openworklabs.com/grant_id",
  DEN_MCP_ORG_ID_CLAIM: "https://openworklabs.com/org_id",
  DEN_MCP_OAUTH_RESOURCE: "http://127.0.0.1:8790/mcp",
  DEN_MCP_RESOURCE: "http://127.0.0.1:8790/mcp",
  DEN_MCP_RESOURCE_CLAIM: "https://openworklabs.com/resource",
  DEN_MCP_RESOURCES: ["http://127.0.0.1:8790/mcp"],
  DEN_MCP_TOKEN_USE_CLAIM: "https://openworklabs.com/token_use",
}))

const { mcpServerEntriesFromPayload, skillEntryFromSource } = await import("../src/routes/org/plugin-system/store.js")

const plugin: GithubDiscoveredPlugin = {
  componentKinds: ["mcp_server"],
  componentPaths: {
    agents: [],
    commands: [],
    hooks: [],
    lspServers: [],
    mcpServers: ["mcp.json"],
    monitors: [],
    settings: [],
    skills: [],
  },
  description: null,
  displayName: "team-tools",
  key: "agent-plugin:root",
  manifestPath: "plugin.json",
  metadata: {},
  rootPath: "",
  selectedByDefault: true,
  sourceKind: "agent_plugin_manifest",
  sourceSchemaVersion: "1.0.0",
  supported: true,
  warnings: [],
}

const legacyPlugin: GithubDiscoveredPlugin = {
  ...plugin,
  key: "plugin:root",
  sourceKind: "plugin_manifest",
  sourceSchemaVersion: null,
}

describe("Agent Plugin Den import policy", () => {
  test("imports safe remote servers and reports unsupported entries independently", () => {
    const servers = mcpServerEntriesFromPayload({
      plugin,
      rawSourceText: JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          headerServer: {
            type: "streamable-http",
            url: "https://headers.example.test/mcp",
            headers: { "x-tenant": "public-value" },
          },
          insecure: { type: "streamable-http", url: "http://example.test/mcp" },
          fragment: { type: "streamable-http", url: "https://mcp.example.test/mcp#fragment" },
          local: { type: "stdio", command: "node", args: ["server.mjs"] },
          loopback: { type: "streamable-http", url: "http://127.0.0.1:8787/mcp" },
          remote: { type: "streamable-http", url: "https://mcp.example.test/mcp" },
        },
      }),
      sourcePath: "mcp.json",
    })

    expect(servers.map((server) => ({ name: server.name, reason: server.skippedReason, supported: server.supported }))).toEqual([
      { name: "headerServer", reason: "headers_unsupported", supported: false },
      { name: "insecure", reason: "invalid_url", supported: false },
      { name: "fragment", reason: "invalid_url", supported: false },
      { name: "local", reason: "local_unsupported", supported: false },
      { name: "loopback", reason: null, supported: true },
      { name: "remote", reason: null, supported: true },
    ])
  })

  test("keeps valid siblings when one server violates the v1 schema", () => {
    const servers = mcpServerEntriesFromPayload({
      plugin,
      rawSourceText: JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          invalid: { type: "streamable-http", url: 42 },
          valid: { type: "streamable-http", url: "https://mcp.example.test/mcp" },
        },
      }),
      sourcePath: "mcp.json",
    })

    expect(servers.map((server) => [server.name, server.skippedReason])).toEqual([
      ["invalid", "invalid_config"],
      ["valid", null],
    ])
  })

  test("disables MCP for a mixed-version package while preserving other component types", () => {
    const servers = mcpServerEntriesFromPayload({
      plugin,
      rawSourceText: JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.1.0/mcp.schema.json",
        mcpServers: {
          remote: { type: "streamable-http", url: "https://mcp.example.test/mcp" },
        },
      }),
      sourcePath: "mcp.json",
    })

    expect(servers).toMatchObject([{
      name: "mcp.json",
      skippedReason: "invalid_config",
      supported: false,
    }])
  })

  test("accepts valid Agent Skills and isolates a parent-directory name mismatch", () => {
    const valid = skillEntryFromSource({
      includeRawSourceText: false,
      plugin,
      rawSourceText: "---\nname: research\ndescription: Research a requested topic.\n---\n\nFollow the research workflow.\n",
      sourcePath: "skills/research/SKILL.md",
    })
    const mismatched = skillEntryFromSource({
      includeRawSourceText: false,
      plugin,
      rawSourceText: "---\nname: other-name\ndescription: Research a requested topic.\n---\n\nFollow the research workflow.\n",
      sourcePath: "skills/research/SKILL.md",
    })

    expect(valid).toMatchObject({ name: "research", skippedReason: null, supported: true })
    expect(mismatched).toMatchObject({ skippedReason: "invalid_skill", supported: false })
  })

  test("preserves legacy Claude-compatible MCP parsing behavior", () => {
    const servers = mcpServerEntriesFromPayload({
      plugin: legacyPlugin,
      rawSourceText: JSON.stringify({
        mcp: {
          legacy: {
            headers: { "x-tenant": "public-value" },
            type: "http",
            url: "https://legacy.example.test/mcp",
          },
        },
      }),
      sourcePath: ".mcp.json",
    })

    expect(servers).toMatchObject([{
      name: "legacy",
      skippedReason: null,
      sourceSchemaVersion: null,
      supported: true,
      url: "https://legacy.example.test/mcp",
    }])
  })
})
