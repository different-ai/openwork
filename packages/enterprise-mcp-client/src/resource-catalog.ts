import { Buffer } from "node:buffer"
import type { Client, RequestOptions } from "@modelcontextprotocol/client"
import { EnterpriseMcpCatalogError } from "./errors.js"

export const ENTERPRISE_MCP_RESOURCE_PAGE_LIMIT = 20
export const ENTERPRISE_MCP_RESOURCE_ITEM_LIMIT = 2_000
export const ENTERPRISE_MCP_RESOURCE_URI_LIMIT_BYTES = 16 * 1024
export const ENTERPRISE_MCP_RESOURCE_DESCRIPTOR_LIMIT_BYTES = 256 * 1024
export const ENTERPRISE_MCP_RESOURCE_CATALOG_LIMIT_BYTES = 8 * 1024 * 1024
export const ENTERPRISE_MCP_RESOURCE_RESULT_LIMIT_BYTES = 2 * 1024 * 1024

type ResourcePage = Awaited<ReturnType<Client["listResources"]>>
type ResourceTemplatePage = Awaited<ReturnType<Client["listResourceTemplates"]>>

function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value)
  return serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8")
}

function assertDescriptor(value: { uri?: string; uriTemplate?: string }): number {
  const uri = value.uri ?? value.uriTemplate ?? ""
  if (Buffer.byteLength(uri, "utf8") > ENTERPRISE_MCP_RESOURCE_URI_LIMIT_BYTES) {
    throw new EnterpriseMcpCatalogError("MCP_RESOURCE_URI_LIMIT")
  }
  const bytes = serializedBytes(value)
  if (bytes > ENTERPRISE_MCP_RESOURCE_DESCRIPTOR_LIMIT_BYTES) {
    throw new EnterpriseMcpCatalogError("MCP_RESOURCE_DESCRIPTOR_LIMIT")
  }
  return bytes
}

async function collectPages<T extends { uri?: string; uriTemplate?: string }>(input: {
  listPage: (cursor: string | undefined, options: RequestOptions) => Promise<{
    items: T[]
    nextCursor?: string
  }>
  requestOptions: RequestOptions
}): Promise<T[]> {
  const items: T[] = []
  const identifiers = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  let catalogBytes = 0

  for (let page = 0; page < ENTERPRISE_MCP_RESOURCE_PAGE_LIMIT; page += 1) {
    const result = await input.listPage(cursor, input.requestOptions)
    for (const item of result.items) {
      if (items.length >= ENTERPRISE_MCP_RESOURCE_ITEM_LIMIT) {
        throw new EnterpriseMcpCatalogError("MCP_CATALOG_ITEM_LIMIT")
      }
      const identifier = item.uri ?? item.uriTemplate ?? ""
      if (identifiers.has(identifier)) throw new EnterpriseMcpCatalogError("MCP_CATALOG_DUPLICATE_RESOURCE")
      const bytes = assertDescriptor(item)
      if (catalogBytes + bytes > ENTERPRISE_MCP_RESOURCE_CATALOG_LIMIT_BYTES) {
        throw new EnterpriseMcpCatalogError("MCP_CATALOG_BYTE_LIMIT")
      }
      catalogBytes += bytes
      identifiers.add(identifier)
      items.push(item)
    }

    if (!result.nextCursor) return items
    if (Buffer.byteLength(result.nextCursor, "utf8") > ENTERPRISE_MCP_RESOURCE_URI_LIMIT_BYTES) {
      throw new EnterpriseMcpCatalogError("MCP_CATALOG_CURSOR_SIZE_LIMIT")
    }
    if (cursors.has(result.nextCursor)) throw new EnterpriseMcpCatalogError("MCP_CATALOG_CURSOR_LOOP")
    cursors.add(result.nextCursor)
    cursor = result.nextCursor
  }

  throw new EnterpriseMcpCatalogError("MCP_CATALOG_PAGE_LIMIT")
}

export function collectEnterpriseMcpResources(input: {
  listPage: (cursor: string | undefined, options: RequestOptions) => Promise<ResourcePage>
  requestOptions: RequestOptions
}) {
  return collectPages({
    requestOptions: input.requestOptions,
    listPage: async (cursor, options) => {
      const result = await input.listPage(cursor, options)
      return { items: result.resources, nextCursor: result.nextCursor }
    },
  })
}

export function collectEnterpriseMcpResourceTemplates(input: {
  listPage: (cursor: string | undefined, options: RequestOptions) => Promise<ResourceTemplatePage>
  requestOptions: RequestOptions
}) {
  return collectPages({
    requestOptions: input.requestOptions,
    listPage: async (cursor, options) => {
      const result = await input.listPage(cursor, options)
      return { items: result.resourceTemplates, nextCursor: result.nextCursor }
    },
  })
}

export function assertEnterpriseMcpResourceResult(value: unknown): void {
  if (serializedBytes(value) > ENTERPRISE_MCP_RESOURCE_RESULT_LIMIT_BYTES) {
    throw new EnterpriseMcpCatalogError("MCP_RESOURCE_RESULT_LIMIT")
  }
}
