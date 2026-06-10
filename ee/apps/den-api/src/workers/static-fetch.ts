import { request as httpRequest } from "node:http"

function headersToRecord(headers: HeadersInit | undefined) {
  return Object.fromEntries(new Headers(headers).entries())
}

function responseHeadersToEntries(headers: Record<string, string | string[] | undefined>) {
  const entries: [string, string][] = []
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) entries.push([key, item])
    } else if (value !== undefined) {
      entries.push([key, value])
    }
  }
  return entries
}

function concatChunks(chunks: Uint8Array[]) {
  const totalLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const output = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

export async function fetchStaticHttpTarget(url: string, init: RequestInit = {}) {
  const parsed = new URL(url)
  const headers = headersToRecord(init.headers)
  const hostHeader = headers.host ?? headers.Host
  if (parsed.protocol !== "http:" || !hostHeader) {
    return fetch(url, init)
  }

  return new Promise<Response>((resolve, reject) => {
    const request = httpRequest({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: init.method ?? "GET",
      headers: { ...headers, Host: hostHeader },
      signal: init.signal ?? undefined,
    }, (response) => {
      const chunks: Uint8Array[] = []
      response.on("data", (chunk: Uint8Array) => chunks.push(chunk))
      response.on("end", () => {
        resolve(new Response(concatChunks(chunks), {
          status: response.statusCode ?? 502,
          statusText: response.statusMessage,
          headers: responseHeadersToEntries(response.headers),
        }))
      })
    })

    request.on("error", reject)
    if (typeof init.body === "string") {
      request.write(init.body)
    }
    request.end()
  })
}
