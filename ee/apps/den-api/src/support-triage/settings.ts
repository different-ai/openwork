import { randomUUID } from "node:crypto"
import { and, eq, isNull, lt, or } from "@openwork-ee/den-db/drizzle"
import { SupportTriageSettingsTable as Settings } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { env } from "../env.js"

export type TriageSettings = typeof Settings.$inferSelect
export type TriageSettingsUpdate = { enabled?: boolean; plainApiKey?: string | null; slackWebhookUrl?: string | null; leadsSlackWebhookUrl?: string | null }
const singleton = eq(Settings.id, "default")

export async function readTriageSettings() {
  const [row] = await db.$primary.select().from(Settings).where(singleton).limit(1)
  return row ?? null
}

export function publicTriageSettings(row: TriageSettings | null) {
  return {
    enabledAt: row?.enabledAt?.toISOString() ?? null,
    plainConfigured: Boolean(row?.plainApiKey), slackConfigured: Boolean(row?.slackWebhookUrl), leadsSlackConfigured: Boolean(row?.leadsSlackWebhookUrl),
    jevConfigured: Boolean(env.agentEvaluationApiKey),
    updatedAt: row?.updatedAt?.toISOString() ?? null, updatedBy: row?.updatedBy ?? null,
  }
}

export function updateTriageSettings(input: TriageSettingsUpdate, updatedBy: DenTypeId<"user">) {
  return db.transaction(async (tx) => {
    const revision = randomUUID()
    await tx.insert(Settings).values({ id: "default", revision, updatedAt: new Date(), updatedBy })
      .onDuplicateKeyUpdate({ set: { id: "default" } })
    const [current] = await tx.select().from(Settings).where(singleton).for("update")
    if (!current) throw new Error("Support triage settings unavailable")
    const plainApiKey = input.plainApiKey === undefined ? current.plainApiKey : input.plainApiKey
    if (input.enabled && (!plainApiKey || !env.agentEvaluationApiKey)) return { kind: "not_configured" } satisfies { kind: "not_configured" }

    const updatedAt = new Date()
    const enabledAt = !plainApiKey || input.enabled === false ? null : current.enabledAt ?? (input.enabled ? updatedAt : null)
    const settings = {
      plainApiKey, enabledAt, revision, updatedAt, updatedBy,
      slackWebhookUrl: input.slackWebhookUrl === undefined ? current.slackWebhookUrl : input.slackWebhookUrl,
      leadsSlackWebhookUrl: input.leadsSlackWebhookUrl === undefined ? current.leadsSlackWebhookUrl : input.leadsSlackWebhookUrl,
      polledThrough: enabledAt && enabledAt === current.enabledAt && plainApiKey === current.plainApiKey ? current.polledThrough : null,
    }
    await tx.update(Settings).set(settings).where(singleton)
    return { kind: "updated", settings: { ...current, ...settings } } satisfies { kind: "updated"; settings: TriageSettings }
  })
}

export async function currentTriageSettings(revision: string) {
  const [row] = await db.$primary.select({ id: Settings.id }).from(Settings).where(and(singleton, eq(Settings.revision, revision))).limit(1)
  return Boolean(row)
}

export async function advanceTriagePoll(revision: string, polledThrough: Date) {
  await db.update(Settings).set({ polledThrough }).where(and(singleton, eq(Settings.revision, revision),
    or(isNull(Settings.polledThrough), lt(Settings.polledThrough, polledThrough))))
}
