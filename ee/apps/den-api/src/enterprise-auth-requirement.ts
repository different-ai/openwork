import { and, eq } from "@openwork-ee/den-db/drizzle"
import {
  AuthAccountTable,
  AuthUserTable,
  OrganizationTable,
  SsoConnectionTable,
  SsoProviderTable,
} from "@openwork-ee/den-db/schema"
import { db } from "./db.js"

type EnterpriseAuthRequirementRow = {
  organizationId: string
  organizationSlug: string
  signInPath: string | null
  ssoProviderId: string | null
}

export type EnterpriseAuthRequirement = {
  organizationId: string
  organizationSlug: string
  signInPath: string
  ssoProviderId: string | null
  hasSso: boolean
}

export type ResolvedNonSsoMethod = "google" | "password" | "signup"

function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

function getEmailDomain(email: string) {
  const normalizedEmail = normalizeEmail(email)
  const atIndex = normalizedEmail.lastIndexOf("@")
  if (atIndex <= 0 || atIndex === normalizedEmail.length - 1) {
    return null
  }
  const domain = normalizedEmail.slice(atIndex + 1)
  return domain.includes(".") ? domain : null
}

function getOrganizationSsoSignInPath(organizationSlug: string) {
  return `/sso/${encodeURIComponent(organizationSlug)}`
}

function toRequirement(row: EnterpriseAuthRequirementRow): EnterpriseAuthRequirement {
  return {
    organizationId: row.organizationId,
    organizationSlug: row.organizationSlug,
    signInPath: row.signInPath ?? getOrganizationSsoSignInPath(row.organizationSlug),
    ssoProviderId: row.ssoProviderId,
    hasSso: Boolean(row.ssoProviderId),
  }
}

function pickRequirement(rows: EnterpriseAuthRequirementRow[]) {
  const ssoRow = rows.find((row) => row.ssoProviderId)
  return ssoRow ?? rows[0] ?? null
}

export async function findEnterpriseAuthRequirementForEmailDomain(email: string) {
  const domain = getEmailDomain(email)
  if (!domain) {
    return null
  }

  const rows = await db
    .select({
      organizationId: OrganizationTable.id,
      organizationSlug: OrganizationTable.slug,
      signInPath: SsoConnectionTable.signInPath,
      ssoProviderId: SsoProviderTable.providerId,
    })
    .from(OrganizationTable)
    .innerJoin(SsoConnectionTable, and(
      eq(OrganizationTable.id, SsoConnectionTable.organizationId),
      eq(SsoConnectionTable.status, "enabled"),
      eq(SsoConnectionTable.domain, domain),
    ))
    .innerJoin(SsoProviderTable, and(
      eq(SsoConnectionTable.providerId, SsoProviderTable.providerId),
      eq(OrganizationTable.id, SsoProviderTable.organizationId),
      eq(SsoProviderTable.domain, domain),
      eq(SsoProviderTable.domainVerified, true),
    ))

  const requirement = pickRequirement(rows)
  return requirement ? toRequirement(requirement) : null
}

export async function resolveNonSsoSignInMethodForEmail(email: string): Promise<ResolvedNonSsoMethod> {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail) {
    return "signup"
  }

  const rows = await db
    .select({
      providerId: AuthAccountTable.providerId,
      password: AuthAccountTable.password,
    })
    .from(AuthUserTable)
    .innerJoin(AuthAccountTable, eq(AuthUserTable.id, AuthAccountTable.userId))
    .where(eq(AuthUserTable.email, normalizedEmail))

  if (rows.length === 0) {
    return "signup"
  }

  if (rows.some((row) => row.providerId.trim().toLowerCase() === "google")) {
    return "google"
  }

  return "password"
}
