import { asc, eq } from "@openwork-ee/den-db/drizzle"
import { HarnessFeedbackOrganizationTable as Enabled, OrganizationTable as Organizations } from "@openwork-ee/den-db/schema"
import { isDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"

const CACHE_TTL_MS = 30_000
const CACHE_MAX_ENTRIES = 2_048
const eligibility = new Map<string, { enabled: boolean; expiresAt: number }>()
let generation = 0

export async function isHarnessFeedbackOrganization(id: string, { fresh = false } = {}) {
  if (!isDenTypeId("organization", id)) return false
  const now = Date.now()
  const cached = eligibility.get(id)
  if (!fresh && cached && cached.expiresAt > now) return cached.enabled
  const readGeneration = generation
  const [row] = await db.$primary.select({ id: Enabled.organizationId }).from(Enabled)
    .where(eq(Enabled.organizationId, id)).limit(1)
  const enabled = Boolean(row)
  if (readGeneration === generation) {
    eligibility.delete(id)
    eligibility.set(id, { enabled, expiresAt: now + CACHE_TTL_MS })
    if (eligibility.size > CACHE_MAX_ENTRIES) {
      const oldest = eligibility.keys().next()
      if (!oldest.done) eligibility.delete(oldest.value)
    }
  }
  return enabled
}

function enabledOrganizations() {
  return db.$primary.select({ id: Enabled.organizationId, name: Organizations.name }).from(Enabled)
    .innerJoin(Organizations, eq(Enabled.organizationId, Organizations.id))
}

export async function harnessFeedbackOrganizationIds() {
  const rows = await db.$primary.select({ id: Enabled.organizationId }).from(Enabled)
    .innerJoin(Organizations, eq(Enabled.organizationId, Organizations.id))
  return rows.map(({ id }) => id)
}

export async function hasHarnessFeedbackOrganizations() {
  const [row] = await enabledOrganizations().limit(1)
  return Boolean(row)
}

export function listHarnessFeedbackOrganizations() {
  return enabledOrganizations().orderBy(asc(Organizations.name), asc(Enabled.organizationId))
}

export async function setHarnessFeedbackOrganization(organizationId: DenTypeId<"organization">, enabled: boolean, actor: DenTypeId<"user">) {
  const [organization] = await db.$primary.select({ id: Organizations.id }).from(Organizations)
    .where(eq(Organizations.id, organizationId)).limit(1)
  if (!organization) return false
  if (enabled) {
    await db.insert(Enabled).values({ organizationId, enabledBy: actor })
      .onDuplicateKeyUpdate({ set: { organizationId } })
  } else {
    await db.delete(Enabled).where(eq(Enabled.organizationId, organizationId))
  }
  generation++
  eligibility.delete(organizationId)
  return true
}
