import { and, eq, gt, sql } from "@openwork-ee/den-db/drizzle"
import { InvitationTable, MemberTable, OrganizationTable, WorkerTable } from "@openwork-ee/den-db/schema"
import { db } from "./db.js"

export const DEFAULT_ORGANIZATION_LIMITS = {
  members: 5,
  workers: 1,
} as const

export type OrganizationLimitType = keyof typeof DEFAULT_ORGANIZATION_LIMITS

export type OrganizationLimits = {
  members: number
  workers: number
}

type OrganizationId = typeof OrganizationTable.$inferSelect.id

export type OrganizationMetadata = {
  limits: OrganizationLimits
} & Record<string, unknown>

type OrganizationMetadataInput = Record<string, unknown> | string | null | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function normalizePositiveInteger(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value
  }

  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed
    }
  }

  return fallback
}

function parseMetadata(input: OrganizationMetadataInput): Record<string, unknown> {
  if (!input) {
    return {}
  }

  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  return isRecord(input) ? input : {}
}

export function normalizeOrganizationMetadata(input: OrganizationMetadataInput): {
  metadata: OrganizationMetadata
  changed: boolean
} {
  const parsed = parseMetadata(input)
  const rawLimits = isRecord(parsed.limits) ? parsed.limits : null
  const members = normalizePositiveInteger(rawLimits?.members, DEFAULT_ORGANIZATION_LIMITS.members)
  const workers = normalizePositiveInteger(rawLimits?.workers ?? rawLimits?.Workers, DEFAULT_ORGANIZATION_LIMITS.workers)

  const metadata: OrganizationMetadata = {
    ...parsed,
    limits: {
      members,
      workers,
    },
  } as OrganizationMetadata

  const changed =
    !isRecord(parsed.limits) ||
    Object.keys(parsed).length === 0 ||
    rawLimits?.members !== members ||
    (rawLimits?.workers ?? rawLimits?.Workers) !== workers

  return { metadata, changed }
}

export function serializeOrganizationMetadata(metadata: OrganizationMetadataInput) {
  const parsed = parseMetadata(metadata)
  return Object.keys(parsed).length > 0 ? JSON.stringify(parsed) : null
}

export async function getOrInitializeOrganizationMetadata(organizationId: OrganizationId) {
  const rows = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, organizationId))
    .limit(1)

  const { metadata, changed } = normalizeOrganizationMetadata(rows[0]?.metadata)
  if (changed) {
    await db
      .update(OrganizationTable)
      .set({ metadata })
      .where(eq(OrganizationTable.id, organizationId))
  }

  return metadata
}

async function countOrganizationMembers(organizationId: OrganizationId) {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(MemberTable)
    .where(eq(MemberTable.organizationId, organizationId))

  return Number(rows[0]?.count ?? 0)
}

async function countPendingOrganizationInvitations(organizationId: OrganizationId) {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(InvitationTable)
    .where(and(eq(InvitationTable.organizationId, organizationId), eq(InvitationTable.status, "pending"), gt(InvitationTable.expiresAt, new Date())))

  return Number(rows[0]?.count ?? 0)
}

async function countOrganizationWorkers(organizationId: OrganizationId) {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(WorkerTable)
    .where(eq(WorkerTable.org_id, organizationId))

  return Number(rows[0]?.count ?? 0)
}

export async function getOrganizationLimitStatus(organizationId: OrganizationId, limitType: OrganizationLimitType) {
  const metadata = await getOrInitializeOrganizationMetadata(organizationId)
  const currentCount =
    limitType === "members"
      ? (await countOrganizationMembers(organizationId)) + (await countPendingOrganizationInvitations(organizationId))
      : await countOrganizationWorkers(organizationId)

  const limit = metadata.limits[limitType]

  return {
    metadata,
    currentCount,
    limit,
    exceeded: currentCount >= limit,
  }
}
