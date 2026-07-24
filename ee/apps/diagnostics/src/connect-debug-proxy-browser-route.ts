import { parseConnectDebugProxyScenario } from "./connect-debug-proxy-scenarios"

export const CONNECT_DEBUG_PROXY_BROWSER_ROUTE_COOKIE = "openwork_connect_debug_route"
export const CONNECT_DEBUG_PROXY_BROWSER_ROUTE_SECONDS = 10 * 60

function validProxyPath(value: string): boolean {
  const segments = value.split("/").filter(Boolean)
  if (segments.length < 3 || segments.length > 4 || segments[0] !== "via") return false
  if (!parseConnectDebugProxyScenario(segments[1] ?? "")) return false
  if (!/^[A-Za-z0-9._~-]+$/u.test(segments[2] ?? "")) return false
  return segments.length === 3 || /^~[A-Za-z0-9_-]+$/u.test(segments[3] ?? "")
}

function cookieValue(cookieHeader: string | null | undefined, name: string): string | null {
  for (const part of cookieHeader?.split(";") ?? []) {
    const separator = part.indexOf("=")
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue
    return part.slice(separator + 1).trim()
  }
  return null
}

export function readConnectDebugProxyBrowserRoute(cookieHeader: string | null | undefined): string | null {
  const encoded = cookieValue(cookieHeader, CONNECT_DEBUG_PROXY_BROWSER_ROUTE_COOKIE)
  if (!encoded) return null
  try {
    const path = decodeURIComponent(encoded)
    return validProxyPath(path) ? path : null
  } catch {
    return null
  }
}

export function stripConnectDebugProxyBrowserRouteCookie(cookieHeader: string): string {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && part.split("=", 1)[0] !== CONNECT_DEBUG_PROXY_BROWSER_ROUTE_COOKIE)
    .join("; ")
}

export function connectDebugProxyBrowserRouteCookie(proxyBase: string): string {
  const url = new URL(proxyBase)
  const secure = url.protocol === "https:" ? "; Secure" : ""
  return `${CONNECT_DEBUG_PROXY_BROWSER_ROUTE_COOKIE}=${encodeURIComponent(url.pathname)}; Path=/; Max-Age=${CONNECT_DEBUG_PROXY_BROWSER_ROUTE_SECONDS}; HttpOnly; SameSite=Lax${secure}`
}
