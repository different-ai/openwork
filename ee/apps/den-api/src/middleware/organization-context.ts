import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { MiddlewareHandler } from "hono"
import { getApiKeyScopedOrganizationId, isScopedApiKeyForOrganization } from "../api-keys.js"
import { getOrganizationContextForUser, resolveUserOrganizations, type OrganizationContext } from "../orgs.js"
import type { AuthContextVariables } from "../session.js"
import { getLegacyProxyOrganizationId, hydrateSessionActiveOrganization, shouldHydrateSessionActiveOrganization, type UserOrganizationsContext } from "./user-organizations.js"

export type OrganizationContextVariables = {
  organizationContext: OrganizationContext
}

export const resolveOrganizationContextMiddleware: MiddlewareHandler<{
  Variables: AuthContextVariables & Partial<OrganizationContextVariables> & Partial<UserOrganizationsContext>
}> = async (c, next) => {
  const user = c.get("user")
  if (!user?.id) {
    return c.json({ error: "unauthorized" }, 401) as never
  }

  const apiKey = c.get("apiKey")
  const apiKeyScopedOrganizationId = getApiKeyScopedOrganizationId(apiKey)
  const legacyProxyOrganizationId = getLegacyProxyOrganizationId(c.req.raw.headers)
  const scopedOrganizationId = apiKeyScopedOrganizationId ?? legacyProxyOrganizationId

  let organizationId = c.get("activeOrganizationId") ?? null
  let organizationSlug = c.get("activeOrganizationSlug") ?? null

  if (!organizationId) {
    const session = c.get("session")
    const resolved = await resolveUserOrganizations({
      activeOrganizationId: scopedOrganizationId ?? session?.activeOrganizationId ?? null,
      userId: normalizeDenTypeId("user", user.id),
    })

    const scopedOrgs = scopedOrganizationId
      ? resolved.orgs.filter((org) => org.id === scopedOrganizationId)
      : resolved.orgs

    organizationId = scopedOrganizationId ? scopedOrgs[0]?.id ?? null : resolved.activeOrgId
    organizationSlug = scopedOrganizationId ? scopedOrgs[0]?.slug ?? null : resolved.activeOrgSlug

    if (shouldHydrateSessionActiveOrganization({
      scopedOrganizationId: apiKeyScopedOrganizationId,
      sessionActiveOrganizationId: session?.activeOrganizationId,
      resolvedActiveOrganizationId: organizationId,
    })) {
      await hydrateSessionActiveOrganization(session, organizationId)
      if (session) {
        c.set("session", { ...session, activeOrganizationId: organizationId })
      }
    }

    c.set("userOrganizations", scopedOrgs)
    c.set("activeOrganizationId", organizationId)
    c.set("activeOrganizationSlug", organizationSlug)
  }

  if (!organizationId) {
    return c.json({ error: "organization_not_found" }, 404) as never
  }

  const normalizedOrganizationId = normalizeDenTypeId("organization", organizationId)

  const context = await getOrganizationContextForUser({
    userId: normalizeDenTypeId("user", user.id),
    organizationId: normalizedOrganizationId,
  })

  if (!context) {
    return c.json({ error: "organization_not_found" }, 404) as never
  }

  if (apiKey && !isScopedApiKeyForOrganization({ apiKey, organizationId: normalizedOrganizationId })) {
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
  c.set("activeOrganizationId", context.organization.id)
  c.set("activeOrganizationSlug", context.organization.slug)
  await next()
}
