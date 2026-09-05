import type { MiddlewareHandler } from "hono"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { getMcpResourceContext, verifyMcpRequest } from "../mcp/auth.js"
import { DEN_MCP_WRITE_SCOPE } from "../mcp/scopes.js"
import { getOrganizationContextForUser } from "../orgs.js"
import { organizationRoleValueSatisfies } from "../organization-role-hierarchy.js"
import type { AuthContextVariables } from "../session.js"
import { requireAdminMiddleware } from "./admin.js"
import { requireUserMiddleware, requireUserSessionMiddleware } from "./current-user.js"
import { resolveOrganizationContextMiddleware, type OrganizationContextVariables } from "./organization-context.js"
import { resolveUserOrganizationsMiddleware, type UserOrganizationsContext } from "./user-organizations.js"

type OrgRoleContext = {
  isOwner: boolean
  role: string
}

type RouteAccessVariables = AuthContextVariables & Partial<OrganizationContextVariables> & Partial<UserOrganizationsContext>

const cloudTransportRouteHandler: MiddlewareHandler<{ Variables: OrganizationContextVariables }> = async (c, next) => {
  const principal = await verifyMcpRequest(
    c.req.raw.headers,
    getMcpResourceContext(c.req.raw, "agent"),
  )
  if (principal instanceof Response) {
    return principal
  }
  if (!principal.scopes.has(DEN_MCP_WRITE_SCOPE)) {
    return c.json({
      error: "insufficient_mcp_scope",
      requiredScope: DEN_MCP_WRITE_SCOPE,
    }, 403)
  }

  const organizationContext = await getOrganizationContextForUser({
    userId: normalizeDenTypeId("user", principal.userId),
    organizationId: normalizeDenTypeId("organization", principal.organizationId),
  })
  if (!organizationContext) {
    return c.json({ error: "mcp_membership_revoked" }, 403)
  }

  c.set("organizationContext", organizationContext)
  await next()
}

const explicitAuthGuardHandlers = new WeakSet<object>([
  requireAdminMiddleware,
  requireUserMiddleware,
  requireUserSessionMiddleware,
  resolveOrganizationContextMiddleware,
  resolveUserOrganizationsMiddleware,
  cloudTransportRouteHandler,
])

/**
 * Den API routes are deny-by-default: every `app.get/post/patch/delete/all/on`
 * registration must include one explicit access policy marker from this file.
 * Public routes use `publicRoute`; token, webhook, and delegated proxy routes
 * use their named markers and perform their specialized verification in the
 * handler. Common user/org/admin markers execute the shared guard middleware.
 * `test/route-access-policy.test.ts` fails CI when a route omits a marker.
 */

export function verifyOrgRole(input: { roles: readonly string[]; userContext: OrgRoleContext }) {
  if (input.roles.includes("member")) {
    return true
  }
  return input.roles.some((role) => organizationRoleValueSatisfies({
    roleValue: input.userContext.role,
    requiredRole: role,
    isOwner: input.userContext.isOwner,
  }))
}

export const publicRoute: MiddlewareHandler = async (_c, next) => {
  await next()
}

export const signedWebhookRoute: MiddlewareHandler = async (_c, next) => {
  await next()
}

export const tokenRoute: MiddlewareHandler = async (_c, next) => {
  await next()
}

export function cloudTransportRoute(): typeof cloudTransportRouteHandler {
  return cloudTransportRouteHandler
}

export const delegatedRoute: MiddlewareHandler = async (_c, next) => {
  await next()
}

export function authenticatedRoute(): MiddlewareHandler<{ Variables: AuthContextVariables }> {
  return requireUserMiddleware
}

export function userSessionRoute(): MiddlewareHandler<{ Variables: AuthContextVariables }> {
  return requireUserSessionMiddleware
}

export function adminRoute(): MiddlewareHandler<{ Variables: AuthContextVariables }> {
  return requireAdminMiddleware
}

export function hasExplicitAuthGuardHandler(handler: unknown) {
  return typeof handler === "function" && explicitAuthGuardHandlers.has(handler)
}

export function orgMemberRoute(options: { useUserOrganizations: true }): typeof resolveUserOrganizationsMiddleware
export function orgMemberRoute(): typeof resolveOrganizationContextMiddleware
export function orgMemberRoute(options?: { useUserOrganizations: true }) {
  if (options?.useUserOrganizations) {
    return resolveUserOrganizationsMiddleware
  }

  return resolveOrganizationContextMiddleware
}

export function orgRoleRoute(roles: readonly string[]): MiddlewareHandler<{ Variables: RouteAccessVariables }> {
  const handler: MiddlewareHandler<{ Variables: RouteAccessVariables }> = async (c, next) => {
    let roleResponse: Response | undefined
    const contextResponse = await resolveOrganizationContextMiddleware(c, async () => {
      const payload = c.get("organizationContext")
      if (!payload) {
        roleResponse = c.json({ error: "organization_not_found" }, 404)
        return
      }

      const allowed = verifyOrgRole({ roles, userContext: payload.currentMember })
      if (!allowed) {
        roleResponse = c.json({ error: "forbidden" }, 403)
        return
      }

      await next()
    })

    return contextResponse ?? roleResponse
  }
  explicitAuthGuardHandlers.add(handler)
  return handler
}
