import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { MiddlewareHandler } from "hono"
import { getOrganizationContextForUser, type OrganizationContext } from "../orgs.js"
import type { AuthContextVariables } from "../session.js"

export type OrganizationContextVariables = {
  organizationContext: OrganizationContext
}

export const resolveOrganizationContextMiddleware: MiddlewareHandler<{
  Variables: AuthContextVariables & Partial<OrganizationContextVariables>
}> = async (c, next) => {
  const user = c.get("user")
  if (!user?.id) {
    return c.json({ error: "unauthorized" }, 401) as never
  }

  const params = (c.req as { valid: (target: "param") => { orgId?: string } }).valid("param")
  const organizationIdRaw = params.orgId?.trim()
  if (!organizationIdRaw) {
    return c.json({ error: "organization_id_required" }, 400) as never
  }

  let organizationId
  try {
    organizationId = normalizeDenTypeId("organization", organizationIdRaw)
  } catch {
    return c.json({ error: "organization_not_found" }, 404) as never
  }

  const context = await getOrganizationContextForUser({
    userId: normalizeDenTypeId("user", user.id),
    organizationId,
  })

  if (!context) {
    return c.json({ error: "organization_not_found" }, 404) as never
  }

  c.set("organizationContext", context)
  await next()
}
