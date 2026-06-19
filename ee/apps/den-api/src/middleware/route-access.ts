import type { MiddlewareHandler } from "hono"
import type { AuthContextVariables } from "../session.js"
import { requireAdminMiddleware } from "./admin.js"
import { requireUserMiddleware } from "./current-user.js"
import { resolveOrganizationContextMiddleware, type OrganizationContextVariables } from "./organization-context.js"
import { resolveUserOrganizationsMiddleware, type UserOrganizationsContext } from "./user-organizations.js"

type OrgRoleContext = {
  isOwner: boolean
  role: string
}

type RouteAccessVariables = AuthContextVariables & Partial<OrganizationContextVariables> & Partial<UserOrganizationsContext>

const explicitAuthGuardHandlers = new WeakSet<object>([
  requireAdminMiddleware,
  requireUserMiddleware,
  resolveOrganizationContextMiddleware,
  resolveUserOrganizationsMiddleware,
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

  if (input.userContext.isOwner) {
    return true
  }

  const assignedRoles = input.userContext.role
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean)

  return input.roles.some((role) => assignedRoles.includes(role))
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

export const delegatedRoute: MiddlewareHandler = async (_c, next) => {
  await next()
}

export function authenticatedRoute(): MiddlewareHandler<{ Variables: AuthContextVariables }> {
  return requireUserMiddleware
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
