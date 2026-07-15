import { Buffer } from "node:buffer"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import { EnterpriseMcpCatalogError, type EnterpriseMcpCatalogErrorCode } from "./errors.js"
import { assertEnterpriseMcpSchema } from "./bounded-schema.js"

export {
  ENTERPRISE_MCP_TOOL_SCHEMA_COMPOSITION_BRANCH_LIMIT,
  ENTERPRISE_MCP_TOOL_SCHEMA_DEPTH_LIMIT,
  ENTERPRISE_MCP_TOOL_SCHEMA_LIMIT_BYTES,
  ENTERPRISE_MCP_TOOL_SCHEMA_NODE_LIMIT,
  ENTERPRISE_MCP_TOOL_SCHEMA_REFERENCE_DEPTH_LIMIT,
} from "./bounded-schema.js"

export const ENTERPRISE_MCP_TOOL_PAGE_LIMIT = 20
export const ENTERPRISE_MCP_TOOL_ITEM_LIMIT = 2_000
export const ENTERPRISE_MCP_TOOL_NAME_LIMIT_BYTES = 512
export const ENTERPRISE_MCP_TOOL_TITLE_LIMIT_BYTES = 4 * 1024
export const ENTERPRISE_MCP_TOOL_DESCRIPTION_LIMIT_BYTES = 64 * 1024
export const ENTERPRISE_MCP_CURSOR_LIMIT_BYTES = 16 * 1024
export const ENTERPRISE_MCP_CATALOG_LIMIT_BYTES = 8 * 1024 * 1024

type ToolPage = Awaited<ReturnType<Client["listTools"]>>

function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value)
  return serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8")
}

function assertStringLimit(
  value: string | undefined,
  limit: number,
  code: EnterpriseMcpCatalogErrorCode,
): void {
  if (value !== undefined && serializedBytes(value) > limit) {
    throw new EnterpriseMcpCatalogError(code)
  }
}

function assertTool(tool: Tool): void {
  assertStringLimit(tool.name, ENTERPRISE_MCP_TOOL_NAME_LIMIT_BYTES, "MCP_CATALOG_TOOL_NAME_LIMIT")
  assertStringLimit(tool.title, ENTERPRISE_MCP_TOOL_TITLE_LIMIT_BYTES, "MCP_CATALOG_TOOL_TITLE_LIMIT")
  assertStringLimit(tool.description, ENTERPRISE_MCP_TOOL_DESCRIPTION_LIMIT_BYTES, "MCP_CATALOG_TOOL_DESCRIPTION_LIMIT")
  assertEnterpriseMcpSchema(tool.inputSchema)
  if (tool.outputSchema) assertEnterpriseMcpSchema(tool.outputSchema)
}

export async function collectEnterpriseMcpTools(input: {
  listPage: (cursor: string | undefined, options: RequestOptions) => Promise<ToolPage>
  requestOptions: RequestOptions
}): Promise<Tool[]> {
  const tools: Tool[] = []
  const names = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  let catalogBytes = 0

  for (let page = 0; page < ENTERPRISE_MCP_TOOL_PAGE_LIMIT; page += 1) {
    const result = await input.listPage(cursor, input.requestOptions)
    for (const tool of result.tools) {
      if (tools.length >= ENTERPRISE_MCP_TOOL_ITEM_LIMIT) {
        throw new EnterpriseMcpCatalogError("MCP_CATALOG_ITEM_LIMIT")
      }
      if (names.has(tool.name)) throw new EnterpriseMcpCatalogError("MCP_CATALOG_DUPLICATE_TOOL")
      assertTool(tool)
      const toolBytes = serializedBytes(tool)
      if (catalogBytes + toolBytes > ENTERPRISE_MCP_CATALOG_LIMIT_BYTES) {
        throw new EnterpriseMcpCatalogError("MCP_CATALOG_BYTE_LIMIT")
      }
      catalogBytes += toolBytes
      names.add(tool.name)
      tools.push(tool)
    }

    if (!result.nextCursor) return tools
    if (serializedBytes(result.nextCursor) > ENTERPRISE_MCP_CURSOR_LIMIT_BYTES) {
      throw new EnterpriseMcpCatalogError("MCP_CATALOG_CURSOR_SIZE_LIMIT")
    }
    if (cursors.has(result.nextCursor)) throw new EnterpriseMcpCatalogError("MCP_CATALOG_CURSOR_LOOP")
    cursors.add(result.nextCursor)
    cursor = result.nextCursor
  }

  throw new EnterpriseMcpCatalogError("MCP_CATALOG_PAGE_LIMIT")
}
