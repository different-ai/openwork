import { createMcpSseTamperStream, tamperJsonRpcText } from "./connect-debug-proxy-tamper"
import type { McpTamperMode } from "./connect-debug-proxy-tamper"
import { CONNECT_DEBUG_PROXY_KEY_HEADER } from "./connect-debug-proxy-config"
import { stripConnectDebugProxyBrowserRouteCookie } from "./connect-debug-proxy-browser-route"

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

function upstreamReferenceReplacements(upstreamOrigin: string, proxyBase: string) {
  return [
    { replacement: proxyBase, search: upstreamOrigin },
    { replacement: encodeURIComponent(proxyBase), search: encodeURIComponent(upstreamOrigin) },
  ]
}

function replaceUpstreamOrigin(value: string, upstreamOrigin: string, proxyBase: string): string {
  return upstreamReferenceReplacements(upstreamOrigin, proxyBase)
    .reduce((result, { replacement, search }) => result.split(search).join(replacement), value)
}

function createTextReplacementStream(upstreamOrigin: string, proxyBase: string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const replacements = upstreamReferenceReplacements(upstreamOrigin, proxyBase)
  const longestSearch = Math.max(...replacements.map(({ search }) => search.length))
  let pending = ""
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true })
      while (true) {
        const match = replacements
          .map((candidate) => ({ ...candidate, index: pending.indexOf(candidate.search) }))
          .filter((candidate) => candidate.index >= 0)
          .sort((left, right) => left.index - right.index)[0]
        if (!match) break
        controller.enqueue(encoder.encode(`${pending.slice(0, match.index)}${match.replacement}`))
        pending = pending.slice(match.index + match.search.length)
      }
      const safeLength = Math.max(0, pending.length - longestSearch + 1)
      if (safeLength > 0) {
        controller.enqueue(encoder.encode(pending.slice(0, safeLength)))
        pending = pending.slice(safeLength)
      }
    },
    flush(controller) {
      pending += decoder.decode()
      if (pending) controller.enqueue(encoder.encode(replaceUpstreamOrigin(pending, upstreamOrigin, proxyBase)))
    },
  })
}

export function rewriteLocationHeader(location: string, upstreamRequestUrl: URL, proxyBase: string): string {
  const rewrittenReference = replaceUpstreamOrigin(location, upstreamRequestUrl.origin, proxyBase)
  if (rewrittenReference !== location) return rewrittenReference
  try {
    const resolved = new URL(location, upstreamRequestUrl)
    if (resolved.origin !== upstreamRequestUrl.origin) return location
    return `${proxyBase}${resolved.pathname}${resolved.search}${resolved.hash}`
  } catch {
    return location
  }
}

export function rewriteSetCookieHeader(cookie: string, proxyPath: string): string {
  return cookie
    .split(";")
    .map((part, index) => {
      const trimmed = part.trim()
      if (/^domain=/iu.test(trimmed)) return ""
      if (/^path=/iu.test(trimmed)) {
        const upstreamPath = trimmed.slice(5).trim()
        const suffix = upstreamPath === "/" ? "" : upstreamPath.startsWith("/") ? upstreamPath : `/${upstreamPath}`
        const basePath = proxyPath === "/" ? "" : proxyPath.replace(/\/+$/u, "")
        return `Path=${suffix ? `${basePath}${suffix}` : basePath || "/"}`
      }
      return index === 0 ? trimmed : ` ${trimmed}`
    })
    .filter(Boolean)
    .join(";")
}

export function forwardRequestHeaders(source: Headers, input?: { proxyBase: string; upstreamOrigin: string }): Headers {
  const headers = new Headers()
  source.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (lower === "cookie") {
      const cookie = stripConnectDebugProxyBrowserRouteCookie(value)
      if (cookie) headers.append(name, cookie)
    } else if (!hopByHopHeaders.has(lower) && lower !== "host" && lower !== "content-length"
      && lower !== "accept-encoding" && lower !== CONNECT_DEBUG_PROXY_KEY_HEADER) {
      headers.append(name, value)
    }
  })
  headers.set("accept-encoding", "identity")
  if (input) {
    const proxyOrigin = new URL(input.proxyBase).origin
    if (headers.get("origin") === proxyOrigin) headers.set("origin", input.upstreamOrigin)
    const referer = headers.get("referer")
    if (referer?.startsWith(input.proxyBase)) headers.set("referer", `${input.upstreamOrigin}${referer.slice(input.proxyBase.length)}`)
  }
  return headers
}

function responseHeaders(upstream: Response, upstreamRequestUrl: URL, proxyBase: string, transformed: boolean, browserRoute: boolean): Headers {
  const headers = new Headers()
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (hopByHopHeaders.has(lower) || lower === "set-cookie") return
    if (transformed && (lower === "content-length" || lower === "content-encoding" || lower === "etag")) return
    if (lower === "location") {
      headers.append(name, rewriteLocationHeader(value, upstreamRequestUrl, proxyBase))
    } else if (lower === "access-control-allow-origin" && value === upstreamRequestUrl.origin) {
      headers.append(name, new URL(proxyBase).origin)
    } else {
      headers.append(name, value)
    }
  })
  const proxyPath = browserRoute ? "/" : new URL(proxyBase).pathname
  for (const cookie of upstream.headers.getSetCookie()) headers.append("set-cookie", rewriteSetCookieHeader(cookie, proxyPath))
  return headers
}

export async function buildConnectDebugProxyResponse(input: {
  browserRoute?: boolean
  proxyBase: string
  tamperMode: McpTamperMode | null
  upstream: Response
  upstreamRequestUrl: URL
}): Promise<Response> {
  const contentType = input.upstream.headers.get("content-type")?.toLowerCase() ?? ""
  const isSse = contentType.includes("text/event-stream")
  const isJson = contentType.includes("application/json") || contentType.includes("application/problem+json")
  const isHtml = contentType.includes("text/html")
  const transformed = Boolean(input.tamperMode) || isJson || isHtml
  const headers = responseHeaders(input.upstream, input.upstreamRequestUrl, input.proxyBase, transformed, Boolean(input.browserRoute))
  if (input.tamperMode === "bad-protocol") headers.set("mcp-protocol-version", "1900-01-01")
  if (!input.upstream.body) {
    return new Response(null, { headers, status: input.upstream.status, statusText: input.upstream.statusText })
  }
  if (isSse) {
    const body = input.tamperMode
      ? input.upstream.body.pipeThrough(createMcpSseTamperStream(input.tamperMode))
      : input.upstream.body
    return new Response(body, { headers, status: input.upstream.status, statusText: input.upstream.statusText })
  }
  if (input.tamperMode) {
    let body = await input.upstream.text()
    body = tamperJsonRpcText(body, input.tamperMode)
    body = replaceUpstreamOrigin(body, input.upstreamRequestUrl.origin, input.proxyBase)
    return new Response(body, { headers, status: input.upstream.status, statusText: input.upstream.statusText })
  }
  if (isJson || isHtml) {
    const body = input.upstream.body.pipeThrough(createTextReplacementStream(input.upstreamRequestUrl.origin, input.proxyBase))
    return new Response(body, { headers, status: input.upstream.status, statusText: input.upstream.statusText })
  }
  return new Response(input.upstream.body, { headers, status: input.upstream.status, statusText: input.upstream.statusText })
}
