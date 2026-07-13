import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { diagnosticsConfig, validateProductionConfig } from "./src/config"
import { DASHBOARD_SESSION_COOKIE, verifyDashboardSession } from "./src/dashboard-auth"

export function proxy(request: NextRequest): NextResponse {
  const missing = validateProductionConfig()
  if (missing.length > 0) {
    return NextResponse.json({ error: "diagnostics_not_configured", missing }, { status: 503 })
  }
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

export const config = { matcher: ["/", "/api/history/:path*"] }
