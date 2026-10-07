import type { PermissionKey } from "@openwork/types/den/permissions"
import type { MiddlewareHandler } from "hono"
import { beginAuditRequest } from "../audit/request-capture.js"
import { INSUFFICIENT_SCOPE_CHALLENGE, requiresAdminError } from "../agent-error-envelope.js"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { getMcpResourceContext, verifyMcpRequest } from "../mcp/auth.js"
import { DEN_MCP_WRITE_SCOPE } from "../mcp/scopes.js"
import { getOrganizationContextForUser } from "../orgs.js"
import { organizationRoleValueSatisfies } from "../organization-role-hierarchy.js"
import { checkMemberPermission } from "../permissions/check.js"
import type { AuthContextVariables } from "../session.js"
import { requireAdminMiddleware } from "./admin.js"
import { requireUserMiddleware, requireUserSessionMiddleware } from "./current-user.js"
import { memberPermissionsForOrganizationContext, type MemberPermissionsVariables } from "./member-permissions.js"
import type { MemberTeamsContext } from "./member-teams.js"
import { resolveOrganizationContextMiddleware, type OrganizationContextVariables } from "./organization-context.js"
import { resolveUserOrganizationsMiddleware, type UserOrganizationsContext } from "./user-organizations.js"

type OrgRoleContext = {
  isOwner: boolean
  role: string
}

type RouteAccessVariables =
  & AuthContextVariables
  & Partial<OrganizationContextVariables>
  & Partial<UserOrganizationsContext>
  & Partial<MemberTeamsContext>
  & Partial<MemberPermissionsVariables>

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
  const auditBlocked = await beginAuditRequest(c, { origin: "mcp" })
  if (auditBlocked) {
    return auditBlocked
  }
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
        c.header("WWW-Authenticate", INSUFFICIENT_SCOPE_CHALLENGE)
        roleResponse = c.json({
          error: "forbidden",
          ...requiresAdminError(roles.includes("admin")
            ? "Only workspace owners and admins can do this. Ask one of them, or have them change your role."
            : "Only the workspace owner can do this."),
        }, 403)
        return
      }

      await next()
    })

    return contextResponse ?? roleResponse
  }
  explicitAuthGuardHandlers.add(handler)
  return handler
}

type RouteAccessContext = Parameters<MiddlewareHandler<{ Variables: RouteAccessVariables }>>[0]

/**
 * The shared permission check behind orgPermissionRoute and
 * requireOrgPermission: resolves the caller's permissions once (sets
 * `c.var.memberPermissions`) and returns the 403 / 404 response when `key` is
 * not usable, or undefined when the request may continue.
 */
async function enforceOrgPermission(c: RouteAccessContext, key: PermissionKey): Promise<Response | undefined> {
  const payload = c.get("organizationContext")
  if (!payload) return c.json({ error: "organization_not_found" }, 404)

  const permissions = c.get("memberPermissions")
    ?? await memberPermissionsForOrganizationContext(payload, c.get("memberTeams"))
  c.set("memberPermissions", permissions)

  const check = checkMemberPermission({ apiKey: c.get("apiKey"), session: c.get("session") }, permissions, key)
  if (check.ok) return undefined
  if (check.response.error === "forbidden") {
    c.header("WWW-Authenticate", INSUFFICIENT_SCOPE_CHALLENGE)
  }
  return c.json(check.response, 403)
}

/**
 * Route marker for organization routes gated by one catalog permission
 * (docs/permissions/overview.md, section 7). Resolves the organization context
 * exactly like orgRoleRoute, resolves the caller's permissions once (sets
 * `c.var.memberPermissions`), then requires `key`. A sensitive key also needs
 * a recent sign-in, with the same `reauth` response as ensureOrganizationAdmin.
 *
 * Denied: 403 `{ error: "forbidden", code: "requires_admin", message,
 * retryable, action_url, requiredPermission }` with the insufficient-scope
 * challenge header. Replaces orgRoleRoute([...]) plus any unconditional
 * in-handler ensure* call on the same route.
 */
export function orgPermissionRoute(key: PermissionKey): MiddlewareHandler<{ Variables: RouteAccessVariables }> {
  const handler: MiddlewareHandler<{ Variables: RouteAccessVariables }> = async (c, next) => {
    let permissionResponse: Response | undefined
    const contextResponse = await resolveOrganizationContextMiddleware(c, async () => {
      permissionResponse = await enforceOrgPermission(c, key)
      if (permissionResponse) return
      await next()
    })

    return contextResponse ?? permissionResponse
  }
  explicitAuthGuardHandlers.add(handler)
  return handler
}

/**
 * The permission check of orgPermissionRoute as a plain middleware (not a
 * route marker), for routes that must run another guard first, e.g.
 * `orgMemberRoute(), requireFeature("permissions"), requireOrgPermission(key)`
 * so a disabled feature answers 404 before any 403 or reauth. Same responses
 * and sensitivity rule as orgPermissionRoute. Needs the organization context.
 */
export function requireOrgPermission(key: PermissionKey): MiddlewareHandler<{ Variables: RouteAccessVariables }> {
  return async (c, next) => {
    const response = await enforceOrgPermission(c, key)
    if (response) return response
    await next()
  }
}
