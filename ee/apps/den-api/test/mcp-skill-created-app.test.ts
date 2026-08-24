import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { McpServer } from "@modelcontextprotocol/server"
import { expect, test } from "bun:test"
import {
  CREATE_SKILL_TOOL_NAME,
  registerAgentSkillCreatedApp,
  SKILL_CREATED_APP_HTML,
  SKILL_CREATED_APP_RESOURCE_URI,
  skillCreatedPayloadSchema,
  UPDATE_SKILL_TOOL_NAME,
  type CreateSkillResult,
} from "../src/mcp/skill-created-app.js"
import { workflowArtifactAppServerCapabilities } from "../src/mcp/workflow-artifact-app.js"

const payload = skillCreatedPayloadSchema.parse({
  schemaVersion: "1",
  name: "beautiful-tomatoes",
  pluginId: "plugin_tomatoes",
  skillId: "configObject_tomatoes",
  description: "Use beautiful tomatoes whenever the user says go.",
  libraryUrl: "https://app.openworklabs.com/dashboard/library/plugins/plugin_tomatoes",
})

const updatedPayload = skillCreatedPayloadSchema.parse({
  ...payload,
  mode: "updated",
  description: "Use beautiful tomatoes and cherry tomatoes when the user says go.",
})

type CreateSkill = Parameters<typeof registerAgentSkillCreatedApp>[0]["create"]
type UpdateSkill = NonNullable<Parameters<typeof registerAgentSkillCreatedApp>[0]["update"]>

async function withClient<T>(
  run: (client: Client) => Promise<T>,
  create: CreateSkill = async () => ({ ok: true, payload }),
  update: UpdateSkill = async () => ({ ok: true, payload: updatedPayload }),
): Promise<T> {
  const server = new McpServer(
    { name: "skill-created-test", version: "1.0.0" },
    { capabilities: workflowArtifactAppServerCapabilities },
  )
  registerAgentSkillCreatedApp({ server, create, update })
  const client = new Client(
    { name: "skill-created-host-test", version: "1.0.0" },
    {
      capabilities: {
        extensions: {
          "io.modelcontextprotocol/ui": {
            mimeTypes: ["text/html;profile=mcp-app"],
          },
        },
      },
    },
  )
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    return await run(client)
  } finally {
    await client.close()
    await server.close()
  }
}

test("lists create_skill with its standard MCP App resource", async () => {
  await withClient(async (client) => {
    const tools = await client.listTools()
    const tool = tools.tools.find((candidate) => candidate.name === CREATE_SKILL_TOOL_NAME)
    expect(tool?._meta).toMatchObject({
      ui: {
        resourceUri: SKILL_CREATED_APP_RESOURCE_URI,
        visibility: ["model", "app"],
      },
      "ui/resourceUri": SKILL_CREATED_APP_RESOURCE_URI,
    })

    const resources = await client.listResources()
    expect(resources.resources).toContainEqual(expect.objectContaining({
      uri: SKILL_CREATED_APP_RESOURCE_URI,
      mimeType: "text/html;profile=mcp-app",
      _meta: {
        ui: {
          csp: {
            connectDomains: [],
            resourceDomains: [],
            frameDomains: [],
            baseUriDomains: [],
          },
          prefersBorder: true,
        },
      },
    }))
  })
})

test("serves bundled React HTML and returns schema-valid structured content with text fallback", async () => {
  const requests: Array<{ pluginName: string; skillMarkdown: string }> = []
  await withClient(async (client) => {
    const resource = await client.readResource({ uri: SKILL_CREATED_APP_RESOURCE_URI })
    const content = resource.contents[0]
    expect(content && "text" in content ? content.text : "").toBe(SKILL_CREATED_APP_HTML)
    expect(SKILL_CREATED_APP_HTML).toStartWith("<!doctype html>")
    expect(SKILL_CREATED_APP_HTML).toContain("2026-01-26")
    expect(SKILL_CREATED_APP_HTML).toContain("ui/notifications/tool-result")
    expect(SKILL_CREATED_APP_HTML).toContain("ui/notifications/size-changed")
    expect(SKILL_CREATED_APP_HTML).not.toContain("<script src=")
    expect(SKILL_CREATED_APP_HTML).not.toContain("fetch(")
    const documentHead = SKILL_CREATED_APP_HTML.slice(0, SKILL_CREATED_APP_HTML.indexOf("<script"))
    expect(documentHead).not.toContain("<link")

    const result = await client.callTool({
      name: CREATE_SKILL_TOOL_NAME,
      arguments: {
        pluginName: "Beautiful Tomatoes",
        skillMarkdown: "---\nname: beautiful-tomatoes\ndescription: Use beautiful tomatoes when the user says go.\n---\n\nUse beautiful tomatoes.",
      },
    })
    expect(result.isError).not.toBe(true)
    expect(skillCreatedPayloadSchema.parse(result.structuredContent)).toEqual(payload)
    const first = result.content[0]
    const fallback = first?.type === "text" ? first.text : ""
    expect(fallback).toContain("# Skill created: beautiful-tomatoes")
    expect(fallback).toContain("Plugin ID: plugin_tomatoes")
    expect(fallback).toContain("Skill ID: configObject_tomatoes")
    expect(fallback).not.toContain("🍅")
    expect(result._meta).toEqual({
      schemaVersion: "1",
      pluginId: "plugin_tomatoes",
      skillId: "configObject_tomatoes",
    })
  }, async (request): Promise<CreateSkillResult> => {
    requests.push(request)
    return { ok: true, payload }
  })
  expect(requests).toHaveLength(1)
  expect(requests[0]?.pluginName).toBe("Beautiful Tomatoes")
})

test("lists update_skill against the same skill App resource", async () => {
  await withClient(async (client) => {
    const tools = await client.listTools()
    const tool = tools.tools.find((candidate) => candidate.name === UPDATE_SKILL_TOOL_NAME)
    expect(tool?._meta).toMatchObject({
      ui: {
        resourceUri: SKILL_CREATED_APP_RESOURCE_URI,
        visibility: ["model", "app"],
      },
    })
  })
})

test("update_skill returns updated-mode structured content and text fallback", async () => {
  const requests: Array<{ skillId: string; skillMarkdown: string; reason?: string }> = []
  await withClient(async (client) => {
    const result = await client.callTool({
      name: UPDATE_SKILL_TOOL_NAME,
      arguments: {
        skillId: "configObject_tomatoes",
        skillMarkdown: "---\nname: beautiful-tomatoes\ndescription: Use beautiful tomatoes and cherry tomatoes when the user says go.\n---\n\nUse tomatoes generously.",
        reason: "Add cherry tomatoes",
      },
    })
    expect(result.isError).not.toBe(true)
    expect(skillCreatedPayloadSchema.parse(result.structuredContent)).toEqual(updatedPayload)
    const first = result.content[0]
    const fallback = first?.type === "text" ? first.text : ""
    expect(fallback).toContain("# Skill updated: beautiful-tomatoes")
    expect(fallback).toContain("Plugin ID: plugin_tomatoes")
  }, undefined, async (request): Promise<CreateSkillResult> => {
    requests.push(request)
    return { ok: true, payload: updatedPayload }
  })
  expect(requests).toHaveLength(1)
  expect(requests[0]?.reason).toBe("Add cherry tomatoes")
})

test("keeps creation failures useful to clients without MCP Apps", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: CREATE_SKILL_TOOL_NAME,
      arguments: {
        pluginName: "Beautiful Tomatoes",
        skillMarkdown: "---\nname: beautiful-tomatoes\ndescription: Use tomatoes.\n---\n\nUse tomatoes.",
      },
    })
    expect(result.isError).toBe(true)
    const first = result.content[0]
    expect(first?.type === "text" ? JSON.parse(first.text) : null).toEqual({
      error: "duplicate_plugin",
      message: "A Plugin with that name already exists.",
    })
    expect(result.structuredContent).toBeUndefined()
  }, async () => ({
    ok: false,
    error: "duplicate_plugin",
    message: "A Plugin with that name already exists.",
  }))
})
