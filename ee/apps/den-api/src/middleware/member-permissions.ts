import type { MiddlewareHandler } from "hono"
import { listTeamsForMember, type OrganizationContext } from "../orgs.js"
import type { MemberPermissions } from "../permissions/effective.js"
import { resolveMemberPermissionsFromContext } from "../permissions/resolve.js"
import type { AuthContextVariables } from "../session.js"
import type { MemberTeamsContext } from "./member-teams.js"
import type { OrganizationContextVariables } from "./organization-context.js"

export type MemberPermissionsVariables = {
  memberPermissions: MemberPermissions
}

// One resolution per OrganizationContext object, i.e. per request: the
// context is rebuilt for every request. Lets helpers that cannot set
// c.var (or run before the middleware) share the same answer.
const resolutions = new WeakMap<OrganizationContext, Promise<MemberPermissions>>()

/**
 * The caller's effective permissions for this request's organization context.
 * Pass `memberTeams` when already loaded (resolveMemberTeamsMiddleware);
 * otherwise the member's teams are read, only when team sets can apply
 * (feature on and not the owner).
 */
export function memberPermissionsForOrganizationContext(
  context: OrganizationContext,
  memberTeams?: readonly { id: string }[],
): Promise<MemberPermissions> {
  const cached = resolutions.get(context)
  if (cached) return cached

  const resolution = (async () => {
    const needsTeams = context.features.permissions && !context.currentMember.isOwner
    const teams = memberTeams ?? (needsTeams
      ? await listTeamsForMember({ organizationId: context.organization.id, memberId: context.currentMember.id })
      : [])
    return resolveMemberPermissionsFromContext(context, teams.map((team) => team.id))
  })()
  resolutions.set(context, resolution)
  void resolution.catch(() => resolutions.delete(context))
  return resolution
}

/**
 * Resolves the caller's effective permissions once per request and sets
 * `c.var.memberPermissions`. Requires the organization context
 * (orgMemberRoute / orgRoleRoute / orgPermissionRoute / cloudTransportRoute
 * first). Skips when an earlier middleware already set it.
 */
export const resolveMemberPermissionsMiddleware: MiddlewareHandler<{
  Variables: AuthContextVariables
    & Partial<OrganizationContextVariables>
    & Partial<MemberTeamsContext>
    & Partial<MemberPermissionsVariables>
}> = async (c, next) => {
  if (c.get("memberPermissions")) {
    await next()
    return
  }

  const context = c.get("organizationContext")
  if (!context) {
    return c.json({ error: "organization_context_required" }, 500) as never
  }

  c.set("memberPermissions", await memberPermissionsForOrganizationContext(context, c.get("memberTeams")))
  await next()
}
