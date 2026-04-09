import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { MiddlewareHandler } from "hono"
import { isScopedApiKeyForOrganization } from "../api-keys.js"
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

  const apiKey = c.get("apiKey")
  if (apiKey && !isScopedApiKeyForOrganization({ apiKey, organizationId })) {
    return c.json({
      error: "forbidden",
      message: "This API key is scoped to a different organization.",
    }, 403) as never
  }

  if (apiKey?.metadata?.orgMembershipId && apiKey.metadata.orgMembershipId !== context.currentMember.id) {
    return c.json({
      error: "forbidden",
      message: "This API key is no longer valid for the current organization member.",
    }, 403) as never
  }

  c.set("organizationContext", context)
  await next()
}
