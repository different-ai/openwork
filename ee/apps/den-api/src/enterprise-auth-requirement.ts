import { and, eq, isNull, sql } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  MemberTable,
  OrganizationTable,
  SsoConnectionTable,
  SsoProviderTable,
} from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
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

function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
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

async function findEnterpriseAuthRequirement(where: ReturnType<typeof and>) {
  const rows = await db
    .select({
      organizationId: OrganizationTable.id,
      organizationSlug: OrganizationTable.slug,
      signInPath: SsoConnectionTable.signInPath,
      ssoProviderId: SsoProviderTable.providerId,
    })
    .from(AuthUserTable)
    .innerJoin(MemberTable, eq(AuthUserTable.id, MemberTable.userId))
    .innerJoin(OrganizationTable, eq(MemberTable.organizationId, OrganizationTable.id))
    .innerJoin(SsoConnectionTable, and(
      eq(OrganizationTable.id, SsoConnectionTable.organizationId),
      eq(SsoConnectionTable.status, "enabled"),
    ))
    .innerJoin(SsoProviderTable, and(
      eq(SsoConnectionTable.providerId, SsoProviderTable.providerId),
      eq(OrganizationTable.id, SsoProviderTable.organizationId),
    ))
    .where(and(
      where,
      isNull(MemberTable.removedAt),
    ))

  const requirement = pickRequirement(rows)
  return requirement ? toRequirement(requirement) : null
}

export async function findEnterpriseAuthRequirementForEmail(email: string) {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail) {
    return null
  }

  return findEnterpriseAuthRequirement(sql`lower(${AuthUserTable.email}) = ${normalizedEmail}`)
}

export async function findEnterpriseAuthRequirementForUserId(userId: string) {
  return findEnterpriseAuthRequirement(eq(AuthUserTable.id, normalizeDenTypeId("user", userId)))
}
