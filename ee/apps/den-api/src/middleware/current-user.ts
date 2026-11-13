import type { MiddlewareHandler } from "hono"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { AuthContextVariables } from "../session.js"
import type { OrganizationContextVariables } from "./organization-context.js"

/**
 * A session bound to one organization (session-token.ts) is a signed-in user
 * session only inside that organization: on a route whose organization guard
 * already ran. Account-wide operations stay with an ordinary sign-in.
 */
export const ORGANIZATION_BOUND_SESSION_MESSAGE = "This sign-in works in one organization only. Sign in to OpenWork directly for this."

export const requireUserMiddleware: MiddlewareHandler<{ Variables: AuthContextVariables }> = async (c, next) => {
  if (!c.get("user")?.id) {
    return c.json({ error: "unauthorized" }, 401) as never
  }

  await next()
}

export const requireUserSessionMiddleware: MiddlewareHandler<{ Variables: AuthContextVariables }> = async (c, next) => {
  if (!c.get("user")?.id) {
    return c.json({ error: "unauthorized" }, 401) as never
  }

  const session = c.get("session")
  if (c.get("apiKey") || !session?.id || !session.token) {
    return c.json({
      error: "forbidden",
      message: "Use a signed-in user session for this operation.",
    }, 403) as never
  }

  try {
    normalizeDenTypeId("session", session.id)
  } catch {
    return c.json({
      error: "forbidden",
      message: "Use a signed-in user session for this operation.",
    }, 403) as never
  }

  const resolved = c.var as Partial<OrganizationContextVariables>
  if (session.organizationScopeId && resolved.organizationContext?.organization.id !== session.organizationScopeId) {
    return c.json({ error: "forbidden", message: ORGANIZATION_BOUND_SESSION_MESSAGE }, 403) as never
  }

  await next()
}
