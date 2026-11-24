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

const resolutions = new WeakMap<OrganizationContext, Promise<MemberPermissions>>()

export function memberPermissionsForOrganizationContext(
  context: OrganizationContext,
  memberTeams?: readonly { id: string }[],
): Promise<MemberPermissions> {
  const cached = resolutions.get(context)
  if (cached) return cached

  const resolution = (async () => {
    const needsTeams = !context.currentMember.isOwner
    const teams = memberTeams ?? (needsTeams
      ? await listTeamsForMember({ organizationId: context.organization.id, memberId: context.currentMember.id })
      : [])
    return resolveMemberPermissionsFromContext(context, teams.map((team) => team.id))
  })()
  resolutions.set(context, resolution)
  void resolution.catch(() => resolutions.delete(context))
  return resolution
}

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
