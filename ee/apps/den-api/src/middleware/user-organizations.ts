import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { MiddlewareHandler } from "hono"
import { beginUserOrganizationsAuditRequest } from "../audit/request-capture.js"
import { getApiKeyScopedOrganizationId } from "../api-keys.js"
import { resolveUserOrganizations, setSessionActiveOrganization, type UserOrgSummary } from "../orgs.js"
import { findSsoBlockedOrganizations } from "../organization-sso-access.js"
import type { AuthContextVariables } from "../session.js"

export const LEGACY_ORG_PROXY_HEADER = "x-openwork-legacy-org-id"
export const ORG_SCOPE_HEADER = "x-openwork-org-id"

export type UserOrganizationsContext = {
  userOrganizations: UserOrgSummary[]
  activeOrganizationId: string | null
  activeOrganizationSlug: string | null
}

type SessionLike = AuthContextVariables["session"]

function getHeaderOrganizationId(headers: Headers, headerName: string) {
  const rawOrganizationId = headers.get(headerName)?.trim()
  if (!rawOrganizationId) {
    return null
  }

  try {
    return normalizeDenTypeId("organization", rawOrganizationId)
  } catch {
    return null
  }
}

export function getLegacyProxyOrganizationId(headers: Headers) {
  return getHeaderOrganizationId(headers, LEGACY_ORG_PROXY_HEADER)
}

export function getRequestScopedOrganizationId(headers: Headers) {
  return getHeaderOrganizationId(headers, ORG_SCOPE_HEADER) ?? getLegacyProxyOrganizationId(headers)
}

export function shouldHydrateSessionActiveOrganization(input: {
  resolvedActiveOrganizationId: string | null
  scopedOrganizationId: string | null
  sessionActiveOrganizationId?: string | null
}) {
  return !input.scopedOrganizationId && !input.sessionActiveOrganizationId && !!input.resolvedActiveOrganizationId
}

export async function hydrateSessionActiveOrganization(session: SessionLike, organizationId: string | null) {
  if (!session?.id || !organizationId || session.activeOrganizationId === organizationId) {
    return
  }

  try {
    const sessionId = normalizeDenTypeId("session", session.id)
    const normalizedOrganizationId = normalizeDenTypeId("organization", organizationId)
    await setSessionActiveOrganization(sessionId, normalizedOrganizationId)
  } catch {
    return
  }
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
  const apiKeyScopedOrganizationId = getApiKeyScopedOrganizationId(apiKey)
  const headerOrganizationId = getRequestScopedOrganizationId(c.req.raw.headers)
  const scopedOrganizationId = apiKeyScopedOrganizationId ?? headerOrganizationId
  const resolved = await resolveUserOrganizations({
    activeOrganizationId: scopedOrganizationId ?? session?.activeOrganizationId ?? null,
    userId: normalizeDenTypeId("user", user.id),
  })

  const scopedOrgs = scopedOrganizationId
    ? resolved.orgs.filter((org) => org.id === scopedOrganizationId)
    : resolved.orgs

  let activeOrganizationId = scopedOrganizationId ? scopedOrgs[0]?.id ?? null : resolved.activeOrgId
  let activeOrganizationSlug = scopedOrganizationId
    ? scopedOrgs[0]?.slug ?? null
    : resolved.activeOrgSlug

  // ssoPerOrganization: never act in an organization that requires SSO from a
  // session that did not sign in through it. Fall back to the first
  // organization the session may open; the list itself stays complete so the
  // person can still choose it (and be sent through its SSO).
  if (!apiKey && activeOrganizationId) {
    const blocked = await findSsoBlockedOrganizations({ sessionId: session?.id ?? null, organizationIds: scopedOrgs.map((org) => org.id) })
    if (blocked.has(activeOrganizationId)) {
      const fallback = scopedOrganizationId ? null : scopedOrgs.find((org) => !blocked.has(org.id)) ?? null
      activeOrganizationId = fallback?.id ?? null
      activeOrganizationSlug = fallback?.slug ?? null
    }
  }

  if (shouldHydrateSessionActiveOrganization({
    scopedOrganizationId,
    sessionActiveOrganizationId: session?.activeOrganizationId,
    resolvedActiveOrganizationId: activeOrganizationId,
  })) {
    await hydrateSessionActiveOrganization(session, activeOrganizationId)
    if (session) {
      c.set("session", { ...session, activeOrganizationId })
    }
  }

  c.set("userOrganizations", scopedOrgs)
  c.set("activeOrganizationId", activeOrganizationId)
  c.set("activeOrganizationSlug", activeOrganizationSlug)
  // The active organization is one of the caller's verified memberships: the
  // handler acts on it, so it is the audit tenant (durable intent before next()).
  const activeMembership = activeOrganizationId ? scopedOrgs.find((org) => org.id === activeOrganizationId) : undefined
  if (activeMembership) {
    const auditBlocked = await beginUserOrganizationsAuditRequest(c, {
      organizationId: activeMembership.id,
      userId: normalizeDenTypeId("user", user.id),
      memberId: activeMembership.membershipId,
    })
    if (auditBlocked) {
      return auditBlocked as never
    }
  }
  await next()
}
