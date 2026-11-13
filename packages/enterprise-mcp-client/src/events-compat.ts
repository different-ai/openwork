import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { z } from "zod"
import type { EnterpriseMcpFetch } from "./contracts.js"

const EVENTS_EXTENSION = "io.modelcontextprotocol/events"
const objectSchema = z.record(z.string(), z.unknown())
const capabilitiesSchema = z.object({ events: objectSchema.optional(), extensions: z.record(z.string(), objectSchema).optional() })
const initializeResponseSchema = z.object({ result: z.object({ protocolVersion: z.string(), capabilities: z.unknown() }) })
const eventRequestSchema = z.object({
  method: z.enum(["events/list", "events/subscribe", "events/unsubscribe"]),
  params: z.object({ name: z.string().optional() }).optional(),
})

export function advertisesEvents(capabilities: unknown): boolean {
  const parsed = capabilitiesSchema.safeParse(capabilities)
  return parsed.success && (parsed.data.events !== undefined || parsed.data.extensions?.[EVENTS_EXTENSION] !== undefined)
}

/** The SDK strips the legacy `events` key after transport decoding, for JSON and SSE alike. */
export function observeLegacyEventCapability(transport: StreamableHTTPClientTransport): () => boolean {
  let advertised = false
  const previous = transport.onmessage
  transport.onmessage = (message) => {
    const parsed = initializeResponseSchema.safeParse(message)
    if (parsed.success) advertised = advertisesEvents(parsed.data.result.capabilities)
    previous?.(message)
  }
  return () => advertised
}

/** SEP-2243 field-value encoding, including escaping literal Base64 sentinels. */
function encodedName(name: string): string {
  const plain = name.length > 0 && name === name.trim() && /^[\x20-\x7e\t]+$/.test(name)
    && !(name.startsWith("=?base64?") && name.endsWith("?="))
  return plain ? name : `=?base64?${Buffer.from(name, "utf8").toString("base64")}?=`
}

/** The SDK's routing-header table does not yet include the Events extension. */
export function withEventRoutingHeaders(fetch: EnterpriseMcpFetch): EnterpriseMcpFetch {
  return (url, init) => {
    if (init?.method !== "POST" || typeof init.body !== "string") return fetch(url, init)
    let body: unknown
    try { body = JSON.parse(init.body) } catch { return fetch(url, init) }
    const parsed = eventRequestSchema.safeParse(body)
    if (!parsed.success) return fetch(url, init)
    const headers = new Headers(init.headers)
    headers.set("Mcp-Method", parsed.data.method)
    if (parsed.data.method !== "events/list" && parsed.data.params?.name !== undefined) {
      headers.set("Mcp-Name", encodedName(parsed.data.params.name))
    }
    return fetch(url, { ...init, headers })
  }
}
