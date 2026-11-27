import type { McpServer } from "@modelcontextprotocol/server"
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js"
import { eq } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, MemberTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  MCP_APP_STORAGE_MAX_READ_ROWS,
  MCP_APP_STORAGE_READ_TOOL_NAME,
  MCP_APP_STORAGE_WRITE_TOOL_NAME,
  mcpAppIdSchema,
  mcpAppStorageReadInputSchema,
  mcpAppStorageReadOutputSchema,
  mcpAppStorageWriteInputSchema,
  mcpAppStorageWriteOutputSchema,
  type McpAppStorage,
  type McpAppStorageStatus,
} from "@openwork/types/mcp-app"
import { db } from "../db.js"
import { env } from "../env.js"
import { markFeaturesUsed } from "../feature-usage.js"
import { getMcpAppStorageBackend } from "../mcp-app-storage/index.js"
import { readMcpAppStorageRecord, recordMcpAppStorageUse } from "../mcp-app-storage/registry.js"
import { McpAppStorageError, readMcpAppStorage, writeMcpAppStorage, type McpAppStorageAccess } from "../mcp-app-storage/service.js"
import { DEN_MCP_READ_SCOPE, DEN_MCP_WRITE_SCOPE } from "./scopes.js"

export const MCP_APP_STORAGE_TOOL_NAMES: ReadonlySet<string> = new Set([MCP_APP_STORAGE_READ_TOOL_NAME, MCP_APP_STORAGE_WRITE_TOOL_NAME])

export const STORAGE_UNAVAILABLE_MESSAGE = "Saved data is unavailable. What was saved is kept, and an OpenWork admin can turn it back on."

type StorageToolResult = CallToolResult & { structuredContent?: Record<string, unknown> }

export type McpAppStorageBinding = {
  status: McpAppStorageStatus
  storage: McpAppStorage
  access?: () => Promise<McpAppStorageAccess>
}

function describeCollections(storage: McpAppStorage): string {
  return storage.collections.map((collection) => {
    const fields = collection.fields.map((field) => {
      const type = field.options ? `one of ${field.options.join(" | ")}` : field.type
      return `${field.name} (${type}${field.required ? ", required" : ""})`
    }).join(", ")
    const rules = [
      collection.scope === "personal" ? "each person sees only their own rows" : "shared by everyone who can use this artifact",
      ...(collection.scope !== "personal" && collection.edit === "creator" ? ["only the person who added a row can change or remove it"] : []),
    ].join("; ")
    return `${collection.name}: ${fields}. ${rules}.`
  }).join(" ")
}

const valueSchema = { type: ["string", "number", "boolean", "null"] }

export function mcpAppStorageTools(title: string, storage: McpAppStorage): Tool[] {
  const collection = { type: "string", enum: storage.collections.map((entry) => entry.name), description: "Which saved collection." }
  const collections = describeCollections(storage)
  return [
    {
      name: MCP_APP_STORAGE_READ_TOOL_NAME,
      title: `Read ${title} data`,
      description: `Read the rows ${title} has saved, newest first unless ordered. Returns { collection, rows: [{ id, values, createdAt, updatedAt, createdBy, updatedBy, mine }], total, limit, offset }. Collections: ${collections}`,
      inputSchema: {
        type: "object",
        properties: {
          collection,
          where: { type: "object", additionalProperties: valueSchema, description: "Only rows whose field equals the value, for example { \"status\": \"open\" }." },
          orderBy: { type: "string", description: "A field name, createdAt, or updatedAt. Defaults to createdAt." },
          order: { type: "string", enum: ["asc", "desc"], description: "Defaults to desc." },
          limit: { type: "integer", minimum: 1, maximum: MCP_APP_STORAGE_MAX_READ_ROWS, description: "Rows to return. Defaults to 50." },
          offset: { type: "integer", minimum: 0 },
        },
        required: ["collection"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    {
      name: MCP_APP_STORAGE_WRITE_TOOL_NAME,
      title: `Change ${title} data`,
      description: `Add, change, or remove one saved row of ${title}. insert takes values; update takes id and only the values to change (null clears an optional one); delete takes id. Returns { collection, action, id, row }. OpenWork checks every value and who may change a row. Collections: ${collections}`,
      inputSchema: {
        type: "object",
        properties: {
          collection,
          action: { type: "string", enum: ["insert", "update", "delete"] },
          id: { type: "string", description: "The row's id, for update and delete." },
          values: { type: "object", additionalProperties: valueSchema, description: "Field values, for insert and update." },
        },
        required: ["collection", "action"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
  ]
}

function failure(error: string, message: string, extra: Record<string, string> = {}): StorageToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error, message, ...extra }) }] }
}

export async function callMcpAppStorageTool(input: {
  binding: McpAppStorageBinding
  name: string
  args: Record<string, unknown>
  scopes: ReadonlySet<string>
  usage?: { organizationId: string; memberId: string }
}): Promise<StorageToolResult> {
  const write = input.name === MCP_APP_STORAGE_WRITE_TOOL_NAME
  const scope = write ? DEN_MCP_WRITE_SCOPE : DEN_MCP_READ_SCOPE
  if (!input.scopes.has(scope)) return failure("insufficient_mcp_scope", `${input.name} requires the ${scope} scope.`, { requiredScope: scope })
  if (!input.binding.access) return failure("storage_unavailable", STORAGE_UNAVAILABLE_MESSAGE)
  try {
    const access = await input.binding.access()
    const result = write ? await writeMcpAppStorage(access, input.args) : await readMcpAppStorage(access, input.args)
    if (input.usage) markFeaturesUsed({ ...input.usage, keys: ["artifactStorage"] })
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result }
  } catch (error) {
    if (error instanceof McpAppStorageError) return failure(error.code, error.message)
    console.error("mcp_app_storage_failed", { error: error instanceof Error ? error.message : String(error) })
    return failure("storage_unavailable", "Saved data is unavailable right now. Try again in a moment.")
  }
}

async function memberName(memberId: string): Promise<string> {
  const [row] = await db.select({ name: AuthUserTable.name, email: AuthUserTable.email })
    .from(MemberTable)
    .innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(eq(MemberTable.id, normalizeDenTypeId("member", memberId)))
    .limit(1)
  return row?.name.trim() || row?.email.split("@")[0] || "A member"
}

export function bindMcpAppStorage(input: {
  organizationId: string
  appId: string
  storage: McpAppStorage
  memberId: string
  enabled: boolean
}): McpAppStorageBinding {
  const backend = input.enabled ? getMcpAppStorageBackend() : null
  const collections = input.storage.collections.map((collection) => collection.name)
  if (!backend) return { status: { available: false, collections }, storage: input.storage }
  let actor: Promise<{ memberId: string; name: string }> | undefined
  return {
    status: { available: true, collections },
    storage: input.storage,
    access: async () => ({
      ref: { organizationId: input.organizationId, appId: input.appId },
      storage: input.storage,
      actor: await (actor ??= memberName(input.memberId).then((name) => ({ memberId: input.memberId, name }))),
      backend,
      limits: { maxRows: env.artifactStorage.maxRows, maxBytes: env.artifactStorage.maxBytes },
      registry: { read: readMcpAppStorageRecord, record: recordMcpAppStorageUse },
    }),
  }
}

const appId = mcpAppIdSchema.describe("Artifact ID (cob_...) from search_capabilities or an artifact result's app.appId.")

export function registerAppStorageTools(input: {
  server: McpServer
  scopes: ReadonlySet<string>
  bind: (appId: string) => Promise<{ binding: McpAppStorageBinding; usage: { organizationId: string; memberId: string } } | null>
}) {
  const run = async (name: string, request: { appId: string } & Record<string, unknown>) => {
    const { appId: id, ...args } = request
    const bound = await input.bind(id)
    if (!bound) return failure("no_saved_data", "That artifact is not available to you, or it does not save data.")
    return callMcpAppStorageTool({ binding: bound.binding, name, args, scopes: input.scopes, usage: bound.usage })
  }
  input.server.registerTool("read_app_data", {
    title: "Read an artifact's saved data",
    description: "Read the rows an artifact has saved, to answer a question about them or summarize them without opening the artifact. Takes the artifact's appId and a collection it saves; optional where (field equals value), orderBy, order, limit (default 50, at most 200), and offset. Returns { collection, rows: [{ id, values, createdAt, updatedAt, createdBy, updatedBy, mine }], total, limit, offset }. You see what the person you act for can see: personal rows are only their own. An unknown collection answers with the names the artifact does save. Requires mcp:read.",
    inputSchema: mcpAppStorageReadInputSchema.extend({ appId }),
    outputSchema: mcpAppStorageReadOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (request) => run(MCP_APP_STORAGE_READ_TOOL_NAME, request))
  input.server.registerTool("write_app_data", {
    title: "Change an artifact's saved data",
    description: "Add, change, or remove one row an artifact has saved, when the person asks you to. Takes the artifact's appId, a collection, and an action: insert with values; update with id and only the values to change; delete with id. Returns { collection, action, id, row }. OpenWork checks every value against the artifact's fields and who may change the row, and refuses with a message to relay. Requires mcp:write.",
    inputSchema: mcpAppStorageWriteInputSchema.extend({ appId }),
    outputSchema: mcpAppStorageWriteOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, (request) => run(MCP_APP_STORAGE_WRITE_TOOL_NAME, request))
}
