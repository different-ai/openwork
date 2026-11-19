import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { env } from "../env.js"
import { isPrivateAddress } from "../capability-sources/url-guard.js"
import { NativeEventError } from "./protocol.js"

/** Resolve and pin on every delivery, retaining the original Host and TLS name; never follow a redirect. */
export async function postWebhook(urlValue: string, secret: string, subscriptionId: string, deliveryId: string, body: unknown, previousSecret?: string | null) {
  const url = new URL(urlValue)
  if (url.username || url.password || url.hash || !["https:", ...(env.allowPrivateMcpUrls ? ["http:"] : [])].includes(url.protocol)) throw new NativeEventError(-32602, "Invalid callback URL")
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true })
  if (!addresses.length || (!env.allowPrivateMcpUrls && addresses.some(value => isPrivateAddress(value.address)))) throw new NativeEventError(-32602, "Callback address is not allowed")
  const raw = JSON.stringify(body)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signatures = [secret, ...(previousSecret ? [previousSecret] : [])].map(key => `v1,${createHmac("sha256", new Uint8Array(Buffer.from(key.slice(6), "base64"))).update(`${deliveryId}.${timestamp}.${raw}`).digest("base64")}`).join(" ")
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)({
      hostname: addresses[0]!.address, port: url.port || (url.protocol === "https:" ? 443 : 80), servername: hostname,
      path: `${url.pathname}${url.search}`, method: "POST", signal: AbortSignal.timeout(5000), agent: false,
      headers: { host: url.host, "content-type": "application/json", "content-length": Buffer.byteLength(raw), "webhook-id": deliveryId, "webhook-timestamp": timestamp, "webhook-signature": signatures, "x-mcp-subscription-id": subscriptionId },
    }, response => {
      const chunks: Uint8Array[] = []
      let size = 0
      response.on("data", (chunk: Buffer) => {
        size += chunk.length
        if (size > 16_384) { response.destroy(new Error("Callback response too large")); return }
        chunks.push(new Uint8Array(chunk))
      })
      response.on("error", reject)
      response.on("end", () => resolve({ status: response.statusCode ?? 500, body: Buffer.concat(chunks).toString("utf8") }))
    })
    request.on("error", reject)
    request.end(raw)
  })
}

export async function verifyCallback(url: string, secret: string, subscriptionId: string) {
  const challenge = randomBytes(32).toString("hex")
  const response = await postWebhook(url, secret, subscriptionId, `msg_verification_${randomBytes(16).toString("hex")}`, { type: "verification", challenge })
  const body: unknown = JSON.parse(response.body)
  const echoed = typeof body === "object" && body !== null && "challenge" in body && typeof body.challenge === "string" ? body.challenge : ""
  const expected = new TextEncoder().encode(challenge)
  const received = new TextEncoder().encode(echoed)
  if (response.status < 200 || response.status >= 300 || expected.length !== received.length || !timingSafeEqual(expected, received)) throw new NativeEventError(-32027, "Callback verification failed", { reason: "challenge_failed" })
}
