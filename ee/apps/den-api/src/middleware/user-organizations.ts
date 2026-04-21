import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { MiddlewareHandler } from "hono"
import { getApiKeyScopedOrganizationId } from "../api-keys.js"
import { resolveUserOrganizations, setSessionActiveOrganization, type UserOrgSummary } from "../orgs.js"
import type { AuthContextVariables } from "../session.js"

export const LEGACY_ORG_PROXY_HEADER = "x-openwork-legacy-org-id"

export type UserOrganizationsContext = {
  userOrganizations: UserOrgSummary[]
  activeOrganizationId: string | null
  activeOrganizationSlug: string | null
}

type SessionLike = AuthContextVariables["session"]

export function getLegacyProxyOrganizationId(headers: Headers) {
  const rawOrganizationId = headers.get(LEGACY_ORG_PROXY_HEADER)?.trim()
  if (!rawOrganizationId) {
    return null
  }

  try {
    return normalizeDenTypeId("organization", rawOrganizationId)
  } catch {
    return null
  }
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
  const legacyProxyOrganizationId = getLegacyProxyOrganizationId(c.req.raw.headers)
  const scopedOrganizationId = apiKeyScopedOrganizationId ?? legacyProxyOrganizationId
  const resolved = await resolveUserOrganizations({
    activeOrganizationId: scopedOrganizationId ?? session?.activeOrganizationId ?? null,
    userId: normalizeDenTypeId("user", user.id),
  })

  const scopedOrgs = scopedOrganizationId
    ? resolved.orgs.filter((org) => org.id === scopedOrganizationId)
    : resolved.orgs

  const activeOrganizationId = scopedOrganizationId ? scopedOrgs[0]?.id ?? null : resolved.activeOrgId
  const activeOrganizationSlug = scopedOrganizationId
    ? scopedOrgs[0]?.slug ?? null
    : resolved.activeOrgSlug

  if (shouldHydrateSessionActiveOrganization({
    scopedOrganizationId: apiKeyScopedOrganizationId,
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
  await next()
}
