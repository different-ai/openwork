import type { Context, Hono } from "hono"
import { orgMemberRoute, resolveMemberTeamsMiddleware } from "../../../middleware/index.js"
import type { OrgRouteVariables } from "../../../routes/org/shared.js"
import { type PluginArchActorContext, PluginArchAuthorizationError } from "../../../routes/org/plugin-system/access.js"
import { PluginArchRouteFailure } from "../store/route-failure.js"

export type OrgContext = Context<{ Variables: OrgRouteVariables }>

function validRequestPart<T>(c: OrgContext, target: "json" | "param" | "query") {
  return (c.req as unknown as { valid: (part: typeof target) => unknown }).valid(target) as T
}

export function validJson<T>(c: OrgContext) {
  return validRequestPart<T>(c, "json")
}

export function validParam<T>(c: OrgContext) {
  return validRequestPart<T>(c, "param")
}

export function validQuery<T>(c: OrgContext) {
  return validRequestPart<T>(c, "query")
}

export function actorContext(c: OrgContext): PluginArchActorContext {
  const organizationContext = c.get("organizationContext")
  if (!organizationContext) {
    throw new PluginArchRouteFailure(404, "organization_not_found", "Organization context not found.")
  }

  return {
    ...(c.get("apiKey") ? { apiKey: true } : {}),
    memberTeams: c.get("memberTeams") ?? [],
    organizationContext,
    session: c.get("session"),
  }
}

export function routeErrorResponse(c: OrgContext, error: unknown) {
  if (error instanceof PluginArchAuthorizationError) {
    const authorizationError = error as PluginArchAuthorizationError
    return c.json({ error: authorizationError.error, reason: authorizationError.reason, message: authorizationError.message }, 403)
  }
  if (error instanceof PluginArchRouteFailure) {
    const failure = error as PluginArchRouteFailure
    return c.json({ error: failure.error, message: failure.message }, failure.status)
  }
  throw error
}

export function withPluginArchOrgContext(app: Hono<any>, method: "delete" | "get" | "patch" | "post" | "put", path: string, ...handlers: unknown[]) {
  const routeHandler = handlers.pop() as unknown
  const routeMiddlewares = handlers as unknown[]
  const routeApp = app as unknown as Record<string, (...args: unknown[]) => unknown>
  routeApp[method](path, orgMemberRoute(), ...routeMiddlewares, resolveMemberTeamsMiddleware, routeHandler)
}
