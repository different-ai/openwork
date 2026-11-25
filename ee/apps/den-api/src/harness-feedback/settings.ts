import { eq } from "@openwork-ee/den-db/drizzle"
import { HarnessFeedbackSlackTable as Slack } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"

export async function hasHarnessFeedbackWebhook() {
  const [row] = await db.$primary.select({ id: Slack.id }).from(Slack).where(eq(Slack.id, "default")).limit(1)
  return Boolean(row)
}

export async function readHarnessFeedbackWebhook() {
  const [row] = await db.$primary.select({ webhookUrl: Slack.webhookUrl }).from(Slack).where(eq(Slack.id, "default")).limit(1)
  return row?.webhookUrl ?? null
}

export async function setHarnessFeedbackWebhook(webhookUrl: string, actor: DenTypeId<"user">) {
  const settings = { webhookUrl, updatedBy: actor, updatedAt: new Date() }
  await db.insert(Slack).values({ id: "default", ...settings }).onDuplicateKeyUpdate({ set: settings })
}

export async function clearHarnessFeedbackWebhook() {
  await db.delete(Slack).where(eq(Slack.id, "default"))
}
