import { Hono } from "hono"
import { z } from "zod"
import {
  ControlPlaneError,
  createInstanceInputSchema,
  updateScenarioInputSchema,
  type EnterpriseMockLabControlPlane,
} from "./contracts.js"
import {
  AuthenticationError,
  RequestSecurityError,
  SecurityService,
  type AuthenticatedSession,
} from "./security.js"
import { applicationCss, renderDashboard, renderLoginPage } from "./ui.js"

export interface EnterpriseMockLabAppOptions {
  controlPlane: EnterpriseMockLabControlPlane
  security: SecurityService
}

const maximumControlPlaneBodyBytes = 64 * 1024

function mediaType(request: Request): string {
  return request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? ""
}

function isHtmlForm(request: Request): boolean {
  return mediaType(request) === "application/x-www-form-urlencoded"
}

function wantsHtml(request: Request): boolean {
  return isHtmlForm(request) || (request.headers.get("accept")?.includes("text/html") ?? false)
}

async function requestBody(request: Request): Promise<Record<string, unknown>> {
  const contentLength = request.headers.get("content-length")
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maximumControlPlaneBodyBytes) {
    throw new ControlPlaneError("payload_too_large", "The control-plane request exceeds the 64 KiB limit.")
  }
  const reader = request.body?.getReader()
  const decoder = new TextDecoder()
  let byteCount = 0
  let text = ""
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        byteCount += value.byteLength
        if (byteCount > maximumControlPlaneBodyBytes) {
          await reader.cancel()
          throw new ControlPlaneError("payload_too_large", "The control-plane request exceeds the 64 KiB limit.")
        }
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()
    } finally {
      reader.releaseLock()
    }
  }

  const contentType = mediaType(request)
  if (contentType === "application/json") {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw new ControlPlaneError("invalid_request", "The JSON request body is malformed.")
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ControlPlaneError("invalid_request", "The request body must be a JSON object.")
    }
    return value as Record<string, unknown>
  }
  if (contentType === "application/x-www-form-urlencoded") {
    return Object.fromEntries(new URLSearchParams(text))
  }
  throw new ControlPlaneError("invalid_request", "Use application/json or a standard HTML form body.")
}

function redirectToDashboard(message: string, kind: "error" | "success" = "success", anchor?: string): Response {
  const query = new URLSearchParams({ kind, notice: message })
  const location = `/?${query.toString()}${anchor ? `#${encodeURIComponent(anchor)}` : ""}`
  return new Response(null, { headers: { Location: location }, status: 303 })
}

function publicInstance(instance: ReturnType<EnterpriseMockLabControlPlane["get"]>): unknown {
  return instance ?? null
}

export function createEnterpriseMockLabApp(options: EnterpriseMockLabAppOptions): Hono {
  const { controlPlane, security } = options
  const app = new Hono()

  app.use("*", async (context, next) => {
    await next()
    context.header("Cache-Control", "no-store")
    context.header("Content-Security-Policy", "default-src 'none'; script-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; connect-src 'self'")
    context.header("Cross-Origin-Opener-Policy", "same-origin")
    context.header("Cross-Origin-Resource-Policy", "same-origin")
    context.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
    // `no-referrer` also serializes same-origin form POSTs with `Origin: null`
    // in Chromium. `same-origin` preserves our strict Origin check while still
    // suppressing referrers when a user follows an external documentation link.
    context.header("Referrer-Policy", "same-origin")
    context.header("X-Content-Type-Options", "nosniff")
    context.header("X-Frame-Options", "DENY")
  })

  app.get("/health", (context) => context.json({ ok: true, service: "enterprise-mock-lab", exposure: "loopback-only" }))

  app.get("/assets/app.css", (context) => {
    context.header("Content-Type", "text/css; charset=utf-8")
    return context.body(applicationCss)
  })

  app.get("/", (context) => {
    let session: AuthenticatedSession
    try {
      session = security.requireSession(context.req.raw)
    } catch (error) {
      if (error instanceof RequestSecurityError && error.code === "authentication_required") {
        const loginError = context.req.query("kind") === "error" ? context.req.query("notice") : undefined
        return context.html(renderLoginPage(loginError), 401)
      }
      throw error
    }

    const catalog = controlPlane.catalog()
    const notice = context.req.query("notice")
    const kind = context.req.query("kind") === "error" ? "error" : "success"
    return context.html(renderDashboard({
      csrfToken: session.csrfToken,
      faults: catalog.faults,
      ...(notice ? { flash: { kind, message: notice } } : {}),
      instances: controlPlane.list(),
      profiles: catalog.profiles,
    }))
  })

  app.post("/session/login", async (context) => {
    try {
      security.assertOrigin(context.req.raw)
      const body = await requestBody(context.req.raw)
      const adminSecret = typeof body.adminSecret === "string" ? body.adminSecret : ""
      const session = security.authenticate(adminSecret, "loopback-client")
      context.header("Set-Cookie", security.sessionCookie(session))
      return context.redirect("/", 303)
    } catch (error) {
      if (error instanceof AuthenticationError) {
        return context.html(renderLoginPage(error.message), error.code === "rate_limited" ? 429 : 401)
      }
      throw error
    }
  })

  app.post("/session/logout", async (context) => {
    security.assertOrigin(context.req.raw)
    security.requireSession(context.req.raw)
    const body = await requestBody(context.req.raw)
    security.requireMutation(context.req.raw, body.csrfToken)
    security.revoke(context.req.raw)
    context.header("Set-Cookie", security.clearSessionCookie())
    return context.redirect("/", 303)
  })

  app.get("/api/v1/catalog", (context) => {
    security.requireSession(context.req.raw)
    return context.json(controlPlane.catalog())
  })

  app.get("/api/v1/instances", (context) => {
    security.requireSession(context.req.raw)
    return context.json({ instances: controlPlane.list() })
  })

  app.get("/api/v1/instances/:id", (context) => {
    security.requireSession(context.req.raw)
    const instance = controlPlane.get(context.req.param("id"))
    if (!instance) throw new ControlPlaneError("not_found", "Mock instance not found.")
    return context.json(publicInstance(instance))
  })

  app.post("/api/v1/instances", async (context) => {
    security.assertOrigin(context.req.raw)
    security.requireSession(context.req.raw)
    const body = await requestBody(context.req.raw)
    security.requireMutation(context.req.raw, body.csrfToken)
    const input = createInstanceInputSchema.parse(body)
    const instance = await controlPlane.create(input)
    if (wantsHtml(context.req.raw)) return redirectToDashboard("The mock instance was created. Start it when you are ready.", "success", `instance-${instance.id}`)
    return context.json(instance, 201)
  })

  app.post("/api/v1/instances/:id/scenario", async (context) => {
    security.assertOrigin(context.req.raw)
    security.requireSession(context.req.raw)
    const body = await requestBody(context.req.raw)
    security.requireMutation(context.req.raw, body.csrfToken)
    const input = updateScenarioInputSchema.parse({
      credentialContinuity: body.credentialContinuity,
      expectedRevision: body.expectedRevision,
      faultId: body.faultId === "" ? null : body.faultId,
    })
    const instance = await controlPlane.updateScenario(context.req.param("id"), input)
    if (wantsHtml(context.req.raw)) {
      const message = input.credentialContinuity === "preserve-compatible-oauth"
        ? "A new immutable scenario revision is active. Compatible OAuth authority was retained; prior MCP sessions were cleared."
        : "A new immutable scenario revision is active. OAuth and MCP connection state was reset."
      return redirectToDashboard(message, "success", `instance-${instance.id}`)
    }
    return context.json(instance)
  })

  app.post("/api/v1/instances/:id/actions/:action", async (context) => {
    security.assertOrigin(context.req.raw)
    security.requireSession(context.req.raw)
    const body = await requestBody(context.req.raw)
    security.requireMutation(context.req.raw, body.csrfToken)
    const id = context.req.param("id")
    const action = z.enum(["start", "stop", "reset", "probe", "delete"]).parse(context.req.param("action"))

    if (action === "delete") {
      await controlPlane.remove(id)
      if (wantsHtml(context.req.raw)) return redirectToDashboard("The mock instance was deleted.")
      return context.body(null, 204)
    }

    const instance = await controlPlane[action](id)
    if (wantsHtml(context.req.raw)) {
      const labels = { probe: "Probe completed.", reset: "Instance reset.", start: "Instance started.", stop: "Instance stopped." } as const
      return redirectToDashboard(labels[action], "success", `instance-${instance.id}`)
    }
    return context.json(instance)
  })

  app.notFound((context) => context.json({ error: "not_found", message: "Route not found." }, 404))

  app.onError((error, context) => {
    if (wantsHtml(context.req.raw) && context.req.method !== "GET") {
      const message = error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message).join(" ")
        : error instanceof Error
          ? error.message
          : "The action could not be completed."
      return redirectToDashboard(message, "error")
    }
    if (error instanceof RequestSecurityError) {
      const status = error.code === "authentication_required" ? 401 : 403
      return context.json({ error: error.code, message: error.message }, status)
    }
    if (error instanceof ControlPlaneError) {
      const status = error.code === "not_found"
        ? 404
        : error.code === "payload_too_large"
          ? 413
          : error.code === "conflict" || error.code === "invalid_state"
            ? 409
            : 400
      return context.json({ error: error.code, message: error.message }, status)
    }
    if (error instanceof z.ZodError) {
      return context.json({ error: "invalid_request", issues: error.issues }, 400)
    }
    console.error("[enterprise-mock-lab] unexpected control-plane error", {
      errorType: error instanceof Error ? error.name : typeof error,
    })
    return context.json({ error: "internal_server_error", message: "The local lab could not complete the request." }, 500)
  })

  return app
}
