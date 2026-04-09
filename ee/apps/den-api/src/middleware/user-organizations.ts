import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { MiddlewareHandler } from "hono"
import { getApiKeyScopedOrganizationId } from "../api-keys.js"
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
  const apiKey = c.get("apiKey")
  const scopedOrganizationId = getApiKeyScopedOrganizationId(apiKey)
  const resolved = await resolveUserOrganizations({
    activeOrganizationId: scopedOrganizationId ?? session?.activeOrganizationId ?? null,
    userId: normalizeDenTypeId("user", user.id),
  })

  const scopedOrgs = scopedOrganizationId
    ? resolved.orgs.filter((org) => org.id === scopedOrganizationId)
    : resolved.orgs

  c.set("userOrganizations", scopedOrgs)
  c.set("activeOrganizationId", scopedOrganizationId ? scopedOrgs[0]?.id ?? null : resolved.activeOrgId)
  c.set(
    "activeOrganizationSlug",
    scopedOrganizationId
      ? scopedOrgs[0]?.slug ?? null
      : resolved.activeOrgSlug,
  )
  await next()
}
