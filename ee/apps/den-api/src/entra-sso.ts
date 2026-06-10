export type DenSsoOrganizationRole = "admin" | "member"

export type EntraSsoConfig = {
  clientId?: string
  clientSecret?: string
  tenantId?: string
  autoJoinEnabled: boolean
  autoJoinOrganizationId?: string
  autoJoinOrganizationSlug?: string
  adminGroupIds: string[]
  memberGroupIds: string[]
}

export type EntraSsoEnvIssue = {
  path: string
  message: string
}

const ENTRA_TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MULTI_TENANT_ENTRA_ALIASES = new Set(["common", "organizations", "consumers"])

export type EntraProfile = {
  email?: string | null
  name?: string | null
  oid?: string | null
  preferred_username?: string | null
  sub?: string | null
  tid?: string | null
  upn?: string | null
}

export type EntraTokenClaims = {
  groups?: unknown
}

export type EntraSsoMembershipRecord = {
  id: string
  role: string
}

export type EnsureEntraSsoMembershipDeps<TMember extends EntraSsoMembershipRecord> = {
  resolveOrganizationId: (input: { organizationId?: string; organizationSlug?: string }) => Promise<string | null>
  getExistingMember: (input: { organizationId: string; userId: string }) => Promise<TMember | null>
  createMember: (input: { organizationId: string; userId: string; role: DenSsoOrganizationRole }) => Promise<TMember>
  updateMemberRole: (input: { memberId: string; role: DenSsoOrganizationRole }) => Promise<TMember>
  ensureDefaultRoles: (organizationId: string) => Promise<void>
  isOwnerRole: (role: string) => boolean
}

function optionalString(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function splitCsv(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export function parseEntraSsoEnv(input: {
  DEN_ENTRA_TENANT_ID?: string
  DEN_ENTRA_CLIENT_ID?: string
  DEN_ENTRA_CLIENT_SECRET?: string
  DEN_ENTRA_AUTO_JOIN_ENABLED?: string
  DEN_ENTRA_AUTO_JOIN_ORG_ID?: string
  DEN_ENTRA_AUTO_JOIN_ORG_SLUG?: string
  DEN_ENTRA_ADMIN_GROUP_IDS?: string
  DEN_ENTRA_MEMBER_GROUP_IDS?: string
}): EntraSsoConfig {
  return {
    tenantId: normalizeEntraTenantId(input.DEN_ENTRA_TENANT_ID),
    clientId: optionalString(input.DEN_ENTRA_CLIENT_ID),
    clientSecret: optionalString(input.DEN_ENTRA_CLIENT_SECRET),
    autoJoinEnabled: (input.DEN_ENTRA_AUTO_JOIN_ENABLED ?? "false").toLowerCase() === "true",
    autoJoinOrganizationId: optionalString(input.DEN_ENTRA_AUTO_JOIN_ORG_ID),
    autoJoinOrganizationSlug: optionalString(input.DEN_ENTRA_AUTO_JOIN_ORG_SLUG),
    adminGroupIds: splitCsv(input.DEN_ENTRA_ADMIN_GROUP_IDS),
    memberGroupIds: splitCsv(input.DEN_ENTRA_MEMBER_GROUP_IDS),
  }
}

export function validateEntraSsoEnv(input: {
  DEN_ENTRA_TENANT_ID?: string
  DEN_ENTRA_CLIENT_ID?: string
  DEN_ENTRA_CLIENT_SECRET?: string
  DEN_ENTRA_AUTO_JOIN_ENABLED?: string
  DEN_ENTRA_AUTO_JOIN_ORG_ID?: string
  DEN_ENTRA_AUTO_JOIN_ORG_SLUG?: string
  BETTER_AUTH_URL?: string
  DEN_BETTER_AUTH_TRUSTED_ORIGINS?: string
  CORS_ORIGINS?: string
}) {
  const issues: EntraSsoEnvIssue[] = []
  const hasAnyProviderValue = Boolean(input.DEN_ENTRA_TENANT_ID || input.DEN_ENTRA_CLIENT_ID || input.DEN_ENTRA_CLIENT_SECRET)

  if (hasAnyProviderValue) {
    for (const key of ["DEN_ENTRA_TENANT_ID", "DEN_ENTRA_CLIENT_ID", "DEN_ENTRA_CLIENT_SECRET"] as const) {
      if (!input[key]?.trim()) {
        issues.push({
          path: key,
          message: `${key} is required when configuring Microsoft Entra SSO`,
        })
      }
    }

    const tenantId = input.DEN_ENTRA_TENANT_ID?.trim()
    if (tenantId && !normalizeEntraTenantId(tenantId)) {
      issues.push({
        path: "DEN_ENTRA_TENANT_ID",
        message: "DEN_ENTRA_TENANT_ID must be a fixed Entra tenant GUID; common, organizations, and consumers are not allowed",
      })
    }

    const trustedOrigins = splitCsv(input.DEN_BETTER_AUTH_TRUSTED_ORIGINS)
    const effectiveTrustedOrigins = trustedOrigins.length > 0 ? trustedOrigins : splitCsv(input.CORS_ORIGINS)
    const trustedOriginsPath = trustedOrigins.length > 0 ? "DEN_BETTER_AUTH_TRUSTED_ORIGINS" : "CORS_ORIGINS"
    for (const origin of effectiveTrustedOrigins) {
      if (origin.trim() === "*") {
        issues.push({
          path: trustedOriginsPath,
          message: "Wildcard trusted origins are not allowed when Microsoft Entra SSO is configured",
        })
        continue
      }

      if (!isSafeEntraAuthOrigin(origin)) {
        issues.push({
          path: trustedOriginsPath,
          message: "Microsoft Entra SSO trusted origins must use https, except http is allowed for localhost, loopback, private LAN IPs, or .local hostnames",
        })
      }
    }

    if (input.BETTER_AUTH_URL && !isSafeEntraAuthOrigin(input.BETTER_AUTH_URL)) {
      issues.push({
        path: "BETTER_AUTH_URL",
        message: "BETTER_AUTH_URL must use https, except http is allowed for localhost, loopback, private LAN IPs, or .local hostnames",
      })
    }
  }

  if ((input.DEN_ENTRA_AUTO_JOIN_ENABLED ?? "false").trim().toLowerCase() === "true") {
    const hasOrgId = Boolean(input.DEN_ENTRA_AUTO_JOIN_ORG_ID?.trim())
    const hasOrgSlug = Boolean(input.DEN_ENTRA_AUTO_JOIN_ORG_SLUG?.trim())
    if (hasOrgId === hasOrgSlug) {
      issues.push({
        path: "DEN_ENTRA_AUTO_JOIN_ORG_ID",
        message: "Exactly one of DEN_ENTRA_AUTO_JOIN_ORG_ID or DEN_ENTRA_AUTO_JOIN_ORG_SLUG is required when DEN_ENTRA_AUTO_JOIN_ENABLED=true",
      })
    }
  }

  return issues
}

export function isEntraSsoEnabled(config: Pick<EntraSsoConfig, "clientId" | "clientSecret" | "tenantId">) {
  return Boolean(config.clientId && config.clientSecret && config.tenantId)
}

export function normalizeEntraTenantId(value: string | undefined) {
  const tenantId = value?.trim()
  if (!tenantId || MULTI_TENANT_ENTRA_ALIASES.has(tenantId.toLowerCase()) || !ENTRA_TENANT_ID_PATTERN.test(tenantId)) {
    return undefined
  }
  return tenantId.toLowerCase()
}

function isPrivateLanIpv4(hostname: string) {
  const parts = hostname.split(".").map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false
  }

  const [first, second] = parts
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
}

export function isSafeEntraAuthOrigin(origin: string) {
  try {
    const parsed = new URL(origin)
    if (parsed.protocol === "https:") {
      return true
    }
    if (parsed.protocol !== "http:") {
      return false
    }

    const hostname = parsed.hostname.toLowerCase()
    return hostname === "localhost"
      || hostname === "127.0.0.1"
      || hostname === "::1"
      || hostname === "[::1]"
      || hostname.endsWith(".local")
      || isPrivateLanIpv4(hostname)
  } catch {
    return false
  }
}

export function mapEntraProfileToUser(profile: EntraProfile) {
  const email = profile.email?.trim()
    || profile.preferred_username?.trim()
    || profile.upn?.trim()
    || (profile.oid?.trim() ? `${profile.oid.trim()}@entra.local` : undefined)
    || (profile.sub?.trim() ? `${profile.sub.trim()}@entra.local` : undefined)

  return {
    email,
    emailVerified: Boolean(email),
    name: profile.name?.trim() || email || "Microsoft Entra user",
  }
}

function decodeJwtPayload(token: string) {
  const payload = token.split(".")[1]
  if (!payload) {
    return null
  }

  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/")
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>
  } catch {
    return null
  }
}

export function extractEntraGroupsFromClaims(claims: EntraTokenClaims | null | undefined) {
  if (!Array.isArray(claims?.groups)) {
    return []
  }

  return claims.groups
    .filter((group): group is string => typeof group === "string")
    .map((group) => group.trim())
    .filter(Boolean)
}

export function extractEntraGroupsFromIdToken(idToken: string | null | undefined) {
  if (!idToken) {
    return []
  }

  return extractEntraGroupsFromClaims(decodeJwtPayload(idToken))
}

export function resolveEntraSsoRole(input: {
  groups: readonly string[]
  adminGroupIds: readonly string[]
  memberGroupIds: readonly string[]
}): DenSsoOrganizationRole {
  const groups = new Set(input.groups.map((group) => group.trim()).filter(Boolean))

  if (input.adminGroupIds.some((groupId) => groups.has(groupId))) {
    return "admin"
  }

  if (input.memberGroupIds.some((groupId) => groups.has(groupId))) {
    return "member"
  }

  return "member"
}

export function normalizeSsoAssignableRole(role: string): DenSsoOrganizationRole {
  return role === "admin" ? "admin" : "member"
}

export async function ensureEntraSsoMembership<TMember extends EntraSsoMembershipRecord>(input: {
  userId: string
  providerId?: string | null
  idToken?: string | null
  config: Pick<EntraSsoConfig, "autoJoinEnabled" | "autoJoinOrganizationId" | "autoJoinOrganizationSlug" | "adminGroupIds" | "memberGroupIds">
  deps: EnsureEntraSsoMembershipDeps<TMember>
}) {
  if (input.providerId !== "microsoft") {
    return { status: "provider_not_microsoft" as const }
  }

  if (!input.config.autoJoinEnabled) {
    return { status: "disabled" as const }
  }

  const hasOrgId = Boolean(input.config.autoJoinOrganizationId?.trim())
  const hasOrgSlug = Boolean(input.config.autoJoinOrganizationSlug?.trim())
  if (hasOrgId === hasOrgSlug) {
    return { status: "invalid_organization_selector" as const }
  }

  const organizationId = await input.deps.resolveOrganizationId({
    organizationId: input.config.autoJoinOrganizationId,
    organizationSlug: input.config.autoJoinOrganizationSlug,
  })
  if (!organizationId) {
    return { status: "organization_not_found" as const }
  }

  const groups = extractEntraGroupsFromIdToken(input.idToken)
  const role = normalizeSsoAssignableRole(resolveEntraSsoRole({
    groups,
    adminGroupIds: input.config.adminGroupIds,
    memberGroupIds: input.config.memberGroupIds,
  }))

  const existingMember = await input.deps.getExistingMember({
    organizationId,
    userId: input.userId,
  })

  if (!existingMember) {
    const member = await input.deps.createMember({
      organizationId,
      userId: input.userId,
      role,
    })
    await input.deps.ensureDefaultRoles(organizationId)
    return { status: "created" as const, member, role }
  }

  if (input.deps.isOwnerRole(existingMember.role)) {
    await input.deps.ensureDefaultRoles(organizationId)
    return { status: "owner_preserved" as const, member: existingMember, role: existingMember.role }
  }

  if (existingMember.role !== role) {
    const member = await input.deps.updateMemberRole({
      memberId: existingMember.id,
      role,
    })
    await input.deps.ensureDefaultRoles(organizationId)
    return { status: "updated" as const, member, role }
  }

  await input.deps.ensureDefaultRoles(organizationId)
  return { status: "unchanged" as const, member: existingMember, role }
}
