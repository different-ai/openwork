import { Agent, fetch as undiciFetch } from "undici"

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

const connectPhaseErrorCodes = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ECONNRESET",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function isConnectPhaseError(error: unknown): boolean {
  let current = error
  const visited = new Set<object>()

  while (isRecord(current) && !visited.has(current)) {
    visited.add(current)
    if ((typeof current.code === "string" && connectPhaseErrorCodes.has(current.code)) || current.name === "ConnectTimeoutError") {
      return true
    }
    current = current.cause
  }

  return false
}

export async function fetchWithConnectRetry(input: {
  fetchImpl: FetchLike
  url: string
  init: RequestInit
  retries?: number
}): Promise<Response> {
  let retriesRemaining = input.retries ?? 1

  while (true) {
    try {
      return await input.fetchImpl(input.url, input.init)
    } catch (error) {
      if (!isConnectPhaseError(error) || retriesRemaining <= 0) {
        throw error
      }
      retriesRemaining -= 1
    }
  }
}

export function fetchPreviewNoRedirect(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetchImpl(url, { ...init, redirect: "error" })
}

export function createPreviewFetch(options: { connectTimeoutMs: number }): FetchLike {
  const agent = new Agent({
    connect: {
      timeout: options.connectTimeoutMs,
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 300,
    },
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 300_000,
    headersTimeout: 15_000,
    bodyTimeout: 30_000,
  })

  return async (url, init) => {
    const request = new Request(url, init)
    const headers: Record<string, string> = {}
    request.headers.forEach((value, name) => {
      headers[name] = value
    })
    const response = await undiciFetch(url, {
      method: request.method,
      headers,
      body: request.body ? await request.arrayBuffer() : undefined,
      redirect: "error",
      signal: request.signal,
      dispatcher: agent,
    })
    const responseHeaders = new Headers()
    response.headers.forEach((value, name) => {
      responseHeaders.append(name, value)
    })
    let body: ReadableStream<Uint8Array> | null = null
    if (response.body) {
      const reader = response.body.getReader()
      body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const chunk = await reader.read()
          if (chunk.done) {
            controller.close()
            return
          }
          controller.enqueue(chunk.value)
        },
        cancel(reason: unknown) {
          return reader.cancel(reason)
        },
      })
    }

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    })
  }
}

let sharedPreviewFetch: FetchLike | undefined

export function previewFetch(): FetchLike {
  sharedPreviewFetch ??= createPreviewFetch({ connectTimeoutMs: 3_000 })
  return sharedPreviewFetch
}
