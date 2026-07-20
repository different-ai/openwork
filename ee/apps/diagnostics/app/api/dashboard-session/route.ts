import { NextResponse } from "next/server"
import { diagnosticsConfig, validateProductionConfig } from "../../../src/config"
import {
  DASHBOARD_SESSION_COOKIE,
  DASHBOARD_SESSION_LIFETIME_SECONDS,
  createDashboardSession,
  dashboardCredentialsAuthorized,
} from "../../../src/dashboard-auth"

function safeNext(value: FormDataEntryValue | null): string {
  if (typeof value !== "string") return "/"
  return value === "/" || value.startsWith("/?") ? value : "/"
}

function firstForwardedValue(value: string | null): string | null {
  return value?.split(",")[0]?.trim() || null
}

function requestPublicOrigin(request: Request): string {
  const internal = new URL(request.url)
  const host = firstForwardedValue(request.headers.get("x-forwarded-host"))
    ?? request.headers.get("host")
    ?? internal.host
  const protocol = firstForwardedValue(request.headers.get("x-forwarded-proto"))
    ?? internal.protocol.slice(0, -1)
  return `${protocol}://${host}`
}

function redirect(request: Request, pathname: string): NextResponse {
  const response = NextResponse.redirect(new URL(pathname, requestPublicOrigin(request)), 303)
  response.headers.set("cache-control", "no-store")
  return response
}

function matchesOrigin(value: string, expectedOrigin: string): boolean {
  try {
    return new URL(value).origin === expectedOrigin
  } catch {
    return false
  }
}

function requestOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("origin")
  if (!origin) return true
  const expectedOrigin = requestPublicOrigin(request)
  if (origin !== "null") return matchesOrigin(origin, expectedOrigin)

  const referrer = request.headers.get("referer")
  return Boolean(referrer && matchesOrigin(referrer, expectedOrigin))
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!requestOriginAllowed(request)) {
    return NextResponse.json({ error: "invalid_request_origin" }, { status: 403 })
  }
  const missing = validateProductionConfig()
  if (missing.length > 0) {
    return NextResponse.json({ error: "diagnostics_not_configured", missing }, { status: 503 })
  }
  const form = await request.formData()
  if (form.get("intent") === "logout") {
    const response = redirect(request, "/login")
    response.cookies.set(DASHBOARD_SESSION_COOKIE, "", {
      httpOnly: true,
      maxAge: 0,
      path: "/",
      sameSite: "strict",
      secure: requestPublicOrigin(request).startsWith("https://") || Boolean(process.env.VERCEL),
    })
    return response
  }

  const username = form.get("username")
  const password = form.get("password")
  const config = diagnosticsConfig()
  if (typeof username !== "string" || typeof password !== "string"
    || !dashboardCredentialsAuthorized(username, password, config)) {
    const next = safeNext(form.get("next"))
    const target = new URL("/login", requestPublicOrigin(request))
    target.searchParams.set("error", "invalid")
    target.searchParams.set("next", next)
    return redirect(request, `${target.pathname}${target.search}`)
  }

  const response = redirect(request, safeNext(form.get("next")))
  response.cookies.set(DASHBOARD_SESSION_COOKIE, createDashboardSession(config), {
    httpOnly: true,
    maxAge: DASHBOARD_SESSION_LIFETIME_SECONDS,
    path: "/",
    sameSite: "strict",
    secure: requestPublicOrigin(request).startsWith("https://") || Boolean(process.env.VERCEL),
  })
  return response
}
