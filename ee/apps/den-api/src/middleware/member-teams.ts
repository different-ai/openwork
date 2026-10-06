import type { MiddlewareHandler } from "hono"
import { coreHooks } from "../core/hooks/index.js"
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

  // Core's default audience is today's team membership (core/hooks: audience.resolver).
  const memberTeams = await coreHooks.resolve(
    "audience.resolver",
    { organizationId: context.organization.id, memberId: context.currentMember.id },
    listTeamsForMember,
  )

  c.set("memberTeams", memberTeams)
  await next()
}
