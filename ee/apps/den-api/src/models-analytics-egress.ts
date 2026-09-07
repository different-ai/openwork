import { lookup } from "node:dns/promises"
import { request } from "node:https"
import { isIP } from "node:net"
import { checkServerIdentity } from "node:tls"
import { isPrivateAddress } from "./capability-sources/url-guard.js"

/** Resolve once, connect to that public IP, and verify TLS against the original host. */
export async function postModelsAnalytics(url: URL, headers: Record<string, string>, body: string): Promise<unknown> {
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("invalid_export_address")
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  const deadline = Date.now() + 5_000
  const addresses = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("export_dns_timeout")), 5_000)
    const resolution = isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }]) : lookup(hostname, { all: true, verbatim: true })
    void resolution.then(resolve, reject).finally(() => clearTimeout(timer))
  })
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error("private_export_address")
  const destination = addresses.find(({ family }) => family === 4) ?? addresses[0]
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: destination.address, family: destination.family, port: url.port || 443,
      servername: isIP(hostname) ? undefined : hostname,
      checkServerIdentity: (_name, certificate) => checkServerIdentity(hostname, certificate),
      path: `${url.pathname}${url.search}`, method: "POST", agent: false,
      headers: { ...headers, Host: url.host }, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    }, (res) => {
      // No redirects, and no unbounded response bodies from user-supplied hosts.
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.destroy(); reject(new Error("export_unavailable")); return
      }
      res.setEncoding("utf8")
      let text = ""
      let bytes = 0
      res.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk)
        if (bytes > 65_536) { res.destroy(new Error("export_response_too_large")); return }
        text += chunk
      })
      res.on("error", reject)
      res.on("end", () => {
        try { resolve(JSON.parse(text)) }
        catch { reject(new Error("invalid_export_acknowledgement")) }
      })
    })
    req.on("error", reject)
    req.end(body)
  })
}
