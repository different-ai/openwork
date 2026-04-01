import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { MiddlewareHandler } from "hono"
import { resolveUserOrganizations, type UserOrgSummary } from "../orgs.js"
import type { AuthContextVariables } from "../session.js"

export type UserOrganizationsContext = {
  userOrganizations: UserOrgSummary[]
  activeOrganizationId: string | null
  activeOrganizationSlug: string | null
}

export const resolveUserOrganizationsMiddleware: MiddlewareHandler<{
  Variables: AuthContextVariables & Partial<UserOrganizationsContext>
}> = async (c, next) => {
  const user = c.get("user")
  if (!user?.id) {
    return c.json({ error: "unauthorized" }, 401) as never
  }

  const session = c.get("session")
  const resolved = await resolveUserOrganizations({
    activeOrganizationId: session?.activeOrganizationId ?? null,
    userId: normalizeDenTypeId("user", user.id),
  })

  c.set("userOrganizations", resolved.orgs)
  c.set("activeOrganizationId", resolved.activeOrgId)
  c.set("activeOrganizationSlug", resolved.activeOrgSlug)
  await next()
}
