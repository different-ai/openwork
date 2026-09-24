import type { App } from "@modelcontextprotocol/ext-apps"
import { z } from "zod"

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type ToolResult = {
  structuredContent?: unknown
  content?: readonly { type: string; text?: string }[]
  isError?: boolean
}

export function parseToolResult<Schema extends z.ZodType>(
  schema: Schema,
  result: ToolResult,
  acceptError?: (payload: z.infer<Schema>) => boolean,
): z.infer<Schema> {
  const candidates: unknown[] = [result.structuredContent]
  for (const item of result.content ?? []) {
    if (item.type !== "text" || !item.text) continue
    try { candidates.push(JSON.parse(item.text)) } catch {}
  }
  for (const candidate of candidates) {
    const parsed = schema.safeParse(candidate)
    if (!parsed.success) continue
    if (result.isError && !acceptError?.(parsed.data)) throw new Error("The tool failed. Try again in the conversation.")
    return parsed.data
  }
  throw new Error("No valid result received. Try again in the conversation.")
}

export function toolResultHandlers<Schema extends z.ZodType>(
  schema: Schema,
  onPayload: (payload: z.infer<Schema>) => void,
  onError: (message: string) => void,
  acceptError?: (payload: z.infer<Schema>) => boolean,
) {
  return {
    ontoolresult(result: ToolResult) {
      try { onPayload(parseToolResult(schema, result, acceptError)) } catch (cause) {
        onError(cause instanceof Error ? cause.message : "The result could not be read.")
      }
    },
    ontoolcancelled() { onError("Cancelled") },
  }
}

export const safeLinkSchema = z.string().url().refine(value => {
  const url = new URL(value)
  return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
}, "The connection did not provide a safe setup link.")

export async function callTool(app: Pick<App, "callServerTool">, name: string, args: Record<string, JsonValue>) {
  const result = await app.callServerTool({ name, arguments: args })
  if (result.isError) throw new Error("The action did not complete. Check the connection before trying again.")
  return result
}

export async function openLink(app: Pick<App, "openLink">, url: string) {
  const result = await app.openLink({ url: safeLinkSchema.parse(url) })
  if (result.isError) throw new Error("The link could not be opened. Open connections to continue.")
}
