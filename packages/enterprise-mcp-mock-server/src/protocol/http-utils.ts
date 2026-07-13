import type { IncomingMessage, ServerResponse } from "node:http"
import { z } from "zod"

const maximumRequestBytes = 1024 * 1024

export class HttpInputError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "HttpInputError"
    this.status = status
  }
}

export async function readBody(request: IncomingMessage): Promise<string> {
  request.setEncoding("utf8")
  const chunks: string[] = []
  let totalBytes = 0
  for await (const chunkValue of request) {
    const chunk = typeof chunkValue === "string" ? chunkValue : String(chunkValue)
    totalBytes += Buffer.byteLength(chunk, "utf8")
    if (totalBytes > maximumRequestBytes) {
      request.resume()
      throw new HttpInputError(413, "Request body exceeds the 1 MiB test-server limit")
    }
    chunks.push(chunk)
  }
  return chunks.join("")
}

export async function readJson(request: IncomingMessage): Promise<unknown> {
  if (mediaType(request.headers["content-type"]) !== "application/json") {
    throw new HttpInputError(415, "Content-Type must be application/json")
  }
  const body = await readBody(request)
  try {
    const parsed: unknown = JSON.parse(body)
    return parsed
  } catch {
    throw new HttpInputError(400, "Request body is not valid JSON")
  }
}

export async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  if (mediaType(request.headers["content-type"]) !== "application/x-www-form-urlencoded") {
    throw new HttpInputError(415, "Content-Type must be application/x-www-form-urlencoded")
  }
  return new URLSearchParams(await readBody(request))
}

export function acceptedMediaTypes(header: string | readonly string[] | undefined): ReadonlySet<string> {
  const values: readonly string[] = typeof header === "string" ? [header] : header ?? []
  const accepted = new Set<string>()
  for (const entry of values.flatMap((value) => value.split(","))) {
    const [rawType, ...parameters] = entry.split(";")
    const type = rawType?.trim().toLowerCase() ?? ""
    if (!type) continue
    const qualityParameter = parameters.map((value) => value.trim()).find((value) => /^q\s*=/i.test(value))
    if (qualityParameter) {
      const quality = Number(qualityParameter.split("=", 2)[1]?.trim())
      if (!Number.isFinite(quality) || quality <= 0 || quality > 1) continue
    }
    accepted.add(type)
  }
  return accepted
}

function mediaType(header: string | readonly string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? ""
}

export function sendJson(response: ServerResponse, status: number, body: unknown, headers?: Readonly<Record<string, string>>): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  })
  response.end(JSON.stringify(body))
}

export function sendSse(response: ServerResponse, body: unknown, headers?: Readonly<Record<string, string>>): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "close",
    ...headers,
  })
  response.end(`event: message\ndata: ${JSON.stringify(body)}\n\n`)
}

export function sendOAuthError(response: ServerResponse, status: number, error: string, description: string): void {
  sendJson(response, status, { error, error_description: description })
}

export function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location, "cache-control": "no-store" })
  response.end()
}

export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number().finite()]).optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
})

export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>

export function jsonRpcResult(id: string | number, result: unknown): unknown {
  return { jsonrpc: "2.0", id, result }
}

export function jsonRpcError(id: string | number | null, code: number, message: string, data?: unknown): unknown {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } }
}

export function requestUrl(request: IncomingMessage, baseUrl: string): URL {
  return new URL(request.url ?? "/", baseUrl)
}
