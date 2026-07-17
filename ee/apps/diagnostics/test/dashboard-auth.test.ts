import { afterEach, describe, expect, test } from "bun:test"
import { NextRequest } from "next/server"
import { POST } from "../app/api/dashboard-session/route"
import { proxy } from "../proxy"
import {
  DASHBOARD_SESSION_COOKIE,
  DASHBOARD_SESSION_LIFETIME_SECONDS,
  createDashboardSession,
  dashboardCredentialsAuthorized,
  verifyDashboardSession,
} from "../src/dashboard-auth"

const originalEnvironment = { ...process.env }
const config = {
  adminPassword: "a-long-synthetic-dashboard-password",
  adminUsername: "diagnostics-test-admin",
  signingSecret: "a-synthetic-signing-secret-that-is-long-enough",
}

afterEach(() => {
  process.env = { ...originalEnvironment }
})

function configureLocalAuthentication(): void {
  delete process.env.VERCEL
  process.env.DIAGNOSTICS_ADMIN_PASSWORD = config.adminPassword
  process.env.DIAGNOSTICS_ADMIN_USERNAME = config.adminUsername
  process.env.DIAGNOSTICS_SIGNING_SECRET = config.signingSecret
}

function formRequest(body: Readonly<Record<string, string>>, origin = "http://localhost:3010"): Request {
  return new Request(`${origin}/api/dashboard-session`, {
    body: new URLSearchParams(body),
    headers: { "content-type": "application/x-www-form-urlencoded", origin },
    method: "POST",
  })
}

describe("Diagnostics dashboard authentication", () => {
  test("requires both environment-backed credentials", () => {
    expect(dashboardCredentialsAuthorized(config.adminUsername, config.adminPassword, config)).toBe(true)
    expect(dashboardCredentialsAuthorized("wrong", config.adminPassword, config)).toBe(false)
    expect(dashboardCredentialsAuthorized(config.adminUsername, "wrong", config)).toBe(false)
  })

  test("expires sessions and invalidates them when any administrator secret changes", () => {
    const now = Date.now()
    const session = createDashboardSession(config, now)

    expect(verifyDashboardSession(session, config, now)).toBe(true)
    expect(verifyDashboardSession(session, config, now + DASHBOARD_SESSION_LIFETIME_SECONDS * 1000 + 1)).toBe(false)
    expect(verifyDashboardSession(session, { ...config, adminUsername: "rotated-admin" }, now)).toBe(false)
    expect(verifyDashboardSession(session, { ...config, adminPassword: "rotated-password" }, now)).toBe(false)
    expect(verifyDashboardSession(session, { ...config, signingSecret: "rotated-signing-secret" }, now)).toBe(false)
  })

  test("sets a secure HTTP-only session and preserves a support-trace destination", async () => {
    configureLocalAuthentication()
    const response = await POST(new Request("http://0.0.0.0:3010/api/dashboard-session", {
      body: new URLSearchParams({
        next: "/?runId=4ab6c4c2-2b5d-4f85-83b7-137cc93acb57",
        password: config.adminPassword,
        username: config.adminUsername,
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://diagnostics.example",
        "x-forwarded-host": "diagnostics.example",
        "x-forwarded-proto": "https",
      },
      method: "POST",
    }))
    const cookie = response.headers.get("set-cookie") ?? ""

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("https://diagnostics.example/?runId=4ab6c4c2-2b5d-4f85-83b7-137cc93acb57")
    expect(cookie).toContain(`${DASHBOARD_SESSION_COOKIE}=`)
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=strict")
    expect(cookie).toContain("Secure")
    expect(cookie).toContain(`Max-Age=${DASHBOARD_SESSION_LIFETIME_SECONDS}`)
  })

  test("returns a generic error without a cookie for invalid credentials", async () => {
    configureLocalAuthentication()
    const response = await POST(formRequest({ next: "/", password: "wrong", username: config.adminUsername }))

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("http://localhost:3010/login?error=invalid&next=%2F")
    expect(response.headers.get("set-cookie")).toBeNull()
  })

  test("clears the dashboard session on sign out", async () => {
    configureLocalAuthentication()
    const response = await POST(formRequest({ intent: "logout" }))
    const cookie = response.headers.get("set-cookie") ?? ""

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("http://localhost:3010/login")
    expect(cookie).toContain(`${DASHBOARD_SESSION_COOKIE}=`)
    expect(cookie).toContain("Max-Age=0")
  })

  test("rejects cross-origin sign-in posts", async () => {
    configureLocalAuthentication()
    const request = formRequest({ password: config.adminPassword, username: config.adminUsername })
    const forged = new Request(request, { headers: { ...Object.fromEntries(request.headers), origin: "https://attacker.example" } })
    const response = await POST(forged)

    expect(response.status).toBe(403)
  })

  test("accepts an opaque browser origin only with a same-origin referrer", async () => {
    configureLocalAuthentication()
    const response = await POST(new Request("http://0.0.0.0:3010/api/dashboard-session", {
      body: new URLSearchParams({ password: config.adminPassword, username: config.adminUsername }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "null",
        referer: "https://diagnostics.example/login",
        "x-forwarded-host": "diagnostics.example",
        "x-forwarded-proto": "https",
      },
      method: "POST",
    }))

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("https://diagnostics.example/")
    expect(response.headers.get("set-cookie")).toContain(`${DASHBOARD_SESSION_COOKIE}=`)
  })

  test("rejects an opaque browser origin without a same-origin referrer", async () => {
    configureLocalAuthentication()
    const body = { password: config.adminPassword, username: config.adminUsername }
    const request = formRequest(body)
    const headers = { ...Object.fromEntries(request.headers), origin: "null" }

    const missingReferrer = await POST(new Request(request, { headers }))
    const crossOriginRequest = formRequest(body)
    const crossOriginReferrer = await POST(new Request(crossOriginRequest, {
      headers: {
        ...Object.fromEntries(crossOriginRequest.headers),
        origin: "null",
        referer: "https://attacker.example/login",
      },
    }))

    expect(missingReferrer.status).toBe(403)
    expect(crossOriginReferrer.status).toBe(403)
  })

  test("redirects the dashboard to login while returning JSON for history clients", async () => {
    configureLocalAuthentication()
    const dashboard = proxy(new NextRequest("http://localhost:3010/?runId=4ab6c4c2-2b5d-4f85-83b7-137cc93acb57"))
    const history = proxy(new NextRequest("http://localhost:3010/api/history"))

    expect(dashboard.status).toBe(307)
    expect(dashboard.headers.get("location")).toBe("http://localhost:3010/login?next=%2F%3FrunId%3D4ab6c4c2-2b5d-4f85-83b7-137cc93acb57")
    expect(history.status).toBe(401)
    expect(await history.json()).toEqual({ error: "diagnostics_admin_authentication_required" })
  })

  test("accepts a valid session cookie at the dashboard boundary", () => {
    configureLocalAuthentication()
    const session = createDashboardSession(config)
    const response = proxy(new NextRequest("http://localhost:3010/", {
      headers: { cookie: `${DASHBOARD_SESSION_COOKIE}=${session}` },
    }))

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
  })
})
