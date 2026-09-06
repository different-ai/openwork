import { createHash } from "node:crypto"
import type { createDenDb } from "@openwork-ee/den-db"
import { and, eq, sql } from "@openwork-ee/den-db/drizzle"
import { ModelsAnalyticsEventTable, ModelsAnalyticsSettingsTable, OrganizationTable, OrgSubscriptionTable } from "@openwork-ee/den-db/schema"
import { modelsAnalyticsEventSchema, type ModelsAnalyticsEvent } from "@openwork-ee/telemetry-contracts"

type Db = ReturnType<typeof createDenDb>["db"]
export type ModelsAnalyticsOrgId = typeof OrganizationTable.$inferSelect.id
type MemberId = typeof ModelsAnalyticsEventTable.$inferSelect.member_id

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
}

export async function readModelsAnalyticsSettings(db: Db, orgId: ModelsAnalyticsOrgId) {
  const [org] = await db.select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable).where(eq(OrganizationTable.id, orgId)).limit(1)
  const [subscription] = await db.select({ status: OrgSubscriptionTable.status })
    .from(OrgSubscriptionTable).where(and(eq(OrgSubscriptionTable.organization_id, orgId), eq(OrgSubscriptionTable.type, "inference"))).limit(1)
  const metadata = record(org?.metadata)
  const available = record(metadata.capabilities).modelsAnalytics === true
  const subscribed = subscription?.status === "active" || subscription?.status === "trialing"
  const modelsEnabled = record(metadata.inference).enabled === true
  // Unreleased organizations do not touch the new tables. This also keeps
  // existing Models traffic working during an application-first rollout.
  const settings = available ? (await db.select().from(ModelsAnalyticsSettingsTable)
    .where(eq(ModelsAnalyticsSettingsTable.org_id, orgId)).limit(1))[0] : undefined
  return {
    available, subscribed, modelsEnabled,
    enabled: available && subscribed && modelsEnabled && settings?.enabled === true && settings.consent_version === 1,
    consentedAt: settings?.consented_at?.toISOString() ?? null,
    consentVersion: settings?.consent_version ?? null,
    exportEnabled: settings?.export_enabled === true,
    langfuseHost: settings?.langfuse_host ?? null,
    langfuseConfigured: Boolean(settings?.langfuse_public_key && settings?.langfuse_secret_key),
  }
}

export async function appendModelsAnalyticsEvents(db: Db, input: {
  orgId: ModelsAnalyticsOrgId
  memberId: MemberId
  source: "app" | "inference"
  events: ModelsAnalyticsEvent[]
}) {
  const settings = await readModelsAnalyticsSettings(db, input.orgId)
  if (!settings.enabled || !settings.consentedAt) return
  const consentedAt = Date.parse(settings.consentedAt)
  const now = Date.now()
  const events = input.events.filter((event) => modelsAnalyticsEventSchema.safeParse(event).success
    && Date.parse(event.timestamp) >= consentedAt
    && Date.parse(event.timestamp) <= now + 60_000)
  if (!events.length) return
  await db.transaction(async (tx) => {
    // Serialize collection with opt-out. Once disabling returns, an in-flight
    // inference response cannot append under an older consent decision.
    const [current] = await tx.select({ enabled: ModelsAnalyticsSettingsTable.enabled, consentedAt: ModelsAnalyticsSettingsTable.consented_at })
      .from(ModelsAnalyticsSettingsTable).where(eq(ModelsAnalyticsSettingsTable.org_id, input.orgId)).limit(1).for("update")
    if (!current?.enabled || current.consentedAt?.getTime() !== consentedAt) return
    await tx.insert(ModelsAnalyticsEventTable).values(events.map((event) => ({
    id: createHash("sha256").update(JSON.stringify([input.orgId, input.memberId, input.source, event.id])).digest("hex"),
    event_id: event.id, org_id: input.orgId, member_id: input.memberId, source: input.source,
    type: event.type, timestamp: new Date(event.timestamp), session_id: event.sessionId, task_id: event.taskId,
    model: event.model, provider: event.provider, input_tokens: event.inputTokens, output_tokens: event.outputTokens,
    cache_read_tokens: event.cacheReadTokens, cost_usd: event.costUsd, usage_complete: event.usageComplete,
    payload: event,
    }))).onDuplicateKeyUpdate({ set: { id: sql`id` } })
  })
}

function missingTable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  if ("code" in error && error.code === "ER_NO_SUCH_TABLE") return true
  return "cause" in error && missingTable(error.cause)
}

export async function deleteModelsAnalyticsForOrganization(tx: Pick<Db, "delete">, orgId: ModelsAnalyticsOrgId) {
  // Lock/remove consent first so an in-flight append cannot recreate history.
  for (const table of [ModelsAnalyticsSettingsTable, ModelsAnalyticsEventTable]) {
    try { await tx.delete(table).where(eq(table.org_id, orgId)) }
    catch (error) {
      // Existing organization deletion also works before the additive migration.
      if (!missingTable(error)) throw error
    }
  }
}
