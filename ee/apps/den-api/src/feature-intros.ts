import { and, asc, eq, sql } from "@openwork-ee/den-db/drizzle"
import { FeatureIntroStateTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import type { FeatureIntroEventRequest, FeatureIntroState } from "@openwork/types/den/feature-intros"
import { db } from "./db.js"
import { applyFeatureIntroEvent, featureIntroStateView, type FeatureIntroTimestamps } from "./feature-intro-state.js"

/**
 * Feature intros (DESIGN.md I1–I10): per member and organization, which intros were seen, dismissed or acted
 * on. Den web owns the registry of intro keys and versions; Den only stores what happened.
 */
type OrganizationId = DenTypeId<"organization">
type MemberId = DenTypeId<"member">
type Database = typeof db | Parameters<Parameters<typeof db["transaction"]>[0]>[0]

export type FeatureIntroActor = { organizationId: OrganizationId; memberId: MemberId }

const timestampColumns = {
  introKey: FeatureIntroStateTable.introKey,
  introVersion: FeatureIntroStateTable.introVersion,
  firstSeenAt: FeatureIntroStateTable.firstSeenAt,
  lastSeenAt: FeatureIntroStateTable.lastSeenAt,
  dismissedAt: FeatureIntroStateTable.dismissedAt,
  ctaClickedAt: FeatureIntroStateTable.ctaClickedAt,
  completedAt: FeatureIntroStateTable.completedAt,
}

function memberScope(actor: FeatureIntroActor) {
  return and(eq(FeatureIntroStateTable.organizationId, actor.organizationId), eq(FeatureIntroStateTable.memberId, actor.memberId))
}

export async function listFeatureIntroStates(actor: FeatureIntroActor): Promise<FeatureIntroState[]> {
  const rows = await db
    .select(timestampColumns)
    .from(FeatureIntroStateTable)
    .where(memberScope(actor))
    .orderBy(asc(FeatureIntroStateTable.introKey))
  return rows.map((row) => featureIntroStateView(row.introKey, row))
}

/**
 * Records one event, idempotently: the row is created on first use and locked while the event is applied, so
 * parallel tabs never lose a timestamp. A newer intro version resets the timestamps first; an older one changes
 * nothing and returns what is stored.
 */
export async function recordFeatureIntroEvent(actor: FeatureIntroActor, event: FeatureIntroEventRequest, now = new Date()): Promise<FeatureIntroState> {
  return db.transaction(async (tx) => {
    await tx
      .insert(FeatureIntroStateTable)
      .values({
        id: createDenTypeId("featureIntroState"),
        organizationId: actor.organizationId,
        memberId: actor.memberId,
        introKey: event.introKey,
        introVersion: event.introVersion,
        createdAt: now,
        updatedAt: now,
      })
      .onDuplicateKeyUpdate({ set: { id: sql`${FeatureIntroStateTable.id}` } })
    const [row] = await tx
      .select({ id: FeatureIntroStateTable.id, ...timestampColumns })
      .from(FeatureIntroStateTable)
      .where(and(memberScope(actor), eq(FeatureIntroStateTable.introKey, event.introKey)))
      .limit(1)
      .for("update")
    if (!row) throw new Error("feature_intro_state_missing")
    const next = applyFeatureIntroEvent(row, event, now)
    if (!next) return featureIntroStateView(row.introKey, row)
    await writeFeatureIntroState(tx, row.id, next, now)
    return featureIntroStateView(row.introKey, next)
  })
}

async function writeFeatureIntroState(database: Database, id: DenTypeId<"featureIntroState">, next: FeatureIntroTimestamps, now: Date) {
  await database
    .update(FeatureIntroStateTable)
    .set({ ...next, updatedAt: now })
    .where(eq(FeatureIntroStateTable.id, id))
}

/** Removes every intro state of an organization inside the transaction that deletes it. */
export async function deleteOrganizationFeatureIntroStates(database: Database, organizationId: OrganizationId): Promise<void> {
  await database.delete(FeatureIntroStateTable).where(eq(FeatureIntroStateTable.organizationId, organizationId))
}
