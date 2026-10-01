import { isIP } from "node:net"
import { CloudBrowserError } from "./contract"

/**
 * Which addresses the agent may open. Only public http(s) websites: no
 * credentials in the address, no browser-internal or script schemes, and no
 * loopback, private, link-local or otherwise internal hosts (the browser's own
 * DevTools port and cloud metadata services live there).
 *
 * The WHATWG parser canonicalizes numeric and hex IPv4 forms
 * (`http://2130706433/` becomes `127.0.0.1`), so checks run on the parsed host.
 * Hostnames that resolve to private addresses (DNS rebinding) are out of scope
 * here; the box's own network isolation covers them.
 */

const MAX_URL_LENGTH = 4_096
const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet", ".corp"]

function ipv4Octets(host: string): number[] | null {
  if (isIP(host) !== 4) return null
  return host.split(".").map((part) => Number(part))
}

function isBlockedIpv4(octets: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets
  if (a === 0 || a === 10 || a === 127) return true // this network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT
  if (a === 169 && b === 254) return true // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 168) return true // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true // IETF protocol assignments, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a === 198 && b === 51 && c === 100) return true // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true // TEST-NET-3
  return a >= 224 // multicast, reserved, broadcast
}

/** The eight 16-bit groups of an IPv6 literal, or `null`. */
function ipv6Words(host: string): number[] | null {
  if (isIP(host) !== 6) return null
  let text = host
  const tail: number[] = []
  const lastColon = text.lastIndexOf(":")
  const v4 = ipv4Octets(text.slice(lastColon + 1))
  if (v4) {
    tail.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0))
    text = text.slice(0, lastColon + 1)
    if (!text.endsWith("::")) text = text.slice(0, -1)
  }
  const halves = text.split("::")
  if (halves.length > 2) return null
  const groups = (part: string) => (part ? part.split(":").map((group) => Number.parseInt(group, 16)) : [])
  const head = groups(halves[0] ?? "")
  const rest = halves.length === 2 ? groups(halves[1] ?? "") : []
  const known = head.length + rest.length + tail.length
  if (known > 8 || (halves.length === 1 && known !== 8)) return null
  const words = [...head, ...Array.from({ length: halves.length === 2 ? 8 - known : 0 }, () => 0), ...rest, ...tail]
  return words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff) ? words : null
}

function isBlockedIpv6(words: readonly number[]): boolean {
  const [w0 = 0, , , , , w5 = 0, w6 = 0, w7 = 0] = words
  if (words.every((word) => word === 0)) return true // unspecified
  if (words.slice(0, 7).every((word) => word === 0) && w7 === 1) return true // loopback
  if (words.slice(0, 5).every((word) => word === 0) && w5 === 0xffff) {
    return isBlockedIpv4([w6 >> 8, w6 & 0xff, w7 >> 8, w7 & 0xff]) // IPv4-mapped
  }
  if ((w0 & 0xfe00) === 0xfc00) return true // unique local
  if ((w0 & 0xffc0) === 0xfe80) return true // link-local
  if ((w0 & 0xff00) === 0xff00) return true // multicast
  return w0 === 0x2001 && words[1] === 0x0db8 // documentation
}

/** Whether `host` (a parsed URL hostname) points inside a private network. */
export function isInternalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
  if (!host) return true
  if (host === "localhost" || INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true
  const v4 = ipv4Octets(host)
  if (v4) return isBlockedIpv4(v4)
  const v6 = ipv6Words(host)
  if (v6) return isBlockedIpv6(v6)
  if (host.includes(":")) return true
  // A single label ("intranet", "router") only resolves on a private network.
  return !host.includes(".")
}

/** Parses an address the agent asked to open; throws `invalid_url` or `blocked_url`. */
export function parseNavigableUrl(value: string): URL {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) {
    throw new CloudBrowserError("invalid_url", "Use a complete http or https website address.")
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new CloudBrowserError("invalid_url", "Use a complete http or https website address.")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CloudBrowserError("invalid_url", "Only http and https websites can be opened.")
  }
  if (url.username || url.password) {
    throw new CloudBrowserError("invalid_url", "Remove the user name or password from the address.")
  }
  if (isInternalHost(url.hostname)) {
    throw new CloudBrowserError("blocked_url", "Private, local and internal network addresses can't be opened.")
  }
  return url
}

/** True for pages the agent may read: public websites and the blank start page. */
export function isReadableUrl(value: string): boolean {
  if (value === "" || value === "about:blank") return true
  try {
    parseNavigableUrl(value)
    return true
  } catch {
    return false
  }
}

/** Origin and path only: queries and fragments can carry tokens. */
export function displayUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol === "http:" || url.protocol === "https:") return `${url.origin}${url.pathname}`
    return url.href === "about:blank" ? "about:blank" : ""
  } catch {
    return ""
  }
}
