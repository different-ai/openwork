import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  AGENT_PLUGIN_V1_MANIFEST_SCHEMA,
  AGENT_PLUGIN_V1_MCP_SCHEMA,
  AGENT_PLUGIN_V1_WORKING_DRAFT_MANIFEST_SCHEMA,
  AGENT_PLUGIN_V1_WORKING_DRAFT_MCP_SCHEMA,
  parseAgentPluginV1McpText,
  validateAgentPluginV1Manifest,
} from "../src/routes/org/plugin-system/agent-plugin-v1.js"

const bundleRoot = join(import.meta.dir, "../../../../integrations/agent-plugins/openwork-connect")

describe("Agent Plugins v1", () => {
  test("ships a published 1.0 package with a valid OpenWork Connect MCP configuration", async () => {
    const manifest = JSON.parse(await readFile(join(bundleRoot, "plugin.json"), "utf8")) as unknown
    const mcpText = await readFile(join(bundleRoot, "mcp.json"), "utf8")

    const manifestResult = validateAgentPluginV1Manifest(manifest)
    expect(manifestResult).toMatchObject({
      manifest: { name: "openwork-connect" },
      ok: true,
      schemaVersion: "1.0.0",
      warnings: [],
    })
    expect(parseAgentPluginV1McpText(mcpText, manifestResult.ok ? manifestResult.schemaVersion : null)).toMatchObject({
      entries: [{
        config: {
          type: "streamable-http",
          url: "https://api.openworklabs.com/mcp/agent",
        },
        name: "openwork",
        valid: true,
      }],
      ok: true,
      schemaVersion: "1.0.0",
    })
  })

  test("accepts the schema-identical 1.1 working draft without weakening 1.0 compatibility", () => {
    const latestManifest = validateAgentPluginV1Manifest({
      $schema: AGENT_PLUGIN_V1_WORKING_DRAFT_MANIFEST_SCHEMA,
      name: "portable.tools",
    })
    expect(latestManifest).toMatchObject({ ok: true, schemaVersion: "1.1.0" })

    expect(parseAgentPluginV1McpText(JSON.stringify({
      $schema: AGENT_PLUGIN_V1_WORKING_DRAFT_MCP_SCHEMA,
      mcpServers: {},
    }), latestManifest.ok ? latestManifest.schemaVersion : null)).toMatchObject({
      ok: true,
      schemaVersion: "1.1.0",
    })

    expect(parseAgentPluginV1McpText(JSON.stringify({
      $schema: AGENT_PLUGIN_V1_MCP_SCHEMA,
      mcpServers: {},
    }), "1.0.0")).toMatchObject({ ok: true, schemaVersion: "1.0.0" })
  })

  test("rejects mixed manifest and MCP schema versions", () => {
    expect(parseAgentPluginV1McpText(JSON.stringify({
      $schema: AGENT_PLUGIN_V1_WORKING_DRAFT_MCP_SCHEMA,
      mcpServers: {},
    }), "1.0.0")).toMatchObject({
      errors: ["mcp.json schema version 1.1.0 must match plugin.json schema version 1.0.0."],
      ok: false,
    })
  })

  test("reports and ignores unknown manifest fields while rejecting other schema violations", () => {
    const accepted = validateAgentPluginV1Manifest({
      $schema: AGENT_PLUGIN_V1_MANIFEST_SCHEMA,
      name: "portable.tools",
      vendorField: true,
    })
    expect(accepted).toMatchObject({
      ok: true,
      warnings: ['Ignored unknown plugin.json field "vendorField".'],
    })

    expect(validateAgentPluginV1Manifest({
      $schema: AGENT_PLUGIN_V1_MANIFEST_SCHEMA,
      author: { team: "Platform" },
      name: "Invalid--Name",
    })).toMatchObject({ ok: false })

    expect(validateAgentPluginV1Manifest({
      $schema: AGENT_PLUGIN_V1_MANIFEST_SCHEMA,
      extensions: "client data with the wrong type",
      name: "portable.tools",
    })).toMatchObject({
      ok: true,
      warnings: ['Ignored non-object plugin.json field "extensions".'],
    })

    expect(validateAgentPluginV1Manifest({
      $schema: AGENT_PLUGIN_V1_MANIFEST_SCHEMA,
      extensions: { "com.example.client": "ignored by other clients" },
      name: "portable.tools",
    })).toMatchObject({ ok: true })
  })

  test("isolates invalid MCP server entries from valid siblings", () => {
    const result = parseAgentPluginV1McpText(JSON.stringify({
      $schema: AGENT_PLUGIN_V1_MCP_SCHEMA,
      mcpServers: {
        local: { type: "stdio", command: "node", args: ["server.mjs"] },
        malformed: { type: "streamable-http", url: 42 },
        remote: { type: "streamable-http", url: "https://mcp.example.test/mcp" },
      },
    }))

    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.entries.map((entry) => [entry.name, entry.valid])).toEqual([
      ["local", true],
      ["malformed", false],
      ["remote", true],
    ])
  })

  test("rejects an MCP document that targets another schema version", () => {
    expect(parseAgentPluginV1McpText(JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/2.0.0/mcp.schema.json",
      mcpServers: {},
    }))).toMatchObject({ ok: false })
  })

  test("rejects escaping stdio paths and malformed or duplicate headers per v1", () => {
    const result = parseAgentPluginV1McpText(JSON.stringify({
      $schema: AGENT_PLUGIN_V1_MCP_SCHEMA,
      mcpServers: {
        duplicateHeaders: {
          type: "streamable-http",
          url: "https://mcp.example.test/mcp",
          headers: { "X-Team": "one", "x-team": "two" },
        },
        invalidHeaderValue: {
          type: "streamable-http",
          url: "https://mcp.example.test/mcp",
          headers: { "X-Team": "invalid\u0001value" },
        },
        escapingCommand: { type: "stdio", command: "./../server" },
        escapingCwd: { type: "stdio", command: "node", cwd: "${PLUGIN_ROOT}/../outside" },
      },
    }))

    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.entries.map((entry) => [entry.name, entry.valid])).toEqual([
      ["duplicateHeaders", false],
      ["invalidHeaderValue", false],
      ["escapingCommand", false],
      ["escapingCwd", false],
    ])
  })
})
