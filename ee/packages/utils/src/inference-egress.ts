import { lookup } from "node:dns/promises"
import type { LookupAddress } from "node:dns"
import { isIP, type LookupFunction } from "node:net"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { Readable } from "node:stream"
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib"

// Node >=18.7 supports strategy; this workspace's older Node declaration omits
// the second argument. Byte sizing is essential (the default counts chunks).
const toWeb: (stream: Readable, options: { strategy: QueuingStrategy<Uint8Array> }) => ReturnType<typeof Readable.toWeb> = Readable.toWeb

export class InferenceEgressError extends Error {
  constructor() { super("Inference egress destination is not permitted."); this.name = "InferenceEgressError" }
}

// Mirrors the existing managed-MCP guard's IPv4 exclusions. IPv6 is more
// conservative: only global unicast, excluding transition/special-use ranges.
export function isPublicInferenceAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0) || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113))
  }
  if (isIP(address) !== 6 || address.includes("%")) return false
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1)
  const [first, second] = canonical.split(":").map((word) => parseInt(word || "0", 16))
  // Reject mapped, NAT64, 6to4, Teredo, ULA, local, multicast and documentation.
  return (first & 0xe000) === 0x2000 && first !== 0x2002
    && !(first === 0x2001 && (second < 0x200 || second === 0xdb8))
    && !(first === 0x3fff && second < 0x1000)
}

/** Operator-owned CSV; GATEWAY_* replaces the deprecated INFERENCE_* alias, never unions it. */
export function inferenceEgressAllowedOrigins(value = process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS ?? process.env.INFERENCE_EGRESS_ALLOWED_ORIGINS ?? ""): ReadonlySet<string> {
  const origins = new Set<string>()
  for (const item of value.split(",").map((entry) => entry.trim()).filter(Boolean)) {
    const url = new URL(item)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hostname.includes("*")
      || url.href.includes("?") || url.href.includes("#") || url.pathname !== "/" || item.replace(/\/$/, "") !== url.origin) throw new InferenceEgressError()
    origins.add(url.origin)
  }
  return origins
}

/** Structural check only. DNS safety requires createInferenceEgressFetch. */
export function validateInferenceUrl(input: string | URL, options: { base?: boolean; allowedOrigins?: ReadonlySet<string> } = {}): URL {
  let url: URL
  try { url = new URL(input) } catch { throw new InferenceEgressError() }
  const trusted = (options.allowedOrigins ?? inferenceEgressAllowedOrigins()).has(url.origin)
  if (url.username || url.password || url.href.includes("#") || (options.base && url.href.includes("?"))
    || (url.protocol !== "https:" && !(trusted && url.protocol === "http:"))) throw new InferenceEgressError()
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (!trusted && (host === "localhost" || host.endsWith(".localhost") || (isIP(host) && !isPublicInferenceAddress(host)))) throw new InferenceEgressError()
  return url
}

export type InferenceAddressResolver = (hostname: string) => Promise<LookupAddress[]>

/** The returned, validated DNS answers are the addresses net.connect consumes. */
export function createInferenceLookup(resolver: InferenceAddressResolver = (host) => lookup(host, { all: true, verbatim: true }), trusted = false): LookupFunction {
  return (hostname, options, callback) => {
    void resolver(hostname).then((addresses) => {
      if (!addresses.length || (!trusted && addresses.some(({ address }) => !isPublicInferenceAddress(address)))) {
        callback(new InferenceEgressError(), [])
      } else if (options.all) callback(null, addresses)
      else callback(null, addresses[0].address, addresses[0].family)
    }, () => callback(new InferenceEgressError(), []))
  }
}

/**
 * Node transport, not resolve/check followed by global fetch. Each connection
 * uses guarded DNS; literal IPs are checked before connecting. HTTPS retains
 * normal certificate/hostname verification. No redirects, including same-origin.
 * Agent pooling is disabled so an exception cannot leak into a later request.
 */
export function createInferenceEgressFetch(options: { allowedOrigins?: ReadonlySet<string>; resolver?: InferenceAddressResolver } = {}): typeof fetch {
  const allowedOrigins = options.allowedOrigins ?? inferenceEgressAllowedOrigins()
  return async (input, init) => {
    const request = new Request(input, init)
    const url = validateInferenceUrl(request.url, { allowedOrigins })
    request.signal.throwIfAborted()
    const headers = new Headers(request.headers)
    for (const name of ["host", "connection", "transfer-encoding", "content-length"]) headers.delete(name)
    headers.set("accept-encoding", "identity")
    return new Promise<Response>((resolve, reject) => {
      const outgoing = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method: request.method,
        headers: Object.fromEntries(headers),
        signal: request.signal,
        agent: false,
        lookup: createInferenceLookup(options.resolver, allowedOrigins.has(url.origin)),
      }, (incoming) => {
        const status = incoming.statusCode ?? 502
        if ([301, 302, 303, 307, 308].includes(status)) {
          incoming.destroy()
          reject(new InferenceEgressError())
          return
        }
        const responseHeaders = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) value.forEach((entry) => responseHeaders.append(name, entry))
          else if (value !== undefined) responseHeaders.set(name, value)
        }
        if (request.method === "HEAD" || [204, 205, 304].includes(status)) {
          incoming.destroy()
          resolve(new Response(null, { status, headers: responseHeaders }))
          return
        }
        const encoding = responseHeaders.get("content-encoding")
        const decompressor = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : null
        if (decompressor) {
          responseHeaders.delete("content-encoding")
          responseHeaders.delete("content-length")
          incoming.on("error", () => decompressor.destroy(new Error("Upstream body failed")))
          decompressor.on("close", () => incoming.destroy())
        }
        // Node and DOM declare distinct but compatible web-stream types.
        const body = toWeb(decompressor ? incoming.pipe(decompressor) : incoming, {
          strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
        }) as ReadableStream<Uint8Array>
        resolve(new Response(body, { status, headers: responseHeaders }))
      })
      outgoing.on("error", () => reject(new Error("Inference upstream transport failed")))
      if (!request.body) outgoing.end()
      else {
        const reader = request.body.getReader()
        outgoing.on("close", () => { void reader.cancel().catch(() => {}) })
        void (async () => {
          try {
            while (true) {
              const chunk = await reader.read()
              if (chunk.done) break
              if (!outgoing.write(chunk.value)) await new Promise<void>((resolveDrain, rejectDrain) => {
                const close = () => { outgoing.off("drain", drain); rejectDrain(new Error("Transport closed")) }
                const drain = () => { outgoing.off("close", close); resolveDrain() }
                outgoing.once("drain", drain)
                outgoing.once("close", close)
              })
            }
            outgoing.end()
          } catch { outgoing.destroy(new Error("Inference request body failed")) }
        })()
      }
    })
  }
}
