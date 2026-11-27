import { z } from "zod"
import type { MicrosoftGraphClient } from "../../capability-sources/microsoft-graph.js"
import { pageTokenSchema, pagingResponseFields } from "./microsoft-365-shared.js"
import type { MicrosoftGraphResource } from "./microsoft-graph-resources.js"

const fieldSchemas = {
  string: z.string().nullable(),
  number: z.number().nullable(),
  boolean: z.boolean().nullable(),
  emailAddress: z.object({ name: z.string(), address: z.string() }).nullable(),
}

type FieldSchema = (typeof fieldSchemas)[keyof typeof fieldSchemas]
type ResourceItem = Record<string, z.output<FieldSchema>>

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : null
}

export function microsoftGraphResourceSchemas(row: MicrosoftGraphResource) {
  const filters: Record<string, z.ZodType<string | undefined>> = {}
  for (const [name, filter] of Object.entries(row.filters)) filters[name] = filter.schema
  const { top } = row.graph
  const shape: Record<string, FieldSchema> = {}
  for (const [key, field] of Object.entries(row.fields)) shape[key] = fieldSchemas[field.type]
  const item = z.object(shape)
  return {
    params: z.object(row.params),
    query: z.object({
      ...filters,
      ...(row.output.kind === "list" ? { pageToken: pageTokenSchema } : {}),
      ...(top ? { maxResults: z.coerce.number().int().min(1).max(top.max).default(top.default).describe(`Maximum per page (default ${top.default}).`) } : {}),
    }),
    response: row.output.kind === "list"
      ? z.object({ ok: z.literal(true), [row.output.key]: z.array(item), ...pagingResponseFields })
      : z.object({ ok: z.literal(true), [row.output.key]: item }),
  }
}

export async function readMicrosoftGraphResource(
  graph: MicrosoftGraphClient,
  row: MicrosoftGraphResource,
  params: Record<string, string>,
  query: Record<string, unknown>,
) {
  const path = row.graph.path.replace(/\{(\w+)\}/g, (_, key: string) => encodeURIComponent(row.params[key].parse(params[key])))
  const queryParams = new URLSearchParams()
  if (row.graph.select) queryParams.set("$select", [...new Set(Object.values(row.fields).map(({ from }) => from))].join(","))
  if (row.graph.top) queryParams.set("$top", String(query.maxResults ?? row.graph.top.default))
  if (row.graph.count) queryParams.set("$count", "true")
  if (row.graph.orderBy) queryParams.set("$orderby", row.graph.orderBy)
  const clauses = []
  for (const [name, filter] of Object.entries(row.filters)) {
    const value = query[name]
    if (filter.effect === "whenTrue" && value === "true") clauses.push(filter.clause)
    if (filter.effect === "quotedSearch" && typeof value === "string") {
      queryParams.set("$search", `"${filter.property}:${value.replace(/["\\]/g, "")}"`)
    }
  }
  if (clauses.length) queryParams.set("$filter", clauses.join(" and "))
  function map(raw: Record<string, unknown>): ResourceItem {
    const item: ResourceItem = {}
    for (const [key, field] of Object.entries(row.fields)) {
      const value = raw[field.from]
      if (field.type === "emailAddress") {
        const email = record(record(value)?.emailAddress)
        item[key] = email && typeof email.address === "string" && email.address ? {
          name: typeof email.name === "string" ? email.name : "",
          address: email.address,
        } : null
      } else {
        const parsed = fieldSchemas[field.type].safeParse(value)
        item[key] = parsed.success ? parsed.data : null
      }
    }
    return item
  }
  const request = { path, query: queryParams, headers: row.graph.headers }
  if (row.output.kind === "item") {
    const item = await graph.readResourceItem(row.summary, request)
    return { ok: true, [row.output.key]: map(item) }
  }
  const { items, nextPageToken, hasMore } = await graph.readResourcePage(row.summary, row.operationId, request, typeof query.pageToken === "string" ? query.pageToken : undefined)
  return { ok: true, [row.output.key]: items.map(map), nextPageToken, hasMore }
}
