import type { MiddlewareHandler } from "hono"
import { listTeamsForMember, type MemberTeamSummary } from "../orgs.js"
import type { AuthContextVariables } from "../session.js"
import type { OrganizationContextVariables } from "./organization-context.js"

export type MemberTeamsContext = {
  memberTeams: MemberTeamSummary[]
}

export const resolveMemberTeamsMiddleware: MiddlewareHandler<{
  Variables: AuthContextVariables & Partial<OrganizationContextVariables> & Partial<MemberTeamsContext>
}> = async (c, next) => {
  const context = c.get("organizationContext")
  if (!context) {
    return c.json({ error: "organization_context_required" }, 500) as never
  }

  const memberTeams = await listTeamsForMember({
    organizationId: context.organization.id,
    memberId: context.currentMember.id,
  })

  c.set("memberTeams", memberTeams)
  await next()
}
