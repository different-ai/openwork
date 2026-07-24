import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { diagnosticsConfig, validateProductionConfig } from "./src/config"
import { DASHBOARD_SESSION_COOKIE, verifyDashboardSession } from "./src/dashboard-auth"
import {
  CONNECT_DEBUG_PROXY_BROWSER_ROUTE_COOKIE,
  readConnectDebugProxyBrowserRoute,
} from "./src/connect-debug-proxy-browser-route"

export function proxy(request: NextRequest): NextResponse {
  const missing = validateProductionConfig()
  if (missing.length > 0) {
    return NextResponse.json({ error: "diagnostics_not_configured", missing }, { status: 503 })
  }
  const pathname = request.nextUrl.pathname
  if (pathname.startsWith("/debug-proxy/")) {
    const response = NextResponse.next()
    response.cookies.delete(CONNECT_DEBUG_PROXY_BROWSER_ROUTE_COOKIE)
    return response
  }
  const browserRoute = readConnectDebugProxyBrowserRoute(request.headers.get("cookie"))
  if (browserRoute && !pathname.startsWith("/via/")) {
    const target = request.nextUrl.clone()
    target.pathname = `${browserRoute}${pathname}`
    return NextResponse.rewrite(target)
  }
  const dashboardProtected = pathname === "/"
    || pathname === "/connections"
    || pathname.startsWith("/api/history")
    || pathname.startsWith("/api/connections/identity")
    || (pathname.startsWith("/api/connections/incidents") && request.method === "GET")
  if (!dashboardProtected) return NextResponse.next()
  const expected = diagnosticsConfig()
  const session = request.cookies.get(DASHBOARD_SESSION_COOKIE)?.value
  if (!session || !verifyDashboardSession(session, expected)) {
    if (request.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "diagnostics_admin_authentication_required" },
        { headers: { "cache-control": "no-store" }, status: 401 },
      )
    }
    const login = new URL("/login", request.url)
    login.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`)
    const response = NextResponse.redirect(login)
    response.headers.set("cache-control", "no-store")
    return response
  }
  const response = NextResponse.next()
  response.headers.set("cache-control", "private, no-store")
  return response
}

export const config = { matcher: ["/:path*"] }
