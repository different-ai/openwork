import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { MiddlewareHandler } from "hono"
import { getApiKeyScopedOrganizationId, isScopedApiKeyForOrganization } from "../api-keys.js"
import { getOrganizationContextForUser, resolveUserOrganizations, type OrganizationContext } from "../orgs.js"
import type { AuthContextVariables } from "../session.js"
import { getRequestScopedOrganizationId, hydrateSessionActiveOrganization, shouldHydrateSessionActiveOrganization, type UserOrganizationsContext } from "./user-organizations.js"

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
  const headerOrganizationId = getRequestScopedOrganizationId(c.req.raw.headers)
  const scopedOrganizationId = apiKeyScopedOrganizationId ?? headerOrganizationId
  const session = c.get("session")
  const userId = normalizeDenTypeId("user", user.id)

  let organizationId = scopedOrganizationId ?? c.get("activeOrganizationId") ?? null
  let organizationSlug = scopedOrganizationId ? null : c.get("activeOrganizationSlug") ?? null

  if (!organizationId) {
    const resolved = await resolveUserOrganizations({
      activeOrganizationId: session?.activeOrganizationId ?? null,
      userId,
    })

    const scopedOrgs = resolved.orgs

    organizationId = resolved.activeOrgId
    organizationSlug = resolved.activeOrgSlug

    if (shouldHydrateSessionActiveOrganization({
      scopedOrganizationId,
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

  let normalizedOrganizationId = normalizeDenTypeId("organization", organizationId)

  let context = await getOrganizationContextForUser({
    userId,
    organizationId: normalizedOrganizationId,
  })

  if (!context && !scopedOrganizationId) {
    const resolved = await resolveUserOrganizations({
      activeOrganizationId: null,
      userId,
    })

    c.set("userOrganizations", resolved.orgs)
    c.set("activeOrganizationId", resolved.activeOrgId)
    c.set("activeOrganizationSlug", resolved.activeOrgSlug)

    if (resolved.activeOrgId) {
      normalizedOrganizationId = normalizeDenTypeId("organization", resolved.activeOrgId)
      context = await getOrganizationContextForUser({
        userId,
        organizationId: normalizedOrganizationId,
      })

      if (context) {
        await hydrateSessionActiveOrganization(session, resolved.activeOrgId)
        if (session) {
          c.set("session", { ...session, activeOrganizationId: resolved.activeOrgId })
        }
      }
    }
  }

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
